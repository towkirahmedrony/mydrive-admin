-- 20260916000600_drive_job_queue.sql
-- Drive replication job queue primitives.
--
-- WHY THIS MIGRATION EXISTS
--   The deployed `drive-replicate` worker and `shared/drive-router.ts` already
--   call these objects, but they were never applied to the live database, so
--   the drive pipeline could not run at all:
--     * replication_jobs.failed_drive_account_ids  (failover exclusion list)
--     * replication_jobs.google_drive_upload_url / _chunk / _attempts
--       (resumable-upload session persistence across worker timeouts)
--     * claim_drive_job() / complete_drive_job() / failover_drive_replication_job()
--     * assign_drive_replication_job()
--
-- SCOPE
--   No new tables. No data is moved or deleted. Every statement is idempotent
--   and additive, so it can be re-applied safely to the live project.
--   This migration does NOT enqueue jobs and does NOT upload media: it only
--   makes the existing worker/router callable against the live schema.
--
-- CONVENTIONS (mirrors the existing claim_telegram_job / complete_telegram_job)
--   * one job row per media per destination — the Drive account is metadata on
--     the job, never a new media_assets row, so changing accounts (failover)
--     cannot duplicate media
--   * atomic claiming with FOR UPDATE SKIP LOCKED
--   * SECURITY DEFINER with a pinned search_path; EXECUTE is revoked from
--     PUBLIC and granted to service_role only (never anon/authenticated)

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. replication_jobs — Drive routing + resumable-upload state
-- ═══════════════════════════════════════════════════════════════════════════

-- Accounts already tried for this job. The router reads this list to fail over
-- to the next eligible account instead of retrying a broken one.
ALTER TABLE public.replication_jobs
    ADD COLUMN IF NOT EXISTS failed_drive_account_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

-- Resumable upload session (Google returns a session URI that survives worker
-- timeouts, so progress is not lost and the upload is never restarted whole).
ALTER TABLE public.replication_jobs
    ADD COLUMN IF NOT EXISTS google_drive_upload_url text;

ALTER TABLE public.replication_jobs
    ADD COLUMN IF NOT EXISTS google_drive_upload_chunk bigint NOT NULL DEFAULT 0;

ALTER TABLE public.replication_jobs
    ADD COLUMN IF NOT EXISTS google_drive_upload_attempts integer NOT NULL DEFAULT 0;

-- Guarded checks for the upgrade path (a fresh definition would carry them).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'replication_jobs_upload_chunk_check'
    ) THEN
        ALTER TABLE public.replication_jobs
            ADD CONSTRAINT replication_jobs_upload_chunk_check
            CHECK (google_drive_upload_chunk >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'replication_jobs_upload_attempts_check'
    ) THEN
        ALTER TABLE public.replication_jobs
            ADD CONSTRAINT replication_jobs_upload_attempts_check
            CHECK (google_drive_upload_attempts >= 0);
    END IF;
END $$;

-- Claim path: only google_drive jobs are scanned, ordered by created_at.
CREATE INDEX IF NOT EXISTS replication_jobs_drive_queue_idx
    ON public.replication_jobs (status, next_retry_at, created_at)
    WHERE destination_type = 'google_drive';

-- One logical media entity => at most one Drive replication row.
--
-- No index is added for this: the live table ALREADY enforces it with the
-- pre-existing unique index replication_jobs_media_id_destination_type_key
-- (media_id, destination_type). Failover re-uses the same job row, so changing
-- the Drive account can never register a second replication record for the same
-- media. Adding another index here would be a duplicate of an existing concept.

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. claim_drive_job() — atomic claim of the next Drive job
-- ═══════════════════════════════════════════════════════════════════════════

-- Claims the oldest PENDING/RETRYING google_drive job whose backoff has
-- elapsed, plus long-stale PROCESSING rows (a crashed/timed-out worker) so a
-- job whose worker died is resumed instead of being stuck forever.
CREATE OR REPLACE FUNCTION public.claim_drive_job()
RETURNS public.replication_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    claimed_job public.replication_jobs%ROWTYPE;
BEGIN
    SELECT rj.*
    INTO claimed_job
    FROM public.replication_jobs rj
    WHERE rj.destination_type = 'google_drive'
      AND (
            (
                rj.status IN ('PENDING', 'RETRYING')
                AND (rj.next_retry_at IS NULL OR rj.next_retry_at <= now())
            )
            OR (
                -- started_at doubles as the upload heartbeat, so a job that is
                -- still being uploaded is never stolen from a live worker.
                rj.status = 'PROCESSING'
                AND rj.started_at IS NOT NULL
                AND rj.started_at < now() - interval '15 minutes'
            )
          )
    ORDER BY rj.created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    UPDATE public.replication_jobs
    SET status        = 'PROCESSING',
        attempt_count = attempt_count + 1,
        started_at    = now(),
        updated_at    = now()
    WHERE id = claimed_job.id;

    claimed_job.status        := 'PROCESSING';
    claimed_job.attempt_count := claimed_job.attempt_count + 1;
    claimed_job.started_at    := now();
    claimed_job.updated_at    := now();

    RETURN claimed_job;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. complete_drive_job() — persist the outcome of a claimed job
