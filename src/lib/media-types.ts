export const EMPLOYEE_PAGE_SIZE = 24;
export const MEDIA_PAGE_SIZE = 24;

/**
 * Lifetime of a signed media access link.
 *
 * Long enough to cover an uninterrupted browsing session in the admin panel,
 * short enough that a link that leaks (browser history, referrer, screenshot,
 * shared devtools URL) stops working quickly. A fresh grant is minted on every
 * server render and on demand from the viewer.
 */
export const MEDIA_ACCESS_TTL_SECONDS = 60 * 60;

/** Which upstream URL an asset request should resolve to. */
export type MediaVariant = "thumb" | "original";

/**
 * A short-lived grant that authorises reading one employee's media set.
 *
 * `token` is an HMAC over the employee id and the expiry instant; it is minted
 * and verified on the server only (`@/lib/media-access`). Only the derived URL
 * is ever handed to the browser — never a provider URL, and never a key.
 */
export type MediaAccessGrant = {
  token: string;
  expiresAt: number;
};

export type EmployeeRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  employee_id: string | null;
  designation: string | null;
  status: string;
  storage_quota_bytes: number | string | null;
  storage_used_bytes: number | string | null;
  last_seen_at: string | null;
};

export type EmployeeFolder = EmployeeRow & {
  media_count: number;
};

export type EmployeeSummary = EmployeeRow & {
  media_count: number;
  photo_count: number;
  video_count: number;
};

export type DeviceInfo = {
  id: string;
  device_name: string | null;
  brand: string | null;
  model: string | null;
  android_version: string | null;
  device_uid: string | null;
  status: string | null;
};

export type ReplicationJob = {
  id: string;
  destination_type: string;
  status: string;
  last_error: string | null;
  attempt_count: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string | null;
};

export type BackupSessionInfo = {
  id: string;
  device_id: string;
  started_at: string | null;
  completed_at: string | null;
  status: string | null;
  files_count: number | null;
};

/**
 * A media asset as the browser receives it.
 *
 * The storage locators (`storage_path`, `storage_url`, `thumbnail_url`) are
 * intentionally not part of this shape: the server does not select them for the
 * client, and the browser reaches the bytes through `mediaAssetPath(...)`.
 * `loadMediaForAsset` (server-only) reads them when proxying.
 */
export type MediaAsset = {
  id: string;
  owner_id: string;
  device_id: string | null;
  file_name: string | null;
  mime_type: string | null;
  file_size: number | string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | string | null;
  storage_provider: string | null;
  status: string;
  created_at: string;
  uploaded_at: string | null;
  deleted_at: string | null;
  drive_archived_at: string | null;
  primary_cleanup_status: string | null;
  primary_cleanup_attempts: number | null;
  primary_cleanup_error: string | null;
  primary_cleanup_started_at: string | null;
  primary_cleanup_completed_at: string | null;
  primary_deleted_at: string | null;
  devices: DeviceInfo | DeviceInfo[] | null;
  replication_jobs: ReplicationJob[] | null;
};

export type MediaKind = "ALL" | "IMAGE" | "VIDEO";
export type MediaStatusFilter = "ALL" | "UPLOADING" | "READY" | "FAILED" | "DELETED";
export type CleanupFilter =
  | "ALL"
  | "none"
  | "cleanup_pending"
  | "cleanup_processing"
  | "cleanup_success"
  | "cleanup_failed";
export type ArchiveFilter = "ALL" | "archived" | "pending";
export type MediaSort = "newest" | "oldest" | "largest" | "smallest" | "name";

export type MediaListFilters = {
  search?: string;
  kind?: MediaKind;
  status?: MediaStatusFilter;
  cleanup?: CleanupFilter;
  archive?: ArchiveFilter;
  sort?: MediaSort;
  from?: string;
  to?: string;
  page?: number;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function sanitizeSearch(raw: string): string {
  return raw.trim().replace(/[%_,()]/g, " ").replace(/\s+/g, " ").trim();
}

export function employeeInitials(
  name: string | null | undefined,
  email: string | null | undefined,
): string {
  const source = name?.trim() || email?.trim() || "";
  if (!source) return "EM";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

export function employeeDisplayName(
  employee: Pick<EmployeeRow, "full_name" | "email" | "employee_id">,
): string {
  return (
    employee.full_name?.trim() ||
    employee.email?.trim() ||
    employee.employee_id?.trim() ||
    "Unnamed employee"
  );
}

/**
 * Builds the only media URL the browser is ever allowed to see.
 *
 * The permanent provider URL (`media_assets.storage_url` / `thumbnail_url`)
 * stays on the server; the client composes this authenticated, expiring admin
 * route instead. `@/lib/media-access` mints the matching grant.
 */
export function mediaAssetPath(
  userId: string,
  mediaId: string,
  grant: MediaAccessGrant,
  variant: MediaVariant = "original",
): string {
  const params = new URLSearchParams({
    e: String(grant.expiresAt),
    t: grant.token,
  });
  if (variant === "thumb") params.set("variant", "thumb");
  return `/admin/media/${userId}/asset/${mediaId}?${params.toString()}`;
}

export type MediaKindName = "image" | "video" | "other";

export function mediaKind(media: Pick<MediaAsset, "mime_type">): MediaKindName {
  const mime = media.mime_type?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "other";
}

export function isVideoMedia(media: Pick<MediaAsset, "mime_type">): boolean {
  return mediaKind(media) === "video";
}

export function isImageMedia(media: Pick<MediaAsset, "mime_type">): boolean {
  return mediaKind(media) === "image";
}

export function mediaDevice(media: MediaAsset): DeviceInfo | null {
  if (!media.devices) return null;
  return Array.isArray(media.devices) ? media.devices[0] ?? null : media.devices;
}

export function mediaJobs(media: MediaAsset): ReplicationJob[] {
  return media.replication_jobs ?? [];
}

export function jobFor(
  media: MediaAsset,
  destination: string,
): ReplicationJob | undefined {
  return mediaJobs(media).find((job) => job.destination_type === destination);
}
