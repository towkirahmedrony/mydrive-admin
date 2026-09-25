/**
 * Drive Account Migration Foundation — schema-contract tests.
 *
 * The behavioural tests for this foundation live in
 * `tests/drive-migration-foundation.sql` and run inside a rolled-back
 * transaction against the real database (they need constraints and functions
 * to actually fire, which a mock cannot prove).
 *
 * These tests are the credential-free half: they statically assert that the
 * migration artifacts still declare every guard the foundation depends on, so
 * a later edit cannot silently drop the source-deletion gate, weaken a
 * RESTRICT to a SET NULL, or introduce a Drive write.
 *
 * Run:
 *   node --experimental-strip-types --import ./tests/register.mjs \
 *     --test tests/drive-migration-schema.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const MIGRATIONS = [
  "20260925120000_drive_account_migration_foundation.sql",
  "20260925120100_drive_migration_planner.sql",
  "20260925120200_drive_migration_gates.sql",
];

function readMigration(name: string): string {
  return readFileSync(path.join(repoRoot, "supabase/migrations", name), "utf8");
}

const ALL_SQL = MIGRATIONS.map(readMigration).join("\n");
/** SQL with `--` comments stripped, so assertions test real code not prose. */
const CODE = ALL_SQL.split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

test("declares both dedicated migration tables", () => {
  assert.match(
    CODE,
    /CREATE TABLE IF NOT EXISTS public\.drive_account_migrations\b/,
  );
  assert.match(
    CODE,
    /CREATE TABLE IF NOT EXISTS public\.drive_account_migration_items\b/,
  );
});

test("does not reuse replication_jobs for account migration", () => {
  assert.doesNotMatch(CODE, /ALTER TABLE public\.replication_jobs/);
  assert.doesNotMatch(CODE, /CREATE TABLE[^;]*replication_jobs/);
});

test("migration status vocabulary is exactly the documented set", () => {
  assert.match(
    CODE,
    /status IN \('PLANNED','RUNNING','PAUSED','COMPLETED','FAILED','CANCELLED','BLOCKED'\)/,
  );
});

test("item verification and deletion states are explicit, not boolean", () => {
  assert.match(
    CODE,
    /verification_state IN \('PENDING','COPYING','COPIED','VERIFIED','FAILED','BLOCKED'\)/,
  );
  assert.match(
    CODE,
    /source_deletion_state IN \('NOT_ELIGIBLE','SOURCE_DELETE_PENDING','SOURCE_DELETED','FAILED'\)/,
  );
  // no boolean verification/deletion column sneaked in
  assert.doesNotMatch(CODE, /is_verified\s+boolean/i);
  assert.doesNotMatch(CODE, /source_deleted\s+boolean/i);
});

test("destination can never equal source", () => {
  assert.match(
    CODE,
    /CONSTRAINT drive_account_migration_items_distinct_accounts CHECK \(\s*destination_drive_account_id IS NULL\s*OR destination_drive_account_id <> source_drive_account_id\s*\)/,
  );
});

test("the source-deletion gate is enforced by the database itself", () => {
  assert.match(
    CODE,
    /CONSTRAINT drive_account_migration_items_delete_gate CHECK \(\s*source_deletion_state IN \('NOT_ELIGIBLE','FAILED'\)\s*OR verification_state = 'VERIFIED'\s*\)/,
  );
  assert.match(
    CODE,
    /CONSTRAINT drive_account_migration_items_source_deleted_requires_dest CHECK/,
  );
});

test("migration provenance uses ON DELETE RESTRICT for accounts and folders", () => {
  for (const col of [
    "source_drive_account_id",
    "source_drive_folder_id",
    "destination_drive_account_id",
    "destination_drive_folder_id",
  ]) {
    const re = new RegExp(
      `${col}\\s+uuid[\\s\\S]{0,120}?REFERENCES public\\.\\w+\\(id\\) ON DELETE RESTRICT`,
    );
    assert.match(CODE, re, `${col} must be ON DELETE RESTRICT`);
  }
  // and nothing migration-related may cascade from an account
  assert.doesNotMatch(
    CODE,
    /REFERENCES public\.drive_accounts\(id\) ON DELETE (CASCADE|SET NULL)/,
  );
});

test("retry cannot duplicate an item; one active migration per source", () => {
  assert.match(
    CODE,
    /CONSTRAINT drive_account_migration_items_unique_media UNIQUE \(migration_id, media_id\)/,
  );
  assert.match(
    CODE,
    /CREATE UNIQUE INDEX IF NOT EXISTS drive_account_migrations_one_active_per_source[\s\S]{0,200}?WHERE status IN \('PLANNED','RUNNING','PAUSED','BLOCKED'\)/,
  );
});

test("retirement guard is a dedicated column, not an overloaded one", () => {
  assert.match(
    CODE,
    /ALTER TABLE public\.drive_accounts\s*ADD COLUMN IF NOT EXISTS retiring_migration_id uuid\s*REFERENCES public\.drive_account_migrations\(id\) ON DELETE RESTRICT/,
  );
  // must not repurpose connectivity / quota columns as the lifecycle guard
  assert.doesNotMatch(CODE, /ALTER TABLE public\.drive_accounts[\s\S]{0,200}?status\s+text/);
  assert.doesNotMatch(CODE, /ALTER TABLE public\.drive_accounts[\s\S]{0,200}?enabled/);
  assert.doesNotMatch(CODE, /ALTER TABLE public\.drive_accounts[\s\S]{0,200}?health_status/);
});

