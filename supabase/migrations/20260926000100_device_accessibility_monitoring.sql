-- Accessibility-based monitoring foundation (phase 1: metadata only).
--
-- Scope: this phase records ONLY accessibility metadata that the admin dashboard
-- needs to understand basic device/app UI activity. It deliberately does NOT
-- implement screen capture, microphone/camera, location, keylogging, or any
-- other invasive capability.
--
-- Follows the existing project conventions:
--   * identity        : device_id -> public.devices(id), user_id -> public.profiles(id)
--   * ownership/authz : (user_id = auth.uid()) OR private.is_admin(), TO authenticated
--   * timestamps      : timestamptz + the existing public.set_updated_at() trigger
-- No existing table is modified, and nothing is dropped.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. device_accessibility_status — CURRENT state per device
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.device_accessibility_status (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id             uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    user_id               uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    is_enabled            boolean NOT NULL DEFAULT false,
    service_connected     boolean NOT NULL DEFAULT false,
    last_connected_at     timestamptz,
    last_disconnected_at  timestamptz,
    last_event_at         timestamptz,
    last_heartbeat_at     timestamptz,
    accessibility_api_level integer,
    service_version       text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    -- One current status row per device.
    CONSTRAINT device_accessibility_status_device_key UNIQUE (device_id)
);

CREATE INDEX IF NOT EXISTS idx_device_accessibility_status_user
    ON public.device_accessibility_status (user_id);

DROP TRIGGER IF EXISTS device_accessibility_status_set_updated_at
    ON public.device_accessibility_status;
CREATE TRIGGER device_accessibility_status_set_updated_at
    BEFORE UPDATE ON public.device_accessibility_status
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. device_accessibility_events — selected events only (never raw firehose)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.device_accessibility_events (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id           uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    user_id             uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    event_type          text NOT NULL,
    package_name        text,
    activity_name       text,
    event_time          timestamptz NOT NULL,
    window_id           integer,
    -- Populated only when the Accessibility API actually exposes it and the
    -- value is safe to keep.
    window_title        text,
    -- Never populated for a password field (enforced by the CHECK below).
    event_text          text,
    content_description text,
    class_name          text,
    is_password_field   boolean NOT NULL DEFAULT false,
    is_editable         boolean,
    is_clickable        boolean,
    is_scrollable       boolean,
    event_metadata      jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    -- Database-level guarantee that no password value can ever be stored, even if
    -- a future client is buggy.
    CONSTRAINT device_accessibility_events_no_password_text
        CHECK (NOT is_password_field OR event_text IS NULL)
);

-- Admin dashboard reads a device's recent events in time order.
CREATE INDEX IF NOT EXISTS idx_device_accessibility_events_device_time
    ON public.device_accessibility_events (device_id, event_time DESC);
-- Retention cleanup scans by age.
CREATE INDEX IF NOT EXISTS idx_device_accessibility_events_time
    ON public.device_accessibility_events (event_time);
