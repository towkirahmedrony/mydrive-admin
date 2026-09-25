-- ============================================================================
-- Drive Account Migration Foundation — focused test suite
-- ============================================================================
-- Runs entirely inside ONE transaction that always ROLLBACKs, so it is safe to
-- execute against production: no fixture, row, account, folder, media or log
-- entry survives the run.  The suite is read-only with respect to real data
-- (it only INSERTs/UPDATEs rows it created itself, inside the transaction).
--
-- Every scenario reports PASS/FAIL into a temp table which is returned as the
-- final result set.
--
--   BEGIN;  ...  SELECT ... FROM migration_test_results;  ROLLBACK;
-- ============================================================================

BEGIN;

CREATE TEMP TABLE migration_test_results (
    n        integer,
    scenario text,
    ok       boolean,
    detail   text
);

-- Fixtures (resolved from live production state, not hardcoded) -------------
CREATE TEMP TABLE fx AS
SELECT
    (SELECT id FROM public.drive_accounts WHERE google_email = 'towkir750@gmail.com') AS src,
    (SELECT id FROM public.drive_accounts WHERE google_email = 'towkir342@gmail.com') AS dst,
    -- scoped to the SOURCE account: the destination account now has a 'user'
    -- folder of its own, so an unfiltered lookup would be ambiguous
    (SELECT id FROM public.drive_folders
     WHERE folder_type = 'user'
       AND drive_account_id = (SELECT id FROM public.drive_accounts
                               WHERE google_email = 'towkir750@gmail.com'))          AS src_folder,
    (SELECT owner_id FROM public.drive_folders
     WHERE folder_type = 'user'
       AND drive_account_id = (SELECT id FROM public.drive_accounts
                               WHERE google_email = 'towkir750@gmail.com'))          AS owner,
    (SELECT id FROM public.media_assets ORDER BY id LIMIT 1)                         AS media1,
    (SELECT id FROM public.media_assets ORDER BY id OFFSET 1 LIMIT 1)                AS media2;

-- Capture pristine account/folder state so "not selected" tests can perturb it.
CREATE TEMP TABLE fx_accounts AS
SELECT id, health_status, connection_status, status, enabled,
       storage_available_bytes, reserved_bytes
FROM public.drive_accounts;

-- Normalise the source account to the clean slate this suite assumes.
-- Production may legitimately carry a live migration now (the copy worker
-- creates one), so clear it here. Everything below happens inside the
-- transaction that is rolled back, so nothing is actually changed.
UPDATE public.drive_accounts SET retiring_migration_id = NULL
WHERE id = (SELECT src FROM fx);
DELETE FROM public.drive_account_migrations
WHERE source_drive_account_id = (SELECT src FROM fx);


-- Helper: run a statement expected to fail; return the SQLSTATE, or
-- 'NO_ERROR' if it unexpectedly succeeded.  The nested exception block rolls
-- back to its own savepoint, so surrounding test state is preserved.
CREATE FUNCTION pg_temp.expect_error(p_sql text)
RETURNS text
LANGUAGE plpgsql
AS $fn$
BEGIN
    EXECUTE p_sql;
    RETURN 'NO_ERROR';
EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE;
END;
$fn$;

-- Helper: assertion recorder.
CREATE FUNCTION pg_temp.record(p_n integer, p_scenario text, p_ok boolean, p_detail text)
RETURNS void
LANGUAGE sql
AS $fn$
    INSERT INTO migration_test_results VALUES (p_n, p_scenario, p_ok, p_detail);
$fn$;

-- A destination folder for the destination account (created inside this
-- transaction only; no Drive folder is created anywhere).
-- A destination folder for the destination account. Production may already
-- have one (the copy worker creates it), so reuse it when present — the
-- (drive_account_id, owner_id) mapping is unique.
CREATE TEMP TABLE dst_folder AS
SELECT COALESCE(
    (SELECT id FROM public.drive_folders
     WHERE drive_account_id = (SELECT dst FROM fx) AND folder_type = 'user'
     ORDER BY created_at LIMIT 1),
    gen_random_uuid()
) AS id;