-- ═══════════════════════════════════════════════════════════════════════════

-- Terminal states release the resumable session; non-terminal states keep it
-- (an "uncertain" upload resumes on the same account instead of restarting).
CREATE OR REPLACE FUNCTION public.complete_drive_job(
    p_job_id              uuid,
    p_status              text,
    p_last_error          text DEFAULT NULL,
    p_drive_account_id    uuid DEFAULT NULL,
    p_drive_folder_id     uuid DEFAULT NULL,
    p_google_drive_file_id text DEFAULT NULL,
    p_next_retry_at       timestamptz DEFAULT NULL,
    p_upload_url          text DEFAULT NULL,
    p_upload_chunk        bigint DEFAULT NULL,
    p_upload_attempts     integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.replication_jobs rj
    SET status                      = COALESCE(p_status, rj.status),
        last_error                  = p_last_error,
        drive_account_id            = COALESCE(p_drive_account_id, rj.drive_account_id),
        drive_folder_id             = COALESCE(p_drive_folder_id, rj.drive_folder_id),
        google_drive_file_id        = COALESCE(p_google_drive_file_id, rj.google_drive_file_id),
        next_retry_at               = p_next_retry_at,
        google_drive_upload_url     = CASE
                                          WHEN p_upload_url IS NOT NULL THEN p_upload_url
                                          WHEN p_status IN ('COMPLETED', 'FAILED', 'SKIPPED') THEN NULL
                                          ELSE rj.google_drive_upload_url
                                      END,
        google_drive_upload_chunk   = CASE
                                          WHEN p_upload_chunk IS NOT NULL THEN p_upload_chunk
                                          WHEN p_status IN ('COMPLETED', 'FAILED', 'SKIPPED') THEN 0
                                          ELSE rj.google_drive_upload_chunk
                                      END,
        google_drive_upload_attempts = COALESCE(p_upload_attempts, rj.google_drive_upload_attempts),
        completed_at                = CASE
                                          WHEN p_status IN ('COMPLETED', 'FAILED') THEN now()
                                          ELSE rj.completed_at
                                      END,
        updated_at                  = now()
    WHERE rj.id = p_job_id
      AND rj.destination_type = 'google_drive';
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. failover_drive_replication_job() — re-queue onto another account
-- ═══════════════════════════════════════════════════════════════════════════

-- Records the failed account, clears the assignment so the router re-selects,
-- and drops the resumable session (it belonged to the previous account).
-- There is no hardcoded "A fails -> always B": the next claim goes through
-- list_eligible_drive_accounts() and skips every id in failed_drive_account_ids.
CREATE OR REPLACE FUNCTION public.failover_drive_replication_job(
    p_job_id            uuid,
    p_failed_account_id uuid,
    p_error             text DEFAULT NULL,
    p_next_retry_at     timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.replication_jobs rj
    SET failed_drive_account_ids     = CASE
                                           WHEN p_failed_account_id IS NULL THEN rj.failed_drive_account_ids
                                           WHEN p_failed_account_id = ANY (rj.failed_drive_account_ids) THEN rj.failed_drive_account_ids
                                           ELSE array_append(rj.failed_drive_account_ids, p_failed_account_id)
                                       END,
        drive_account_id             = NULL,
        drive_folder_id              = NULL,
        status                       = 'RETRYING',
        last_error                   = p_error,
        next_retry_at                = p_next_retry_at,
        google_drive_upload_url      = NULL,
        google_drive_upload_chunk    = 0,
        google_drive_upload_attempts = rj.google_drive_upload_attempts + 1,
        completed_at                 = NULL,
        updated_at                   = now()
    WHERE rj.id = p_job_id
      AND rj.destination_type = 'google_drive';
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. assign_drive_replication_job() — persist a routing decision
-- ═══════════════════════════════════════════════════════════════════════════

-- Used by the router when a job is bound to a chosen account/folder without
-- changing its status (the quota reservation is what makes the choice real).
CREATE OR REPLACE FUNCTION public.assign_drive_replication_job(
    p_job_id           uuid,
    p_drive_account_id uuid,
    p_drive_folder_id  uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.replication_jobs
    SET drive_account_id = p_drive_account_id,
        drive_folder_id  = COALESCE(p_drive_folder_id, drive_folder_id),
        updated_at       = now()
    WHERE id = p_job_id
      AND destination_type = 'google_drive';
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Lock down EXECUTE: backend (service_role) only
-- ═══════════════════════════════════════════════════════════════════════════

-- NOTE: `REVOKE ... FROM PUBLIC` alone is NOT sufficient in this project.
-- Supabase installs default privileges that grant EXECUTE on new public
-- functions to `anon` and `authenticated` at CREATE time, so those roles must
-- be revoked explicitly. Verified with has_function_privilege().
DO $$
DECLARE
    f record;
BEGIN
    FOR f IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN (
              'claim_drive_job',
              'complete_drive_job',
              'failover_drive_replication_job',
              'assign_drive_replication_job'
          )
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f.sig);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f.sig);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
    END LOOP;
END $$;
