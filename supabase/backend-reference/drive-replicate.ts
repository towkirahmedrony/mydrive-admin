import { serve } from "jsr:@std/http";
import { corsHeaders, handleCors } from "../shared/cors.ts";
import { getSupabaseAdmin } from "../shared/auth.ts";
import {
  planNextDriveAccount,
  markDriveAccountResult,
  releaseDriveQuota,
} from "../shared/drive-router.ts";
import {
  accessTokenForAccount,
  resolveUserDriveFolder,
  type DriveFolderRow,
} from "../shared/drive-folders.ts";
import { findFileByName } from "../shared/google-drive.ts";
import {
  uploadChunked,
  uploadStreaming,
  DriveUploadError,
  DriveUploadExpiredError,
  DriveUploadUncertainError,
  type ChunkProgress,
} from "../shared/google-drive-upload.ts";

/**
 * drive-replicate — server-side Google Drive replication worker.
 *
 * Android -> Cloudinary -> Supabase media_assets -> PENDING Drive job ->
 * this worker -> Drive Router -> selected Google Drive account ->
 * user's per-account folder -> original media file on Google Drive.
 *
 * Android NEVER uploads to Google Drive and Google Drive is never exposed to
 * the app; it is an admin/office archive destination managed entirely here.
 *
 * Behavior summary:
 *   - claim_drive_job() atomically claims the next PENDING/RETRYING (or
 *     long-stale PROCESSING) Drive job; concurrent workers can never
 *     double-process the same row (FOR UPDATE SKIP LOCKED).
 *   - The Drive Router (list/reserve over drive_accounts, no hardcoded
 *     accounts) picks the best enabled+healthy account with enough quota and
 *     the configured safety margin, excluding accounts the job already failed
 *     on (failed_drive_account_ids = failover list).
 *   - resolveUserDriveFolder() reuses the stored drive_folders mapping for
 *     (user, account) or creates it idempotently under a creation lease.
 *   - Original Cloudinary media is streamed to Drive (never buffered whole in
 *     memory, never downloaded to Android). Files up to 20 MB use a single
 *     streaming resumable request; larger files use 5 MB chunked resumable
 *     uploads whose session URI + progress survive worker timeouts/crashes.
 *   - Transient failures retry with exponential backoff; account-level
 *     failures (OAuth, quota, disabled) fail over to the next eligible
 *     account on the SAME job row — the media_assets record is never
 *     duplicated and the application user stays authoritative.
 *   - A Cloudinary success or Telegram replication is never rolled back by a
 *     Drive failure.
 *
 * Security:
 *   - service-role key required (or public_url=true for cron). Google refresh
 *     tokens and OAuth client secrets stay in the Vault / Edge Function
 *     secrets and are never logged or returned.
 *
 * Deploy:
 *   supabase db push
 *   supabase functions deploy drive-replicate
 */

type AdminClient = ReturnType<typeof getSupabaseAdmin>;

const BATCH_SIZE = 2; // jobs per invocation
const MAX_MS = 48_000; // stay well inside the 60s Edge Function limit
const CONCURRENT_LIMIT = 3; // in-process concurrency guard
const CHUNKED_THRESHOLD_BYTES = 20 * 1024 * 1024; // >= this -> chunked resumable

// ─── Types ────────────────────────────────────────────────────────────────

interface DriveJob {
  id: string;
  media_id: string;
  drive_account_id: string | null;
  drive_folder_id: string | null;
  status: string;
  attempt_count: number;
  last_error: string | null;
  next_retry_at: string | null;
  google_drive_file_id: string | null;
  failed_drive_account_ids: string[];
  google_drive_upload_url: string | null;
  google_drive_upload_chunk: number;
  google_drive_upload_attempts: number;
  created_at: string;
}

interface MediaAsset {
  id: string;
  owner_id: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  storage_url: string | null;
  storage_asset_id: string;
  status: string;
}

interface AppSettings {
  drive_enabled: boolean;
  max_retry: number;
  retry_base_delay_seconds: number;
}

// ─── In-process concurrency guard ─────────────────────────────────────────

