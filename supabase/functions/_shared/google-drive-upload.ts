/**
 * Streaming Google Drive upload client for the MyDrive archive worker.
 *
 * Deliberately decoupled from Supabase: this module knows only Google's Drive
 * v3 upload protocol. The worker composes it with the existing Darwin router
 * (`shared/drive-router.ts`), folder resolver (`shared/drive-folders.ts`) and
 * the Cloudinary origin.
 *
 * Why streaming:
 *   - Media can be 500 MB or 1 GB+. Buffering the whole file in Edge Function
 *     memory would OOM; instead the Cloudinary response stream is piped
 *     straight into the Drive upload request (blob upload) or sliced into
 *     5 MB chunks (chunked resumable upload).
 *   - Chunked uploads persist Google's resumable session URI between worker
 *     invocations, so a function that times out mid-upload resumes on the next
 *     call rather than restarting from byte zero.
 *
 * Behavior:
 *   - buildResumableUploadUrl()  — create the upload session (metadata only).
 *   - uploadBlobStream()         — media fits in Edge Function memory:
 *                                  stream Cloudinary -> Drive in one request.
 *   - uploadChunked()            — large media: chunked resumable upload with
 *                                  stored progress and byte-range Resume.
 *
 * Security: no refresh tokens, no access tokens, no Drive file URLs are ever
 * logged by this module. It never touches Supabase tables.
 */

const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

export interface UploadOptions {
  accessToken: string;
  fileName: string;
  mimeType: string;
  /** Google folder id (drive_folders.google_folder_id). */
  parentFolderId: string | null;
  /** Total media size in bytes. */
  fileSize: number;
  /** Description attached to the Drive file metadata. */
  description?: string;
}

export interface ChunkUploadOptions extends UploadOptions {
  /** Total bytes uploaded so far on a resumed session. */
  resumeAtBytes?: number;
  /**
   * Existing resumable session URI to continue instead of creating a new one.
   * Persisted on the job row so a worker that dies mid-upload resumes rather
   * than restarting from byte zero (and never creates a second Drive file).
   */
  uploadUrl?: string;
}

export interface ChunkProgress {
  /** Total bytes uploaded so far (including chunks sent this invocation). */
  bytesSent: number;
  /** Google resumable session URI to persist for the next invocation. */
  uploadUrl: string;
}

/**
 * Where the bytes to upload come from.
 *
 * `sourceUrl` is the original public-fetch path (Cloudinary).  `openSource`
 * exists so the SAME upload implementation can be reused for a Drive->Drive
 * byte relay, where the bytes are private and require an Authorization header:
 * the caller opens the authenticated response and this module streams it
 * through unchanged.  When both are supplied `openSource` wins.
 */
export interface UploadSourceOptions {
  /** Public, directly fetchable source URL. */
  sourceUrl?: string;
  /** Authenticated opener. Called once per attempt; never buffered. */
  openSource?: () => Promise<Response>;
}

/**
 * Resolves the source response without buffering it.
 *
 * Kept as one helper so the streaming and chunked paths cannot drift apart in
 * how they treat an authenticated source.
 */
/**
 * Fails fast when no source was supplied.  Checked BEFORE the resumable session
 * is created so a misconfigured call cannot leave a dangling session behind.
 */
function requireSource(options: UploadSourceOptions, label: string): void {
  if (!options.openSource && !options.sourceUrl) {
    throw new Error(`${label} requires either sourceUrl or openSource`);
  }
}

