"use client";

/* eslint-disable @next/next/no-img-element -- thumbnails stream through the
   authenticated asset route; next/image would re-encode them. */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import EmptyState from "@/components/EmptyState";
import MediaInfoPanel from "@/components/MediaInfoPanel";
import { servedFromDriveArchive } from "@/lib/media-display";
import {
  mediaAssetPath,
  mediaKind,
  type BackupSessionInfo,
  type MediaAccessGrant,
  type MediaAsset,
} from "@/lib/media-types";
import { loadMoreMedia, refreshMediaAccess, retryEmployeeMediaJobs } from "../actions";
import MediaViewer from "./media-viewer";

/* ─── Date grouping ─────────────────────────────────────────────────────── */

function dateKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dateLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

type DateGroup = { key: string; label: string; items: MediaAsset[] };

function groupByDate(items: MediaAsset[], sort: string): DateGroup[] {
  // Sort by created_at descending for "newest", ascending for "oldest"
  const sorted = [...items].sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    return sort === "oldest" ? ta - tb : tb - ta;
  });

  const groups = new Map<string, MediaAsset[]>();
  for (const item of sorted) {
    const key = dateKey(item.created_at);
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }

  return Array.from(groups.entries()).map(([key, items]) => ({
    key,
    label: dateLabel(key),
    items,
  }));
}

/* ─── Thumbnail ─────────────────────────────────────────────────────────── */

function GalleryTile({
  media,
  userId,
  access,
  selected,
  onSelect,
  onClick,
}: {
  media: MediaAsset;
  userId: string;
  access: MediaAccessGrant;
  selected: boolean;
  onSelect: (id: string) => void;
  onClick: (id: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const kind = mediaKind(media);
  const isVideo = kind === "video";
  const src = useMemo(
    () => mediaAssetPath(userId, media.id, access, "thumb"),
    [media, userId, access],
  );

  return (
    <div
      className={`gallery-tile ${selected ? "selected" : ""}`}
      onClick={() => onClick(media.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(media.id);
        }
      }}
    >
      {/* Selection checkbox */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onSelect(media.id);
        }}
        className={`absolute left-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border transition ${
          selected
            ? "border-blue-500 bg-blue-500 text-white"
            : "border-white/80 bg-black/30 text-white opacity-0 group-hover:opacity-100 hover:bg-black/50"
        }`}
        aria-label={`Select ${media.file_name || media.id}`}
        style={{ opacity: selected ? 1 : undefined }}
      >
        {selected && (
          <svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor">
            <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
          </svg>
        )}
      </button>

      {/* Thumbnail image */}
      {!failed && (kind === "image" || isVideo) ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
          style={{ opacity: loaded ? 1 : 0 }}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gray-200 text-gray-400">
          <span className="text-xl">{failed ? "!" : "▣"}</span>
        </div>
      )}

      {/* Video play badge */}
      {isVideo && (
        <div className="absolute bottom-1 right-1 flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5">
          <svg viewBox="0 0 16 16" className="h-2.5 w-2.5 text-white" fill="currentColor">
            <path d="M4 2.5v11l10-5.5z" />
          </svg>
          {media.duration_ms != null && (
            <span className="text-[10px] font-medium text-white">
              {(() => {
                const s = Math.round(Number(media.duration_ms) / 1000);
                const m = Math.floor(s / 60);
                return `${m}:${String(s % 60).padStart(2, "0")}`;
              })()}
            </span>
          )}
        </div>
      )}

      {/* Drive archive badge */}
      {servedFromDriveArchive(media) && (
        <div className="absolute left-1.5 bottom-1 rounded bg-emerald-600/80 px-1 py-0.5">
          <span className="text-[9px] font-semibold text-white">DRIVE</span>
        </div>
      )}
    </div>
  );
}

/* ─── Main component ────────────────────────────────────────────────────── */

