-- ============================================================================
-- Drive Account Migration — dry-run planner test suite
-- ============================================================================
-- Runs inside ONE transaction that always ROLLBACKs, so it is safe against
-- production: every account it creates, mutates or deletes is undone.
--
--   BEGIN; ... SELECT ... FROM dry_run_results; ROLLBACK;
-- ============================================================================

BEGIN;

CREATE TEMP TABLE dry_run_results (
    n        integer,
    scenario text,
    ok       boolean,
    detail   text
);

CREATE FUNCTION pg_temp.record(p_n integer, p_scenario text, p_ok boolean, p_detail text)
RETURNS void LANGUAGE sql AS $fn$
    INSERT INTO dry_run_results VALUES (p_n, p_scenario, p_ok, p_detail);
$fn$;

-- Fixtures resolved from live production state ------------------------------
CREATE TEMP TABLE fx AS
SELECT
    (SELECT id FROM public.drive_accounts WHERE google_email = 'towkir750@gmail.com') AS src,
    (SELECT id FROM public.drive_accounts WHERE google_email = 'towkir342@gmail.com') AS dst;

-- Normalise the source account to the clean slate this suite assumes.
-- Production may legitimately carry a live migration now (the copy worker
-- creates one), so clear it here. Everything below happens inside the
-- transaction that is rolled back, so nothing is actually changed.
UPDATE public.drive_accounts SET retiring_migration_id = NULL
WHERE id = (SELECT src FROM fx);
DELETE FROM public.drive_account_migrations
WHERE source_drive_account_id = (SELECT src FROM fx);

-- Pristine values so each scenario can restore them.
CREATE TEMP TABLE fx_pristine AS
SELECT id, health_status, connection_status, status, enabled,
       storage_available_bytes, storage_limit_bytes, storage_used_bytes, reserved_bytes
FROM public.drive_accounts;

-- Health payload builder: verified observation for one account.
CREATE FUNCTION pg_temp.health_for(p_account_id uuid, p_email text, p_permission_id text, p_available text)
RETURNS jsonb LANGUAGE sql AS $fn$
    SELECT jsonb_build_object(p_account_id::text, jsonb_build_object(
        'verified', true, 'email', p_email,
        'permission_id', p_permission_id,
        'storage_available_bytes', p_available,
        'checked_at', now()::text, 'error', NULL));
$fn$;

-- Baseline health payload for the two real accounts (no mutating scenario yet).
CREATE TEMP TABLE fx_health AS
SELECT jsonb_build_object(
    (SELECT src FROM fx)::text, jsonb_build_object(
        'verified', true, 'email', 'towkir750@gmail.com',
        'permission_id', '16924252089058675997',
        'storage_available_bytes', '5494734223975', 'checked_at', now()::text, 'error', NULL),
    (SELECT dst FROM fx)::text, jsonb_build_object(
        'verified', true, 'email', 'towkir342@gmail.com',
        'permission_id', '03586478075243744004',
        'storage_available_bytes', '5497557572435', 'checked_at', now()::text, 'error', NULL)
) AS health;

CREATE FUNCTION pg_temp.restore_accounts()
RETURNS void LANGUAGE sql AS $fn$
    UPDATE public.drive_accounts da
    SET health_status = p.health_status,
        connection_status = p.connection_status,
        status = p.status,
        enabled = p.enabled,
        storage_available_bytes = p.storage_available_bytes,
        storage_limit_bytes = p.storage_limit_bytes,
        storage_used_bytes = p.storage_used_bytes,
        reserved_bytes = p.reserved_bytes
    FROM fx_pristine p
    WHERE da.id = p.id;
$fn$;

