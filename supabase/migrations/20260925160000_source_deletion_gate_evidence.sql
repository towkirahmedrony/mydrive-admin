-- ============================================================================
-- Source deletion gate — require COMPLETED migration + fresh dual evidence
-- ============================================================================
-- Extends the EXISTING gate rather than adding a second deletion path.  All
-- nine original destination-side checks are preserved verbatim; three checks
-- are added that only the database can make authoritatively:
--
--   migration_status_completed   the whole migration must be COMPLETED before
--                                a source may be destroyed
--   source_not_already_deleted   an item already SOURCE_DELETED (or holding a
--                                deletion timestamp) is refused, so a retry can
--                                never delete twice
--   fresh_evidence_present       the caller must supply the fresh BOTH-SIDES
--                                metadata it just read from Google, and that
--                                evidence must agree with the item's recorded
--                                provenance.  Without it the gate is closed.
--
-- The evidence parameter is additive with a DEFAULT, so the prior verdict
-- semantics are unchanged for callers that supply it.
--
-- WHAT THIS DOES AND DOES NOT PROVE
--   The gate cannot re-perform a Google read itself (it is SQL).  It therefore
--   requires the caller to present the observed metadata AND validates that
--   metadata against the item's own recorded source and destination
--   provenance — so the evidence cannot contradict the record, and a caller
--   cannot close the gate with an empty or mismatched claim.  The genuine
--   "the bytes are still there" assertion is made by the authenticated deletion
--   worker immediately before calling this function.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.can_delete_drive_migration_source(
    p_item_id uuid,
    p_evidence jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v              public.drive_account_migration_items%ROWTYPE;
    v_dest_acct    public.drive_accounts%ROWTYPE;
    v_dest_folder  public.drive_folders%ROWTYPE;
    v_dest_found   boolean := false;
    v_folder_found boolean := false;
    v_mig_status   text;

    c_file    boolean;
    c_fileid  boolean;
    c_account boolean;
    c_folder  boolean;
    c_name    boolean;
    c_size    boolean;
    c_md5     boolean;
    c_persist boolean;
    c_state   boolean;

    -- new
    c_mig_completed boolean;
    c_not_deleted   boolean;
    c_evidence      boolean;

    e_src_id    text;
    e_src_size  text;
    e_src_md5   text;
    e_src_trash boolean;
    e_dst_id    text;
    e_dst_size  text;
    e_dst_md5   text;
    e_dst_trash boolean;
    e_perm_src  boolean;
    e_perm_dst  boolean;

    v_reasons text[] := ARRAY[]::text[];
BEGIN
    SELECT * INTO v FROM public.drive_account_migration_items WHERE id = p_item_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'item_id', p_item_id,
            'eligible', false,
            'reasons', jsonb_build_array('migration_item_not_found')
        );
    END IF;

    IF v.destination_drive_account_id IS NOT NULL THEN
        SELECT * INTO v_dest_acct
        FROM public.drive_accounts
        WHERE id = v.destination_drive_account_id;
        v_dest_found := FOUND;
    END IF;

    IF v.destination_drive_folder_id IS NOT NULL THEN
        SELECT * INTO v_dest_folder
        FROM public.drive_folders
        WHERE id = v.destination_drive_folder_id;
        v_folder_found := FOUND;
    END IF;

    -- ── original checks (unchanged) ────────────────────────────────────────

    -- 1. destination file exists
    c_file := v.destination_google_drive_file_id IS NOT NULL;
    IF NOT c_file THEN v_reasons := array_append(v_reasons, 'destination_file_missing'); END IF;

    -- 2. destination Google file ID is known (non-empty)
    c_fileid := length(COALESCE(v.destination_google_drive_file_id, '')) > 0;
    IF NOT c_fileid THEN v_reasons := array_append(v_reasons, 'destination_google_file_id_unknown'); END IF;

    -- 3. destination account is correct: known, existing, and not the source
    c_account := v_dest_found
                 AND v.destination_drive_account_id <> v.source_drive_account_id;
    IF NOT c_account THEN v_reasons := array_append(v_reasons, 'destination_account_incorrect'); END IF;

    -- 4. destination folder is correct: known and belonging to that account
    c_folder := v_folder_found
                AND v_dest_folder.drive_account_id = v.destination_drive_account_id;
    IF NOT c_folder THEN v_reasons := array_append(v_reasons, 'destination_folder_incorrect'); END IF;

    -- 5. destination file name is correct
    c_name := v.destination_file_name IS NOT NULL
              AND v.destination_file_name = v.source_file_name;
    IF NOT c_name THEN v_reasons := array_append(v_reasons, 'destination_file_name_mismatch'); END IF;

    -- 6. destination size matches source
    c_size := v.destination_size_bytes IS NOT NULL
              AND v.destination_size_bytes = v.source_size_bytes;
    IF NOT c_size THEN v_reasons := array_append(v_reasons, 'destination_size_mismatch'); END IF;

    -- 7. destination MD5 matches source (both must exist; never assumed)
    c_md5 := v.source_md5 IS NOT NULL
             AND v.destination_md5 IS NOT NULL
             AND v.destination_md5 = v.source_md5;
    IF NOT c_md5 THEN v_reasons := array_append(v_reasons, 'destination_md5_mismatch'); END IF;

    -- 8. destination metadata is durably persisted
    c_persist := v.id IS NOT NULL AND v.verified_at IS NOT NULL;
    IF NOT c_persist THEN v_reasons := array_append(v_reasons, 'destination_verification_not_persisted'); END IF;

    -- 9. migration item is in the correct verified state
    c_state := v.verification_state = 'VERIFIED';
    IF NOT c_state THEN v_reasons := array_append(v_reasons, 'item_not_verified'); END IF;

    -- ── new checks ─────────────────────────────────────────────────────────

    -- 10. the whole migration must be COMPLETED
    SELECT m.status INTO v_mig_status
    FROM public.drive_account_migrations m
    WHERE m.id = v.migration_id;

    c_mig_completed := (v_mig_status = 'COMPLETED');
    IF NOT c_mig_completed THEN
        v_reasons := array_append(v_reasons, 'migration_not_completed');
    END IF;

    -- 11. the source must not already be deleted (retry can never delete twice)
    c_not_deleted := (v.source_deletion_state <> 'SOURCE_DELETED')
                     AND (v.source_deleted_at IS NULL);
    IF NOT c_not_deleted THEN
        v_reasons := array_append(v_reasons, 'source_already_deleted');
    END IF;

    -- 12. fresh dual-side evidence, consistent with the recorded provenance
    c_evidence := (p_evidence IS NOT NULL)
                  AND (p_evidence ? 'source')
                  AND (p_evidence ? 'destination');

    IF NOT c_evidence THEN
        v_reasons := array_append(v_reasons, 'fresh_verification_evidence_missing');
    ELSE
        e_src_id    := p_evidence #>> '{source,file_id}';
        e_src_size  := p_evidence #>> '{source,size}';
        e_src_md5   := p_evidence #>> '{source,md5}';
        e_src_trash := COALESCE((p_evidence #>> '{source,trashed}')::boolean, true);
        e_dst_id    := p_evidence #>> '{destination,file_id}';
        e_dst_size  := p_evidence #>> '{destination,size}';
        e_dst_md5   := p_evidence #>> '{destination,md5}';
        e_dst_trash := COALESCE((p_evidence #>> '{destination,trashed}')::boolean, true);
        e_perm_src  := COALESCE((p_evidence #>> '{source,account_identity_matched}')::boolean, false);
        e_perm_dst  := COALESCE((p_evidence #>> '{destination,account_identity_matched}')::boolean, false);

        -- source side must still be exactly the recorded original
        IF e_src_id IS DISTINCT FROM v.source_google_drive_file_id THEN
            c_evidence := false;
            v_reasons := array_append(v_reasons, 'evidence_source_file_id_mismatch');
        END IF;
        IF e_src_size IS DISTINCT FROM v.source_size_bytes::text THEN
            c_evidence := false;
            v_reasons := array_append(v_reasons, 'evidence_source_size_mismatch');
        END IF;
        IF e_src_md5 IS DISTINCT FROM v.source_md5 THEN
            c_evidence := false;
            v_reasons := array_append(v_reasons, 'evidence_source_md5_mismatch');
        END IF;
        IF e_src_trash THEN
            c_evidence := false;
            v_reasons := array_append(v_reasons, 'evidence_source_trashed');
        END IF;

        -- destination side must still be the verified copy
        IF e_dst_id IS DISTINCT FROM v.destination_google_drive_file_id THEN
            c_evidence := false;
            v_reasons := array_append(v_reasons, 'evidence_destination_file_id_mismatch');
        END IF;
        IF e_dst_id IS NOT DISTINCT FROM e_src_id THEN
            c_evidence := false;
            v_reasons := array_append(v_reasons, 'evidence_destination_equals_source');
        END IF;
        IF e_dst_size IS DISTINCT FROM v.source_size_bytes::text THEN
            c_evidence := false;
            v_reasons := array_append(v_reasons, 'evidence_destination_size_mismatch');
        END IF;
        IF e_dst_md5 IS DISTINCT FROM v.source_md5 THEN
            c_evidence := false;
            v_reasons := array_append(v_reasons, 'evidence_destination_md5_mismatch');
        END IF;
        IF e_dst_trash THEN
            c_evidence := false;
            v_reasons := array_append(v_reasons, 'evidence_destination_trashed');
        END IF;

        -- account identity must have been proven from the API, both sides
        IF NOT e_perm_src OR NOT e_perm_dst THEN
            c_evidence := false;
            v_reasons := array_append(v_reasons, 'evidence_account_identity_unproven');
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'item_id',                 p_item_id,
        'migration_id',            v.migration_id,
        'media_id',                v.media_id,
        'verification_state',      v.verification_state,
        'source_deletion_state',   v.source_deletion_state,
        'migration_status',        v_mig_status,
        'eligible',                (c_file AND c_fileid AND c_account AND c_folder
                                    AND c_name AND c_size AND c_md5 AND c_persist AND c_state
                                    AND c_mig_completed AND c_not_deleted AND c_evidence),
        'checks', jsonb_build_object(
            'destination_file_exists',          c_file,
            'destination_file_id_known',        c_fileid,
            'destination_account_correct',      c_account,
            'destination_folder_correct',       c_folder,
            'destination_name_matches',         c_name,
            'destination_size_matches',         c_size,
            'destination_md5_matches',          c_md5,
            'destination_metadata_persisted',   c_persist,
            'item_verified_state',              c_state,
            'migration_status_completed',       c_mig_completed,
            'source_not_already_deleted',       c_not_deleted,
            'fresh_evidence_valid',             c_evidence
        ),
        'reasons', to_jsonb(v_reasons)
    );
END;
$fn$;

COMMENT ON FUNCTION public.can_delete_drive_migration_source(uuid, jsonb) IS
    'Source deletion gate. Requires a COMPLETED migration, a VERIFIED item, an '
    'undeleted source, and fresh dual-side Drive evidence consistent with the '
    'recorded provenance. Read-only; reports every failed requirement.';

-- ---------------------------------------------------------------------------
-- Authorization — unchanged behaviour plus the evidence passthrough
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.authorize_drive_migration_source_deletion(
    p_item_id uuid,
    p_evidence jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_verdict jsonb;
    v_state   text;
    v_updated public.drive_account_migration_items%ROWTYPE;
BEGIN
    SELECT source_deletion_state INTO v_state
    FROM public.drive_account_migration_items
    WHERE id = p_item_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'authorized', false,
            'reasons', jsonb_build_array('migration_item_not_found')
        );
    END IF;

    -- idempotent: re-authorising an already-authorised item is not an error
    IF v_state IN ('SOURCE_DELETE_PENDING', 'SOURCE_DELETED') THEN
        RETURN jsonb_build_object(
            'authorized', true,
            'already_authorized', true,
            'source_deletion_state', v_state
        );
    END IF;

    v_verdict := public.can_delete_drive_migration_source(p_item_id, p_evidence);

    IF NOT (v_verdict ->> 'eligible')::boolean THEN
        RETURN jsonb_build_object(
            'authorized', false,
            'already_authorized', false,
            'reasons', v_verdict -> 'reasons',
            'checks',  v_verdict -> 'checks'
        );
    END IF;

    UPDATE public.drive_account_migration_items
    SET source_deletion_state       = 'SOURCE_DELETE_PENDING',
        source_delete_authorised_at = now(),
        updated_at                  = now()
    WHERE id = p_item_id
      AND verification_state = 'VERIFIED'            -- belt and braces
    RETURNING * INTO v_updated;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'authorized', false,
            'reasons', jsonb_build_array('state_changed_during_authorization')
        );
    END IF;

    RETURN jsonb_build_object(
        'authorized', true,
        'already_authorized', false,
        'item_id', v_updated.id,
        'source_deletion_state', v_updated.source_deletion_state,
        'authorized_at', v_updated.source_delete_authorised_at
    );
END;
$fn$;

COMMENT ON FUNCTION public.authorize_drive_migration_source_deletion(uuid, jsonb) IS
    'Authorises deletion of ONE source file. Refuses unless the migration is '
    'COMPLETED and the destination plus a fresh dual-side read of both files '
    'all pass. Idempotent. Never performs the deletion itself.';

COMMIT;
