-- ============================================================================
-- Drive migration worker — database behaviour tests
-- ============================================================================
-- Runs inside ONE transaction that always ROLLBACKs, so production is left
-- exactly as it was found (including the live migration's status and the
-- source account's retirement guard, both of which are perturbed in here).
-- ============================================================================

BEGIN;

CREATE TEMP TABLE w_results (n integer, scenario text, ok boolean, detail text);
CREATE FUNCTION pg_temp.rec(p_n integer, p_s text, p_ok boolean, p_d text)
RETURNS void LANGUAGE sql AS $fn$
    INSERT INTO w_results VALUES (p_n, p_s, p_ok, p_d);
$fn$;
CREATE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $fn$
BEGIN
    EXECUTE p_sql; RETURN 'NO_ERROR';
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE;
END;
$fn$;

CREATE TEMP TABLE fx AS
SELECT (SELECT id FROM public.drive_accounts WHERE google_email = 'towkir750@gmail.com') AS src,
       (SELECT id FROM public.drive_accounts WHERE google_email = 'towkir342@gmail.com') AS dst;

-- Queryable health payload for the destination.
CREATE TEMP TABLE fx_health AS
SELECT jsonb_build_object(
    (SELECT dst FROM fx)::text, jsonb_build_object(
        'verified', true, 'email', 'towkir342@gmail.com',
        'permission_id', '03586478075243744004',
        'storage_available_bytes', '5497557572435',
        'checked_at', now()::text, 'error', NULL)
) AS health;

-- Free the source so a fresh migration can be created inside this transaction.
UPDATE public.drive_account_migrations SET status = 'CANCELLED'
WHERE source_drive_account_id = (SELECT src FROM fx)
  AND status IN ('PLANNED','RUNNING','PAUSED','BLOCKED');
UPDATE public.drive_accounts SET retiring_migration_id = NULL WHERE id = (SELECT src FROM fx);

CREATE TEMP TABLE mig_id (id uuid);

-- Create the migration under test (inside this transaction).
DO $blk$
DECLARE v_out jsonb;
BEGIN
    v_out := public.create_drive_account_migration(
        (SELECT src FROM fx), (SELECT health FROM fx_health), NULL);

    IF NOT COALESCE((v_out ->> 'created')::boolean, false) THEN
        RAISE EXCEPTION 'fixture migration was not created: %', v_out::text;
    END IF;
    IF (v_out ->> 'items_created')::int <> 243 THEN
        RAISE EXCEPTION 'fixture expected 243 items, got %', v_out ->> 'items_created';
    END IF;

    INSERT INTO mig_id VALUES ((v_out ->> 'migration_id')::uuid);
END $blk$;

-- The destination account's user folder. It now exists in production because
-- the validated copy batch created it exactly once; reusing the real row keeps
-- the test faithful. Falls back to a synthetic row if none exists yet.
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
SELECT df.id, (SELECT dst FROM fx),
       (SELECT owner_id FROM public.drive_folders
        WHERE drive_account_id = (SELECT src FROM fx) AND folder_type = 'user'
        ORDER BY created_at LIMIT 1),
       'towkir', 'TEST_DEST_FOLDER_GID', 'user', now(), 'active', 0, now()
FROM dst_folder df
WHERE NOT EXISTS (SELECT 1 FROM public.drive_folders f WHERE f.id = df.id);

-- ===========================================================================
-- 1. Migration item creation
-- ===========================================================================
DO $blk$
DECLARE v_total int; v_bytes bigint; v_src uuid;
BEGIN
    SELECT src INTO v_src FROM fx;
    SELECT count(*)::int, sum(source_size_bytes)::bigint
    INTO v_total, v_bytes
    FROM public.drive_account_migration_items
    WHERE migration_id = (SELECT id FROM mig_id);

    PERFORM pg_temp.rec(
        1, 'one migration item per source media',
        v_total = 243 AND v_bytes = 642524522,
        'items=' || v_total || ' bytes=' || COALESCE(v_bytes::text,'0')
    );

    PERFORM pg_temp.rec(
        2, 'migration created as RUNNING with counters initialised',
        (SELECT status FROM public.drive_account_migrations WHERE id = (SELECT id FROM mig_id)) = 'RUNNING'
          AND (SELECT total_media_count FROM public.drive_account_migrations WHERE id = (SELECT id FROM mig_id)) = 243,
        'items_in_fixture_migration=' ||
          (SELECT count(*)::text FROM public.drive_account_migration_items
           WHERE migration_id = (SELECT id FROM mig_id))
    );
END $blk$;

-- ===========================================================================
-- 2. Source provenance preservation
-- ===========================================================================
DO $blk$
DECLARE v_src uuid; v_missing int; v_mismatch int;
BEGIN
    SELECT src INTO v_src FROM fx;

    SELECT count(*) FILTER (
               WHERE i.source_google_drive_file_id IS NULL
                  OR i.source_file_name IS NULL
                  OR i.source_size_bytes IS NULL
                  OR i.source_md5 IS NULL
                  OR i.source_drive_folder_id IS NULL
                  OR i.source_drive_account_id <> v_src)::int
    INTO v_missing
    FROM public.drive_account_migration_items i
    WHERE i.migration_id = (SELECT id FROM mig_id);

    -- provenance must equal what production says for the same media
    SELECT count(*)::int INTO v_mismatch
    FROM public.drive_account_migration_items i
    JOIN public.replication_jobs rj ON rj.media_id = i.media_id
    WHERE i.migration_id = (SELECT id FROM mig_id)
      AND (rj.google_drive_file_id <> i.source_google_drive_file_id
           OR rj.drive_account_id <> i.source_drive_account_id
           OR rj.drive_folder_id IS DISTINCT FROM i.source_drive_folder_id);

    PERFORM pg_temp.rec(
        3, 'source provenance copied exactly from production', 
        v_missing = 0 AND v_mismatch = 0,
        'incomplete=' || v_missing || ' mismatched_vs_replication_jobs=' || v_mismatch
    );
END $blk$;

-- ===========================================================================
-- 3. Destination provenance population
-- ===========================================================================
DO $blk$
DECLARE v_id uuid;
BEGIN
    SELECT id INTO v_id FROM public.drive_account_migration_items
    WHERE migration_id = (SELECT id FROM mig_id) ORDER BY created_at, id LIMIT 1;

    PERFORM public.complete_drive_migration_item(
        p_item_id => v_id,
        p_verification_state => 'VERIFIED',
        p_destination_drive_account_id => (SELECT dst FROM fx),
        p_destination_drive_folder_id => (SELECT id FROM dst_folder),
        p_destination_google_drive_file_id => 'DEST_FILE_TEST',
        p_destination_file_name => 'x_media_abc.mp4',
        p_destination_size_bytes => 1000,
        p_destination_md5 => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );

    PERFORM pg_temp.rec(
        4, 'destination provenance is persisted on verification',
        (SELECT verification_state = 'VERIFIED'
                AND destination_google_drive_file_id = 'DEST_FILE_TEST'
                AND destination_file_name = 'x_media_abc.mp4'
                AND destination_size_bytes = 1000
                AND destination_md5 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
                AND verified_at IS NOT NULL
                AND lease_owner IS NULL
           FROM public.drive_account_migration_items WHERE id = v_id),
        'destination fields recorded'
    );

    PERFORM pg_temp.rec(
        5, 'source provenance is retained alongside destination provenance',
        (SELECT source_google_drive_file_id IS NOT NULL
                AND source_md5 IS NOT NULL
                AND source_size_bytes IS NOT NULL
                AND source_drive_account_id IS NOT NULL
           FROM public.drive_account_migration_items WHERE id = v_id),
        'source side untouched by verification'
    );
END $blk$;

-- ===========================================================================
-- 4. Source account cannot equal destination
-- ===========================================================================
DO $blk$
DECLARE v_state text;
BEGIN
    v_state := pg_temp.err(format($sql$
        UPDATE public.drive_account_migration_items
        SET destination_drive_account_id = %L
        WHERE migration_id = %L AND destination_drive_account_id = %L
    $sql$, (SELECT src FROM fx), (SELECT id FROM mig_id), (SELECT dst FROM fx)));
    PERFORM pg_temp.rec(
        6, 'a destination equal to the source account is refused',
        v_state = '23514', 'sqlstate=' || v_state
    );
END $blk$;

-- ===========================================================================
-- 7. Retry after failure (backoff window honoured)
-- ===========================================================================
DO $blk$
DECLARE v_id uuid; v_claimed uuid;
BEGIN
    UPDATE public.drive_account_migration_items
    SET verification_state = 'VERIFIED' WHERE migration_id = (SELECT id FROM mig_id);

    SELECT id INTO v_id FROM public.drive_account_migration_items
    WHERE migration_id = (SELECT id FROM mig_id) ORDER BY created_at, id LIMIT 1;

    -- failed with a future retry time -> NOT claimable
    UPDATE public.drive_account_migration_items
    SET verification_state = 'FAILED', next_retry_at = now() + interval '1 hour',
        lease_owner = NULL, lease_expires_at = NULL
    WHERE id = v_id;

    SELECT (public.claim_drive_migration_item((SELECT id FROM mig_id), 'test', 15)).id INTO v_claimed;
    PERFORM pg_temp.rec(
        7, 'a failed item inside its backoff window is not re-claimed',
        v_claimed IS NULL, 'claimed=' || COALESCE(v_claimed::text,'NULL')
    );

    -- once the window opens it is claimable again
    UPDATE public.drive_account_migration_items
    SET next_retry_at = now() - interval '1 minute' WHERE id = v_id;

    SELECT (public.claim_drive_migration_item((SELECT id FROM mig_id), 'test', 15)).id INTO v_claimed;
    PERFORM pg_temp.rec(
        8, 'a failed item becomes claimable once the retry window opens',
        v_claimed = v_id, 'claimed=' || COALESCE(v_claimed::text,'NULL')
    );
END $blk$;

-- ===========================================================================
-- 9. Retry after a worker crash (stale lease)
-- ===========================================================================
DO $blk$
DECLARE v_id uuid; v_claimed uuid; v_state text;
BEGIN
    UPDATE public.drive_account_migration_items
    SET verification_state = 'VERIFIED' WHERE migration_id = (SELECT id FROM mig_id);

    SELECT id INTO v_id FROM public.drive_account_migration_items
    WHERE migration_id = (SELECT id FROM mig_id) ORDER BY created_at, id LIMIT 1;

    -- a worker died mid-copy: lease expired, state COPYING
    UPDATE public.drive_account_migration_items
    SET verification_state = 'COPYING', lease_owner = 'dead-worker',
        lease_expires_at = now() - interval '5 minutes', next_retry_at = NULL
    WHERE id = v_id;

    SELECT (public.claim_drive_migration_item((SELECT id FROM mig_id), 'recovery', 15)).id INTO v_claimed;
    v_state := (SELECT verification_state FROM public.drive_account_migration_items WHERE id = v_id);

    PERFORM pg_temp.rec(
        9, 'a crashed worker''s item is recovered by the next invocation',
        v_claimed = v_id AND v_state = 'COPYING',
        'claimed=' || COALESCE(v_claimed::text,'NULL') || ' state=' || v_state
    );

    -- a live lease must NOT be stolen
    UPDATE public.drive_account_migration_items
    SET verification_state = 'COPYING', lease_owner = 'live-worker',
        lease_expires_at = now() + interval '10 minutes'
    WHERE id = v_id;

    SELECT (public.claim_drive_migration_item((SELECT id FROM mig_id), 'other', 15)).id INTO v_claimed;
    PERFORM pg_temp.rec(
        10, 'an item held by a live lease is not stolen',
        v_claimed IS NULL, 'claimed=' || COALESCE(v_claimed::text,'NULL')
    );
END $blk$;

-- ===========================================================================
-- 11. Already-verified item is idempotent
-- ===========================================================================
DO $blk$
DECLARE v_claimed uuid;
BEGIN
    UPDATE public.drive_account_migration_items
    SET verification_state = 'VERIFIED', lease_owner = NULL, lease_expires_at = NULL
    WHERE migration_id = (SELECT id FROM mig_id);

    SELECT (public.claim_drive_migration_item((SELECT id FROM mig_id), 'test', 15)).id INTO v_claimed;
    PERFORM pg_temp.rec(
        11, 'a VERIFIED item is never re-claimed (idempotent re-runs)',
        v_claimed IS NULL, 'claimed=' || COALESCE(v_claimed::text,'NULL')
    );
END $blk$;

-- ===========================================================================
-- 12. Duplicate destination prevention
-- ===========================================================================
DO $blk$
DECLARE v_id uuid; v_claimed uuid; v_state text; v_dest text;
BEGIN
    UPDATE public.drive_account_migration_items
    SET verification_state = 'VERIFIED' WHERE migration_id = (SELECT id FROM mig_id);

    SELECT id INTO v_id FROM public.drive_account_migration_items
    WHERE migration_id = (SELECT id FROM mig_id) ORDER BY created_at, id LIMIT 1;

    -- upload completed and was persisted, verification not yet done
    UPDATE public.drive_account_migration_items
    SET verification_state = 'COPIED',
        destination_google_drive_file_id = 'EXISTING_DEST',
        destination_drive_account_id = (SELECT dst FROM fx),
        destination_drive_folder_id = (SELECT id FROM dst_folder),
        destination_file_name = source_file_name,
        destination_size_bytes = source_size_bytes,
        lease_owner = NULL, lease_expires_at = NULL, next_retry_at = NULL
    WHERE id = v_id;

    SELECT (public.claim_drive_migration_item((SELECT id FROM mig_id), 'test', 15)).id INTO v_claimed;
    SELECT verification_state, destination_google_drive_file_id
    INTO v_state, v_dest
    FROM public.drive_account_migration_items WHERE id = v_id;

    PERFORM pg_temp.rec(
        12, 'a COPIED item is re-claimed for VERIFICATION, never reset for re-upload',
        v_claimed = v_id AND v_state = 'COPIED' AND v_dest = 'EXISTING_DEST',
        'state=' || v_state || ' dest_file=' || COALESCE(v_dest,'NULL')
    );
END $blk$;

-- ===========================================================================
-- 13. Migration cannot complete with unverified items
-- ===========================================================================
DO $blk$
DECLARE v_out jsonb;
BEGIN
    UPDATE public.drive_account_migration_items
    SET verification_state = 'VERIFIED' WHERE migration_id = (SELECT id FROM mig_id);

    UPDATE public.drive_account_migration_items
    SET verification_state = 'FAILED'
    WHERE id = (SELECT id FROM public.drive_account_migration_items
                WHERE migration_id = (SELECT id FROM mig_id) ORDER BY created_at, id LIMIT 1);

    v_out := public.finalize_drive_account_migration((SELECT id FROM mig_id));

    PERFORM pg_temp.rec(
        13, 'migration cannot complete while any item is unverified',
        (v_out ->> 'finalized')::boolean = false
          AND v_out -> 'reasons' @> '["ITEMS_NOT_VERIFIED"]'::jsonb
          AND (SELECT status FROM public.drive_account_migrations WHERE id = (SELECT id FROM mig_id)) = 'RUNNING',
        'not_verified=' || COALESCE(v_out ->> 'not_verified_items','?')
    );
END $blk$;

-- ===========================================================================
-- 14. Migration completes only when EVERY item is VERIFIED
-- ===========================================================================
DO $blk$
DECLARE v_out jsonb;
BEGIN
    UPDATE public.drive_account_migration_items
    SET verification_state = 'VERIFIED', verified_at = now()
    WHERE migration_id = (SELECT id FROM mig_id);

    v_out := public.finalize_drive_account_migration((SELECT id FROM mig_id));

    PERFORM pg_temp.rec(
        14, 'migration completes when every item is VERIFIED',
        (v_out ->> 'finalized')::boolean = true
          AND (SELECT status FROM public.drive_account_migrations WHERE id = (SELECT id FROM mig_id)) = 'COMPLETED'
          AND (v_out ->> 'verified_items')::int = 243,
        'verified=' || COALESCE(v_out ->> 'verified_items','?')
    );
END $blk$;

-- ===========================================================================
-- 14b. Counters agree with the item table once a migration completes
-- ===========================================================================
-- Regression guard: the counters were originally defined in terms of
-- source_deletion_state = 'SOURCE_DELETED', which can never advance during the
-- copy-and-verify phase, leaving COMPLETED migrations reporting 0/0.
DO $blk$
DECLARE v_counters jsonb; v_row public.drive_account_migrations%ROWTYPE;
BEGIN
    v_counters := public.refresh_drive_account_migration_counters((SELECT id FROM mig_id));
    SELECT * INTO v_row FROM public.drive_account_migrations WHERE id = (SELECT id FROM mig_id);

    PERFORM pg_temp.rec(
        21, 'counters match the item table for a fully verified migration',
        v_row.completed_count = 243
          AND v_row.total_media_count = 243
          AND v_row.failed_count = 0
          AND v_row.migrated_bytes = 642524522
          AND v_row.migrated_bytes = v_row.total_expected_bytes,
        'completed=' || v_row.completed_count || ' total=' || v_row.total_media_count
          || ' migrated_bytes=' || v_row.migrated_bytes
          || ' expected=' || v_row.total_expected_bytes
    );
END $blk$;

-- ===========================================================================
-- 15. Source deletion is never authorised or performed by this layer
-- ===========================================================================
DO $blk$
DECLARE v_args text; v_del int; v_auth int;
BEGIN
    -- the completion function has no parameter that could set deletion state
    SELECT pg_get_function_arguments(p.oid) INTO v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'complete_drive_migration_item';

    PERFORM pg_temp.rec(
        15, 'complete_drive_migration_item has no source-deletion parameter',
        v_args IS NOT NULL AND position('source_deletion' in v_args) = 0,
        'args=' || COALESCE(v_args,'(missing)')
    );

    SELECT count(*)::int INTO v_del
    FROM public.drive_account_migration_items
    WHERE migration_id = (SELECT id FROM mig_id) AND source_deletion_state <> 'NOT_ELIGIBLE';

    SELECT count(*)::int INTO v_auth
    FROM public.drive_account_migration_items
    WHERE migration_id = (SELECT id FROM mig_id)
      AND (source_delete_authorised_at IS NOT NULL OR source_deleted_at IS NOT NULL);

    PERFORM pg_temp.rec(
        16, 'no item was authorised or marked for source deletion',
        v_del = 0 AND v_auth = 0,
        'non_default_deletion_states=' || v_del || ' authorised_or_deleted=' || v_auth
    );

    PERFORM pg_temp.rec(
        17, 'the deletion gate still refuses deletion for a VERIFIED item with no evidence',
        (public.can_delete_drive_migration_source(
            (SELECT id FROM public.drive_account_migration_items
             WHERE migration_id = (SELECT id FROM mig_id) LIMIT 1)) ->> 'eligible')::boolean = false,
        'gate closed (no destination md5/folder recorded in this synthetic case)'
    );
END $blk$;

-- ===========================================================================
-- 18. Duplicate item cannot be created for the same media
-- ===========================================================================
DO $blk$
DECLARE v_state text;
BEGIN
    v_state := pg_temp.err(format($sql$
        INSERT INTO public.drive_account_migration_items (
            migration_id, media_id, source_drive_account_id,
            source_google_drive_file_id, source_file_name, source_size_bytes
        )
        SELECT migration_id, media_id, source_drive_account_id,
               'DUP', 'dup.jpg', 1
        FROM public.drive_account_migration_items
        WHERE migration_id = %L LIMIT 1
    $sql$, (SELECT id FROM mig_id)));
    PERFORM pg_temp.rec(
        18, 'duplicate (migration_id, media_id) is refused',
        v_state = '23505', 'sqlstate=' || v_state
    );
END $blk$;

-- ===========================================================================
-- 19. A second active migration for the same source is refused
-- ===========================================================================
DO $blk$
DECLARE v_out jsonb;
BEGIN
    -- Put the fixture migration back in flight and clear the guard, so the plan
    -- is feasible and the DUPLICATE check is the thing under test (otherwise
    -- the retirement guard fires first and masks it).
    UPDATE public.drive_account_migrations SET status = 'RUNNING', completed_at = NULL
    WHERE id = (SELECT id FROM mig_id);
    UPDATE public.drive_accounts SET retiring_migration_id = NULL WHERE id = (SELECT src FROM fx);

    v_out := public.create_drive_account_migration(
        (SELECT src FROM fx), (SELECT health FROM fx_health), NULL);

    PERFORM pg_temp.rec(
        19, 'a second active migration for the same source is refused',
        (v_out ->> 'created')::boolean = false
          AND v_out -> 'reasons' @> '["MIGRATION_ALREADY_ACTIVE_FOR_SOURCE"]'::jsonb,
        'reason=' || COALESCE((v_out -> 'reasons')::text,'?')
    );
END $blk$;

-- ===========================================================================
-- 20. Planning refusal creates nothing
-- ===========================================================================
DO $blk$
DECLARE v_before int; v_after int; v_out jsonb;
BEGIN
    SELECT count(*)::int INTO v_before FROM public.drive_account_migrations;

    -- no fresh health supplied -> the plan is BLOCKED -> nothing may be created
    UPDATE public.drive_account_migrations SET status = 'CANCELLED'
    WHERE source_drive_account_id = (SELECT src FROM fx) AND status = 'RUNNING';
    UPDATE public.drive_accounts SET retiring_migration_id = NULL WHERE id = (SELECT src FROM fx);

    v_out := public.create_drive_account_migration((SELECT src FROM fx), NULL, NULL);
    SELECT count(*)::int INTO v_after FROM public.drive_account_migrations;

    PERFORM pg_temp.rec(
        20, 'a stale/unverifiable plan creates no migration',
        (v_out ->> 'created')::boolean = false AND v_after = v_before,
        'created=' || (v_out ->> 'created') || ' migrations ' || v_before || '->' || v_after
    );
END $blk$;

SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, scenario, detail
FROM w_results ORDER BY n;

ROLLBACK;