-- ===========================================================================
-- 1. One destination with sufficient capacity
-- ===========================================================================
DO $blk$
DECLARE v_src uuid; v_h jsonb; v_plan jsonb; v_d text;
BEGIN
    SELECT f.src, h.health INTO v_src, v_h FROM fx f, fx_health h;
    PERFORM pg_temp.restore_accounts();

    v_plan := public.plan_drive_migration_dry_run(v_src, v_h);
    v_d := v_plan -> 'destinations' -> 0 ->> 'reason';

    PERFORM pg_temp.record(
        1, 'one destination with sufficient capacity',
        (v_plan ->> 'verdict') = 'FEASIBLE'
          AND jsonb_array_length(v_plan -> 'allocations') = 1
          AND (v_plan ->> 'allocated_bytes')::bigint = (v_plan -> 'population' ->> 'total_required_bytes')::bigint
          AND v_d = 'SELECTED',
        'verdict=' || (v_plan ->> 'verdict') || ' allocations=' ||
          jsonb_array_length(v_plan -> 'allocations')::text
    );
END $blk$;

-- ===========================================================================
-- 2. Multiple destinations required (splitting)
-- ===========================================================================
DO $blk$
DECLARE
    v_src uuid; v_dst uuid; v_b uuid;
    v_cap bigint := 1073741824 + 400000000;   -- margin + 400 MB usable
    v_h jsonb; v_plan jsonb; v_a jsonb;
BEGIN
    SELECT src, dst INTO v_src, v_dst FROM fx;

    UPDATE public.drive_accounts
    SET storage_available_bytes = v_cap, reserved_bytes = 0
    WHERE id = v_dst;

    INSERT INTO public.drive_accounts (
        name, google_email, refresh_token_secret_id, status, enabled,
        connection_status, health_status, priority,
        storage_limit_bytes, storage_used_bytes, storage_available_bytes,
        reserved_bytes, created_at, updated_at
    ) VALUES (
        'DryRun Test B', 'dryrun-split-b@example.invalid', gen_random_uuid(),
        'active', true, 'connected', 'healthy', 200,
        10000000000, 0, v_cap, 0, now(), now()
    ) RETURNING id INTO v_b;

    v_h := jsonb_build_object(
        v_dst::text, jsonb_build_object('verified', true, 'email', 'towkir342@gmail.com',
            'permission_id', '03586478075243744004', 'storage_available_bytes', v_cap::text,
            'checked_at', now()::text, 'error', NULL),
        v_b::text, jsonb_build_object('verified', true, 'email', 'dryrun-split-b@example.invalid',
            'permission_id', NULL, 'storage_available_bytes', v_cap::text,
            'checked_at', now()::text, 'error', NULL)
    );

    v_plan := public.plan_drive_migration_dry_run(v_src, v_h);
    v_a    := v_plan -> 'allocations';

    PERFORM pg_temp.record(
        2, 'multiple destinations required',
        (v_plan ->> 'verdict') = 'FEASIBLE'
          AND jsonb_array_length(v_a) = 2
          AND (v_a -> 0 ->> 'allocated_bytes')::bigint = 400000000
          AND (v_a -> 1 ->> 'allocated_bytes')::bigint = 242524522
          AND (v_plan ->> 'single_account_sufficient')::boolean = false,
        'destinations=' || jsonb_array_length(v_a)::text ||
          ' split=' || (v_a -> 0 ->> 'allocated_bytes') || '+' || (v_a -> 1 ->> 'allocated_bytes')
    );

    -- also proves the per-media plan splits across both accounts
    PERFORM pg_temp.record(
        3, 'per-media plan splits across both destinations',
        (SELECT count(DISTINCT out_destination_drive_account_id)
         FROM public.plan_drive_migration_items(v_src, v_a)) = 2,
        'distinct destinations in per-media plan'
    );

    DELETE FROM public.drive_accounts WHERE id = v_b;
END $blk$;

-- ===========================================================================
-- 4. Insufficient total capacity
-- ===========================================================================
DO $blk$
DECLARE v_src uuid; v_dst uuid; v_h jsonb; v_plan jsonb;
BEGIN
    SELECT src, dst INTO v_src, v_dst FROM fx;
    UPDATE public.drive_accounts SET storage_available_bytes = 100000000 WHERE id = v_dst;

    v_h := jsonb_build_object(v_dst::text, jsonb_build_object(
        'verified', true, 'email', 'towkir342@gmail.com',
        'permission_id', '03586478075243744004',
        'storage_available_bytes', '100000000', 'checked_at', now()::text, 'error', NULL));

    v_plan := public.plan_drive_migration_dry_run(v_src, v_h);
    PERFORM pg_temp.record(
        4, 'insufficient total capacity blocks the plan',
        (v_plan ->> 'verdict') = 'BLOCKED'
          AND v_plan -> 'reasons' @> '["INSUFFICIENT_CAPACITY"]'::jsonb
          AND (v_plan ->> 'shortfall_bytes')::bigint > 0,
        'shortfall=' || (v_plan ->> 'shortfall_bytes')
    );

    PERFORM pg_temp.restore_accounts();
