-- ============================================================================
-- Drive Account Migration — copy-and-verify worker RPCs
-- ============================================================================
-- Backing store for the copy-and-verify phase ONLY.
--
-- This file deliberately contains NO source-deletion capability:
--   * nothing here calls authorize_drive_migration_source_deletion
--   * nothing here calls mark_drive_migration_source_deleted
--   * no function here writes source_deletion_state
--     (it stays 'NOT_ELIGIBLE' for every item, enforced by omission)
-- Source deletion is a separate, later task.
--
-- Additive changes only:
--   * one new nullable column: drive_account_migration_items.next_retry_at
--   * an extended (still closed) audit vocabulary
--   * five new functions
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Retry scheduling column
-- ---------------------------------------------------------------------------
-- Retry/backoff needs a durable "do not retry before" instant.  lease_expires_at
-- cannot express it: a failed item is not leased, so a fresh failure would be
-- claimable immediately and could hot-loop on a permanently bad file.
ALTER TABLE public.drive_account_migration_items
    ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

COMMENT ON COLUMN public.drive_account_migration_items.next_retry_at IS
    'Earliest time a failed item may be claimed again. NULL = immediately '
    'claimable (a never-attempted item).';

CREATE INDEX IF NOT EXISTS drive_account_migration_items_retry_idx
    ON public.drive_account_migration_items (migration_id, next_retry_at)
    WHERE verification_state IN ('PENDING', 'FAILED', 'COPIED');