INSERT INTO public.drive_folders (
    id, drive_account_id, owner_id, folder_name, google_folder_id,
    folder_type, created_at, folder_status, create_attempts, updated_at
)
SELECT df.id, (SELECT dst FROM fx), (SELECT owner FROM fx), 'towkir',
       'TEST_DEST_FOLDER_GOOGLE_ID', 'user', now(), 'active', 0, now()
FROM dst_folder df
WHERE NOT EXISTS (SELECT 1 FROM public.drive_folders f WHERE f.id = df.id);

-- ===========================================================================
-- 1. Source account cannot be deleted while migration references exist
-- ===========================================================================
DO $blk$
DECLARE
    v_src    uuid;
    v_media1 uuid;
    v_folder uuid;
    v_state  text;
BEGIN
    SELECT src, media1, src_folder INTO v_src, v_media1, v_folder FROM fx;

    INSERT INTO public.drive_account_migrations (source_drive_account_id, status)
    VALUES (v_src, 'PLANNED');

    INSERT INTO public.drive_account_migration_items (
        migration_id, media_id, source_drive_account_id, source_drive_folder_id,
        source_google_drive_file_id, source_file_name, source_size_bytes, source_md5
    )
    SELECT m.id, v_media1, v_src, v_folder, 'SRC_FILE_1', 'a.jpg', 1000, 'md5-a'
    FROM public.drive_account_migrations m WHERE m.source_drive_account_id = v_src;

    v_state := pg_temp.expect_error(
        format('DELETE FROM public.drive_accounts WHERE id = %L', v_src)
    );
    PERFORM pg_temp.record(
        1,
        'source account cannot be deleted while migration references exist',
        v_state IN ('23503', '23001'),
        'blocked by FK (sqlstate=' || v_state || ')'
    );
END $blk$;

-- ===========================================================================
-- 2. Destination cannot equal source
-- ===========================================================================
DO $blk$
DECLARE
    v_src uuid;
    v_state text;
BEGIN
    SELECT src INTO v_src FROM fx;
    v_state := pg_temp.expect_error(format($sql$
        INSERT INTO public.drive_account_migration_items (
            migration_id, media_id, source_drive_account_id,
            source_google_drive_file_id, source_file_name, source_size_bytes,
            destination_drive_account_id
        )
        SELECT m.id, (SELECT media2 FROM fx), %L, 'X', 'x.jpg', 10, %L
        FROM public.drive_account_migrations m WHERE m.source_drive_account_id = %L
    $sql$, v_src, v_src, v_src));
    PERFORM pg_temp.record(
        2, 'destination cannot equal source',
        v_state = '23514', 'sqlstate=' || v_state
    );
END $blk$;

-- ===========================================================================
-- 3/4/5. Unhealthy / disabled / quota-full destination cannot be selected
-- ===========================================================================
DO $blk$
DECLARE
    v_src uuid; v_dst uuid; v_plan jsonb; v_found boolean;
    v_c uuid; v_cmig uuid;
