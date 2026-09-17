# Google Drive Backend Foundation — Implementation Report

Project: `gpiuxcdjmrzcouhjapcs` (MyDrive, ap-southeast-1)
Date: 2026-09-17
Scope: Drive account model, enable/disable, health, quota, safety margin, priority,
user folder mapping, Drive Router foundation, Admin Panel controls, RLS/security.

## 1. Headline finding: the foundation was designed but never applied

Three sources had diverged, and the live database was missing most of the Drive
foundation even though the Edge Functions were already deployed against it:

| Source | What it held |
|---|---|
| `mydrive-admin` repo | Admin Panel, two OAuth functions, `supabase/migrations/00[12]`, and `supabase/backend-reference/` (reference copies of *another* repo's files) |
| Live Supabase project | 1 connected drive account, 0 folder mappings, 0 jobs, only 3 recorded migrations (telegram-era) |
| Origin dev checkout (referenced in `backend-reference/oauth-schema-search.txt`) | The real `supabase/migrations/2026091600xx` series |

Consequences found before any change was made:

- Deployed `drive-admin` v15 selected columns (`enabled`, `connection_status`,
  `health_status`, `display_name`, `reserved_bytes`, `last_health_check_at`,
  `last_error`, `last_error_at`, `notes`) that **did not exist** in the live
  `drive_accounts` table, so it could not work at all.
- Deployed `drive-replicate` v15 and `shared/drive-router.ts` called
  `claim_drive_job`, `complete_drive_job`, `failover_drive_replication_job`,
  `assign_drive_replication_job`, `list_eligible_drive_accounts`,
  `reserve_drive_account`, `claim_drive_folder`, … — **none of which existed**.
- No migration for any Drive object was recorded in `supabase_migrations`.

The three pending migrations were therefore applied, plus one new one authored
for the job queue and one for security hardening.

## 2. Database migrations created/changed

All applied through the migration system (recorded in `supabase_migrations`);
none is destructive, all are idempotent re-runnable.

| Version | Name | Source | Effect |
|---|---|---|---|
| 20260917053001 | `drive_accounts_folders` | repo `20260916000400` | +11 `drive_accounts` cols (`display_name`, `refresh_token_updated_at`, `token_expires_at`, `enabled`, `connection_status`, `health_status`, `reserved_bytes`, `last_health_check_at`, `last_error`, `last_error_at`, `notes`), +5 `drive_folders` cols (`folder_status`, `create_lease_until`, `create_attempts`, `last_error`, `updated_at`), `google_folder_id` NOT NULL dropped, status CHECK constraints, routing indexes, `drive_folders_user_mapping_key`, `drive_folders_root_key` |
| 20260917053119 | `drive_job_queue` | **new** `20260916000600` | `failed_drive_account_ids`, `google_drive_upload_url/_chunk/_attempts`, queue index, `claim_drive_job()`, `complete_drive_job()`, `failover_drive_replication_job()`, `assign_drive_replication_job()` |
| 20260917053331 | `drive_job_queue` (re-run, idempotent) | same | no-op safety re-run |
| 20260917055030 + one re-run | `privilege_hardening` | **new** `20260916000700` | revokes EXECUTE from `anon`/`authenticated` on all server-only RPCs; adds `profiles` set update guard |
| 2026091705xxxx | `drive_router_folders` | repo `20260916000500` | Router + folder primitives: `list_eligible_drive_accounts`, `select_drive_account`, `reserve_drive_account`, `release_drive_quota`, `mark_drive_account_result`, `claim_drive_folder`, `complete_drive_folder`, `fail_drive_folder`, and hardened `admin_store_drive_refresh_token` / `worker_lookup_drive_refresh_token` |

Data safety: the pre-existing account row was verified unchanged after every
apply (same id, email, priority, quota values, `last_quota_check_at`).

Because `drive_router_folders` creates functions *after* the hardening pass, the
hardening migration was re-applied afterwards and privileges re-verified.

## 3. Edge Functions changed

| Function | Version | Change |
|---|---|---|
| `drive-admin` | 16 → **17** | Added `refresh_health` (real Google `about.get` quota + health classification) and `routing` (read-only eligibility from the DB router). `UPDATABLE_FIELDS` reduced to configuration only (`name`, `display_name`, `root_folder_id`, `priority`, `enabled`, `reserved_bytes`, `notes`) so health/quota/status can no longer be hand-written. `set_enabled` now writes the `enabled` column and logs an audit event. `create` now goes through `admin_create_drive_account_with_refresh_token` (cannot insert a credential-less account, which the live `refresh_token_secret_id NOT NULL` forbids) and rejects a missing refresh token with 400. |
| `drive-replicate` | 15 → **17** | Boot fix + phantom-row guard (see §4). No pipeline logic changed. |

Source files changed in the repo:

- `supabase/backend-reference/drive-admin.ts`
- `supabase/backend-reference/drive-replicate.ts`
- `supabase/backend-reference/shared/google-drive.ts` (added `DriveAboutError`, `DriveAboutInfo`, `fetchDriveAbout()`, `httpStatusFromError()`)
- `supabase/backend-reference/shared/drive-router.ts` (**restored** — was missing from the repo entirely)
- `supabase/backend-reference/shared/google-drive-upload.ts` (**restored** — was missing from the repo entirely)
- new: `supabase/backend-reference/20260916000600_drive_job_queue.sql`
- new: `supabase/backend-reference/20260916000700_privilege_hardening.sql`

## 4. Architecture conflicts discovered (and what was done)

1. **Both deployed functions could not boot.** Line 1 was
   `import { serve } from "jsr:@std/http"`; the deployed edge runtime resolves
   that module to a version with no `serve` export, producing
   `worker boot error: Uncaught SyntaxError: … does not provide an export named 'serve'`.
   Fixed by using the built-in `Deno.serve` (as the repo's own OAuth functions
   already do). Neither function had ever been invoked successfully before, so
   nobody had noticed.
2. **Empty-queue crash in the worker.** `claim_drive_job()` returns
   `RETURNS public.replication_jobs`; when it finds nothing it returns SQL NULL,
   which PostgREST delivers as an **object with all fields null**, not as
   `null`. The worker's `if (!claimed) break;` therefore passed a phantom job to
   `processJob`, which threw `Cannot read properties of null (reading 'slice')`
   and returned HTTP 500 on every run. Fixed with an explicit id guard, and the
   same phantom-row class was fixed in `shared/drive-router.ts` for
   `select_drive_account` / `reserve_drive_account`.
3. **Credential exposure (critical).** Supabase default privileges grant EXECUTE
   on new `public` functions to `anon` and `authenticated`; the existing
   `REVOKE … FROM PUBLIC` did not remove them. Verified live: as
   `authenticated`, `worker_lookup_drive_refresh_token(<secret_id>,<account_id>)`
   returned a **plaintext 182-character Google refresh token**. After hardening,
   the same call fails with `permission denied for function`, while
   `service_role` retains access. The same defect affected
   `worker_lookup_telegram_token` (bot tokens) and is fixed too.
4. **Privilege self-escalation.** `profiles` allowed any authenticated user to
   `UPDATE` their own row including `role`/`status`, which are exactly the inputs
   of `private.is_admin()`. Fixed with a BEFORE UPDATE guard trigger; content
   fields (`full_name`, used by the Android app) remain user-editable.
5. **Repo/DB divergence.** `shared/drive-router.ts` and
   `shared/google-drive-upload.ts` existed only inside the deployed bundles. Both
   restored as reference copies.
6. **Duplicate index avoided.** My first job-queue draft created a unique index
   on `(media_id) WHERE destination_type='google_drive'`; the live table already
   enforces one Drive job per media via
   `replication_jobs_media_id_destination_type_key`, so the duplicate was dropped
   and the migration updated.
7. **Worker auth check is weak (reported, not changed).** `drive-replicate`
   accepts any `Authorization: Bearer …` header (including the public anon key)
   and then executes privileged work with the service role. Tightening it changes
   an external invocation contract, so it is left for your decision.

## 5. Schemas used

**Drive account** — `drive_accounts` (existing table, extended):
`id`, `name`, `display_name`, `google_email` (unique), `refresh_token_secret_id`
(→ Supabase Vault; never exposed), `root_folder_id`, `priority`, `enabled`,
`status` (`active|quota_full|reauth_required|disabled|error`),
`connection_status` (`connected|disconnected|reauth_required|error|unknown`),
`health_status` (`unknown|healthy|degraded|unhealthy`), `storage_limit_bytes`,
`storage_used_bytes`, `storage_available_bytes`, `reserved_bytes`,
`last_quota_check_at`, `last_health_check_at`, `refresh_token_updated_at`,
`token_expires_at`, `last_error`, `last_error_at`, `notes`, `created_at`,
`updated_at`.

**Folder mapping** — `drive_folders` (existing): `id`, `drive_account_id`,
`parent_folder_id`, `owner_id`, `folder_name`, `google_folder_id`,
`folder_type` (`root|media|user|year|month|custom`), `folder_status`
(`pending|creating|active|failed`), `create_lease_until`, `create_attempts`,
`last_error`, `created_at`, `updated_at`. Identity is the persisted Google
folder id, never the folder name. Uniqueness: `drive_folders_user_mapping_key`
(one user mapping per account) and `drive_folders_root_key` (one root per
account), plus the pre-existing `(drive_account_id, google_folder_id)` key.

**Router location** — `list_eligible_drive_accounts()` /
`select_drive_account()` / `reserve_drive_account()` in the database
(migration `drive_router_folders`); the TypeScript side is
`supabase/backend-reference/shared/drive-router.ts`. Selection is priority ASC,
then most free space, minus `reserved_bytes`, and requires the safety margin
from `app_settings.drive_safety_margin_bytes` (default 1 GiB).

## 6. Admin Panel

`src/app/admin/drive/page.tsx` and `src/components/DriveAccountCard.tsx`
rewritten (delegated and reviewed):

- Data now comes from the `drive-admin` function (`list` + `routing`) over the
  admin's session JWT; **no direct table access** and `refresh_token_secret_id`
  is never selected.
- Displays: account email/name, enabled + status badges, separate connection and
  health badges, total/used/free quota with "Not synced yet" when null, priority,
  `reserved_bytes` when non-zero, last health check, last quota refresh,
  `last_error`, and an "eligible for new uploads" indicator from real routing data.
- Actions: Enable/Disable (`set_enabled`), Refresh health/quota
  (`refresh_health`), priority edit (`update`), Reconnect (existing OAuth button
  when `reauth_required`). The destructive browser-side DELETE and the direct
  `status` UPDATE were removed.
- No hardcoded account limit anywhere; `npm run build` passes.

## 7. Secrets / environment required

`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`,
`ADMIN_PANEL_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Edge Functions),
plus `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` in the panel.
Refresh tokens live in Supabase Vault. No new secret is required by this work.

## 8. Tests performed (live project, fixtures inside rolled-back transactions)

| # | Test | Result |
|---|---|---|
| 0 | 11 Drive accounts created at once | PASS — no 3/4 account cap |
| 2 | Routing order = priority ASC then most free | PASS — `T-A3(5), T-A1(10), T-A2(20), T-A4(30/9GB), T-A5(30/6GB), <prod acct>(100)` |
| 3 | Disabled / degraded / reauth / quota_full / below-margin / unknown-quota excluded | PASS |
| 4 | Safety-margin override (6 GB) excludes smaller accounts | PASS |
| 5 | `required_bytes` filter | PASS |
| 6 | Excluding the best account returns the next eligible | PASS (with margin 0 the small account becomes eligible — router behaviour is correct; the initial fixture expectation was wrong) |
| 8 | `reserve_drive_account` decrements availability atomically | PASS (4 GB → 3 GB) |
| 9 | `release_drive_quota` reverses it | PASS (→ 4 GB) |
| 10–12 | Folder claim acquires lease; repeat claim creates **no** second mapping; completed folder id reused, no re-create on retry | PASS |
| 13 | Same user holds mappings on two different accounts | PASS |
| 14 | Folder uniqueness indexes present | PASS |
| 21 | `reserved_bytes` honoured by the router | PASS |
| — | Platform JWT enforcement on `drive-admin` | PASS (401 without a token) |
| — | `drive-admin` boots and enforces the admin gate | PASS (function-generated 401 `Invalid or expired token` for a session-less anon JWT; no BOOT_ERROR after redeploy, `booted (time: 41ms)`) |
| — | `drive-replicate` boots and runs the claim loop | PASS — HTTP 200 `{"processed":0,"results":[],"elapsed_ms":359}` |
| — | Credential-exposure exploit | PASS — `authenticated` now gets `permission denied for function` |
| — | `profiles` escalation guard | PASS — self `role`/`status` change → `42501`; own `full_name` update → 1 row; admin → 1 row; `service_role` → 1 row; anon → 0 rows |
| — | Drive table access control | PASS — normal user 0 rows read/update/delete, INSERT rejected; admin read/update 1 row; anon denied |
| — | Both bundles typecheck | PASS — `drive-admin` clean; `drive-replicate` has 6 pre-existing type errors, identical before and after my changes |

**Not verified:** the job-queue lifecycle assertions (claim → failover →
re-claim → complete → single-media-row) did **not** complete as SQL tests — my
test script had two syntax errors that I was interrupted before fixing. The
functions are deployed and `claim_drive_job()` is proven working through the live
worker run; `failover_drive_replication_job` and `complete_drive_job` have not
been exercised. **No Cloudinary → Drive upload was performed, and no
end-to-end replication is claimed.**

## 9. Still required before the Drive replication worker can run end to end

1. Finish the queue-lifecycle SQL test (failover/complete RPCs).
2. **Nothing enqueues `destination_type='google_drive'` jobs.** No deployed
   function creates them and there is no scheduler (`pg_cron` is not installed),
   so the worker will always find an empty queue. The next task must add
   idempotent job creation on media finalize (one drive job per media — enforced
   by `replication_jobs_media_id_destination_type_key`).
3. Decide on the `drive-replicate` invocation contract: it currently accepts any
   valid JWT (including the public anon key) before running privileged work.
4. The 6 pre-existing type errors in `drive-replicate/index.ts` (including a
   `Promise` passed where a byte count is expected in the quota-release path,
   which can silently release 0 bytes) are unfixed.
5. Reconnect flow for `reauth_required` accounts should be exercised once by an
   admin, since no admin JWT was available during this work.
