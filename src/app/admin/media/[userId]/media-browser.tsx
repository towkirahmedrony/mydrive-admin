"use client";

/* eslint-disable @next/next/no-img-element -- thumbnails stream through the
   authenticated asset route; next/image would re-encode them. */

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import EmptyState from "@/components/EmptyState";
import MediaInfoPanel from "@/components/MediaInfoPanel";
import StatusBadge from "@/components/StatusBadge";
import { formatBytes, formatTimestamp } from "@/lib/format";
import {
  archiveLabel,
  cleanupLabel,
  cleanupTone,
  jobTone,
  servedFromDriveArchive,
} from "@/lib/media-display";
import {
  jobFor,
  mediaAssetPath,
  mediaKind,
  type BackupSessionInfo,
  type MediaAccessGrant,
  type MediaAsset,
} from "@/lib/media-types";
import { refreshMediaAccess, retryEmployeeMediaJobs } from "../actions";
import MediaViewer from "./media-viewer";

type ViewMode = "grid" | "list";

/**
 * How many tiles load eagerly. A 3-column grid at 1080p shows about six cards
 * above the fold, so this covers the first screen without asking for more than
 * the viewer can see.
 */
const EAGER_TILE_COUNT = 6;

/**
 * Thumbnails come from the signed asset route, never from
 * `media_assets.thumbnail_url` directly — that permanent provider URL stays on
 * the server. A missing preview (no derived thumbnail, or a file the provider
 * cannot serve) degrades to the same placeholder the grid always used.
 */