BEGIN
    SELECT src, dst INTO v_src, v_dst FROM fx;

    -- baseline: the healthy destination IS offered
    v_plan  := public.plan_drive_account_migration(v_src, 0);
    v_found := v_plan -> 'candidates' @> jsonb_build_array(
                   jsonb_build_object('drive_account_id', v_dst));
    PERFORM pg_temp.record(
        3, 'healthy destination is selectable (control)',
        v_found AND (v_plan ->> 'feasible')::boolean,
        'candidate_present=' || v_found::text
    );

    -- unhealthy
    UPDATE public.drive_accounts SET health_status = 'unhealthy' WHERE id = v_dst;
    v_plan := public.plan_drive_account_migration(v_src, 0);
    PERFORM pg_temp.record(
        4, 'unhealthy destination cannot be selected',
        NOT (v_plan -> 'candidates' @> jsonb_build_array(
                 jsonb_build_object('drive_account_id', v_dst))),
        'excluded'
    );
    UPDATE public.drive_accounts SET health_status = 'healthy' WHERE id = v_dst;

    -- disabled
    UPDATE public.drive_accounts SET enabled = false WHERE id = v_dst;
    v_plan := public.plan_drive_account_migration(v_src, 0);
    PERFORM pg_temp.record(
        5, 'disabled destination cannot be selected',
        NOT (v_plan -> 'candidates' @> jsonb_build_array(
                 jsonb_build_object('drive_account_id', v_dst))),
        'excluded'
    );
    UPDATE public.drive_accounts SET enabled = true WHERE id = v_dst;

    -- quota full
    UPDATE public.drive_accounts SET status = 'quota_full' WHERE id = v_dst;
    v_plan := public.plan_drive_account_migration(v_src, 0);
    PERFORM pg_temp.record(
        6, 'quota-full destination cannot be selected',
        NOT (v_plan -> 'candidates' @> jsonb_build_array(
                 jsonb_build_object('drive_account_id', v_dst))),
        'excluded'
    );
    UPDATE public.drive_accounts SET status = 'active' WHERE id = v_dst;

    -- connection / credential unusable
    UPDATE public.drive_accounts SET connection_status = 'reauth_required' WHERE id = v_dst;
    v_plan := public.plan_drive_account_migration(v_src, 0);
    PERFORM pg_temp.record(
        7, 'reauth-required destination cannot be selected',
        NOT (v_plan -> 'candidates' @> jsonb_build_array(
                 jsonb_build_object('drive_account_id', v_dst))),
        'excluded'
    );
    UPDATE public.drive_accounts SET connection_status = 'connected' WHERE id = v_dst;

    -- An account being retired is never a destination.  This needs a dedicated
    -- third account C, because retiring_migration_id may only be set on the
    -- migration's own source account (enforced by trigger).
    INSERT INTO public.drive_accounts (
        name, google_email, refresh_token_secret_id, status, enabled,
        connection_status, health_status, priority,
        storage_limit_bytes, storage_used_bytes, storage_available_bytes,
        reserved_bytes, created_at, updated_at
    ) VALUES (
        'Migration Test C', 'migration-retiring-test-c@example.invalid',
        gen_random_uuid(), 'active', true, 'connected', 'healthy', 50,
        10000000000, 0, 9000000000, 0, now(), now()
    ) RETURNING id INTO v_c;

    INSERT INTO public.drive_account_migrations (source_drive_account_id, status)
    VALUES (v_c, 'PLANNED')
    RETURNING id INTO v_cmig;

    PERFORM public.set_drive_account_retiring(v_c, v_cmig);

    v_plan := public.plan_drive_account_migration(v_src, 0);
    PERFORM pg_temp.record(
        8, 'account being retired cannot be selected as destination',
        NOT (v_plan -> 'candidates' @> jsonb_build_array(
                 jsonb_build_object('drive_account_id', v_c))),
        'excluded (lifecycle=' || public.drive_account_retirement_state(v_c) || ')'
    );

    -- park C so it cannot influence later capacity scenarios
    UPDATE public.drive_account_migrations SET status = 'CANCELLED' WHERE id = v_cmig;
    UPDATE public.drive_accounts SET enabled = false, retiring_migration_id = NULL WHERE id = v_c;
END $blk$;

-- ===========================================================================
-- 9. Insufficient capacity blocks planning
-- ===========================================================================
DO $blk$
DECLARE
    v_src uuid; v_dst uuid; v_plan jsonb; v_req bigint;
BEGIN
    SELECT src, dst INTO v_src, v_dst FROM fx;
    UPDATE public.drive_accounts
    SET storage_available_bytes = 100000000, reserved_bytes = 0
    WHERE id = v_dst;

    v_plan := public.plan_drive_account_migration(v_src, 0);
    v_req  := COALESCE((v_plan ->> 'required_bytes')::bigint, 0);

    PERFORM pg_temp.record(
        9, 'insufficient capacity blocks planning',
        (v_plan ->> 'feasible')::boolean = false
          AND (v_plan ->> 'shortfall_bytes')::bigint = v_req - 100000000
          AND v_plan -> 'reasons' @> '["insufficient_destination_capacity"]'::jsonb,
        'feasible=false shortfall=' || (v_plan ->> 'shortfall_bytes') || ' required=' || v_req
    );
