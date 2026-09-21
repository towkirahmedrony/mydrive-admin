/**
 * Pure types and derivation logic for the Users / Employee Maintain directory.
 *
 * Schema discipline
 * -----------------
 * Every field named below exists in `MYDRIVE_SCHEMA.md`; nothing is invented.
 * Sensitive columns are deliberately NOT part of these shapes:
 *   - `devices.push_token` and `devices.push_token_updated_at` (FCM tokens)
 *   - `profiles.department_id` (Department is intentionally out of scope — the
 *     office currently has a single department, so it must not appear in the UI)
 * Because the shapes cannot express them, those values can never be selected,
 * cached, serialised to the browser or rendered.
 *
 * Why this module is pure
 * -----------------------
 * The directory has to be searchable, filterable, sortable and windowed without
 * touching the database again. Keeping that logic here — free of any I/O — means
 * the same functions run in the Server Component, in the server action, in the
 * browser and under `node --test`.
 */
import { usagePercent } from "@/lib/format";
import {
  employeeDisplayName,
  sanitizeSearch,
} from "@/lib/media-types";

/** Rows rendered per progressive-reveal step (and the first server window). */
export const DIRECTORY_WINDOW = 25;

/**
 * Upper bound on rows one view hands to the browser.
 *
 * The office roster is small, but this bounds the payload and the DOM for the
 * pathological case. When the match count exceeds it the list says so
 * explicitly rather than silently truncating.
 */
export const DIRECTORY_VIEW_MAX = 200;

/** Hard cap on profiles scanned for one search term. */
export const DIRECTORY_MAX_PROFILES = 1000;

/**
 * How far back `backup_sessions` is read.
 *
 * A device's latest backup is taken from the sessions inside this window, which
 * keeps the read bounded (no per-device query, no unbounded history scan) while
 * still being exact for every device that backed up recently. A device with no
 * session in the window is reported as "no recent backup" rather than guessed.
 */
export const BACKUP_LOOKBACK_DAYS = 90;

/** Ids per PostgREST `in(...)` request (URL length + plan stability). */
export const QUERY_CHUNK = 100;

/** Maximum search tokens pushed into the SQL OR groups. */
const MAX_SEARCH_TOKENS = 4;

// ── Selected columns ───────────────────────────────────────────────────────

/**
 * `profiles` columns the directory reads. Nothing else is selected.
 * `department_id` is absent on purpose: Department is out of scope.
 */
export const PROFILE_COLUMNS = [
  "id",
  "full_name",
  "email",
  "employee_id",
  "designation",
  "role",
  "status",
  "last_seen_at",
  "created_at",
  "storage_quota_bytes",
  "storage_used_bytes",
].join(",");

/**
 * `devices` columns the directory reads.
 *
 * `push_token` and `push_token_updated_at` are intentionally absent: an FCM
 * token is a delivery credential, so it is never fetched, cached, serialised or
 * rendered. `tests/user-directory.test.ts` pins that.
 */
export const DEVICE_COLUMNS = [
  "id",
  "user_id",
  "device_uid",
  "device_name",
  "brand",
  "model",
  "android_version",
  "status",
  "last_seen_at",
  "created_at",
  "wifi_only_sync",
  "auto_delete_after_backup",
].join(",");

export const SESSION_COLUMNS = [
  "id",
  "device_id",
  "started_at",
  "completed_at",
  "status",
  "files_count",
  "files_uploaded",
  "files_failed",
  "total_size_bytes",
  "error_message",
].join(",");

// ── Row shapes (mirror the documented columns) ──────────────────────────────

/** `profiles` — documented columns only. */
export type ProfileRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  employee_id: string | null;
  designation: string | null;
  role: string;
  status: string;
  last_seen_at: string | null;
  created_at: string | null;
  storage_quota_bytes: number | string | null;
  storage_used_bytes: number | string | null;
};

/** `devices` — documented columns only, push token excluded on purpose. */
export type DeviceRow = {
  id: string;
  user_id: string;
  device_uid: string | null;
  device_name: string | null;
  brand: string | null;
  model: string | null;
  android_version: string | null;
  status: string;
  last_seen_at: string | null;
  created_at: string | null;
  /** `devices.wifi_only_sync` */
  wifi_only_sync: boolean | null;
  /** `devices.auto_delete_after_backup` */
  auto_delete_after_backup: boolean | null;
};

