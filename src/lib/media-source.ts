/**
 * Pure source-selection logic for the signed media asset route.
 *
 * Cloudinary is TEMPORARY storage in this product; the Google Drive archive is
 * the record. The original is destroyed only after the archive is verified, so
 * "no Cloudinary copy" is the normal state for historical media and must never
 * be reported as a deleted file.
 *
 * Priority:
 *   1. the current Cloudinary asset, if it actually exists;
 *   2. the Google Drive archived copy, if the media has a verified one;
 *   3. a genuine "no copy available" answer.
 *
 * Kept free of I/O so the whole decision table can be exercised by tests
 * (`tests/media-source.test.ts`) rather than only through a live browser.
 */
import type { MediaVariant } from "./media-types";

/** Reasons this layer exposes to the browser. */
export type MediaFailureReason =
  | "media_not_found"
  | "session_required"
  | "forbidden"
  | "file_unavailable"
  | "archive_no_preview"
  | "archive_credential_error"
  | "archive_unavailable"
  | "range_not_satisfiable"
  | "provider_unavailable"
  | "invalid_metadata";

export type MediaFailure = {
  status: number;
  reason: MediaFailureReason;
  retryable: boolean;
  message: string;
};

/** The archive-side facts the decision needs. */
export type ArchiveFacts = {
  /** true when a COMPLETED Google Drive job holds a verified file id. */
  driveArchived: boolean;
  /** 'cleanup_success' means the Cloudinary original was removed on purpose. */
  cleanupStatus: string | null;
  /** Set when the Cloudinary original was actually destroyed. */
  primaryDeletedAt: string | null;
  storageUrl: string | null;
  /**
   * Preview URL for the `thumb` variant: a persisted `thumbnail_url`, or the
   * Cloudinary delivery transformation the caller derived from the original.
   */
  previewUrl: string | null;
  /** Byte-range/`thumb` variant requested by the browser. */
  variant: MediaVariant;
  /** The host allowlist guard, injected so this module performs no I/O. */
  upstreamAllowed: (url: string | null | undefined) => boolean;
};

export function cleanupConfirmed(archive: ArchiveFacts): boolean {
  return archive.cleanupStatus === "cleanup_success" ||
    Boolean(archive.primaryDeletedAt);
}

/**
 * The Cloudinary URL a request should use, or null when there is nothing
 * usable.
 *
 * Thumbnails deliberately prefer a derived preview over the original: a grid
 * tile must never pull a full-size file. A Drive-archived photo with no
 * derivable preview therefore falls through to the archive instead.
 */
export function resolvePrimaryUpstream(archive: ArchiveFacts): string | null {
  if (archive.variant === "thumb") {
    if (archive.previewUrl) return archive.previewUrl;
    // No derivable preview: with an archive, the Drive-generated thumbnail is
    // the preview and the full-size original is never fetched for a tile.
    return archive.driveArchived ? null : archive.storageUrl;
  }
  return archive.storageUrl;
}

export type PrimaryProbeOutcome = "ok" | "missing" | "failed";

/**
 * What to do before any provider call.
 *
 * `use-archive` skips Cloudinary entirely when its copy is known to be gone,
 * which is both correct and cheaper than probing a URL that cannot work.
 */
export function planInitialSource(
  archive: ArchiveFacts,
): { action: "try-primary"; upstream: string } | { action: "use-archive" } | { action: "fail"; failure: MediaFailure } {
  if (cleanupConfirmed(archive) && archive.driveArchived) {
    return { action: "use-archive" };
  }

  const upstream = resolvePrimaryUpstream(archive);
  // A missing URL is never a usable source, whatever the host guard says.
  const usable = Boolean(upstream) && archive.upstreamAllowed(upstream);

  if (!cleanupConfirmed(archive) && usable) {
    return { action: "try-primary", upstream: upstream! };
  }

  if (archive.driveArchived) return { action: "use-archive" };

  if (cleanupConfirmed(archive)) {
    return { action: "fail", failure: unavailable() };
  }

  if (!usable) return { action: "fail", failure: invalidMetadata() };

  // A usable Cloudinary URL always takes the try-primary branch above, so this
  // is unreachable; it exists so the union stays total.
  return { action: "fail", failure: unavailable() };
}

/**
 * What to do once the Cloudinary probe has answered.
 *
 * A 404/410 from Cloudinary is not an error: it is the documented post-cleanup
 * state, so an existing archive takes over. A transport fault is different — it
 * must not be allowed to masquerade as a missing file, but when an archive
 * exists it is still the better answer than an error.
 */
export function planAfterPrimary(
  archive: ArchiveFacts,
  probe:
    | { outcome: "missing" }
    | { outcome: "failed"; failure: MediaFailure },
): { action: "use-archive" } | { action: "fail"; failure: MediaFailure } {
  if (probe.outcome === "missing") {
    if (archive.driveArchived) return { action: "use-archive" };
    return { action: "fail", failure: unavailable() };
  }

  if (archive.driveArchived) return { action: "use-archive" };
  return { action: "fail", failure: probe.failure };
}

/**
 * Maps an archive-side failure onto the browser-facing answer.
 *
 * Only `archive_missing` — Drive confirming the file is gone — becomes the
 * "file unavailable" state. Everything else stays distinguishable so a
 * credential problem or an outage is never described as a deleted file.
 */
export function planArchiveFailure(
  reason: string,
  status: number,
  retryable: boolean,
): MediaFailure {
  switch (reason) {
    case "archive_missing":
      return unavailable();
    case "no_preview":
      return {
        status: 404,
        reason: "archive_no_preview",
        retryable: false,
        message: "The archived file has no preview image available.",
      };
    case "credential_error":
    case "account_missing":
    case "account_disabled":
      return {
        status: 503,
        reason: "archive_credential_error",
        retryable: false,
        message:
          "The Google Drive archive account needs attention before this file can be shown.",
      };
    case "unauthenticated":
      return {
        status: 401,
        reason: "session_required",
        retryable: true,
        message: "The admin session was rejected while loading this media.",
      };
    case "forbidden":
    case "ownership_mismatch":
      return {
        status: 403,
        reason: "forbidden",
        retryable: false,
        message: "Not authorized.",
      };
    case "range_not_satisfiable":
      return {
        status: 416,
        reason: "range_not_satisfiable",
        retryable: false,
        message: "The requested byte range is not available for this file.",
      };
    case "media_not_found":
      return {
        status: 404,
        reason: "media_not_found",
        retryable: false,
        message: "Media not found.",
      };
    default:
      return {
        status: status === 429 ? 429 : 502,
        reason: "archive_unavailable",
        retryable,
        message:
          "The media archive could not be read right now. Try again in a moment.",
      };
  }
}

function unavailable(): MediaFailure {
  return {
    status: 404,
    reason: "file_unavailable",
    retryable: false,
    message: "This file is no longer available in storage.",
  };
}

function invalidMetadata(): MediaFailure {
  return {
    status: 422,
    reason: "invalid_metadata",
    retryable: false,
    message: "Media metadata does not contain a valid playable source.",
  };
}
