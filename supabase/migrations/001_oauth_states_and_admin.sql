-- Migration: OAuth states for the admin Google Drive connection flow.
--
-- Used by:
--   supabase/functions/google-oauth-initiate  (INSERT state)
--   supabase/functions/google-oauth-callback  (atomic DELETE/consume + cleanup)
--
-- Notes:
--   * Idempotent: safe whether or not an earlier generation of this table
--     already exists. Reuses the table if present; never drops existing data.
--   * The live database is the source of truth. Inspect it before applying;
--     do NOT replay this blindly if oauth_states already exists.
--   * Follows the project convention for admin-only tables:
--     RLS enabled with a private.is_admin() policy, and server-only RPC
--     EXECUTE granted to service_role (never to authenticated/anon).

-- Create the oauth_states table for single-use CSRF protection.
CREATE TABLE IF NOT EXISTS public.oauth_states (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  state TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '10 minutes') NOT NULL
);

-- Upgrade path for a pre-existing table (no-ops on a fresh install).
ALTER TABLE public.oauth_states ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now() NOT NULL;
ALTER TABLE public.oauth_states ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '10 minutes') NOT NULL;

-- Admin-only access at the data layer (defense in depth; Edge Functions use
-- the service role and bypass RLS).
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage oauth states" ON public.oauth_states;
DROP POLICY IF EXISTS oauth_states_admin_all ON public.oauth_states;

CREATE POLICY oauth_states_admin_all ON public.oauth_states
  FOR ALL
  USING (private.is_admin())
  WITH CHECK (private.is_admin());

-- Indexes for state lookup and expiry cleanup.
CREATE INDEX IF NOT EXISTS idx_oauth_states_state ON public.oauth_states(state);
CREATE INDEX IF NOT EXISTS idx_oauth_states_user_id ON public.oauth_states(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON public.oauth_states(expires_at);

-- Removes expired (unconsumed) states. Called by google-oauth-callback.
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

-- Backend (service_role) only, mirroring the drive_router_folders migration.
REVOKE ALL ON FUNCTION public.cleanup_expired_oauth_states() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_oauth_states() TO service_role;
