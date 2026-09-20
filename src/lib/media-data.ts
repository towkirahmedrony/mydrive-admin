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
  "storage_path",
  "storage_url",
  "thumbnail_url",
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

function asNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : 0;
}

type Client = Awaited<ReturnType<typeof createClient>>;
/* eslint-disable @typescript-eslint/no-explicit-any */
type Filter = (query: any) => any;

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

async function loadUsageByOwner(
  supabase: Client,
  ownerIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (ownerIds.length === 0) return map;

  const { data, error } = await supabase
    .from("device_storage_usage")
    .select("user_id,file_count")
    .in("user_id", ownerIds);

  if (!error && data) {
    for (const row of data as { user_id: string; file_count: number | string | null }[]) {
      map.set(row.user_id, (map.get(row.user_id) ?? 0) + asNumber(row.file_count));
    }
    return map;
  }

  const counts = await Promise.all(
    ownerIds.map(async (id) => {
      const { count } = await supabase
        .from("media_assets")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", id)
        .is("deleted_at", null)
        .neq("status", "DELETED");
      return { id, count: count ?? 0 };
    }),
  );
  for (const row of counts) map.set(row.id, row.count);
  return map;
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
  const from = (page - 1) * EMPLOYEE_PAGE_SIZE;
  const to = from + EMPLOYEE_PAGE_SIZE - 1;
  const search = input.search ? sanitizeSearch(input.search) : "";

  let query = supabase
    .from("profiles")
    .select(PROFILE_COLUMNS, { count: "exact" })
    .order("full_name", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .range(from, to);

  if (search) {
    const term = `%${search}%`;
    query = query.or(
      `full_name.ilike.${term},email.ilike.${term},employee_id.ilike.${term},designation.ilike.${term}`,
    );
  }

  const { data, count, error } = await query;
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
  const usage = await loadUsageByOwner(
    supabase,
    profiles.map((profile) => profile.id),
  );

  return {
    employees: profiles.map((profile) => ({
      ...profile,
      media_count: usage.get(profile.id) ?? 0,
    })),
    total: count ?? 0,
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
