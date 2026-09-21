import { createClient } from "@/lib/supabase/server";
import {
  EMPLOYEE_PAGE_SIZE,
  MEDIA_PAGE_SIZE,
  isUuid,
  sanitizeSearch,
  type ArchiveFilter,
  type BackupSessionInfo,
  type CleanupFilter,
  type EmployeeFolder,
  type EmployeeRow,
  type EmployeeSummary,
  type MediaAsset,
  type MediaKind,
  type MediaListFilters,
  type MediaSort,
  type MediaStatusFilter,
} from "@/lib/media-types";

export {
  EMPLOYEE_PAGE_SIZE,
  MEDIA_PAGE_SIZE,
  employeeDisplayName,
  employeeInitials,
  isUuid,
  jobFor,
  mediaDevice,
  mediaJobs,
} from "@/lib/media-types";

export type {
  ArchiveFilter,
  BackupSessionInfo,
  CleanupFilter,
  DeviceInfo,
  EmployeeFolder,
  EmployeeRow,
  EmployeeSummary,
  MediaAsset,
  MediaKind,
  MediaListFilters,
  MediaSort,
  MediaStatusFilter,
  ReplicationJob,
} from "@/lib/media-types";

const PROFILE_COLUMNS =
  "id,full_name,email,employee_id,designation,status,storage_quota_bytes,storage_used_bytes,last_seen_at";

/**
 * Columns sent to the browser.
 *
 * `storage_url` and `thumbnail_url` are deliberately absent: they are permanent
 * provider URLs, and the admin panel reaches the bytes through the signed asset
 * route instead (`loadMediaForAsset` reads them server-side only).
 */
const MEDIA_COLUMNS = [
  "id",
  "owner_id",
  "device_id",
  "file_name",
  "mime_type",
  "file_size",
  "width",
  "height",
  "duration_ms",
  "storage_provider",
  "status",
  "created_at",
  "uploaded_at",
  "deleted_at",
  "drive_archived_at",
  "primary_cleanup_status",
  "primary_cleanup_attempts",
  "primary_cleanup_error",
  "primary_cleanup_started_at",
  "primary_cleanup_completed_at",
  "primary_deleted_at",
  "devices(id,device_name,brand,model,android_version,device_uid,status)",
  "replication_jobs(id,destination_type,status,last_error,attempt_count,started_at,completed_at,created_at)",
].join(",");

type Client = Awaited<ReturnType<typeof createClient>>;
/* eslint-disable @typescript-eslint/no-explicit-any */
type Filter = (query: any) => any;

export type AdminActorResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Server-side admin gate shared by the media server action and the signed asset
 * route. Always called with the request-scoped Supabase client so the check
 * runs against the caller's own session.
 */
export async function requireAdminActor(
  supabase: Client,
): Promise<AdminActorResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: actor } = await supabase
    .from("profiles")
    .select("id,role")
    .eq("id", user.id)
    .maybeSingle();
  if (!actor || actor.role !== "admin") {
    return { ok: false, error: "Not authorized." };
  }

  return { ok: true, id: user.id };
}

async function countOwnedMedia(
  supabase: Client,
  userId: string,
  extra?: Filter,
): Promise<number> {
  let query = supabase
    .from("media_assets")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", userId)
    .is("deleted_at", null)
    .neq("status", "DELETED");
  if (extra) query = extra(query);
  const { count } = await query;
  return count ?? 0;
}