/** `backup_sessions` — documented columns only. */
export type BackupSessionRow = {
  id: string;
  device_id: string;
  started_at: string | null;
  completed_at: string | null;
  status: string;
  files_count: number | null;
  files_uploaded: number | null;
  files_failed: number | null;
  total_size_bytes: number | string | null;
  error_message: string | null;
};

/** A device row joined with its most recent backup session in the lookback window. */
export type UserDevice = DeviceRow & {
  last_backup: BackupSessionRow | null;
};

/** Latest backup roll-up, summarised for the list and the detail page. */
export type BackupSummary = {
  device_id: string;
  device_name: string | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  files_count: number | null;
  files_uploaded: number | null;
  files_failed: number | null;
  total_size_bytes: number | string | null;
  error_message: string | null;
};

/**
 * Coarse sync state derived from `backup_sessions.status`.
 *
 * `none` means "no backup session in the lookback window" — it is never used to
 * mean "successful", so a device that has never backed up cannot look healthy.
 */
export type SyncState = "none" | "backing_up" | "ok" | "failed" | "cancelled";

export type DirectoryUser = ProfileRow & {
  device_count: number;
  active_device_count: number;
  disabled_device_count: number;
  /** Newest `devices.last_seen_at` across the employee's devices. */
  last_device_seen_at: string | null;
  /** Newest of `profiles.last_seen_at` and the devices' `last_seen_at`. */
  last_activity_at: string | null;
  sync_state: SyncState;
  last_backup: BackupSummary | null;
  /** `storage_used_bytes / storage_quota_bytes`, null when no usable quota. */
  storage_percent: number | null;
};

export type UserDetail = {
  user: DirectoryUser;
  devices: UserDevice[];
  /** Non-deleted media owned by this employee (`media_assets.owner_id`). */
  media_count: number;
};

// ── Filters ────────────────────────────────────────────────────────────────

/**
 * `profiles.status` is constrained to exactly these two values, so there is no
 * "disabled" account state to filter on — `devices.status` is the column that
 * carries `active | disabled`.
 */
export type AccountStatusFilter = "ALL" | "active" | "suspended";

export type DeviceFilter =
  | "ALL"
  | "with_devices"
  | "without_devices"
  | "with_disabled";

export type SyncFilter = "ALL" | "ok" | "backing_up" | "failed" | "none";

export type StorageFilter =
  | "ALL"
  | "used_high"
  | "used_mid"
  | "used_low"
  | "no_quota";

export type DirectorySort = "name" | "recent" | "storage" | "newest";

export type DirectoryFilters = {
  search: string;
  status: AccountStatusFilter;
  devices: DeviceFilter;
  sync: SyncFilter;
  storage: StorageFilter;
  sort: DirectorySort;
};

export const DEFAULT_DIRECTORY_FILTERS: DirectoryFilters = {
  search: "",
  status: "ALL",
  devices: "ALL",
  sync: "ALL",
  storage: "ALL",
  sort: "name",
};

/** A view is the filter set + sort; the window size is applied on top. */
export type DirectoryView = DirectoryFilters;

export type DirectoryViewResult = {
  users: DirectoryUser[];
  /** Rows matching the view, before the window is applied. */
  matched: number;
  /** True when `matched` exceeds the rows actually returned. */
  capped: boolean;
};

export type DirectorySnapshot = DirectoryViewResult & {
  /** Profiles+devices scanned for this search term, before filters. */
  scanned: number;
  /** True when the profile scan hit `DIRECTORY_MAX_PROFILES`. */
  scanCapped: boolean;
  /** Roster size for this search term (before view filters). */
  total: number;
  /** True when the answer came from the server-side cache. */
  cached: boolean;
  /** Wall-clock time the snapshot was produced (server). */
  generatedAt: string;
};

// ── Query-string <-> filters ───────────────────────────────────────────────

type RawSearchParams = Record<string, string | string[] | undefined>;