export default function MediaBrowser({
  userId,
  employeeName,
  employeeId,
  designation,
  media: initialMedia,
  sessionsByDevice,
  access: initialAccess,
  total: serverTotal,
  initialPage,
  pageSize,
}: {
  userId: string;
  employeeName: string;
  employeeId: string | null;
  designation: string | null;
  media: MediaAsset[];
  sessionsByDevice: Record<string, BackupSessionInfo>;
  access: MediaAccessGrant;
  total: number;
  initialPage: number;
  pageSize: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [allMedia, setAllMedia] = useState<MediaAsset[]>(initialMedia);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<MediaAsset | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [access, setAccess] = useState<MediaAccessGrant>(initialAccess);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(initialMedia.length < serverTotal);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const sort = searchParams.get("sort") ?? "newest";
  const q = searchParams.get("q") ?? "";
  const kind = searchParams.get("kind") ?? "ALL";
  const status = searchParams.get("status") ?? "ALL";
  const archive = searchParams.get("archive") ?? "ALL";
  const cleanup = searchParams.get("cleanup") ?? "ALL";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const [inputQuery, setInputQuery] = useState(q);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const selectedMedia = useMemo(
    () => allMedia.filter((item) => selected.has(item.id)),
    [allMedia, selected],
  );

  const viewerItems = useMemo(
    () => allMedia.filter((item) => item.owner_id === userId),
    [allMedia, userId],
  );
  const viewerIndex = viewerId
    ? viewerItems.findIndex((item) => item.id === viewerId)
    : -1;

  useEffect(() => {
    if (viewerId && viewerIndex === -1) setViewerId(null);
  }, [viewerId, viewerIndex]);

  const openViewer = useCallback((mediaId: string) => {
    setDetail(null);
    setViewerId(mediaId);
  }, []);

  const closeViewer = useCallback(() => setViewerId(null), []);

  const renewAccess = useCallback(async (): Promise<MediaAccessGrant | null> => {
    const result = await refreshMediaAccess(userId);
    if (!result.success || !result.grant) return null;
    setAccess(result.grant);
    return result.grant;
  }, [userId]);

  const setParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(searchParams.toString());
      if (
        !value ||
        value === "ALL" ||
        (key === "sort" && value === "newest")
      ) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      if (key !== "page") next.delete("page");
      const query = next.toString();
      router.push(query ? `${pathname}?${query}` : pathname);
    },
    [pathname, router, searchParams],
  );

  // Reset media list when filters change (server re-renders with new data)
  useEffect(() => {
    setAllMedia(initialMedia);
    setHasMore(initialMedia.length < serverTotal);
  }, [initialMedia, serverTotal]);

  // Search debounce
  useEffect(() => {
    setInputQuery(q);
  }, [q]);

  useEffect(() => {
    if (inputQuery.trim() === q) return;
    const timer = window.setTimeout(() => setParam("q", inputQuery.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [inputQuery, q, setParam]);

  // ─── Infinite scroll ───────────────────────────────────────────────────
  const currentPageRef = useRef(initialPage);

  const fetchMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const nextPage = currentPageRef.current + 1;
    try {
      const result = await loadMoreMedia(userId, nextPage, {
        kind: kind !== "ALL" ? kind : undefined,
        status: status !== "ALL" ? status : undefined,
        archive: archive !== "ALL" ? archive : undefined,
        cleanup: cleanup !== "ALL" ? cleanup : undefined,
        sort: sort !== "newest" ? sort : undefined,
        q: q || undefined,
        from: from || undefined,
        to: to || undefined,
      });
      if (result.media && result.media.length > 0) {
        setAllMedia((prev) => {
          const existing = new Set(prev.map((m) => m.id));
          const newItems = result.media.filter((m) => !existing.has(m.id));
          return [...prev, ...newItems];
        });
        currentPageRef.current = nextPage;
        setHasMore(result.media.length === pageSize);
      } else {
        setHasMore(false);
      }
    } catch {
      // Silently fail — the sentinel will retry on next intersection
    } finally {
      setLoadingMore(false);
    }
  }, [userId, kind, status, archive, cleanup, sort, q, from, to, loadingMore, hasMore, pageSize]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          fetchMore();
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchMore]);

  // ─── Actions ───────────────────────────────────────────────────────────
  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
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
      setNotice(
        `${result.retried} replication job${result.retried === 1 ? "" : "s"} queued for retry.`,
      );
      setSelected(new Set());
      router.refresh();
    });
  }

  // ─── Date groups ───────────────────────────────────────────────────────
  const dateGroups = useMemo(
    () => groupByDate(allMedia, sort),
    [allMedia, sort],
  );

  const selectClass =
    "rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── Sticky toolbar ──────────────────────────────────────── */}
      <div className="sticky top-0 z-20 shrink-0 border-b border-gray-100 bg-white">
        {/* Main toolbar row */}
        <div className="flex items-center gap-2 px-3 py-2 sm:px-4">
          {/* Search */}
          <div className="relative min-w-0 flex-1">
            <svg
              viewBox="0 0 24 24"
              className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <circle cx="11" cy="11" r="8" />
              <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
            </svg>
            <input
              value={inputQuery}
              onChange={(e) => setInputQuery(e.target.value)}
              placeholder="Search…"
              className="w-full rounded border border-gray-200 bg-gray-50 py-1.5 pl-7 pr-2 text-xs outline-none focus:border-blue-300 focus:bg-white focus:ring-1 focus:ring-blue-200"
            />
          </div>

          {/* Filter toggle (mobile) */}
          <button
            type="button"
            onClick={() => setFiltersOpen((open) => !open)}
            className="inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1.5 text-xs text-gray-600 hover:bg-gray-50 sm:hidden"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" d="M4 6h16M7 12h10M10 18h4" />
            </svg>
            Filter
          </button>

          {/* Sort (always visible) */}
          <select
            value={sort}
            onChange={(e) => setParam("sort", e.target.value)}
            className={selectClass}
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="largest">Largest</option>
            <option value="smallest">Smallest</option>
            <option value="name">Name</option>
          </select>
        </div>

        {/* Expandable filter row (mobile) */}
        {filtersOpen && (
          <div className="flex flex-wrap items-center gap-2 border-t border-gray-50 px-3 py-2 sm:hidden">
            <select value={kind} onChange={(e) => setParam("kind", e.target.value)} className={selectClass}>
              <option value="ALL">All types</option>
              <option value="IMAGE">Photos</option>
              <option value="VIDEO">Videos</option>
            </select>
            <select value={status} onChange={(e) => setParam("status", e.target.value)} className={selectClass}>
              <option value="ALL">All status</option>
              <option value="READY">Ready</option>
              <option value="UPLOADING">Uploading</option>
              <option value="FAILED">Failed</option>
              <option value="DELETED">Deleted</option>
            </select>
            <select value={archive} onChange={(e) => setParam("archive", e.target.value)} className={selectClass}>
              <option value="ALL">All archive</option>
              <option value="archived">Archived</option>
              <option value="pending">Pending</option>
            </select>
          </div>
        )}

        {/* Expandable filter row (desktop) */}
        <div className="hidden items-center gap-2 border-t border-gray-50 px-3 py-2 sm:flex">
          <select value={kind} onChange={(e) => setParam("kind", e.target.value)} className={selectClass}>
            <option value="ALL">All types</option>
            <option value="IMAGE">Photos</option>
            <option value="VIDEO">Videos</option>
          </select>
          <select value={status} onChange={(e) => setParam("status", e.target.value)} className={selectClass}>
            <option value="ALL">All status</option>
            <option value="READY">Ready</option>
            <option value="UPLOADING">Uploading</option>
            <option value="FAILED">Failed</option>
            <option value="DELETED">Deleted</option>
          </select>
          <select value={archive} onChange={(e) => setParam("archive", e.target.value)} className={selectClass}>
            <option value="ALL">All archive</option>
            <option value="archived">Archived</option>
            <option value="pending">Pending</option>
          </select>
          <select value={cleanup} onChange={(e) => setParam("cleanup", e.target.value)} className={selectClass}>
            <option value="ALL">All cleanup</option>
            <option value="none">None</option>
            <option value="cleanup_pending">Pending</option>
            <option value="cleanup_processing">Processing</option>
            <option value="cleanup_success">Success</option>
            <option value="cleanup_failed">Failed</option>
          </select>
          <label className="ml-auto flex items-center gap-1 text-xs text-gray-500">
            From
            <input
              type="date"
              value={from.slice(0, 10)}
              onChange={(e) =>
                setParam("from", e.target.value ? `${e.target.value}T00:00:00.000Z` : "")
              }
              className="rounded border border-gray-200 px-1.5 py-0.5 text-xs"
            />
          </label>
          <label className="flex items-center gap-1 text-xs text-gray-500">
            To
            <input
              type="date"
              value={to.slice(0, 10)}
              onChange={(e) =>
                setParam("to", e.target.value ? `${e.target.value}T23:59:59.999Z` : "")
              }
              className="rounded border border-gray-200 px-1.5 py-0.5 text-xs"
            />
          </label>
        </div>
      </div>

      {/* ── Selection bar ───────────────────────────────────────── */}
      {selected.size > 0 && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-blue-100 bg-blue-50 px-3 py-2 text-xs sm:px-4">
          <span className="font-medium text-blue-900">{selected.size} selected</span>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={retrySelected}
              disabled={pending}
              className="rounded bg-blue-600 px-2.5 py-1 font-medium text-white disabled:opacity-50"
            >
              {pending ? "Retrying…" : "Retry jobs"}
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded border border-gray-200 bg-white px-2.5 py-1 text-gray-600"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* ── Notices ────────────────────────────────────────────── */}
      {notice && (
        <div className="shrink-0 border-b border-green-100 bg-green-50 px-3 py-1.5 text-xs text-green-800 sm:px-4">
          {notice}
        </div>
      )}
      {error && (
        <div className="shrink-0 border-b border-red-100 bg-red-50 px-3 py-1.5 text-xs text-red-800 sm:px-4">
          {error}
        </div>
      )}

      {/* ── Gallery ────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {allMedia.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8">
            <EmptyState
              icon="🖼"
              title="No media yet"
              detail={
                q || kind !== "ALL" || status !== "ALL" || archive !== "ALL"
                  ? "Try clearing a filter or changing the search."
                  : "Media uploaded by this employee will appear here."
              }
            />
          </div>
        ) : (
          <div>
            {dateGroups.map((group) => (
              <div key={group.key}>
                <div className="date-group-header">{group.label}</div>
                <div className="gallery-grid">
                  {group.items.map((item) => (
                    <GalleryTile
                      key={item.id}
                      media={item}
                      userId={userId}
                      access={access}
                      selected={selected.has(item.id)}
                      onSelect={toggle}
                      onClick={openViewer}
                    />
                  ))}
                </div>
              </div>
            ))}

            {/* Infinite scroll sentinel */}
            <div ref={sentinelRef} className="h-1" />

            {/* Loading indicator */}
            {loadingMore && (
              <div className="flex justify-center py-4">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
              </div>
            )}

            {/* End of media */}
            {!hasMore && allMedia.length > 0 && (
              <p className="py-4 text-center text-xs text-gray-400">
                {allMedia.length.toLocaleString()} items
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Detail drawer ───────────────────────────────────────── */}
      {detail && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/40"
          role="dialog"
          aria-modal="true"
          aria-label="Media details"
          onClick={() => setDetail(null)}
        >
          <aside
            className="h-full w-full max-w-md overflow-y-auto bg-white p-5 shadow-2xl sm:max-w-xl sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <p className="text-xs font-medium text-blue-600">Details</p>
                <h2 className="mt-0.5 truncate text-base font-bold text-gray-900">
                  {detail.file_name || detail.id}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setDetail(null)}
                className="rounded p-1 text-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <button
              type="button"
              onClick={() => openViewer(detail.id)}
              className="mt-4 block h-48 w-full overflow-hidden rounded-lg bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:h-64"
              aria-label={`Open in viewer`}
            >
              <img
                src={mediaAssetPath(userId, detail.id, access, "thumb")}
                alt=""
                className="h-full w-full object-contain"
              />
            </button>
            <p className="mt-1.5 text-center text-[11px] text-gray-400">Tap to open in viewer</p>

            <div className="mt-4">
              <MediaInfoPanel
                media={detail}
                employeeName={employeeName}
                employeeId={employeeId}
                designation={designation}
                session={detail.device_id ? sessionsByDevice[detail.device_id] ?? null : null}
              />
            </div>
          </aside>
        </div>
      )}

      {/* ── Viewer ─────────────────────────────────────────────── */}
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
