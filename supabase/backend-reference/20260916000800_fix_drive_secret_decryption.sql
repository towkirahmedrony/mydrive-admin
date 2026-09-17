-- 20260916000800_fix_drive_secret_decryption.sql
-- ROOT CAUSE FIX: the Drive refresh-token lookup returned the Vault CIPHERTEXT.
--
-- `vault.decrypted_secrets` exposes two text columns for the same secret:
--
--   secret            -> the stored AEAD ciphertext, base64 with line breaks
--                        (measured live: 182 chars, contains newlines)
--   decrypted_secret  -> the plaintext (measured live: 103 chars, starts `1//`)
--
-- `worker_lookup_drive_refresh_token()` selected `secret`, so every caller
-- received 182 characters of ciphertext instead of the refresh token. Google
-- answers that with HTTP 400 `invalid_grant`, which is exactly what the Admin
-- Panel reported as "Google OAuth token exchange failed: HTTP 400".
--
-- This is why reconnecting never helped: the OAuth callback never reads Vault
-- back (it uses the access token straight from the code exchange, so the panel
-- showed "connected"), while every health check reads the stored credential
-- from Vault through this function and therefore always got ciphertext.
--
-- The credential itself was never invalid, and reconnect did persist correctly
-- (same secret row updated in place, refresh_token_updated_at advanced).
--
-- No data is modified by this migration: it only changes which column is read.

CREATE OR REPLACE FUNCTION public.worker_lookup_drive_refresh_token(
    p_secret_id uuid,
    p_drive_account_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    token text;
BEGIN
    -- 1. Supabase Vault — the PLAINTEXT column.
    BEGIN
        SELECT decrypted_secret
        INTO token
        FROM vault.decrypted_secrets
        WHERE id = p_secret_id
        LIMIT 1;

        IF token IS NOT NULL AND length(trim(token)) > 0 THEN
            RETURN trim(token);
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    -- 2. Compatibility fallback: if `decrypted_secret` is unavailable (older
    --    Vault layouts where `secret` holds the plaintext), accept it ONLY when
    --    it actually looks like a Google refresh token. Ciphertext is
    --    line-wrapped base64 and can never pass both checks, so this can never
    --    silently return ciphertext again.
    BEGIN
        SELECT secret
        INTO token
        FROM vault.decrypted_secrets
        WHERE id = p_secret_id
        LIMIT 1;

        IF token IS NOT NULL
           AND token ~ '^1//'
           AND token !~ '[[:space:]]'
        THEN
            RETURN token;
        END IF;
        token := NULL;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    -- 3. Legacy `secrets` table fallback (non-Vault installations).
    BEGIN
        SELECT value
        INTO token
        FROM secrets
        WHERE id = p_secret_id
        LIMIT 1;

        IF token IS NOT NULL AND length(trim(token)) > 0 THEN
            RETURN trim(token);
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    -- 4. Per-account runtime setting fallback (unchanged behaviour).
    BEGIN
        token := current_setting(
            'app.settings.drive_refresh_token_' || p_drive_account_id::text,
            true
        );

        IF token IS NOT NULL AND length(trim(token)) > 0 THEN
            RETURN trim(token);
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    RETURN NULL;
END;
$$;

-- Keep the backend-only contract enforced after the redefinition.
REVOKE ALL ON FUNCTION public.worker_lookup_drive_refresh_token(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.worker_lookup_drive_refresh_token(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.worker_lookup_drive_refresh_token(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.worker_lookup_drive_refresh_token(uuid, uuid) TO service_role;
