-- Canonical PostgreSQL function synchronization snapshot.
-- Generated from the live MyDrive database and repository migrations on 2026-09-24.
-- This migration is intentionally idempotent and uses CREATE OR REPLACE.
-- It contains functions that were present on only one side of the comparison.
-- Functions present in the live database but absent from repository SQL.
CREATE OR REPLACE FUNCTION public.admin_allow_cleanup_despite_telegram(p_media_id uuid, p_allow boolean DEFAULT true, p_reason text DEFAULT NULL::text)
 RETURNS media_assets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_row public.media_assets%ROWTYPE;
BEGIN
    UPDATE public.media_assets
    SET cleanup_telegram_override = COALESCE(p_allow, true),
        updated_at                = now()
    WHERE id = p_media_id
    RETURNING * INTO v_row;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'admin_allow_cleanup_despite_telegram: media % not found', p_media_id;
    END IF;

    INSERT INTO public.sync_logs (
        media_id, replication_job_id, event_type, status, message, metadata
    )
    VALUES (
        p_media_id,
        NULL,
        'CLOUDINARY_CLEANUP_TELEGRAM_OVERRIDE',
        CASE WHEN COALESCE(p_allow, true) THEN 'allowed' ELSE 'revoked' END,
        left(COALESCE(p_reason, ''), 500),
        jsonb_build_object(
            'media_id', p_media_id,
            'allow', COALESCE(p_allow, true)
        )
    );

    RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_create_drive_account_with_refresh_token(p_google_email text, p_name text, p_refresh_token text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_account_id uuid;
  v_secret_id  uuid;
  v_email      text;
  v_name       text;
BEGIN
  v_email := trim(COALESCE(p_google_email, ''));
  v_name := trim(COALESCE(p_name, ''));

  IF v_email = '' THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '22023',
        MESSAGE = 'Google email must not be empty';
  END IF;

  IF v_name = '' THEN
    v_name := v_email;
  END IF;

  IF p_refresh_token IS NULL OR length(trim(p_refresh_token)) = 0 THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '22023',
        MESSAGE = 'refresh token must not be empty';
  END IF;

  v_account_id := gen_random_uuid();

  v_secret_id := vault.create_secret(
    trim(p_refresh_token),
    'drive_refresh_token_' || v_account_id::text,
    'Google Drive refresh token for ' || v_account_id::text,
    NULL
  );

  IF v_secret_id IS NULL THEN
    RAISE EXCEPTION
      USING
        ERRCODE = 'P0001',
        MESSAGE = 'Vault did not return a secret ID';
  END IF;

  INSERT INTO public.drive_accounts (
    id,
    name,
    google_email,
    refresh_token_secret_id,
    status
  )
  VALUES (
    v_account_id,
    v_name,
    v_email,
    v_secret_id,
    'active'
  );

  RETURN v_account_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_cloudinary_cleanup(p_limit integer DEFAULT 5)
 RETURNS SETOF media_assets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_auto_delete boolean;
    v_max_retry   integer;
    v_retry_base  integer;
    v_lease_secs  integer;
    v_ids         uuid[];
BEGIN
    SELECT s.auto_delete_primary_after_replication,
           s.max_retry,
           s.retry_base_delay_seconds
    INTO v_auto_delete, v_max_retry, v_retry_base
    FROM public.app_settings s
    WHERE s.id = true;

    -- Master switch: no cleanup candidates at all while it is off.
    IF COALESCE(v_auto_delete, false) IS NOT TRUE THEN
        RETURN;
    END IF;

    v_lease_secs := LEAST(
        GREATEST(GREATEST(COALESCE(v_retry_base, 60), 60) * 5, 300),
        3600
    );

    SELECT array_agg(candidate.id)
    INTO v_ids
    FROM (
        SELECT ma.id
        FROM public.media_assets ma
        WHERE (
                ma.primary_cleanup_status IN ('cleanup_pending', 'cleanup_failed')
                -- Stale lease: a previous attempt claimed this row and never
                -- finished (timeout / killed instance).
                OR (
                    ma.primary_cleanup_status = 'cleanup_processing'
                    AND ma.primary_cleanup_started_at IS NOT NULL
                    AND ma.primary_cleanup_started_at
                        < now() - make_interval(secs => v_lease_secs)
                )
              )
          AND ma.primary_cleanup_attempts < GREATEST(COALESCE(v_max_retry, 5), 1)
          AND ma.storage_provider = 'cloudinary'
          AND ma.storage_asset_id IS NOT NULL
          AND ma.status <> 'DELETED'
          -- Never delete the only remaining source: a COMPLETED Drive job that
          -- holds a real Drive file id must already exist.
          AND EXISTS (
              SELECT 1
              FROM public.replication_jobs dj
              WHERE dj.media_id = ma.id
                AND dj.destination_type = 'google_drive'
                AND dj.status = 'COMPLETED'
                AND dj.google_drive_file_id IS NOT NULL
          )
          -- Every other replication that still depends on the Cloudinary source
          -- must have reached a terminal success state, unless an admin
          -- explicitly overrode the block for this media.
          AND (
              COALESCE(ma.cleanup_telegram_override, false)
              OR NOT EXISTS (
                  SELECT 1
                  FROM public.replication_jobs tj
                  WHERE tj.media_id = ma.id
                    AND tj.destination_type = 'telegram'
                    AND tj.status NOT IN ('COMPLETED', 'SKIPPED')
              )
          )
          -- Retry backoff for previously failed cleanups.
          AND (
              ma.primary_cleanup_status = 'cleanup_pending'
              OR ma.primary_cleanup_status = 'cleanup_processing'
              OR ma.updated_at <= now() - make_interval(
                  secs => GREATEST(COALESCE(v_retry_base, 60), 1)
                          * (1 << LEAST(GREATEST(ma.primary_cleanup_attempts - 1, 0), 6))
              )
          )
        ORDER BY ma.updated_at ASC, ma.id ASC
        LIMIT GREATEST(COALESCE(p_limit, 5), 1)
        FOR UPDATE SKIP LOCKED
    ) candidate;

    IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
        RETURN;
    END IF;

    UPDATE public.media_assets
    SET primary_cleanup_status     = 'cleanup_processing',
        primary_cleanup_attempts   = primary_cleanup_attempts + 1,
        primary_cleanup_started_at = now(),
        updated_at                 = now()
    WHERE id = ANY (v_ids);

    RETURN QUERY
    SELECT ma.*
    FROM public.media_assets ma
    WHERE ma.id = ANY (v_ids);
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_cloudinary_cleanup(p_media_id uuid, p_status text, p_error text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF p_status = 'cleanup_success' THEN
        UPDATE public.media_assets
        SET primary_cleanup_status       = 'cleanup_success',
            primary_cleanup_error        = NULL,
            primary_cleanup_completed_at = COALESCE(primary_cleanup_completed_at, now()),
            primary_deleted_at           = COALESCE(primary_deleted_at, now()),
            updated_at                   = now()
        WHERE id = p_media_id;

    ELSIF p_status = 'cleanup_failed' THEN
        UPDATE public.media_assets
        SET primary_cleanup_status = 'cleanup_failed',
            primary_cleanup_error  = left(COALESCE(p_error, 'unknown cleanup error'), 2000),
            updated_at             = now()
        WHERE id = p_media_id;

    ELSIF p_status = 'cleanup_pending' THEN
        -- Explicit requeue (e.g. a downstream dependency is not finished yet).
        UPDATE public.media_assets
        SET primary_cleanup_status = 'cleanup_pending',
            updated_at             = now()
        WHERE id = p_media_id
          AND primary_cleanup_status <> 'cleanup_success';

    ELSE
        RAISE EXCEPTION 'complete_cloudinary_cleanup: invalid status %', p_status;
    END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    INSERT INTO public.profiles (
        id,
        email,
        full_name
    )
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(
            NEW.raw_user_meta_data ->> 'full_name',
            NEW.raw_user_meta_data ->> 'name'
        )
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_profile_storage_used()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  owner_to_update uuid;
begin
  if TG_OP = 'DELETE' then
    owner_to_update := OLD.owner_id;
  else
    owner_to_update := NEW.owner_id;
  end if;

  update public.profiles
  set storage_used_bytes = coalesce((
    select sum(file_size) from public.media_assets
    where owner_id = owner_to_update and status = 'READY' and deleted_at is null
  ), 0)
  where id = owner_to_update;

  if TG_OP = 'UPDATE' and OLD.owner_id is distinct from NEW.owner_id then
    update public.profiles
    set storage_used_bytes = coalesce((
      select sum(file_size) from public.media_assets
      where owner_id = OLD.owner_id and status = 'READY' and deleted_at is null
    ), 0)
    where id = OLD.owner_id;
  end if;

  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_drive_worker()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net', 'vault', 'pg_temp'
AS $function$
DECLARE
    v_key text;
    v_url text := 'https://gpiuxcdjmrzcouhjapcs.supabase.co/functions/v1/drive-replicate?public_url=true';
    v_request_id bigint;
BEGIN
    SELECT ds.decrypted_secret
    INTO v_key
    FROM vault.decrypted_secrets ds
    WHERE ds.name = 'drive_worker_anon_key'
    LIMIT 1;

    -- Fail soft: a missing key must not break the schedule, and must never be
    -- worked around by embedding a credential here.
    IF v_key IS NULL OR length(v_key) = 0 THEN
        RAISE WARNING 'trigger_drive_worker: vault secret drive_worker_anon_key is missing; skipping tick';
        RETURN NULL;
    END IF;

    SELECT net.http_post(
        url := v_url,
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || v_key
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 55000
    )
    INTO v_request_id;

    RETURN v_request_id;
EXCEPTION
    WHEN OTHERS THEN
        -- Never let a scheduling fault surface as an unhandled cron error loop.
        RAISE WARNING 'trigger_drive_worker failed: %', SQLERRM;
        RETURN NULL;
END;
$function$;

-- Functions present in repository SQL but absent from the live database.
CREATE OR REPLACE FUNCTION public.cleanup_expired_oauth_states()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.oauth_states
  WHERE expires_at < now();
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_media_assets_user_hidden_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Trusted server-side contexts: the table owner (postgres /
    -- supabase_admin / platform owner) and service_role. SECURITY DEFINER
    -- functions such as set_media_library_visibility() run as the function
    -- owner, so they pass this check and are allowed through.
    IF current_user IN ('service_role', 'postgres', 'supabase_admin')
       OR pg_has_role(current_user, 'pg_database_owner', 'member') THEN
        RETURN NEW;
    END IF;

    -- Normal authenticated users must never write user_hidden_at directly.
    IF NEW.user_hidden_at IS DISTINCT FROM OLD.user_hidden_at THEN
        RAISE EXCEPTION
            'Direct modification of media_assets.user_hidden_at is not permitted; use set_media_library_visibility()'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_media_drive_jobs(
    p_media_id uuid
)
RETURNS SETOF public.replication_jobs
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT rj.*
    FROM public.replication_jobs rj
    WHERE rj.media_id = p_media_id
      AND rj.destination_type = 'google_drive'
    ORDER BY rj.created_at ASC;
$$;

-- Preserve server-only execution for maintenance/trigger helpers.
REVOKE ALL ON FUNCTION public.cleanup_expired_oauth_states() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_oauth_states() TO service_role;
REVOKE ALL ON FUNCTION public.guard_media_assets_user_hidden_at() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_media_assets_guard_user_hidden_at ON public.media_assets;
CREATE TRIGGER trg_media_assets_guard_user_hidden_at
    BEFORE UPDATE OF user_hidden_at ON public.media_assets
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_media_assets_user_hidden_at();