async function openUploadSource(
  options: UploadSourceOptions,
  label: string,
  timeoutMs: number,
): Promise<Response> {
  if (options.openSource) {
    const res = await options.openSource();
    if (!res.ok && res.status !== 206) {
      throw new Error(`${label} failed: HTTP ${res.status}`);
    }
    if (!res.body) throw new Error(`${label} response has no body stream`);
    return res;
  }
  if (!options.sourceUrl) {
    throw new Error(`${label} requires either sourceUrl or openSource`);
  }
  const res = await fetch(options.sourceUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${label} failed: HTTP ${res.status}`);
  if (!res.body) throw new Error(`${label} response has no body stream`);
  return res;
}

/**
 * Creates a fresh resumable upload session for a file. Metadata (name,
 * parents, mime type) is sent now; content is uploaded later.
 */
export async function buildResumableUploadUrl(
  options: UploadOptions,
): Promise<string> {
  const metadata: Record<string, unknown> = {
    name: options.fileName,
    mimeType: options.mimeType,
  };
  if (options.parentFolderId) metadata.parents = [options.parentFolderId];
  if (options.description) metadata.description = options.description;

  const url = new URL(UPLOAD_URL);
  url.searchParams.set("uploadType", "resumable");

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      "Content-Type": "application/json",
      "X-Upload-Content-Length": String(options.fileSize),
      "X-Upload-Content-Type": options.mimeType,
    },
    body: JSON.stringify(metadata),
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw await driveHttpError(res, "Drive resumable session failed");
  }

  const location = res.headers.get("location");
  if (!location) {
    throw new Error("Drive resumable session returned no upload URL");
  }
  return location;
}

/**
 * Minimal session-URI Status check used when resuming. Returns the number of
 * bytes Drive has already accepted for the session, or null when unknown.
 */
export async function getResumableUploadProgress(
  uploadUrl: string,
  accessToken: string,
): Promise<number | null> {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Length": "0",
      "Content-Range": "bytes */0",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });

  if (res.status === 308 || res.status === 200 || res.status === 201) {
    const range = (res.headers.get("range") ?? "").trim();
    const match = /bytes=0-(\d+)/.exec(range);
    if (match) return Number(match[1]) + 1;
    return 0;
  }

  // 404/410 -> expired session; 4xx permanent -> throw (upload must restart).
  throw await driveHttpError(res, "Drive upload status check failed");
}

/**
 * Deletes an in-progress or partial file so a retry starts clean (and never
 * leaves orphaned partial files in the user's folder).
 */
export async function deletePartialDriveFile(
  fileId: string,
  accessToken: string,
): Promise<void> {
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("supportsAllDrives", "true");

  const res = await fetch(url.toString(), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });

  // 404 = already gone; any other non-2xx is best-effort (we log, not throw).
  if (res.status === 404 || res.ok) return;
  throw await driveHttpError(res, "Drive partial-file cleanup failed");
}

/**
 * Uploads media that can safely fit in the Edge Function's memory budget.
 *
 * Uses the resumable protocol so the file's NAME/MIME/PARENTS metadata is set
 * from the upload session, then streams the whole Cloudinary response straight
 * through to Drive in ONE request. The file is never materialised in worker
 * memory and never downloaded to Android.
 */
export async function uploadStreaming(
  options: UploadOptions & UploadSourceOptions & { timeoutMs?: number },
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 50_000;
  requireSource(options, "Source fetch");
  const uploadUrl = await buildResumableUploadUrl(options);

  const source = await openUploadSource(options, "Source fetch", timeoutMs);

  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      "Content-Type": options.mimeType,
      "Content-Length": String(options.fileSize),
      // Total content-range tells Drive this single PUT carries the whole file.
      "Content-Range": `bytes 0-${options.fileSize - 1}/${options.fileSize}`,
    },
    // ReadableStream → request body: the runtime pipes bytes through without
    // buffering the whole file in worker memory.
    body: source.body as unknown as BodyInit,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) throw await driveHttpError(res, "Drive upload failed");

  try {
    const json = await res.json() as { id?: string };
    if (!json.id) throw new Error("Drive upload returned no file id");
    return json.id;
  } catch {
    throw new Error("Drive upload returned an unparseable response");
  }
}

/**
 * Uploads a large file in 5 MB chunks, starting a fresh resumable session or
 * resuming the persisted one. Every successful chunk is reported back so the
 * worker can persist progress before it crashes/timeouts.
 */
export async function uploadChunked(
  options: ChunkUploadOptions & UploadSourceOptions & { chunkCloseMs?: number },
  onProgress: (progress: ChunkProgress) => Promise<void>,
): Promise<{ fileId: string; bytesSent: number }> {
  requireSource(options, "Source fetch");
  const resumeAt = options.resumeAtBytes ?? 0;
  const chunkSize = 5 * 1024 * 1024;
  // On resume the resumable session URI is persisted; when absent start fresh.
  const uploadUrl = options.uploadUrl ??
    await buildResumableUploadUrl(options);

  const source = await openUploadSource(options, "Source fetch", 60_000);

  let accumulated = resumeAt; // bytes Drive already accepted before this call

  // Resume: drive has the first `resumeAt` bytes, so skip them in the source
  // stream; chunk boundaries computed from `accumulated` stay aligned.
  let skipped = 0n;
  if (resumeAt > 0) {
    const reader = source.body?.getReader();
    if (reader) {
      try {
        while (skipped < resumeAt) {
          const { done, value } = await reader.read();
          if (done) break;
          skipped += BigInt(value.length);
        }
      } finally {
        reader.releaseLock();
      }
    }
  }

  for await (const part of batchReader(source.body, chunkSize)) {
    const start = accumulated;
    const end = Math.min(start + part.length - 1, options.fileSize - 1);
    const bodyLength = end - start + 1;
    const isFinal = end === options.fileSize - 1;

    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        "Content-Length": String(bodyLength),
        "Content-Range": isFinal
          ? `bytes ${start}-${end}/${options.fileSize}`
          : `bytes ${start}-${end}/*`,
      },
      body: part,
      redirect: "follow",
      signal: AbortSignal.timeout(options.chunkCloseMs ?? 60_000),
    });

    if (res.ok) {
      accumulated = end + 1;
      await onProgress({ bytesSent: accumulated, uploadUrl });

      // Final chunk → Drive returns the file id in the 2xx response body.
      if (res.status === 200 || res.status === 201) {
        try {
          const json = await res.json() as { id?: string };
          if (!json.id) throw new Error("Drive upload returned no file id");
          return { fileId: json.id, bytesSent: accumulated };
        } catch {
          throw new Error("Drive upload returned an unparseable response");
        }
      }
      continue;
    }

    if (res.status === 308) {
      // 308 = Drive already has some bytes; continue from where it says.
      const range = (res.headers.get("range") ?? "").trim();
      const match = /bytes=0-(\d+)/.exec(range);
      const serverReceived = match ? Number(match[1]) + 1 : accumulated;
      if (serverReceived > accumulated) {
        accumulated = serverReceived;
        await onProgress({ bytesSent: accumulated, uploadUrl });
      }
      continue;
    }

    if (res.status === 404 || res.status === 410) {
      throw new DriveUploadExpiredError(
        "Drive resumable session expired; restart upload",
      );
    }

    throw await driveHttpError(res, "Drive chunk upload failed");
  }

  // Stream ended without an explicit completion. Ask Drive how many bytes it
  // really has — typically because the final chunk used the open-ended range
  // form and Drive only acks with 308.
  if (accumulated === options.fileSize) {
    const accepted = await getResumableUploadProgress(uploadUrl, options.accessToken);
    if (accepted === options.fileSize) {
      const { fileId } = await finalizeIncompleteUpload(
        uploadUrl,
        options.accessToken,
      );
      return { fileId, bytesSent: accepted };
    }
  }

  const accepted = await getResumableUploadProgress(uploadUrl, options.accessToken);
  if (accepted !== null && accepted !== accumulated) {
    await onProgress({ bytesSent: accepted, uploadUrl });
  }
  throw new DriveUploadUncertainError(accepted ?? accumulated, uploadUrl);
}

/**
 * Completes a fully-transmitted upload by sending a zero-length final chunk
 * with the TOTAL content-range, which makes Drive return the file metadata.
 */
async function finalizeIncompleteUpload(
  uploadUrl: string,
  accessToken: string,
): Promise<{ fileId: string }> {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Length": "0",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });

  if (res.status === 200 || res.status === 201) {
    const json = await res.json() as { id?: string };
    if (json.id) return { fileId: json.id };
  }
  throw await driveHttpError(res, "Drive upload finalization failed");
}

/**
 * Error class for permanent/google-side upload failures. Keeps a status code
 * plus safe, token-free diagnostics (Drive error bodies contain no secrets).
 */
export class DriveUploadError extends Error {
  status: number;
  /** True when Google reports the account is out of storage. */
  quotaExceeded: boolean;
  /** Retry-After seconds when Google provided one (429 / transient). */
  retryAfterSeconds: number | null;
  constructor(
    status: number,
    message: string,
    opts: { quotaExceeded?: boolean; retryAfterSeconds?: number | null } = {},
  ) {
    super(`${message} (HTTP ${status})`);
    this.status = status;
    this.quotaExceeded = opts.quotaExceeded ?? false;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
  }
}

/** Raised when the resumable session can no longer be resumed. */
export class DriveUploadExpiredError extends Error {}

/** Raised when progression is incomplete but nothing failed explicitly. */
export class DriveUploadUncertainError extends Error {
  acceptedBytes: number;
  uploadUrl: string;
  constructor(acceptedBytes: number, uploadUrl: string) {
    super(`Drive upload progress uncertain at ${acceptedBytes} bytes`);
    this.acceptedBytes = acceptedBytes;
    this.uploadUrl = uploadUrl;
  }
}

/**
 * Builds a DriveUploadError from an HTTP response, capturing safe diagnostics
 * (quota-exhausted messaging and Retry-After) without ever echoing tokens.
 */
export async function driveHttpError(
  res: Response,
  fallback: string,
): Promise<DriveUploadError> {
  let text = "";
  try {
    text = (await res.text()).slice(0, 500);
  } catch {
    text = "";
  }
  const quotaExceeded = /storage ?quota|enough storage|storageQuotaExceeded|insufficient/i
    .test(text);
  const retryAfterRaw = res.headers.get("retry-after");
  let retryAfterSeconds: number | null = null;
  if (retryAfterRaw) {
    const n = Math.round(Number(retryAfterRaw));
    if (Number.isFinite(n) && n >= 0) retryAfterSeconds = n;
  }
  if (!quotaExceeded) {
    const bodySec = /"retryDelaySeconds":\s*"(\d+)"/.exec(text) ??
      /"retryDelaySeconds":\s*(\d+)/.exec(text);
    if (bodySec) retryAfterSeconds = Number(bodySec[1]);
  }
  const message = text.length > 0 ? text.slice(0, 200) : fallback;
  return new DriveUploadError(res.status, message, {
    quotaExceeded,
    retryAfterSeconds,
  });
}

/**
 * Pulls a ReadableStream into BufferedChunk instances of roughly `size`
 * bytes. Chunks are yielded in order without assembling the full stream.
 */
async function* batchReader(
  stream: ReadableStream<Uint8Array> | null,
  size: number,
): AsyncGenerator<Uint8Array> {
  if (!stream) return;
  const reader = stream.getReader();
  const buffer = new Uint8Array(size);
  let fill = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      let offset = 0;
      while (offset < value.length) {
        const take = Math.min(size - fill, value.length - offset);
        buffer.set(value.subarray(offset, offset + take), fill);
        fill += take;
        offset += take;

        if (fill === size) {
          const out = new Uint8Array(fill);
          out.set(buffer.subarray(0, fill));
          yield out;
          fill = 0;
        }
      }
    }

    if (fill > 0) {
      const out = new Uint8Array(fill);
      out.set(buffer.subarray(0, fill));
      yield out;
    }
  } finally {
    reader.releaseLock();
  }
}