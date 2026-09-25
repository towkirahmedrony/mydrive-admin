-- ============================================================================
-- Drive Account Migration — destination planner + account lifecycle state
-- ============================================================================
-- Additive. Read-only planner: it computes a plan and returns it.  It does NOT
-- reserve real Drive quota, does NOT create folders and does NOT write to
-- drive_accounts.  Reservation here is a logical figure held on the migration
-- row; only a future worker consumes real quota (reserve_drive_account()).
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Account lifecycle state
-- ---------------------------------------------------------------------------
-- Distinguishes the three states the guard must tell apart, using the
-- dedicated retiring_migration_id column rather than overloading status.
CREATE OR REPLACE FUNCTION public.drive_account_retirement_state(
    p_drive_account_id uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_acct        public.drive_accounts%ROWTYPE;
    v_mig_status  text;
BEGIN
    IF p_drive_account_id IS NULL THEN
        RETURN 'MISSING';
    END IF;

    SELECT * INTO v_acct FROM public.drive_accounts WHERE id = p_drive_account_id;
    IF NOT FOUND THEN
        RETURN 'MISSING';
    END IF;

    -- Participating as a migration source / actively being retired.
    IF v_acct.retiring_migration_id IS NOT NULL THEN
        SELECT m.status INTO v_mig_status
        FROM public.drive_account_migrations m
        WHERE m.id = v_acct.retiring_migration_id;

        IF v_mig_status = 'COMPLETED' THEN
            RETURN 'RETIRED';
        ELSIF v_mig_status = 'CANCELLED' THEN
            RETURN 'ACTIVE';          -- a cancelled retirement releases the account
        ELSE
            RETURN 'RETIRING';
        END IF;
    END IF;

    -- Source of a live migration that has not (yet) been bound to the guard.
    IF EXISTS (
        SELECT 1 FROM public.drive_account_migrations m
        WHERE m.source_drive_account_id = v_acct.id
          AND m.status IN ('PLANNED','RUNNING','PAUSED','BLOCKED')
    ) THEN
        RETURN 'MIGRATION_SOURCE';
    END IF;

    IF v_acct.status = 'disabled' THEN
        RETURN 'RETIRED';
    END IF;

    RETURN 'ACTIVE';
END;
$fn$;

COMMENT ON FUNCTION public.drive_account_retirement_state(uuid) IS
    'ACTIVE | MIGRATION_SOURCE | RETIRING | RETIRED | MISSING. The authoritative '
    'lifecycle query for the retirement guard.';

-- ---------------------------------------------------------------------------
-- 2. Eligibility: exclude accounts being retired
-- ---------------------------------------------------------------------------
-- Recreated from the deployed definition with ONE additive predicate:
--   AND da.retiring_migration_id IS NULL
-- Both live accounts currently have retiring_migration_id IS NULL, so
-- behaviour today is bit-for-bit identical to the previous version; the
-- existing replication worker is unaffected.  Going forward it correctly stops
-- an account that is being retired from being handed new work.
CREATE OR REPLACE FUNCTION public.list_eligible_drive_accounts(
    p_required_bytes bigint DEFAULT 0,
    p_exclude_account_ids uuid[] DEFAULT '{}'::uuid[],
    p_safety_margin_bytes bigint DEFAULT NULL::bigint
)
RETURNS SETOF drive_accounts
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_margin bigint;
    v_req    bigint := GREATEST(COALESCE(p_required_bytes, 0), 0);
BEGIN
    SELECT COALESCE(
               p_safety_margin_bytes,
               (SELECT drive_safety_margin_bytes FROM public.app_settings WHERE id = true),
               1073741824
           )
    INTO v_margin;

    RETURN QUERY
    SELECT da.*
    FROM public.drive_accounts da
    CROSS JOIN LATERAL (
        SELECT COALESCE(
                   da.storage_available_bytes,
                   CASE WHEN da.storage_limit_bytes IS NOT NULL
                        THEN GREATEST(da.storage_limit_bytes - COALESCE(da.storage_used_bytes, 0), 0)
                        ELSE NULL END
               ) AS effective_available
    ) av
    WHERE da.enabled = true
      AND da.status = 'active'
      AND da.connection_status IN ('connected', 'unknown')
      AND da.health_status IN ('healthy', 'unknown')
      AND da.retiring_migration_id IS NULL              -- NEW: not being retired
      AND NOT (da.id = ANY (COALESCE(p_exclude_account_ids, '{}'::uuid[])))
      AND av.effective_available IS NOT NULL
      AND av.effective_available - v_req - COALESCE(da.reserved_bytes, 0) >= v_margin
    ORDER BY da.priority ASC,
             (av.effective_available - v_req) DESC,
             da.last_quota_check_at ASC NULLS FIRST,
             da.created_at ASC;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Planner
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.plan_drive_account_migration(
    p_source_drive_account_id uuid,
    p_safety_margin_bytes bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_margin       bigint;
    v_required     bigint := 0;
    v_media_count  integer := 0;
    v_remaining    bigint;
    v_source_state text;
    v_candidates   jsonb := '[]'::jsonb;
    v_allocations  jsonb := '[]'::jsonb;
    v_alloc_total  bigint := 0;
    v_first_usable bigint := 0;
    v_rec          record;
    v_pending      bigint;
    v_usable       bigint;
    v_take         bigint;
    v_reasons      text[] := ARRAY[]::text[];
BEGIN
    SELECT COALESCE(
               p_safety_margin_bytes,
               (SELECT drive_safety_margin_bytes FROM public.app_settings WHERE id = true),
               1073741824
           )
    INTO v_margin;

    v_source_state := public.drive_account_retirement_state(p_source_drive_account_id);

    -- Authoritative population, derived from production state (never supplied
    -- by a caller): completed Drive replication jobs owned by the source
    -- account, with a real Drive file id.
    SELECT COALESCE(sum(ma.file_size), 0)::bigint, count(*)::int
    INTO v_required, v_media_count
    FROM public.replication_jobs rj
    JOIN public.media_assets ma ON ma.id = rj.media_id
    WHERE rj.destination_type = 'google_drive'
      AND rj.status = 'COMPLETED'
      AND rj.google_drive_file_id IS NOT NULL
      AND rj.drive_account_id = p_source_drive_account_id;

    v_remaining := v_required;

    IF v_source_state = 'MISSING' THEN
        v_reasons := array_append(v_reasons, 'source_account_missing');
    ELSIF v_source_state = 'RETIRING' OR v_source_state = 'RETIRED' THEN
        v_reasons := array_append(v_reasons, 'source_account_already_retiring');
    END IF;

    IF v_media_count = 0 THEN
        v_reasons := array_append(v_reasons, 'no_migratable_media');
    END IF;

    FOR v_rec IN
        SELECT da.id,
               da.google_email,
               da.priority,
               da.reserved_bytes,
               da.last_quota_check_at,
               da.created_at,
               da.health_status,
               da.connection_status,
               av.effective_available,
               COALESCE((
                   SELECT sum(m.reserved_bytes)
                   FROM public.drive_account_migrations m
                   WHERE m.status IN ('PLANNED','RUNNING','PAUSED','BLOCKED')
                     AND da.id = ANY (m.destination_account_ids)
               ), 0)::bigint AS pending_migration_reservation,
               COALESCE((
                   SELECT count(*)::int
                   FROM public.drive_account_migration_items i
                   WHERE i.destination_drive_account_id = da.id
                     AND i.verification_state = 'COPYING'
               ), 0) AS active_items
        FROM public.drive_accounts da
        CROSS JOIN LATERAL (
            SELECT COALESCE(
                       da.storage_available_bytes,
                       CASE WHEN da.storage_limit_bytes IS NOT NULL
                            THEN GREATEST(da.storage_limit_bytes - COALESCE(da.storage_used_bytes, 0), 0)
                            ELSE NULL END
                   ) AS effective_available
        ) av
        WHERE da.enabled = true
          AND da.status = 'active'
          AND da.connection_status IN ('connected', 'unknown')
          AND da.health_status IN ('healthy', 'unknown')
          AND da.retiring_migration_id IS NULL
          AND da.id <> p_source_drive_account_id
          AND av.effective_available IS NOT NULL
        ORDER BY da.priority ASC,
                 (av.effective_available - COALESCE(da.reserved_bytes, 0)) DESC,
                 da.last_quota_check_at ASC NULLS FIRST,
                 da.created_at ASC
    LOOP
        -- capacity available to THIS migration on THIS account, after its own
        -- reserved_bytes, other active migrations' logical reservations, and
        -- the safety margin which must remain free afterwards
        v_pending := COALESCE(v_rec.reserved_bytes, 0) + COALESCE(v_rec.pending_migration_reservation, 0);
        v_usable  := GREATEST(v_rec.effective_available - v_pending - v_margin, 0);

        v_candidates := v_candidates || jsonb_build_object(
            'drive_account_id',            v_rec.id,
            'google_email',                v_rec.google_email,
            'priority',                    v_rec.priority,
            'health_status',               v_rec.health_status,
            'connection_status',           v_rec.connection_status,
            'effective_available_bytes',   v_rec.effective_available,
            'reserved_bytes',              COALESCE(v_rec.reserved_bytes, 0),
            'pending_migration_reservation_bytes', v_rec.pending_migration_reservation,
            'safety_margin_bytes',         v_margin,
            'usable_bytes',                v_usable,
            'active_migration_items',      v_rec.active_items,
            'last_quota_check_at',         v_rec.last_quota_check_at
        );

        IF v_alloc_total = 0 THEN
            v_first_usable := v_usable;
        END IF;

        IF v_remaining > 0 AND v_usable > 0 THEN
            v_take := LEAST(v_usable, v_remaining);
            v_allocations := v_allocations || jsonb_build_object(
                'drive_account_id', v_rec.id,
                'google_email',     v_rec.google_email,
                'allocated_bytes',  v_take
            );
            v_alloc_total := v_alloc_total + v_take;
            v_remaining   := v_remaining - v_take;
        END IF;
    END LOOP;

    IF v_remaining > 0 THEN
        v_reasons := array_append(v_reasons, 'insufficient_destination_capacity');
    END IF;

    RETURN jsonb_build_object(
        'source_drive_account_id',      p_source_drive_account_id,
        'source_account_state',         v_source_state,
        'source_media_count',           v_media_count,
        'required_bytes',               v_required,
        'safety_margin_bytes',          v_margin,
        'reserved_bytes',               v_alloc_total,
        'allocated_bytes',              v_alloc_total,
        'shortfall_bytes',              GREATEST(v_remaining, 0),
        'feasible',                     (v_remaining <= 0 AND v_media_count > 0
                                         AND v_source_state NOT IN ('MISSING','RETIRING','RETIRED')),
        'single_account_sufficient',    (v_first_usable >= v_required AND v_required > 0),
        'destination_count',            jsonb_array_length(v_allocations),
        'candidates',                   v_candidates,
        'allocations',                  v_allocations,
        'reasons',                      to_jsonb(v_reasons),
        'planned_at',                   now()
    );
END;
$fn$;

COMMENT ON FUNCTION public.plan_drive_account_migration(uuid, bigint) IS
    'Destination planner. Derives the migration population from production DB '
    'state, checks complete-migration feasibility and allocates capacity across '
    'one or more healthy destination accounts. Read-only: reserves no real '
    'Drive quota and writes nothing.';

COMMIT;