CREATE INDEX IF NOT EXISTS idx_device_accessibility_events_user
    ON public.device_accessibility_events (user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. device_accessibility_sessions — summarised foreground sessions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.device_accessibility_sessions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id      uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    user_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    package_name   text NOT NULL,
    activity_name  text,
    started_at     timestamptz NOT NULL,
    ended_at       timestamptz,
    -- Null until the session is closed: duration is only claimed once the
    -- Accessibility events actually establish an end.
    duration_ms    bigint,
    start_event_id uuid REFERENCES public.device_accessibility_events(id) ON DELETE SET NULL,
    end_event_id   uuid REFERENCES public.device_accessibility_events(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT device_accessibility_sessions_duration_non_negative
        CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

-- At most one OPEN session per device.
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_accessibility_sessions_open
    ON public.device_accessibility_sessions (device_id)
    WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_device_accessibility_sessions_device_started
    ON public.device_accessibility_sessions (device_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_accessibility_sessions_user
    ON public.device_accessibility_sessions (user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. device_monitoring_settings — per-device collection switches
--    Defaults minimise collection: nothing is collected until it is explicitly
--    switched on after the documented setup disclosure.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.device_monitoring_settings (
    id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id                      uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    user_id                        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    accessibility_monitoring_enabled boolean NOT NULL DEFAULT false,
    event_collection_enabled       boolean NOT NULL DEFAULT false,
    collect_window_events          boolean NOT NULL DEFAULT false,
    collect_interaction_events     boolean NOT NULL DEFAULT false,
    collect_text_events            boolean NOT NULL DEFAULT false,
    collect_notification_events    boolean NOT NULL DEFAULT false,
    retention_days                 integer NOT NULL DEFAULT 14
        CONSTRAINT device_monitoring_settings_retention_range
        CHECK (retention_days >= 1 AND retention_days <= 365),
    created_at                     timestamptz NOT NULL DEFAULT now(),
    updated_at                     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT device_monitoring_settings_device_key UNIQUE (device_id)
);

CREATE INDEX IF NOT EXISTS idx_device_monitoring_settings_user
    ON public.device_monitoring_settings (user_id);

DROP TRIGGER IF EXISTS device_monitoring_settings_set_updated_at
    ON public.device_monitoring_settings;
CREATE TRIGGER device_monitoring_settings_set_updated_at
    BEFORE UPDATE ON public.device_monitoring_settings
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. RLS — ownership for the device, organisation-wide read for admins only
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.device_accessibility_status  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_accessibility_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_accessibility_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_monitoring_settings   ENABLE ROW LEVEL SECURITY;

-- Status: the device maintains its own row; an admin may read/manage any device.
DROP POLICY IF EXISTS "Users can view own device accessibility status" ON public.device_accessibility_status;
CREATE POLICY "Users can view own device accessibility status"
    ON public.device_accessibility_status FOR SELECT TO authenticated
    USING ((user_id = auth.uid()) OR private.is_admin());

DROP POLICY IF EXISTS "Users can insert own device accessibility status" ON public.device_accessibility_status;
CREATE POLICY "Users can insert own device accessibility status"
    ON public.device_accessibility_status FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own device accessibility status" ON public.device_accessibility_status;
CREATE POLICY "Users can update own device accessibility status"
    ON public.device_accessibility_status FOR UPDATE TO authenticated
    USING ((user_id = auth.uid()) OR private.is_admin())
    WITH CHECK ((user_id = auth.uid()) OR private.is_admin());

DROP POLICY IF EXISTS "Users can delete own device accessibility status" ON public.device_accessibility_status;
CREATE POLICY "Users can delete own device accessibility status"
    ON public.device_accessibility_status FOR DELETE TO authenticated
    USING (private.is_admin());

-- Events: write-only for the device (append-only, tamper-resistant), readable by
-- its owner and by admins. No UPDATE policy, so a client cannot rewrite history.
DROP POLICY IF EXISTS "Users can view own device accessibility events" ON public.device_accessibility_events;
CREATE POLICY "Users can view own device accessibility events"
    ON public.device_accessibility_events FOR SELECT TO authenticated
    USING ((user_id = auth.uid()) OR private.is_admin());

DROP POLICY IF EXISTS "Users can insert own device accessibility events" ON public.device_accessibility_events;
CREATE POLICY "Users can insert own device accessibility events"
    ON public.device_accessibility_events FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Admins can delete device accessibility events" ON public.device_accessibility_events;
CREATE POLICY "Admins can delete device accessibility events"
    ON public.device_accessibility_events FOR DELETE TO authenticated
    USING (private.is_admin());

-- Sessions: same posture as events, but the device closes its own open session.
DROP POLICY IF EXISTS "Users can view own device accessibility sessions" ON public.device_accessibility_sessions;
CREATE POLICY "Users can view own device accessibility sessions"
    ON public.device_accessibility_sessions FOR SELECT TO authenticated
    USING ((user_id = auth.uid()) OR private.is_admin());

DROP POLICY IF EXISTS "Users can insert own device accessibility sessions" ON public.device_accessibility_sessions;
CREATE POLICY "Users can insert own device accessibility sessions"
    ON public.device_accessibility_sessions FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can close own device accessibility sessions" ON public.device_accessibility_sessions;
CREATE POLICY "Users can close own device accessibility sessions"
    ON public.device_accessibility_sessions FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Admins can delete device accessibility sessions" ON public.device_accessibility_sessions;
CREATE POLICY "Admins can delete device accessibility sessions"
    ON public.device_accessibility_sessions FOR DELETE TO authenticated
    USING (private.is_admin());

-- Settings: the device configures its own row; admins may read and change any.
DROP POLICY IF EXISTS "Users can view own device monitoring settings" ON public.device_monitoring_settings;
CREATE POLICY "Users can view own device monitoring settings"
    ON public.device_monitoring_settings FOR SELECT TO authenticated
    USING ((user_id = auth.uid()) OR private.is_admin());

DROP POLICY IF EXISTS "Users can insert own device monitoring settings" ON public.device_monitoring_settings;
CREATE POLICY "Users can insert own device monitoring settings"
    ON public.device_monitoring_settings FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own device monitoring settings" ON public.device_monitoring_settings;
CREATE POLICY "Users can update own device monitoring settings"
    ON public.device_monitoring_settings FOR UPDATE TO authenticated
    USING ((user_id = auth.uid()) OR private.is_admin())
    WITH CHECK ((user_id = auth.uid()) OR private.is_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Retention / cleanup support (high-volume event data)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_expired_accessibility_data()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    deleted_events integer := 0;
    deleted_sessions integer := 0;
BEGIN
    -- Age is per device: a device without a settings row falls back to 14 days.
    DELETE FROM public.device_accessibility_events e
     WHERE e.event_time < NOW() - (
        COALESCE(
            (SELECT s.retention_days FROM public.device_monitoring_settings s
              WHERE s.device_id = e.device_id),
            14
        ) || ' days'
     )::interval;
    GET DIAGNOSTICS deleted_events = ROW_COUNT;

    DELETE FROM public.device_accessibility_sessions d
     WHERE d.started_at < NOW() - (
        COALESCE(
            (SELECT s.retention_days FROM public.device_monitoring_settings s
              WHERE s.device_id = d.device_id),
            14
        ) || ' days'
     )::interval;
    GET DIAGNOSTICS deleted_sessions = ROW_COUNT;

    RETURN deleted_events + deleted_sessions;
END;
$$;

-- Only the service role (scheduled maintenance) may run the purge; a device must
-- not be able to erase its own history, and no employee can purge others' data.
REVOKE ALL ON FUNCTION public.purge_expired_accessibility_data() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_expired_accessibility_data() FROM anon;
REVOKE ALL ON FUNCTION public.purge_expired_accessibility_data() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_accessibility_data() TO service_role;
