"use client";

/* eslint-disable @next/next/no-img-element -- Media is streamed at full
   resolution through the authenticated asset route. next/image would re-encode
   the file, which this viewer must not do. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MediaInfoPanel from "@/components/MediaInfoPanel";
import StatusBadge from "@/components/StatusBadge";
import { formatBytes } from "@/lib/format";
import {
  durationLabel,
  kindLabel,
  servedFromDriveArchive,
} from "@/lib/media-display";
import {
  mediaAssetPath,
  mediaKind,
  type BackupSessionInfo,
  type MediaAccessGrant,
  type MediaAsset,
} from "@/lib/media-types";

type LoadState = "loading" | "ready" | "error";

type ViewerFailure = {
  title: string;
  detail: string;
  retryable: boolean;
};

type View = { zoom: number; x: number; y: number };

const INITIAL_VIEW: View = { zoom: 1, x: 0, y: 0 };
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;
const SWIPE_DISTANCE = 60;
const SWIPE_SLOP = 80;
const EXIT_DURATION_MS = 160;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

function clampOffset(
  x: number,
  y: number,
  zoom: number,
  rect: DOMRect | null,
): { x: number; y: number } {
  if (!rect || zoom <= 1) return { x: 0, y: 0 };
  const maxX = (rect.width * (zoom - 1)) / 2;
  const maxY = (rect.height * (zoom - 1)) / 2;
  return {
    x: Math.min(maxX, Math.max(-maxX, x)),
    y: Math.min(maxY, Math.max(-maxY, y)),
  };
}

/**
 * Full-screen photo and video viewer for one employee's media set.
 *
 * The component only ever receives `items` — the media currently listed on the
 * employee's page, already scoped to that employee by the server query — so
 * previous/next can never walk into another employee's library.
 *
 * Photos render the original asset (never a downscaled variant) and support
 * wheel/pinch/double-click zoom, drag panning and swipe navigation. Videos use
 * the native HTML5 player, which supplies play/pause, seek, volume, fullscreen
 * and progress, and stream through the Range-aware asset route so playback
 * starts before the whole file arrives. Nothing autoplays.
 */
