"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import EmptyState from "@/components/EmptyState";
import StatusBadge from "@/components/StatusBadge";
import { formatBytes, formatTimestamp, type Tone } from "@/lib/format";
import {
  jobFor,
  mediaDevice,
  mediaJobs,
  type BackupSessionInfo,
  type MediaAsset,
} from "@/lib/media-types";
import { retryEmployeeMediaJobs } from "../actions";

type ViewMode = "grid" | "list";

function isVideo(media: MediaAsset): boolean {
  return media.mime_type?.toLowerCase().startsWith("video/") ?? false;
}

function jobTone(status: string | undefined): Tone {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED") return "danger";
  if (status) return "warning";
  return "neutral";
}

function cleanupTone(status: string | null | undefined): Tone {
  if (status === "cleanup_success") return "success";
  if (status === "cleanup_failed") return "danger";
  if (status === "cleanup_pending" || status === "cleanup_processing") return "warning";
  return "neutral";
}

function cleanupLabel(status: string | null | undefined): string {
  switch (status) {
    case "cleanup_pending":
      return "Cleanup pending";
    case "cleanup_processing":
      return "Cleanup processing";
    case "cleanup_success":
      return "Cleanup success";
    case "cleanup_failed":
      return "Cleanup failed";
    default:
      return "Cleanup none";
  }
}

function archiveLabel(media: MediaAsset): string {
  return media.drive_archived_at ? "Drive verified" : "Not archived";
}

function deviceLabel(media: MediaAsset): string {
  const device = mediaDevice(media);
  if (!device) return "Unknown device";
  return (
    device.device_name ||
    [device.brand, device.model].filter(Boolean).join(" ") ||
    "Unnamed device"
  );
}

function durationLabel(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!n || !Number.isFinite(n)) return "—";
  return `${Math.round(n / 1000)}s`;
}

function Thumbnail({ media }: { media: MediaAsset }) {
  const video = isVideo(media);
  if (media.thumbnail_url && !video) {
    return (
      <img
        src={media.thumbnail_url}
        alt=""
        loading="lazy"
        className="h-full w-full object-cover"
      />
    );
  }
  return (
    <div className={`flex h-full items-center justify-center ${video ? "bg-slate-900 text-white" : "bg-gray-100 text-gray-400"}`}>
      <span className="text-2xl">{video ? "▶" : "▣"}</span>
    </div>
  );
}

