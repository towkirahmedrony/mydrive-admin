/**
 * Source deletion worker — static safety + ordering contract.
 *
 * The destructive call must sit strictly inside the safety sequence, and the
 * sequence must stop at the first anomaly. These assertions are ordering
 * checks on the real source, which no runtime unit test can prove as directly.
 *
 * Run:
 *   node --experimental-strip-types --test tests/drive-migration-source-delete-safety.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = "supabase/functions/drive-migration-source-delete/index.ts";

const raw = readFileSync(path.join(repoRoot, WORKER), "utf8");
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("//"))
  .join("\n");

const at = (needle: string, from = 0) => {
  const i = code.indexOf(needle, from);
  assert.notEqual(i, -1, `expected to find: ${needle} (from ${from})`);
  return i;
};

// ── the destructive call is exactly one, and only on the source ────────────

test("exactly one delete call exists, and it is the source file", () => {
  const calls = code.match(/deletePartialDriveFile\(/g) ?? [];
  assert.equal(calls.length, 1, "there must be exactly one delete call");
  assert.match(code, /deletePartialDriveFile\(srcId,\s*ctx\.srcToken\)/);
});

test("the destination file id is never passed to a delete call", () => {
  assert.doesNotMatch(code, /deletePartialDriveFile\(dstId/);
  assert.doesNotMatch(code, /deletePartialDriveFile\(item\.destination_/);
});

test("no other destructive Drive surface is used", () => {
  assert.doesNotMatch(code, /method:\s*["']DELETE["']/);
  assert.doesNotMatch(code, /method:\s*["']PATCH["']/);
  assert.doesNotMatch(code, /trashed:\s*true/);
  assert.doesNotMatch(code, /files\.update/);
});

test("no bulk or loop-driven deletion path", () => {
  // the per-item loop may only ever *call* processItem; the delete lives inside
  // processItem, which handles exactly one item
  const loopStart = at("for (const item of items)");
  const loop = code.slice(loopStart, at("return json({", loopStart));
  assert.doesNotMatch(loop, /deletePartialDriveFile/);
  assert.match(loop, /for \(const item of items\)/);
  assert.match(loop, /break;/, "the loop must be able to stop");
});

// ── ordering: delete happens only after both fresh reads + authorisation ───

test("the delete is sequenced after both fresh reads and the authorisation", () => {
  const srcRead = at("await fetchDriveFileMetadata({ accessToken: ctx.srcToken");
  const dstRead = at("await fetchDriveFileMetadata({ accessToken: ctx.dstToken");
  const auth = at("authorize_drive_migration_source_deletion");
  const del = at("deletePartialDriveFile(srcId");
  const confirm = at("source_still_present_after_delete");
  const dstAfter = at("destination_corrupted_after_source_deletion");
  // the crash-recovery branch also calls mark_…, so locate the one in the
  // normal post-delete path
  const mark = at("mark_drive_migration_source_deleted", del);

  assert.ok(srcRead < auth, "fresh source read must precede authorisation");
  assert.ok(dstRead < auth, "fresh destination read must precede authorisation");
  assert.ok(auth < del, "authorisation must precede deletion");
  assert.ok(del < confirm, "the post-delete source confirmation must follow the delete");
  assert.ok(del < dstAfter, "the post-delete destination check must follow the delete");
  assert.ok(dstAfter < mark, "the item may only be marked deleted after the destination is re-verified");
  assert.ok(confirm < mark, "the item may only be marked deleted after the source is confirmed gone");
});

test("authorisation is required: a refused authorisation aborts before deleting", () => {
  const refused = at('if (!auth?.authorized)');
  const del = at("deletePartialDriveFile(srcId");
  assert.ok(refused < del, "the refusal branch must sit before the delete");
  assert.match(code, /return fail\("authorization_refused"/);
});

test("the deletion is only attempted when the item is destination-VERIFIED", () => {
  const guard = at('if (item.verification_state !== "VERIFIED")');
  const del = at("deletePartialDriveFile(srcId");
  assert.ok(guard < del);
  assert.match(code, /return fail\("item_not_destination_verified"\)/);
});

// ── fail-closed behaviour ─────────────────────────────────────────────────

test("the run stops at the first anomaly", () => {
  assert.match(code, /stopped = true;/);
  assert.match(code, /stopReason = r\.reason \?\? "unspecified";/);
  assert.match(code, /stopped_on_anomaly: stopped/);
});

test("the migration must be COMPLETED before any candidate is considered", () => {
  const guard = at('if (migration.status !== "COMPLETED")');
  const del = at("deletePartialDriveFile(srcId");
  assert.ok(guard < del);
  assert.match(code, /reason: "migration_not_completed"/);
});

test("crash recovery: an unauthorised missing source is an anomaly, not a success", () => {
  assert.match(code, /source_missing_without_authorisation/);
  assert.match(code, /const alreadyAuthorised = item\.source_deletion_state === "SOURCE_DELETE_PENDING"/);
  assert.match(code, /crash_recovery: true/);
});

test("a still-readable source after deletion is treated as a failure", () => {
  assert.match(code, /source_only_trashed_not_deleted/);
  assert.match(code, /source_still_present_after_delete/);
  assert.match(code, /deletion_confirmed_but_persistence_failed/);
});

test("the destination is re-verified after the deletion and corruption blocks the result", () => {
  assert.match(code, /destination_corrupted_after_source_deletion/);
  assert.match(code, /destination_reverified_after_delete: true/);
});

test("every pre-delete failure reason is explicit and mutually distinguishable", () => {
  for (const reason of [
    "destination_trashed_before_source_deletion",
    "destination_file_id_mismatch_before_source_deletion",
    "destination_size_mismatch_before_source_deletion",
    "destination_md5_mismatch_before_source_deletion",
    "destination_name_mismatch_before_source_deletion",
    "destination_folder_mismatch_before_source_deletion",
    "source_trashed_before_deletion",
    "source_md5_changed_since_baseline",
    "source_size_changed_since_baseline",
    "source_folder_mismatch",
    "source_name_mismatch",
    "source_file_id_mismatch",
    "source_and_destination_file_id_identical",
    "account_identity_unproven_for_source_deletion",
  ]) {
    assert.match(code, new RegExp(`"${reason}"`), `expected reason ${reason}`);
  }
});

test("scope cannot be caller-chosen", () => {
  // the body may only carry migration_id and limit
  assert.match(code, /body: \{ migration_id\?: unknown; limit\?: unknown \}/);
  assert.doesNotMatch(code, /body\.item_id/);
  assert.doesNotMatch(code, /body\.source_/);
  assert.doesNotMatch(code, /body\.destination_/);
  assert.doesNotMatch(code, /body\.file_id/);
});

test("the worker is authenticated; nothing is anonymous", () => {
  assert.match(code, /Authentication required/);
  assert.match(code, /Forbidden/);
  assert.match(code, /X-Migration-System-Token/);
});

test("credentials and resumable URLs are never logged", () => {
  assert.doesNotMatch(code, /decrypted_secret/);
  assert.doesNotMatch(code, /uploadUrl/);
});
