-- Migration: Create OAuth states table and admin function

-- Create the oauth_states table for CSRF protection during OAuth flow
CREATE TABLE IF NOT EXISTS public.oauth_states (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  state TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '10 minutes') NOT NULL
);

-- Add RLS policies for oauth_states (admin only)
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;

-- Only admins can access oauth_states
CREATE POLICY "Admins can manage oauth states" ON public.oauth_states
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

-- Create index for efficient state lookups
CREATE INDEX IF NOT EXISTS idx_oauth_states_state ON public.oauth_states(state);
CREATE INDEX IF NOT EXISTS idx_oauth_states_user_id ON public.oauth_states(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON public.oauth_states(expires_at);

-- Function to clean up expired OAuth states (can be called via pg_cron or Edge Function)
CREATE OR REPLACE FUNCTION public.cleanup_expired_oauth_states()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM public.oauth_states
  WHERE expires_at < now();
END;
$$;

-- Create a scheduled job to clean up expired states every hour (requires pg_cron extension)
-- Uncomment if pg_cron is available:
-- SELECT cron.schedule(
--   'cleanup-oauth-states',
--   '0 * * * *',
--   'SELECT public.cleanup_expired_oauth_states()'
-- );

-- Grant execute permission to authenticated users (they'll call it via Edge Function)
GRANT EXECUTE ON FUNCTION public.cleanup_expired_oauth_states() TO authenticated;

-- Note: The private.is_admin() function is already used in the existing schema
-- as referenced in MYDRIVE_SCHEMA.md. This migration assumes it exists.
-- If it doesn't exist, you'll need to create it:
--
-- CREATE OR REPLACE FUNCTION public.is_admin()
-- RETURNS BOOLEAN
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- AS $$
-- DECLARE
--   user_role TEXT;
-- BEGIN
--   SELECT role INTO user_role
--   FROM public.profiles
--   WHERE id = auth.uid();
--   RETURN user_role = 'admin';
-- END;
-- $$;
