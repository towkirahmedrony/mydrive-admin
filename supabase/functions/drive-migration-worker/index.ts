/**
 * drive-migration-worker — COPY -> DESTINATION VERIFY -> PERSIST PROVENANCE
 *
 * ⚠️  SOURCE DELETION IS DELIBERATELY ABSENT.
 *
 * This worker copies an archived file from the source Drive account to the
 * destination Drive account, verifies the destination against fresh Drive
 * metadata, and persists destination provenance alongside the untouched source
 * provenance.  It never deletes, trashes, moves, renames or modifies a source
 * file, and it never marks an item's source as deletable.
 *
 * There is no code path here that can do so: the module does not import, call
 * or reference `authorize_drive_migration_source_deletion`,
 * `mark_drive_migration_source_deleted`, `deletePartialDriveFile`, or any
 * Drive delete/trash/update endpoint.  `complete_drive_migration_item()` has no
 * parameter for `source_deletion_state`, so even a compromised call could not
 * authorise a deletion.
 *
 * SCOPE COMES FROM THE MIGRATION ROW ONLY
 *   The body carries `migration_id` and a batch `limit`.  There is no way to
 *   name a source account, destination account, media id or Google file id.
 *   The item row is authoritative, and the worker asserts that the item's
 *   source/destination accounts match the accounts it actually authenticates
 *   as before it copies anything.
 *
 * REUSED (not reimplemented): the Vault-backed accessTokenForAccount,
 * resolveUserDriveFolder / claim_drive_folder, the resumable uploader,
 * openDriveFileContent (authenticated alt=media read), verifyDriveUpload,
 * fetchDriveFileMetadata, fetchDriveAbout and findFileByName.
 */

import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getSupabaseAdmin, getSupabaseAuth } from "../_shared/auth.ts";
import {
  resolveUserDriveFolder,
  accessTokenForAccount,
} from "../_shared/drive-folders.ts";
import type { DriveAccount } from "../_shared/drive-router.ts";
import { openDriveFileContent } from "../_shared/drive-media-read.ts";
import {
  uploadChunked,
  uploadStreaming,
  type ChunkProgress,
} from "../_shared/google-drive-upload.ts";
import {
  DriveVerifyError,
  fetchDriveFileMetadata,
  verifyDriveUpload,
} from "../_shared/drive-verify.ts";
import {
  DriveAboutError,
  fetchDriveAbout,
  findFileByName,
  httpStatusFromError,
} from "../_shared/google-drive.ts";

const WORKER_VERSION = "drive-migration-worker/1.0.0";
const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 8;
const BUDGET_MS = 48_000; // inside the 60s Edge Function limit
const CHUNKED_THRESHOLD_BYTES = 20 * 1024 * 1024;
const LEASE_MINUTES = 15;

// ── types ──────────────────────────────────────────────────────────────────

type Admin = ReturnType<typeof getSupabaseAdmin>;

interface MigrationRow {
  id: string;
  status: string;
  source_drive_account_id: string;
  destination_account_ids: string[];
  total_media_count: number;
  total_expected_bytes: number;
}

interface ItemRow {
  id: string;
  migration_id: string;
  media_id: string;
  source_drive_account_id: string;
  source_drive_folder_id: string | null;
  source_google_drive_file_id: string;
  source_file_name: string;
  source_size_bytes: number;
  source_md5: string | null;
  destination_drive_account_id: string | null;
  destination_drive_folder_id: string | null;
  destination_google_drive_file_id: string | null;
  destination_file_name: string | null;
  verification_state: string;
  source_deletion_state: string;
  attempt_count: number;
}

interface Outcome {
  item_id: string;
  state: "VERIFIED" | "FAILED" | "BLOCKED";
  detail: string;
  bytes: number;
}

// ── helpers ────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function bearer(req: Request): string {
  const raw = req.headers.get("Authorization") ?? "";
  return raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : "";
}

function sha256Hex(input: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(input))
    .then((buf) =>
      Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
    );
}