END $blk$;

-- ===========================================================================
-- 5. Destination health unknown (no fresh verification supplied)
-- ===========================================================================
DO $blk$
DECLARE v_src uuid; v_plan jsonb; v_plan_null jsonb;
BEGIN
    SELECT src INTO v_src FROM fx;

    -- fresh verification reported the account as NOT verified
    v_plan := public.plan_drive_migration_dry_run(
        v_src,
        jsonb_build_object((SELECT dst FROM fx)::text, jsonb_build_object(
            'verified', false, 'error', 'credential_unavailable')));

    PERFORM pg_temp.record(
        5, 'destination health unknown is not assumed usable',
        (v_plan ->> 'verdict') = 'BLOCKED'
          AND v_plan -> 'reasons' @> '["DESTINATION_HEALTH_UNKNOWN"]'::jsonb
          AND (v_plan -> 'destinations' -> 0 ->> 'reason') = 'DESTINATION_HEALTH_UNKNOWN'
          AND (v_plan -> 'destinations' -> 0 ->> 'selected') = 'false',
        'reasons=' || (v_plan -> 'reasons')::text
    );

    -- and no health input at all must behave the same way
    v_plan_null := public.plan_drive_migration_dry_run(v_src, NULL);
    PERFORM pg_temp.record(
        6, 'absent health input yields BLOCKED, never a silent FEASIBLE',
        (v_plan_null ->> 'verdict') = 'BLOCKED'
          AND v_plan_null -> 'reasons' @> '["DESTINATION_HEALTH_UNKNOWN"]'::jsonb
          AND (v_plan_null ->> 'fresh_health_supplied') = 'false',
        'verdict=' || (v_plan_null ->> 'verdict')
    );
END $blk$;

-- ===========================================================================
-- 7/8/9. Unhealthy / quota-full / connection-broken destinations
-- ===========================================================================
DO $blk$
DECLARE v_src uuid; v_dst uuid; v_h jsonb; v_plan jsonb; v_reason text;
BEGIN
    SELECT f.src, f.dst, h.health INTO v_src, v_dst, v_h FROM fx f, fx_health h;

    UPDATE public.drive_accounts SET health_status = 'unhealthy' WHERE id = v_dst;
    v_plan := public.plan_drive_migration_dry_run(v_src, v_h);
    v_reason := v_plan -> 'destinations' -> 0 ->> 'reason';
    PERFORM pg_temp.record(
        7, 'unhealthy destination is excluded',
        (v_plan ->> 'verdict') = 'BLOCKED' AND v_reason = 'DESTINATION_HEALTH_UNHEALTHY',
        'reason=' || v_reason
    );

    UPDATE public.drive_accounts SET health_status = 'healthy', status = 'quota_full' WHERE id = v_dst;
    v_plan := public.plan_drive_migration_dry_run(v_src, v_h);
    v_reason := v_plan -> 'destinations' -> 0 ->> 'reason';
    PERFORM pg_temp.record(
        8, 'quota-full destination is excluded',
        (v_plan ->> 'verdict') = 'BLOCKED' AND v_reason = 'DESTINATION_STATUS_QUOTA_FULL',
        'reason=' || v_reason
    );

    UPDATE public.drive_accounts SET status = 'reauth_required' WHERE id = v_dst;
    v_plan := public.plan_drive_migration_dry_run(v_src, v_h);
    v_reason := v_plan -> 'destinations' -> 0 ->> 'reason';
    PERFORM pg_temp.record(
        9, 'reauth-required destination is excluded',
        (v_plan ->> 'verdict') = 'BLOCKED' AND v_reason = 'DESTINATION_STATUS_REAUTH_REQUIRED',
        'reason=' || v_reason
    );

    UPDATE public.drive_accounts SET status = 'active', enabled = false WHERE id = v_dst;
    v_plan := public.plan_drive_migration_dry_run(v_src, v_h);
    v_reason := v_plan -> 'destinations' -> 0 ->> 'reason';
    PERFORM pg_temp.record(
        10, 'disabled destination is excluded',
        (v_plan ->> 'verdict') = 'BLOCKED' AND v_reason = 'DESTINATION_DISABLED',
        'reason=' || v_reason
    );

    PERFORM pg_temp.restore_accounts();