test("destination selection excludes accounts being retired", () => {
  const idx = CODE.indexOf("public.list_eligible_drive_accounts");
  assert.notEqual(idx, -1, "list_eligible_drive_accounts must be redefined");
  const body = CODE.slice(idx, idx + 2500);
  assert.match(body, /da\.retiring_migration_id IS NULL/);
  // existing eligibility rules must survive the redefinition
  assert.match(body, /da\.enabled = true/);
  assert.match(body, /da\.status = 'active'/);
  assert.match(body, /da\.connection_status IN \('connected', 'unknown'\)/);
  assert.match(body, /da\.health_status IN \('healthy', 'unknown'\)/);
});

test("planner derives scope from DB state and returns every required figure", () => {
  for (const key of [
    "required_bytes",
    "safety_margin_bytes",
    "shortfall_bytes",
    "feasible",
    "single_account_sufficient",
    "destination_count",
    "candidates",
    "allocations",
  ]) {
    assert.match(CODE, new RegExp(`'${key}'`), `planner must return ${key}`);
  }
  // capacity must subtract reserved bytes and the margin
  assert.match(
    CODE,
    /v_usable\s*:=\s*GREATEST\(v_rec\.effective_available - v_pending - v_margin, 0\)/,
  );
  // and must support multiple destinations
  assert.match(CODE, /LEAST\(v_usable, v_remaining\)/);
});

test("gates are defined and admin-only", () => {
  for (const fn of [
    "public.plan_drive_account_migration",
    "public.can_delete_drive_migration_source",
    "public.authorize_drive_migration_source_deletion",
    "public.mark_drive_migration_source_deleted",
    "public.check_drive_account_removal",
    "public.drive_account_retirement_state",
    "public.set_drive_account_retiring",
    "public.log_drive_migration_event",
  ]) {
    assert.match(
      CODE,
      new RegExp(`CREATE OR REPLACE FUNCTION ${fn.replace(/\./g, "\\.")}\\(`),
      `${fn} must exist`,
    );
  }
  assert.match(CODE, /ENABLE ROW LEVEL SECURITY/);
  assert.match(CODE, /USING \(private\.is_admin\(\)\)/);
  assert.match(CODE, /REVOKE ALL ON public\.drive_account_migrations\s+FROM anon/);
});

test("there is no force-remove bypass for account removal", () => {
  assert.doesNotMatch(CODE, /force[_ ]?remove/i);
  assert.doesNotMatch(CODE, /p_force\s+boolean/i);
  assert.match(
    CODE,
    /'can_remove',\s*\(cardinality\(v_reasons\) = 0\)/,
  );
});

test("the foundation performs no Drive write and touches no Drive object", () => {
  // no Drive API anything
  assert.doesNotMatch(CODE, /googleapis\.com/i);
  assert.doesNotMatch(CODE, /files\.copy|files\.delete|files\.update|files\.create/i);
  assert.doesNotMatch(CODE, /\bnet\.http_post\b/i);
  // no destructive DDL/DML on existing production tables
  assert.doesNotMatch(CODE, /DROP TABLE/i);
  assert.doesNotMatch(CODE, /TRUNCATE/i);
  assert.doesNotMatch(CODE, /DELETE FROM public\.(media_assets|replication_jobs|drive_accounts|drive_folders|sync_logs)/i);
  assert.doesNotMatch(CODE, /UPDATE public\.(media_assets|replication_jobs|drive_folders)\b/i);
  // drive_accounts may only be altered additively
  assert.doesNotMatch(CODE, /ALTER TABLE public\.drive_accounts[\s\S]{0,400}?DROP COLUMN/i);
});

test("the audit vocabulary covers the required migration events", () => {
  for (const ev of [
    "DRIVE_MIGRATION_PLANNED",
    "DRIVE_MIGRATION_DESTINATION_SELECTED",
    "DRIVE_MIGRATION_COPY_STARTED",
    "DRIVE_MIGRATION_COPY_COMPLETED",
    "DRIVE_MIGRATION_DESTINATION_VERIFIED",
    "DRIVE_MIGRATION_DESTINATION_VERIFICATION_FAILED",
    "DRIVE_MIGRATION_SOURCE_DELETE_AUTHORISED",
    "DRIVE_MIGRATION_SOURCE_DELETE_COMPLETED",
    "DRIVE_MIGRATION_COMPLETED",
    "DRIVE_MIGRATION_FAILED",
    "DRIVE_ACCOUNT_RETIREMENT_AUTHORISED",
  ]) {
    assert.match(CODE, new RegExp(`'${ev}'`), `${ev} must be in the vocabulary`);
  }
  // audit reuses the existing table; no new audit table
  assert.match(CODE, /INSERT INTO public\.sync_logs/);
  assert.doesNotMatch(CODE, /CREATE TABLE[^;]*audit_logs/i);
});
