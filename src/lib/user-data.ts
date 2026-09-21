/**
 * Server data layer for the Users / Employee Maintain pages.
 *
 * Security model — identical to the rest of the panel
 * --------------------------------------------------
 * Every read goes through the request-scoped anon client from
 * `@/lib/supabase/server`, so the caller's session cookies are attached and the
 * existing RLS policies (`private.is_admin()`) decide what is visible. No
 * service-role key, no new API surface, and no credential column is ever
 * selected. `requireAdminActor` is the same server-side admin gate the media
 * server actions use — reused, not reimplemented.
 *
 * Push tokens are structurally unreachable: `DEVICE_COLUMNS` has no
 * `push_token` / `push_token_updated_at`, so those values are never fetched,
 * never cached and never serialised to the browser.
 *
 * Query shape (no N+1)
 * --------------------
 * A directory load costs a fixed number of round trips regardless of how many
 * employees are returned:
 *   1. `profiles` (one page of up to DIRECTORY_MAX_PROFILES rows, `count: exact`)
 *   2. `devices` for those profiles, chunked `in (user_id)` requests
 *   3. `backup_sessions` for those devices inside BACKUP_LOOKBACK_DAYS, chunked
 * The previous Employees list ran one COUNT per profile; this does not.
 *
 * Caching
 * -------
 * The directory is loaded from the database once per (admin, search term) and
 * then served from a short-lived in-process cache, so filters, sorting, the
 * progressive window and repeated navigation cost zero database round trips.
 * The cache is keyed by the admin's own id, holds only the non-sensitive
 * projection above, is bounded, and is cleared explicitly after a write.
 * This mirrors the existing `roleCache` / `sourceCache` approach in
 * `media-data.ts` rather than introducing a second caching story.
 */
import { createClient } from "@/lib/supabase/server";
import { requireAdminActor } from "@/lib/media-data";
import { isUuid, sanitizeSearch } from "@/lib/media-types";
import {
  BACKUP_LOOKBACK_DAYS,
  DEVICE_COLUMNS,
  DIRECTORY_MAX_PROFILES,
  DIRECTORY_WINDOW,
  PROFILE_COLUMNS,
  QUERY_CHUNK,
  SESSION_COLUMNS,
  buildDirectory,
  buildUserDevices,
  searchOrGroup,
  searchTokens,
  viewDirectory,
  type BackupSessionRow,
  type DeviceRow,
  type DirectoryFilters,
  type DirectorySnapshot,
  type DirectoryUser,
  type ProfileRow,
  type UserDetail,
} from "@/lib/user-types";

/** Safety valve for the per-chunk session read (newest-first, so bounded). */
const SESSION_ROW_LIMIT = 2000;

const SNAPSHOT_TTL_MS = 20_000;
const DETAIL_TTL_MS = 20_000;
const CACHE_MAX_ENTRIES = 64;

type Client = Awaited<ReturnType<typeof createClient>>;

type SnapshotValue = {
  profiles: ProfileRow[];
  devices: DeviceRow[];
  sessions: BackupSessionRow[];
  users: DirectoryUser[];
  /** `count: exact` for this search term, before view filters. */
  total: number;
  scanCapped: boolean;
};

type CacheEntry<T> = { value: T; expiresAt: number };

const snapshotCache = new Map<string, CacheEntry<SnapshotValue>>();
const detailCache = new Map<string, CacheEntry<UserDetail>>();

function put<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttl: number) {
  cache.set(key, { value, expiresAt: Date.now() + ttl });
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/**
 * Drops every cached directory/detail entry.
 *
 * Called after a write so the next render reads the new state instead of the
 * pre-write snapshot. `revalidatePath` alone is not enough: the Next.js data
 * cache is not what holds these values.
 */
export function invalidateUserData(): void {
  snapshotCache.clear();
  detailCache.clear();
}

function chunk<T>(items: T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    parts.push(items.slice(index, index + size));
  }
  return parts;
}

/**
 * Operator-facing message + server-side detail.
 *
 * PostgREST messages are useful to an operator reading logs and are exactly the
 * "raw database error" the panel must not print for an admin, so the two are
 * separated here.
 */
function reportError(scope: string, message: string): string {
  console.error(`[users] ${scope}: ${message}`);
  return scope;
}

const DIRECTORY_ERROR =
  "The employee directory could not be loaded. Please try again.";
export type DirectoryLoadResult = DirectorySnapshot & {
  /** The signed-in admin's id, used to scope the browser-side cache. */
  viewerId: string | null;
  error: string | null;
};

