/**
 * drive-migration-source-delete — per-file, FAIL-CLOSED source deletion.
 *
 * Deletes the SOURCE Drive file of one migration item at a time, but only after
 * the destination has been proven good by a FRESH read AND the source itself has
 * been proven to still be exactly the recorded original.
 *
 * Strict sequence per item — any failure stops the whole run:
 *
 *   1  load the authoritative item (scope comes from the migration, not a caller)
 *   2  prove both account identities from the live API
 *   3  FRESH source read     — must still be the recorded original
 *   4  FRESH destination read — must be the verified copy, untrashed
 *   5  existing authorisation RPC with the fresh evidence
 *   6  DELETE that one source file (existing `DELETE /files/{id}` semantics)
 *   7  FRESH source read     — must now be gone, or it is NOT marked deleted
 *   8  FRESH destination read — must be unchanged after the deletion
 *   9  record SOURCE_DELETED + audit
 *
 * IT NEVER TOUCHES THE DESTINATION.  The only destructive call is
 * `files.delete` on the item's own source file id.  There is no bulk loop, no
 * hard-coded count, no "delete all" path and no bypass of the SQL gate — the
 * gate is called and can refuse.
 *
 * CRASH RECOVERY.  If the source is already missing on the FIRST read:
 *   * and the item was already authorised (SOURCE_DELETE_PENDING) → this is a
 *     previous run that died after Google deleted but before the DB was
 *     updated.  The destination and the recorded provenance are re-verified; if
 *     they hold, the item is reconciled to SOURCE_DELETED without any second
 *     deletion.
 *   * and the item was NOT authorised → the source disappeared unexpectedly.
 *     That is an anomaly: the item is marked FAILED and the run stops.
 */

import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getSupabaseAdmin, getSupabaseAuth } from "../_shared/auth.ts";
import { accessTokenForAccount } from "../_shared/drive-folders.ts";
import { fetchDriveFileMetadata } from "../_shared/drive-verify.ts";
import { deletePartialDriveFile } from "../_shared/google-drive-upload.ts";
import { DriveAboutError, httpStatusFromError } from "../_shared/google-drive.ts";

const WORKER_VERSION = "drive-migration-source-delete/1.0.0";
const DEFAULT_LIMIT = 1;
const MAX_LIMIT = 8;
const BUDGET_MS = 45_000;

type Admin = ReturnType<typeof getSupabaseAdmin>;

interface ItemRow {
  id: string;
  migration_id: string;
  media_id: string;
  source_drive_account_id: string;
  source_drive_folder_id: string | null;
  source_google_drive_file_id: string;
  source_size_bytes: number;
  source_md5: string | null;
  destination_drive_account_id: string | null;
  destination_drive_folder_id: string | null;
  destination_google_drive_file_id: string | null;
  destination_file_name: string | null;
  destination_size_bytes: number | null;
  destination_md5: string | null;
  verification_state: string;
  source_deletion_state: string;
}

interface Ctx {
  srcToken: string;
  dstToken: string;
  srcFolderGoogleId: string | null;
  dstFolderGoogleId: string | null;
  srcIdentityMatched: boolean;
  dstIdentityMatched: boolean;
}

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
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
    .then((b) =>
      Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("")
    );
}

/**
 * Account identity, read from the live API.
 *
 * Uses `about.get` directly (rather than the shared `fetchDriveAbout`, whose
 * field list omits `permissionId`) so the stable `permissionId` can be asserted
 * against `drive_accounts.google_permission_id` where that column is populated.
 */
async function fetchIdentity(accessToken: string): Promise<{
  email: string | null;
  permissionId: string | null;
}> {
  const url = new URL("https://www.googleapis.com/drive/v3/about");
  url.searchParams.set("fields", "user(permissionId,emailAddress)");

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new DriveAboutError(`about transport failure: ${(err as Error).name}`, 0);
  }
  if (!res.ok) throw new DriveAboutError(`about HTTP ${res.status}`, res.status);

  const body = await res.json() as {
    user?: { permissionId?: string; emailAddress?: string };
  };
  return {
    email: body.user?.emailAddress?.trim() ?? null,
    permissionId: body.user?.permissionId?.trim() ?? null,
  };
}

/** Observed metadata for one side, shaped for the SQL gate's evidence param. */
function side(
  m: { id: string; name: string | null; size: string | null; md5Checksum: string | null; trashed: boolean },
  identityMatched: boolean,
) {
  return {
    file_id: m.id,
    name: m.name,
    size: m.size,
    md5: m.md5Checksum,
    trashed: m.trashed,
    account_identity_matched: identityMatched,
  };
}

