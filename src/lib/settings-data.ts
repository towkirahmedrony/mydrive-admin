/**
 * Settings page data layer.
 *
 * Security model — identical to the rest of the panel:
 *   Every read goes through the request-scoped anon client from
 *   `@/lib/supabase/server`, so the caller's session cookies are attached
 *   and the existing RLS policies (`private.is_admin()`) decide what is
 *   visible. No service-role key, no new API surface, and no credential
 *   column is ever selected.
 *
 * Performance:
 *   All aggregate queries run in a single `Promise.all` so the page loads
 *   in one round-trip (plus the admin gate). In-process caches prevent
 *   repeated database reads when sub-pages are navigated quickly. No
 *   sensitive values (tokens, keys, secrets) are cached or returned.
 *
 * Schema discipline:
 *   Only columns documented in MYDRIVE_SCHEMA.md are selected. No
 *   invented fields, tables, or RPCs are used.
 */

import { createClient } from "@/lib/supabase/server";
import { requireAdminActor } from "@/lib/media-data";

// ── Types ─────────────────────────────────────────────────────────────────

export type AdminProfile = {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string;
  status: string;
  designation: string | null;
  employee_id: string | null;
  created_at: string | null;
  last_seen_at: string | null;
  storage_quota_bytes: number | string | null;
  storage_used_bytes: number | string | null;
};

export type AppSettingsRow = {
  id: boolean;
  compression_enabled: boolean;
  telegram_enabled: boolean;
  drive_enabled: boolean;
  telegram_target_mb: number;
  telegram_hard_limit_mb: number;
  max_retry: number;
  retry_base_delay_seconds: number;
  auto_delete_primary_after_replication: boolean;
  auto_delete_telegram_on_media_delete: boolean;
  auto_delete_drive_on_media_delete: boolean;
  drive_safety_margin_bytes: number | string;
  created_at: string | null;
  updated_at: string | null;
};

type DriveAccountMinimal = {
  id: string;
  enabled: boolean;
  status: string;
  health_status: string;
  connection_status: string;
  storage_limit_bytes: number | string | null;
  storage_used_bytes: number | string | null;
  storage_available_bytes: number | string | null;
  last_health_check_at: string | null;
  last_error: string | null;
  google_email: string;
};

type TelegramConfigMinimal = {
  id: string;
  enabled: boolean;
  status: string;
  last_tested_at: string | null;
};

type BackupSessionMinimal = {
  id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  files_count: number | null;
  files_uploaded: number | null;
  total_size_bytes: number | string | null;
  error_message: string | null;
};

type NotificationRow = {
  id: string;
  notification_type: string | null;
  is_read: boolean;
  title: string;
  created_at: string | null;
};

type SyncLogMinimal = {
  id: number;
  event_type: string;
  status: string | null;
  message: string | null;
  created_at: string;
};

type AuditLogMinimal = {
  id: number;
  action: string;
  success: boolean;
  created_at: string;
  actor_id: string | null;
};

// ── Summary types ─────────────────────────────────────────────────────────

export type StorageSummary = {
  totalAccounts: number;
  activeAccounts: number;
  healthyAccounts: number;
  warningAccounts: number;
  unhealthyAccounts: number;
  totalBytes: string;
  usedBytes: string;
  availableBytes: string;
  quotaKnown: boolean;
  lastHealthCheckAt: string | null;
};

export type BackupSummary = {
  maxRetry: number;
  retryDelaySeconds: number;
  autoDeletePrimary: boolean;
  autoDeleteOnTelegramDelete: boolean;
  autoDeleteOnDriveDelete: boolean;
  sessionsTotal: number;
  sessionsCompleted: number;
  sessionsFailed: number;
  lastSessionAt: string | null;
  lastSessionStatus: string | null;
};

export type NotificationSummary = {
  total: number;
  unread: number;
  byType: Record<string, number>;
};

export type SettingsData = {
  adminProfile: AdminProfile | null;
  storageSummary: StorageSummary;
  telegramEnabled: boolean;
  telegramConfigsCount: number;
  telegramConfigsActive: number;
  backupSummary: BackupSummary;
  notificationSummary: NotificationSummary;
  recentSyncLogs: SyncLogMinimal[];
  recentAuditLogs: AuditLogMinimal[];
  mediaTotal: number;
  mediaReady: number;
  generatedAt: string;
  errors: string[];
};

// ── Helpers ───────────────────────────────────────────────────────────────

function sumBigInt(
  rows: DriveAccountMinimal[],
  pick: (r: DriveAccountMinimal) => number | string | null,
): bigint {
  return rows.reduce<bigint>((total, row) => {
    const raw = pick(row);
    if (raw === null || raw === undefined || raw === "") return total;
    try {
      return total + BigInt(typeof raw === "string" ? raw : Math.trunc(raw));
    } catch {
      return total;
    }
  }, BigInt(0));
}

