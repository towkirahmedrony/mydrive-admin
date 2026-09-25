-- ============================================================================
-- Drive Account Migration — READ-ONLY dry-run planner
-- ============================================================================
-- Planning only.  Every function here is STABLE and writes NOTHING: no
-- migration record, no migration item, no reservation, no folder, no Drive
-- call.  It reads production state and returns a plan.
--
-- Account selection is NOT reimplemented.  This file extends the existing
-- `list_eligible_drive_accounts` / `plan_drive_account_migration` pair with an
-- optional "these destinations were freshly health-verified" allowlist, and
-- then layers three read-only additions on top:
--
--   plan_drive_migration_items()    per-media plan (deterministic packing)
--   plan_drive_migration_folders()  source folder -> destination folder mapping
--   plan_drive_migration_dry_run()  orchestrator: population, destinations,
--                                   allocation, folder mapping, safety analysis,
--                                   FEASIBLE / BLOCKED verdict
--
-- Both added parameters default to NULL, which reproduces the previous
-- behaviour exactly, so the existing replication worker is unaffected.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Eligibility gains an optional fresh-health allowlist
-- ---------------------------------------------------------------------------
-- When p_require_health_verified_ids IS NULL this is the previous function
-- verbatim.  When supplied, only those accounts remain candidates — which is
-- how a destination whose health is only 'unknown' in the DB stops being
-- treated as usable without writing anything to drive_accounts.
CREATE OR REPLACE FUNCTION public.list_eligible_drive_accounts(
    p_required_bytes bigint DEFAULT 0,
    p_exclude_account_ids uuid[] DEFAULT '{}'::uuid[],
    p_safety_margin_bytes bigint DEFAULT NULL::bigint,
    p_require_health_verified_ids uuid[] DEFAULT NULL
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
      AND da.retiring_migration_id IS NULL
      AND NOT (da.id = ANY (COALESCE(p_exclude_account_ids, '{}'::uuid[])))
      AND (p_require_health_verified_ids IS NULL
           OR da.id = ANY (p_require_health_verified_ids))      -- NEW
      AND av.effective_available IS NOT NULL
      AND av.effective_available - v_req - COALESCE(da.reserved_bytes, 0) >= v_margin
    ORDER BY da.priority ASC,
             (av.effective_available - v_req) DESC,
             da.last_quota_check_at ASC NULLS FIRST,
             da.created_at ASC,
             da.id ASC;                                          -- NEW: total order
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Planner gains the same allowlist + a total ordering
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.plan_drive_account_migration(
    p_source_drive_account_id uuid,
    p_safety_margin_bytes bigint DEFAULT NULL,
    p_require_health_verified_ids uuid[] DEFAULT NULL
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
          AND (p_require_health_verified_ids IS NULL
               OR da.id = ANY (p_require_health_verified_ids))   -- NEW
          AND av.effective_available IS NOT NULL
        ORDER BY da.priority ASC,
                 (av.effective_available - COALESCE(da.reserved_bytes, 0)) DESC,
                 da.last_quota_check_at ASC NULLS FIRST,
                 da.created_at ASC,
                 da.id ASC                                          -- NEW: total order
    LOOP
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

-- ---------------------------------------------------------------------------
-- 3. Per-media plan (read-only, deterministic)
-- ---------------------------------------------------------------------------
-- Destination assignment: media ordered by media_id ASC, destinations in the
-- order the existing planner allocated them, packed by cumulative bytes.  The
-- item that crosses a boundary goes to the destination where its START offset
-- lies, so every media is assigned exactly once and the result depends only on
-- production state — never on invocation order or timing.
CREATE OR REPLACE FUNCTION public.plan_drive_migration_items(
    p_source_drive_account_id uuid,
    p_allocations jsonb DEFAULT NULL
)
RETURNS TABLE (
    out_media_id                     uuid,
    out_source_drive_account_id      uuid,
    out_source_drive_folder_id       uuid,
    out_source_google_folder_id      text,
    out_source_drive_folder_name     text,
    out_source_google_drive_file_id  text,
    out_source_file_name             text,
    out_source_size_bytes            bigint,
    out_source_md5                   text,
    out_source_md5_event_id          bigint,
    out_destination_drive_account_id uuid,
    out_destination_account_email    text,
    out_destination_folder_spec      jsonb,
    out_planned_state                text,
    out_assignment_reason            text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
    WITH src AS (
        SELECT rj.media_id          AS mid,
               rj.drive_folder_id   AS folder_row_id,
               rj.google_drive_file_id AS file_id,
               ma.file_name         AS name,
               ma.file_size         AS size_bytes
        FROM public.replication_jobs rj
        JOIN public.media_assets ma ON ma.id = rj.media_id
        WHERE rj.destination_type = 'google_drive'
          AND rj.status = 'COMPLETED'
          AND rj.google_drive_file_id IS NOT NULL
          AND rj.drive_account_id = p_source_drive_account_id
    ),
    -- authoritative stored MD5: earliest DRIVE_UPLOAD_VERIFIED for the CURRENT
    -- file id (the rule established by the archive integrity baseline)
    md5 AS (
        SELECT s.mid,
               sl.metadata ->> 'drive_md5' AS md5,
               sl.id                       AS event_id
        FROM src s
        JOIN LATERAL (
            SELECT sl.id, sl.metadata
            FROM public.sync_logs sl
            WHERE sl.event_type = 'DRIVE_UPLOAD_VERIFIED'
              AND sl.media_id = s.mid
              AND sl.metadata ->> 'file_id' = s.file_id
            ORDER BY sl.created_at ASC, sl.id ASC
            LIMIT 1
        ) sl ON true
    ),
    cum AS (
        SELECT s.mid, s.folder_row_id, s.file_id, s.name, s.size_bytes,
               sum(s.size_bytes) OVER (ORDER BY s.mid) - s.size_bytes AS cum_before
        FROM src s
    ),
    budgets AS (
        SELECT (a ->> 'drive_account_id')::uuid AS acct,
               (a ->> 'allocated_bytes')::bigint AS alloc,
               row_number() OVER (ORDER BY ord)  AS rn,
               sum((a ->> 'allocated_bytes')::bigint) OVER (ORDER BY ord) AS cum_alloc
        FROM jsonb_array_elements(COALESCE(p_allocations, '[]'::jsonb))
             WITH ORDINALITY AS t(a, ord)
    )
    SELECT
        c.mid,
        p_source_drive_account_id,
        c.folder_row_id,
        df.google_folder_id,
        df.folder_name,
        c.file_id,
        c.name,
        c.size_bytes,
        m.md5,
        m.event_id,
        b.acct,
        da.google_email,
        CASE WHEN b.acct IS NULL THEN NULL
             ELSE jsonb_build_object(
                      'folder_type', df.folder_type,
                      'folder_name', df.folder_name,
                      'owner_id',    df.owner_id)
        END,
        CASE WHEN b.acct IS NULL THEN 'UNASSIGNED' ELSE 'PLANNED_COPY_PENDING' END,
        CASE WHEN b.acct IS NULL THEN 'no_destination_capacity_available'
             ELSE 'deterministic_cumulative_packing' END
    FROM cum c
    LEFT JOIN md5 m                     ON m.mid = c.mid
    LEFT JOIN public.drive_folders df   ON df.id = c.folder_row_id
    LEFT JOIN LATERAL (
        SELECT bb.acct
        FROM budgets bb
        WHERE bb.cum_alloc > c.cum_before
        ORDER BY bb.rn
        LIMIT 1
    ) b ON true
    LEFT JOIN public.drive_accounts da  ON da.id = b.acct
    ORDER BY c.mid;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Folder mapping plan (read-only)
-- ---------------------------------------------------------------------------
-- Determines the mapping the future worker will need.  The destination folder
-- is resolved exactly the way `claim_drive_folder()` resolves it — by
-- (drive_account_id, folder_type, owner_id) — so the plan reflects the real
-- deterministic primitive and creates nothing.
CREATE OR REPLACE FUNCTION public.plan_drive_migration_folders(
    p_source_drive_account_id uuid,
    p_destination_account_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
    out_source_drive_folder_id                uuid,
    out_source_google_folder_id               text,
    out_source_folder_name                    text,
    out_source_folder_type                    text,
    out_source_owner_id                       uuid,
    out_media_count                           integer,
    out_total_bytes                           bigint,
    out_destination_drive_account_id          uuid,
    out_destination_account_email             text,
    out_destination_folder_name               text,
    out_destination_folder_type               text,
    out_existing_destination_folder_row_id    uuid,
    out_existing_destination_google_folder_id text,
    out_existing_destination_folder_status    text,
    out_planned_action                        text,
    out_mapping_basis                         text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
    WITH src_folders AS (
        SELECT rj.drive_folder_id AS folder_row_id,
               count(*)::int      AS media_count,
               sum(ma.file_size)::bigint AS total_bytes
        FROM public.replication_jobs rj
        JOIN public.media_assets ma ON ma.id = rj.media_id
        WHERE rj.destination_type = 'google_drive'
          AND rj.status = 'COMPLETED'
          AND rj.google_drive_file_id IS NOT NULL
          AND rj.drive_account_id = p_source_drive_account_id
        GROUP BY rj.drive_folder_id
    ),
    dests AS (
        SELECT da.id, da.google_email
        FROM public.drive_accounts da
        WHERE p_destination_account_ids IS NOT NULL
          AND da.id = ANY (p_destination_account_ids)
    )
    SELECT
        sf.folder_row_id,
        df.google_folder_id,
        df.folder_name,
        df.folder_type,
        df.owner_id,
        sf.media_count,
        sf.total_bytes,
        d.id,
        d.google_email,
        df.folder_name,      -- destination folder keeps the source name
        df.folder_type,      -- and the source type
        existing.id,
        existing.google_folder_id,
        existing.folder_status,
        CASE
            WHEN existing.id IS NULL               THEN 'WORKER_MUST_CREATE'
            WHEN existing.google_folder_id IS NULL THEN 'WORKER_MUST_CREATE_OR_RESUME'
            ELSE 'REUSE_EXISTING'
        END,
        'claim_drive_folder(drive_account_id, owner_id, folder_type)'
    FROM src_folders sf
    JOIN public.drive_folders df ON df.id = sf.folder_row_id
    CROSS JOIN dests d
    LEFT JOIN LATERAL (
        SELECT edf.id, edf.google_folder_id, edf.folder_status
        FROM public.drive_folders edf
        WHERE edf.drive_account_id = d.id
          AND edf.folder_type = df.folder_type
          AND (edf.owner_id = df.owner_id
               OR (edf.owner_id IS NULL AND df.owner_id IS NULL))
        ORDER BY edf.created_at ASC, edf.id ASC
        LIMIT 1
    ) existing ON true
    ORDER BY d.id, df.folder_type, df.id;
$fn$;

COMMIT;