function pick(params: RawSearchParams, key: string): string {
  const value = params[key];
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return value?.trim() ?? "";
}

function asStatus(value: string): AccountStatusFilter {
  return value === "active" || value === "suspended" ? value : "ALL";
}

function asDevices(value: string): DeviceFilter {
  return value === "with_devices" ||
    value === "without_devices" ||
    value === "with_disabled"
    ? value
    : "ALL";
}

function asSync(value: string): SyncFilter {
  return value === "ok" ||
    value === "backing_up" ||
    value === "failed" ||
    value === "none"
    ? value
    : "ALL";
}

function asStorage(value: string): StorageFilter {
  return value === "used_high" ||
    value === "used_mid" ||
    value === "used_low" ||
    value === "no_quota"
    ? value
    : "ALL";
}

function asSort(value: string): DirectorySort {
  return value === "recent" ||
    value === "storage" ||
    value === "newest"
    ? value
    : "name";
}

/** Parses `?q=&status=&devices=&sync=&storage=&sort=` into a validated view. */
export function parseDirectoryFilters(params: RawSearchParams): DirectoryFilters {
  return {
    search: sanitizeSearch(pick(params, "q")),
    status: asStatus(pick(params, "status")),
    devices: asDevices(pick(params, "devices")),
    sync: asSync(pick(params, "sync")),
    storage: asStorage(pick(params, "storage")),
    sort: asSort(pick(params, "sort")),
  };
}

/**
 * Only non-default values are written, so the canonical bookmark for the
 * default view stays `/admin/users`.
 */
export function directorySearchParams(filters: DirectoryFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  if (filters.status !== "ALL") params.set("status", filters.status);
  if (filters.devices !== "ALL") params.set("devices", filters.devices);
  if (filters.sync !== "ALL") params.set("sync", filters.sync);
  if (filters.storage !== "ALL") params.set("storage", filters.storage);
  if (filters.sort !== "name") params.set("sort", filters.sort);
  return params;
}

export function directoryHref(filters: DirectoryFilters): string {
  const query = directorySearchParams(filters).toString();
  return query ? `/admin/users?${query}` : "/admin/users";
}

/**
 * Stable identity of a view. Used to key the client snapshot cache and the
 * server-side result cache, so two identical views never cost anything twice.
 */
export function directoryViewKey(filters: DirectoryFilters): string {
  const parts: string[] = [filters.search];
  parts.push(
    filters.status,
    filters.devices,
    filters.sync,
    filters.storage,
    filters.sort,
  );
  return parts.join("|");
}

export function filtersActive(filters: DirectoryFilters): number {
  let count = 0;
  if (filters.status !== "ALL") count += 1;
  if (filters.devices !== "ALL") count += 1;
  if (filters.sync !== "ALL") count += 1;
  if (filters.storage !== "ALL") count += 1;
  return count;
}

// ── Search ─────────────────────────────────────────────────────────────────

export function searchTokens(filters: DirectoryFilters): string[] {
  const term = sanitizeSearch(filters.search).toLowerCase();
  if (!term) return [];
  return term.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TOKENS);
}

/**
 * Columns searched, in the order they are offered to the admin.
 * `employee_id` and `designation` are real `profiles` columns.
 */
export const SEARCH_COLUMNS = [
  "full_name",
  "email",
  "employee_id",
  "designation",
] as const;

/** One PostgREST `or=(...)` group for one token (ilike across the columns). */
export function searchOrGroup(token: string): string {
  const pattern = `%${token}%`;
  return SEARCH_COLUMNS.map((column) => `${column}.ilike.${pattern}`).join(",");
}

function haystack(user: ProfileRow): string {
  return [
    user.full_name ?? "",
    user.email ?? "",
    user.employee_id ?? "",
    user.designation ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * In-memory mirror of the SQL token match (every token must be present in any
 * of the searched columns). Applied after the SQL search so the rendered count
 * and the rendered rows always agree.
 */
export function matchesSearch(user: ProfileRow, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const text = haystack(user);
  return tokens.every((token) => text.includes(token));
}

// ── Numbers / timestamps ───────────────────────────────────────────────────

/** PostgREST returns `bigint` as a string; normalise without losing precision. */
export function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
}

function timeOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function newestOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  const ta = timeOf(a);
  const tb = timeOf(b);
  if (ta === null) return b;
  if (tb === null) return a;
  return tb > ta ? b : a;
}