/**
 * Mirrors `driveFileName()` in the deployed drive-replicate worker.
 * Kept only as a fallback: the worker prefers the source file's ACTUAL Drive
 * name so the copy is byte- and name-identical to what was archived.
 */
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

function deriveDriveFileName(media: {
  id: string;
  file_name: string;
  mime_type: string;
}): string {
  const raw = (media.file_name ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 180);
  const base = raw && !raw.startsWith(".") ? raw : `media_${media.id}`;
  const withExt = base.includes(".") ? base : base + extForMime(media.mime_type);
  const tag = `media_${media.id.slice(0, 8)}`;
  const dot = withExt.lastIndexOf(".");
  return dot > 0
    ? `${withExt.slice(0, dot)}_${tag}${withExt.slice(dot)}`
    : `${withExt}_${tag}`;
}

async function logEvent(
  admin: Admin,
  eventType: string,
  migrationId: string,
  mediaId: string | null,
  status: string,
  message: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  // Never include tokens, credentials or resumable session URLs.
  const { error } = await admin.rpc("log_drive_migration_event", {
    p_event_type: eventType,
    p_migration_id: migrationId,
    p_media_id: mediaId,
    p_status: status,
    p_message: message.slice(0, 500),
    p_metadata: metadata,
  });
  if (error) console.error(`[audit ${eventType}] ${error.message}`);
}

function backoffSeconds(attempt: number): number {
  const base = 30;
  const capped = Math.min(attempt, 8);
  return Math.min(base * Math.pow(2, Math.max(capped - 1, 0)), 3600);
}

