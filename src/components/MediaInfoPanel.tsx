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
  mediaDevice,
  mediaJobs,
  mediaKind,
  type BackupSessionInfo,
  type MediaAsset,
  type MediaKindName,
} from "@/lib/media-types";

export type MediaInfoTone = "light" | "dark";

type InfoRow = { label: string; value: string; icon?: string };

function buildFileSection(media: MediaAsset, kind: MediaKindName): InfoRow[] {
  const rows: InfoRow[] = [
    { label: "Filename", value: media.file_name || "—" },
    { label: "Type", value: kindLabel(kind) },
    { label: "MIME", value: media.mime_type || "—" },
    { label: "Size", value: formatBytes(media.file_size) ?? "—" },
  ];
  if (media.width && media.height) {
    rows.push({ label: "Dimensions", value: `${media.width} × ${media.height}` });
  }
  if (media.duration_ms) {
    rows.push({ label: "Duration", value: durationLabel(media.duration_ms) });
  }
  return rows;
}

function buildDateSection(media: MediaAsset): InfoRow[] {
  return [
    { label: "Captured", value: formatTimestamp(media.created_at) ?? "—" },
    { label: "Uploaded", value: formatTimestamp(media.uploaded_at) ?? "—" },
  ];
}

function buildEmployeeSection(
  employeeName: string,
  employeeId: string | null,
  designation: string | null,
): InfoRow[] {
  return [
    { label: "Name", value: employeeName },
    { label: "Employee ID", value: employeeId || "Not assigned" },
    { label: "Designation", value: designation || "Not assigned" },
  ];
}

function buildDeviceSection(
  media: MediaAsset,
  session: BackupSessionInfo | null,
): InfoRow[] {
  const device = mediaDevice(media);
  const rows: InfoRow[] = [
    { label: "Source device", value: device ? deviceLabel(media) : "—" },
    { label: "Device ID", value: device?.device_uid || device?.id || "—" },
  ];
  if (session) {
    rows.push({ label: "Backup session", value: session.id });
    rows.push({ label: "Session started", value: formatTimestamp(session.started_at) ?? "—" });
    rows.push({ label: "Session completed", value: formatTimestamp(session.completed_at) ?? "—" });
    rows.push({ label: "Session status", value: session.status || "—" });
    if (session.files_count != null) {
      rows.push({ label: "Session files", value: String(session.files_count) });
    }
  }
  return rows;
}

function buildStorageSection(media: MediaAsset): InfoRow[] {
  return [
    { label: "Status", value: media.status },
    { label: "Provider", value: media.storage_provider || "—" },
    {
      label: "Archive",
      value: media.drive_archived_at
        ? `Verified ${formatTimestamp(media.drive_archived_at)}`
        : "Not archived",
    },
    { label: "Served from", value: sourceLabel(media) },
    { label: "Cleanup", value: cleanupLabel(media.primary_cleanup_status) },
  ];
}

function SectionBlock({
  title,
  rows,
  tone,
}: {
  title: string;
  rows: InfoRow[];
  tone: MediaInfoTone;
}) {
  if (rows.length === 0) return null;

  const labelClass = tone === "dark" ? "text-gray-400" : "text-gray-500";
  const valueClass = tone === "dark" ? "text-gray-100" : "text-gray-900";

  return (
    <div className="mb-4 last:mb-0">
      <h3
        className={`mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider ${
          tone === "dark" ? "text-gray-500" : "text-gray-400"
        }`}
      >
        {title}
      </h3>
      <div
        className={`rounded-lg border ${
          tone === "dark"
            ? "border-white/10 bg-white/[0.03]"
            : "border-gray-100 bg-gray-50/80"
        }`}
      >
        <dl className="divide-y divide-gray-100 dark:divide-white/5">
          {rows.map((row) => (
            <div
              key={row.label}
              className="grid grid-cols-[5.5rem_1fr] items-baseline gap-2 px-3 py-2 sm:grid-cols-[7rem_1fr]"
            >
              <dt className={`truncate text-[11px] sm:text-xs ${labelClass}`}>
                {row.label}
              </dt>
              <dd
                className={`min-w-0 break-words text-xs font-medium sm:text-[13px] ${valueClass}`}
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

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
  const kind = mediaKind(media);
  const jobs = mediaJobs(media);

  const fileRows = buildFileSection(media, kind);
  const dateRows = buildDateSection(media);
  const employeeRows = buildEmployeeSection(employeeName, employeeId, designation);
  const deviceRows = buildDeviceSection(media, session);
  const storageRows = buildStorageSection(media);

  const heading = tone === "dark" ? "text-white" : "text-gray-900";
  const jobCard =
    tone === "dark"
      ? "border-white/10 bg-white/5"
      : "border-gray-200 bg-gray-50/80";
  const label = tone === "dark" ? "text-gray-400" : "text-gray-500";

  return (
    <div className="text-sm">
      <SectionBlock title="File" rows={fileRows} tone={tone} />
      <SectionBlock title="Date" rows={dateRows} tone={tone} />
      <SectionBlock title="Employee" rows={employeeRows} tone={tone} />
      <SectionBlock title="Device & Session" rows={deviceRows} tone={tone} />
      <SectionBlock title="Storage" rows={storageRows} tone={tone} />

      {media.primary_cleanup_error && (
        <div className="mb-4">
          <h3
            className={`mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider ${
              tone === "dark" ? "text-gray-500" : "text-gray-400"
            }`}
          >
            Cleanup Error
          </h3>
          <div
            className={`rounded-lg border px-3 py-2 text-xs ${
              tone === "dark"
                ? "border-red-500/20 bg-red-500/10 text-red-300"
                : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            {media.primary_cleanup_error}
          </div>
        </div>
      )}

      <div className="mb-4">
        <h3
          className={`mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider ${
            tone === "dark" ? "text-gray-500" : "text-gray-400"
          }`}
        >
          Media ID
        </h3>
        <p
          className={`rounded-lg border px-3 py-2 font-mono text-[11px] ${
            tone === "dark"
              ? "border-white/10 bg-white/[0.03] text-gray-400"
              : "border-gray-100 bg-gray-50/80 text-gray-500"
          }`}
        >
          {media.id}
        </p>
      </div>

      {jobs.length > 0 && (
        <div className="mb-4">
          <h3
            className={`mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider ${
              tone === "dark" ? "text-gray-500" : "text-gray-400"
            }`}
          >
            Replication Jobs
          </h3>
          <ul className="space-y-1.5">
            {jobs.map((job) => (
              <li
                key={job.id}
                className={`rounded-lg border px-3 py-2 ${jobCard}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className={`text-xs font-semibold ${heading}`}>
                    {job.destination_type === "google_drive"
                      ? "Google Drive"
                      : "Telegram"}
                  </span>
                  <StatusBadge label={job.status} tone={jobTone(job.status)} />
                </div>
                <p className={`mt-1 text-[11px] ${label}`}>
                  Attempts: {job.attempt_count ?? 0} ·{" "}
                  {formatTimestamp(
                    job.completed_at || job.started_at || job.created_at,
                  ) ?? "—"}
                </p>
                {job.last_error && (
                  <p className="mt-1 truncate text-[11px] text-red-500">
                    {job.last_error}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