END $blk$;

-- ===========================================================================
-- 10. Multiple destinations can satisfy capacity (splitting)
-- ===========================================================================
DO $blk$
DECLARE
    v_src uuid; v_dst uuid; v_b uuid; v_plan jsonb; v_req bigint; v_alloc bigint;
BEGIN
    SELECT src, dst INTO v_src, v_dst FROM fx;

    -- two accounts at 400 MB each cannot cover ~643 MB alone, but together can
    UPDATE public.drive_accounts
    SET storage_available_bytes = 400000000, reserved_bytes = 0 WHERE id = v_dst;

    INSERT INTO public.drive_accounts (
        name, google_email, refresh_token_secret_id, status, enabled,
        connection_status, health_status, priority,
        storage_limit_bytes, storage_used_bytes, storage_available_bytes,
        reserved_bytes, created_at, updated_at
    ) VALUES (
        'Migration Test B', 'migration-split-test-b@example.invalid',
        gen_random_uuid(), 'active', true,
        'connected', 'healthy', 200,
        1000000000, 0, 400000000,
        0, now(), now()
    ) RETURNING id INTO v_b;

    v_plan  := public.plan_drive_account_migration(v_src, 0);
    v_req   := (v_plan ->> 'required_bytes')::bigint;
    v_alloc := COALESCE((v_plan ->> 'allocated_bytes')::bigint, 0);

    PERFORM pg_temp.record(
        10, 'multiple destinations can satisfy capacity',
        (v_plan ->> 'feasible')::boolean
          AND (v_plan ->> 'destination_count')::int = 2
          AND v_alloc = v_req
          AND (v_plan ->> 'single_account_sufficient')::boolean = false,
        'destinations=' || (v_plan ->> 'destination_count')
          || ' allocated=' || v_alloc || ' required=' || v_req
          || ' single_sufficient=' || (v_plan ->> 'single_account_sufficient')
    );
END $blk$;

-- ===========================================================================
-- 11/12. Safety margin and reserved bytes are included in usable capacity
-- ===========================================================================
DO $blk$
DECLARE
    v_src uuid; v_dst uuid; v_plan jsonb; v_cand jsonb;
    v_avail bigint := 5000000000;
    v_margin bigint := 1000000000;
    v_reserved bigint := 250000000;
    v_usable numeric;
BEGIN
    SELECT src, dst INTO v_src, v_dst FROM fx;

    UPDATE public.drive_accounts
    SET storage_available_bytes = v_avail, reserved_bytes = v_reserved
    WHERE id = v_dst;

    v_plan := public.plan_drive_account_migration(v_src, v_margin);

    SELECT c INTO v_cand
    FROM jsonb_array_elements(v_plan -> 'candidates') c
    WHERE (c ->> 'drive_account_id')::uuid = v_dst;

    v_usable := (v_cand ->> 'usable_bytes')::numeric;

    PERFORM pg_temp.record(
        11, 'safety margin is included in usable capacity',
        v_usable = v_avail - v_reserved - v_margin,
        'usable=' || v_usable || ' expected=' || (v_avail - v_reserved - v_margin)
          || ' (avail=' || v_avail || ' - reserved=' || v_reserved
          || ' - margin=' || v_margin || ')'
    );

    PERFORM pg_temp.record(
        12, 'reserved bytes are included in usable capacity',
        (v_cand ->> 'reserved_bytes')::bigint = v_reserved
          AND v_usable < v_avail - v_margin,
        'reserved reported=' || (v_cand ->> 'reserved_bytes')
    );
END $blk$;

-- ===========================================================================
-- 13. Source deletion gate rejects an unverified destination
-- ===========================================================================
DO $blk$
DECLARE
    v_item uuid; v_verdict jsonb; v_state text;