export default function MediaBrowser({
  userId,
  employeeName,
  employeeId,
  designation,
  media,
  sessionsByDevice,
}: {
  userId: string;
  employeeName: string;
  employeeId: string | null;
  designation: string | null;
  media: MediaAsset[];
  sessionsByDevice: Record<string, BackupSessionInfo>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<MediaAsset | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const view = (searchParams.get("view") === "list" ? "list" : "grid") as ViewMode;
  const q = searchParams.get("q") ?? "";
  const kind = searchParams.get("kind") ?? "ALL";
  const status = searchParams.get("status") ?? "ALL";
  const archive = searchParams.get("archive") ?? "ALL";
  const cleanup = searchParams.get("cleanup") ?? "ALL";
  const sort = searchParams.get("sort") ?? "newest";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const [inputQuery, setInputQuery] = useState(q);

  const selectedMedia = useMemo(
    () => media.filter((item) => selected.has(item.id)),
    [media, selected],
  );
  const allSelected = media.length > 0 && media.every((item) => selected.has(item.id));

  const setParam = useCallback((key: string, value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (!value || value === "ALL" || (key === "view" && value === "grid") || (key === "sort" && value === "newest")) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    if (key !== "page") next.delete("page");
    const query = next.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }, [pathname, router, searchParams]);

  useEffect(() => {
    setInputQuery(q);
  }, [q]);

  useEffect(() => {
    if (inputQuery.trim() === q) return;
    const timer = window.setTimeout(() => setParam("q", inputQuery.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [inputQuery, q, setParam]);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function toggleAll() {
    const next = new Set(selected);
    if (allSelected) media.forEach((item) => next.delete(item.id));
    else media.forEach((item) => next.add(item.id));
    setSelected(next);
  }

  function retrySelected() {
    if (!selectedMedia.length || pending) return;
    setNotice(null);
    setError(null);
    startTransition(async () => {
      const result = await retryEmployeeMediaJobs(
        userId,
        selectedMedia.map((item) => item.id),
      );
      if (!result.success) {
        setError(result.error || "Retry failed.");
        return;
      }
      setNotice(`${result.retried} replication job${result.retried === 1 ? "" : "s"} queued for retry.`);
      setSelected(new Set());
      router.refresh();
    });
  }

  const selectClass = "rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm";

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <label className="relative flex-1">
            <span className="sr-only">Search media</span>
            <input
              value={inputQuery}
              onChange={(event) => setInputQuery(event.target.value)}
              placeholder="Search this employee's media by filename or ID"
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm outline-none ring-primary-500 placeholder:text-gray-400 focus:ring-2"
            />
          </label>
          <select value={kind} onChange={(event) => setParam("kind", event.target.value)} className={selectClass}>
            <option value="ALL">Type</option>
            <option value="IMAGE">Images</option>
            <option value="VIDEO">Videos</option>
          </select>
          <select value={status} onChange={(event) => setParam("status", event.target.value)} className={selectClass}>
            <option value="ALL">Status</option>
            <option value="READY">Ready</option>
            <option value="UPLOADING">Uploading</option>
            <option value="FAILED">Failed</option>
            <option value="DELETED">Deleted</option>
          </select>
          <select value={archive} onChange={(event) => setParam("archive", event.target.value)} className={selectClass}>
            <option value="ALL">Archive</option>
            <option value="archived">Drive verified</option>
            <option value="pending">Not archived</option>
          </select>
          <select value={cleanup} onChange={(event) => setParam("cleanup", event.target.value)} className={selectClass}>
            <option value="ALL">Cleanup</option>
            <option value="none">None</option>
            <option value="cleanup_pending">Pending</option>
            <option value="cleanup_processing">Processing</option>
            <option value="cleanup_success">Success</option>
            <option value="cleanup_failed">Failed</option>
          </select>
          <select value={sort} onChange={(event) => setParam("sort", event.target.value)} className={selectClass}>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="largest">Largest</option>
            <option value="smallest">Smallest</option>
            <option value="name">Filename</option>
          </select>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-600">
            From
            <input type="date" value={from.slice(0, 10)} onChange={(event) => setParam("from", event.target.value ? `${event.target.value}T00:00:00.000Z` : "")} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-600">
            To
            <input type="date" value={to.slice(0, 10)} onChange={(event) => setParam("to", event.target.value ? `${event.target.value}T23:59:59.999Z` : "")} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
          </label>
          <div className="ml-auto flex rounded-lg border border-gray-300 p-1">
            <button type="button" onClick={() => setParam("view", "grid")} aria-pressed={view === "grid"} className={`rounded px-2.5 py-1 text-sm ${view === "grid" ? "bg-primary-600 text-white" : "text-gray-600"}`}>
              Grid
            </button>
            <button type="button" onClick={() => setParam("view", "list")} aria-pressed={view === "list"} className={`rounded px-2.5 py-1 text-sm ${view === "list" ? "bg-primary-600 text-white" : "text-gray-600"}`}>
              List
            </button>
          </div>
        </div>
      </section>

      {selected.size > 0 && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary-200 bg-primary-50 px-4 py-3 text-sm">
          <p className="font-medium text-primary-900">Selected: {selected.size} media</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={retrySelected}
              disabled={pending}
              className="rounded-lg bg-primary-600 px-3 py-2 font-medium text-white disabled:opacity-50"
            >
              {pending ? "Retrying..." : "Retry eligible jobs"}
            </button>
            <button
              type="button"
              onClick={() => {
                setNotice(null);
                setError(null);
                router.refresh();
              }}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-700"
            >
              Recheck status
            </button>
          </div>
        </section>
      )}

      {notice && <div role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">{notice}</div>}
      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

      {media.length === 0 ? (
        <EmptyState
          icon="▣"
          title="No media in this folder"
          detail={q || kind !== "ALL" || status !== "ALL" || archive !== "ALL" || cleanup !== "ALL" || from || to
            ? "Try clearing a filter or changing the search."
            : "Media uploaded by this employee will appear here."}
        />
      ) : view === "grid" ? (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {media.map((item) => {
            const drive = jobFor(item, "google_drive");
            const video = isVideo(item);
            return (
              <article
                key={item.id}
                className={`group overflow-hidden rounded-xl border bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${selected.has(item.id) ? "border-primary-500 ring-2 ring-primary-100" : "border-gray-200"}`}
              >
                <div className="relative aspect-[4/3] bg-gray-100">
                  <Thumbnail media={item} />
                  <label className="absolute left-3 top-3 rounded-md bg-white/95 p-1.5 shadow-sm" onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      onChange={() => toggle(item.id)}
                      aria-label={`Select ${item.file_name || item.id}`}
                      className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                    />
                  </label>
                  {video && <span className="absolute right-3 top-3 rounded-full bg-black/65 px-2 py-1 text-xs font-semibold text-white">VIDEO</span>}
                  <button
                    type="button"
                    onClick={() => setDetail(item)}
                    className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-4 pb-3 pt-8 text-left text-white opacity-0 transition group-hover:opacity-100 focus:opacity-100"
                  >
                    Open details
                  </button>
                </div>
                <div className="space-y-3 p-4">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold text-gray-900" title={item.file_name || item.id}>
                      {item.file_name || "Untitled media"}
                    </h2>
                    <p className="mt-1 truncate text-xs text-gray-500">
                      {formatBytes(item.file_size) ?? "—"} · {formatTimestamp(item.uploaded_at || item.created_at) ?? "—"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <StatusBadge label={item.status} tone={item.status === "READY" ? "success" : item.status === "FAILED" ? "danger" : "warning"} />
                    <StatusBadge label={archiveLabel(item)} tone={item.drive_archived_at ? "success" : "neutral"} />
                    <StatusBadge label={cleanupLabel(item.primary_cleanup_status)} tone={cleanupTone(item.primary_cleanup_status)} />
                    <StatusBadge label={`Drive: ${drive?.status || "—"}`} tone={jobTone(drive?.status)} />
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-3">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-4 w-4 rounded border-gray-300 text-primary-600" aria-label="Select all on this page" />
                  </th>
                  <th className="px-4 py-3">Preview</th>
                  <th className="px-4 py-3">Filename</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Size</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Archive</th>
                  <th className="px-4 py-3">Cleanup</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {media.map((item) => (
                  <tr key={item.id} className="cursor-pointer hover:bg-gray-50" onClick={() => setDetail(item)}>
                    <td className="px-4 py-3" onClick={(event) => event.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} className="h-4 w-4 rounded border-gray-300 text-primary-600" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="h-12 w-16 overflow-hidden rounded bg-gray-100">
                        <Thumbnail media={item} />
                      </div>
                    </td>
                    <td className="max-w-xs px-4 py-3">
                      <p className="truncate font-medium text-gray-900">{item.file_name || item.id}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{isVideo(item) ? "Video" : "Image"}</td>
                    <td className="px-4 py-3 text-gray-600">{formatBytes(item.file_size) ?? "—"}</td>
                    <td className="px-4 py-3 text-gray-600">{formatTimestamp(item.uploaded_at || item.created_at) ?? "—"}</td>
                    <td className="px-4 py-3">
                      <StatusBadge label={archiveLabel(item)} tone={item.drive_archived_at ? "success" : "neutral"} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge label={cleanupLabel(item.primary_cleanup_status)} tone={cleanupTone(item.primary_cleanup_status)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {detail && (
        <MediaDetail
          media={detail}
          employeeName={employeeName}
          employeeId={employeeId}
          designation={designation}
          session={detail.device_id ? sessionsByDevice[detail.device_id] ?? null : null}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

function MediaDetail({
  media,
  employeeName,
  employeeId,
  designation,
  session,
  onClose,
}: {
  media: MediaAsset;
  employeeName: string;
  employeeId: string | null;
  designation: string | null;
  session: BackupSessionInfo | null;
  onClose: () => void;
}) {
  const device = mediaDevice(media);
  const jobs = mediaJobs(media);
  const drive = jobFor(media, "google_drive");
  const telegram = jobFor(media, "telegram");

  const rows: Array<[string, string]> = [
    ["Media ID", media.id],
    ["Filename", media.file_name || "—"],
    ["Type", media.mime_type || "—"],
    ["Size", formatBytes(media.file_size) ?? "—"],
    ["Dimensions", media.width && media.height ? `${media.width} × ${media.height}` : "—"],
    ["Duration", durationLabel(media.duration_ms)],
    ["Created", formatTimestamp(media.created_at) ?? "—"],
    ["Uploaded", formatTimestamp(media.uploaded_at) ?? "—"],
    ["Employee", employeeName],
    ["Employee ID", employeeId || "Not assigned"],
    ["Designation", designation || "Not assigned"],
    ["Cloudinary / origin", media.status],
    ["Storage provider", media.storage_provider || "—"],
    ["Drive archive", media.drive_archived_at ? `Verified ${formatTimestamp(media.drive_archived_at)}` : "Not archived"],
    ["Drive job", drive?.status || "—"],
    ["Telegram job", telegram?.status || "—"],
    ["Cleanup", cleanupLabel(media.primary_cleanup_status)],
    ["Cleanup completed", formatTimestamp(media.primary_cleanup_completed_at) ?? "—"],
    ["Primary deleted", formatTimestamp(media.primary_deleted_at) ?? "—"],
    ["Source device", device ? deviceLabel(media) : "—"],
    ["Device ID", device?.device_uid || device?.id || "—"],
    ["Backup session", session?.id || "—"],
    ["Backup date", formatTimestamp(session?.started_at) ?? "—"],
    ["Session status", session?.status || "—"],
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" role="dialog" aria-modal="true" aria-label="Media details" onClick={onClose}>
      <aside className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-primary-600">Media details</p>
            <h2 className="mt-1 max-w-sm truncate text-xl font-bold text-gray-900">{media.file_name || media.id}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-2xl text-gray-400 hover:bg-gray-100 hover:text-gray-700" aria-label="Close details">
            ×
          </button>
        </div>
        <div className="mt-6 overflow-hidden rounded-xl bg-gray-100">
          {isVideo(media) ? (
            <div className="flex aspect-video items-center justify-center bg-slate-900 text-5xl text-white">▶</div>
          ) : media.thumbnail_url || media.storage_url ? (
            <img src={media.thumbnail_url || media.storage_url || ""} alt="Media preview" className="max-h-80 w-full object-contain" />
          ) : (
            <div className="flex h-48 items-center justify-center text-5xl text-gray-300">▣</div>
          )}
        </div>
        <dl className="mt-6 divide-y divide-gray-100">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[9rem_1fr] gap-4 py-3 text-sm">
              <dt className="text-gray-500">{label}</dt>
              <dd className="break-words font-medium text-gray-900">{value}</dd>
            </div>
          ))}
        </dl>
        {jobs.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-gray-900">Replication jobs</h3>
            <ul className="mt-3 space-y-2">
              {jobs.map((job) => (
                <li key={job.id} className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-gray-900">{job.destination_type === "google_drive" ? "Google Drive" : "Telegram"}</span>
                    <StatusBadge label={job.status} tone={jobTone(job.status)} />
                  </div>
                  {job.last_error && <p className="mt-1 text-xs text-red-600">{job.last_error}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}
