-- ============================================================================
-- Drive Account Migration — safety gates, counters, audit vocabulary
-- ============================================================================
-- Additive.  These functions are the gates the FUTURE migration worker must
-- call.  Nothing here is invoked by this task, no Drive object is touched and
-- no account is removed.  A "force remove" bypass is deliberately NOT provided.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Source deletion gate — verdict only (read-only)
-- ---------------------------------------------------------------------------
-- Encodes: a source file may only be deleted after destination verification
-- succeeds.  Every requirement is evaluated and ALL failures are returned.
CREATE OR REPLACE FUNCTION public.can_delete_drive_migration_source(
    p_item_id uuid
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

    c_file    boolean;
    c_fileid  boolean;
    c_account boolean;
    c_folder  boolean;
    c_name    boolean;
    c_size    boolean;
    c_md5     boolean;
    c_persist boolean;
    c_state   boolean;

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

    RETURN jsonb_build_object(
        'item_id',                 p_item_id,
        'migration_id',            v.migration_id,
        'media_id',                v.media_id,
        'verification_state',      v.verification_state,
        'source_deletion_state',   v.source_deletion_state,
        'eligible',                (c_file AND c_fileid AND c_account AND c_folder
                                    AND c_name AND c_size AND c_md5 AND c_persist AND c_state),
        'checks', jsonb_build_object(
            'destination_file_exists',        c_file,
            'destination_file_id_known',      c_fileid,
            'destination_account_correct',    c_account,
            'destination_folder_correct',     c_folder,
            'destination_name_matches',       c_name,
            'destination_size_matches',       c_size,
            'destination_md5_matches',        c_md5,
            'destination_metadata_persisted', c_persist,
            'item_verified_state',            c_state
        ),
        'reasons', to_jsonb(v_reasons)
    );
END;
$fn$;

COMMENT ON FUNCTION public.can_delete_drive_migration_source(uuid) IS
    'Source deletion gate (verdict). No verified destination => not eligible. '
    'Read-only; reports every failed requirement, not just the first.';

-- ---------------------------------------------------------------------------
-- 2. Source deletion gate — authorise (the call the worker must make)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.authorize_drive_migration_source_deletion(
    p_item_id uuid
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

    v_verdict := public.can_delete_drive_migration_source(p_item_id);

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

COMMENT ON FUNCTION public.authorize_drive_migration_source_deletion(uuid) IS
    'Authorises deletion of a source Drive file. Refuses unless the destination '
    'is fully verified. Idempotent. Actual deletion is performed by the future '
    'worker, never by this function.';

-- ---------------------------------------------------------------------------
-- 3. Record completed source deletion (worker calls after deleting)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_drive_migration_source_deleted(
    p_item_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_updated public.drive_account_migration_items%ROWTYPE;
BEGIN
    UPDATE public.drive_account_migration_items
    SET source_deletion_state = 'SOURCE_DELETED',
        source_deleted_at     = now(),
        updated_at            = now()
    WHERE id = p_item_id
      AND source_deletion_state = 'SOURCE_DELETE_PENDING'
      AND verification_state    = 'VERIFIED'
    RETURNING * INTO v_updated;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'recorded', false,
            'reasons', jsonb_build_array('item_not_authorized_for_deletion')
        );
    END IF;

    RETURN jsonb_build_object(
        'recorded', true,
        'item_id', v_updated.id,
        'source_deleted_at', v_updated.source_deleted_at
    );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Account removal gate
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_drive_account_removal(
    p_drive_account_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_acct            public.drive_accounts%ROWTYPE;
    v_reasons         text[] := ARRAY[]::text[];
    v_lifecycle       text;

    b_migration_open  boolean := false;
    b_items_unverif   boolean := false;
    b_source_remain   boolean := false;
    b_job_active      boolean := false;
    b_errors          boolean := false;
    b_media_refs      boolean := false;
    b_retire_open     boolean := false;
    b_is_destination  boolean := false;
    b_consistency     boolean := false;

    v_open_migrations integer := 0;
    v_outstanding     integer := 0;
    v_total_items     integer := 0;
BEGIN
    SELECT * INTO v_acct FROM public.drive_accounts WHERE id = p_drive_account_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'drive_account_id', p_drive_account_id,
            'can_remove', false,
            'reasons', jsonb_build_array('account_not_found')
        );
    END IF;

    v_lifecycle := public.drive_account_retirement_state(p_drive_account_id);

    -- 1. no migration may still be in flight for this account
    SELECT count(*)::int INTO v_open_migrations
    FROM public.drive_account_migrations m
    WHERE m.source_drive_account_id = p_drive_account_id
      AND m.status IN ('PLANNED','RUNNING','PAUSED','BLOCKED');
    b_migration_open := v_open_migrations > 0;
    IF b_migration_open THEN v_reasons := array_append(v_reasons, 'migration_incomplete'); END IF;

    -- 2. nothing may be pending / processing
    b_job_active := EXISTS (
        SELECT 1 FROM public.drive_account_migration_items i
        JOIN public.drive_account_migrations m ON m.id = i.migration_id
        WHERE m.source_drive_account_id = p_drive_account_id
          AND i.verification_state IN ('PENDING','COPYING','COPIED')
    );
    IF b_job_active THEN v_reasons := array_append(v_reasons, 'migration_items_still_active'); END IF;

    -- 3. every destination verification must be complete
    b_items_unverif := EXISTS (
        SELECT 1 FROM public.drive_account_migration_items i
        JOIN public.drive_account_migrations m ON m.id = i.migration_id
        WHERE m.source_drive_account_id = p_drive_account_id
          AND i.verification_state <> 'VERIFIED'
    );
    IF b_items_unverif THEN v_reasons := array_append(v_reasons, 'destination_verification_incomplete'); END IF;

    -- 4. no unresolved migration errors
    b_errors := EXISTS (
        SELECT 1 FROM public.drive_account_migration_items i
        JOIN public.drive_account_migrations m ON m.id = i.migration_id
        WHERE m.source_drive_account_id = p_drive_account_id
          AND (i.verification_state IN ('FAILED','BLOCKED')
               OR i.source_deletion_state = 'FAILED')
    ) OR EXISTS (
        SELECT 1 FROM public.drive_account_migrations m
        WHERE m.source_drive_account_id = p_drive_account_id
          AND m.status = 'FAILED'
    );
    IF b_errors THEN v_reasons := array_append(v_reasons, 'unresolved_migration_error'); END IF;

    -- 5. no source Drive file may still be required
    b_source_remain := EXISTS (
        SELECT 1 FROM public.drive_account_migration_items i
        JOIN public.drive_account_migrations m ON m.id = i.migration_id
        WHERE m.source_drive_account_id = p_drive_account_id
          AND i.source_deletion_state <> 'SOURCE_DELETED'
    );
    IF b_source_remain THEN v_reasons := array_append(v_reasons, 'source_files_still_required'); END IF;

    -- 6. no media may still reference the account (this is what makes the
    --    existing ON DELETE SET NULL on replication_jobs non-destructive:
    --    removal is refused while any reference remains)
    b_media_refs := EXISTS (
        SELECT 1 FROM public.replication_jobs rj
        WHERE rj.drive_account_id = p_drive_account_id
          AND rj.google_drive_file_id IS NOT NULL
    );
    IF b_media_refs THEN v_reasons := array_append(v_reasons, 'media_still_references_account'); END IF;

    -- 7. the retirement must actually be finished
    IF v_acct.retiring_migration_id IS NOT NULL THEN
        b_retire_open := NOT EXISTS (
            SELECT 1 FROM public.drive_account_migrations m
            WHERE m.id = v_acct.retiring_migration_id
              AND m.status = 'COMPLETED'
        );
        IF b_retire_open THEN v_reasons := array_append(v_reasons, 'account_retirement_not_completed'); END IF;
    END IF;

    -- 8. the account must not be an active migration destination elsewhere
    b_is_destination := EXISTS (
        SELECT 1 FROM public.drive_account_migrations m
        WHERE p_drive_account_id = ANY (m.destination_account_ids)
          AND m.status IN ('PLANNED','RUNNING','PAUSED','BLOCKED')
    );
    IF b_is_destination THEN v_reasons := array_append(v_reasons, 'account_is_active_migration_destination'); END IF;

    -- 9. final consistency check
    SELECT count(*)::int,
           COALESCE(sum(CASE WHEN i.source_deletion_state <> 'SOURCE_DELETED' THEN 1 ELSE 0 END), 0)::int
    INTO v_total_items, v_outstanding
    FROM public.drive_account_migration_items i
    JOIN public.drive_account_migrations m ON m.id = i.migration_id
    WHERE m.source_drive_account_id = p_drive_account_id;

    b_consistency := EXISTS (
        SELECT 1 FROM public.drive_account_migrations m
        WHERE m.source_drive_account_id = p_drive_account_id
          AND (m.status = 'COMPLETED'
               OR m.completed_count + m.failed_count = m.total_media_count)
    );

    IF NOT b_consistency THEN
        v_reasons := array_append(v_reasons, 'final_consistency_check_failed');
    END IF;
    IF v_outstanding > 0 THEN
        v_reasons := array_append(v_reasons, 'outstanding_source_files_remain');
    END IF;

    RETURN jsonb_build_object(
        'drive_account_id',  p_drive_account_id,
        'google_email',      v_acct.google_email,
        'lifecycle_state',   v_lifecycle,
        'can_remove',        (cardinality(v_reasons) = 0),
        'open_migrations',   v_open_migrations,
        'total_items',       v_total_items,
        'outstanding_items', v_outstanding,
        'checks', jsonb_build_object(
            'no_open_migration',             NOT b_migration_open,
            'no_active_items',               NOT b_job_active,
            'destination_verification_done', NOT b_items_unverif,
            'no_unresolved_errors',          NOT b_errors,
            'no_source_files_remaining',     NOT b_source_remain,
            'no_media_references',           NOT b_media_refs,
            'retirement_completed',          NOT b_retire_open,
            'not_active_destination',        NOT b_is_destination,
            'final_consistency_passed',      b_consistency
        ),
        'reasons', to_jsonb(v_reasons)
    );
END;
$fn$;

COMMENT ON FUNCTION public.check_drive_account_removal(uuid) IS
    'Account removal gate. Returns can_remove=false with every blocking reason. '
    'No force-remove bypass exists by design.';

-- ---------------------------------------------------------------------------
-- 5. Bind the retirement guard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_drive_account_retiring(
    p_drive_account_id uuid,
    p_migration_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_mig public.drive_account_migrations%ROWTYPE;
BEGIN
    SELECT * INTO v_mig FROM public.drive_account_migrations WHERE id = p_migration_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('updated', false, 'reasons', jsonb_build_array('migration_not_found'));
    END IF;

    IF v_mig.source_drive_account_id <> p_drive_account_id THEN
        RETURN jsonb_build_object('updated', false, 'reasons', jsonb_build_array('migration_source_mismatch'));
    END IF;

    IF v_mig.status IN ('COMPLETED','CANCELLED') THEN
        RETURN jsonb_build_object('updated', false, 'reasons', jsonb_build_array('migration_terminal'));
    END IF;

    UPDATE public.drive_accounts
    SET retiring_migration_id = p_migration_id,
        updated_at            = now()
    WHERE id = p_drive_account_id
      AND (retiring_migration_id IS NULL OR retiring_migration_id = p_migration_id);

    IF NOT FOUND THEN
        RETURN jsonb_build_object('updated', false, 'reasons', jsonb_build_array('account_already_retiring'));
    END IF;

    RETURN jsonb_build_object(
        'updated', true,
        'drive_account_id', p_drive_account_id,
        'retiring_migration_id', p_migration_id,
        'lifecycle_state', public.drive_account_retirement_state(p_drive_account_id)
    );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Counters
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_drive_account_migration_counters(
    p_migration_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v public.drive_account_migrations%ROWTYPE;
    v_total      integer;
    v_completed  integer;
    v_failed     integer;
    v_migrated   bigint;
BEGIN
    SELECT * INTO v FROM public.drive_account_migrations WHERE id = p_migration_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('updated', false, 'reasons', jsonb_build_array('migration_not_found'));
    END IF;

    SELECT count(*)::int,
           count(*) FILTER (WHERE source_deletion_state = 'SOURCE_DELETED')::int,
           count(*) FILTER (WHERE verification_state IN ('FAILED','BLOCKED')
                              OR source_deletion_state = 'FAILED')::int,
           COALESCE(sum(source_size_bytes) FILTER (WHERE source_deletion_state = 'SOURCE_DELETED'), 0)::bigint
    INTO v_total, v_completed, v_failed, v_migrated
    FROM public.drive_account_migration_items
    WHERE migration_id = p_migration_id;

    UPDATE public.drive_account_migrations
    SET total_media_count = v_total,
        completed_count   = v_completed,
        failed_count      = v_failed,
        migrated_bytes    = v_migrated,
        updated_at        = now()
    WHERE id = p_migration_id;

    RETURN jsonb_build_object(
        'updated', true,
        'total_media_count', v_total,
        'completed_count', v_completed,
        'failed_count', v_failed,
        'migrated_bytes', v_migrated
    );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. Audit vocabulary (existing sync_logs — no new audit table)
-- ---------------------------------------------------------------------------
-- Migration events are distinguishable from ordinary replication events by
-- prefix:
--   DRIVE_MIGRATION_*        — migration lifecycle
--   DRIVE_ACCOUNT_RETIREMENT_* — account retirement
-- versus the pre-existing DRIVE_UPLOAD_VERIFIED / DRIVE_MEDIA_ARCHIVED etc.
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
        'DRIVE_MIGRATION_DESTINATION_SELECTED',
        'DRIVE_MIGRATION_COPY_STARTED',
        'DRIVE_MIGRATION_COPY_COMPLETED',
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

COMMENT ON FUNCTION public.log_drive_migration_event(text, uuid, uuid, text, text, jsonb) IS
    'Writes one migration audit event into the existing sync_logs table. '
    'Rejects unknown event types. No new audit table is introduced.';

COMMIT;