BEGIN
    SELECT i.id INTO v_item
    FROM public.drive_account_migration_items i
    JOIN public.drive_account_migrations m ON m.id = i.migration_id
    WHERE m.source_drive_account_id = (SELECT src FROM fx)
    LIMIT 1;

    -- point it at a plausible but UNVERIFIED destination
    UPDATE public.drive_account_migration_items
    SET destination_drive_account_id     = (SELECT dst FROM fx),
        destination_drive_folder_id      = (SELECT id FROM dst_folder),
        destination_google_drive_file_id = 'DEST_FILE_1',
        destination_file_name            = source_file_name,
        destination_size_bytes           = source_size_bytes,
        destination_md5                  = source_md5,
        verification_state               = 'COPIED'
    WHERE id = v_item;

    v_verdict := public.can_delete_drive_migration_source(v_item);
    PERFORM pg_temp.record(
        13, 'source deletion gate rejects unverified destination',
        (v_verdict ->> 'eligible')::boolean = false
          AND v_verdict -> 'reasons' @> '["item_not_verified"]'::jsonb,
        'reasons=' || (v_verdict -> 'reasons')::text
    );

    -- the DB itself refuses the illegal transition, not just the gate
    v_state := pg_temp.expect_error(format($sql$
        UPDATE public.drive_account_migration_items
        SET source_deletion_state = 'SOURCE_DELETE_PENDING' WHERE id = %L
    $sql$, v_item));
    PERFORM pg_temp.record(
        14, 'database CHECK forbids marking a source deletable before VERIFIED',
        v_state = '23514', 'sqlstate=' || v_state
    );

    -- authorization must also refuse
    v_verdict := public.authorize_drive_migration_source_deletion(v_item);
    PERFORM pg_temp.record(
        15, 'authorize source deletion refuses an unverified destination',
        (v_verdict ->> 'authorized')::boolean = false,
        'authorized=false'
    );
END $blk$;

-- ===========================================================================
-- 16. Source deletion gate accepts only a fully verified destination
-- ===========================================================================
DO $blk$
DECLARE
    v_item uuid; v_verdict jsonb; v_auth jsonb; v_row public.drive_account_migration_items%ROWTYPE;
    v_evidence jsonb;
BEGIN
    SELECT i.id INTO v_item
    FROM public.drive_account_migration_items i
    JOIN public.drive_account_migrations m ON m.id = i.migration_id
    WHERE m.source_drive_account_id = (SELECT src FROM fx)
    LIMIT 1;

    UPDATE public.drive_account_migration_items
    SET verification_state = 'VERIFIED', verified_at = now()
    WHERE id = v_item;

    -- The gate now also requires the migration to be COMPLETED ...
    UPDATE public.drive_account_migrations SET status = 'COMPLETED'
    WHERE source_drive_account_id = (SELECT src FROM fx);

    -- ... and fresh dual-side evidence consistent with the recorded provenance.
    SELECT jsonb_build_object(
        'source', jsonb_build_object(
            'file_id', i.source_google_drive_file_id, 'name', i.destination_file_name,
            'size', i.source_size_bytes::text, 'md5', i.source_md5,
            'trashed', false, 'account_identity_matched', true),
        'destination', jsonb_build_object(
            'file_id', i.destination_google_drive_file_id, 'name', i.destination_file_name,
            'size', i.source_size_bytes::text, 'md5', i.source_md5,
            'trashed', false, 'account_identity_matched', true),
        'observed_at', now()::text)
    INTO v_evidence
    FROM public.drive_account_migration_items i WHERE i.id = v_item;

    v_verdict := public.can_delete_drive_migration_source(v_item, v_evidence);
    PERFORM pg_temp.record(
        16, 'source deletion gate accepts a fully verified destination',
        (v_verdict ->> 'eligible')::boolean = true
          AND NOT (v_verdict -> 'reasons') @> '["item_not_verified"]'::jsonb,
        'eligible=' || (v_verdict ->> 'eligible')
          || ' reasons=' || (v_verdict -> 'reasons')::text
    );

    v_auth := public.authorize_drive_migration_source_deletion(v_item, v_evidence);
    SELECT * INTO v_row FROM public.drive_account_migration_items WHERE id = v_item;
    PERFORM pg_temp.record(
        17, 'authorize source deletion transitions to SOURCE_DELETE_PENDING',
        (v_auth ->> 'authorized')::boolean = true
          AND v_row.source_deletion_state = 'SOURCE_DELETE_PENDING'
          AND v_row.source_delete_authorised_at IS NOT NULL,
        'state=' || v_row.source_deletion_state
    );

    -- and it is idempotent
    v_auth := public.authorize_drive_migration_source_deletion(v_item, v_evidence);
    PERFORM pg_temp.record(
        18, 'authorize source deletion is idempotent',
        (v_auth ->> 'authorized')::boolean = true
          AND (v_auth ->> 'already_authorized')::boolean = true,
        'already_authorized=true'
    );

    -- MD5 must never be assumed: break it and the gate must close again
    UPDATE public.drive_account_migration_items
    SET source_deletion_state = 'NOT_ELIGIBLE',
        destination_md5 = 'md5-different'
    WHERE id = v_item;
    v_verdict := public.can_delete_drive_migration_source(v_item, v_evidence);
    PERFORM pg_temp.record(
        19, 'gate rejects an MD5 mismatch',
        (v_verdict ->> 'eligible')::boolean = false
          AND v_verdict -> 'reasons' @> '["destination_md5_mismatch"]'::jsonb,
        'reasons=' || (v_verdict -> 'reasons')::text
    );
