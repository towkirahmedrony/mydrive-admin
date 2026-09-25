-- ============================================================================
-- Fix: the gate's destination NAME check compared the wrong field
-- ============================================================================
-- Found while arming the deletion phase: the gate could never pass.
--
--   source_file_name        = the RAW media name    e.g. IMG-20260723-WA0018.jpg
--   destination_file_name   = the DERIVED Drive name e.g. IMG-20260723-WA0018_media_c26ed8ca.jpg
--
-- Check 5 compared the two directly (`destination_file_name = source_file_name`),
-- but the uploader deliberately renames the Drive object via driveFileName()
-- (sanitise + `media_<id8>` collision tag). The comparison was therefore
-- unsatisfiable and would have refused every deletion — fail-closed, but broken.
--
-- Correct model: `destination_file_name` IS the expected deterministic Drive
-- name. It is:
--   * stored on the item by the copy worker, which derived it from the source
--     file's own Drive name, and
--   * independently confirmed live by the post-migration reconciliation
--     (243/243 destination names matched).
--
-- So the gate now requires a non-null stored name, and the strict name equality
-- is asserted against BOTH live reads via the evidence block — which is
-- stronger than the original (it checks the real source name and the real
-- destination name, not two database columns).
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

    c_mig_completed boolean;
    c_not_deleted   boolean;
    c_evidence      boolean;

    e_src_id    text;
    e_src_size  text;
    e_src_md5   text;
    e_src_name  text;
    e_src_trash boolean;
    e_dst_id    text;
    e_dst_size  text;
    e_dst_md5   text;
    e_dst_name  text;
    e_dst_trash boolean;
    e_perm_src  boolean;
    e_perm_dst  boolean;

    v_reasons text[] := ARRAY[]::text[];