let inflight = 0;

// ─── Entry point ──────────────────────────────────────────────────────────

serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (inflight >= CONCURRENT_LIMIT) {
    return jsonResponse({ processed: 0, reason: "Worker busy" }, 429);
  }

  inflight++;
  const started = Date.now();

  try {
    const url = new URL(req.url);
    const isPublicUrl = url.searchParams.get("public_url") === "true";

    let admin: AdminClient;
    if (isPublicUrl) {
      admin = getSupabaseAdmin();
    } else {
      const authHeader = req.headers.get("Authorization") ?? "";
      if (!authHeader.startsWith("Bearer ")) {
        return jsonResponse(
          { error: "Authorization required (service role key)" },
          401,
        );
      }
      admin = getSupabaseAdmin();
    }

    const { data: settings } = await admin
      .from("app_settings")
      .select("*")
      .eq("id", true)
      .maybeSingle();

    const typedSettings = (settings as AppSettings | null) ?? null;
    const maxRetry = typedSettings?.max_retry ?? 5;
    const retryBase = typedSettings?.retry_base_delay_seconds ?? 60;

    let processed = 0;
    const results: Array<{ job_id: string; status: string; error?: string }> =
      [];

    while (processed < BATCH_SIZE && Date.now() - started < MAX_MS) {
      const claimed = await claimNextJob(admin);
      if (!claimed) break;

      const result = await processJob(admin, claimed, {
        ...typedSettings,
        max_retry: maxRetry,
        retry_base_delay_seconds: retryBase,
      });
      processed++;
      results.push({
        job_id: claimed.id,
        status: result.status,
        error: result.error,
      });
    }

    return jsonResponse(
      { processed, results, elapsed_ms: Date.now() - started },
      200,
    );
  } catch (error) {
    console.error(
      "drive-replicate worker failed:",
      ((error as Error).message ?? String(error)).slice(0, 500),
    );
    return jsonResponse({ error: (error as Error).message }, 500);
  } finally {
    inflight--;
  }
});

// ─── Job claiming ─────────────────────────────────────────────────────────

async function claimNextJob(admin: AdminClient): Promise<DriveJob | null> {
  const { data, error } = await admin.rpc("claim_drive_job").maybeSingle();
  if (error) {
    console.error("claim_drive_job RPC error:", error.message);
    return null;
  }
  return (data as DriveJob | null) ?? null;
}

// ─── Single job processing ────────────────────────────────────────────────