END $blk$;

-- ===========================================================================
-- 11. Source is excluded from destinations
-- ===========================================================================
DO $blk$
DECLARE v_src uuid; v_h jsonb; v_plan jsonb;
BEGIN
    SELECT f.src, h.health INTO v_src, v_h FROM fx f, fx_health h;
    v_plan := public.plan_drive_migration_dry_run(v_src, v_h);

    PERFORM pg_temp.record(
        11, 'source account is excluded from destinations',
        NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_plan -> 'destinations') d
            WHERE (d ->> 'drive_account_id')::uuid = v_src)
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_plan -> 'allocations') a
            WHERE (a ->> 'drive_account_id')::uuid = v_src),
        'source absent from destinations and allocations'
    );
END $blk$;

-- ===========================================================================
-- 12. A retiring destination is excluded
-- ===========================================================================
DO $blk$
DECLARE
    v_src uuid; v_h jsonb; v_c uuid; v_cmig uuid; v_plan jsonb; v_reason text;
BEGIN
    SELECT f.src, h.health INTO v_src, v_h FROM fx f, fx_health h;

    INSERT INTO public.drive_accounts (
        name, google_email, refresh_token_secret_id, status, enabled,
        connection_status, health_status, priority,
        storage_limit_bytes, storage_used_bytes, storage_available_bytes,
        reserved_bytes, created_at, updated_at
    ) VALUES (
        'DryRun Retiring C', 'dryrun-retiring-c@example.invalid', gen_random_uuid(),
        'active', true, 'connected', 'healthy', 10,
        10000000000, 0, 9000000000, 0, now(), now()
    ) RETURNING id INTO v_c;

    INSERT INTO public.drive_account_migrations (source_drive_account_id, status)
    VALUES (v_c, 'PLANNED') RETURNING id INTO v_cmig;
    PERFORM public.set_drive_account_retiring(v_c, v_cmig);

    v_h := v_h || jsonb_build_object(v_c::text, jsonb_build_object(
        'verified', true, 'email', 'dryrun-retiring-c@example.invalid',
        'permission_id', NULL, 'storage_available_bytes', '9000000000',
        'checked_at', now()::text, 'error', NULL));

    v_plan := public.plan_drive_migration_dry_run(v_src, v_h);

    SELECT d ->> 'reason' INTO v_reason
    FROM jsonb_array_elements(v_plan -> 'destinations') d
    WHERE (d ->> 'drive_account_id')::uuid = v_c;

    PERFORM pg_temp.record(
        12, 'retiring destination is excluded even when health-verified',
        v_reason = 'DESTINATION_RETIRING'
          AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(v_plan -> 'allocations') a
              WHERE (a ->> 'drive_account_id')::uuid = v_c),
        'reason=' || COALESCE(v_reason, '(missing)')
    );

    -- RESTRICT both ways: clear the guard, then the migration, then the account
    UPDATE public.drive_accounts SET retiring_migration_id = NULL WHERE id = v_c;
    DELETE FROM public.drive_account_migrations WHERE id = v_cmig;
    DELETE FROM public.drive_accounts WHERE id = v_c;
END $blk$;

-- ===========================================================================
-- 13/14. Safety margin and reserved bytes are included
-- ===========================================================================
DO $blk$
DECLARE
    v_src uuid; v_dst uuid; v_h jsonb; v_plan jsonb; v_d jsonb;
    v_avail bigint := 5000000000;
    v_reserved bigint := 250000000;
    v_margin bigint;
