-- 20260916000400_drive_accounts_folders.sql
-- Foundation for a multi-account Google Drive archive.
--
-- Expands the existing `drive_accounts` / `drive_folders` tables documented in
-- MYDRIVE_SCHEMA.md so that an ARBITRARY number of authorized Google Drive
-- accounts can be managed server-side. Nothing here uploads media to Drive;
-- this migration only hardens the account pool and the per-user folder
-- mapping that the future Drive replication worker will consume.
--
-- Design notes:
--   * Google Drive is an ADMIN/OFFICE archive destination only. Neither table
--     is readable or writable from Android clients (admin-only RLS).
--   * Refresh tokens are NEVER stored in these tables. Only a reference to a
--     server-side secret (`refresh_token_secret_id` -> Supabase Vault) is
--     kept, mirroring the existing `telegram_configs.bot_token_secret_id`
--     convention.
--   * Every statement is idempotent: `CREATE TABLE IF NOT EXISTS`,
--     `ADD COLUMN IF NOT EXISTS`, guarded constraints/indexes and guarded
--     policies. The live project already has an earlier generation of both
--     tables, so this migration upgrades them in place instead of replacing
--     them (no duplicate tables, no data loss).
--
-- No hardcoded account cap: routing is driven entirely by table rows.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. drive_accounts — pool of authorized Google Drive accounts (unbounded)
-- ═══════════════════════════════════════════════════════════════════════════

-- 1a. Fresh-install definition. No-op when the table already exists.
CREATE TABLE IF NOT EXISTS public.drive_accounts (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                     text NOT NULL DEFAULT 'Google Drive',
    display_name             text,
    google_email             text UNIQUE,
    -- Reference to a server-side secret (Supabase Vault). The token itself
    -- must never be written to this table.
    refresh_token_secret_id  uuid,
    refresh_token_updated_at timestamptz,
    token_expires_at         timestamptz,
    -- Google Drive folder id that acts as the archive root on this account.
    root_folder_id           text,
    priority                 integer NOT NULL DEFAULT 100,
    enabled                  boolean NOT NULL DEFAULT true,
    status                   text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'quota_full', 'reauth_required', 'disabled', 'error')),
    connection_status        text NOT NULL DEFAULT 'unknown'
                             CHECK (connection_status IN ('connected', 'disconnected', 'reauth_required', 'error', 'unknown')),
    health_status            text NOT NULL DEFAULT 'unknown'
                             CHECK (health_status IN ('healthy', 'degraded', 'unhealthy', 'unknown')),
    storage_limit_bytes      bigint CHECK (storage_limit_bytes IS NULL OR storage_limit_bytes >= 0),
    storage_used_bytes       bigint CHECK (storage_used_bytes IS NULL OR storage_used_bytes >= 0),
    storage_available_bytes  bigint CHECK (storage_available_bytes IS NULL OR storage_available_bytes >= 0),
    -- Per-account bytes held back from the global safety margin.
    reserved_bytes           bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
    last_quota_check_at      timestamptz,
    last_health_check_at     timestamptz,
    last_error               text,
    last_error_at            timestamptz,
    notes                    text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