async function logEvent(
  admin: Admin, eventType: string, migrationId: string, mediaId: string,
  status: string, message: string, metadata: Record<string, unknown>,
): Promise<void> {
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

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = getSupabaseAdmin();
  const startedAt = Date.now();

  // ── authorization: admin session or internal system caller ───────────────
  const token = bearer(req);
  const systemToken = req.headers.get("X-Migration-System-Token")?.trim() ?? "";
  if (!token && !systemToken) return json({ error: "Authentication required" }, 401);

  let actor = "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (token && serviceKey && token === serviceKey) {
    actor = "service_role";
  } else if (token) {
    try {
      const auth = await getSupabaseAuth(req);
      const { data: p } = await admin
        .from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
      if ((p as { role?: string } | null)?.role === "admin") actor = `admin:${auth.user.id}`;
    } catch { /* not an admin session */ }
  }
  if (!actor && systemToken) {
    const { data: a } = await admin
      .from("drive_accounts").select("id, refresh_token_secret_id")
      .order("created_at", { ascending: true }).limit(1).maybeSingle();
    const row = a as { id: string; refresh_token_secret_id: string | null } | null;
    if (row?.refresh_token_secret_id) {
      const { data: tok } = await admin.rpc("worker_lookup_drive_refresh_token", {
        p_secret_id: row.refresh_token_secret_id, p_drive_account_id: row.id,
      });
      if (typeof tok === "string" && tok.length > 0 &&
          (await sha256Hex(tok)) === systemToken) actor = "system";
    }
  }
  if (!actor) return json({ error: "Forbidden" }, 403);

  // ── body: migration_id + limit only ─────────────────────────────────────
  let body: { migration_id?: unknown; limit?: unknown } = {};
  try { body = await req.json(); } catch { body = {}; }
  const migrationId = typeof body.migration_id === "string" ? body.migration_id.trim() : "";
  if (!migrationId) return json({ error: "migration_id is required" }, 400);
  const limit = Math.max(1, Math.min(MAX_LIMIT,
    typeof body.limit === "number" ? Math.trunc(body.limit) : DEFAULT_LIMIT));

  // ── the migration must be COMPLETED (gate re-checks this too) ───────────
  const { data: migData } = await admin
    .from("drive_account_migrations")
    .select("id, status, source_drive_account_id, total_expected_bytes")
    .eq("id", migrationId).maybeSingle();
  const migration = migData as
    { id: string; status: string; source_drive_account_id: string } | null;
  if (!migration) return json({ error: "migration not found" }, 404);
  if (migration.status !== "COMPLETED") {
    return json({
      success: false, migration_id: migrationId, status: migration.status,
      deleted: 0, reason: "migration_not_completed",
    }, 409);
  }

  const sourceAccountId = migration.source_drive_account_id;

  // ── account identities from the live API ────────────────────────────────
  const { data: firstItem } = await admin
    .from("drive_account_migration_items")
    .select("destination_drive_account_id")
    .eq("migration_id", migrationId)
    .not("destination_drive_account_id", "is", null)
    .limit(1)
    .maybeSingle();

  const destAccountId =
    (firstItem as { destination_drive_account_id: string | null } | null)
      ?.destination_drive_account_id ?? null;
  if (!destAccountId) {
    return json({
      success: false, migration_id: migrationId, deleted: 0,
      reason: "destination_account_not_recorded",
    }, 409);
  }
  if (destAccountId === sourceAccountId) {
    return json({
      success: false, migration_id: migrationId, deleted: 0,
      reason: "destination_equals_source_account",
    }, 409);
  }

  const { data: acctRows } = await admin
    .from("drive_accounts")
    .select("id, google_email, google_permission_id, refresh_token_secret_id")
    .in("id", [sourceAccountId, destAccountId]);

  const accounts = (acctRows ?? []) as Array<{
    id: string; google_email: string | null; google_permission_id: string | null;
    refresh_token_secret_id: string | null;
  }>;

  const tokenByAccount = new Map<string, string>();
  const identityByAccount = new Map<string, { email: string | null; permissionId: string | null }>();
  const accountErrors = new Map<string, string>();

  for (const acct of accounts) {
    try {
      const t = await accessTokenForAccount(admin, acct.id);
      tokenByAccount.set(acct.id, t);
      identityByAccount.set(acct.id, await fetchIdentity(t));
    } catch (err) {
      accountErrors.set(acct.id, `credential_or_about_error_${httpStatusFromError(err)}`);
    }
  }

  const identityMatches = (acctId: string): boolean => {
    const acct = accounts.find((a) => a.id === acctId);
    const obs = identityByAccount.get(acctId);
    if (!acct || !obs || !obs.email) return false;
    if (acct.google_email && obs.email !== acct.google_email) return false;
    if (acct.google_permission_id && obs.permissionId !== acct.google_permission_id) return false;
    return true;
  };

  const srcToken = tokenByAccount.get(sourceAccountId);
  const dstToken = destAccountId ? tokenByAccount.get(destAccountId) : undefined;
  if (!srcToken || !dstToken) {
    return json({
      success: false, migration_id: migrationId, deleted: 0,
      reason: "account_unavailable",
      account_errors: Object.fromEntries(accountErrors),
    }, 409);
  }

  // ── folder google ids ───────────────────────────────────────────────────
  const { data: folderRows } = await admin
    .from("drive_folders").select("id, google_folder_id")
    .in("drive_account_id", [sourceAccountId, destAccountId]);
  const folderGoogle = new Map<string, string | null>(
    (folderRows ?? []).map((f: { id: string; google_folder_id: string | null }) =>
      [f.id, f.google_folder_id] as const),
  );

  // ── candidate items, deterministic order, strictly sequential ───────────
  const { data: itemRows, error: itemError } = await admin
    .from("drive_account_migration_items")
    .select(
      "id, migration_id, media_id, source_drive_account_id, source_drive_folder_id, source_google_drive_file_id, source_size_bytes, source_md5, destination_drive_account_id, destination_drive_folder_id, destination_google_drive_file_id, destination_file_name, destination_size_bytes, destination_md5, verification_state, source_deletion_state",
    )
    .eq("migration_id", migrationId)
    .neq("source_deletion_state", "SOURCE_DELETED")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit);

  if (itemError) return json({ error: `item read failed: ${itemError.message}` }, 500);
  const items = (itemRows ?? []) as ItemRow[];

  const results: unknown[] = [];
  let deleted = 0;
  let reconciled = 0;
  let stopped = false;
  let stopReason: string | null = null;
  let destinationRebytes = 0;

  for (const item of items) {
    if (Date.now() - startedAt > BUDGET_MS) {
      stopReason = "time_budget_reached";
      break;
    }

    const ctx: Ctx = {
      srcToken,
      dstToken,
      srcFolderGoogleId: item.source_drive_folder_id
        ? folderGoogle.get(item.source_drive_folder_id) ?? null : null,
      dstFolderGoogleId: item.destination_drive_folder_id
        ? folderGoogle.get(item.destination_drive_folder_id) ?? null : null,
      srcIdentityMatched: identityMatches(item.source_drive_account_id),
      dstIdentityMatched: destAccountId ? identityMatches(destAccountId) : false,
    };

    const r = await processItem(admin, migrationId, item, ctx);
    results.push(r);

    if (r.outcome === "SOURCE_DELETED") { deleted++; destinationRebytes += r.bytes ?? 0; }
    else if (r.outcome === "RECONCILED") { reconciled++; }
    else {
      // FAIL-CLOSED: stop the entire run on the first anomaly.
      stopped = true;
      stopReason = r.reason ?? "unspecified";
      break;
    }
  }

  return json({
    success: true,
    worker_version: WORKER_VERSION,
    actor,
    migration_id: migrationId,
    migration_status: migration.status,
    candidates: items.length,
    source_files_deleted: deleted,
    crash_recovery_reconciliations: reconciled,
    destination_verified_bytes_after_delete: destinationRebytes,
    stopped_on_anomaly: stopped,
    stop_reason: stopReason,
    account_errors: Object.fromEntries(accountErrors),
    results,
  });
});

