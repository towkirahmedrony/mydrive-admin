-- ============================================================================
-- Drive Account Migration Foundation
-- ============================================================================
-- Additive foundation for safe Google Drive account retirement + media
-- migration.  This migration does NOT copy, move, delete or touch any Drive
-- object, does not modify any existing row, does not disable any account and
-- does not move any media.
--
-- Design notes (see archive-integrity-baseline-results.md for the audit that
-- preceded this):
--
--  * `replication_jobs` is deliberately NOT reused.  It carries
--    UNIQUE (media_id, destination_type) and FK drive_account_id ON DELETE
--    SET NULL, so it cannot represent a source copy and a destination copy of
--    the same media at once, and it would silently orphan the only pointer to
--    a file if an account row were removed.  Migration therefore gets its own
--    provenance-preserving model.
--
--  * Every migration reference to a Drive account / folder is ON DELETE
--    RESTRICT.  Combined with the pre-existing
--    drive_folders.drive_account_id ON DELETE CASCADE, this means deleting an
--    account that a migration still depends on fails loudly instead of
--    destroying the record of where a file came from.
--
--  * `media_id` is ON DELETE CASCADE on purpose: it matches the existing
--    replication_jobs behaviour, so media deletion keeps working exactly as it
--    does today (compatibility requirement).  Migration items are transient
--    work records; the durable audit trail lives in sync_logs.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. drive_account_migrations — one row per account-level migration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.drive_account_migrations (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_drive_account_id   uuid NOT NULL
                              REFERENCES public.drive_accounts(id) ON DELETE RESTRICT,
    status                    text NOT NULL DEFAULT 'PLANNED',
    requested_by              uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    requested_at              timestamptz NOT NULL DEFAULT now(),
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),
    started_at                timestamptz,
    completed_at              timestamptz,
    cancelled_at              timestamptz,
    total_media_count         integer NOT NULL DEFAULT 0 CHECK (total_media_count >= 0),
    completed_count           integer NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
    failed_count              integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    total_expected_bytes      bigint  NOT NULL DEFAULT 0 CHECK (total_expected_bytes >= 0),
    migrated_bytes            bigint  NOT NULL DEFAULT 0 CHECK (migrated_bytes >= 0),
    reserved_bytes            bigint  NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
    destination_account_ids   uuid[]  NOT NULL DEFAULT '{}',
    lease_owner               text,
    lease_expires_at          timestamptz,
    last_error                text,
    last_error_at             timestamptz,
    notes                     text,
    CONSTRAINT drive_account_migrations_status_check CHECK (
        status IN ('PLANNED','RUNNING','PAUSED','COMPLETED','FAILED','CANCELLED','BLOCKED')
    ),
    -- counters may never exceed the population they describe
    CONSTRAINT drive_account_migrations_counters_check CHECK (
        completed_count + failed_count <= total_media_count
    )
);

COMMENT ON TABLE public.drive_account_migrations IS
    'Account-level Google Drive retirement migration. One row per migration. '
    'Does not replace replication_jobs (which cannot represent source+destination '
    'copies of the same media because of UNIQUE (media_id, destination_type)).';
COMMENT ON COLUMN public.drive_account_migrations.reserved_bytes IS
    'Logical capacity reserved for this migration. Distinct from '
    'drive_accounts.reserved_bytes; nothing here consumes real Drive quota.';

-- At most ONE non-terminal migration per source account.  This is what makes
-- "duplicate migration cannot create conflicting source retirement state"
-- enforceable in the database rather than in application code.
CREATE UNIQUE INDEX IF NOT EXISTS drive_account_migrations_one_active_per_source
    ON public.drive_account_migrations (source_drive_account_id)
    WHERE status IN ('PLANNED','RUNNING','PAUSED','BLOCKED');