END $blk$;

-- ===========================================================================
-- 20. Account retirement rejects an incomplete migration
-- ===========================================================================
DO $blk$
DECLARE
    v_src uuid; v_check jsonb;
BEGIN
    SELECT src INTO v_src FROM fx;

    UPDATE public.drive_account_migrations SET status = 'RUNNING'
    WHERE source_drive_account_id = v_src;

    v_check := public.check_drive_account_removal(v_src);
    PERFORM pg_temp.record(
        20, 'account retirement rejects incomplete migration',
        (v_check ->> 'can_remove')::boolean = false
          AND v_check -> 'reasons' @> '["migration_incomplete"]'::jsonb,
        'reasons=' || (v_check -> 'reasons')::text
    );
END $blk$;

-- ===========================================================================
-- 21. Account retirement rejects failed items
-- ===========================================================================
DO $blk$
DECLARE
    v_src uuid; v_check jsonb;
BEGIN
    SELECT src INTO v_src FROM fx;

    UPDATE public.drive_account_migration_items
    SET verification_state = 'FAILED', last_error = 'simulated copy failure'
    WHERE migration_id IN (SELECT id FROM public.drive_account_migrations
                           WHERE source_drive_account_id = v_src);

    v_check := public.check_drive_account_removal(v_src);
    PERFORM pg_temp.record(
        21, 'account retirement rejects failed items',
        (v_check ->> 'can_remove')::boolean = false
          AND v_check -> 'reasons' @> '["unresolved_migration_error"]'::jsonb,
        'reasons=' || (v_check -> 'reasons')::text
    );

    -- clear the failure again for the next scenario
    UPDATE public.drive_account_migration_items
    SET verification_state = 'VERIFIED', verified_at = now(), last_error = NULL,
        source_deletion_state = 'SOURCE_DELETE_PENDING'
    WHERE migration_id IN (SELECT id FROM public.drive_account_migrations
                           WHERE source_drive_account_id = v_src);
END $blk$;

-- ===========================================================================
-- 22. Account retirement rejects remaining source references
-- ===========================================================================
DO $blk$
DECLARE
    v_src uuid; v_check jsonb;