function Thumbnail({
  media,
  userId,
  access,
  fit = "cover",
  aboveFold = false,
}: {
  media: MediaAsset;
  userId: string;
  access: MediaAccessGrant;
  fit?: "cover" | "contain";
  /**
   * The first screen of tiles loads eagerly with a high priority so the grid
   * shows media immediately; everything below the fold stays lazy so a page of
   * 24 tiles never competes for bandwidth with the ones the admin can see.
   */
  aboveFold?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const kind = mediaKind(media);
  const src = useMemo(
    () => mediaAssetPath(userId, media.id, access, "thumb"),
    [media, userId, access],
  );

  if ((kind === "image" || kind === "video") && !failed) {
    return (
      <img
        src={src}
        alt=""
        loading={aboveFold ? "eager" : "lazy"}
        fetchPriority={aboveFold ? "high" : "auto"}
        decoding="async"
        onError={() => setFailed(true)}
        className={`h-full w-full ${fit === "cover" ? "object-cover" : "object-contain"}`}
      />
    );
  }

  return (
    <div
      className={`flex h-full w-full items-center justify-center ${
        kind === "video" ? "bg-slate-900 text-white" : "bg-gray-100 text-gray-400"
      }`}
    >
      <span className="text-2xl">{kind === "video" ? "▶" : "▣"}</span>
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
  access: initialAccess,
}: {
  userId: string;
  employeeName: string;
  employeeId: string | null;
  designation: string | null;
  media: MediaAsset[];
  sessionsByDevice: Record<string, BackupSessionInfo>;
  access: MediaAccessGrant;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<MediaAsset | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [access, setAccess] = useState<MediaAccessGrant>(initialAccess);
  const [viewerId, setViewerId] = useState<string | null>(null);

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

  /**
   * The viewer navigates this list and only this list.
   *
   * `media` is already the filtered/sorted page for one employee (the query is
   * scoped by `owner_id`), so previous/next honours the active search, kind,
   * status and sort filters while staying inside the selected employee. The
   * owner check is re-applied here as a hard guard: a foreign row can never
   * become reachable from the viewer.
   */
  const viewerItems = useMemo(
    () => media.filter((item) => item.owner_id === userId),
    [media, userId],
  );
  const viewerIndex = viewerId
    ? viewerItems.findIndex((item) => item.id === viewerId)
    : -1;

  // If filters, sort or pagination change the list under an open viewer, close
  // it rather than leaving the viewer pointing at an index that no longer exists.
  useEffect(() => {
    if (viewerId && viewerIndex === -1) setViewerId(null);
  }, [viewerId, viewerIndex]);

  const openViewer = useCallback((mediaId: string) => {
    setDetail(null);
    setViewerId(mediaId);
  }, []);

  const closeViewer = useCallback(() => setViewerId(null), []);

  /** Renews the short-lived grant when the viewer reports a load failure. */
  const renewAccess = useCallback(async (): Promise<MediaAccessGrant | null> => {
    const result = await refreshMediaAccess(userId);
    if (!result.success || !result.grant) return null;
    setAccess(result.grant);
    return result.grant;
  }, [userId]);

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
  const rowActionClass =
    "rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500";
  const activeFilterCount = [
    q,
    kind !== "ALL" ? kind : "",
    status !== "ALL" ? status : "",
    archive !== "ALL" ? archive : "",
    cleanup !== "ALL" ? cleanup : "",
    sort !== "newest" ? sort : "",
    from,
    to,
  ].filter(Boolean).length;

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-gray-200 bg-white p-2 shadow-sm sm:rounded-xl sm:p-4">
        <div className="flex items-center justify-between sm:hidden">
          <span className="text-sm font-semibold text-gray-800">Media filters</span>
          <button
            type="button"
            onClick={() => setFiltersOpen((open) => !open)}
            aria-expanded={filtersOpen}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" d="M4 6h16M7 12h10M10 18h4" />
            </svg>
            {activeFilterCount ? `${activeFilterCount} active` : "Filter"}
          </button>
        </div>
        <div className={`${filtersOpen ? "block" : "hidden"} mt-2 sm:mt-0 sm:block`}>
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
          {media.map((item, gridIndex) => {
            const drive = jobFor(item, "google_drive");
            const video = mediaKind(item) === "video";
            return (
              <article
                key={item.id}
                className={`group overflow-hidden rounded-xl border bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${selected.has(item.id) ? "border-primary-500 ring-2 ring-primary-100" : "border-gray-200"}`}
              >
                <div className="relative aspect-[4/3] bg-gray-100">
                  <button
                    type="button"
                    onClick={() => openViewer(item.id)}
                    aria-label={`View ${item.file_name || item.id}`}
                    className="absolute inset-0 h-full w-full cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
                  >
                    <Thumbnail
                      media={item}
                      userId={userId}
                      access={access}
                      aboveFold={gridIndex < EAGER_TILE_COUNT}
                    />
                  </button>
                  <label className="absolute left-3 top-3 rounded-md bg-white/95 p-1.5 shadow-sm" onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      onChange={() => toggle(item.id)}
                      aria-label={`Select ${item.file_name || item.id}`}
                      className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                    />
                  </label>
                  <div className="pointer-events-none absolute right-3 top-3 flex flex-col items-end gap-1.5">
                    {video && (
                      <span className="rounded-full bg-black/65 px-2 py-1 text-xs font-semibold text-white">VIDEO</span>
                    )}
                    {/* The Cloudinary working copy is removed after a verified
                        archive; the tile is served from Google Drive. */}
                    {servedFromDriveArchive(item) && (
                      <span
                        title="Served from the Google Drive archive"
                        className="rounded-full bg-emerald-600/85 px-2 py-1 text-xs font-semibold text-white"
                      >
                        DRIVE
                      </span>
                    )}
                  </div>
                  <div className="absolute inset-x-0 bottom-0 flex justify-end gap-2 bg-gradient-to-t from-black/70 to-transparent px-3 pb-3 pt-8 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      type="button"
                      onClick={() => openViewer(item.id)}
                      className="rounded-md bg-white/95 px-2.5 py-1.5 text-xs font-semibold text-gray-900 transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                    >
                      View
                    </button>
                    <button
                      type="button"
                      onClick={() => setDetail(item)}
                      className="rounded-md border border-white/40 bg-black/40 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
                    >
                      Details
                    </button>
                  </div>
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
                  <th className="px-4 py-3">Open</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {media.map((item) => (
                  <tr key={item.id} className="cursor-zoom-in hover:bg-gray-50" onClick={() => openViewer(item.id)}>
                    <td className="px-4 py-3" onClick={(event) => event.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} className="h-4 w-4 rounded border-gray-300 text-primary-600" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="h-12 w-16 overflow-hidden rounded bg-gray-100">
                        <Thumbnail media={item} userId={userId} access={access} />
                      </div>
                    </td>
                    <td className="max-w-xs px-4 py-3">
                      <p className="truncate font-medium text-gray-900">{item.file_name || item.id}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{mediaKind(item) === "video" ? "Video" : "Image"}</td>
                    <td className="px-4 py-3 text-gray-600">{formatBytes(item.file_size) ?? "—"}</td>
                    <td className="px-4 py-3 text-gray-600">{formatTimestamp(item.uploaded_at || item.created_at) ?? "—"}</td>
                    <td className="px-4 py-3">
                      <StatusBadge label={archiveLabel(item)} tone={item.drive_archived_at ? "success" : "neutral"} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge label={cleanupLabel(item.primary_cleanup_status)} tone={cleanupTone(item.primary_cleanup_status)} />
                    </td>
                    <td className="px-4 py-3" onClick={(event) => event.stopPropagation()}>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => openViewer(item.id)} className={rowActionClass}>
                          View
                        </button>
                        <button type="button" onClick={() => setDetail(item)} className={rowActionClass}>
                          Details
                        </button>
                      </div>
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
          userId={userId}
          access={access}
          employeeName={employeeName}
          employeeId={employeeId}
          designation={designation}
          session={detail.device_id ? sessionsByDevice[detail.device_id] ?? null : null}
          onClose={() => setDetail(null)}
          onView={openViewer}
        />
      )}

      {viewerId && viewerIndex >= 0 && (
        <MediaViewer
          userId={userId}
          items={viewerItems}
          index={viewerIndex}
          access={access}
          employeeName={employeeName}
          employeeId={employeeId}
          designation={designation}
          sessionsByDevice={sessionsByDevice}
          onIndexChange={(next) => {
            const target = viewerItems[next];
            if (target) setViewerId(target.id);
          }}
          onRenewAccess={renewAccess}
          onClose={closeViewer}
        />
      )}
    </div>
  );
}

function MediaDetail({
  media,
  userId,
  access,
  employeeName,
  employeeId,
  designation,
  session,
  onClose,
  onView,
}: {
  media: MediaAsset;
  userId: string;
  access: MediaAccessGrant;
  employeeName: string;
  employeeId: string | null;
  designation: string | null;
  session: BackupSessionInfo | null;
  onClose: () => void;
  onView: (mediaId: string) => void;
}) {
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

        <button
          type="button"
          onClick={() => onView(media.id)}
          className="mt-6 block h-72 w-full overflow-hidden rounded-xl bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          aria-label={`Open ${media.file_name || media.id} in the viewer`}
        >
          <Thumbnail media={media} userId={userId} access={access} fit="contain" />
        </button>
        <p className="mt-2 text-center text-xs text-gray-500">Open in viewer</p>

        <div className="mt-6">
          <MediaInfoPanel
            media={media}
            employeeName={employeeName}
            employeeId={employeeId}
            designation={designation}
            session={session}
          />
        </div>
      </aside>
    </div>
  );
}
