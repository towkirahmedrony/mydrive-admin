-- Migration: Add encrypted refresh token storage to drive_accounts
-- The existing drive_accounts table has a refresh_token_secret_id column that
-- references a secret store, but no dedicated secrets table exists in the schema.
-- This migration adds a column to store the AES-256-GCM encrypted refresh token
-- directly on the drive_accounts table.
--
-- SECURITY: This column is protected by the existing RLS policy on drive_accounts:
--   ALL: is_admin() only
-- No end-user can read or write this column.
-- The token is encrypted with a server-side ENCRYPTION_KEY (AES-256-GCM),
-- so even if the database is compromised, the plaintext token is not exposed.

ALTER TABLE public.drive_accounts
  ADD COLUMN IF NOT EXISTS refresh_token_encrypted text;

COMMENT ON COLUMN public.drive_accounts.refresh_token_encrypted IS
  'AES-256-GCM encrypted Google OAuth refresh token. '
  'Encrypted with ENCRYPTION_KEY env var. '
  'Never returned to the browser. Protected by drive_accounts RLS (admin only).';