CREATE INDEX IF NOT EXISTS drive_account_migrations_source_idx
    ON public.drive_account_migrations (source_drive_account_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. drive_account_migration_items — one row per media being migrated
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.drive_account_migration_items (
    id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    migration_id                    uuid NOT NULL
                                    REFERENCES public.drive_account_migrations(id) ON DELETE CASCADE,

    -- provenance: source side, retained independently of anything else
    media_id                        uuid NOT NULL
                                    REFERENCES public.media_assets(id) ON DELETE CASCADE,
    source_drive_account_id         uuid NOT NULL
                                    REFERENCES public.drive_accounts(id) ON DELETE RESTRICT,
    source_drive_folder_id          uuid
                                    REFERENCES public.drive_folders(id) ON DELETE RESTRICT,
    source_google_drive_file_id     text NOT NULL,
    source_file_name                text NOT NULL,
    source_size_bytes               bigint NOT NULL CHECK (source_size_bytes >= 0),
    source_md5                      text,

    -- provenance: destination side, filled in by the (future) worker
    destination_drive_account_id    uuid
                                    REFERENCES public.drive_accounts(id) ON DELETE RESTRICT,
    destination_drive_folder_id     uuid
                                    REFERENCES public.drive_folders(id) ON DELETE RESTRICT,
    destination_google_drive_file_id text,
    destination_file_name           text,
    destination_size_bytes          bigint CHECK (destination_size_bytes IS NULL OR destination_size_bytes >= 0),
    destination_md5                 text,

    verification_state              text NOT NULL DEFAULT 'PENDING',
    source_deletion_state           text NOT NULL DEFAULT 'NOT_ELIGIBLE',
    attempt_count                   integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    lease_owner                     text,
    lease_expires_at                timestamptz,
    last_error                      text,
    last_error_at                   timestamptz,
    copied_at                       timestamptz,
    verified_at                     timestamptz,
    source_delete_authorised_at     timestamptz,
    source_deleted_at               timestamptz,
    created_at                      timestamptz NOT NULL DEFAULT now(),
    updated_at                      timestamptz NOT NULL DEFAULT now(),

    -- retry must never create a second item for the same media
    CONSTRAINT drive_account_migration_items_unique_media UNIQUE (migration_id, media_id),

    CONSTRAINT drive_account_migration_items_verification_state_check CHECK (
        verification_state IN ('PENDING','COPYING','COPIED','VERIFIED','FAILED','BLOCKED')
    ),

    CONSTRAINT drive_account_migration_items_source_deletion_state_check CHECK (
        source_deletion_state IN ('NOT_ELIGIBLE','SOURCE_DELETE_PENDING','SOURCE_DELETED','FAILED')
    ),

    -- a destination may never be the source account
    CONSTRAINT drive_account_migration_items_distinct_accounts CHECK (
        destination_drive_account_id IS NULL
        OR destination_drive_account_id <> source_drive_account_id
    ),

    -- THE SOURCE DELETION GATE (database-enforced):
    -- a source may only become deletable once the destination is VERIFIED.
    CONSTRAINT drive_account_migration_items_delete_gate CHECK (
        source_deletion_state IN ('NOT_ELIGIBLE','FAILED')
        OR verification_state = 'VERIFIED'
    ),

    -- destination provenance must be complete together, never half-filled
    CONSTRAINT drive_account_migration_items_destination_complete CHECK (
        destination_google_drive_file_id IS NULL
        OR (destination_drive_account_id IS NOT NULL
            AND destination_drive_folder_id IS NOT NULL
            AND destination_file_name IS NOT NULL
            AND destination_size_bytes IS NOT NULL)
    ),

    -- a fully deleted source must still point at a verified destination
    CONSTRAINT drive_account_migration_items_source_deleted_requires_dest CHECK (
        source_deletion_state <> 'SOURCE_DELETED'
        OR (destination_google_drive_file_id IS NOT NULL
            AND verification_state = 'VERIFIED')
    )
);

COMMENT ON TABLE public.drive_account_migration_items IS
    'One row per media per migration. Preserves source AND destination provenance '
    'so the record of where a file came from survives independently of '
    'drive_accounts / replication_jobs.';
COMMENT ON COLUMN public.drive_account_migration_items.source_drive_account_id IS
    'ON DELETE RESTRICT: the DB blocks removal of an account that migration '
    'records still depend on.';
COMMENT ON COLUMN public.drive_account_migration_items.source_deletion_state IS
    'Separate from verification_state on purpose (no boolean). A CHECK constraint '
    'makes it impossible to mark a source deletable before verification_state = VERIFIED.';
COMMENT ON COLUMN public.drive_account_migration_items.destination_drive_folder_id IS
    'Destination counterpart of source_drive_folder_id, created/found '
    'deterministically by the future worker via claim_drive_folder().';

CREATE INDEX IF NOT EXISTS drive_account_migration_items_migration_idx
    ON public.drive_account_migration_items (migration_id, verification_state);
CREATE INDEX IF NOT EXISTS drive_account_migration_items_source_account_idx
    ON public.drive_account_migration_items (source_drive_account_id);
CREATE INDEX IF NOT EXISTS drive_account_migration_items_dest_account_idx
    ON public.drive_account_migration_items (destination_drive_account_id);
CREATE INDEX IF NOT EXISTS drive_account_migration_items_open_idx
    ON public.drive_account_migration_items (migration_id)
    WHERE source_deletion_state <> 'SOURCE_DELETED';

-- ---------------------------------------------------------------------------
-- 3. drive_accounts.retiring_migration_id — the retirement guard
-- ---------------------------------------------------------------------------
-- Deliberately a NEW, dedicated column: the guard must be able to distinguish
-- a normal active account, an account participating as a migration source, and
-- a retired/removed account without overloading status / health_status /
-- enabled (which describe connectivity and quota, not lifecycle intent).
ALTER TABLE public.drive_accounts
    ADD COLUMN IF NOT EXISTS retiring_migration_id uuid
    REFERENCES public.drive_account_migrations(id) ON DELETE RESTRICT;

COMMENT ON COLUMN public.drive_accounts.retiring_migration_id IS
    'NULL = not being retired. Non-NULL = this account is the source of that '
    'migration and is off-limits as a destination and for removal. Distinct from '
    'status / health_status / enabled, which describe connectivity and capacity.';

CREATE INDEX IF NOT EXISTS drive_accounts_retiring_migration_idx
    ON public.drive_accounts (retiring_migration_id);

-- Consistency guard: retiring_migration_id may only point at a migration whose
-- source is this very account.  Prevents a cross-wired guard from silently
-- un-protecting an account.
CREATE OR REPLACE FUNCTION private.enforce_retiring_migration_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
    IF NEW.retiring_migration_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.drive_account_migrations m
        WHERE m.id = NEW.retiring_migration_id
          AND m.source_drive_account_id = NEW.id
    ) THEN
        RAISE EXCEPTION
            'retiring_migration_id % is not a migration whose source is account %',
            NEW.retiring_migration_id, NEW.id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_drive_accounts_retiring_consistency ON public.drive_accounts;