BEGIN
    SELECT * INTO v FROM public.drive_account_migration_items WHERE id = p_item_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'item_id', p_item_id, 'eligible', false,
            'reasons', jsonb_build_array('migration_item_not_found')
        );
    END IF;

    IF v.destination_drive_account_id IS NOT NULL THEN
        SELECT * INTO v_dest_acct FROM public.drive_accounts
        WHERE id = v.destination_drive_account_id;
        v_dest_found := FOUND;
    END IF;

    IF v.destination_drive_folder_id IS NOT NULL THEN
        SELECT * INTO v_dest_folder FROM public.drive_folders
        WHERE id = v.destination_drive_folder_id;
        v_folder_found := FOUND;
    END IF;

    -- ── 1-9: original checks ───────────────────────────────────────────────
    c_file := v.destination_google_drive_file_id IS NOT NULL;
    IF NOT c_file THEN v_reasons := array_append(v_reasons, 'destination_file_missing'); END IF;

    c_fileid := length(COALESCE(v.destination_google_drive_file_id, '')) > 0;
    IF NOT c_fileid THEN v_reasons := array_append(v_reasons, 'destination_google_file_id_unknown'); END IF;

    c_account := v_dest_found
                 AND v.destination_drive_account_id <> v.source_drive_account_id;
    IF NOT c_account THEN v_reasons := array_append(v_reasons, 'destination_account_incorrect'); END IF;

    c_folder := v_folder_found
                AND v_dest_folder.drive_account_id = v.destination_drive_account_id;
    IF NOT c_folder THEN v_reasons := array_append(v_reasons, 'destination_folder_incorrect'); END IF;

    -- 5. the expected deterministic Drive name must be recorded. The strict
    --    equality against the LIVE name on both sides is enforced in the
    --    evidence block below.
    c_name := v.destination_file_name IS NOT NULL
              AND length(v.destination_file_name) > 0;
    IF NOT c_name THEN v_reasons := array_append(v_reasons, 'destination_file_name_missing'); END IF;

    c_size := v.destination_size_bytes IS NOT NULL
              AND v.destination_size_bytes = v.source_size_bytes;
    IF NOT c_size THEN v_reasons := array_append(v_reasons, 'destination_size_mismatch'); END IF;

    c_md5 := v.source_md5 IS NOT NULL
             AND v.destination_md5 IS NOT NULL
             AND v.destination_md5 = v.source_md5;
    IF NOT c_md5 THEN v_reasons := array_append(v_reasons, 'destination_md5_mismatch'); END IF;

    c_persist := v.id IS NOT NULL AND v.verified_at IS NOT NULL;
    IF NOT c_persist THEN v_reasons := array_append(v_reasons, 'destination_verification_not_persisted'); END IF;

    c_state := v.verification_state = 'VERIFIED';
    IF NOT c_state THEN v_reasons := array_append(v_reasons, 'item_not_verified'); END IF;

    -- ── 10-12: phase and evidence ──────────────────────────────────────────
    SELECT m.status INTO v_mig_status
    FROM public.drive_account_migrations m WHERE m.id = v.migration_id;

    c_mig_completed := (v_mig_status = 'COMPLETED');
    IF NOT c_mig_completed THEN
        v_reasons := array_append(v_reasons, 'migration_not_completed');
    END IF;

    c_not_deleted := (v.source_deletion_state <> 'SOURCE_DELETED')
                     AND (v.source_deleted_at IS NULL);
    IF NOT c_not_deleted THEN
        v_reasons := array_append(v_reasons, 'source_already_deleted');
    END IF;

    c_evidence := (p_evidence IS NOT NULL)
                  AND (p_evidence ? 'source')
                  AND (p_evidence ? 'destination');

    IF NOT c_evidence THEN
        v_reasons := array_append(v_reasons, 'fresh_verification_evidence_missing');
    ELSE
        e_src_id    := p_evidence #>> '{source,file_id}';
        e_src_size  := p_evidence #>> '{source,size}';
        e_src_md5   := p_evidence #>> '{source,md5}';
        e_src_name  := p_evidence #>> '{source,name}';
        e_src_trash := COALESCE((p_evidence #>> '{source,trashed}')::boolean, true);
        e_dst_id    := p_evidence #>> '{destination,file_id}';
        e_dst_size  := p_evidence #>> '{destination,size}';
        e_dst_md5   := p_evidence #>> '{destination,md5}';
        e_dst_name  := p_evidence #>> '{destination,name}';
        e_dst_trash := COALESCE((p_evidence #>> '{destination,trashed}')::boolean, true);
        e_perm_src  := COALESCE((p_evidence #>> '{source,account_identity_matched}')::boolean, false);
        e_perm_dst  := COALESCE((p_evidence #>> '{destination,account_identity_matched}')::boolean, false);

        IF e_src_id IS DISTINCT FROM v.source_google_drive_file_id THEN
            c_evidence := false; v_reasons := array_append(v_reasons, 'evidence_source_file_id_mismatch');
        END IF;
        IF e_src_size IS DISTINCT FROM v.source_size_bytes::text THEN
            c_evidence := false; v_reasons := array_append(v_reasons, 'evidence_source_size_mismatch');
        END IF;
        IF e_src_md5 IS DISTINCT FROM v.source_md5 THEN
            c_evidence := false; v_reasons := array_append(v_reasons, 'evidence_source_md5_mismatch');
        END IF;
        IF e_src_name IS DISTINCT FROM v.destination_file_name THEN
            c_evidence := false; v_reasons := array_append(v_reasons, 'evidence_source_name_mismatch');
        END IF;
        IF e_src_trash THEN
            c_evidence := false; v_reasons := array_append(v_reasons, 'evidence_source_trashed');
        END IF;

        IF e_dst_id IS DISTINCT FROM v.destination_google_drive_file_id THEN
            c_evidence := false; v_reasons := array_append(v_reasons, 'evidence_destination_file_id_mismatch');
        END IF;
        IF e_dst_id IS NOT DISTINCT FROM e_src_id THEN
            c_evidence := false; v_reasons := array_append(v_reasons, 'evidence_destination_equals_source');
        END IF;
        IF e_dst_size IS DISTINCT FROM v.source_size_bytes::text THEN
            c_evidence := false; v_reasons := array_append(v_reasons, 'evidence_destination_size_mismatch');
        END IF;
        IF e_dst_md5 IS DISTINCT FROM v.source_md5 THEN
            c_evidence := false; v_reasons := array_append(v_reasons, 'evidence_destination_md5_mismatch');
        END IF;
        IF e_dst_name IS DISTINCT FROM v.destination_file_name THEN
            c_evidence := false; v_reasons := array_append(v_reasons, 'evidence_destination_name_mismatch');
        END IF;
        IF e_dst_trash THEN
            c_evidence := false; v_reasons := array_append(v_reasons, 'evidence_destination_trashed');
        END IF;

        IF NOT e_perm_src OR NOT e_perm_dst THEN
            c_evidence := false; v_reasons := array_append(v_reasons, 'evidence_account_identity_unproven');
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'item_id', p_item_id,
        'migration_id', v.migration_id,
        'media_id', v.media_id,
        'verification_state', v.verification_state,
        'source_deletion_state', v.source_deletion_state,
        'migration_status', v_mig_status,
        'expected_drive_name', v.destination_file_name,
        'eligible', (c_file AND c_fileid AND c_account AND c_folder
                     AND c_name AND c_size AND c_md5 AND c_persist AND c_state
                     AND c_mig_completed AND c_not_deleted AND c_evidence),
        'checks', jsonb_build_object(
            'destination_file_exists',          c_file,
            'destination_file_id_known',        c_fileid,
            'destination_account_correct',      c_account,
            'destination_folder_correct',       c_folder,
            'destination_name_recorded',        c_name,
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

COMMIT;