/** Bigint-safe subtraction used for "remaining storage". */
export function bytesRemaining(
  quota: number | string | null | undefined,
  used: number | string | null | undefined,
): string | null {
  const q = toNumber(quota);
  const u = toNumber(used);
  if (q === null) return null;
  const remaining = q - (u ?? 0);
  return String(remaining > 0 ? remaining : 0);
}

// ── Derivation ─────────────────────────────────────────────────────────────

export function syncStateOf(status: string | null | undefined): SyncState {
  switch (status) {
    case "RUNNING":
      return "backing_up";
    case "COMPLETED":
      return "ok";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    default:
      return "none";
  }
}

/**
 * Employee-level sync state, attention-first.
 *
 * An employee can hold several devices, so one indicator has to summarise them.
 * The order is deliberate: a failure is never hidden behind a sibling device's
 * success, and a run in progress outranks everything (the state is moving).
 * Per-device truth is shown on the detail page.
 */
export function rollupSyncState(states: SyncState[]): SyncState {
  if (states.length === 0) return "none";
  if (states.includes("backing_up")) return "backing_up";
  if (states.includes("failed")) return "failed";
  if (states.includes("ok")) return "ok";
  if (states.includes("cancelled")) return "cancelled";
  return "none";
}

function toSummary(session: BackupSessionRow, deviceName: string | null): BackupSummary {
  return {
    device_id: session.device_id,
    device_name: deviceName,
    status: session.status,
    started_at: session.started_at,
    completed_at: session.completed_at,
    files_count: session.files_count,
    files_uploaded: session.files_uploaded,
    files_failed: session.files_failed,
    total_size_bytes: session.total_size_bytes,
    error_message: session.error_message,
  };
}

/**
 * Latest session per device.
 *
 * Sessions are read newest-first and reduced by `started_at`, so the result is
 * exact for everything inside the lookback window.
 */
function latestByDevice(
  sessions: BackupSessionRow[],
): Map<string, BackupSessionRow> {
  const map = new Map<string, BackupSessionRow>();
  for (const session of sessions) {
    const current = map.get(session.device_id);
    if (!current) {
      map.set(session.device_id, session);
      continue;
    }
    const next = timeOf(session.started_at);
    const kept = timeOf(current.started_at);
    if (next !== null && (kept === null || next > kept)) {
      map.set(session.device_id, session);
    }
  }
  return map;
}

function groupDevicesByUser(devices: DeviceRow[]): Map<string, DeviceRow[]> {
  const map = new Map<string, DeviceRow[]>();
  for (const device of devices) {
    const list = map.get(device.user_id);
    if (list) list.push(device);
    else map.set(device.user_id, [device]);
  }
  return map;
}

/**
 * Joins profiles, devices and backup sessions into the directory shape.
 * Pure: no queries, no clock reads, deterministic for a given input.
 */
export function buildDirectory(
  profiles: ProfileRow[],
  devices: DeviceRow[],
  sessions: BackupSessionRow[],
): DirectoryUser[] {
  const latestSessions = latestByDevice(sessions);
  const byUser = groupDevicesByUser(devices);

  return profiles.map((profile) => {
    const own = byUser.get(profile.id) ?? [];
    const disabled = own.filter((device) => device.status === "disabled").length;

    let lastDeviceSeen: string | null = null;
    const states: SyncState[] = [];
    // Latest session across the employee's devices, not per device.
    let best: { session: BackupSessionRow; device: DeviceRow } | null = null;

    for (const device of own) {
      lastDeviceSeen = newestOf(lastDeviceSeen, device.last_seen_at);

      const session = latestSessions.get(device.id);
      if (!session) continue;
      states.push(syncStateOf(session.status));

      if (!best) {
        best = { session, device };
        continue;
      }
      const next = timeOf(session.started_at);
      if (next === null) continue;
      const kept = timeOf(best.session.started_at);
      if (kept === null || next > kept) best = { session, device };
    }

    const lastBackup = best ? toSummary(best.session, best.device.device_name) : null;
    const quota = toNumber(profile.storage_quota_bytes);
    const used = toNumber(profile.storage_used_bytes);

    return {
      ...profile,
      device_count: own.length,
      active_device_count: own.length - disabled,
      disabled_device_count: disabled,
      last_device_seen_at: lastDeviceSeen,
      last_activity_at: newestOf(profile.last_seen_at, lastDeviceSeen),
      sync_state: rollupSyncState(states),
      last_backup: lastBackup,
      storage_percent:
        quota !== null && quota > 0 ? usagePercent(used, quota) : null,
    };
  });
}

