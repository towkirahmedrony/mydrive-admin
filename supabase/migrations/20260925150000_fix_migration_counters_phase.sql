-- ============================================================================
-- Fix: migration counters must measure the COPY-AND-VERIFY phase
-- ============================================================================
-- Found in production once the copy phase completed:
--
--   status = COMPLETED   but   completed_count = 0   and   migrated_bytes = 0
--
-- Cause: refresh_drive_account_migration_counters() was written during the
-- foundation task in terms of `source_deletion_state = 'SOURCE_DELETED'`. That
-- is a POST-deletion metric. The copy-and-verify phase deliberately never
-- deletes a source file, so completed_count / migrated_bytes could never leave
-- zero — the counters contradicted the item table.
--
-- Fix: the counters now measure the phase that actually runs, i.e. destination
-- verification.  Source-deletion progress is still fully reported, just
-- separately, by drive_migration_progress() -> source_deleted_count.  No
-- information is lost and no deletion semantics change.
--
-- `failed_count` is unchanged in meaning (failed or blocked items).
-- ============================================================================

BEGIN;

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
           -- completed == destination-verified (the phase this migration runs)
           count(*) FILTER (WHERE verification_state = 'VERIFIED')::int,
           count(*) FILTER (WHERE verification_state IN ('FAILED','BLOCKED')
                              OR source_deletion_state = 'FAILED')::int,
           -- migrated bytes == bytes proven present at the destination
           COALESCE(sum(source_size_bytes)
                    FILTER (WHERE verification_state = 'VERIFIED'), 0)::bigint
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

COMMENT ON FUNCTION public.refresh_drive_account_migration_counters(uuid) IS
    'Recomputes migration counters from the item table. completed_count and '
    'migrated_bytes measure DESTINATION VERIFICATION (the copy-and-verify '
    'phase). Source-deletion progress is reported separately by '
    'drive_migration_progress().';

COMMENT ON COLUMN public.drive_account_migrations.completed_count IS
    'Items whose destination copy is VERIFIED. Not a source-deletion count.';
COMMENT ON COLUMN public.drive_account_migrations.migrated_bytes IS
    'Sum of source_size_bytes for destination-VERIFIED items.';

COMMIT;
