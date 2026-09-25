-- ============================================================================
-- Drive Account Migration — dry-run orchestrator (READ-ONLY)
-- ============================================================================
-- Produces the complete dry-run plan as a single jsonb document.  Writes
-- nothing, reserves nothing, creates nothing, calls no Google API.
--
-- Fresh destination health is supplied by the caller as
-- `p_destination_health` (observed read-only via Drive about.get):
--
--   { "<drive_account_id>": {
--       "verified": true|false,
--       "email": "...", "permission_id": "...",
--       "storage_limit_bytes": N, "storage_usage_bytes": N,
--       "storage_available_bytes": N, "checked_at": "...", "error": null } }
--
-- A destination that is not present in that map, or not `verified`, is
-- treated as UNAVAILABLE — it is never assumed usable because the DB merely
-- says 'unknown'.  When the map is absent entirely, no destination is
-- considered verified and the verdict is BLOCKED.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.plan_drive_migration_dry_run(
    p_source_drive_account_id uuid,
    p_destination_health jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_source              public.drive_accounts%ROWTYPE;
    v_source_state        text;
    v_plan_all            jsonb;
    v_plan                jsonb;
    v_verified_ids        uuid[] := ARRAY[]::uuid[];
    v_candidate           jsonb;
    v_fresh               jsonb;
    v_identity_ok         boolean;
    v_verified            boolean;
    v_reason              text;
    v_destinations        jsonb := '[]'::jsonb;
    v_folders             jsonb := '[]'::jsonb;
    v_rec                 record;

    v_total_media         integer := 0;
    v_distinct_media      integer := 0;
    v_distinct_file_ids   integer := 0;
    v_missing_file_id     integer := 0;
    v_missing_folder      integer := 0;
    v_missing_size        integer := 0;
    v_missing_md5         integer := 0;
    v_unassigned          integer := 0;
    v_required_bytes      bigint  := 0;
    v_assigned_bytes      bigint  := 0;
    v_allocated_bytes     bigint  := 0;

    v_reasons             text[] := ARRAY[]::text[];
    v_checks              jsonb;
    v_feasible            boolean;
BEGIN
    SELECT * INTO v_source FROM public.drive_accounts WHERE id = p_source_drive_account_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'verdict', 'BLOCKED',
            'reasons', jsonb_build_array('SOURCE_ACCOUNT_MISSING'),
            'source_drive_account_id', p_source_drive_account_id,
            'planned_at', now()
        );
    END IF;

    v_source_state := public.drive_account_retirement_state(p_source_drive_account_id);

    IF v_source_state IN ('RETIRING', 'RETIRED') THEN
        v_reasons := array_append(v_reasons, 'SOURCE_ACCOUNT_ALREADY_RETIRING');
    END IF;

    -- ---- which destinations are freshly verified AND the right account? ----
    FOR v_rec IN
        SELECT da.id, da.google_email, da.google_permission_id
        FROM public.drive_accounts da
        WHERE da.id <> p_source_drive_account_id
        ORDER BY da.id
    LOOP
        v_fresh := p_destination_health -> v_rec.id::text;

        v_verified := v_fresh IS NOT NULL
                      AND COALESCE((v_fresh ->> 'verified')::boolean, false)
                      AND (v_fresh ->> 'error') IS NULL;

        IF v_verified THEN
            v_identity_ok := (v_fresh ->> 'email') = v_rec.google_email
                             AND (v_rec.google_permission_id IS NULL
                                  OR (v_fresh ->> 'permission_id') = v_rec.google_permission_id);
            IF v_identity_ok THEN
                v_verified_ids := array_append(v_verified_ids, v_rec.id);
            END IF;
        END IF;
    END LOOP;

    -- ---- existing selection model, run twice (reporting vs selecting) ----
    v_plan_all := public.plan_drive_account_migration(p_source_drive_account_id, NULL, NULL);
    v_plan     := public.plan_drive_account_migration(p_source_drive_account_id, NULL, v_verified_ids);

    -- ---- population + per-media safety analysis ----
    SELECT count(*)::int,
           count(DISTINCT out_media_id)::int,
           count(DISTINCT out_source_google_drive_file_id)::int,
           count(*) FILTER (WHERE out_source_google_drive_file_id IS NULL)::int,
           count(*) FILTER (WHERE out_source_drive_folder_id IS NULL)::int,
           count(*) FILTER (WHERE out_source_size_bytes IS NULL)::int,
           count(*) FILTER (WHERE out_source_md5 IS NULL)::int,
           count(*) FILTER (WHERE out_destination_drive_account_id IS NULL)::int,
           COALESCE(sum(out_source_size_bytes), 0)::bigint,
           COALESCE(sum(out_source_size_bytes)
                    FILTER (WHERE out_destination_drive_account_id IS NOT NULL), 0)::bigint
    INTO v_total_media, v_distinct_media, v_distinct_file_ids,
         v_missing_file_id, v_missing_folder, v_missing_size, v_missing_md5,
         v_unassigned, v_required_bytes, v_assigned_bytes
    FROM public.plan_drive_migration_items(
             p_source_drive_account_id,
             COALESCE(v_plan -> 'allocations', '[]'::jsonb)
         );

    v_allocated_bytes := COALESCE((v_plan ->> 'allocated_bytes')::bigint, 0);

    IF v_missing_file_id > 0 THEN v_reasons := array_append(v_reasons, 'MISSING_SOURCE_FILE_ID'); END IF;
    IF v_missing_folder  > 0 THEN v_reasons := array_append(v_reasons, 'MISSING_SOURCE_FOLDER'); END IF;
    IF v_missing_size    > 0 THEN v_reasons := array_append(v_reasons, 'MISSING_SOURCE_SIZE'); END IF;
    IF v_missing_md5     > 0 THEN v_reasons := array_append(v_reasons, 'MISSING_SOURCE_MD5'); END IF;

    -- duplicate source file ids would mean two media pointing at one Drive file
    IF v_distinct_file_ids <> v_total_media THEN
        v_reasons := array_append(v_reasons, 'DUPLICATE_SOURCE_FILE_IDS');
    END IF;
    -- a media appearing twice would be a conflicting assignment
    IF v_distinct_media <> v_total_media THEN
        v_reasons := array_append(v_reasons, 'DUPLICATE_MEDIA_ASSIGNMENT');
    END IF;

    IF v_total_media = 0 THEN
        v_reasons := array_append(v_reasons, 'NO_MIGRATABLE_MEDIA');
    ELSIF v_unassigned > 0 THEN
        v_reasons := array_append(v_reasons, 'MEDIA_WITHOUT_DESTINATION');
    END IF;

    IF v_allocated_bytes <> v_required_bytes THEN
        v_reasons := array_append(v_reasons, 'ALLOCATION_BYTES_MISMATCH');
    END IF;

    IF (v_plan -> 'reasons') @> '["insufficient_destination_capacity"]'::jsonb THEN
        v_reasons := array_append(v_reasons, 'INSUFFICIENT_CAPACITY');
    END IF;

    IF array_length(v_verified_ids, 1) IS NULL THEN
        IF EXISTS (
            SELECT 1 FROM public.drive_accounts da
            WHERE da.id <> p_source_drive_account_id
              AND COALESCE((p_destination_health -> da.id::text ->> 'verified')::boolean, false) = false
        ) THEN
            v_reasons := array_append(v_reasons, 'DESTINATION_HEALTH_UNKNOWN');
        END IF;
        v_reasons := array_append(v_reasons, 'NO_ELIGIBLE_DESTINATION');
    END IF;

    -- ---- destination table: db state + fresh state + reason ----
    FOR v_rec IN
        SELECT da.*,
               av.effective_available
        FROM public.drive_accounts da
        CROSS JOIN LATERAL (
            SELECT COALESCE(
                       da.storage_available_bytes,
                       CASE WHEN da.storage_limit_bytes IS NOT NULL
                            THEN GREATEST(da.storage_limit_bytes - COALESCE(da.storage_used_bytes, 0), 0)
                            ELSE NULL END
                   ) AS effective_available
        ) av
        WHERE da.id <> p_source_drive_account_id
        ORDER BY da.priority ASC, da.id ASC
    LOOP
        v_fresh := p_destination_health -> v_rec.id::text;

        v_verified := v_fresh IS NOT NULL
                      AND COALESCE((v_fresh ->> 'verified')::boolean, false)
                      AND (v_fresh ->> 'error') IS NULL;

        v_identity_ok := v_verified
                         AND (v_fresh ->> 'email') = v_rec.google_email
                         AND (v_rec.google_permission_id IS NULL
                              OR (v_fresh ->> 'permission_id') = v_rec.google_permission_id);

        SELECT c INTO v_candidate
        FROM jsonb_array_elements(v_plan_all -> 'candidates') c
        WHERE (c ->> 'drive_account_id')::uuid = v_rec.id
        LIMIT 1;

        -- reason, most specific first
        IF NOT v_verified THEN
            v_reason := 'DESTINATION_HEALTH_UNKNOWN';
        ELSIF NOT v_identity_ok THEN
            v_reason := 'DESTINATION_IDENTITY_MISMATCH';
        ELSIF v_candidate IS NULL THEN
            IF NOT v_rec.enabled THEN
                v_reason := 'DESTINATION_DISABLED';
            ELSIF v_rec.status <> 'active' THEN
                v_reason := 'DESTINATION_STATUS_' || upper(v_rec.status);
            ELSIF v_rec.connection_status NOT IN ('connected', 'unknown') THEN
                v_reason := 'DESTINATION_CONNECTION_' || upper(v_rec.connection_status);
            ELSIF v_rec.health_status NOT IN ('healthy', 'unknown') THEN
                v_reason := 'DESTINATION_HEALTH_' || upper(v_rec.health_status);
            ELSIF v_rec.retiring_migration_id IS NOT NULL THEN
                v_reason := 'DESTINATION_RETIRING';
            ELSIF v_rec.effective_available IS NULL THEN
                v_reason := 'DESTINATION_CONFIGURATION_ERROR';
            ELSE
                v_reason := 'INSUFFICIENT_DESTINATION_CAPACITY';
            END IF;
        ELSIF EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(v_plan -> 'allocations', '[]'::jsonb)) a
            WHERE (a ->> 'drive_account_id')::uuid = v_rec.id
        ) THEN
            v_reason := 'SELECTED';
        ELSE
            v_reason := 'ELIGIBLE_BUT_NOT_NEEDED';
        END IF;

        v_destinations := v_destinations || jsonb_build_object(
            'drive_account_id',        v_rec.id,
            'google_email',            v_rec.google_email,
            'google_permission_id',    v_rec.google_permission_id,
            'is_source',               false,
            'db_health_status',        v_rec.health_status,
            'db_connection_status',    v_rec.connection_status,
            'db_status',               v_rec.status,
            'db_enabled',              v_rec.enabled,
            'db_retiring_migration_id', v_rec.retiring_migration_id,
            'db_effective_available_bytes', v_rec.effective_available,
            'db_reserved_bytes',       COALESCE(v_rec.reserved_bytes, 0),
            'fresh_health_verified',   v_verified,
            'fresh_identity_matches',  COALESCE(v_identity_ok, false),
            'fresh_email',             v_fresh ->> 'email',
            'fresh_permission_id',     v_fresh ->> 'permission_id',
            'fresh_storage_available_bytes', CASE WHEN (v_fresh ->> 'storage_available_bytes') ~ '^[0-9]+$'
                                                  THEN (v_fresh ->> 'storage_available_bytes')::bigint END,
            'fresh_checked_at',        v_fresh ->> 'checked_at',
            'fresh_error',             v_fresh ->> 'error',
            'eligible_under_db_model', (v_candidate IS NOT NULL),
            'reported_usable_bytes',   CASE WHEN v_candidate IS NOT NULL
                                            THEN (v_candidate ->> 'usable_bytes')::bigint END,
            'safety_margin_bytes',     CASE WHEN v_candidate IS NOT NULL
                                            THEN (v_candidate ->> 'safety_margin_bytes')::bigint END,
            'selected',                EXISTS (
                SELECT 1 FROM jsonb_array_elements(COALESCE(v_plan -> 'allocations', '[]'::jsonb)) a
                WHERE (a ->> 'drive_account_id')::uuid = v_rec.id),
            'allocated_bytes',         COALESCE((
                SELECT (a ->> 'allocated_bytes')::bigint
                FROM jsonb_array_elements(COALESCE(v_plan -> 'allocations', '[]'::jsonb)) a
                WHERE (a ->> 'drive_account_id')::uuid = v_rec.id), 0),
            'reason',                  v_reason
        );
    END LOOP;

    -- ---- folder mapping for the selected destinations ----
    FOR v_rec IN
        SELECT f.*
        FROM public.plan_drive_migration_folders(
                 p_source_drive_account_id,
                 ARRAY(
                     SELECT (a ->> 'drive_account_id')::uuid
                     FROM jsonb_array_elements(COALESCE(v_plan -> 'allocations', '[]'::jsonb)) a
                 )
             ) f
    LOOP
        v_folders := v_folders || jsonb_build_object(
            'source_drive_folder_id',        v_rec.out_source_drive_folder_id,
            'source_google_folder_id',       v_rec.out_source_google_folder_id,
            'source_folder_name',            v_rec.out_source_folder_name,
            'source_folder_type',            v_rec.out_source_folder_type,
            'source_owner_id',               v_rec.out_source_owner_id,
            'media_count',                   v_rec.out_media_count,
            'total_bytes',                   v_rec.out_total_bytes,
            'destination_drive_account_id',  v_rec.out_destination_drive_account_id,
            'destination_account_email',     v_rec.out_destination_account_email,
            'destination_folder_name',       v_rec.out_destination_folder_name,
            'destination_folder_type',       v_rec.out_destination_folder_type,
            'existing_destination_folder_row_id',     v_rec.out_existing_destination_folder_row_id,
            'existing_destination_google_folder_id',  v_rec.out_existing_destination_google_folder_id,
            'existing_destination_folder_status',     v_rec.out_existing_destination_folder_status,
            'planned_action',                v_rec.out_planned_action,
            'mapping_basis',                 v_rec.out_mapping_basis
        );
    END LOOP;

    v_checks := jsonb_build_object(
        'source_account_exists',              true,
        'source_not_retiring',                v_source_state NOT IN ('RETIRING','RETIRED'),
        'source_account_state',               v_source_state,
        'every_media_has_source_file_id',     v_missing_file_id = 0,
        'every_media_has_source_folder',      v_missing_folder = 0,
        'every_media_has_source_size',        v_missing_size = 0,
        'every_media_has_source_md5',         v_missing_md5 = 0,
        'no_duplicate_source_file_ids',       v_distinct_file_ids = v_total_media,
        'no_duplicate_media_assignments',     v_distinct_media = v_total_media,
        'every_media_has_exactly_one_destination', v_total_media > 0 AND v_unassigned = 0,
        'no_media_with_zero_destinations',    v_unassigned = 0,
        'allocation_bytes_equal_required',    v_allocated_bytes = v_required_bytes,
        'destination_differs_from_source',    true,
        'destination_freshly_verified',       array_length(v_verified_ids, 1) IS NOT NULL,
        'safety_margin_applied',              true,
        'reserved_and_pending_included',      true,
        'sufficient_capacity',                COALESCE((v_plan ->> 'feasible')::boolean, false)
    );

    v_feasible := COALESCE((v_plan ->> 'feasible')::boolean, false)
                  AND array_length(v_verified_ids, 1) IS NOT NULL
                  AND v_source_state NOT IN ('RETIRING','RETIRED')
                  AND v_total_media > 0
                  AND v_unassigned = 0
                  AND v_missing_file_id = 0
                  AND v_missing_folder = 0
                  AND v_missing_size = 0
                  AND v_missing_md5 = 0
                  AND v_distinct_file_ids = v_total_media
                  AND v_distinct_media = v_total_media
                  AND v_allocated_bytes = v_required_bytes;

    RETURN jsonb_build_object(
        'planner_version',          'drive-migration-dry-run/1.0.0',
        'dry_run',                  true,
        'planning_only',            true,
        'wrote_anything',           false,
        'verdict',                  CASE WHEN v_feasible THEN 'FEASIBLE' ELSE 'BLOCKED' END,
        'reasons',                  COALESCE(
                                        (SELECT jsonb_agg(DISTINCT r ORDER BY r)
                                         FROM unnest(v_reasons) AS r),
                                        '[]'::jsonb),
        'source', jsonb_build_object(
            'drive_account_id', v_source.id,
            'google_email',     v_source.google_email,
            'retirement_state', v_source_state,
            'db_health_status', v_source.health_status,
            'db_connection_status', v_source.connection_status
        ),
        'population', jsonb_build_object(
            'media_count',          v_total_media,
            'distinct_media_ids',   v_distinct_media,
            'unique_source_file_ids', v_distinct_file_ids,
            'replication_jobs',     v_total_media,
            'total_required_bytes', v_required_bytes,
            'missing_source_file_id_count', v_missing_file_id,
            'missing_source_folder_count',  v_missing_folder,
            'missing_source_size_count',    v_missing_size,
            'missing_source_md5_count',     v_missing_md5
        ),
        'destinations',      v_destinations,
        'allocations',       COALESCE(v_plan -> 'allocations', '[]'::jsonb),
        'allocated_bytes',   v_allocated_bytes,
        'assigned_bytes',    v_assigned_bytes,
        'unassigned_media',  v_unassigned,
        'safety_margin_bytes', COALESCE((v_plan ->> 'safety_margin_bytes')::bigint, 0),
        'shortfall_bytes',   COALESCE((v_plan ->> 'shortfall_bytes')::bigint, 0),
        'single_account_sufficient', COALESCE((v_plan ->> 'single_account_sufficient')::boolean, false),
        'folder_mapping',    v_folders,
        'safety_checks',     v_checks,
        'fresh_health_supplied', p_destination_health IS NOT NULL,
        'planned_at',        now()
    );
END;
$fn$;

COMMENT ON FUNCTION public.plan_drive_migration_dry_run(uuid, jsonb) IS
    'READ-ONLY dry-run migration planner. Reuses plan_drive_account_migration '
    'for account selection, adds per-media and folder mapping plans plus a '
    'safety analysis. Writes nothing and reserves nothing. Verdict is FEASIBLE '
    'or BLOCKED.';

COMMIT;
