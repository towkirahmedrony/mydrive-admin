/**
 * Drive migration worker — static safety contract.
 *
 * These assertions are the regression guard for the one rule that must never
 * break: the copy-and-verify worker must not be able to delete, trash, move or
 * rename a SOURCE file, and must not authorise a source deletion.
 *
 * They read the worker and its shared modules as text and assert the absence of
 * the dangerous surface, plus the presence of the additions this task made.
 *
 * Run:
 *   node --experimental-strip-types --test tests/drive-migration-worker-safety.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const WORKER = "supabase/functions/drive-migration-worker/index.ts";
const UPLOAD = "supabase/functions/_shared/google-drive-upload.ts";
const VERIFY = "supabase/functions/_shared/drive-verify.ts";
const MEDIA_READ = "supabase/functions/_shared/drive-media-read.ts";
const MIGRATION_SQL = "supabase/migrations/20260925140000_drive_migration_worker_rpcs.sql";

function raw(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

/** Strip block and line comments so assertions test code, not prose. */
function code(rel: string): string {
  return raw(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("--"))
    .join("\n");
}

const WORKER_CODE = code(WORKER);
const SQL_CODE = code(MIGRATION_SQL);

// ── the source-deletion prohibition ────────────────────────────────────────

test("worker never calls a source-deletion RPC", () => {
  assert.doesNotMatch(WORKER_CODE, /authorize_drive_migration_source_deletion\s*\(/);
  assert.doesNotMatch(WORKER_CODE, /mark_drive_migration_source_deleted\s*\(/);
});

test("worker never issues a Drive delete or trash request", () => {
  assert.doesNotMatch(WORKER_CODE, /files\.delete/i);
  assert.doesNotMatch(WORKER_CODE, /method:\s*["']DELETE["']/i);
  assert.doesNotMatch(WORKER_CODE, /method:\s*["']PATCH["']/i);
  assert.doesNotMatch(WORKER_CODE, /\btrashed\s*:\s*true\b/);
  assert.doesNotMatch(WORKER_CODE, /deletePartialDriveFile/);
});

test("worker never writes source provenance or deletion state", () => {
  // `source_deletion_state` may appear exactly once: as the read-only type
  // field on ItemRow.  Any second occurrence would mean it is being handled.
  const hits = (WORKER_CODE.match(/source_deletion_state/g) ?? []).length;
  assert.equal(hits, 1, "deletion state must only be declared, never assigned");
  assert.match(WORKER_CODE, /source_deletion_state:\s*string;/);

  assert.doesNotMatch(WORKER_CODE, /source_deleted_at/);
  assert.doesNotMatch(WORKER_CODE, /source_delete_authorised_at/);
  assert.doesNotMatch(WORKER_CODE, /p_source_/);
});

test("only the destination side is written", () => {
  // the RPC arguments the worker passes are destination-scoped
  const calls = WORKER_CODE.match(/p_destination_\w+/g) ?? [];
  assert.ok(calls.length > 0, "worker must populate destination provenance");
  assert.ok(calls.every((c) => c.startsWith("p_destination_")));
});

// ── the DB layer cannot authorise a deletion either ────────────────────────

test("the completion RPC has no source-deletion parameter", () => {
  const fn = SQL_CODE.slice(
    SQL_CODE.indexOf("CREATE OR REPLACE FUNCTION public.complete_drive_migration_item"),
    SQL_CODE.indexOf("COMMENT ON FUNCTION public.complete_drive_migration_item"),
  );
  assert.ok(fn.length > 0, "complete_drive_migration_item must exist");

  // It may REPORT the deletion state in its result, but the UPDATE it performs
  // must not set any source-side column.
  const update = fn.slice(
    fn.indexOf("UPDATE public.drive_account_migration_items"),
    fn.indexOf("WHERE id = p_item_id"),
  );
  assert.ok(update.length > 0, "the item UPDATE must be present");
  assert.doesNotMatch(update, /source_deletion_state/);
  assert.doesNotMatch(update, /source_deleted_at/);
  assert.doesNotMatch(update, /source_delete_authorised_at/);
  assert.doesNotMatch(update, /source_google_drive_file_id\s*=/);
  assert.doesNotMatch(update, /source_md5\s*=/);
});

test("the worker-RPC migration adds no source-deletion capability", () => {
  assert.doesNotMatch(SQL_CODE, /authorize_drive_migration_source_deletion/);
  assert.doesNotMatch(SQL_CODE, /mark_drive_migration_source_deleted/);
  assert.doesNotMatch(SQL_CODE, /DROP TABLE/i);
  assert.doesNotMatch(SQL_CODE, /DELETE FROM public\./i);
});

test("finalize refuses to complete while items are unverified", () => {
  const fn = SQL_CODE.slice(
    SQL_CODE.indexOf("CREATE OR REPLACE FUNCTION public.finalize_drive_account_migration"),
    SQL_CODE.indexOf("CREATE OR REPLACE FUNCTION public.drive_migration_progress"),
  );
  assert.match(fn, /ITEMS_NOT_VERIFIED/);
  assert.match(fn, /v_not_verified > 0/);
  // and it never touches deletion state
  assert.doesNotMatch(fn, /source_deletion_state\s*=/);
});

test("the claim function refuses to redo VERIFIED or BLOCKED items", () => {
  const fn = SQL_CODE.slice(
    SQL_CODE.indexOf("CREATE OR REPLACE FUNCTION public.claim_drive_migration_item"),
    SQL_CODE.indexOf("-- 5. Persist an item result"),
  );
  assert.match(fn, /verification_state <> 'VERIFIED'/);
  assert.match(fn, /verification_state <> 'BLOCKED'/);
  assert.match(fn, /FOR UPDATE SKIP LOCKED/);
  // a COPIED item must not regress to COPYING (that would re-upload)
  assert.match(fn, /WHEN verification_state = 'COPIED' THEN 'COPIED'/);
});

// ── the additions this task made ───────────────────────────────────────────

test("the uploader gained an authenticated source opener", () => {
  const src = code(UPLOAD);
  assert.match(src, /openSource\?\s*:\s*\(\)\s*=>\s*Promise<Response>/);
  assert.match(src, /async function openUploadSource/);
  assert.match(src, /function requireSource/);
  // and it must fail BEFORE creating a resumable session
  const streaming = src.slice(src.indexOf("export async function uploadStreaming"));
  assert.ok(
    streaming.indexOf("requireSource(") < streaming.indexOf("buildResumableUploadUrl("),
    "the source guard must run before the resumable session is created",
  );
});

test("the uploader still supports the original public-URL path", () => {
  const src = code(UPLOAD);
  assert.match(src, /sourceUrl\?\s*:\s*string/);
  assert.match(src, /requires either sourceUrl or openSource/);
});

test("the verification primitive gained the MD5 byte-equality check", () => {
  const src = code(VERIFY);
  assert.match(src, /expectedMd5\?\s*:\s*string \| null/);
  assert.match(src, /md5_matches_source/);
  assert.match(src, /md5_not_requested/);
  // a missing checksum must be retryable, never a silent pass
  assert.match(src, /byte equality cannot be proven/);
});

test("the source read is the authenticated metadata/media path, not a public URL", () => {
  const src = code(MEDIA_READ);
  assert.match(src, /url\.searchParams\.set\("alt",\s*"media"\)/);
  assert.match(src, /Authorization: `Bearer \$\{params\.accessToken\}`/);
  // the worker wires that opener into the uploader rather than building a URL
  // the worker defines an opener around the authenticated read and hands that
  // FUNCTION to the uploader (never a URL)
  assert.match(WORKER_CODE, /const openSource = \(\) =>\s*\n?\s*openDriveFileContent\(\{/);
  assert.match(WORKER_CODE, /\bopenSource,/);
  assert.doesNotMatch(WORKER_CODE, /alt=media/);
  assert.doesNotMatch(WORKER_CODE, /sourceUrl:/);
});

test("the worker asserts item scope against the migration", () => {
  assert.match(WORKER_CODE, /item\.source_drive_account_id !== migration\.source_drive_account_id/);
  assert.match(WORKER_CODE, /destination_equals_source/);
  assert.match(WORKER_CODE, /item_has_no_destination_account/);
});

test("the worker reconciles an existing destination object before re-uploading", () => {
  assert.match(WORKER_CODE, /findFileByName\(/);
  assert.match(WORKER_CODE, /adopted: true/);
});

test("the worker verifies account identity from the API, not the DB alone", () => {
  assert.match(WORKER_CODE, /identityByAccount\.get\(destAccountId\)/);
  assert.match(WORKER_CODE, /destination_account_identity_mismatch/);
  assert.match(WORKER_CODE, /source_account_identity_mismatch/);
});

test("the worker never logs credentials or resumable session URLs", () => {
  // The uploader's progress callback carries a resumable session URI. The worker
  // must not forward it to a log, a result, or a database column.
  assert.doesNotMatch(WORKER_CODE, /uploadUrl\b/);
  assert.match(WORKER_CODE, /session URI deliberately NOT logged/);

  // Vault secret VALUES never appear. The worker reads only the secret id, and
  // only to derive the internal system token as a one-way hash.
  assert.doesNotMatch(WORKER_CODE, /decrypted_secret/);
  assert.match(WORKER_CODE, /refresh_token_secret_id/);
  assert.match(WORKER_CODE, /sha256Hex\(tok\)/);

  // No response or audit payload carries a token field.
  assert.doesNotMatch(WORKER_CODE, /(access_token|refresh_token_value|refreshToken\s*:|authorization\s*:)/i);
});

test("the batch is bounded and resumable", () => {
  assert.match(WORKER_CODE, /MAX_LIMIT = 8/);
  assert.match(WORKER_CODE, /BUDGET_MS = 48_000/);
  assert.match(WORKER_CODE, /p_lease_minutes/);
  assert.match(WORKER_CODE, /next_retry_at/);
});