function emptyDirectory(): DirectorySnapshot {
  return {
    users: [],
    matched: 0,
    capped: false,
    scanned: 0,
    scanCapped: false,
    total: 0,
    cached: false,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Loads (or reuses) the profile+device+backup snapshot for one search term.
 *
 * Only the search term is part of the cache key: the device/backup/storage
 * filters are applied in memory afterwards, which is what keeps filtering and
 * sorting free of database round trips.
 */
async function loadSnapshot(
  supabase: Client,
  actorId: string,
  filters: DirectoryFilters,
): Promise<{ snapshot: SnapshotValue | null; cached: boolean; error: string | null }> {
  const tokens = searchTokens(filters);
  const key = `${actorId}|${tokens.join(" ")}`;

  const hit = snapshotCache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return { snapshot: hit.value, cached: true, error: null };
  }

  let query = supabase
    .from("profiles")
    .select(PROFILE_COLUMNS, { count: "exact" })
    .order("full_name", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .range(0, DIRECTORY_MAX_PROFILES - 1);

  // One ANDed `or=(...)` group per token: "towkir dev" must match a name in one
  // column and a designation in another, which a single substring cannot.
  for (const token of tokens) {
    query = query.or(searchOrGroup(token));
  }

  const { data, count, error } = await query;
  if (error) {
    return {
      snapshot: null,
      cached: false,
      error: reportError("directory profiles read failed", error.message),
    };
  }

  const profiles = (data ?? []) as unknown as ProfileRow[];
  const total = count ?? profiles.length;

  const devices: DeviceRow[] = [];
  const sessions: BackupSessionRow[] = [];

  if (profiles.length > 0) {
    const profileIds = profiles.map((profile) => profile.id);

    for (const part of chunk(profileIds, QUERY_CHUNK)) {
      const { data: deviceRows, error: deviceError } = await supabase
        .from("devices")
        .select(DEVICE_COLUMNS)
        .in("user_id", part);

      if (deviceError) {
        return {
          snapshot: null,
          cached: false,
          error: reportError("directory devices read failed", deviceError.message),
        };
      }

      devices.push(...((deviceRows ?? []) as unknown as DeviceRow[]));
    }

    if (devices.length > 0) {
      const since = new Date(
        Date.now() - BACKUP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      const deviceIds = devices.map((device) => device.id);

      for (const part of chunk(deviceIds, QUERY_CHUNK)) {
        const { data: sessionRows, error: sessionError } = await supabase
          .from("backup_sessions")
          .select(SESSION_COLUMNS)
          .in("device_id", part)
          .gte("started_at", since)
          .order("started_at", { ascending: false, nullsFirst: false })
          .limit(SESSION_ROW_LIMIT);

        if (sessionError) {
          return {
            snapshot: null,
            cached: false,
            error: reportError(
              "directory backup sessions read failed",
              sessionError.message,
            ),
          };
        }

        sessions.push(...((sessionRows ?? []) as unknown as BackupSessionRow[]));
      }
    }
  }

  const snapshot: SnapshotValue = {
    profiles,
    devices,
    sessions,
    users: buildDirectory(profiles, devices, sessions),
    total,
    scanCapped: total > profiles.length,
  };

  put(snapshotCache, key, snapshot, SNAPSHOT_TTL_MS);
  return { snapshot, cached: false, error: null };
}

/**
 * The directory view for one filter set.
 *
 * `limit` is the progressive-reveal window. Raising it re-slices the cached
 * snapshot, so "show more" never re-queries the database.
 */
export async function loadUserDirectory(
  filters: DirectoryFilters,
  limit: number = DIRECTORY_WINDOW,
  force = false,
): Promise<DirectoryLoadResult> {
  const supabase = await createClient();
  const actor = await requireAdminActor(supabase);
  if (!actor.ok) {
    return { ...emptyDirectory(), viewerId: null, error: actor.error };
  }

  // An explicit refresh must read the database again rather than replay the
  // snapshot, otherwise "Refresh" would be a no-op inside the cache window.
  if (force) invalidateUserData();

  const { snapshot, cached, error } = await loadSnapshot(supabase, actor.id, filters);
  if (!snapshot) {
    return { ...emptyDirectory(), viewerId: actor.id, error: error ?? DIRECTORY_ERROR };
  }

  const view = viewDirectory(snapshot.users, filters, limit);

  return {
    ...view,
    scanned: snapshot.profiles.length,
    scanCapped: snapshot.scanCapped,
    total: snapshot.total,
    cached,
    generatedAt: new Date().toISOString(),
    viewerId: actor.id,
    error: null,
  };
}

export type UserDetailResult = {
  detail: UserDetail | null;
  error: string | null;
  /** False when the caller is not an admin (the page then renders not-found). */
  authorized: boolean;
  /** The signed-in admin's id, so the page can tell "this is my own record". */
  viewerId: string | null;
};

/**
 * One employee's full record for `/admin/users/[userId]`.
 *
 * The loader itself re-checks the admin session (like the media server actions)
 * rather than trusting the route: an authenticated non-admin that reaches this
 * URL gets no data. A malformed or unknown id resolves to `null` — the page
 * renders the not-found state and never reveals whether the id exists.
 */
export async function loadUserDetail(userId: string): Promise<UserDetailResult> {
  if (!isUuid(userId)) {
    return { detail: null, error: null, authorized: true, viewerId: null };
  }

  const supabase = await createClient();
  const actor = await requireAdminActor(supabase);
  if (!actor.ok) {
    return { detail: null, error: null, authorized: false, viewerId: null };
  }

  const cacheKey = `${actor.id}|${userId}`;
  const hit = detailCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    return { detail: hit.value, error: null, authorized: true, viewerId: actor.id };
  }

  const { data: profileRow, error: profileError } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", userId)
    .maybeSingle();

  if (profileError) {
    return {
      detail: null,
      error: reportError("employee read failed", profileError.message),
      authorized: true,
      viewerId: actor.id,
    };
  }
  if (!profileRow) {
    return { detail: null, error: null, authorized: true, viewerId: actor.id };
  }

  const profile = profileRow as unknown as ProfileRow;

  const { data: deviceRows, error: deviceError } = await supabase
    .from("devices")
    .select(DEVICE_COLUMNS)
    .eq("user_id", userId)
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true });

  if (deviceError) {
    return {
      detail: null,
      error: reportError("employee devices read failed", deviceError.message),
      authorized: true,
      viewerId: actor.id,
    };
  }

  const devices = (deviceRows ?? []) as unknown as DeviceRow[];
  let sessions: BackupSessionRow[] = [];

  if (devices.length > 0) {
    const since = new Date(
      Date.now() - BACKUP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { data: sessionRows, error: sessionError } = await supabase
      .from("backup_sessions")
      .select(SESSION_COLUMNS)
      .in("device_id", devices.map((device) => device.id))
      .gte("started_at", since)
      .order("started_at", { ascending: false, nullsFirst: false })
      .limit(SESSION_ROW_LIMIT);

    if (sessionError) {
      return {
        detail: null,
        error: reportError("employee sessions read failed", sessionError.message),
        authorized: true,
        viewerId: actor.id,
      };
    }

    sessions = (sessionRows ?? []) as unknown as BackupSessionRow[];
  }

  // Media count only — no media rows, no storage locators, no provider URLs.
  // The grid itself stays on the Media page.
  const { count: mediaCount } = await supabase
    .from("media_assets")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", userId)
    .is("deleted_at", null)
    .neq("status", "DELETED");

  const [user] = buildDirectory([profile], devices, sessions);
  const detail: UserDetail = {
    user,
    devices: buildUserDevices(devices, sessions),
    media_count: mediaCount ?? 0,
  };

  put(detailCache, cacheKey, detail, DETAIL_TTL_MS);
  return { detail, error: null, authorized: true, viewerId: actor.id };
}

/**
 * Narrowing helper for the server action boundary: the filters arrive from the
 * browser, so only the documented union members are accepted.
 */
export function normalizeDirectoryFilters(input: {
  search?: string | null;
  status?: string | null;
  devices?: string | null;
  sync?: string | null;
  storage?: string | null;
  sort?: string | null;
}): DirectoryFilters {
  const status: DirectoryFilters["status"] =
    input.status === "active" || input.status === "suspended" ? input.status : "ALL";
  const devices: DirectoryFilters["devices"] =
    input.devices === "with_devices" ||
    input.devices === "without_devices" ||
    input.devices === "with_disabled"
      ? input.devices
      : "ALL";
  const sync: DirectoryFilters["sync"] =
    input.sync === "ok" ||
    input.sync === "backing_up" ||
    input.sync === "failed" ||
    input.sync === "none"
      ? input.sync
      : "ALL";
  const storage: DirectoryFilters["storage"] =
    input.storage === "used_high" ||
    input.storage === "used_mid" ||
    input.storage === "used_low" ||
    input.storage === "no_quota"
      ? input.storage
      : "ALL";
  const sort: DirectoryFilters["sort"] =
    input.sort === "recent" || input.sort === "storage" || input.sort === "newest"
      ? input.sort
      : "name";

  return {
    search: sanitizeSearch(input.search ?? ""),
    status,
    devices,
    sync,
    storage,
    sort,
  };
}