export async function loadEmployeeFolders(input: {
  search?: string;
  page?: number;
}): Promise<{
  employees: EmployeeFolder[];
  total: number;
  page: number;
  pageSize: number;
  error: string | null;
}> {
  const supabase = await createClient();
  const page = Math.max(1, input.page ?? 1);
  const search = input.search ? sanitizeSearch(input.search) : "";

  let query = supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .order("full_name", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });

  if (search) {
    const term = `%${search}%`;
    query = query.or(
      `full_name.ilike.${term},email.ilike.${term},designation.ilike.${term}`,
    );
  }

  const { data, error } = await query;
  if (error) {
    return {
      employees: [],
      total: 0,
      page,
      pageSize: EMPLOYEE_PAGE_SIZE,
      error: error.message,
    };
  }

  const profiles = (data ?? []) as EmployeeRow[];
  const counts = await Promise.all(
    profiles.map(async (profile) => ({
      profile,
      media_count: await countOwnedMedia(supabase, profile.id),
    })),
  );

  // A user can have duplicate profile rows (for example after an account
  // recreation). Group by the stable display identity and keep the profile
  // that owns the most media, so one person is shown only once and the link
  // still opens the profile containing that person's media.
  const grouped = new Map<string, EmployeeFolder>();
  for (const { profile, media_count } of counts) {
    const identity = (profile.full_name?.trim() || profile.email?.trim() || profile.id).toLowerCase();
    const candidate = { ...profile, media_count };
    const existing = grouped.get(identity);
    if (!existing || candidate.media_count > existing.media_count) {
      grouped.set(identity, candidate);
    }
  }

  const employees = Array.from(grouped.values());
  const from = (page - 1) * EMPLOYEE_PAGE_SIZE;
  const pageEmployees = employees.slice(from, from + EMPLOYEE_PAGE_SIZE);

  return {
    employees: pageEmployees,
    total: employees.length,
    page,
    pageSize: EMPLOYEE_PAGE_SIZE,
    error: null,
  };
}

export async function loadEmployeeSummary(
  userId: string,
): Promise<{ employee: EmployeeSummary | null; error: string | null }> {
  if (!isUuid(userId)) return { employee: null, error: null };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", userId)
    .maybeSingle();

  if (error) return { employee: null, error: error.message };
  if (!data) return { employee: null, error: null };

  const profile = data as EmployeeRow;
  const [media_count, photo_count, video_count] = await Promise.all([
    countOwnedMedia(supabase, userId),
    countOwnedMedia(supabase, userId, (q) => q.ilike("mime_type", "image/%")),
    countOwnedMedia(supabase, userId, (q) => q.ilike("mime_type", "video/%")),
  ]);

  return {
    employee: { ...profile, media_count, photo_count, video_count },
    error: null,
  };
}

function applyMediaFilters(
  query: any,
  userId: string,
  filters: MediaListFilters,
) {
  let next = query.eq("owner_id", userId);
  const status: MediaStatusFilter = filters.status ?? "ALL";
  const kind: MediaKind = filters.kind ?? "ALL";
  const cleanup: CleanupFilter = filters.cleanup ?? "ALL";
  const archive: ArchiveFilter = filters.archive ?? "ALL";
  const search = filters.search ? sanitizeSearch(filters.search) : "";

  if (status === "DELETED") {
    next = next.or("status.eq.DELETED,deleted_at.not.is.null");
  } else {
    next = next.is("deleted_at", null).neq("status", "DELETED");
    if (status !== "ALL") next = next.eq("status", status);
  }

  if (kind === "IMAGE") next = next.ilike("mime_type", "image/%");
  if (kind === "VIDEO") next = next.ilike("mime_type", "video/%");
  if (cleanup !== "ALL") {
    next = next.eq("primary_cleanup_status", cleanup);
  }
  if (archive === "archived") {
    next = next.not("drive_archived_at", "is", null);
  }
  if (archive === "pending") {
    next = next.is("drive_archived_at", null);
  }
  if (filters.from) next = next.gte("created_at", filters.from);
  if (filters.to) next = next.lte("created_at", filters.to);

  if (search) {
    const term = `%${search}%`;
    next = isUuid(search)
      ? next.or(`id.eq.${search},file_name.ilike.${term}`)
      : next.ilike("file_name", term);
  }

  return next;
}

