-- 20260916000500_drive_router_folders.sql
-- Server-side foundation for the Google Drive replication pipeline.
--
-- This migration adds the reusable primitives the future Drive worker will
-- compose; it does NOT upload media and does NOT claim/complete media jobs.
--
--   1. Drive Router  — eligible-account listing, deterministic selection and
--      atomic quota reservation across ANY number of enabled accounts.
--   2. Folder resolver — idempotent, concurrency-safe per-user folder claims
--      backed by the drive_folders mapping.
--   3. Secret access — server-only retrieval/storage of Drive OAuth refresh
--      tokens (Supabase Vault). Tokens are never stored in plaintext tables.
--
-- All SECURITY DEFINER functions run with owner privileges so the service
-- role (used by Edge Functions) can operate on admin-only tables. EXECUTE is
-- revoked from PUBLIC and granted to service_role only, so authenticated /
-- anon Android clients can never call them.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Drive Router
-- ═══════════════════════════════════════════════════════════════════════════

-- 1a. list_eligible_drive_accounts()
--     Returns every account that can accept `p_required_bytes` right now,
--     ordered by the routing preference: lowest priority number first, then
--     most free space, then least-recently quota-checked, then oldest created.
--     Empty `p_exclude_account_ids` keeps already-tried accounts out of a
--     failover retry.
CREATE OR REPLACE FUNCTION public.list_eligible_drive_accounts(
    p_required_bytes      bigint DEFAULT 0,
    p_exclude_account_ids uuid[] DEFAULT '{}',
    p_safety_margin_bytes bigint DEFAULT NULL
)
RETURNS SETOF public.drive_accounts
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
      AND NOT (da.id = ANY (COALESCE(p_exclude_account_ids, '{}'::uuid[])))
      AND av.effective_available IS NOT NULL
      AND av.effective_available - v_req - COALESCE(da.reserved_bytes, 0) >= v_margin
    ORDER BY da.priority ASC,
             (av.effective_available - v_req) DESC,
             da.last_quota_check_at ASC NULLS FIRST,
             da.created_at ASC;
END;
$$;

-- 1b. select_drive_account()
--     Single best eligible account, or NULL when none can accept the file.
--     Read-only: use this for planning/diagnostics. Use reserve_* for work.
CREATE OR REPLACE FUNCTION public.select_drive_account(
    p_required_bytes      bigint DEFAULT 0,
    p_exclude_account_ids uuid[] DEFAULT '{}',
    p_safety_margin_bytes bigint DEFAULT NULL
)
RETURNS public.drive_accounts
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT candidate
    FROM public.list_eligible_drive_accounts(
             p_required_bytes, p_exclude_account_ids, p_safety_margin_bytes
         ) AS candidate
    LIMIT 1;
$$;

-- 1c. reserve_drive_account()
--     Selects the best eligible account AND atomically decrements its
--     available quota in the same transaction. FOR UPDATE SKIP LOCKED makes
--     concurrent routers unable to over-allocate the same account. Returns the
--     reserved account, or NULL when every enabled account is full /
--     unavailable / excluded.
CREATE OR REPLACE FUNCTION public.reserve_drive_account(
    p_required_bytes      bigint DEFAULT 0,
    p_exclude_account_ids uuid[] DEFAULT '{}',
    p_safety_margin_bytes bigint DEFAULT NULL
)
RETURNS public.drive_accounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_acct   public.drive_accounts%ROWTYPE;
    v_margin bigint;
    v_req    bigint := GREATEST(COALESCE(p_required_bytes, 0), 0);
BEGIN
    SELECT COALESCE(
               p_safety_margin_bytes,
               (SELECT drive_safety_margin_bytes FROM public.app_settings WHERE id = true),
               1073741824
           )
    INTO v_margin;

    SELECT da.*
    INTO v_acct
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
      AND NOT (da.id = ANY (COALESCE(p_exclude_account_ids, '{}'::uuid[])))
      AND av.effective_available IS NOT NULL
      AND av.effective_available - v_req - COALESCE(da.reserved_bytes, 0) >= v_margin
    ORDER BY da.priority ASC,
             (av.effective_available - v_req) DESC,
             da.last_quota_check_at ASC NULLS FIRST,
             da.created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    UPDATE public.drive_accounts da
    SET storage_available_bytes = COALESCE(
            da.storage_available_bytes,
            CASE WHEN da.storage_limit_bytes IS NOT NULL
                 THEN GREATEST(da.storage_limit_bytes - COALESCE(da.storage_used_bytes, 0), 0)
                 ELSE NULL END
        ) - v_req,
        storage_used_bytes = COALESCE(da.storage_used_bytes, 0) + v_req,
        updated_at = now()
    WHERE da.id = v_acct.id
    RETURNING * INTO v_acct;

    RETURN v_acct;
END;
$$;