-- 1b. Upgrade path for the pre-existing table (no-ops on a fresh install).
ALTER TABLE public.drive_accounts ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE public.drive_accounts ADD COLUMN IF NOT EXISTS refresh_token_updated_at timestamptz;
ALTER TABLE public.drive_accounts ADD COLUMN IF NOT EXISTS token_expires_at timestamptz;
ALTER TABLE public.drive_accounts ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.drive_accounts ADD COLUMN IF NOT EXISTS connection_status text NOT NULL DEFAULT 'unknown';
ALTER TABLE public.drive_accounts ADD COLUMN IF NOT EXISTS health_status text NOT NULL DEFAULT 'unknown';
ALTER TABLE public.drive_accounts ADD COLUMN IF NOT EXISTS reserved_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE public.drive_accounts ADD COLUMN IF NOT EXISTS last_health_check_at timestamptz;
ALTER TABLE public.drive_accounts ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE public.drive_accounts ADD COLUMN IF NOT EXISTS last_error_at timestamptz;
ALTER TABLE public.drive_accounts ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.drive_accounts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- 1c. Constraints for the upgrade path (fresh install already has them inline).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'drive_accounts_connection_status_check'
    ) THEN
        ALTER TABLE public.drive_accounts
            ADD CONSTRAINT drive_accounts_connection_status_check
            CHECK (connection_status IN ('connected', 'disconnected', 'reauth_required', 'error', 'unknown'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'drive_accounts_health_status_check'
    ) THEN
        ALTER TABLE public.drive_accounts
            ADD CONSTRAINT drive_accounts_health_status_check
            CHECK (health_status IN ('healthy', 'degraded', 'unhealthy', 'unknown'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'drive_accounts_reserved_bytes_check'
    ) THEN
        ALTER TABLE public.drive_accounts
            ADD CONSTRAINT drive_accounts_reserved_bytes_check
            CHECK (reserved_bytes >= 0);
    END IF;
END $$;

-- 1d. Routing / admin indexes. The router orders by priority over enabled,
--     active accounts, so cover that predicate.
CREATE INDEX IF NOT EXISTS drive_accounts_routing_idx
    ON public.drive_accounts (enabled, status, priority, storage_available_bytes);

CREATE INDEX IF NOT EXISTS drive_accounts_priority_idx
    ON public.drive_accounts (priority);

CREATE INDEX IF NOT EXISTS drive_accounts_connection_health_idx
    ON public.drive_accounts (connection_status, health_status)
    WHERE enabled = true;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. drive_folders — authoritative per-user Drive folder mapping
-- ═══════════════════════════════════════════════════════════════════════════

-- 2a. Fresh-install definition. No-op when the table already exists.
CREATE TABLE IF NOT EXISTS public.drive_folders (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    drive_account_id   uuid NOT NULL REFERENCES public.drive_accounts(id) ON DELETE CASCADE,
    parent_folder_id   uuid REFERENCES public.drive_folders(id) ON DELETE SET NULL,
    owner_id           uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    folder_name        text NOT NULL,
    -- Google Drive folder id. NULL until the folder has actually been created.
    google_folder_id   text,
    folder_type        text NOT NULL DEFAULT 'media'
                       CHECK (folder_type IN ('root', 'media', 'user', 'year', 'month', 'custom')),
    -- Lifecycle of the external mapping. 'pending' = claimed, not yet created.
    folder_status      text NOT NULL DEFAULT 'active'
                       CHECK (folder_status IN ('pending', 'active', 'error')),
    -- Short lease held by the server process currently creating the folder.
    create_lease_until timestamptz,
    create_attempts    integer NOT NULL DEFAULT 0 CHECK (create_attempts >= 0),
    last_error         text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

-- 2b. Upgrade path for the pre-existing table (no-ops on a fresh install).
ALTER TABLE public.drive_folders ADD COLUMN IF NOT EXISTS folder_status text NOT NULL DEFAULT 'active';
ALTER TABLE public.drive_folders ADD COLUMN IF NOT EXISTS create_lease_until timestamptz;
ALTER TABLE public.drive_folders ADD COLUMN IF NOT EXISTS create_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE public.drive_folders ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE public.drive_folders ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- google_folder_id was previously NOT NULL; a folder row must be persisted
-- before its Google id exists so folder creation can be made idempotent.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'drive_folders'
          AND column_name = 'google_folder_id'
          AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE public.drive_folders ALTER COLUMN google_folder_id DROP NOT NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'drive_folders_folder_status_check'
    ) THEN
        ALTER TABLE public.drive_folders
            ADD CONSTRAINT drive_folders_folder_status_check
            CHECK (folder_status IN ('pending', 'active', 'error'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'drive_folders_create_attempts_check'
    ) THEN
        ALTER TABLE public.drive_folders
            ADD CONSTRAINT drive_folders_create_attempts_check
            CHECK (create_attempts >= 0);
    END IF;
END $$;

-- 2c. Idempotency keys. `drive_folder_id` is only the external mapping; the
--     application's user_id/media_id stay authoritative.
--
--     * exactly one USER folder per (drive_account_id, owner_id)
--     * exactly one ROOT/archive folder per drive account
--     The indexes are scoped by folder_type so unrelated folder kinds (e.g.
--     per-media 'media' folders) are never constrained.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.drive_folders
        WHERE owner_id IS NOT NULL AND folder_type = 'user'
        GROUP BY drive_account_id, owner_id
        HAVING count(*) > 1
    ) THEN
        RAISE NOTICE 'drive_folders has duplicate (drive_account_id, owner_id) user folders; skipping unique index drive_folders_user_mapping_key. Resolve duplicates and re-run to enforce.';
    ELSE
        CREATE UNIQUE INDEX IF NOT EXISTS drive_folders_user_mapping_key
            ON public.drive_folders (drive_account_id, owner_id)
            WHERE owner_id IS NOT NULL AND folder_type = 'user';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.drive_folders
        WHERE folder_type = 'root'
        GROUP BY drive_account_id
        HAVING count(*) > 1
    ) THEN
        RAISE NOTICE 'drive_folders has duplicate root folders; skipping unique index drive_folders_root_key. Resolve duplicates and re-run to enforce.';
    ELSE
        CREATE UNIQUE INDEX IF NOT EXISTS drive_folders_root_key
            ON public.drive_folders (drive_account_id)
            WHERE owner_id IS NULL AND folder_type = 'root';
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS drive_folders_account_owner_idx
    ON public.drive_folders (drive_account_id, owner_id);

CREATE INDEX IF NOT EXISTS drive_folders_owner_idx
    ON public.drive_folders (owner_id);

CREATE INDEX IF NOT EXISTS drive_folders_pending_idx
    ON public.drive_folders (folder_status)
    WHERE folder_status <> 'active';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Row Level Security — admin/backend only, never Android
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.drive_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drive_folders ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'drive_accounts'
          AND policyname = 'drive_accounts_admin_all'
    ) THEN
        CREATE POLICY drive_accounts_admin_all ON public.drive_accounts
            FOR ALL
            USING (private.is_admin())
            WITH CHECK (private.is_admin());
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'drive_folders'
          AND policyname = 'drive_folders_admin_all'
    ) THEN
        CREATE POLICY drive_folders_admin_all ON public.drive_folders
            FOR ALL
            USING (private.is_admin())
            WITH CHECK (private.is_admin());
    END IF;
END $$;
