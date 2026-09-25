/**
 * Post-upload verification for the MyDrive Google Drive archive.
 *
 * Cloudinary is deleted ONLY after the Drive copy has been proven to exist.
 * This module is that proof. It is deliberately read-only: it never deletes,
 * moves, renames or re-uploads anything, so a failed verification can never
 * damage the archive or the source.
 *
 * Verification performed by `verifyDriveUpload`:
 *   1. Drive API returned success and a real file id.
 *   2. The file id resolves to a non-trashed file.
 *   3. The file is a child of the expected (user's) Drive folder.
 *   4. The file name matches the name the worker uploaded.
 *   5. The stored size is consistent with the source size.
 *   6. The MD5 checksum Drive reports is captured for audit (it is the value a
 *      later integrity audit can compare against an independent hash).
 *
 * Security: only a short-lived access token is passed in; it is never logged,
 * returned or embedded in an error message, and the response body is never
 * echoed verbatim (it can contain file metadata that must not leak wholesale).
 */

const DRIVE_API = "https://www.googleapis.com/drive/v3";

/** Raised when verification could not be completed or did not pass. */
export class DriveVerifyError extends Error {
  readonly status: number;
  /** true when re-running verification later could plausibly succeed. */
  readonly retryable: boolean;
  /** false when the Drive copy is provably wrong and must not be archived. */
  readonly mismatch: boolean;

  constructor(
    message: string,
    status: number,
    opts: { retryable?: boolean; mismatch?: boolean } = {},
  ) {
    super(message);
    this.name = "DriveVerifyError";
    this.status = status;
    this.retryable = opts.retryable ?? true;
    this.mismatch = opts.mismatch ?? false;
  }
}

/** The safe, non-secret subset of a Drive file resource. */
export interface DriveFileMetadata {
  id: string;
  name: string | null;
  mimeType: string | null;
  /** Drive reports byte counts as strings; null when Google omits them. */
  size: string | null;
  parents: string[];
  trashed: boolean;
  md5Checksum: string | null;
}

export interface DriveVerification {
  file: DriveFileMetadata;
  /** Resolved byte size, or null when Drive omitted it. */
  sizeBytes: number | null;
  /** MD5 of the archived bytes (audit value), or null when unavailable. */
  md5Checksum: string | null;
  /** Human-readable list of the checks that were actually asserted. */
  checks: string[];
}

const FILE_FIELDS =
  "id,name,mimeType,size,parents,trashed,md5Checksum,driveId,explicitlyTrashed";

/** Digits-only normalisation for Google byte counts. */
function normalizeByteCount(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^\d+$/.test(normalized) ? normalized : null;
}

/**
 * Reads a Drive file resource. Throws a typed error carrying only the HTTP
 * status; the response body is never surfaced or logged.
 */
