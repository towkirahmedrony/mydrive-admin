/**
 * Read-only Google Drive access for the MyDrive media archive.
 *
 * Direction of this module
 * ------------------------
 * `drive-replicate` OWNS the archive: it creates folders and uploads bytes.
 * This module is the opposite direction — it only READS a file that the worker
 * already archived, so an admin surface can display media whose temporary
 * Cloudinary primary has since been cleaned up.
 *
 * It never uploads, copies, deletes, trashes, renames or moves anything, and it
 * never creates a folder. A failed read can therefore never damage the archive
 * or the source, which is why the read path needs no rollback story.
 *
 * Failure vocabulary
 * ------------------
 * Every failure is reported as a `DriveMediaError` carrying a machine-readable
 * `reason`, so a caller can tell "the archived file is really gone" apart from
 * "Google could not be reached right now" and never mislabels a transient fault
 * as a deleted file:
 *
 *   archive_missing        the Drive file/project is gone, trashed or never
 *                          belonged to this credential  -> NOT retryable
 *   credential_error       the stored Drive credential is unusable
 *                          (revoked / wrong scope)       -> NOT retryable
 *   no_preview             the file exists but Drive exposes no thumbnail
 *                          (thumbnail variant only)      -> NOT retryable
 *   provider_unavailable   timeout, transport failure, 429 or 5xx
 *                                                         -> retryable
 *   range_not_satisfiable  the caller asked for a byte range the file does
 *                          not have                       -> NOT retryable
 *
 * Security
 * --------
 *   - only short-lived access tokens are passed in; they are never logged,
 *     returned or embedded in an error message;
 *   - response bodies are never echoed verbatim (they can carry file metadata
 *     that must not leak wholesale);
 *   - the thumbnail hop is restricted to Google's own thumbnail host, so a
 *     hostile value in Drive metadata cannot become an SSRF primitive.
 */

const DRIVE_API = "https://www.googleapis.com/drive/v3";

/** Host suffix every legitimate Drive `thumbnailLink` uses. */
const THUMBNAIL_HOST_SUFFIX = ".googleusercontent.com";

export type DriveMediaFailureReason =
  | "archive_missing"
  | "credential_error"
  | "no_preview"
  | "provider_unavailable"
  | "range_not_satisfiable";

export interface DriveMediaErrorOptions {
  reason: DriveMediaFailureReason;
  /** HTTP status observed upstream, or 0 for a transport failure. */
  status: number;
  /** true only when repeating the identical read could plausibly succeed. */
  retryable: boolean;
}

/** Typed, secret-free failure raised by every reader in this module. */
export class DriveMediaError extends Error {
  readonly reason: DriveMediaFailureReason;
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, options: DriveMediaErrorOptions) {
    super(message);
    this.name = "DriveMediaError";
    this.reason = options.reason;
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

/** The safe, non-secret subset of a Drive file resource this module reads. */
export interface DriveMediaMetadata {
  id: string;
  name: string | null;
  mimeType: string | null;
  /** Drive reports byte counts as strings; normalized to a number, or null. */
  sizeBytes: number | null;
  /** Google-hosted preview image, or null when Drive has none. */
  thumbnailLink: string | null;
  /** Parent folder ids; used to prove the file still lives where it was put. */
  parents: string[];
  trashed: boolean;
  md5Checksum: string | null;
}

const FILE_FIELDS = [
  "id",
  "name",
  "mimeType",
  "size",
  "thumbnailLink",
  "parents",
  "trashed",
  "explicitlyTrashed",
  "md5Checksum",
].join(",");

/** Digits-only byte count as a number, or null. Never throws on hostile input. */
function normalizeByteCount(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Maps a Google HTTP status onto the failure vocabulary above.
 *
 * `context` matters in one place: an absent thumbnail is an expected, benign
 * answer for a file that exists, whereas an absent file is not.
 */
export function classifyDriveStatus(
  status: number,
  context: "metadata" | "content" | "thumbnail",
): DriveMediaErrorOptions {
  if (status === 0) {
    return { reason: "provider_unavailable", status: 0, retryable: true };
  }
  if (status === 404 || status === 410) {
    return context === "thumbnail"
      ? { reason: "no_preview", status, retryable: false }
      : { reason: "archive_missing", status, retryable: false };
  }
  if (status === 401 || status === 403) {
    // 401 = the access token was rejected; 403 = the credential is not allowed
    // to see this file. Both mean "reconnect the account", not "file deleted".
    return { reason: "credential_error", status, retryable: false };
  }
  if (status === 416) {
    return { reason: "range_not_satisfiable", status, retryable: false };
  }
  return { reason: "provider_unavailable", status, retryable: true };
}

/**
 * Reads the file resource. Throws a typed `DriveMediaError`; the response body
 * is never surfaced or logged.
 */
export async function readDriveFileMetadata(params: {
  accessToken: string;
  fileId: string;
  fetchImpl?: typeof fetch;
}): Promise<DriveMediaMetadata> {
  if (!params.accessToken) {
    throw new DriveMediaError("Missing Drive access token", {
      reason: "credential_error",
      status: 0,
      retryable: false,
    });
  }

  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(params.fileId)}`);
  url.searchParams.set("fields", FILE_FIELDS);
  url.searchParams.set("supportsAllDrives", "true");

  const fetchImpl = params.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${params.accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new DriveMediaError(
      `Drive files.get transport failure: ${(err as Error).name ?? "error"}`,
      { reason: "provider_unavailable", status: 0, retryable: true },
    );
  }

  if (!res.ok) {
    const classified = classifyDriveStatus(res.status, "metadata");
    throw new DriveMediaError(
      `Drive files.get failed: HTTP ${res.status}`,
      classified,
    );
  }

  const json = await res.json() as Record<string, unknown>;
  const id = typeof json.id === "string" ? json.id : "";
  if (!id) {
    throw new DriveMediaError("Drive files.get returned no file id", {
      reason: "archive_missing",
      status: res.status,
      retryable: false,
    });
  }

  const trashed = json.trashed === true || json.explicitlyTrashed === true;

  return {
    id,
    name: typeof json.name === "string" ? json.name : null,
    mimeType: typeof json.mimeType === "string" ? json.mimeType : null,
    sizeBytes: normalizeByteCount(json.size),
    thumbnailLink: typeof json.thumbnailLink === "string" &&
        json.thumbnailLink.length > 0
      ? json.thumbnailLink
      : null,
    parents: Array.isArray(json.parents)
      ? json.parents.filter((parent): parent is string =>
        typeof parent === "string"
      )
      : [],
    trashed,
    md5Checksum: typeof json.md5Checksum === "string"
      ? json.md5Checksum
      : null,
  };
}

/**
 * Opens the archived bytes as a stream.
 *
 * The `Range` header is forwarded verbatim so a browser video can seek and
 * start playing before the whole file arrives, and so a preview never has to
 * download an entire original. The caller streams this response onward; this
 * function never buffers the body.
 */
export async function openDriveFileContent(params: {
  accessToken: string;
  fileId: string;
  range?: string | null;
  /**
   * The browser's validator, forwarded so Drive can answer 304 instead of
   * re-sending bytes the client already holds.
   */
  ifNoneMatch?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<Response> {
  if (!params.accessToken) {
    throw new DriveMediaError("Missing Drive access token", {
      reason: "credential_error",
      status: 0,
      retryable: false,
    });
  }

  const url = new URL(
    `${DRIVE_API}/files/${encodeURIComponent(params.fileId)}`,
  );
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.accessToken}`,
  };
  if (params.range) headers.Range = params.range;
  if (params.ifNoneMatch) headers["If-None-Match"] = params.ifNoneMatch;

  const fetchImpl = params.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      headers,
      signal: AbortSignal.timeout(params.timeoutMs ?? 120_000),
    });
  } catch (err) {
    throw new DriveMediaError(
      `Drive media download transport failure: ${(err as Error).name ?? "error"}`,
      { reason: "provider_unavailable", status: 0, retryable: true },
    );
  }

  // 304 is a complete, successful answer: the client's copy is still current.
  if (!res.ok && res.status !== 206 && res.status !== 304) {
    const classified = classifyDriveStatus(res.status, "content");
    throw new DriveMediaError(
      `Drive media download failed: HTTP ${res.status}`,
      classified,
    );
  }

  return res;
}