// ── handler ────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = getSupabaseAdmin();
  const startedAt = Date.now();

  // ── authorization: admin session or internal system caller ───────────────
  const token = bearer(req);
  const systemToken = req.headers.get("X-Migration-System-Token")?.trim() ?? "";
  if (!token && !systemToken) {
    return json({ error: "Authentication required" }, 401);
  }

  let actor = "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (token && serviceKey && token === serviceKey) {
    actor = "service_role";
  } else if (token) {
    let userId: string | null = null;
    try {
      const auth = await getSupabaseAuth(req);
      userId = auth.user.id;
    } catch {
      userId = null;
    }
    if (userId) {
      const { data: profile } = await admin
        .from("profiles")
        .select("role")
        .eq("id", userId)
        .maybeSingle();
      if ((profile as { role?: string } | null)?.role === "admin") {
        actor = `admin:${userId}`;
      }
    }
  }

  // Internal path (used to drive bounded batches from SQL via pg_net).  The
  // presented value is compared against the hash of a stored refresh token, so
  // only the hash transits and no secret appears in any request queue.
  if (!actor && systemToken) {
    const { data: acct } = await admin
      .from("drive_accounts")
      .select("id, refresh_token_secret_id")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const row = acct as { id: string; refresh_token_secret_id: string | null } | null;
    if (row?.refresh_token_secret_id) {
      const { data: tok } = await admin.rpc("worker_lookup_drive_refresh_token", {
        p_secret_id: row.refresh_token_secret_id,
        p_drive_account_id: row.id,
      });
      if (typeof tok === "string" && tok.length > 0) {
        if ((await sha256Hex(tok)) === systemToken) actor = "system";
      }
    }
  }
  if (!actor) return json({ error: "Forbidden" }, 403);

  // ── body: migration_id + limit only (no account/media/file id) ──────────
  let body: { migration_id?: unknown; limit?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const migrationId = typeof body.migration_id === "string"
    ? body.migration_id.trim()
    : "";
  if (!migrationId) return json({ error: "migration_id is required" }, 400);

  const rawLimit = typeof body.limit === "number" ? body.limit : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(rawLimit)));

  // ── load the migration (the authoritative scope) ────────────────────────
  const { data: migData, error: migError } = await admin
    .from("drive_account_migrations")
    .select("*")
    .eq("id", migrationId)
    .maybeSingle();

  if (migError) return json({ error: `migration read failed: ${migError.message}` }, 500);
  const migration = migData as MigrationRow | null;
  if (!migration) return json({ error: "migration not found" }, 404);
  if (migration.status !== "RUNNING") {
    return json({
      success: false,
      migration_id: migrationId,
      status: migration.status,
      processed: 0,
      reason: "migration_not_running",
    });
  }

  const sourceAccountId = migration.source_drive_account_id;

  // ── source account must still be a valid source ─────────────────────────
  const { data: srcAcctData } = await admin
    .from("drive_accounts")
    .select("id, google_email, google_permission_id, refresh_token_secret_id, enabled")
    .eq("id", sourceAccountId)
    .maybeSingle();
  const srcAcct = srcAcctData as {
    id: string;
    google_email: string | null;
    google_permission_id: string | null;
    refresh_token_secret_id: string | null;
    enabled: boolean;
  } | null;

  if (!srcAcct?.refresh_token_secret_id) {
    return json({
      success: false,
      migration_id: migrationId,
      processed: 0,
      reason: "source_account_unavailable",
    }, 409);
  }

  // ── access tokens + API-observed identities (once per invocation) ───────
  const tokenByAccount = new Map<string, string>();
  const identityByAccount = new Map<string, string | null>();
  const accountError = new Map<string, string>();

  // The migration row is the authoritative scope — no caller-supplied ids.
  const accountIds = [
    sourceAccountId,
    ...(migration.destination_account_ids ?? []),
  ];

  for (const accountId of new Set(accountIds)) {
    try {
      const accessToken = await accessTokenForAccount(admin, accountId);
      tokenByAccount.set(accountId, accessToken);
      // Identity: observed from the API, compared against the DB record.
      const about = await fetchDriveAbout(accessToken);
      identityByAccount.set(accountId, about.email ?? null);
    } catch (err) {
      accountError.set(accountId, `credential_or_about_error_${httpStatusFromError(err)}`);
    }
  }

  // ── source folder names, for exact structure preservation ───────────────
  const { data: srcFolders } = await admin
    .from("drive_folders")
    .select("id, folder_name, folder_type, owner_id, google_folder_id")
    .eq("drive_account_id", sourceAccountId);
  const folderById = new Map(
    ((srcFolders ?? []) as Array<{
      id: string;
      folder_name: string;
      folder_type: string;
      owner_id: string | null;
      google_folder_id: string | null;
    }>).map((f) => [f.id, f]),
  );
  const sourceRootName = ((srcFolders ?? []) as Array<{ folder_type: string; folder_name: string }>)
    .find((f) => f.folder_type === "root")?.folder_name ?? "MyDrive Archive";

  // ── source account identity, observed from the API (once per invocation) ─
  const srcObservedEmail = identityByAccount.get(sourceAccountId) ?? null;
  if (!srcObservedEmail ||
      (srcAcct.google_email && srcObservedEmail !== srcAcct.google_email)) {
    return json({
      success: false,
      migration_id: migrationId,
      processed: 0,
      reason: "source_account_identity_mismatch",
      observed_email: srcObservedEmail,
    }, 409);
  }

  const results: Outcome[] = [];
  let copied = 0;
  let verified = 0;
  let failed = 0;
  let blocked = 0;
  let bytesCopied = 0;
  let bytesVerified = 0;

  // ── bounded batch loop (sequential: concurrency 1) ──────────────────────
  while (results.length < limit && Date.now() - startedAt < BUDGET_MS) {
    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_drive_migration_item",
      {
        p_migration_id: migrationId,
        p_worker_owner: `${WORKER_VERSION}:${actor}`.slice(0, 100),
        p_lease_minutes: LEASE_MINUTES,
      },
    );

    if (claimError) {
      return json({ error: `claim failed: ${claimError.message}` }, 500);
    }
    const item = (claimed as ItemRow[] | null)?.[0];
    if (!item) break; // nothing claimable → batch complete

    const outcome = await processItem(admin, migration, item, {
      tokenByAccount,
      identityByAccount,
      accountError,
      folderById,
      sourceRootName,
    });

    results.push(outcome);
    if (outcome.state === "VERIFIED") {
      verified++;
      bytesVerified += outcome.bytes;
      copied++;
      bytesCopied += outcome.bytes;
    } else if (outcome.state === "FAILED") {
      failed++;
    } else if (outcome.state === "BLOCKED") {
      blocked++;
    }
  }

  // ── counters + completion attempt (never marks an unverified item done) ──
  await admin.rpc("refresh_drive_account_migration_counters", {
    p_migration_id: migrationId,
  });
  const { data: finData } = await admin.rpc("finalize_drive_account_migration", {
    p_migration_id: migrationId,
  });

  const { data: progress } = await admin.rpc("drive_migration_progress", {
    p_migration_id: migrationId,
  });

  return json({
    success: true,
    worker_version: WORKER_VERSION,
    actor,
    migration_id: migrationId,
    processed: results.length,
    copied,
    destination_verified: verified,
    failed,
    blocked,
    bytes_copied: bytesCopied,
    bytes_destination_verified: bytesVerified,
    duration_ms: Date.now() - startedAt,
    account_errors: Object.fromEntries(accountError),
    finalize: finData,
    progress,
    source_deletion: "NOT_PERFORMED — source files are left untouched by design",
    results,
  });
});