CREATE TRIGGER trg_drive_accounts_retiring_consistency
    BEFORE INSERT OR UPDATE OF retiring_migration_id ON public.drive_accounts
    FOR EACH ROW
    EXECUTE FUNCTION private.enforce_retiring_migration_consistency();

-- ---------------------------------------------------------------------------
-- 4. RLS — admin-only, no anonymous access
-- ---------------------------------------------------------------------------
ALTER TABLE public.drive_account_migrations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drive_account_migration_items  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS drive_account_migrations_admin_all ON public.drive_account_migrations;
CREATE POLICY drive_account_migrations_admin_all
    ON public.drive_account_migrations
    FOR ALL
    USING (private.is_admin())
    WITH CHECK (private.is_admin());

DROP POLICY IF EXISTS drive_account_migration_items_admin_all ON public.drive_account_migration_items;
CREATE POLICY drive_account_migration_items_admin_all
    ON public.drive_account_migration_items
    FOR ALL
    USING (private.is_admin())
    WITH CHECK (private.is_admin());

-- ---------------------------------------------------------------------------
-- 5. Grants — service role only beyond RLS; never anon
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.drive_account_migrations      FROM anon;
REVOKE ALL ON public.drive_account_migration_items FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.drive_account_migrations      TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.drive_account_migration_items TO authenticated, service_role;

COMMIT;
