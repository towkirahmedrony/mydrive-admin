-- ============================================================================
-- Source deletion gate — behaviour tests
-- ============================================================================
-- Runs inside ONE transaction that always ROLLBACKs, so it is safe against
-- production.  It exercises the gate against REAL migration items from the
-- COMPLETED migration, tampering with one field at a time to prove each
-- rejection, then restoring.
--
-- NOTE ON SCOPE: this suite proves the DATABASE-side gate and the RPC
-- invariants (idempotency, ordering constraints, "never mark deleted before the
-- deletion is confirmed").  The live Google-side behaviour — fresh dual-side
-- reads, the DELETE call, the post-delete confirmation reads — is proven in
-- production by drive-migration-source-delete and reported in full.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE sd_results (n integer, scenario text, ok boolean, detail text);
CREATE FUNCTION pg_temp.rec(p_n integer, p_s text, p_ok boolean, p_d text)
RETURNS void LANGUAGE sql AS $fn$
    INSERT INTO sd_results VALUES (p_n, p_s, p_ok, p_d);
$fn$;

-- A real, destination-verified item from the completed migration.
CREATE TEMP TABLE fx AS
SELECT i.* FROM public.drive_account_migration_items i
WHERE i.migration_id = '5b5552e1-285c-4738-b3e7-077169322be0'
  AND i.verification_state = 'VERIFIED'
ORDER BY i.created_at
LIMIT 3;

-- These items are borrowed from live production, where the deletion phase has
-- since run and they are all SOURCE_DELETED.  Normalise the three fixture items
-- back to the pre-deletion state so the gate can be exercised.  Everything here
-- is inside the transaction that is rolled back.
UPDATE public.drive_account_migration_items i
SET source_deletion_state       = 'NOT_ELIGIBLE',
    source_deleted_at           = NULL,
    source_delete_authorised_at = NULL,
    last_error                  = NULL,
    last_error_at               = NULL
WHERE i.id IN (SELECT id FROM fx)
  AND i.source_deletion_state = 'SOURCE_DELETED'
  AND i.verification_state = 'VERIFIED';

-- Build the "everything is fine" evidence straight from recorded provenance.
CREATE FUNCTION pg_temp.good_evidence(p_item public.drive_account_migration_items)
RETURNS jsonb LANGUAGE sql AS $fn$
    SELECT jsonb_build_object(
        'source', jsonb_build_object(
            'file_id', p_item.source_google_drive_file_id,
            'name',    p_item.destination_file_name,
            'size',    p_item.source_size_bytes::text,
            'md5',     p_item.source_md5,
            'trashed', false,
            'account_identity_matched', true),
        'destination', jsonb_build_object(
            'file_id', p_item.destination_google_drive_file_id,
            'name',    p_item.destination_file_name,
            'size',    p_item.source_size_bytes::text,
            'md5',     p_item.source_md5,
            'trashed', false,
            'account_identity_matched', true),
        'observed_at', now()::text);
$fn$;

CREATE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $fn$
BEGIN
    EXECUTE p_sql; RETURN 'NO_ERROR';
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE;
END;
$fn$;

CREATE FUNCTION pg_temp.item(p_idx integer) RETURNS public.drive_account_migration_items
LANGUAGE sql AS $fn$
    SELECT * FROM public.drive_account_migration_items
    WHERE id = (SELECT id FROM fx ORDER BY created_at, id OFFSET p_idx LIMIT 1);
$fn$;

-- ===========================================================================
-- 1. The happy path: fully verified item + fresh dual-side evidence
-- ===========================================================================
DO $blk$
DECLARE v public.drive_account_migration_items%ROWTYPE; v_verdict jsonb;
BEGIN
    v := pg_temp.item(0);
    v_verdict := public.can_delete_drive_migration_source(v.id, pg_temp.good_evidence(v));
    PERFORM pg_temp.rec(
        1, 'gate accepts a verified item with fresh dual-side evidence',
        (v_verdict ->> 'eligible')::boolean = true,
        'reasons=' || (v_verdict -> 'reasons')::text
    );
END $blk$;

-- ===========================================================================
-- 2. No evidence at all => closed
-- ===========================================================================
DO $blk$
DECLARE v public.drive_account_migration_items%ROWTYPE; v_verdict jsonb;
BEGIN
    v := pg_temp.item(0);
    v_verdict := public.can_delete_drive_migration_source(v.id);
    PERFORM pg_temp.rec(
        2, 'gate refuses without fresh verification evidence',
        (v_verdict ->> 'eligible')::boolean = false
          AND v_verdict -> 'reasons' @> '["fresh_verification_evidence_missing"]'::jsonb,
        'reasons=' || (v_verdict -> 'reasons')::text
    );
END $blk$;

-- ===========================================================================
-- 3-6. Destination-side mismatches each block deletion
-- ===========================================================================
DO $blk$
DECLARE v public.drive_account_migration_items%ROWTYPE; e jsonb; r jsonb;
BEGIN
    v := pg_temp.item(0);

    -- destination MD5 mismatch
    e := jsonb_set(pg_temp.good_evidence(v), '{destination,md5}', '"0000000000000000000000000000dead"');
    r := public.can_delete_drive_migration_source(v.id, e);
    PERFORM pg_temp.rec(3, 'destination MD5 mismatch blocks source deletion',
        (r ->> 'eligible')::boolean = false
          AND r -> 'reasons' @> '["evidence_destination_md5_mismatch"]'::jsonb,
        (r -> 'reasons')::text);

    -- destination size mismatch
    e := jsonb_set(pg_temp.good_evidence(v), '{destination,size}',
                   to_jsonb((v.source_size_bytes + 1)::text));
    r := public.can_delete_drive_migration_source(v.id, e);
    PERFORM pg_temp.rec(4, 'destination size mismatch blocks source deletion',
        (r ->> 'eligible')::boolean = false
          AND r -> 'reasons' @> '["evidence_destination_size_mismatch"]'::jsonb,
        (r -> 'reasons')::text);

    -- trashed destination
    e := jsonb_set(pg_temp.good_evidence(v), '{destination,trashed}', 'true');
    r := public.can_delete_drive_migration_source(v.id, e);
    PERFORM pg_temp.rec(5, 'trashed destination blocks source deletion',
        (r ->> 'eligible')::boolean = false
          AND r -> 'reasons' @> '["evidence_destination_trashed"]'::jsonb,
        (r -> 'reasons')::text);

    -- missing destination file id
    e := jsonb_set(pg_temp.good_evidence(v), '{destination,file_id}', 'null');
    r := public.can_delete_drive_migration_source(v.id, e);
    PERFORM pg_temp.rec(6, 'missing destination file id blocks source deletion',
        (r ->> 'eligible')::boolean = false
          AND r -> 'reasons' @> '["evidence_destination_file_id_mismatch"]'::jsonb,
        (r -> 'reasons')::text);

    -- destination name mismatch
    e := jsonb_set(pg_temp.good_evidence(v), '{destination,name}', '"wrong-name.bin"');
    r := public.can_delete_drive_migration_source(v.id, e);
    PERFORM pg_temp.rec(7, 'destination name mismatch blocks source deletion',
        (r ->> 'eligible')::boolean = false
          AND r -> 'reasons' @> '["evidence_destination_name_mismatch"]'::jsonb,
        (r -> 'reasons')::text);

    -- destination equals source (same object on both sides)
    e := jsonb_set(pg_temp.good_evidence(v), '{destination,file_id}',
                   to_jsonb(v.source_google_drive_file_id));
    r := public.can_delete_drive_migration_source(v.id, e);
    PERFORM pg_temp.rec(8, 'destination identical to source blocks source deletion',
        (r ->> 'eligible')::boolean = false
          AND r -> 'reasons' @> '["evidence_destination_equals_source"]'::jsonb,
        (r -> 'reasons')::text);

    -- account identity not proven from the API
    e := jsonb_set(pg_temp.good_evidence(v), '{source,account_identity_matched}', 'false');
    r := public.can_delete_drive_migration_source(v.id, e);
    PERFORM pg_temp.rec(9, 'unproven account identity blocks source deletion',
        (r ->> 'eligible')::boolean = false
          AND r -> 'reasons' @> '["evidence_account_identity_unproven"]'::jsonb,
        (r -> 'reasons')::text);
END $blk$;

-- ===========================================================================
-- 10-12. Source-side identity mismatches block deletion
-- ===========================================================================
DO $blk$
DECLARE v public.drive_account_migration_items%ROWTYPE; e jsonb; r jsonb;
BEGIN
    v := pg_temp.item(0);

    e := jsonb_set(pg_temp.good_evidence(v), '{source,file_id}', '"SOME-OTHER-FILE-ID"');
    r := public.can_delete_drive_migration_source(v.id, e);
    PERFORM pg_temp.rec(10, 'source file id mismatch blocks deletion',
        (r ->> 'eligible')::boolean = false
          AND r -> 'reasons' @> '["evidence_source_file_id_mismatch"]'::jsonb,
        (r -> 'reasons')::text);

    e := jsonb_set(pg_temp.good_evidence(v), '{source,md5}', '"ffffffffffffffffffffffffffffffff"');
    r := public.can_delete_drive_migration_source(v.id, e);
    PERFORM pg_temp.rec(11, 'source MD5 mismatch blocks deletion',
        (r ->> 'eligible')::boolean = false
          AND r -> 'reasons' @> '["evidence_source_md5_mismatch"]'::jsonb,
        (r -> 'reasons')::text);

    e := jsonb_set(pg_temp.good_evidence(v), '{source,size}',
                   to_jsonb((v.source_size_bytes + 5)::text));
    r := public.can_delete_drive_migration_source(v.id, e);
    PERFORM pg_temp.rec(12, 'source size mismatch blocks deletion',
        (r ->> 'eligible')::boolean = false
          AND r -> 'reasons' @> '["evidence_source_size_mismatch"]'::jsonb,
        (r -> 'reasons')::text);

    e := jsonb_set(pg_temp.good_evidence(v), '{source,trashed}', 'true');
    r := public.can_delete_drive_migration_source(v.id, e);
    PERFORM pg_temp.rec(13, 'trashed source blocks deletion',
        (r ->> 'eligible')::boolean = false
          AND r -> 'reasons' @> '["evidence_source_trashed"]'::jsonb,
        (r -> 'reasons')::text);
END $blk$;

-- ===========================================================================
-- 14-17. Recorded-item state also blocks deletion
-- ===========================================================================
DO $blk$
DECLARE v public.drive_account_migration_items%ROWTYPE; r jsonb; e jsonb; v_state text;
BEGIN
    v := pg_temp.item(0);
    e := pg_temp.good_evidence(v);

    -- unverified item
    UPDATE public.drive_account_migration_items SET verification_state='COPIED' WHERE id=v.id;
    r := public.can_delete_drive_migration_source(v.id, e);
    PERFORM pg_temp.rec(14, 'no source deletion before destination verification',
        (r ->> 'eligible')::boolean = false
          AND r -> 'reasons' @> '["item_not_verified"]'::jsonb,
        (r -> 'reasons')::text);
    UPDATE public.drive_account_migration_items SET verification_state='VERIFIED' WHERE id=v.id;

    -- migration not COMPLETED
    UPDATE public.drive_account_migrations SET status='RUNNING'
    WHERE source_drive_account_id = v.source_drive_account_id;
    r := public.can_delete_drive_migration_source(v.id, e);
    PERFORM pg_temp.rec(15, 'deletion refused while the migration is not COMPLETED',
        (r ->> 'eligible')::boolean = false
          AND r -> 'reasons' @> '["migration_not_completed"]'::jsonb,
        (r -> 'reasons')::text);
    UPDATE public.drive_account_migrations SET status='COMPLETED'
    WHERE source_drive_account_id = v.source_drive_account_id;

    -- missing destination provenance
    UPDATE public.drive_account_migration_items SET destination_google_drive_file_id=NULL WHERE id=v.id;
    r := public.can_delete_drive_migration_source(v.id, e);
    PERFORM pg_temp.rec(16, 'missing destination blocks deletion',
        (r ->> 'eligible')::boolean = false
          AND r -> 'reasons' @> '["destination_file_missing"]'::jsonb,
        (r -> 'reasons')::text);
    UPDATE public.drive_account_migration_items
    SET destination_google_drive_file_id = v.destination_google_drive_file_id WHERE id=v.id;

    -- A destination equal to the source is refused by the DATABASE itself, not
    -- merely by the gate, so the state is structurally unreachable.
    v_state := pg_temp.err(format($sql$
        UPDATE public.drive_account_migration_items
        SET destination_drive_account_id = source_drive_account_id WHERE id = %L
    $sql$, v.id));
    PERFORM pg_temp.rec(17, 'wrong destination account is refused by the database',
        v_state = '23514', 'sqlstate=' || v_state);
END $blk$;

-- ===========================================================================
-- 18-20. Authorization + idempotency + crash recovery
-- ===========================================================================
DO $blk$
DECLARE v public.drive_account_migration_items%ROWTYPE; out jsonb;
BEGIN
    v := pg_temp.item(1);

    -- authorization is refused without evidence
    out := public.authorize_drive_migration_source_deletion(v.id);
    PERFORM pg_temp.rec(18, 'authorization refused without fresh evidence',
        (out ->> 'authorized')::boolean = false,
        'authorized=false');

    -- and grows the item to SOURCE_DELETE_PENDING only with evidence
    out := public.authorize_drive_migration_source_deletion(v.id, pg_temp.good_evidence(v));
    PERFORM pg_temp.rec(19, 'authorization succeeds with valid evidence and records a timestamp',
        (out ->> 'authorized')::boolean = true
          AND (SELECT source_deletion_state = 'SOURCE_DELETE_PENDING'
                      AND source_delete_authorised_at IS NOT NULL
               FROM public.drive_account_migration_items WHERE id = v.id),
        'state=' || (SELECT source_deletion_state FROM public.drive_account_migration_items WHERE id=v.id));

    -- re-authorising is idempotent (safe to replay after a crash)
    out := public.authorize_drive_migration_source_deletion(v.id, pg_temp.good_evidence(v));
    PERFORM pg_temp.rec(20, 're-authorising the same item is idempotent',
        (out ->> 'authorized')::boolean = true
          AND (out ->> 'already_authorized')::boolean = true,
        'already_authorized=true');
END $blk$;

DO $blk$
DECLARE v public.drive_account_migration_items%ROWTYPE; out jsonb; out2 jsonb;
BEGIN
    v := pg_temp.item(1);   -- already SOURCE_DELETE_PENDING from the block above

    -- crash recovery: the source is gone and the item was authorised -> reconcile
    out := public.mark_drive_migration_source_deleted(v.id);
    PERFORM pg_temp.rec(21, 'authorised item can be reconciled to SOURCE_DELETED',
        (out ->> 'recorded')::boolean = true
          AND (SELECT source_deletion_state = 'SOURCE_DELETED'
                      AND source_deleted_at IS NOT NULL
               FROM public.drive_account_migration_items WHERE id = v.id),
        'recorded=true');

    -- replaying the crash-recovery path must not un-delete or double-record
    out2 := public.mark_drive_migration_source_deleted(v.id);
    PERFORM pg_temp.rec(22, 'replaying the reconciliation is idempotent',
        (out2 ->> 'recorded')::boolean = false
          AND (SELECT source_deletion_state = 'SOURCE_DELETED'
               FROM public.drive_account_migration_items WHERE id = v.id),
        'second call recorded=false, state still SOURCE_DELETED');

    -- an already SOURCE_DELETED item can never be deleted again
    PERFORM pg_temp.rec(23, 'an already SOURCE_DELETED item is not deleted again',
        (public.can_delete_drive_migration_source(v.id, pg_temp.good_evidence(v))
           ->> 'eligible')::boolean = false
          AND public.can_delete_drive_migration_source(v.id, pg_temp.good_evidence(v))
                -> 'reasons' @> '["source_already_deleted"]'::jsonb,
        'gate closed: source_already_deleted');
END $blk$;

-- ===========================================================================
-- 24. Never mark deleted unless the item was authorised for deletion
-- ===========================================================================
DO $blk$
DECLARE v public.drive_account_migration_items%ROWTYPE; out jsonb;
BEGIN
    v := pg_temp.item(2);   -- untouched: NOT_ELIGIBLE
    out := public.mark_drive_migration_source_deleted(v.id);
    PERFORM pg_temp.rec(24, 'marking deleted is refused for a non-authorised item',
        (out ->> 'recorded')::boolean = false
          AND (SELECT source_deletion_state = 'NOT_ELIGIBLE'
                      AND source_deleted_at IS NULL
               FROM public.drive_account_migration_items WHERE id = v.id),
        'recorded=false, state unchanged');
END $blk$;

-- ===========================================================================
-- 25. A failure is recorded without disturbing an already-deleted item
-- ===========================================================================
DO $blk$
DECLARE v_fail public.drive_account_migration_items%ROWTYPE;
        v_done public.drive_account_migration_items%ROWTYPE;
        out jsonb;
BEGIN
    v_fail := pg_temp.item(2);
    out := public.fail_drive_migration_source_deletion(v_fail.id, 'test: destination_trashed');
    PERFORM pg_temp.rec(25, 'a deletion failure is recorded with its exact reason',
        (out ->> 'recorded')::boolean = true
          AND (SELECT source_deletion_state = 'FAILED'
                      AND last_error = 'test: destination_trashed'
               FROM public.drive_account_migration_items WHERE id = v_fail.id),
        'state=FAILED reason recorded');
    -- restore so the run cannot be affected
    UPDATE public.drive_account_migration_items
    SET source_deletion_state = 'NOT_ELIGIBLE', last_error = NULL, last_error_at = NULL
    WHERE id = v_fail.id;

    v_done := pg_temp.item(1);   -- SOURCE_DELETED from above
    out := public.fail_drive_migration_source_deletion(v_done.id, 'late failure');
    PERFORM pg_temp.rec(26, 'a late failure cannot downgrade an already-deleted item',
        (out ->> 'recorded')::boolean = false
          AND (SELECT source_deletion_state = 'SOURCE_DELETED'
               FROM public.drive_account_migration_items WHERE id = v_done.id),
        'SOURCE_DELETED preserved');
END $blk$;

-- ===========================================================================
-- 27. Account removal stays blocked while source references remain
-- ===========================================================================
DO $blk$
DECLARE v_src uuid; v_check jsonb;
BEGIN
    SELECT source_drive_account_id INTO v_src FROM fx LIMIT 1;
    v_check := public.check_drive_account_removal(v_src);

    PERFORM pg_temp.rec(
        27, 'account removal remains blocked while source references remain',
        (v_check ->> 'can_remove')::boolean = false
          AND (v_check -> 'reasons' @> '["media_still_references_account"]'::jsonb
               OR v_check -> 'reasons' @> '["source_files_still_required"]'::jsonb),
        'reasons=' || (v_check -> 'reasons')::text
    );
END $blk$;

SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, scenario, detail
FROM sd_results ORDER BY n;

ROLLBACK;