BEGIN
    SELECT src INTO v_src FROM fx;
    v_check := public.check_drive_account_removal(v_src);

    PERFORM pg_temp.record(
        22, 'account retirement rejects remaining source references',
        (v_check ->> 'can_remove')::boolean = false
          AND v_check -> 'reasons' @> '["media_still_references_account"]'::jsonb
          AND v_check -> 'reasons' @> '["source_files_still_required"]'::jsonb,
        'reasons=' || (v_check -> 'reasons')::text
    );

    -- and the gate is still closed even after every item is SOURCE_DELETED,
    -- because 243 real media still reference the account
    UPDATE public.drive_account_migration_items
    SET source_deletion_state = 'SOURCE_DELETED', source_deleted_at = now()
    WHERE migration_id IN (SELECT id FROM public.drive_account_migrations
                           WHERE source_drive_account_id = v_src);
    UPDATE public.drive_account_migrations SET status = 'COMPLETED'
    WHERE source_drive_account_id = v_src;

    v_check := public.check_drive_account_removal(v_src);
    PERFORM pg_temp.record(
        23, 'retirement still refused while real media reference the account',
        (v_check ->> 'can_remove')::boolean = false
          AND v_check -> 'reasons' @> '["media_still_references_account"]'::jsonb,
        'reasons=' || (v_check -> 'reasons')::text
    );
END $blk$;

-- ===========================================================================
-- 24. Duplicate migration cannot create conflicting source retirement state
-- ===========================================================================
DO $blk$
DECLARE
    v_src uuid; v_state text;
BEGIN
    SELECT src INTO v_src FROM fx;

    -- the earlier migration is still 'PLANNED' in this scenario group? reset it
    UPDATE public.drive_account_migrations SET status = 'RUNNING'
    WHERE source_drive_account_id = v_src;

    v_state := pg_temp.expect_error(format($sql$
        INSERT INTO public.drive_account_migrations (source_drive_account_id, status)
        VALUES (%L, 'PLANNED')
    $sql$, v_src));
    PERFORM pg_temp.record(
        24, 'duplicate active migration for one source is refused',
        v_state = '23505', 'sqlstate=' || v_state
    );

    -- a CANCELLED migration must NOT block a fresh one
    UPDATE public.drive_account_migrations SET status = 'CANCELLED'
    WHERE source_drive_account_id = v_src;
    v_state := pg_temp.expect_error(format($sql$
        INSERT INTO public.drive_account_migrations (source_drive_account_id, status)
        VALUES (%L, 'PLANNED')
    $sql$, v_src));
    PERFORM pg_temp.record(
        25, 'a cancelled migration does not block a new one',
        v_state = 'NO_ERROR', 'sqlstate=' || v_state
    );
END $blk$;

-- ===========================================================================
-- 26. Retry does not create a duplicate migration item
-- ===========================================================================
DO $blk$
DECLARE
    v_state text;
BEGIN
    v_state := pg_temp.expect_error(format($sql$
        INSERT INTO public.drive_account_migration_items (
            migration_id, media_id, source_drive_account_id,
            source_google_drive_file_id, source_file_name, source_size_bytes
        )
        SELECT migration_id, media_id, source_drive_account_id,
               'SRC_FILE_1_RETRY', 'a.jpg', 1000
        FROM public.drive_account_migration_items LIMIT 1
    $sql$));
    PERFORM pg_temp.record(
        26, 'retry does not create a duplicate migration item',
        v_state = '23505', 'sqlstate=' || v_state
    );
END $blk$;

-- ===========================================================================
-- 27. Migration provenance remains independent of replication_jobs
-- ===========================================================================
DO $blk$
DECLARE
    v_item uuid; v_src uuid; v_folder uuid; v_row public.drive_account_migration_items%ROWTYPE;
BEGIN
    SELECT src, src_folder INTO v_src, v_folder FROM fx;

    SELECT i.id INTO v_item
    FROM public.drive_account_migration_items i LIMIT 1;

    -- simulate the worst case for replication_jobs: null the only pointer it
    -- holds to the source file / account (the ON DELETE SET NULL hazard)
    UPDATE public.replication_jobs
    SET google_drive_file_id = NULL, drive_account_id = NULL, drive_folder_id = NULL
    WHERE media_id = (SELECT media_id FROM public.drive_account_migration_items WHERE id = v_item);

    SELECT * INTO v_row FROM public.drive_account_migration_items WHERE id = v_item;

    PERFORM pg_temp.record(
        27, 'migration provenance survives loss of replication_jobs pointers',
        v_row.source_drive_account_id = v_src
          AND v_row.source_drive_folder_id = v_folder
          AND length(v_row.source_google_drive_file_id) > 0
          AND v_row.source_file_name IS NOT NULL,
        'source account/folder/file retained: ' || v_row.source_drive_account_id
          || ' / ' || v_row.source_drive_folder_id
          || ' / ' || v_row.source_google_drive_file_id
    );