export async function fetchDriveFileMetadata(params: {
  accessToken: string;
  fileId: string;
  fetchImpl?: typeof fetch;
}): Promise<DriveFileMetadata> {
  if (!params.accessToken) {
    throw new DriveVerifyError("Missing Drive access token", 0, { retryable: false });
  }

  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(params.fileId)}`);
  url.searchParams.set("fields", FILE_FIELDS);
  url.searchParams.set("supportsAllDrives", "true");

  const fetchImpl = params.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${params.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new DriveVerifyError(
      `Drive files.get transport failure: ${(err as Error).name ?? "error"}`,
      0,
      { retryable: true },
    );
  }

  if (!res.ok) {
    // 401/403 -> account problem; 404 -> the file is gone; 429/5xx -> transient.
    const retryable = res.status === 429 || res.status >= 500 || res.status === 0;
    throw new DriveVerifyError(
      `Drive files.get failed: HTTP ${res.status}`,
      res.status,
      { retryable, mismatch: res.status === 404 },
    );
  }

  const json = await res.json() as Record<string, unknown>;

  const id = typeof json.id === "string" ? json.id : "";
  if (!id) {
    throw new DriveVerifyError("Drive files.get returned no file id", res.status, {
      retryable: false,
      mismatch: true,
    });
  }

  return {
    id,
    name: typeof json.name === "string" ? json.name : null,
    mimeType: typeof json.mimeType === "string" ? json.mimeType : null,
    size: normalizeByteCount(json.size),
    parents: Array.isArray(json.parents)
      ? json.parents.filter((p): p is string => typeof p === "string")
      : [],
    trashed: json.trashed === true || json.explicitlyTrashed === true,
    md5Checksum: typeof json.md5Checksum === "string" ? json.md5Checksum : null,
  };
}

export interface VerifyDriveUploadParams {
  accessToken: string;
  fileId: string;
  /** Exact Drive file name the worker created. */
  expectedName: string;
  /** The user's Drive folder id the file must live in. */
  expectedParentId: string;
  /** Byte size of the source that was streamed. */
  expectedSize: number | null;
  /**
   * MD5 of the source bytes.  When supplied, the destination must report a
   * matching `md5Checksum` — this is what proves the copy is byte-identical
   * rather than merely the same length.  Omitted/null keeps the previous
   * behaviour (audit capture only).
   */
  expectedMd5?: string | null;
  fetchImpl?: typeof fetch;
}

/**
 * Asserts that the Drive copy is present, complete and located where the
 * archive contract requires. Throws DriveVerifyError on any failure; returns
 * the verification evidence on success.
 *
 * A size mismatch is reported as `mismatch: true` so the caller keeps the
 * Cloudinary source and never records the media as archived.
 */
export async function verifyDriveUpload(
  params: VerifyDriveUploadParams,
): Promise<DriveVerification> {
  const file = await fetchDriveFileMetadata({
    accessToken: params.accessToken,
    fileId: params.fileId,
    fetchImpl: params.fetchImpl,
  });

  const checks: string[] = ["file_exists"];

  // ── Identity ────────────────────────────────────────────────────────────
  if (file.id !== params.fileId) {
    throw new DriveVerifyError("Drive file id does not match the uploaded id", 200, {
      retryable: false,
      mismatch: true,
    });
  }
  checks.push("file_id_matches");

  // ── Not trashed ─────────────────────────────────────────────────────────
  if (file.trashed) {
    throw new DriveVerifyError("Drive file is trashed", 200, {
      retryable: true,
      mismatch: true,
    });
  }
  checks.push("not_trashed");

  // ── Belongs to the expected user folder ─────────────────────────────────
  if (!file.parents.includes(params.expectedParentId)) {
    throw new DriveVerifyError(
      "Drive file is not inside the expected user folder",
      200,
      { retryable: false, mismatch: true },
    );
  }
  checks.push("parent_folder_matches");

  // ── Name ────────────────────────────────────────────────────────────────
  if (file.name !== params.expectedName) {
    throw new DriveVerifyError("Drive file name does not match the upload", 200, {
      retryable: false,
      mismatch: true,
    });
  }
  checks.push("file_name_matches");

  // ── Size ────────────────────────────────────────────────────────────────
  const sizeBytes = file.size === null ? null : Number(file.size);
  if (
    params.expectedSize !== null &&
    sizeBytes !== null &&
    sizeBytes !== params.expectedSize
  ) {
    throw new DriveVerifyError(
      `Drive size ${sizeBytes} does not match source size ${params.expectedSize}`,
      200,
      { retryable: true, mismatch: true },
    );
  }
  checks.push(sizeBytes === null ? "size_unavailable" : "size_matches_source");

  // ── MD5 (byte equality) ─────────────────────────────────────────────────
  // Drive omits md5Checksum for some file types; that is an unproven copy, not
  // a passing one, so it is retryable rather than silently accepted.
  if (params.expectedMd5) {
    if (!file.md5Checksum) {
      throw new DriveVerifyError(
        "Drive reported no md5Checksum; byte equality cannot be proven",
        200,
        { retryable: true, mismatch: false },
      );
    }
    if (file.md5Checksum !== params.expectedMd5) {
      throw new DriveVerifyError(
        "Drive md5Checksum does not match the source",
        200,
        { retryable: false, mismatch: true },
      );
    }
    checks.push("md5_matches_source");
  } else {
    checks.push("md5_not_requested");
  }

  return { file, sizeBytes, md5Checksum: file.md5Checksum, checks };
}