function applyMediaSort(query: any, sort: MediaSort) {
  switch (sort) {
    case "oldest":
      return query.order("created_at", { ascending: true });
    case "largest":
      return query.order("file_size", { ascending: false, nullsFirst: false });
    case "smallest":
      return query.order("file_size", { ascending: true, nullsFirst: false });
    case "name":
      return query.order("file_name", { ascending: true, nullsFirst: false });
    default:
      return query.order("created_at", { ascending: false });
  }
}

export async function loadEmployeeMedia(
  userId: string,
  filters: MediaListFilters,
): Promise<{
  media: MediaAsset[];
  total: number;
  page: number;
  pageSize: number;
  sessionsByDevice: Record<string, BackupSessionInfo>;
  error: string | null;
}> {
  const page = Math.max(1, filters.page ?? 1);
  const empty = {
    media: [] as MediaAsset[],
    total: 0,
    page,
    pageSize: MEDIA_PAGE_SIZE,
    sessionsByDevice: {} as Record<string, BackupSessionInfo>,
    error: null as string | null,
  };

  if (!isUuid(userId)) return empty;

  const supabase = await createClient();
  const from = (page - 1) * MEDIA_PAGE_SIZE;
  const to = from + MEDIA_PAGE_SIZE - 1;
  const sort = filters.sort ?? "newest";

  let query = supabase
    .from("media_assets")
    .select(MEDIA_COLUMNS, { count: "exact" });
  query = applyMediaFilters(query, userId, filters);
  query = applyMediaSort(query, sort);
  query = query.range(from, to);

  const { data, count, error } = await query;
  if (error) return { ...empty, error: error.message };

  const media = (data ?? []) as unknown as MediaAsset[];
  const deviceIds = Array.from(
    new Set(media.map((item) => item.device_id).filter((id): id is string => Boolean(id))),
  );

  const sessionsByDevice: Record<string, BackupSessionInfo> = {};
  if (deviceIds.length > 0) {
    const { data: sessions } = await supabase
      .from("backup_sessions")
      .select("id,device_id,started_at,completed_at,status,files_count")
      .in("device_id", deviceIds)
      .order("started_at", { ascending: false })
      .limit(deviceIds.length * 3);

    for (const session of (sessions ?? []) as BackupSessionInfo[]) {
      if (!sessionsByDevice[session.device_id]) {
        sessionsByDevice[session.device_id] = session;
      }
    }
  }

  return {
    media,
    total: count ?? 0,
    page,
    pageSize: MEDIA_PAGE_SIZE,
    sessionsByDevice,
    error: null,
  };
}

export async function ownedMediaIds(
  userId: string,
  mediaIds: string[],
): Promise<string[]> {
  if (!isUuid(userId) || mediaIds.length === 0) return [];
  const valid = mediaIds.filter(isUuid);
  if (valid.length === 0) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("media_assets")
    .select("id")
    .eq("owner_id", userId)
    .in("id", valid);

  if (error || !data) return [];
  return data.map((row) => row.id as string);
}

/** The only fields the signed asset route needs, including the provider URLs. */
export type MediaAssetSource = {
  id: string;
  owner_id: string;
  file_name: string | null;
  mime_type: string | null;
  storage_url: string | null;
  thumbnail_url: string | null;
};

/**
 * Server-only lookup for the streaming proxy. Ownership is part of the query,
 * so an asset belonging to another employee can never be resolved even with a
 * valid grant — this is what keeps the viewer inside one employee's media set.
 *
 * The returned row is never serialised to the browser: it carries the permanent
 * storage URL, which must stay server-side.
 */
export async function loadMediaForAsset(
  userId: string,
  mediaId: string,
): Promise<{ media: MediaAssetSource | null; error: string | null }> {
  if (!isUuid(userId) || !isUuid(mediaId)) return { media: null, error: null };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("media_assets")
    .select("id,owner_id,file_name,mime_type,storage_url,thumbnail_url")
    .eq("id", mediaId)
    .eq("owner_id", userId)
    .maybeSingle();

  if (error) return { media: null, error: error.message };
  return { media: (data as MediaAssetSource | null) ?? null, error: null };
}