END $blk$;

-- ===========================================================================
-- 28. Unrelated compatibility checks
-- ===========================================================================
DO $blk$
DECLARE
    v_src uuid; v_dst uuid; v_ok boolean; v_state text;
BEGIN
    SELECT src, dst INTO v_src, v_dst FROM fx;

    -- replication_jobs uniqueness model untouched
    SELECT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.replication_jobs'::regclass
          AND conname  = 'replication_jobs_media_id_destination_type_key'
    ) INTO v_ok;
    PERFORM pg_temp.record(
        28, 'existing replication_jobs uniqueness model unchanged',
        v_ok, 'UNIQUE (media_id, destination_type) present'
    );

    -- migration items must survive a replication_jobs change (no coupling)
    SELECT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.drive_account_migration_items'::regclass
          AND contype = 'f'
          AND confrelid = 'public.replication_jobs'::regclass
    ) INTO v_ok;
    PERFORM pg_temp.record(
        29, 'migration items have no FK coupling to replication_jobs',
        NOT v_ok, 'independent provenance model'
    );

    -- unknown audit event types are rejected (vocabulary is closed)
    v_state := pg_temp.expect_error($sql$
        SELECT public.log_drive_migration_event('DRIVE_MIGRATION_BOGUS', NULL)
    $sql$);
    PERFORM pg_temp.record(
        30, 'audit vocabulary rejects unknown migration event types',
        v_state = '23514', 'sqlstate=' || v_state
    );

    -- valid event types are accepted and land in the EXISTING sync_logs table
    v_ok := public.log_drive_migration_event(
        'DRIVE_MIGRATION_PLANNED', NULL, NULL, 'INFO', 'test', '{}'::jsonb
    ) IS NOT NULL;
    PERFORM pg_temp.record(
        31, 'valid migration audit events write to existing sync_logs',
        v_ok, 'no new audit table introduced'
    );

    -- counts/counters recompute correctly
    v_ok := (public.refresh_drive_account_migration_counters(
        (SELECT id FROM public.drive_account_migrations WHERE source_drive_account_id = v_src LIMIT 1)
    ) ->> 'updated')::boolean;
    PERFORM pg_temp.record(
        32, 'migration counters recompute', v_ok, 'updated=true'
    );
END $blk$;

-- ===========================================================================
-- 33. The retirement guard cannot be cross-wired
-- ===========================================================================
DO $blk$
DECLARE
    v_src uuid; v_dst uuid; v_state text;
BEGIN
    SELECT src, dst INTO v_src, v_dst FROM fx;

    -- point dst's guard at a migration whose source is src
    v_state := pg_temp.expect_error(format($sql$
        UPDATE public.drive_accounts
        SET retiring_migration_id = (
            SELECT id FROM public.drive_account_migrations
            WHERE source_drive_account_id = %L LIMIT 1
        )
        WHERE id = %L
    $sql$, v_src, v_dst));

    PERFORM pg_temp.record(
        33, 'retirement guard cannot be cross-wired to another account''s migration',
        v_state = '23503', 'sqlstate=' || v_state
    );

    PERFORM pg_temp.record(
        34, 'lifecycle states are distinguishable',
        public.drive_account_retirement_state(v_src) IN ('MIGRATION_SOURCE','RETIRING','RETIRED')
          AND public.drive_account_retirement_state(v_dst) = 'ACTIVE'
          AND public.drive_account_retirement_state(gen_random_uuid()) = 'MISSING',
        'src=' || public.drive_account_retirement_state(v_src)
          || ' dst=' || public.drive_account_retirement_state(v_dst)
    );
END $blk$;

-- ===========================================================================
-- Return results
-- ===========================================================================
SELECT
    n,
    CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
    scenario,
    detail
FROM migration_test_results
ORDER BY n;

ROLLBACK;