BEGIN
    SELECT src, dst INTO v_src, v_dst FROM fx;
    UPDATE public.drive_accounts
    SET storage_available_bytes = v_avail, reserved_bytes = v_reserved
    WHERE id = v_dst;

    v_h := jsonb_build_object(v_dst::text, jsonb_build_object(
        'verified', true, 'email', 'towkir342@gmail.com',
        'permission_id', '03586478075243744004',
        'storage_available_bytes', v_avail::text, 'checked_at', now()::text, 'error', NULL));

    v_plan := public.plan_drive_migration_dry_run(v_src, v_h);
    v_margin := (v_plan ->> 'safety_margin_bytes')::bigint;

    SELECT d INTO v_d FROM jsonb_array_elements(v_plan -> 'destinations') d
    WHERE (d ->> 'drive_account_id')::uuid = v_dst;

    PERFORM pg_temp.record(
        13, 'safety margin is included in usable capacity',
        v_margin > 0
          AND (v_d ->> 'reported_usable_bytes')::bigint = v_avail - v_reserved - v_margin
          AND (v_d ->> 'safety_margin_bytes')::bigint = v_margin,
        'usable=' || (v_d ->> 'reported_usable_bytes') || ' expected=' ||
          (v_avail - v_reserved - v_margin)::text || ' margin=' || v_margin::text
    );

    PERFORM pg_temp.record(
        14, 'reserved bytes are included in usable capacity',
        (v_d ->> 'db_reserved_bytes')::bigint = v_reserved
          AND (v_d ->> 'reported_usable_bytes')::bigint = v_avail - v_reserved - v_margin,
        'reserved=' || (v_d ->> 'db_reserved_bytes')
    );

    -- remaining capacity after allocation
    PERFORM pg_temp.record(
        15, 'remaining usable capacity is reported per destination',
        (v_d ->> 'reported_usable_bytes')::bigint - (v_d ->> 'allocated_bytes')::bigint
          = v_avail - v_reserved - v_margin - (v_plan ->> 'allocated_bytes')::bigint,
        'remaining=' || ((v_d ->> 'reported_usable_bytes')::bigint
                          - (v_d ->> 'allocated_bytes')::bigint)::text
    );

    PERFORM pg_temp.restore_accounts();
END $blk$;

-- ===========================================================================
-- 16/17. Determinism: repeated runs produce an identical plan
-- ===========================================================================
DO $blk$
DECLARE v_src uuid; v_h jsonb; v_1 jsonb; v_2 jsonb; v_3 jsonb;
BEGIN
    SELECT f.src, h.health INTO v_src, v_h FROM fx f, fx_health h;

    v_1 := public.plan_drive_migration_dry_run(v_src, v_h);
    v_2 := public.plan_drive_migration_dry_run(v_src, v_h);
    v_3 := public.plan_drive_migration_dry_run(v_src, v_h);

    PERFORM pg_temp.record(
        16, 'repeated planner runs produce an identical plan',
        (v_1 - 'planned_at') = (v_2 - 'planned_at')
          AND (v_2 - 'planned_at') = (v_3 - 'planned_at'),
        'three runs identical (excluding planned_at)'
    );

    PERFORM pg_temp.record(
        17, 'allocation does not depend on invocation order',
        (v_1 -> 'allocations') = (v_2 -> 'allocations')
          AND (v_1 -> 'destinations') = (v_2 -> 'destinations'),
        'allocations and candidate ordering stable'
    );
END $blk$;

-- ===========================================================================
-- 18/19/20. Per-media plan integrity
-- ===========================================================================
DO $blk$
DECLARE
    v_src uuid; v_h jsonb; v_plan jsonb; v_allocs jsonb;
    v_total int; v_distinct_media int; v_distinct_dest int;
    v_unassigned int; v_assigned_bytes bigint; v_required bigint;
    v_distinct_file_ids int;