/** True when a thumbnail URL points at Google's own thumbnail host. */
export function isGoogleThumbnailUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return host === "googleusercontent.com" ||
    host.endsWith(THUMBNAIL_HOST_SUFFIX);
}

/**
 * Requests a specific thumbnail edge length from a Drive `thumbnailLink`.
 *
 * Drive returns links ending in a size directive (`=s220`, `=w220-h220`, ...).
 * The directive is replaced when present; when the shape is unfamiliar the link
 * is used unchanged rather than risking a broken URL — a smaller preview is a
 * far better outcome than no preview.
 */
export function withThumbnailSize(link: string, size: number): string {
  const safeSize = Number.isFinite(size) && size > 0
    ? Math.min(Math.floor(size), 1600)
    : 480;
  if (/=s\d+(-c)?$/.test(link)) return link.replace(/=s\d+(-c)?$/, `=s${safeSize}`);
  if (/=w\d+-h\d+$/.test(link)) {
    return link.replace(/=w\d+-h\d+$/, `=w${safeSize}-h${safeSize}`);
  }
  if (/=/.test(link)) return link;
  return `${link}=s${safeSize}`;
}

/**
 * Fetches a Drive-generated thumbnail (a poster frame for videos) as a small
 * image stream. This is what keeps the media grid cheap: the grid never pulls
 * a full-size original just to draw a tile.
 */
export async function openDriveThumbnail(params: {
  accessToken: string;
  thumbnailLink: string;
  size?: number;
  fetchImpl?: typeof fetch;
}): Promise<Response> {
  if (!isGoogleThumbnailUrl(params.thumbnailLink)) {
    throw new DriveMediaError("Drive thumbnail link is not a Google host", {
      reason: "no_preview",
      status: 0,
      retryable: false,
    });
  }

  const url = withThumbnailSize(
    params.thumbnailLink,
    params.size ?? 480,
  );

  const fetchImpl = params.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      // The link is short-lived and scoped; the bearer token is still sent so
      // the request works regardless of the link's public-visibility window.
      headers: { Authorization: `Bearer ${params.accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new DriveMediaError(
      `Drive thumbnail transport failure: ${(err as Error).name ?? "error"}`,
      { reason: "provider_unavailable", status: 0, retryable: true },
    );
  }

  if (!res.ok) {
    const classified = classifyDriveStatus(res.status, "thumbnail");
    throw new DriveMediaError(
      `Drive thumbnail failed: HTTP ${res.status}`,
      classified,
    );
  }

  return res;
}

/** Narrows an unknown thrown value to the failure vocabulary. */
export function driveMediaFailure(err: unknown): DriveMediaError {
  if (err instanceof DriveMediaError) return err;
  return new DriveMediaError(
    `Drive read failed: ${(err as Error)?.name ?? "error"}`,
    { reason: "provider_unavailable", status: 0, retryable: true },
  );
}