export default function MediaViewer({
  userId,
  items,
  index,
  access,
  employeeName,
  employeeId,
  designation,
  sessionsByDevice,
  onIndexChange,
  onRenewAccess,
  onClose,
}: {
  userId: string;
  items: MediaAsset[];
  index: number;
  access: MediaAccessGrant;
  employeeName: string;
  employeeId: string | null;
  designation: string | null;
  sessionsByDevice: Record<string, BackupSessionInfo>;
  onIndexChange: (index: number) => void;
  onRenewAccess: () => Promise<MediaAccessGrant | null>;
  onClose: () => void;
}) {
  const media = items[index] ?? null;
  const mediaId = media?.id ?? null;
  const kind = media ? mediaKind(media) : "other";
  const image = kind === "image";
  const video = kind === "video";

  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const renewAttemptedRef = useRef(false);

  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const panStartRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const pinchStartRef = useRef<{ dist: number; zoom: number } | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number; active: boolean } | null>(null);

  const [view, setView] = useState<View>(INITIAL_VIEW);
  const [dragging, setDragging] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [failure, setFailure] = useState<ViewerFailure | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const session = media?.device_id ? sessionsByDevice[media.device_id] ?? null : null;

  // The only media URL the browser gets: a signed, expiring admin route. The
  // permanent provider URL stays on the server.
  const src = useMemo(
    () => (media ? mediaAssetPath(userId, media.id, access, "original") : ""),
    [media, userId, access],
  );

  /* ---------------------------------------------------------------- lifecycle */

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    // The viewer is the whole screen; the page behind it must not scroll.
    const body = document.body;
    const previousOverflow = body.style.overflow;
    const previousPadding = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;

    const frame = window.requestAnimationFrame(() => setVisible(true));
    dialogRef.current?.focus();

    return () => {
      window.cancelAnimationFrame(frame);
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPadding;
      const restore = restoreFocusRef.current;
      if (restore && document.contains(restore)) restore.focus();
    };
  }, []);

  // Desktop shows the information panel beside the media, small screens keep it
  // collapsed behind the info button.
  useEffect(() => {
    setInfoOpen(window.matchMedia("(min-width: 1024px)").matches);
  }, []);

  // Moving to another asset is a fresh load: drop zoom/pan and any stale error.
  useEffect(() => {
    setView(INITIAL_VIEW);
    setLoadState("loading");
    setFailure(null);
    setReloadNonce(0);
    renewAttemptedRef.current = false;
    pointersRef.current.clear();
    panStartRef.current = null;
    pinchStartRef.current = null;
    swipeStartRef.current = null;
  }, [mediaId]);

  const requestClose = useCallback(() => {
    setVisible(false);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      onClose();
      return;
    }
    closeTimerRef.current = window.setTimeout(onClose, EXIT_DURATION_MS);
  }, [onClose]);

  /* ------------------------------------------------------------- navigation */

  const canPrevious = index > 0;
  const canNext = index < items.length - 1;

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= items.length || next === index) return;
      onIndexChange(next);
    },
    [index, items.length, onIndexChange],
  );

  const goPrevious = useCallback(() => goTo(index - 1), [goTo, index]);
  const goNext = useCallback(() => goTo(index + 1), [goTo, index]);

  /* ------------------------------------------------------------------- zoom */

  const applyZoom = useCallback(
    (resolve: number | ((zoom: number) => number), clientX?: number, clientY?: number) => {
      setView((previous) => {
        const requested = typeof resolve === "function" ? resolve(previous.zoom) : resolve;
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, requested));
        if (!Number.isFinite(zoom) || zoom === previous.zoom) return previous;

        const rect = stageRef.current?.getBoundingClientRect() ?? null;
        if (!rect) return { ...previous, zoom };

        // Keep the point under the cursor/fingers anchored while scaling.
        const cx = (clientX ?? rect.left + rect.width / 2) - rect.left - rect.width / 2;
        const cy = (clientY ?? rect.top + rect.height / 2) - rect.top - rect.height / 2;
        const ratio = zoom / previous.zoom;
        const next = clampOffset(
          cx - (cx - previous.x) * ratio,
          cy - (cy - previous.y) * ratio,
          zoom,
          rect,
        );
        return { zoom, x: next.x, y: next.y };
      });
    },
    [],
  );

  const resetView = useCallback(() => setView(INITIAL_VIEW), []);
  const zoomIn = useCallback(() => applyZoom((zoom) => zoom * ZOOM_STEP), [applyZoom]);
  const zoomOut = useCallback(() => applyZoom((zoom) => zoom / ZOOM_STEP), [applyZoom]);

  // Wheel zoom needs a non-passive listener: React attaches wheel handlers
  // passively, so preventDefault there would be ignored and the gesture would
  // scroll instead of zoom.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !image) return;

    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const factor = Math.exp(-event.deltaY * unit * 0.002);
      applyZoom((zoom) => zoom * factor, event.clientX, event.clientY);
    }

    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, [applyZoom, image]);

  /* --------------------------------------------------------- pointer gestures */

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!image) return;
    const stage = stageRef.current;
    if (!stage) return;

    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointersRef.current.size === 1) {
      if (view.zoom > 1) {
        panStartRef.current = { x: event.clientX, y: event.clientY, ox: view.x, oy: view.y };
        stage.setPointerCapture(event.pointerId);
        setDragging(true);
      } else if (event.pointerType === "touch") {
        swipeStartRef.current = { x: event.clientX, y: event.clientY, active: true };
        stage.setPointerCapture(event.pointerId);
      }
      return;
    }

    if (pointersRef.current.size === 2) {
      const [a, b] = Array.from(pointersRef.current.values());
      pinchStartRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: view.zoom };
      swipeStartRef.current = null;
      setDragging(true);
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointersRef.current.size >= 2 && pinchStartRef.current) {
      const [a, b] = Array.from(pointersRef.current.values());
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchStartRef.current.dist > 0) {
        applyZoom(
          pinchStartRef.current.zoom * (dist / pinchStartRef.current.dist),
          (a.x + b.x) / 2,
          (a.y + b.y) / 2,
        );
      }
      return;
    }

    if (panStartRef.current) {
      const rect = stageRef.current?.getBoundingClientRect() ?? null;
      const next = clampOffset(
        panStartRef.current.ox + (event.clientX - panStartRef.current.x),
        panStartRef.current.oy + (event.clientY - panStartRef.current.y),
        view.zoom,
        rect,
      );
      setView((previous) => ({ ...previous, x: next.x, y: next.y }));
      return;
    }

    // A mostly-vertical drag is the user reading the image, not swiping.
    if (swipeStartRef.current?.active) {
      if (Math.abs(event.clientY - swipeStartRef.current.y) > SWIPE_SLOP) {
        swipeStartRef.current.active = false;
      }
    }
  }

  function endPointer(event: React.PointerEvent<HTMLDivElement>) {
    const stage = stageRef.current;
    pointersRef.current.delete(event.pointerId);

    if (swipeStartRef.current?.active) {
      const dx = event.clientX - swipeStartRef.current.x;
      const dy = event.clientY - swipeStartRef.current.y;
      if (Math.abs(dx) > SWIPE_DISTANCE && Math.abs(dy) < SWIPE_SLOP) {
        if (dx < 0) goNext();
        else goPrevious();
      }
    }
    swipeStartRef.current = null;

    if (pointersRef.current.size < 2) pinchStartRef.current = null;
    if (pointersRef.current.size === 0) {
      panStartRef.current = null;
      setDragging(false);
    }

    if (stage?.hasPointerCapture?.(event.pointerId)) {
      stage.releasePointerCapture(event.pointerId);
    }
  }

  function handleDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!image) return;
    if (view.zoom > 1) resetView();
    else applyZoom(2, event.clientX, event.clientY);
  }

  /* -------------------------------------------------------- loading failures */

  const classifyFailure = useCallback(async (target: string): Promise<ViewerFailure> => {
    try {
      const response = await fetch(target, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        cache: "no-store",
      });
      const contentType = response.headers.get("content-type") ?? "";
      const looksLikeMedia =
        contentType.startsWith("image/") ||
        contentType.startsWith("video/") ||
        contentType.startsWith("application/octet-stream");

      // The asset route answers failures with a reason code so the copy here
      // never has to guess. Without it, an expired token, an unreachable Drive
      // account and a genuinely deleted file would all read the same, and a
      // healthy archived file would be reported as deleted.
      let reason = "";
      if (contentType.includes("application/json")) {
        try {
          const payload = await response.clone().json() as { reason?: unknown };
          if (typeof payload.reason === "string") reason = payload.reason;
        } catch {
          reason = "";
        }
      }

      if (reason === "file_unavailable") {
        return {
          title: "File not available",
          detail:
            "Both the working copy and its verified Google Drive archive could not be found. The file was deleted or its upload never completed.",
          retryable: false,
        };
      }
      if (reason === "archive_credential_error") {
        return {
          title: "Archive account needs attention",
          detail:
            "This file is archived in Google Drive, but the Drive account that holds it could not be authorized. Reconnect the account on the Drive page and try again.",
          retryable: false,
        };
      }
      if (reason === "archive_no_preview") {
        return {
          title: "No preview available",
          detail:
            "The archived file exists but Google Drive provides no preview image for it. The metadata below is still accurate.",
          retryable: false,
        };
      }
      if (reason === "media_not_found") {
        return {
          title: "Media record not found",
          detail:
            "This media is no longer in the database. Reload the media page and pick the file again.",
          retryable: false,
        };
      }
      if (response.status === 401 || response.status === 403) {
        return {
          title: "Media link expired",
          detail:
            "This viewer's secure media link is no longer valid. Reload the page and open the viewer again.",
          retryable: true,
        };
      }
      if (response.status === 404 || response.status === 410) {
        // A 404 without the `file_unavailable` reason is not a deleted file:
        // it is the archive path answering (no preview, missing record, …).
        return {
          title: "File not available",
          detail:
            "This file is no longer present in storage. It may have been deleted, or its upload never completed.",
          retryable: false,
        };
      }
      if (reason === "archive_unavailable" || reason === "provider_unavailable") {
        return {
          title: "Storage temporarily unavailable",
          detail:
            "This file is stored in the Google Drive archive, which could not be read right now. Nothing was deleted — try again in a moment.",
          retryable: true,
        };
      }
      if (response.status === 422) {
        return {
          title: "Invalid media metadata",
          detail:
            "This record does not contain a valid provider source. Review its storage metadata before retrying.",
          retryable: false,
        };
      }
      if (response.status >= 500) {
        return {
          title: "Storage unavailable",
          detail: "The media provider could not serve this file. Try again in a moment.",
          retryable: true,
        };
      }
      if (response.redirected || (response.ok && !looksLikeMedia)) {
        return {
          title: "Admin session required",
          detail:
            "The admin session was rejected while loading this media. Sign in again, then reopen the viewer.",
          retryable: true,
        };
      }
      return {
        title: "Media could not be loaded",
        detail: `The media source responded with ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
        retryable: true,
      };
    } catch {
      return {
        title: "Network error",
        detail: "This media could not be reached. Check your connection and try again.",
        retryable: true,
      };
    }
  }, []);

  const handleMediaFailure = useCallback(async () => {
    if (!media) return;

    // A grant that expired while the viewer stayed open is the common cause, so
    // renew once silently before showing an error.
    if (!renewAttemptedRef.current) {
      renewAttemptedRef.current = true;
      const renewed = await onRenewAccess();
      if (renewed) {
        setLoadState("loading");
        setReloadNonce((nonce) => nonce + 1);
        return;
      }
    }

    setFailure(await classifyFailure(src));
    setLoadState("error");
  }, [classifyFailure, media, onRenewAccess, src]);

  const retry = useCallback(async () => {
    renewAttemptedRef.current = false;
    setFailure(null);
    setLoadState("loading");
    await onRenewAccess();
    setReloadNonce((nonce) => nonce + 1);
  }, [onRenewAccess]);

  const markReady = useCallback(() => {
    setFailure(null);
    setLoadState("ready");
  }, []);

  /**
   * Warm the neighbouring thumbnails once the current item is actually on
   * screen.
   *
   * Only thumbnails, and only the two direct neighbours: the viewer's urls are
   * stable, so this is usually a cache hit on tiles the grid already loaded and
   * makes previous/next instant. No original is ever preloaded, so opening one
   * photo never competes with two speculative full-size downloads.
   */
  useEffect(() => {
    if (loadState !== "ready" || !media) return;
    const neighbours = [index - 1, index + 1].filter(
      (candidate) => candidate >= 0 && candidate < items.length,
    );
    for (const candidate of neighbours) {
      const warmer = new Image();
      warmer.decoding = "async";
      warmer.src = mediaAssetPath(userId, items[candidate].id, access, "thumb");
    }
  }, [loadState, index, items, media, userId, access]);

  /* -------------------------------------------------------------- keyboard/aria */

  const trapFocus = useCallback((event: KeyboardEvent) => {
    const container = dialogRef.current;
    if (!container) return;
    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).filter((element) => element.getClientRects().length > 0);
    if (focusables.length === 0) {
      event.preventDefault();
      container.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!active || !container.contains(active)) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      // Esc while a video is fullscreen belongs to the browser.
      if (event.key === "Escape" && document.fullscreenElement) return;
      if (event.key === "Tab") {
        trapFocus(event);
        return;
      }

      // With the player focused, arrows and space are the player's (seek /
      // playback), which is what native controls promise.
      const insidePlayer = Boolean(target?.closest("video"));
      if (
        insidePlayer &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === " ")
      ) {
        return;
      }

      switch (event.key) {
        case "Escape":
          event.preventDefault();
          requestClose();
          break;
        case "ArrowLeft":
          event.preventDefault();
          goPrevious();
          break;
        case "ArrowRight":
          event.preventDefault();
          goNext();
          break;
        case "+":
        case "=":
          event.preventDefault();
          zoomIn();
          break;
        case "-":
        case "_":
          event.preventDefault();
          zoomOut();
          break;
        case "0":
        case "f":
        case "F":
          event.preventDefault();
          resetView();
          break;
        case "i":
        case "I":
          event.preventDefault();
          setInfoOpen((open) => !open);
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [goNext, goPrevious, requestClose, resetView, trapFocus, zoomIn, zoomOut]);

  /* -------------------------------------------------------------------- render */

  const transition = dragging ? "" : "transition-transform duration-150 ease-out motion-reduce:transition-none";
  const controlClass =
    "inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/[0.06] px-2.5 text-sm text-gray-100 transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:cursor-not-allowed disabled:opacity-40";
  const navClass =
    "absolute top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 backdrop-blur-sm text-white/90 transition hover:bg-black/70 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:pointer-events-none disabled:opacity-0";

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={media ? `Media viewer: ${media.file_name || media.id}` : "Media viewer"}
      tabIndex={-1}
      className={`fixed inset-0 z-[100] flex flex-col bg-black/90 backdrop-blur-sm transition-opacity duration-150 motion-reduce:transition-none focus:outline-none ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      {/* ------------------------------------------------------------- header */}
      <header className="flex items-center gap-2 border-b border-white/[0.08] bg-black/60 px-3 py-2 backdrop-blur-sm sm:px-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[13px] font-medium text-white/90">
              {media?.file_name || "Untitled media"}
            </p>
          </div>
          {media && (
            <p className="mt-0.5 flex items-center gap-x-1.5 text-[11px] text-gray-500">
              <span>{kindLabel(kind)}</span>
              <span aria-hidden>·</span>
              <span>{formatBytes(media.file_size) ?? "—"}</span>
              {video && media.duration_ms != null && (
                <>
                  <span aria-hidden>·</span>
                  <span>{durationLabel(media.duration_ms)}</span>
                </>
              )}
              <span className="ml-1 inline-flex items-center gap-1.5">
                <StatusBadge
                  label={media.status}
                  tone={media.status === "READY" ? "success" : media.status === "FAILED" ? "danger" : "warning"}
                />
                {servedFromDriveArchive(media) && (
                  <StatusBadge label="Drive archive" tone="success" />
                )}
              </span>
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className="rounded-md bg-white/[0.08] px-2 py-0.5 text-[11px] font-medium tabular-nums text-gray-400"
            aria-live="polite"
            aria-atomic="true"
          >
            {items.length > 0 ? `${index + 1} / ${items.length}` : "0 / 0"}
          </span>
          <button
            type="button"
            onClick={() => setInfoOpen((open) => !open)}
            aria-pressed={infoOpen}
            aria-label={infoOpen ? "Hide media information" : "Show media information"}
            title="Media information (I)"
            className={controlClass}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path strokeLinecap="round" d="M12 11v5M12 8h.01" />
            </svg>
          </button>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close viewer"
            title="Close (Esc)"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </header>

      {/* --------------------------------------------------------------- body */}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div
            ref={stageRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
            onDoubleClick={handleDoubleClick}
            className="relative flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden"
          >
            {media && image && (
              <img
                key={`${media.id}-${reloadNonce}`}
                src={src}
                alt={media.file_name || "Media preview"}
                draggable={false}
                onLoad={markReady}
                onError={handleMediaFailure}
                style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.zoom})` }}
                className={`h-full w-full object-contain will-change-transform ${transition} ${
                  loadState === "ready" ? "opacity-100" : "opacity-0"
                } ${view.zoom > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"}`}
              />
            )}

            {media && video && (
              <video
                key={`${media.id}-${reloadNonce}`}
                src={src}
                controls
                playsInline
                // Metadata only: the player then range-fetches what it needs, so
                // playback starts without downloading the whole file.
                preload="metadata"
                onLoadedData={markReady}
                onCanPlay={markReady}
                onError={handleMediaFailure}
                className={`h-full w-full bg-black transition-opacity duration-150 motion-reduce:transition-none ${
                  loadState === "ready" ? "opacity-100" : "opacity-0"
                }`}
              >
                {/* No autoplay: sound never starts on its own. */}
              </video>
            )}

            {media && kind === "other" && (
              <div className="max-w-md p-6 text-center text-gray-300">
                <div className="text-3xl" aria-hidden>
                  ▤
                </div>
                <h3 className="mt-3 text-base font-semibold text-white">
                  Preview not available
                </h3>
                <p className="mt-1 text-sm">
                  {media.mime_type || "This file type"} cannot be displayed in the viewer.
                  Its metadata is still available in the information panel.
                </p>
              </div>
            )}

            {loadState === "loading" && !failure && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                  <span
                    className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-white/70"
                    aria-hidden="true"
                  />
                  <span role="status" className="text-xs text-gray-500">
                    Loading…
                  </span>
                </div>
              </div>
            )}

            {loadState === "error" && failure && (
              <div className="absolute inset-0 flex items-center justify-center p-4 sm:p-6">
                <div
                  role="alert"
                  className="w-full max-w-md rounded-xl border border-red-500/30 bg-red-950/80 p-5 text-center shadow-2xl"
                >
                  <div className="text-2xl" aria-hidden>
                    ⚠
                  </div>
                  <h3 className="mt-2 text-base font-semibold text-white">{failure.title}</h3>
                  <p className="mt-1 text-sm text-red-100/90">{failure.detail}</p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {failure.retryable && (
                      <button
                        type="button"
                        onClick={retry}
                        className="rounded-lg bg-white px-3.5 py-2 text-sm font-semibold text-gray-900 transition hover:bg-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
                      >
                        Try again
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={requestClose}
                      className="rounded-lg border border-white/25 px-3.5 py-2 text-sm font-medium text-gray-100 transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* previous / next: floating controls, the standard lightbox affordance */}
            <button
              type="button"
              onClick={goPrevious}
              disabled={!canPrevious}
              aria-label="Previous media"
              title="Previous (←)"
              className={`${navClass} left-2 sm:left-3`}
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <button
              type="button"
              onClick={goNext}
              disabled={!canNext}
              aria-label="Next media"
              title="Next (→)"
              className={`${navClass} right-2 sm:right-3`}
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          {/* ---------------------------------------------------------- footer */}
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.08] bg-black/60 px-3 py-1.5 sm:px-4">
            <div className="flex flex-wrap items-center gap-1">
              {image ? (
                <>
                  <button type="button" onClick={zoomOut} className={controlClass} aria-label="Zoom out" title="Zoom out (−)">
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path strokeLinecap="round" d="M5 12h14" />
                    </svg>
                  </button>
                  <span className="w-12 text-center text-[11px] tabular-nums text-gray-400" aria-live="polite">
                    {Math.round(view.zoom * 100)}%
                  </span>
                  <button type="button" onClick={zoomIn} className={controlClass} aria-label="Zoom in" title="Zoom in (+)">
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path strokeLinecap="round" d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={resetView}
                    aria-pressed={view.zoom === 1 && view.x === 0 && view.y === 0}
                    className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[11px] text-gray-400 transition hover:bg-white/[0.06] hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
                    title="Fit the whole image on screen (F / 0)"
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <path strokeLinecap="round" d="M9 3v18M15 3v18M3 9h18M3 15h18" />
                    </svg>
                    <span className="hidden sm:inline">Fit</span>
                  </button>
                </>
              ) : video ? (
                <span className="text-[11px] text-gray-500">
                  Player controls: play, seek, volume, fullscreen
                </span>
              ) : (
                <span className="text-[11px] text-gray-500">
                  Preview not available
                </span>
              )}
            </div>

            <span className="hidden text-[11px] text-gray-600 lg:inline">
              ← → nav · + − zoom · F fit · I info · Esc close
            </span>
          </footer>
        </div>

        {/* ----------------------------------------------------- info: desktop */}
        {infoOpen && media && (
          <aside
            aria-label="Media information"
            className="hidden w-80 shrink-0 overflow-y-auto border-l border-white/[0.08] bg-gray-950/98 p-4 lg:block xl:w-96"
          >
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-[13px] font-semibold text-white">Details</h2>
                <p className="mt-0.5 text-[11px] text-gray-500">{employeeName}</p>
              </div>
            </div>
            <MediaInfoPanel
              media={media}
              employeeName={employeeName}
              employeeId={employeeId}
              designation={designation}
              session={session}
              tone="dark"
            />
          </aside>
        )}
      </div>

      {/* -------------------------------------------------------- info: mobile */}
      {infoOpen && media && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-10 bg-black/50 backdrop-blur-sm lg:hidden"
            onClick={() => setInfoOpen(false)}
            aria-hidden="true"
          />
          <div
            className="fixed inset-x-0 bottom-0 z-20 max-h-[75vh] overflow-y-auto rounded-t-2xl border-t border-white/[0.1] bg-gray-950 shadow-2xl transition-transform duration-200 lg:hidden"
            role="region"
            aria-label="Media information"
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-2.5 pb-1">
              <div className="h-1 w-8 rounded-full bg-white/20" />
            </div>
            <div className="px-4 pb-6">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h2 className="text-[13px] font-semibold text-white">Details</h2>
                  <p className="mt-0.5 text-[11px] text-gray-500">{employeeName}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setInfoOpen(false)}
                  aria-label="Hide media information"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition hover:bg-white/10 hover:text-white"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
              <MediaInfoPanel
                media={media}
                employeeName={employeeName}
                employeeId={employeeId}
                designation={designation}
                session={session}
                tone="dark"
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