BEGIN
    SELECT f.src, h.health INTO v_src, v_h FROM fx f, fx_health h;
    v_plan := public.plan_drive_migration_dry_run(v_src, v_h);
    v_allocs := v_plan -> 'allocations';

    SELECT count(*)::int,
           count(DISTINCT out_media_id)::int,
           count(DISTINCT out_destination_drive_account_id)::int,
           count(DISTINCT out_source_google_drive_file_id)::int,
           count(*) FILTER (WHERE out_destination_drive_account_id IS NULL)::int,
           COALESCE(sum(out_source_size_bytes) FILTER (
               WHERE out_destination_drive_account_id IS NOT NULL), 0)::bigint
    INTO v_total, v_distinct_media, v_distinct_dest, v_distinct_file_ids,
         v_unassigned, v_assigned_bytes
    FROM public.plan_drive_migration_items(v_src, v_allocs);

    v_required := (v_plan -> 'population' ->> 'total_required_bytes')::bigint;

    PERFORM pg_temp.record(
        18, 'every media gets exactly one destination',
        v_total = 243 AND v_unassigned = 0 AND v_distinct_media = v_total,
        'rows=' || v_total || ' unassigned=' || v_unassigned || ' distinct=' || v_distinct_media
    );

    PERFORM pg_temp.record(
        19, 'duplicate media cannot appear twice',
        v_distinct_media = v_total AND v_distinct_file_ids = v_total,
        'distinct media=' || v_distinct_media || ' distinct file ids=' || v_distinct_file_ids
    );

    PERFORM pg_temp.record(
        20, 'total allocated bytes equals required bytes',
        (v_plan ->> 'allocated_bytes')::bigint = v_required
          AND v_assigned_bytes = v_required
          AND (v_plan -> 'safety_checks' ->> 'allocation_bytes_equal_required') = 'true',
        'allocated=' || (v_plan ->> 'allocated_bytes') || ' assigned=' || v_assigned_bytes
          || ' required=' || v_required
    );
END $blk$;

-- ===========================================================================
-- 21. Missing source provenance blocks the plan
-- ===========================================================================
DO $blk$
DECLARE v_src uuid; v_h jsonb; v_plan jsonb; v_target uuid;
BEGIN
    SELECT f.src, h.health INTO v_src, v_h FROM fx f, fx_health h;

    -- remove exactly one authoritative stored-MD5 event (rolled back later)
    SELECT media_id INTO v_target
    FROM public.sync_logs
    WHERE event_type = 'DRIVE_UPLOAD_VERIFIED'
      AND media_id IN (SELECT media_id FROM public.replication_jobs
                       WHERE drive_account_id = v_src AND status = 'COMPLETED')
    ORDER BY media_id LIMIT 1;

    DELETE FROM public.sync_logs
    WHERE event_type = 'DRIVE_UPLOAD_VERIFIED' AND media_id = v_target;

    v_plan := public.plan_drive_migration_dry_run(v_src, v_h);

    PERFORM pg_temp.record(
        21, 'missing source provenance blocks the plan',
        (v_plan ->> 'verdict') = 'BLOCKED'
          AND v_plan -> 'reasons' @> '["MISSING_SOURCE_MD5"]'::jsonb
          AND (v_plan -> 'safety_checks' ->> 'every_media_has_source_md5') = 'false'
          AND (v_plan -> 'population' ->> 'missing_source_md5_count')::int = 1,
        'missing_md5_count=' || (v_plan -> 'population' ->> 'missing_source_md5_count')
    );
END $blk$;

-- ===========================================================================
-- 22. Unverified destination is not silently used, and identity mismatch blocks
-- ===========================================================================
DO $blk$
DECLARE v_src uuid; v_dst uuid; v_plan jsonb; v_reason text;
BEGIN
    SELECT src, dst INTO v_src, v_dst FROM fx;

    -- health verified but for the WRONG account identity
    v_plan := public.plan_drive_migration_dry_run(v_src, jsonb_build_object(
        v_dst::text, jsonb_build_object(
            'verified', true, 'email', 'someone-else@example.invalid',
            'permission_id', '9999999999',
            'storage_available_bytes', '9000000000',
            'checked_at', now()::text, 'error', NULL)));

    v_reason := v_plan -> 'destinations' -> 0 ->> 'reason';
    PERFORM pg_temp.record(
        22, 'destination identity mismatch blocks the plan',
        (v_plan ->> 'verdict') = 'BLOCKED' AND v_reason = 'DESTINATION_IDENTITY_MISMATCH',
        'reason=' || v_reason
    );
