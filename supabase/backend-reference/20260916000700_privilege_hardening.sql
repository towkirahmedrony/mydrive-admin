-- 20260916000700_privilege_hardening.sql
-- Security hardening found while reviewing the live authorization surface.
--
-- TWO ISSUES, both verified against the live database before this migration:
--
-- 1. SERVER-ONLY RPCS WERE EXECUTABLE BY `anon` AND `authenticated`.
--    Supabase's default privileges grant EXECUTE on every new function in
--    `public` to anon/authenticated/service_role, and the existing migrations
--    only did `REVOKE ALL ... FROM PUBLIC`, which does NOT remove those
--    per-role grants. Verified with has_function_privilege(): all of the
--    worker/admin functions still returned true for anon and authenticated.
--    Worst case, verified live (value never printed, only its length):
--
--      SET LOCAL role authenticated;
--      SELECT length(worker_lookup_drive_refresh_token(<secret_id>, <account_id>));
--      -- => 182  (the plaintext Google refresh token)
--
--    i.e. any signed-in user holding a Vault secret id could read the pooled
--    Google Drive refresh tokens. The same defect exposes
--    worker_lookup_telegram_token (bot tokens). Nothing client-side calls
--    these functions: the Android app talks only to profiles/devices and the
--    Admin Panel performs no RPC calls, so revoking is behaviour-preserving
--    for every client while keeping service_role (Edge Functions) working.
--
-- 2. `profiles` ALLOWED PRIVILEGE SELF-ESCALATION.
--    The policy "Users can update own profile" (USING/WITH CHECK id = auth.uid())
--    let any authenticated user UPDATE their own row, including `role` and
--    `status`; `private.is_admin()` authorizes on exactly those columns, so a
--    normal user could promote themselves to admin and then manage Drive
--    accounts. RLS cannot compare OLD/NEW, so this is closed with a column
--    guard trigger. The policies themselves are left intact (not weakened).
--
-- Every statement is idempotent. No table is dropped, no policy is dropped,
-- no existing data is modified.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Server-only RPCs: service_role only (explicit role revokes)
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
              -- Google Drive credential + routing + folder primitives
              'worker_lookup_drive_refresh_token',
              'admin_store_drive_refresh_token',
              'admin_create_drive_account_with_refresh_token',
              'list_eligible_drive_accounts',
              'select_drive_account',
              'reserve_drive_account',
              'release_drive_quota',
              'mark_drive_account_result',
              'claim_drive_folder',
              'complete_drive_folder',
              'fail_drive_folder',
              -- Drive replication queue
              'claim_drive_job',
              'complete_drive_job',
              'failover_drive_replication_job',
              'assign_drive_replication_job',
              -- OAuth state housekeeping
              'cleanup_expired_oauth_states',
              -- Same defect class: returns Telegram bot tokens / mutates jobs
              'worker_lookup_telegram_token',
              'claim_telegram_job',
              'complete_telegram_job'
          )
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f.sig);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f.sig);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
    END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. profiles — block privilege self-escalation
-- ═══════════════════════════════════════════════════════════════════════════

-- Only `role` and `status` are guarded: they are the authorization inputs of
-- private.is_admin(). Everything else (full_name, email, avatar, ...) stays
-- user-editable, so the Android profile-name update keeps working.
--
-- SECURITY DEFINER is required so the guard can read public.profiles
-- deterministically; the caller identity is therefore taken from
-- current_setting('role') / auth.uid() instead of current_user, which would be
-- the function owner inside a SECURITY DEFINER function.
CREATE OR REPLACE FUNCTION public.guard_profile_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role      text := COALESCE(current_setting('role', true), '');
    v_uid       uuid := auth.uid();
    v_is_admin  boolean;
BEGIN
    -- Backend / maintenance contexts (service_role key, direct SQL as
    -- postgres/supabase_admin) are trusted: they already need full control of
    -- the profiles table and never carry an end-user JWT subject.
    IF v_role IN ('service_role', 'postgres', 'supabase_admin') THEN
        RETURN NEW;
    END IF;
    IF v_uid IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.role IS NOT DISTINCT FROM OLD.role
       AND NEW.status IS NOT DISTINCT FROM OLD.status
    THEN
        RETURN NEW;  -- nothing authorization-relevant changed
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = v_uid
          AND p.role = 'admin'
          AND p.status = 'active'
    )
    INTO v_is_admin;

    IF NOT v_is_admin THEN
        RAISE EXCEPTION
            USING
                ERRCODE = '42501',
                MESSAGE = 'Only administrators may change profiles.role or profiles.status';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_privileged_columns ON public.profiles;

CREATE TRIGGER profiles_guard_privileged_columns
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_profile_privileged_columns();

-- Trigger function: fires only as a trigger, never as a client RPC. Mirrors the
-- existing set_updated_at() convention, so no EXECUTE grants are added.