-- ---------------------------------------------------------------------------
-- 2. Audit vocabulary — extend with the two events the worker emits
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_drive_migration_event(
    p_event_type text,
    p_migration_id uuid DEFAULT NULL,
    p_media_id uuid DEFAULT NULL,
    p_status text DEFAULT NULL,
    p_message text DEFAULT NULL,
    p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_allowed text[] := ARRAY[
        'DRIVE_MIGRATION_PLANNED',
        'DRIVE_MIGRATION_STARTED',
        'DRIVE_MIGRATION_DESTINATION_SELECTED',
        'DRIVE_MIGRATION_COPY_STARTED',
        'DRIVE_MIGRATION_COPY_COMPLETED',
        'DRIVE_MIGRATION_COPY_FAILED',
        'DRIVE_MIGRATION_DESTINATION_VERIFIED',
        'DRIVE_MIGRATION_DESTINATION_VERIFICATION_FAILED',
        'DRIVE_MIGRATION_SOURCE_DELETE_AUTHORISED',
        'DRIVE_MIGRATION_SOURCE_DELETE_COMPLETED',
        'DRIVE_MIGRATION_COMPLETED',
        'DRIVE_MIGRATION_FAILED',
        'DRIVE_ACCOUNT_RETIREMENT_AUTHORISED'
    ];
    v_id bigint;
BEGIN
    IF NOT (p_event_type = ANY (v_allowed)) THEN
        RAISE EXCEPTION 'unknown migration event type: %', p_event_type
            USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO public.sync_logs (media_id, event_type, status, message, metadata)
    VALUES (
        p_media_id,
        p_event_type,
        COALESCE(p_status, 'INFO'),
        p_message,
        COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
            'drive_migration_id', p_migration_id,
            'migration_event',    true
        )
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. Create the migration from the validated plan (PLANNED -> RUNNING)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_drive_account_migration(
    p_source_drive_account_id uuid,
    p_destination_health jsonb DEFAULT NULL,
    p_requested_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_plan          jsonb;
    v_required      bigint;
    v_media_count   integer;
    v_allocations   jsonb;
    v_dest_ids      uuid[];
    v_reserved      bigint;
    v_migration_id  uuid;
    v_items         integer := 0;
BEGIN
    -- Revalidate immediately before creating anything.  A stale plan must not
    -- start a copy.
    v_plan := public.plan_drive_migration_dry_run(p_source_drive_account_id, p_destination_health);

    IF (v_plan ->> 'verdict') IS DISTINCT FROM 'FEASIBLE' THEN
        RETURN jsonb_build_object(
            'created', false,
            'verdict', 'BLOCKED',
            'reasons', COALESCE(v_plan -> 'reasons', jsonb_build_array('PLAN_NOT_FEASIBLE')),
            'safety_checks', v_plan -> 'safety_checks'
        );
    END IF;

    v_required    := (v_plan -> 'population' ->> 'total_required_bytes')::bigint;
    v_media_count := (v_plan -> 'population' ->> 'media_count')::int;
    v_allocations := v_plan -> 'allocations';

    SELECT COALESCE(array_agg((a ->> 'drive_account_id')::uuid), ARRAY[]::uuid[]),
           COALESCE(sum((a ->> 'allocated_bytes')::bigint), 0)
    INTO v_dest_ids, v_reserved
    FROM jsonb_array_elements(v_allocations) a;

    -- At most one non-terminal migration per source is enforced by a partial
    -- unique index; surface it as a clean BLOCKED rather than a raw error.
    IF EXISTS (
        SELECT 1 FROM public.drive_account_migrations m
        WHERE m.source_drive_account_id = p_source_drive_account_id
          AND m.status IN ('PLANNED','RUNNING','PAUSED','BLOCKED')
    ) THEN
        RETURN jsonb_build_object(
            'created', false,
            'verdict', 'BLOCKED',
            'reasons', jsonb_build_array('MIGRATION_ALREADY_ACTIVE_FOR_SOURCE')
        );
    END IF;

    INSERT INTO public.drive_account_migrations (
        source_drive_account_id, status, requested_by,
        total_media_count, total_expected_bytes, reserved_bytes,
        destination_account_ids, started_at
    ) VALUES (
        p_source_drive_account_id, 'PLANNED', p_requested_by,
        v_media_count, v_required, v_reserved,
        v_dest_ids, now()
    )
    RETURNING id INTO v_migration_id;

    -- Items: source provenance copied verbatim, destination initialised to the
    -- account the planner chose.  destination file id / folder id / md5 stay
    -- NULL until the worker actually produces them.
    -- source_deletion_state is left at its default 'NOT_ELIGIBLE'.
    INSERT INTO public.drive_account_migration_items (
        migration_id, media_id,
        source_drive_account_id, source_drive_folder_id,
        source_google_drive_file_id, source_file_name,
        source_size_bytes, source_md5,
        destination_drive_account_id,
        verification_state, source_deletion_state
    )
    SELECT
        v_migration_id,
        i.out_media_id,
        p_source_drive_account_id,
        i.out_source_drive_folder_id,
        i.out_source_google_drive_file_id,
        i.out_source_file_name,
        i.out_source_size_bytes,
        i.out_source_md5,
        i.out_destination_drive_account_id,
        'PENDING',
        'NOT_ELIGIBLE'
    FROM public.plan_drive_migration_items(p_source_drive_account_id, v_allocations) i
    WHERE i.out_destination_drive_account_id IS NOT NULL;

    GET DIAGNOSTICS v_items = ROW_COUNT;

    -- PLANNED -> RUNNING (the state model's controlled transition)
    UPDATE public.drive_account_migrations
    SET status     = 'RUNNING',
        started_at = now(),
        updated_at = now()
    WHERE id = v_migration_id;

    -- Bind the retirement guard: the source is now off-limits as a destination.
    PERFORM public.set_drive_account_retiring(p_source_drive_account_id, v_migration_id);

    PERFORM public.refresh_drive_account_migration_counters(v_migration_id);

    PERFORM public.log_drive_migration_event(
        'DRIVE_MIGRATION_PLANNED', v_migration_id, NULL, 'INFO',
        'migration created from validated dry-run plan',
        jsonb_build_object(
            'source_drive_account_id', p_source_drive_account_id,
            'destination_account_ids', to_jsonb(v_dest_ids),
            'media_count', v_media_count,
            'total_expected_bytes', v_required
        )
    );
    PERFORM public.log_drive_migration_event(
        'DRIVE_MIGRATION_STARTED', v_migration_id, NULL, 'INFO',
        'PLANNED -> RUNNING; copy-and-verify phase only, source deletion is NOT part of this phase',
        jsonb_build_object('items_created', v_items)
    );

    RETURN jsonb_build_object(
        'created', true,
        'migration_id', v_migration_id,
        'status', 'RUNNING',
        'media_count', v_media_count,
        'items_created', v_items,
        'total_required_bytes', v_required,
        'reserved_bytes', v_reserved,
        'destination_account_ids', to_jsonb(v_dest_ids)
    );
END;
$fn$;

COMMENT ON FUNCTION public.create_drive_account_migration(uuid, jsonb, uuid) IS
    'Creates migration items from the validated dry-run plan and transitions '
    'PLANNED -> RUNNING.  Refuses (BLOCKED, creates nothing) when the plan is '
    'stale or infeasible.';

-- ---------------------------------------------------------------------------
-- 4. Claim one item (lease + SKIP LOCKED, mirrors claim_drive_job)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_drive_migration_item(
    p_migration_id uuid,
    p_worker_owner text DEFAULT 'worker',
    p_lease_minutes integer DEFAULT 15
)
RETURNS SETOF drive_account_migration_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    claimed public.drive_account_migration_items%ROWTYPE;
BEGIN
    SELECT i.*
    INTO claimed
    FROM public.drive_account_migration_items i
    WHERE i.migration_id = p_migration_id
      AND (
            -- never attempted, or retry window has opened
            (i.verification_state IN ('PENDING','FAILED')
             AND (i.next_retry_at IS NULL OR i.next_retry_at <= now())
             AND (i.lease_expires_at IS NULL OR i.lease_expires_at < now()))
            -- uploaded but not yet verified: must be verified, never re-uploaded
            OR (i.verification_state = 'COPIED'
                AND (i.lease_expires_at IS NULL OR i.lease_expires_at < now()))
            -- a worker died holding it
            OR (i.verification_state = 'COPYING'
                AND i.lease_expires_at IS NOT NULL
                AND i.lease_expires_at < now())
          )
      AND i.verification_state <> 'VERIFIED'          -- idempotent: never redo
      AND i.verification_state <> 'BLOCKED'           -- needs a human decision
    ORDER BY i.created_at ASC, i.id ASC               -- deterministic continuation
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    UPDATE public.drive_account_migration_items
    SET lease_owner       = p_worker_owner,
        lease_expires_at  = now() + make_interval(mins => GREATEST(p_lease_minutes, 1)),
        attempt_count     = attempt_count + 1,
        -- A COPIED item keeps COPIED: the bytes are already at the destination
        -- and re-uploading would create a duplicate.
        verification_state = CASE
            WHEN verification_state = 'COPIED' THEN 'COPIED'
            ELSE 'COPYING'
        END,
        updated_at        = now()
    WHERE id = claimed.id;

    claimed.lease_owner            := p_worker_owner;
    claimed.lease_expires_at       := now() + make_interval(mins => GREATEST(p_lease_minutes, 1));
    claimed.attempt_count          := claimed.attempt_count + 1;
    claimed.verification_state     := CASE
        WHEN claimed.verification_state = 'COPIED' THEN 'COPIED' ELSE 'COPYING' END;

    RETURN NEXT claimed;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Persist an item result
-- ---------------------------------------------------------------------------
-- Deliberately cannot touch source_* or source_deletion_state.  There is no
-- parameter for them, so no caller can authorize a source deletion here.
CREATE OR REPLACE FUNCTION public.complete_drive_migration_item(
    p_item_id uuid,
    p_verification_state text,
    p_destination_drive_account_id uuid DEFAULT NULL,
    p_destination_drive_folder_id uuid DEFAULT NULL,
    p_destination_google_drive_file_id text DEFAULT NULL,
    p_destination_file_name text DEFAULT NULL,
    p_destination_size_bytes bigint DEFAULT NULL,
    p_destination_md5 text DEFAULT NULL,
    p_last_error text DEFAULT NULL,
    p_next_retry_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_item public.drive_account_migration_items%ROWTYPE;
BEGIN
    IF p_verification_state NOT IN ('PENDING','COPYING','COPIED','VERIFIED','FAILED','BLOCKED') THEN
        RAISE EXCEPTION 'invalid verification_state: %', p_verification_state
            USING ERRCODE = 'check_violation';
    END IF;

    -- A failed/blocked item must carry a reason; an uncertain upload must keep
    -- whatever file id we already know so reconciliation can use it.
    UPDATE public.drive_account_migration_items
    SET verification_state              = p_verification_state,
        destination_drive_account_id    = COALESCE(p_destination_drive_account_id, destination_drive_account_id),
        destination_drive_folder_id     = COALESCE(p_destination_drive_folder_id, destination_drive_folder_id),
        destination_google_drive_file_id = COALESCE(p_destination_google_drive_file_id, destination_google_drive_file_id),
        destination_file_name           = COALESCE(p_destination_file_name, destination_file_name),
        destination_size_bytes          = COALESCE(p_destination_size_bytes, destination_size_bytes),
        destination_md5                 = COALESCE(p_destination_md5, destination_md5),
        copied_at                       = CASE
            WHEN p_verification_state IN ('COPIED','VERIFIED') THEN COALESCE(copied_at, now())
            ELSE copied_at END,
        verified_at                     = CASE
            WHEN p_verification_state = 'VERIFIED' THEN now()
            ELSE verified_at END,
        last_error                      = CASE
            WHEN p_verification_state IN ('FAILED','BLOCKED') THEN p_last_error
            ELSE NULL END,
        last_error_at                   = CASE
            WHEN p_verification_state IN ('FAILED','BLOCKED') THEN now()
            ELSE last_error_at END,
        next_retry_at                   = CASE
            WHEN p_verification_state IN ('FAILED') THEN COALESCE(p_next_retry_at, now() + interval '60 seconds')
            ELSE NULL END,
        lease_owner                     = NULL,
        lease_expires_at                = NULL,
        updated_at                      = now()
    WHERE id = p_item_id
    RETURNING * INTO v_item;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('updated', false, 'reasons', jsonb_build_array('item_not_found'));
    END IF;

    RETURN jsonb_build_object(
        'updated', true,
        'item_id', v_item.id,
        'verification_state', v_item.verification_state,
        'source_deletion_state', v_item.source_deletion_state,
        'destination_google_drive_file_id', v_item.destination_google_drive_file_id,
        'attempt_count', v_item.attempt_count
    );
END;
$fn$;

COMMENT ON FUNCTION public.complete_drive_migration_item(uuid, text, uuid, uuid, text, text, bigint, text, text, timestamptz) IS
    'Persists copy/verify outcome. Cannot modify source provenance or '
    'source_deletion_state by construction — there is no parameter for them.';

-- ---------------------------------------------------------------------------
-- 6. Finalize — COMPLETED only when every item is VERIFIED
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_drive_account_migration(
    p_migration_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_total       integer;
    v_verified    integer;
    v_blocked     integer;
    v_not_verified integer;
    v_counters    jsonb;
BEGIN
    PERFORM public.refresh_drive_account_migration_counters(p_migration_id);

    SELECT count(*)::int,
           count(*) FILTER (WHERE verification_state = 'VERIFIED')::int,
           count(*) FILTER (WHERE verification_state = 'BLOCKED')::int
    INTO v_total, v_verified, v_blocked
    FROM public.drive_account_migration_items
    WHERE migration_id = p_migration_id;

    v_not_verified := v_total - v_verified;

    IF v_total = 0 THEN
        RETURN jsonb_build_object(
            'finalized', false, 'reasons', jsonb_build_array('NO_ITEMS'));
    END IF;

    IF v_not_verified > 0 THEN
        RETURN jsonb_build_object(
            'finalized', false,
            'reasons', jsonb_build_array('ITEMS_NOT_VERIFIED'),
            'total_items', v_total,
            'verified_items', v_verified,
            'not_verified_items', v_not_verified,
            'blocked_items', v_blocked
        );
    END IF;

    UPDATE public.drive_account_migrations
    SET status       = 'COMPLETED',
        completed_at = now(),
        updated_at   = now()
    WHERE id = p_migration_id
      AND status = 'RUNNING';

    v_counters := public.refresh_drive_account_migration_counters(p_migration_id);

    PERFORM public.log_drive_migration_event(
        'DRIVE_MIGRATION_COMPLETED', p_migration_id, NULL, 'OK',
        'every item VERIFIED at the destination; source files intentionally left in place',
        jsonb_build_object(
            'verified_items', v_verified,
            'note', 'copy-and-verify phase complete; source deletion is a separate task'
        )
    );

    RETURN jsonb_build_object(
        'finalized', true,
        'status', 'COMPLETED',
        'verified_items', v_verified,
        'counters', v_counters
    );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. Progress report
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drive_migration_progress(
    p_migration_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v public.drive_account_migrations%ROWTYPE;
    v_result jsonb;
BEGIN
    SELECT * INTO v FROM public.drive_account_migrations WHERE id = p_migration_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('found', false);
    END IF;

    SELECT jsonb_build_object(
        'found', true,
        'migration_id', v.id,
        'status', v.status,
        'source_drive_account_id', v.source_drive_account_id,
        'destination_account_ids', to_jsonb(v.destination_account_ids),
        'total_media_count', v.total_media_count,
        'total_expected_bytes', v.total_expected_bytes,
        'items_by_state', COALESCE((
            SELECT jsonb_object_agg(verification_state, n)
            FROM (
                SELECT verification_state, count(*)::int AS n
                FROM public.drive_account_migration_items
                WHERE migration_id = p_migration_id
                GROUP BY verification_state
            ) s), '{}'::jsonb),
        'items_by_deletion_state', COALESCE((
            SELECT jsonb_object_agg(source_deletion_state, n)
            FROM (
                SELECT source_deletion_state, count(*)::int AS n
                FROM public.drive_account_migration_items
                WHERE migration_id = p_migration_id
                GROUP BY source_deletion_state
            ) s), '{}'::jsonb),
        'verified_count', (SELECT count(*)::int FROM public.drive_account_migration_items
                           WHERE migration_id = p_migration_id AND verification_state = 'VERIFIED'),
        'verified_bytes', (SELECT COALESCE(sum(source_size_bytes),0)::bigint
                           FROM public.drive_account_migration_items
                           WHERE migration_id = p_migration_id AND verification_state = 'VERIFIED'),
        'failed_count', (SELECT count(*)::int FROM public.drive_account_migration_items
                         WHERE migration_id = p_migration_id AND verification_state = 'FAILED'),
        'blocked_count', (SELECT count(*)::int FROM public.drive_account_migration_items
                          WHERE migration_id = p_migration_id AND verification_state = 'BLOCKED'),
        'source_deleted_count', (SELECT count(*)::int FROM public.drive_account_migration_items
                                 WHERE migration_id = p_migration_id AND source_deletion_state = 'SOURCE_DELETED'),
        'source_delete_authorised_count', (SELECT count(*)::int FROM public.drive_account_migration_items
                                           WHERE migration_id = p_migration_id
                                             AND source_delete_authorised_at IS NOT NULL)
    ) INTO v_result;

    RETURN v_result;
END;
$fn$;

COMMIT;
