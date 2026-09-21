import StatusBadge from "@/components/StatusBadge";
import { formatBytes, formatTimestamp } from "@/lib/format";
import {
  cleanupLabel,
  deviceLabel,
  durationLabel,
  jobTone,
  kindLabel,
  sourceLabel,
} from "@/lib/media-display";
import {
  jobFor,
  mediaDevice,
  mediaJobs,
  mediaKind,
  type BackupSessionInfo,
  type MediaAsset,
} from "@/lib/media-types";

export type MediaInfoTone = "light" | "dark";

/**
 * The single metadata panel for a media asset, shared by the detail drawer on
 * the media page and the viewer's side panel so the two never drift apart.
 *
 * Every row maps to a column that actually exists on `media_assets`, its joined
 * `devices` row, its `replication_jobs` rows or the employee's latest
 * `backup_sessions` row. Storage locators (`storage_url`, `storage_path`,
 * `storage_asset_id`), the signed access URL and any credential are deliberately
 * absent — this panel is rendered in the browser.
 */
export default function MediaInfoPanel({
  media,
  employeeName,
  employeeId,
  designation,
  session,
  tone = "light",
}: {
  media: MediaAsset;
  employeeName: string;
  employeeId: string | null;
  designation: string | null;
  session: BackupSessionInfo | null;
  tone?: MediaInfoTone;
}) {
  const device = mediaDevice(media);
  const jobs = mediaJobs(media);
  const drive = jobFor(media, "google_drive");
  const telegram = jobFor(media, "telegram");
  const kind = mediaKind(media);

  const rows: Array<[string, string]> = [
    ["Filename", media.file_name || "—"],
    ["Kind", kindLabel(kind)],
    ["Media type", media.mime_type || "—"],
    ["File size", formatBytes(media.file_size) ?? "—"],
    [
      "Dimensions",
      media.width && media.height ? `${media.width} × ${media.height}` : "—",
    ],
    ["Duration", durationLabel(media.duration_ms)],
    ["Captured / created", formatTimestamp(media.created_at) ?? "—"],
    ["Uploaded", formatTimestamp(media.uploaded_at) ?? "—"],
    ["Employee", employeeName],
    ["Employee ID", employeeId || "Not assigned"],
    ["Designation", designation || "Not assigned"],
    ["Source device", device ? deviceLabel(media) : "—"],
    ["Device ID", device?.device_uid || device?.id || "—"],
    ["Backup session", session?.id || "—"],
    ["Backup started", formatTimestamp(session?.started_at) ?? "—"],
    ["Backup completed", formatTimestamp(session?.completed_at) ?? "—"],
    ["Session status", session?.status || "—"],
    ["Session files", session?.files_count != null ? String(session.files_count) : "—"],
    ["Status", media.status],
    ["Storage provider", media.storage_provider || "—"],
    [
      "Drive archive",
      media.drive_archived_at
        ? `Verified ${formatTimestamp(media.drive_archived_at)}`
        : "Not archived",
    ],
    ["Drive job", drive?.status || "—"],
    // Where the bytes actually come from. After a verified archive the
    // Cloudinary original is removed on purpose, so the Drive copy is the
    // live source and the panel must not imply the media is missing.
    ["Served from", sourceLabel(media)],
    ["Telegram job", telegram?.status || "—"],
    ["Cleanup", cleanupLabel(media.primary_cleanup_status)],
    ["Cleanup completed", formatTimestamp(media.primary_cleanup_completed_at) ?? "—"],
    ["Primary deleted", formatTimestamp(media.primary_deleted_at) ?? "—"],
    ["Media ID", media.id],
  ];

  const label = tone === "dark" ? "text-gray-400" : "text-gray-500";
  const value = tone === "dark" ? "text-gray-100" : "text-gray-900";
  const divider = tone === "dark" ? "divide-white/10" : "divide-gray-100";
  const heading = tone === "dark" ? "text-white" : "text-gray-900";
  const jobCard =
    tone === "dark"
      ? "border-white/10 bg-white/5"
      : "border-gray-200 bg-white";

  return (
    <div className="text-sm">
      <dl className={`divide-y ${divider}`}>
        {rows.map(([term, description]) => (
          <div
            key={term}
            className="grid grid-cols-[7.5rem_1fr] gap-3 py-2.5 sm:grid-cols-[9rem_1fr] sm:gap-4"
          >
            <dt className={`text-xs sm:text-sm ${label}`}>{term}</dt>
            <dd className={`break-words font-medium ${value}`}>{description}</dd>
          </div>
        ))}
      </dl>

      {jobs.length > 0 && (
        <div className="mt-5">
          <h3 className={`text-sm font-semibold ${heading}`}>Replication jobs</h3>
          <ul className="mt-3 space-y-2">
            {jobs.map((job) => (
              <li
                key={job.id}
                className={`rounded-lg border px-3 py-2 text-sm ${jobCard}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className={`font-medium ${heading}`}>
                    {job.destination_type === "google_drive"
                      ? "Google Drive"
                      : "Telegram"}
                  </span>
                  <StatusBadge label={job.status} tone={jobTone(job.status)} />
                </div>
                <p className={`mt-1 text-xs ${label}`}>
                  Attempts: {job.attempt_count ?? 0} ·{" "}
                  {formatTimestamp(job.completed_at || job.started_at || job.created_at) ??
                    "—"}
                </p>
                {job.last_error && (
                  <p className="mt-1 text-xs text-red-500">{job.last_error}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