// ── per-item processing ────────────────────────────────────────────────────

async function processItem(
  admin: Admin,
  migration: MigrationRow,
  item: ItemRow,
  ctx: {
    tokenByAccount: Map<string, string>;
    identityByAccount: Map<string, string | null>;
    accountError: Map<string, string>;
    folderById: Map<string, { folder_name: string; folder_type: string; owner_id: string | null; google_folder_id: string | null }>;
    sourceRootName: string;
  },
): Promise<Outcome> {
  const bytes = item.source_size_bytes;
  const fail = async (
    state: "FAILED" | "BLOCKED",
    detail: string,
    eventType: string,
    extra: Record<string, unknown> = {},
  ): Promise<Outcome> => {
    await admin.rpc("complete_drive_migration_item", {
      p_item_id: item.id,
      p_verification_state: state,
      p_last_error: detail,
      p_next_retry_at: state === "FAILED"
        ? new Date(Date.now() + backoffSeconds(item.attempt_count) * 1000).toISOString()
        : null,
    });
    await logEvent(admin, eventType, migration.id, item.media_id, "FAILED", detail, {
      item_id: item.id,
      attempt_count: item.attempt_count,
      verification_state: state,
      ...extra,
    });
    return { item_id: item.id, state, detail, bytes };
  };

  // ── scope assertions: the item must agree with the migration ────────────
  if (item.source_drive_account_id !== migration.source_drive_account_id) {
    return fail("BLOCKED", "item_source_account_differs_from_migration", "DRIVE_MIGRATION_COPY_FAILED");
  }
  const destAccountId = item.destination_drive_account_id;
  if (!destAccountId) {
    return fail("BLOCKED", "item_has_no_destination_account", "DRIVE_MIGRATION_COPY_FAILED");
  }
  if (destAccountId === item.source_drive_account_id) {
    return fail("BLOCKED", "destination_equals_source", "DRIVE_MIGRATION_COPY_FAILED");
  }

  const srcToken = ctx.tokenByAccount.get(item.source_drive_account_id);
  const dstToken = ctx.tokenByAccount.get(destAccountId);
  if (!srcToken) {
    return fail(
      "FAILED",
      ctx.accountError.get(item.source_drive_account_id) ?? "source_credential_unavailable",
      "DRIVE_MIGRATION_COPY_FAILED",
    );
  }
  if (!dstToken) {
    return fail(
      "FAILED",
      ctx.accountError.get(destAccountId) ?? "destination_credential_unavailable",
      "DRIVE_MIGRATION_COPY_FAILED",
    );
  }

  // ── destination account identity (from the API, not the DB alone) ────────
  const { data: dstAcctData } = await admin
    .from("drive_accounts")
    .select("*")
    .eq("id", destAccountId)
    .maybeSingle();
  // Full row: structurally a DriveAccount (needed by resolveUserDriveFolder),
  // plus the identity column used for the API-observed check.
  const dstAcct = dstAcctData as
    (DriveAccount & { google_permission_id: string | null }) | null;
  const observedEmail = ctx.identityByAccount.get(destAccountId) ?? null;
  if (!dstAcct || !observedEmail || (dstAcct.google_email && observedEmail !== dstAcct.google_email)) {
    return fail(
      "BLOCKED",
      "destination_account_identity_mismatch",
      "DRIVE_MIGRATION_COPY_FAILED",
      { observed_email: observedEmail ?? null },
    );
  }

  // ── source metadata: integrity precondition for the copy ────────────────
  let srcMeta;
  try {
    srcMeta = await fetchDriveFileMetadata({
      accessToken: srcToken,
      fileId: item.source_google_drive_file_id,
    });
  } catch (err) {
    const status = err instanceof DriveVerifyError ? err.status : httpStatusFromError(err);
    return fail(
      "FAILED",
      `source_metadata_unavailable_status_${status}`,
      "DRIVE_MIGRATION_COPY_FAILED",
    );
  }

  const sourceFolderGoogleId = item.source_drive_folder_id
    ? ctx.folderById.get(item.source_drive_folder_id)?.google_folder_id ?? null
    : null;

  if (srcMeta.trashed) {
    return fail("BLOCKED", "source_file_is_trashed", "DRIVE_MIGRATION_COPY_FAILED");
  }
  if (sourceFolderGoogleId && !srcMeta.parents.includes(sourceFolderGoogleId)) {
    return fail("BLOCKED", "source_file_not_in_expected_source_folder", "DRIVE_MIGRATION_COPY_FAILED", {
      source_parents: srcMeta.parents,
    });
  }
  const srcSize = srcMeta.size === null ? null : Number(srcMeta.size);
  if (srcSize !== null && srcSize !== item.source_size_bytes) {
    return fail("BLOCKED", "source_size_changed_since_baseline", "DRIVE_MIGRATION_COPY_FAILED", {
      source_size_now: srcSize,
      source_size_expected: item.source_size_bytes,
    });
  }
  if (item.source_md5 && srcMeta.md5Checksum && srcMeta.md5Checksum !== item.source_md5) {
    return fail("BLOCKED", "source_md5_changed_since_baseline", "DRIVE_MIGRATION_COPY_FAILED");
  }

  const destinationName = srcMeta.name ?? item.source_file_name;
  const expectedMd5 = srcMeta.md5Checksum ?? item.source_md5;

  // ── destination folder (deterministic, reuse existing mechanism) ────────
  const srcFolder = item.source_drive_folder_id
    ? ctx.folderById.get(item.source_drive_folder_id)
    : undefined;

  let destFolderRowId: string | null = item.destination_drive_folder_id;
  let destFolderGoogleId: string | null = null;

  if (destFolderRowId) {
    const { data: f } = await admin
      .from("drive_folders")
      .select("id, google_folder_id, folder_status")
      .eq("id", destFolderRowId)
      .maybeSingle();
    destFolderGoogleId =
      (f as { google_folder_id: string | null } | null)?.google_folder_id ?? null;
  }

  if (!destFolderGoogleId) {
    try {
      // The folder mapping is keyed on (account, folder_type, owner_id), so the
      // owner must be known — otherwise the destination folder is ambiguous and
      // we refuse rather than guess.
      const ownerId = srcFolder?.owner_id ?? null;
      if (!ownerId) {
        return fail(
          "BLOCKED",
          "source_folder_owner_unknown",
          "DRIVE_MIGRATION_COPY_FAILED",
        );
      }

      const resolved = await resolveUserDriveFolder(
        admin,
        dstAcct,
        ownerId,
        {
          folderName: srcFolder?.folder_name ?? "dest",
          // mirror the SOURCE root folder name so the hierarchy is identical
          rootFolderName: ctx.sourceRootName,
        },
      );
      if (!resolved?.google_folder_id) {
        return fail("FAILED", "destination_folder_not_ready", "DRIVE_MIGRATION_COPY_FAILED");
      }
      destFolderRowId = resolved.id;
      destFolderGoogleId = resolved.google_folder_id;
    } catch (err) {
      return fail(
        "FAILED",
        `destination_folder_error_${httpStatusFromError(err)}`,
        "DRIVE_MIGRATION_COPY_FAILED",
      );
    }
  }

  // ── copy (skip when the bytes are already known to be at the destination) ─
  let destFileId = item.destination_google_drive_file_id;

  if (!destFileId) {
    // Reconciliation first: a previous run may have uploaded the file and died
    // before persisting the id.  Adopt the existing object instead of creating
    // a second copy.
    try {
      const existing = await findFileByName(destinationName, destFolderGoogleId, dstToken);
      if (existing) {
        destFileId = existing;
        await admin.rpc("complete_drive_migration_item", {
          p_item_id: item.id,
          p_verification_state: "COPIED",
          p_destination_drive_account_id: destAccountId,
          p_destination_drive_folder_id: destFolderRowId,
          p_destination_google_drive_file_id: existing,
          p_destination_file_name: destinationName,
        });
        await logEvent(
          admin, "DRIVE_MIGRATION_COPY_COMPLETED", migration.id, item.media_id, "OK",
          "adopted an existing destination object (crash reconciliation)",
          { item_id: item.id, destination_google_drive_file_id: existing, adopted: true },
        );
      }
    } catch {
      // lookup failure is not fatal — fall through to a normal upload attempt
    }
  }

  if (!destFileId) {
    await logEvent(
      admin, "DRIVE_MIGRATION_COPY_STARTED", migration.id, item.media_id, "PROCESSING",
      "copying source bytes to destination account",
      {
        item_id: item.id,
        source_drive_account_id: item.source_drive_account_id,
        destination_drive_account_id: destAccountId,
        source_google_drive_file_id: item.source_google_drive_file_id,
        file_name: destinationName,
        file_size: bytes,
        mode: bytes <= CHUNKED_THRESHOLD_BYTES ? "streaming" : "chunked_resumable",
        attempt_count: item.attempt_count,
        // Durable evidence that the SOURCE was intact at copy time: after this
        // point the worker only reads it again, never writes it.
        source_observed: {
          name: srcMeta.name,
          size: srcMeta.size,
          md5: srcMeta.md5Checksum,
          parents: srcMeta.parents,
          trashed: srcMeta.trashed,
        },
        source_mutated: false,
      },
    );

    const openSource = () =>
      openDriveFileContent({
        accessToken: srcToken,
        fileId: item.source_google_drive_file_id,
      });

    const description =
      `MyDrive archive migration\nmedia_id: ${item.media_id}\nsource_file: ${item.source_google_drive_file_id}`.slice(0, 500);

    try {
      if (bytes <= CHUNKED_THRESHOLD_BYTES) {
        destFileId = await uploadStreaming({
          accessToken: dstToken,
          openSource,
          fileName: destinationName,
          mimeType: srcMeta.mimeType ?? "application/octet-stream",
          parentFolderId: destFolderGoogleId,
          fileSize: bytes,
          description,
        });
      } else {
        let lastProgress: ChunkProgress | null = null;
        const res = await uploadChunked(
          {
            accessToken: dstToken,
            openSource,
            fileName: destinationName,
            mimeType: srcMeta.mimeType ?? "application/octet-stream",
            parentFolderId: destFolderGoogleId,
            fileSize: bytes,
            description,
            chunkCloseMs: 45_000,
          },
          async (progress) => {
            lastProgress = progress; // session URI deliberately NOT logged
          },
        );
        destFileId = res.fileId;
        void lastProgress;
      }
    } catch (err) {
      const status = httpStatusFromError(err);
      const uncertain = (err as Error).name === "DriveUploadUncertainError";
      return fail(
        uncertain ? "FAILED" : "FAILED",
        uncertain
          ? "destination_upload_uncertain"
          : `destination_upload_failed_status_${status}`,
        "DRIVE_MIGRATION_COPY_FAILED",
      );
    }

    // Persist the id IMMEDIATELY, so a crash after this point cannot cause a
    // second upload (the reconciliation lookup would also catch it).
    await admin.rpc("complete_drive_migration_item", {
      p_item_id: item.id,
      p_verification_state: "COPIED",
      p_destination_drive_account_id: destAccountId,
      p_destination_drive_folder_id: destFolderRowId,
      p_destination_google_drive_file_id: destFileId,
      p_destination_file_name: destinationName,
      p_destination_size_bytes: bytes,
    });

    await logEvent(
      admin, "DRIVE_MIGRATION_COPY_COMPLETED", migration.id, item.media_id, "OK",
      "destination upload completed",
      { item_id: item.id, destination_google_drive_file_id: destFileId, file_size: bytes },
    );
  }

  // ── fresh destination verification (a 2xx upload response is NOT enough) ──
  try {
    const verification = await verifyDriveUpload({
      accessToken: dstToken,
      fileId: destFileId,
      expectedName: destinationName,
      expectedParentId: destFolderGoogleId,
      expectedSize: bytes,
      expectedMd5: expectedMd5 || null,
    });

    await admin.rpc("complete_drive_migration_item", {
      p_item_id: item.id,
      p_verification_state: "VERIFIED",
      p_destination_drive_account_id: destAccountId,
      p_destination_drive_folder_id: destFolderRowId,
      p_destination_google_drive_file_id: destFileId,
      p_destination_file_name: verification.file.name ?? destinationName,
      p_destination_size_bytes: verification.sizeBytes,
      p_destination_md5: verification.md5Checksum,
    });

    await logEvent(
      admin, "DRIVE_MIGRATION_DESTINATION_VERIFIED", migration.id, item.media_id, "OK",
      "destination verified against fresh Drive metadata",
      {
        item_id: item.id,
        destination_google_drive_file_id: destFileId,
        destination_account_id: destAccountId,
        destination_folder_id: destFolderGoogleId,
        destination_file_name: verification.file.name,
        destination_size_bytes: verification.sizeBytes,
        destination_md5: verification.md5Checksum,
        source_md5: expectedMd5,
        checks: verification.checks,
        source_preserved: true,
      },
    );

    return { item_id: item.id, state: "VERIFIED", detail: "verified", bytes };
  } catch (err) {
    const status = err instanceof DriveVerifyError ? err.status : httpStatusFromError(err);
    const provablyWrong = err instanceof DriveVerifyError ? err.mismatch === true : false;
    const retryable = err instanceof DriveVerifyError ? err.retryable === true : true;

    await logEvent(
      admin, "DRIVE_MIGRATION_DESTINATION_VERIFICATION_FAILED", migration.id, item.media_id,
      "FAILED", "destination verification failed",
      {
        item_id: item.id,
        destination_google_drive_file_id: destFileId,
        status,
        provably_wrong: provablyWrong,
        destination_preserved: true,
        note: "destination object is NOT deleted; no second copy is created",
      },
    );

    // A provable mismatch (wrong name/size/md5/folder, trashed) cannot be fixed
    // by retrying, and re-uploading would create a duplicate — so it stops for
    // a human decision.  Anything transient stays retryable.
    return fail(
      provablyWrong || !retryable ? "BLOCKED" : "FAILED",
      `destination_verification_failed_status_${status}`,
      "DRIVE_MIGRATION_DESTINATION_VERIFICATION_FAILED",
      { destination_google_drive_file_id: destFileId },
    );
  }
}