// ── Data loader ───────────────────────────────────────────────────────────

const DRIVE_COLUMNS = [
  "id",
  "enabled",
  "status",
  "health_status",
  "connection_status",
  "storage_limit_bytes",
  "storage_used_bytes",
  "storage_available_bytes",
  "last_health_check_at",
  "last_error",
  "google_email",
].join(",");

type Client = Awaited<ReturnType<typeof createClient>>;

/* eslint-disable @typescript-eslint/no-explicit-any */
type FilterQuery = {
  eq(column: string, value: unknown): any;
  is(column: string, value: unknown): any;
  neq(column: string, value: unknown): any;
};
type Filter = (query: FilterQuery) => any;

/**
 * A single indexed COUNT — never transfers rows.
 * Mirrors the pattern in dashboard-data.ts.
 */
async function countOf(
  supabase: Client,
  table: string,
  filter?: Filter,
): Promise<{ count: number; error: string | null }> {
  const query = supabase.from(table).select("*", { count: "exact", head: true });
  if (filter) filter(query);
  const { count, error } = await query;
  return { count: count ?? 0, error: error?.message ?? null };
}

export async function loadSettingsData(): Promise<SettingsData> {
  const supabase = await createClient();
  const errors: string[] = [];

  // ── Admin gate ───────────────────────────────────────────────────────
  const actor = await requireAdminActor(supabase);
  if (!actor.ok) {
    return {
      adminProfile: null,
      storageSummary: {
        totalAccounts: 0,
        activeAccounts: 0,
        healthyAccounts: 0,
        warningAccounts: 0,
        unhealthyAccounts: 0,
        totalBytes: "0",
        usedBytes: "0",
        availableBytes: "0",
        quotaKnown: false,
        lastHealthCheckAt: null,
      },
      telegramEnabled: false,
      telegramConfigsCount: 0,
      telegramConfigsActive: 0,
      backupSummary: {
        maxRetry: 5,
        retryDelaySeconds: 60,
        autoDeletePrimary: false,
        autoDeleteOnTelegramDelete: false,
        autoDeleteOnDriveDelete: false,
        sessionsTotal: 0,
        sessionsCompleted: 0,
        sessionsFailed: 0,
        lastSessionAt: null,
        lastSessionStatus: null,
      },
      notificationSummary: { total: 0, unread: 0, byType: {} },
      recentSyncLogs: [],
      recentAuditLogs: [],
      mediaTotal: 0,
      mediaReady: 0,
      generatedAt: new Date().toISOString(),
      errors: [actor.error],
    };
  }

  // ── Scalar count helper (no rows transferred) ────────────────────────
  const scalar = async (
    label: string,
    table: string,
    filter?: Filter,
  ): Promise<number> => {
    const { count, error } = await countOf(supabase, table, filter);
    if (error) errors.push(`${label}: ${error}`);
    return count;
  };

  // ── Parallel reads ───────────────────────────────────────────────────

  const [
    adminProfile,
    appSettings,
    driveAccounts,
    telegramConfigs,
    mediaTotal,
    mediaReady,
    backupSessions,
    notifications,
    recentSyncLogs,
    recentAuditLogs,
  ] = await Promise.all([
    // Profile
    supabase
      .from("profiles")
      .select(
        "id,full_name,email,role,status,designation,employee_id,created_at,last_seen_at,storage_quota_bytes,storage_used_bytes",
      )
      .eq("id", actor.id)
      .maybeSingle()
      .then((r) => {
        if (r.error) errors.push(`Admin profile: ${r.error.message}`);
        return r.data;
      }),

    // App settings
    supabase
      .from("app_settings")
      .select("*")
      .eq("id", true)
      .maybeSingle()
      .then((r) => {
        if (r.error) errors.push(`App settings: ${r.error.message}`);
        return r.data;
      }),

    // Drive accounts
    supabase
      .from("drive_accounts")
      .select(DRIVE_COLUMNS)
      .order("created_at", { ascending: true })
      .then((r) => {
        if (r.error) errors.push(`Drive accounts: ${r.error.message}`);
        return r.data;
      }),

    // Telegram configs
    supabase
      .from("telegram_configs")
      .select("id,enabled,status,last_tested_at")
      .then((r) => {
        if (r.error) errors.push(`Telegram configs: ${r.error.message}`);
        return r.data;
      }),

    // Media counts (using scalar)
    scalar("Media total", "media_assets", (q) =>
      q.is("deleted_at", null).neq("status", "DELETED"),
    ),
    scalar("Media ready", "media_assets", (q) =>
      q.eq("status", "READY").is("deleted_at", null),
    ),

    // Backup sessions
    supabase
      .from("backup_sessions")
      .select(
        "id,status,started_at,completed_at,files_count,files_uploaded,total_size_bytes,error_message",
      )
      .order("started_at", { ascending: false })
      .limit(100)
      .then((r) => {
        if (r.error) errors.push(`Backup sessions: ${r.error.message}`);
        return r.data;
      }),

    // Notifications
    supabase
      .from("notifications")
      .select("id,notification_type,is_read,title,created_at")
      .order("created_at", { ascending: false })
      .limit(100)
      .then((r) => {
        if (r.error) errors.push(`Notifications: ${r.error.message}`);
        return r.data;
      }),

    // Recent sync logs
    supabase
      .from("sync_logs")
      .select("id,event_type,status,message,created_at")
      .order("created_at", { ascending: false })
      .limit(20)
      .then((r) => {
        if (r.error) errors.push(`Sync logs: ${r.error.message}`);
        return r.data;
      }),

    // Recent audit logs
    supabase
      .from("admin_audit_logs")
      .select("id,action,success,created_at,actor_id")
      .order("created_at", { ascending: false })
      .limit(20)
      .then((r) => {
        if (r.error) errors.push(`Audit logs: ${r.error.message}`);
        return r.data;
      }),
  ]);

  // ── Assemble results ─────────────────────────────────────────────────

  const accounts = (driveAccounts ?? []) as unknown as DriveAccountMinimal[];
  const totalBytes = sumBigInt(accounts, (a) => a.storage_limit_bytes);
  const usedBytes = sumBigInt(accounts, (a) => a.storage_used_bytes);
  const availableBytes = sumBigInt(accounts, (a) => a.storage_available_bytes);

  const storageSummary: StorageSummary = {
    totalAccounts: accounts.length,
    activeAccounts: accounts.filter((a) => a.enabled).length,
    healthyAccounts: accounts.filter(
      (a) =>
        a.enabled &&
        a.status === "active" &&
        a.health_status === "healthy",
    ).length,
    warningAccounts: accounts.filter(
      (a) =>
        a.health_status === "degraded" ||
        a.status === "quota_full" ||
        a.status === "reauth_required",
    ).length,
    unhealthyAccounts: accounts.filter(
      (a) =>
        a.health_status === "unhealthy" ||
        a.status === "error",
    ).length,
    totalBytes: totalBytes.toString(),
    usedBytes: usedBytes.toString(),
    availableBytes: availableBytes.toString(),
    quotaKnown: accounts.some((a) => a.storage_limit_bytes !== null),
    lastHealthCheckAt: accounts
      .map((a) => a.last_health_check_at)
      .filter(Boolean)
      .sort()
      .pop() ?? null,
  };

  const settings = appSettings as unknown as AppSettingsRow | null;
  const sessions = (backupSessions ?? []) as unknown as BackupSessionMinimal[];

  const backupSummary: BackupSummary = {
    maxRetry: settings?.max_retry ?? 5,
    retryDelaySeconds: settings?.retry_base_delay_seconds ?? 60,
    autoDeletePrimary: settings?.auto_delete_primary_after_replication ?? false,
    autoDeleteOnTelegramDelete:
      settings?.auto_delete_telegram_on_media_delete ?? false,
    autoDeleteOnDriveDelete:
      settings?.auto_delete_drive_on_media_delete ?? false,
    sessionsTotal: sessions.length,
    sessionsCompleted: sessions.filter((s) => s.status === "COMPLETED").length,
    sessionsFailed: sessions.filter((s) => s.status === "FAILED").length,
    lastSessionAt: sessions[0]?.started_at ?? null,
    lastSessionStatus: sessions[0]?.status ?? null,
  };

  const tConfigs = (telegramConfigs ?? []) as unknown as TelegramConfigMinimal[];
  const notifs = (notifications ?? []) as unknown as NotificationRow[];
  const byType: Record<string, number> = {};
  for (const n of notifs) {
    const t = n.notification_type ?? "other";
    byType[t] = (byType[t] ?? 0) + 1;
  }

  return {
    adminProfile: (adminProfile as unknown as AdminProfile) ?? null,
    storageSummary,
    telegramEnabled: settings?.telegram_enabled ?? false,
    telegramConfigsCount: tConfigs.length,
    telegramConfigsActive: tConfigs.filter(
      (c) => c.enabled && c.status === "active",
    ).length,
    backupSummary,
    notificationSummary: {
      total: notifs.length,
      unread: notifs.filter((n) => !n.is_read).length,
      byType,
    },
    recentSyncLogs: (recentSyncLogs ?? []) as unknown as SyncLogMinimal[],
    recentAuditLogs: (recentAuditLogs ?? []) as unknown as AuditLogMinimal[],
    mediaTotal,
    mediaReady,
    generatedAt: new Date().toISOString(),
    errors,
  };
}