-- 1d. release_drive_quota()
--     Reverses a reservation when the worker gives up on an account (failover
--     to another account) or before/without uploading.
CREATE OR REPLACE FUNCTION public.release_drive_quota(
    p_drive_account_id uuid,
    p_bytes            bigint
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    UPDATE public.drive_accounts
    SET storage_available_bytes = COALESCE(storage_available_bytes, 0)
                                   + GREATEST(COALESCE(p_bytes, 0), 0),
        storage_used_bytes      = GREATEST(
                                      COALESCE(storage_used_bytes, 0)
                                      - GREATEST(COALESCE(p_bytes, 0), 0),
                                      0
                                  ),
        updated_at              = now()
    WHERE id = p_drive_account_id;
$$;

-- 1e. mark_drive_account_result()
--     Health/status feedback for a routed account. Called by the worker when
--     an upload succeeds or fails, so the router stops choosing broken or
--     full accounts until the next quota/health check.
CREATE OR REPLACE FUNCTION public.mark_drive_account_result(
    p_drive_account_id uuid,
    p_health_status    text DEFAULT NULL,
    p_status           text DEFAULT NULL,
    p_last_error       text DEFAULT NULL
)
RETURNS public.drive_accounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.drive_accounts%ROWTYPE;
BEGIN
    UPDATE public.drive_accounts
    SET health_status       = COALESCE(p_health_status, health_status),
        status              = COALESCE(p_status, status),
        last_error          = p_last_error,
        last_error_at       = CASE WHEN p_last_error IS NOT NULL THEN now() ELSE last_error_at END,
        last_health_check_at = now(),
        updated_at          = now()
    WHERE id = p_drive_account_id
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Idempotent per-user folder resolution
-- ═══════════════════════════════════════════════════════════════════════════

-- 2a. claim_drive_folder()
--     Finds an existing folder mapping or creates a 'pending' row, then
--     leases the right to create that folder in Google Drive.
--
--     Returns (folder, acquired):
--       * acquired = true  -> this caller holds the lease and MUST create the
--                             folder in Drive, then call complete_drive_folder
--                             (or fail_drive_folder).
--       * acquired = false -> another process is creating it (or it already
--                             exists); caller should read google_folder_id.
--
--     A transaction-scoped advisory lock serialises callers for the same
--     (account, owner, folder_type), so concurrent jobs can never create two
--     Drive folders for the same mapping. The unique indexes on
--     drive_folders are the final safety net.
CREATE OR REPLACE FUNCTION public.claim_drive_folder(
    p_drive_account_id  uuid,
    p_owner_id          uuid,
    p_folder_name       text,
    p_folder_type       text DEFAULT 'user',
    p_parent_folder_id  uuid DEFAULT NULL
)
RETURNS TABLE (folder public.drive_folders, acquired boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row      public.drive_folders%ROWTYPE;
    v_acquired boolean := false;
    v_key      bigint;
BEGIN
    v_key := hashtextextended(
        COALESCE(p_drive_account_id::text, '') || ':' ||
        COALESCE(p_owner_id::text, 'root') || ':' ||
        COALESCE(p_folder_type, 'user'),
        0
    );
    PERFORM pg_advisory_xact_lock(v_key);

    SELECT df.*
    INTO v_row
    FROM public.drive_folders df
    WHERE df.drive_account_id = p_drive_account_id
      AND df.folder_type = p_folder_type
      AND (df.owner_id = p_owner_id OR (df.owner_id IS NULL AND p_owner_id IS NULL))
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO public.drive_folders (
            drive_account_id, owner_id, folder_name, folder_type,
            parent_folder_id, folder_status, created_at, updated_at
        )
        VALUES (
            p_drive_account_id, p_owner_id, p_folder_name, p_folder_type,
            p_parent_folder_id, 'pending', now(), now()
        )
        RETURNING * INTO v_row;
    END IF;

    -- Only one caller at a time may hold the creation lease. An 'error' row
    -- (or an expired lease) is re-claimable so transient Drive failures retry.
    IF v_row.id IS NOT NULL
       AND v_row.google_folder_id IS NULL
       AND (
           v_row.folder_status = 'error'
           OR v_row.create_lease_until IS NULL
           OR v_row.create_lease_until < now()
       )
    THEN
        UPDATE public.drive_folders df
        SET folder_status      = 'pending',
            create_lease_until = now() + interval '2 minutes',
            create_attempts    = df.create_attempts + 1,
            last_error         = NULL,
            updated_at         = now()
        WHERE df.id = v_row.id
        RETURNING * INTO v_row;

        v_acquired := true;
    END IF;

    RETURN QUERY SELECT v_row, v_acquired;
END;
$$;

-- 2b. complete_drive_folder()
--     Persists the Google folder id produced by the folder-creation call and
--     marks the mapping active. Idempotent: re-running with the same id is a
--     no-op on the value.
CREATE OR REPLACE FUNCTION public.complete_drive_folder(
    p_folder_row_id     uuid,
    p_google_folder_id  text
)
RETURNS public.drive_folders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.drive_folders%ROWTYPE;
BEGIN
    UPDATE public.drive_folders
    SET google_folder_id   = p_google_folder_id,
        folder_status      = 'active',
        create_lease_until = NULL,
        last_error         = NULL,
        updated_at         = now()
    WHERE id = p_folder_row_id
      AND p_google_folder_id IS NOT NULL
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

-- 2c. fail_drive_folder()
--     Releases the lease and records the error. The mapping can be re-claimed
--     by a later attempt (folder_status = 'error').
CREATE OR REPLACE FUNCTION public.fail_drive_folder(
    p_folder_row_id uuid,
    p_error         text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    UPDATE public.drive_folders
    SET folder_status      = 'error',
        create_lease_until = NULL,
        last_error         = p_error,
        updated_at         = now()
    WHERE id = p_folder_row_id;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Server-side refresh-token access (Supabase Vault)
-- ═══════════════════════════════════════════════════════════════════════════

-- 3a. worker_lookup_drive_refresh_token()
--     Mirror of worker_lookup_telegram_token(): resolve the secret reference
--     to plaintext server-side. The caller MUST NOT log the returned value.
CREATE OR REPLACE FUNCTION public.worker_lookup_drive_refresh_token(
    p_secret_id         uuid,
    p_drive_account_id  uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    token text;
BEGIN
    -- 1. Supabase vault
    BEGIN
        SELECT secret INTO token
        FROM vault.decrypted_secrets
        WHERE id = p_secret_id
        LIMIT 1;

        IF token IS NOT NULL AND length(token) > 0 THEN
            RETURN token;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    -- 2. Fallback: secrets table (some Supabase installs use this schema)
    BEGIN
        SELECT value INTO token
        FROM secrets
        WHERE id = p_secret_id
        LIMIT 1;

        IF token IS NOT NULL AND length(token) > 0 THEN
            RETURN token;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    -- 3. Fallback: env-var secret keyed by the account id
    BEGIN
        token := current_setting('app.settings.drive_refresh_token_' || p_drive_account_id::text, true);

        IF token IS NOT NULL AND length(token) > 0 THEN
            RETURN token;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    RETURN NULL;
END;
$$;

-- 3b. admin_store_drive_refresh_token()
--     Writes a refresh token into Supabase Vault and stores only the secret
--     reference on the account row. Raises (rather than falling back to
--     plaintext) when Vault is unavailable, so a token can never leak into
--     drive_accounts.
CREATE OR REPLACE FUNCTION public.admin_store_drive_refresh_token(
    p_drive_account_id uuid,
    p_refresh_token    text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_secret_id uuid;
    v_existing  uuid;
    v_name      text := 'drive_refresh_token_' || p_drive_account_id::text;
BEGIN
    IF p_refresh_token IS NULL OR length(trim(p_refresh_token)) = 0 THEN
        RAISE EXCEPTION 'refresh token must not be empty';
    END IF;

    SELECT refresh_token_secret_id
    INTO v_existing
    FROM public.drive_accounts
    WHERE id = p_drive_account_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'drive account % not found', p_drive_account_id;
    END IF;

    IF v_existing IS NULL THEN
        BEGIN
            v_secret_id := vault.create_secret(
                p_refresh_token,
                v_name,
                'Google Drive refresh token for ' || p_drive_account_id::text
            );
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'Supabase Vault unavailable; refusing to store Drive refresh token in plaintext';
        END;
    ELSE
        BEGIN
            PERFORM vault.update_secret(
                v_existing,
                p_refresh_token,
                v_name,
                'Google Drive refresh token for ' || p_drive_account_id::text
            );
            v_secret_id := v_existing;
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'Supabase Vault unavailable; refusing to store Drive refresh token in plaintext';
        END;
    END IF;

    UPDATE public.drive_accounts
    SET refresh_token_secret_id  = v_secret_id,
        refresh_token_updated_at = now(),
        connection_status        = 'connected',
        status                   = CASE WHEN status = 'reauth_required' THEN 'active' ELSE status END,
        last_error               = NULL,
        updated_at               = now()
    WHERE id = p_drive_account_id;

    RETURN v_secret_id;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Lock down EXECUTE: backend (service_role) only
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
    f record;
BEGIN
    FOR f IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN (
              'list_eligible_drive_accounts',
              'select_drive_account',
              'reserve_drive_account',
              'release_drive_quota',
              'mark_drive_account_result',
              'claim_drive_folder',
              'complete_drive_folder',
              'fail_drive_folder',
              'worker_lookup_drive_refresh_token',
              'admin_store_drive_refresh_token'
          )
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
    END LOOP;
END $$;