// ── per-item sequence ──────────────────────────────────────────────────────

async function processItem(
  admin: Admin,
  migrationId: string,
  item: ItemRow,
  ctx: Ctx,
): Promise<{
  item_id: string;
  media_id: string;
  outcome: "SOURCE_DELETED" | "RECONCILED" | "FAILED";
  reason?: string;
  bytes?: number;
  crash_recovery?: boolean;
}> {
  const srcId = item.source_google_drive_file_id;
  const dstId = item.destination_google_drive_file_id;

  const fail = async (reason: string, extra: Record<string, unknown> = {}) => {
    await admin.rpc("fail_drive_migration_source_deletion", {
      p_item_id: item.id, p_reason: reason,
    });
    await logEvent(admin, "DRIVE_MIGRATION_COPY_FAILED", migrationId, item.media_id,
      "FAILED", `source deletion blocked: ${reason}`,
      { item_id: item.id, phase: "source_deletion", reason, source_preserved: true, ...extra });
    return { item_id: item.id, media_id: item.media_id, outcome: "FAILED" as const, reason };
  };

  // ── scope assertions ───────────────────────────────────────────────────
  if (item.verification_state !== "VERIFIED") {
    return fail("item_not_destination_verified");
  }
  if (!dstId) return fail("destination_file_id_missing");
  if (!item.source_drive_account_id || !item.destination_drive_account_id) {
    return fail("account_provenance_missing");
  }
  if (item.destination_drive_account_id === item.source_drive_account_id) {
    return fail("destination_equals_source_account");
  }
  if (!ctx.srcIdentityMatched || !ctx.dstIdentityMatched) {
    return fail("account_identity_unproven_for_source_deletion");
  }

  // ── FRESH source read ──────────────────────────────────────────────────
  const alreadyAuthorised = item.source_deletion_state === "SOURCE_DELETE_PENDING";
  let srcMissing = false;
  let srcMeta: Awaited<ReturnType<typeof fetchDriveFileMetadata>> | null = null;

  try {
    srcMeta = await fetchDriveFileMetadata({ accessToken: ctx.srcToken, fileId: srcId });
  } catch (err) {
    const status = httpStatusFromError(err);
    if (status === 404 || status === 410) {
      srcMissing = true;
    } else {
      return fail(`source_metadata_unavailable_status_${status}`);
    }
  }

  if (srcMissing && !alreadyAuthorised) {
    // The source vanished without ever being authorised for deletion.
    return fail("source_missing_without_authorisation");
  }

  // ── FRESH destination read (both paths need it) ────────────────────────
  let dstMeta: Awaited<ReturnType<typeof fetchDriveFileMetadata>>;
  try {
    dstMeta = await fetchDriveFileMetadata({ accessToken: ctx.dstToken, fileId: dstId });
  } catch (err) {
    const status = httpStatusFromError(err);
    return fail(`destination_metadata_unavailable_status_${status}`);
  }

  const dstSizeOk = dstMeta.size !== null && Number(dstMeta.size) === item.source_size_bytes;
  const dstMd5Ok = !!item.source_md5 && dstMeta.md5Checksum === item.source_md5;
  const dstNameOk = !!item.destination_file_name &&
                    dstMeta.name === item.destination_file_name;
  const dstFolderOk = !ctx.dstFolderGoogleId ||
                      dstMeta.parents.includes(ctx.dstFolderGoogleId);
  const dstNotTrashed = dstMeta.trashed !== true;
  const dstIdOk = dstMeta.id === dstId;

  if (!dstNotTrashed) return fail("destination_trashed_before_source_deletion");
  if (!dstIdOk) return fail("destination_file_id_mismatch_before_source_deletion");
  if (!dstSizeOk) return fail("destination_size_mismatch_before_source_deletion");
  if (!dstMd5Ok) return fail("destination_md5_mismatch_before_source_deletion");
  if (!dstNameOk) return fail("destination_name_mismatch_before_source_deletion");
  if (!dstFolderOk) return fail("destination_folder_mismatch_before_source_deletion");

  // ── crash recovery: source already gone, but it WAS authorised ─────────
  if (srcMissing && alreadyAuthorised) {
    const recordedOk = await admin.rpc("mark_drive_migration_source_deleted", {
      p_item_id: item.id,
    });
    const recorded =
      (recordedOk.data as { recorded?: boolean } | null)?.recorded === true;
    if (!recorded) return fail("crash_recovery_persistence_failed");

    await logEvent(admin, "DRIVE_MIGRATION_SOURCE_DELETE_COMPLETED", migrationId,
      item.media_id, "OK",
      "adopted a source deletion performed by an earlier run (crash recovery)",
      {
        item_id: item.id, crash_recovery: true,
        destination_google_drive_file_id: dstId,
        destination_md5: dstMeta.md5Checksum,
        destination_verified_after: true,
      });
    return { item_id: item.id, media_id: item.media_id, outcome: "RECONCILED",
             crash_recovery: true, bytes: item.source_size_bytes };
  }

  // ── source is present: it must still be the recorded original ──────────
  if (!srcMeta) return fail("source_metadata_unavailable");
  if (srcMeta.trashed) return fail("source_trashed_before_deletion");
  const srcSizeOk = srcMeta.size !== null && Number(srcMeta.size) === item.source_size_bytes;
  const srcMd5Ok = !!item.source_md5 && srcMeta.md5Checksum === item.source_md5;
  const srcNameOk = srcMeta.name === item.destination_file_name;
  const srcFolderOk = !ctx.srcFolderGoogleId ||
                      srcMeta.parents.includes(ctx.srcFolderGoogleId);
  const srcIdOk = srcMeta.id === srcId;

  if (!srcIdOk) return fail("source_file_id_mismatch");
  if (srcId === dstId) return fail("source_and_destination_file_id_identical");
  if (!srcSizeOk) return fail("source_size_changed_since_baseline");
  if (!srcMd5Ok) return fail("source_md5_changed_since_baseline");
  if (!srcNameOk) return fail("source_name_mismatch");
  if (!srcFolderOk) return fail("source_folder_mismatch");

  // ── existing authorisation mechanism, with the fresh evidence ──────────
  const evidence = {
    source: side(srcMeta, ctx.srcIdentityMatched),
    destination: side(dstMeta, ctx.dstIdentityMatched),
    observed_at: new Date().toISOString(),
    verifier_version: WORKER_VERSION,
  };

  const authRes = await admin.rpc("authorize_drive_migration_source_deletion", {
    p_item_id: item.id,
    p_evidence: evidence,
  });
  const auth = authRes.data as
    { authorized?: boolean; reasons?: unknown; checks?: unknown } | null;

  if (!auth?.authorized) {
    return fail("authorization_refused", { authorization: auth });
  }

  await logEvent(admin, "DRIVE_MIGRATION_SOURCE_DELETE_AUTHORISED", migrationId,
    item.media_id, "OK", "source deletion authorised after fresh dual-side verification",
    {
      item_id: item.id,
      source_google_drive_file_id: srcId,
      destination_google_drive_file_id: dstId,
      source_md5: srcMeta.md5Checksum,
      destination_md5: dstMeta.md5Checksum,
      already_authorized: (auth as { already_authorized?: boolean }).already_authorized ?? false,
    });

  // ── DELETE exactly this one source file (permanent, 404 tolerated) ─────
  try {
    await deletePartialDriveFile(srcId, ctx.srcToken);
  } catch (err) {
    return fail(`source_delete_request_failed_status_${httpStatusFromError(err)}`);
  }

  // ── post-delete FRESH source read: it must now be gone ────────────────
  try {
    const still = await fetchDriveFileMetadata({ accessToken: ctx.srcToken, fileId: srcId });
    // Still readable ⇒ the deletion did NOT take effect.
    if (still.trashed) {
      return fail("source_only_trashed_not_deleted");
    }
    return fail("source_still_present_after_delete");
  } catch (err) {
    const status = httpStatusFromError(err);
    if (status !== 404 && status !== 410) {
      return fail(`source_delete_confirmation_read_error_status_${status}`);
    }
    // 404/410 = confirmed gone by the intended (permanent) semantics.
  }

  // ── post-delete FRESH destination read: must be unchanged ─────────────
  try {
    const after = await fetchDriveFileMetadata({ accessToken: ctx.dstToken, fileId: dstId });
    const ok =
      after.trashed !== true &&
      after.id === dstId &&
      after.size !== null && Number(after.size) === item.source_size_bytes &&
      !!item.source_md5 && after.md5Checksum === item.source_md5 &&
      (!item.destination_file_name || after.name === item.destination_file_name) &&
      (!ctx.dstFolderGoogleId || after.parents.includes(ctx.dstFolderGoogleId));
    if (!ok) {
      return fail("destination_corrupted_after_source_deletion", {
        destination_after: {
          id: after.id, name: after.name, size: after.size,
          md5: after.md5Checksum, trashed: after.trashed, parents: after.parents,
        },
      });
    }
  } catch (err) {
    return fail(`destination_verification_after_delete_failed_status_${httpStatusFromError(err)}`);
  }

  // ── only now record the completed deletion ────────────────────────────
  const recordedRes = await admin.rpc("mark_drive_migration_source_deleted", {
    p_item_id: item.id,
  });
  const recorded = (recordedRes.data as { recorded?: boolean } | null)?.recorded === true;
  if (!recorded) {
    return fail("deletion_confirmed_but_persistence_failed");
  }

  await logEvent(admin, "DRIVE_MIGRATION_SOURCE_DELETE_COMPLETED", migrationId,
    item.media_id, "OK",
    "source file permanently deleted and confirmed gone; destination re-verified",
    {
      item_id: item.id,
      source_google_drive_file_id: srcId,
      destination_google_drive_file_id: dstId,
      source_size_bytes: item.source_size_bytes,
      source_md5: item.source_md5,
      destination_reverified_after_delete: true,
      crash_recovery: false,
    });

  return { item_id: item.id, media_id: item.media_id, outcome: "SOURCE_DELETED",
           bytes: item.source_size_bytes };
}