async function processJob(
  admin: AdminClient,
  job: DriveJob,
  settings: AppSettings,
): Promise<{ status: string; error?: string }> {
  const log = (msg: string) =>
    console.log(`[drive ${job.id.slice(0, 8)}] ${msg}`);

  log(
    `Processing (attempt ${job.attempt_count}) account=${job.drive_account_id ?? "none"}`,
  );

  // ── 1. Idempotency: a job that already holds a Drive file id is done ──
  if (job.status === "COMPLETED") {
    log("Already completed — skipping");
    return { status: "SKIPPED" };
  }
  // A claimed (PENDING/RETRYING) job that already has a file id means a
  // previous run completed the upload but failed to persist COMPLETED.
  if (job.google_drive_file_id && job.drive_account_id) {
    log(`Reconciling: file ${job.google_drive_file_id} already exists`);
    await completeDriveJob(admin, job.id, {
      status: "COMPLETED",
      driveAccountId: job.drive_account_id,
      driveFolderId: job.drive_folder_id,
      driveFileId: job.google_drive_file_id,
    });
    await logSyncEvent(admin, job, "JOB_COMPLETED", "COMPLETED", {
      file_id: job.google_drive_file_id,
      account_id: job.drive_account_id,
      reconciled: true,
    });
    return { status: "COMPLETED" };
  }

  // ── 2. Global switch ────────────────────────────────────────────────
  if (settings.drive_enabled === false) {
    const msg = "Drive replication is disabled globally";
    log(msg);
    await completeDriveJob(admin, job.id, { status: "SKIPPED", error: msg });
    await logSyncEvent(admin, job, "JOB_SKIPPED", "SKIPPED", { reason: msg });
    return { status: "SKIPPED", error: msg };
  }

  // ── 3. Load media ───────────────────────────────────────────────────
  const media = await loadMedia(admin, job);
  if (!media) {
    const msg = "Media not found or not READY";
    log(`FAIL (permanent): ${msg}`);
    await completeDriveJob(admin, job.id, { status: "FAILED", error: msg });
    await logSyncEvent(admin, job, "JOB_FAILED", "FAILED", { reason: msg });
    return { status: "FAILED", error: msg };
  }
  if (!media.storage_url || !media.storage_asset_id) {
    const msg = "Media has no Cloudinary origin (storage_url missing)";
    log(`FAIL (permanent): ${msg}`);
    await completeDriveJob(admin, job.id, { status: "FAILED", error: msg });
    await logSyncEvent(admin, job, "JOB_FAILED", "FAILED", { reason: msg });
    return { status: "FAILED", error: msg };
  }

  // ── 4. Route: pick the best eligible account (atomic quota reserve) ──
  const routed = await planNextDriveAccount(admin, job.id, {
    requiredBytes: media.file_size,
  });
  const account = routed.account;

  if (!account) {
    const msg =
      "No eligible Drive account (all full, disconnected, disabled or excluded)";
    if (job.attempt_count >= settings.max_retry) {
      log(`FAIL (attempts exhausted): ${msg}`);
      await completeDriveJob(admin, job.id, { status: "FAILED", error: msg });
      await logSyncEvent(admin, job, "JOB_FAILED", "FAILED", { reason: msg });
      return { status: "FAILED", error: msg };
    }
    log(`TRANSIENT (no route): ${msg}`);
    const backoff = computeBackoff(job, settings.retry_base_delay_seconds);
    await retryDriveJobSameAccount(admin, job.id, null, null, msg, backoff);
    await logSyncEvent(admin, job, "JOB_RETRY", "RETRYING", {
      reason: msg,
      next_retry_ms: backoff * 1000,
    });
    return { status: "RETRYING", error: msg };
  }

  log(
    `Routed to account ${account.id.slice(0, 8)} (${account.google_email ?? "?"}, priority ${account.priority})`,
  );

  // An upload session left over from a previous, different account must be
  // discarded before we start on this one.
  const resumeSameAccount =
    job.google_drive_upload_url &&
    job.google_drive_upload_chunk > 0 &&
    job.drive_account_id === account.id;

  // ── 5. Persist the account selection (keep PROCESSING) ──────────────
  await admin
    .from("replication_jobs")
    .update({ drive_account_id: account.id, updated_at: new Date().toISOString() })
    .eq("id", job.id);

  if (!resumeSameAccount && job.google_drive_upload_url) {
    await admin
      .from("replication_jobs")
      .update({
        google_drive_upload_url: null,
        google_drive_upload_chunk: 0,
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    log("Discarded upload session from a previous account");
  }

  // ── 6. Resolve (or create) the user's folder on this account ────────
  let folder: DriveFolderRow | null = null;
  try {
    folder = await resolveUserDriveFolder(admin, account, media.owner_id);
  } catch (err) {
    const errMsg = (err as Error).message;
    const decision = decideFailure(err);
    if (decision.kind === "failover") {
      log(`FOLDER account failure → failover: ${errMsg}`);
      const outcome = await accountFailover(admin, job, account, settings, errMsg, decision);
      await logSyncEvent(admin, job, "JOB_FAILOVER", outcome, {
        from_account: account.id,
        error: errMsg,
      });
      return { status: outcome, error: errMsg };
    }
    if (decision.kind === "permanent") {
      log(`FAIL (folder permanent): ${errMsg}`);
      await releaseDriveQuota(admin, account.id, media.file_size).catch(() => {});
      await completeDriveJob(admin, job.id, { status: "FAILED", error: errMsg });
      await logSyncEvent(admin, job, "JOB_FAILED", "FAILED", { reason: errMsg });
      return { status: "FAILED", error: errMsg };
    }
    // transient folder trouble (root folder lease held elsewhere, network…)
    log(`TRANSIENT (folder): ${errMsg}`);
    const backoff = computeBackoff(job, settings.retry_base_delay_seconds);
    await retryDriveJobSameAccount(
      admin, job.id, account.id, job.drive_folder_id, errMsg, backoff,
    );
    await logSyncEvent(admin, job, "JOB_RETRY", "RETRYING", { reason: errMsg });
    return { status: "RETRYING", error: errMsg };
  }

  if (!folder || !folder.google_folder_id) {
    const msg =
      "User folder not ready yet (creation lease held elsewhere) — will retry";
    log(msg);
    const backoff = computeBackoff(job, settings.retry_base_delay_seconds);
    await retryDriveJobSameAccount(admin, job.id, account.id, null, msg, backoff);
    await logSyncEvent(admin, job, "JOB_RETRY", "RETRYING", { reason: msg });
    return { status: "RETRYING", error: msg };
  }

  await admin
    .from("replication_jobs")
    .update({ drive_folder_id: folder.id, updated_at: new Date().toISOString() })
    .eq("id", job.id);
  log(`Folder ${folder.google_folder_id} (${folder.folder_status}) on account ${account.id.slice(0, 8)}`);
  await logSyncEvent(admin, job, "FOLDER_RESOLVED", "OK", {
    account_id: account.id,
    folder_id: folder.id,
    google_folder_id: folder.google_folder_id,
    created: folder.folder_status === "active" && folder.create_attempts >= 1,
  });

  // ── 7. Access token (server-side secrets only) ─────────────────────
  let accessToken: string;
  try {
    accessToken = await accessTokenForAccount(admin, account.id);
  } catch (err) {
    const errMsg = (err as Error).message;
    log(`AUTH account failure → failover: ${errMsg}`);
    const decision = decideFailure(err);
    const outcome = await accountFailover(admin, job, account, settings, errMsg, decision);
    await logSyncEvent(admin, job, "JOB_FAILOVER", outcome, {
      from_account: account.id,
      error: errMsg,
    });
    return { status: outcome, error: errMsg };
  }

  // ── 8. Re-check job state right before upload (double-delivery guard) ──
  const recheck = await admin
    .from("replication_jobs")
    .select("status, google_drive_file_id")
    .eq("id", job.id)
    .maybeSingle();
  if (recheck.data) {
    const rc = recheck.data as { status: string; google_drive_file_id: string | null };
    if (rc.status === "COMPLETED" || rc.google_drive_file_id) {
      log(`Job already completed elsewhere — skipping upload`);
      return { status: "SKIPPED" };
    }
  }

  // ── 9. Duplicate guard (fresh uploads only) ────────────────────────
  const fileName = driveFileName(media);
  if (!resumeSameAccount) {
    try {
      const existingId = await findFileByName(
        fileName,
        folder.google_folder_id,
        accessToken,
      );
      if (existingId) {
        log(`File already exists on Drive (${existingId}) — marking COMPLETED`);
        await completeDriveJob(admin, job.id, {
          status: "COMPLETED",
          driveAccountId: account.id,
          driveFolderId: folder.id,
          driveFileId: existingId,
        });
        await logSyncEvent(admin, job, "JOB_COMPLETED", "COMPLETED", {
          file_id: existingId,
          account_id: account.id,
          folder_id: folder.id,
          reused: true,
        });
        return { status: "COMPLETED" };
      }
    } catch (err) {
      // A list failure shouldn't abort a legitimate upload — just log.
      log(`Duplicate check skipped (${(err as Error).message})`);
    }
  }

  // ── 10. Upload the original media (streamed, no full buffering) ────
  const description =
    `MyDrive archive\nmedia_id: ${media.id}\ncloudinary: ${media.storage_asset_id}`.slice(
      0, 500,
    );

  // Live report of the newest resumable position, in case we need to resume.
  let lastChunkProgress: ChunkProgress | null = null;

  try {
    let fileId: string;

    if (media.file_size <= CHUNKED_THRESHOLD_BYTES) {
      log(`Uploading ${(media.file_size / 1024 / 1024).toFixed(2)} MB (streamed)`);
      fileId = await uploadStreaming({
        accessToken,
        sourceUrl: media.storage_url,
        fileName,
        mimeType: media.mime_type || "application/octet-stream",
        parentFolderId: folder.google_folder_id,
        fileSize: media.file_size,
        description,
      });
      log(`SUCCESS: file ${fileId}`);
    } else {
      const resumeAt = resumeSameAccount ? job.google_drive_upload_chunk : 0;
      log(
        `Uploading ${(media.file_size / 1024 / 1024).toFixed(1)} MB (chunked, resume @ ${resumeAt} bytes)`,
      );
      const onProgress = async (progress: ChunkProgress) => {
        lastChunkProgress = progress;
        await persistUploadProgress(admin, job.id, progress);
      };
      const { fileId: chunkedId, bytesSent } = await uploadChunked(
        {
          accessToken,
          sourceUrl: media.storage_url,
          fileName,
          mimeType: media.mime_type || "application/octet-stream",
          parentFolderId: folder.google_folder_id,
          fileSize: media.file_size,
          description,
          resumeAtBytes: resumeAt,
          uploadUrl: resumeSameAccount ? job.google_drive_upload_url : undefined,
          chunkCloseMs: 45_000,
        },
        onProgress,
      );
      fileId = chunkedId;
      log(`SUCCESS: file ${fileId} (${bytesSent} bytes)`);
    }

    await completeDriveJob(admin, job.id, {
      status: "COMPLETED",
      driveAccountId: account.id,
      driveFolderId: folder.id,
      driveFileId: fileId,
    });
    await markDriveAccountResult(admin, account.id, {
      healthStatus: "healthy",
      status: "active",
      lastError: null,
    }).catch(() => {});
    await logSyncEvent(admin, job, "JOB_COMPLETED", "COMPLETED", {
      file_id: fileId,
      account_id: account.id,
      folder_id: folder.id,
      google_folder_id: folder.google_folder_id,
      bytes: media.file_size,
    });
    return { status: "COMPLETED" };
  } catch (err) {
    const decision = decideFailure(err);
    const errMsg = (err as Error).message;

    switch (decision.kind) {
      case "failover": {
        log(`ACCOUNT FAILURE → failover: ${errMsg}`);
        const outcome = await accountFailover(admin, job, account, settings, errMsg, decision);
        await logSyncEvent(admin, job, "JOB_FAILOVER", outcome, {
          from_account: account.id,
          error: errMsg,
        });
        return { status: outcome, error: errMsg };
      }
      case "restart_session": {
        if (job.attempt_count >= settings.max_retry) {
          log(`FAIL (attempts exhausted): ${errMsg}`);
          await releaseDriveQuota(admin, account.id, media.file_size).catch(() => {});
          await completeDriveJob(admin, job.id, { status: "FAILED", error: errMsg });
          await logSyncEvent(admin, job, "JOB_FAILED", "FAILED", { reason: errMsg });
          return { status: "FAILED", error: errMsg };
        }
        log(`SESSION EXPIRED → fresh restart: ${errMsg}`);
        await clearUploadSession(admin, job.id);
        const backoff = 30; // restart quickly, session+cold
        await retryDriveJobSameAccount(
          admin, job.id, account.id, folder.id, errMsg, backoff,
        );
        await logSyncEvent(admin, job, "JOB_RETRY", "RETRYING", { reason: errMsg });
        return { status: "RETRYING", error: errMsg };
      }
      case "permanent": {
        log(`FAIL (permanent): ${errMsg}`);
        await releaseDriveQuota(admin, account.id, media.file_size).catch(() => {});
        await completeDriveJob(admin, job.id, { status: "FAILED", error: errMsg });
        await logSyncEvent(admin, job, "JOB_FAILED", "FAILED", { reason: errMsg });
        return { status: "FAILED", error: errMsg };
      }
      case "transient_retry":
      default: {
        // Transient: Cloudinary hiccups, Drive 5xx / 429, network, or an
        // uncertain upload outcome where we must simply resume.
        if (job.attempt_count >= settings.max_retry) {
          log(`FAIL (attempts exhausted): ${errMsg}`);
          await releaseDriveQuota(admin, account.id, media.file_size).catch(() => {});
          await completeDriveJob(admin, job.id, { status: "FAILED", error: errMsg });
          await logSyncEvent(admin, job, "JOB_FAILED", "FAILED", { reason: errMsg });
          return { status: "FAILED", error: errMsg };
        }
        log(`TRANSIENT: ${errMsg}`);
        if (decision.retrySeconds != null && decision.health === "degraded") {
          await markDriveAccountResult(admin, account.id, {
            healthStatus: "degraded",
            lastError: errMsg.slice(0, 500),
          }).catch(() => {});
        }
        const backoff = decision.retrySeconds ??
          computeBackoff(job, settings.retry_base_delay_seconds);
        // Preserve the resumable session/progress when the outcome was
        // uncertain (retry returns on the same account and resumes).
        await retryDriveJobSameAccount(
          admin,
          job.id,
          account.id,
          folder.id,
          errMsg,
          backoff,
          decision.kind === "uncertain"
            ? (lastChunkProgress?.bytesSent ?? job.google_drive_upload_chunk)
            : null,
        );
        await logSyncEvent(admin, job, "JOB_RETRY", "RETRYING", {
          reason: errMsg,
          resume_at: decision.kind === "uncertain" ? job.google_drive_upload_chunk : 0,
          next_retry_ms: backoff * 1000,
        });
        return { status: "RETRYING", error: errMsg };
      }
    }
  }
}

// ─── Load helpers ─────────────────────────────────────────────────────────

async function loadMedia(
  admin: AdminClient,
  job: DriveJob,
): Promise<MediaAsset | null> {
  const { data, error } = await admin
    .from("media_assets")
    .select(
      "id, owner_id, file_name, mime_type, file_size, storage_url, storage_asset_id, status",
    )
    .eq("id", job.media_id)
    .maybeSingle();

  if (error || !data) return null;
  const row = data as unknown as MediaAsset;
  if (row.status !== "READY") return null;
  if (typeof row.file_size !== "number" || row.file_size < 0) return null;
  return row;
}

// ─── Lifecycle helpers (state only, single atomic UPDATE each) ────────────

async function completeDriveJob(
  admin: AdminClient,
  jobId: string,
  params: {
    status: string;
    driveAccountId?: string | null;
    driveFolderId?: string | null;
    driveFileId?: string | null;
    error?: string | null;
    nextRetryAt?: string | null;
    uploadUrl?: string | null;
    uploadChunk?: number | null;
  },
): Promise<void> {
  const { error } = await admin.rpc("complete_drive_job", {
    p_job_id: jobId,
    p_status: params.status,
    p_last_error: (params.error ?? null)?.slice(0, 4000) ?? null,
    p_drive_account_id: params.driveAccountId ?? null,
    p_drive_folder_id: params.driveFolderId ?? null,
    p_google_drive_file_id: params.driveFileId ?? null,
    p_next_retry_at: params.nextRetryAt ?? null,
    p_upload_url: params.uploadUrl ?? null,
    p_upload_chunk: params.uploadChunk ?? null,
    p_upload_attempts: null,
  });
  if (error) {
    console.error(`complete_drive_job failed for ${jobId}: ${error.message}`);
  }
}

async function retryDriveJobSameAccount(
  admin: AdminClient,
  jobId: string,
  driveAccountId: string | null,
  driveFolderId: string | null,
  errorMessage: string,
  delaySeconds: number,
  resumeAtByte?: number | null,
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: "RETRYING",
    next_retry_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
    last_error: errorMessage.slice(0, 4000),
    updated_at: new Date().toISOString(),
  };
  if (resumeAtByte != null) {
    // Keep the persisted resumable session so the next claim resumes it.
    patch.google_drive_upload_chunk = resumeAtByte;
  }
  const { error } = await admin
    .from("replication_jobs")
    .update(patch)
    .eq("id", jobId)
    .eq("destination_type", "google_drive");
  if (error) {
    console.error(`retryDriveJobSameAccount failed for ${jobId}:`, error.message);
  }
}

/** Marks the account, gives the reservation back and moves the job to another account. */
async function accountFailover(
  admin: AdminClient,
  job: DriveJob,
  account: { id: string },
  settings: AppSettings,
  errorMessage: string,
  decision: FailureDecision,
): Promise<"RETRYING" | "FAILED"> {
  await markDriveAccountResult(admin, account.id, {
    healthStatus: decision.health ?? "degraded",
    status: decision.accountStatus ?? "error",
    lastError: errorMessage.slice(0, 500),
  }).catch(() => {});

  if (job.attempt_count >= settings.max_retry) {
    await releaseDriveQuota(admin, account.id, jobMediaBytesHint(admin, job))
      .catch(() => {});
    await completeDriveJob(admin, job.id, { status: "FAILED", error: errorMessage });
    await logSyncEvent(admin, job, "JOB_FAILED", "FAILED", { reason: errorMessage });
    return "FAILED";
  }

  await releaseDriveQuota(admin, account.id, jobMediaBytesHint(admin, job))
    .catch(() => {});

  const backoff = decision.retrySeconds ??
    computeBackoff(job, settings.retry_base_delay_seconds);
  const { error } = await admin.rpc("failover_drive_replication_job", {
    p_job_id: job.id,
    p_failed_account_id: account.id,
    p_error: errorMessage.slice(0, 4000),
    p_next_retry_at: new Date(Date.now() + backoff * 1000).toISOString(),
  });
  if (error) {
    console.error(`failover_drive_replication_job failed: ${error.message}`);
  }
  return "RETRYING";
}

/** Persists resumable progress + heartbeat while the job stays PROCESSING. */
async function persistUploadProgress(
  admin: AdminClient,
  jobId: string,
  progress: ChunkProgress,
): Promise<void> {
  const { error } = await admin
    .from("replication_jobs")
    .update({
      google_drive_upload_url: progress.uploadUrl,
      google_drive_upload_chunk: progress.bytesSent,
      started_at: new Date().toISOString(),
      last_error: "Upload in progress",
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("destination_type", "google_drive");
  if (error) {
    console.error(`persistUploadProgress failed for ${jobId}:`, error.message);
  }
}

async function clearUploadSession(
  admin: AdminClient,
  jobId: string,
): Promise<void> {
  await admin
    .from("replication_jobs")
    .update({
      google_drive_upload_url: null,
      google_drive_upload_chunk: 0,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);
}

/** Best-effort media size read for quota release during failover. */
async function jobMediaBytesHint(
  admin: AdminClient,
  job: DriveJob,
): Promise<number> {
  try {
    const { data } = await admin
      .from("media_assets")
      .select("file_size")
      .eq("id", job.media_id)
      .maybeSingle();
    return typeof (data as { file_size?: number } | null)?.file_size === "number"
      ? (data as { file_size: number }).file_size
      : 0;
  } catch {
    return 0;
  }
}

// ─── Failure classification ───────────────────────────────────────────────

type FailureDecision = {
  kind: "transient_retry" | "restart_session" | "failover" | "permanent" |
    "uncertain";
  message: string;
  retrySeconds: number | null;
  health?: "healthy" | "degraded" | "unhealthy";
  accountStatus?:
    | "active" | "quota_full" | "reauth_required" | "disabled" | "error";
};

function decideFailure(err: unknown): FailureDecision {
  const msg = ((err as Error).message ?? String(err)).slice(0, 1000);

  if (err instanceof DriveUploadUncertainError) {
    return { kind: "uncertain", message: msg, retrySeconds: 30 };
  }
  if (err instanceof DriveUploadExpiredError) {
    return { kind: "restart_session", message: msg, retrySeconds: 30 };
  }
  if (err instanceof DriveUploadError) {
    if (err.quotaExceeded) {
      return {
        kind: "failover",
        message: msg,
        retrySeconds: null,
        health: "degraded",
        accountStatus: "quota_full",
      };
    }
    if (err.status === 401 || err.status === 403) {
      return {
        kind: "failover",
        message: msg,
        retrySeconds: null,
        health: "unhealthy",
        accountStatus: "reauth_required",
      };
    }
    if (err.status === 404 || err.status === 410) {
      return { kind: "restart_session", message: msg, retrySeconds: 30 };
    }
    if (err.status === 429) {
      return {
        kind: "transient_retry",
        message: msg,
        retrySeconds: err.retryAfterSeconds ?? 60,
        health: "degraded",
      };
    }
    if (err.status >= 500) {
      return {
        kind: "transient_retry",
        message: msg,
        retrySeconds: null,
        health: "degraded",
      };
    }
    if (err.status === 400) {
      return { kind: "restart_session", message: msg, retrySeconds: 30 };
    }
    return { kind: "permanent", message: msg, retrySeconds: null };
  }

  // Non-Drive errors (Supabase lookups, folder resolution, OAuth exchange…)
  const hasHttp = /HTTP (\d{3})/.exec(msg);
  const httpStatus = hasHttp ? Number(hasHttp[1]) : 0;

  if (/refresh token|oauth|credential|no stored credentials|access token/i.test(msg)) {
    return {
      kind: "failover",
      message: msg,
      retrySeconds: null,
      health: "unhealthy",
      accountStatus: "reauth_required",
    };
  }
  if (/storage ?quota|enough storage|storageQuotaExceeded/i.test(msg)) {
    return {
      kind: "failover",
      message: msg,
      retrySeconds: null,
      health: "degraded",
      accountStatus: "quota_full",
    };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      kind: "failover",
      message: msg,
      retrySeconds: null,
      health: "unhealthy",
      accountStatus: "reauth_required",
    };
  }
  if (httpStatus >= 500) {
    return { kind: "transient_retry", message: msg, retrySeconds: null, health: "degraded" };
  }
  if (httpStatus === 429) {
    return { kind: "transient_retry", message: msg, retrySeconds: 60, health: "degraded" };
  }
  if (/cloudinary|fetch failed|timeout|abort|network|socket/i.test(msg)) {
    return { kind: "transient_retry", message: msg, retrySeconds: null };
  }
  return { kind: "transient_retry", message: msg, retrySeconds: null };
}

// ─── Observability ────────────────────────────────────────────────────────

async function logSyncEvent(
  admin: AdminClient,
  job: DriveJob,
  eventType: string,
  status: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin.from("sync_logs").insert({
    media_id: job.media_id,
    replication_job_id: job.id,
    event_type: eventType,
    status,
    message: null,
    metadata,
  });
  if (error) {
    console.error(`sync_logs insert failed (${eventType}):`, error.message);
  }
}

// ─── Naming / backoff helpers ─────────────────────────────────────────────

function driveFileName(media: MediaAsset): string {
  const raw = (media.file_name ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 180);
  const base = raw && !raw.startsWith(".") ? raw : `media_${media.id}`;
  const withExt = base.includes(".") ? base : base + extForMime(media.mime_type);
  const tag = `media_${media.id.slice(0, 8)}`; // avoids cross-upload collisions
  const dot = withExt.lastIndexOf(".");
  return dot > 0
    ? `${withExt.slice(0, dot)}_${tag}${withExt.slice(dot)}`
    : `${withExt}_${tag}`;
}

function extForMime(mime: string): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("png")) return ".png";
  if (m.includes("gif")) return ".gif";
  if (m.includes("webp")) return ".webp";
  if (m.includes("heic")) return ".heic";
  if (m.includes("heif")) return ".heif";
  if (m.includes("mp4")) return ".mp4";
  if (m.includes("quicktime")) return ".mov";
  if (m.includes("webm")) return ".webm";
  if (m.includes("bmp")) return ".bmp";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  return "";
}

function computeBackoff(job: DriveJob, baseDelaySeconds: number): number {
  const base = baseDelaySeconds ?? 60;
  return base * Math.pow(2, Math.max(0, job.attempt_count - 1));
}

// ─── Response helper ──────────────────────────────────────────────────────

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    status,
  });
}