/** One employee's devices, each carrying its latest backup in the window. */
export function buildUserDevices(
  devices: DeviceRow[],
  sessions: BackupSessionRow[],
): UserDevice[] {
  const latest = latestByDevice(sessions);
  return devices.map((device) => ({
    ...device,
    last_backup: latest.get(device.id) ?? null,
  }));
}

// ── Filter / sort / window ─────────────────────────────────────────────────

export function filterDirectory(
  users: DirectoryUser[],
  filters: DirectoryFilters,
): DirectoryUser[] {
  const tokens = searchTokens(filters);
  const storage = filters.storage;

  return users.filter((user) => {
    if (!matchesSearch(user, tokens)) return false;
    if (filters.status !== "ALL" && user.status !== filters.status) return false;

    if (filters.devices === "with_devices" && user.device_count === 0) return false;
    if (filters.devices === "without_devices" && user.device_count > 0) return false;
    if (filters.devices === "with_disabled" && user.disabled_device_count === 0) {
      return false;
    }

    if (filters.sync !== "ALL" && user.sync_state !== filters.sync) return false;

    if (storage !== "ALL") {
      const percent = user.storage_percent;
      if (storage === "no_quota" && percent !== null) return false;
      if (storage === "used_high" && (percent === null || percent < 90)) return false;
      if (
        storage === "used_mid" &&
        (percent === null || percent < 50 || percent >= 90)
      ) {
        return false;
      }
      if (storage === "used_low" && (percent === null || percent >= 50)) return false;
    }

    return true;
  });
}

function compareDesc(a: string | null, b: string | null): number {
  const ta = timeOf(a);
  const tb = timeOf(b);
  if (ta === null && tb === null) return 0;
  if (ta === null) return 1;
  if (tb === null) return -1;
  return tb - ta;
}

function compareNames(a: ProfileRow, b: ProfileRow): number {
  return employeeDisplayName(a).localeCompare(employeeDisplayName(b), "en", {
    sensitivity: "base",
  });
}

export function sortDirectory(
  users: DirectoryUser[],
  sort: DirectorySort,
): DirectoryUser[] {
  const copy = [...users];
  switch (sort) {
    case "recent":
      return copy.sort(
        (a, b) => compareDesc(a.last_activity_at, b.last_activity_at) || compareNames(a, b),
      );
    case "storage":
      return copy.sort(
        (a, b) =>
          (toNumber(b.storage_used_bytes) ?? -1) - (toNumber(a.storage_used_bytes) ?? -1) ||
          compareNames(a, b),
      );
    case "newest":
      return copy.sort(
        (a, b) => compareDesc(a.created_at, b.created_at) || compareNames(a, b),
      );
    default:
      return copy.sort(compareNames);
  }
}

/**
 * Applies the view: filter, sort, then reveal at most `limit` rows.
 *
 * `matched` is the true filtered count, so the UI can say "showing 25 of 312"
 * and never implies the window is the whole answer.
 */
export function viewDirectory(
  users: DirectoryUser[],
  filters: DirectoryFilters,
  limit: number = DIRECTORY_WINDOW,
): DirectoryViewResult {
  const filtered = filterDirectory(users, filters);
  const sorted = sortDirectory(filtered, filters.sort);
  const bounded = Math.max(1, Math.min(limit, DIRECTORY_VIEW_MAX));
  return {
    users: sorted.slice(0, bounded),
    matched: sorted.length,
    capped: sorted.length > bounded,
  };
}