END $blk$;

-- ===========================================================================
-- 23. Source already retiring blocks the plan
-- ===========================================================================
DO $blk$
DECLARE v_src uuid; v_h jsonb; v_mig uuid; v_plan jsonb;
BEGIN
    SELECT f.src, h.health INTO v_src, v_h FROM fx f, fx_health h;

    INSERT INTO public.drive_account_migrations (source_drive_account_id, status)
    VALUES (v_src, 'RUNNING') RETURNING id INTO v_mig;
    PERFORM public.set_drive_account_retiring(v_src, v_mig);

    v_plan := public.plan_drive_migration_dry_run(v_src, v_h);

    PERFORM pg_temp.record(
        23, 'source already retiring blocks the plan',
        (v_plan ->> 'verdict') = 'BLOCKED'
          AND v_plan -> 'reasons' @> '["SOURCE_ACCOUNT_ALREADY_RETIRING"]'::jsonb,
        'reasons=' || (v_plan -> 'reasons')::text
    );

    UPDATE public.drive_account_migrations SET status = 'CANCELLED' WHERE id = v_mig;
END $blk$;

-- ===========================================================================
-- 24. The planner writes nothing
-- ===========================================================================
DO $blk$
DECLARE v_mig_before int; v_items_before int;
        v_mig_after int; v_items_after int;
        v_src uuid; v_h jsonb;
BEGIN
    SELECT f.src, h.health INTO v_src, v_h FROM fx f, fx_health h;

    SELECT count(*)::int INTO v_mig_before FROM public.drive_account_migrations;
    SELECT count(*)::int INTO v_items_before FROM public.drive_account_migration_items;

    PERFORM public.plan_drive_migration_dry_run(v_src, v_h);
    PERFORM public.plan_drive_migration_items(v_src, '[]'::jsonb);
    PERFORM public.plan_drive_migration_folders(v_src, NULL);

    SELECT count(*)::int INTO v_mig_after FROM public.drive_account_migrations;
    SELECT count(*)::int INTO v_items_after FROM public.drive_account_migration_items;

    PERFORM pg_temp.record(
        24, 'planner writes no migration records or items',
        v_mig_after = v_mig_before AND v_items_after = v_items_before,
        'migrations ' || v_mig_before || '->' || v_mig_after ||
          ', items ' || v_items_before || '->' || v_items_after
    );
END $blk$;

-- ===========================================================================
-- 25. Folder mapping
-- ===========================================================================
DO $blk$
DECLARE v_src uuid; v_h jsonb; v_plan jsonb; v_f jsonb;
BEGIN
    SELECT f.src, h.health INTO v_src, v_h FROM fx f, fx_health h;
    v_plan := public.plan_drive_migration_dry_run(v_src, v_h);
    v_f := v_plan -> 'folder_mapping' -> 0;

    PERFORM pg_temp.record(
        25, 'folder mapping names the source folder and the deterministic action',
        jsonb_array_length(v_plan -> 'folder_mapping') = 1
          AND (v_f ->> 'source_folder_name') = 'towkir'
          AND (v_f ->> 'source_folder_type') = 'user'
          AND (v_f ->> 'media_count')::int = 243
          AND (v_f ->> 'planned_action') IN ('WORKER_MUST_CREATE','REUSE_EXISTING')
          AND (v_f ->> 'mapping_basis') LIKE 'claim_drive_folder%',
        'action=' || (v_f ->> 'planned_action') || ' media=' || (v_f ->> 'media_count')
          || ' existing=' || COALESCE(v_f ->> 'existing_destination_google_folder_id','none')
    );
END $blk$;

SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, scenario, detail
FROM dry_run_results ORDER BY n;

ROLLBACK;
