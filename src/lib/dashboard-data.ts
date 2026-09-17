import { createClient } from "@/lib/supabase/server";
import type { Tone } from "@/lib/format";

/**
 * Dashboard data layer.
 *
 * Security model (unchanged from the rest of the panel): the request-scoped
 * anon client carries the admin's session cookies, so every read below is
 * filtered by the existing RLS policies (`private.is_admin()`), and no
 * service-role key is ever involved. No credential columns are selected:
 * drive_accounts.refresh_token_secret_id and telegram_configs.bot_token_secret_id
 * are never fetched.
 *
 * Performance: every statistic is a `count: "exact", head: true` aggregate, so
 * no media/job rows are transferred to compute counts. The handful of list
 * queries are bounded by explicit `limit()`s — no N+1, no full-table reads.
 *
 * Google Drive quota comes from the columns the existing health check already
 * persists (storage_*_bytes / last_quota_check_at). The dashboard never calls
 * the Drive API and never touches OAuth.
 */

export type { Tone };

export interface SystemState {
  /** Subsystem name, rendered on the left. */
  label: string;
  /** Short state word, rendered as the status badge. */
  badge: string;
  tone: Tone;
  detail: string;
}

export interface DriveAccountRow {
  id: string;
  name: string | null;
  display_name: string | null;
  google_email: string;
  enabled: boolean;
  status: string;
  connection_status: string;
  health_status: string;
  storage_limit_bytes: number | string | null;
  storage_used_bytes: number | string | null;
  storage_available_bytes: number | string | null;
  reserved_bytes: number | string | null;
  priority: number;
  last_quota_check_at: string | null;
  last_health_check_at: string | null;
  last_error: string | null;
}

export interface JobRow {
  id: string;
  status: string;
  destination_type: string;
  last_error: string | null;
  attempt_count: number;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string | null;
  media_id: string | null;
  drive_account_id: string | null;
  media_assets: { file_name: string | null; local_media_id: number | null } | null;
  drive_accounts: { google_email: string | null } | null;
}

export interface MediaRow {
  id: string;
  file_name: string | null;
  mime_type: string | null;
  file_size: number | string | null;
  status: string;
  created_at: string;
  profiles: { email: string | null } | null;
}

export interface SyncLogRow {
  id: number;
  event_type: string;
  status: string;
  message: string | null;
  created_at: string;
  media_id: string | null;
}

export interface DestinationSummary {
  key: string;
  label: string;
  PENDING: number;
  PROCESSING: number;
  COMPLETED: number;
  FAILED: number;
  RETRYING: number;
  SKIPPED: number;
}

export interface DashboardData {
  generatedAt: string;
  /** Non-fatal problems; the section still renders with whatever loaded. */
  errors: string[];
  queryCount: number;

  counts: {
    totalUsers: number;
    activeUsers: number;
    suspendedUsers: number;
    devices: number;
    mediaTotal: number;
    mediaReady: number;
    mediaFailed: number;
    mediaToday: number;
    jobsPending: number;
    jobsFailed: number;
    telegramConfigs: number;
    telegramConfigsEnabled: number;
    telegramConfigsInvalid: number;
  };

  driveAccounts: DriveAccountRow[];
  destinations: DestinationSummary[];
  recentFailures: JobRow[];
  recentSuccesses: JobRow[];
  recentUploads: MediaRow[];
  recentFailureLogs: SyncLogRow[];
  recentDriveHealth: DriveAccountRow[];
  systemHealth: SystemState[];
}

const DRIVE_ACCOUNT_COLUMNS = [
  "id",
  "name",
  "display_name",
  "google_email",
  "enabled",
  "status",
  "connection_status",
  "health_status",
  "storage_limit_bytes",
  "storage_used_bytes",
  "storage_available_bytes",
  "reserved_bytes",
  "priority",
  "last_quota_check_at",
  "last_health_check_at",
  "last_error",
].join(",");

const JOB_STATUSES = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "RETRYING",
  "SKIPPED",
] as const;

const DESTINATIONS = [
  { key: "telegram", label: "Telegram" },
  { key: "google_drive", label: "Google Drive" },
] as const;

type Client = Awaited<ReturnType<typeof createClient>>;
type Filter = (query: any) => any;
/** supabase-js builders are PromiseLike, not real Promises. */
type Loaded<T> = PromiseLike<{ data: T | null; error: string | null }>;

/** A single indexed COUNT — never transfers rows. */
async function countOf(
  supabase: Client,
  table: string,
  filter?: Filter,
): Promise<{ count: number; error: string | null }> {
  let query = supabase.from(table).select("*", { count: "exact", head: true });
  if (filter) query = filter(query);
  const { count, error } = await query;
  return { count: count ?? 0, error: error?.message ?? null };
}

/**
 * Runs the whole dashboard load in parallel, collecting failures instead of
 * throwing, so one broken query degrades a single section rather than the page.
 */
export async function loadDashboard(): Promise<DashboardData> {
  const supabase = await createClient();
  const errors: string[] = [];
  let queryCount = 0;

  const track = async <T>(label: string, promise: Loaded<T>): Promise<T | null> => {
    queryCount += 1;
    const { data, error } = await promise;
    if (error) errors.push(`${label}: ${error}`);
    return data;
  };

  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setUTCHours(0, 0, 0, 0);

  // ── Overview statistics ─────────────────────────────────────────────────
  const scalar = (label: string, table: string, filter?: Filter) =>
    track(
      label,
      countOf(supabase, table, filter).then((r) => ({
        data: r.error ? null : r.count,
        error: r.error,
      })),
    );

  // ── Replication: one COUNT per destination/status pair ────────────────
  const destinationCount = (
    label: string,
    destination: string,
    status: string,
  ) =>
    track(
      label,
      countOf(supabase, "replication_jobs", (q) =>
        q.eq("destination_type", destination).eq("status", status),
      ).then((r) => ({ data: r.error ? null : r.count, error: r.error })),
    );

  const listQuery = <T>(label: string, promise: Loaded<T>) => track(label, promise);

  const [
    totalUsers,
    activeUsers,
    suspendedUsers,
    devices,
    mediaTotal,
    mediaReady,
    mediaFailed,
    mediaToday,
    telegramConfigs,
    telegramConfigsEnabled,
    telegramConfigsInvalid,
    driveAccounts,
    recentFailures,
    recentSuccesses,
    recentUploads,
    recentFailureLogs,
    recentDriveHealth,
    ...destinationCounts
  ] = await Promise.all([
    scalar("Total users", "profiles"),
    scalar("Active users", "profiles", (q) => q.eq("status", "active")),
    scalar("Suspended users", "profiles", (q) => q.eq("status", "suspended")),
    scalar("Registered devices", "devices"),
    scalar("Total media assets", "media_assets"),
    scalar("Ready media", "media_assets", (q) => q.eq("status", "READY")),
    scalar("Failed media", "media_assets", (q) => q.eq("status", "FAILED")),
    scalar("Media uploaded today", "media_assets", (q) =>
      q.gte("created_at", startOfToday.toISOString()),
    ),
    scalar("Telegram configs", "telegram_configs"),
    scalar("Enabled Telegram configs", "telegram_configs", (q) => q.eq("enabled", true)),
    scalar("Invalid Telegram configs", "telegram_configs", (q) => q.eq("status", "invalid")),

    // Storage pool: the quota columns the health check already maintains.
    // Intentionally not row-limited: this IS the pool, so every configured
    // account must be included for the totals to be correct. The table is
    // admin-only and its size is operator-controlled (connected accounts).
    listQuery<DriveAccountRow[]>(
      "Drive accounts",
      supabase
        .from("drive_accounts")
        .select(DRIVE_ACCOUNT_COLUMNS)
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true })
        .then((r) => ({
          data: (r.data as unknown as DriveAccountRow[] | null) ?? null,
          error: r.error?.message ?? null,
        })),
    ),

    listQuery<JobRow[]>(
      "Recent failed jobs",
      supabase
        .from("replication_jobs")
        .select(
          "id,status,destination_type,last_error,attempt_count,next_retry_at,created_at,updated_at,media_id,drive_account_id,media_assets(file_name,local_media_id),drive_accounts(google_email)",
        )
        .eq("status", "FAILED")
        .order("updated_at", { ascending: false, nullsFirst: false })
        .limit(5)
        .then((r) => ({
          data: (r.data as unknown as JobRow[] | null) ?? null,
          error: r.error?.message ?? null,
        })),
    ),

    listQuery<JobRow[]>(
      "Recent successful replications",
      supabase
        .from("replication_jobs")
        .select(
          "id,status,destination_type,last_error,attempt_count,next_retry_at,created_at,updated_at,media_id,drive_account_id,media_assets(file_name,local_media_id),drive_accounts(google_email)",
        )
        .eq("status", "COMPLETED")
        .order("updated_at", { ascending: false, nullsFirst: false })
        .limit(5)
        .then((r) => ({
          data: (r.data as unknown as JobRow[] | null) ?? null,
          error: r.error?.message ?? null,
        })),
    ),

    listQuery<MediaRow[]>(
      "Recent media uploads",
      supabase
        .from("media_assets")
        .select("id,file_name,mime_type,file_size,status,created_at,profiles(email)")
        .order("created_at", { ascending: false })
        .limit(5)
        .then((r) => ({
          data: (r.data as unknown as MediaRow[] | null) ?? null,
          error: r.error?.message ?? null,
        })),
    ),

    // Failure audit trail written by the backend. The worker records job
    // failures as "FAILED" (JOB_FAILED events); older/other writers may use a
    // lowercase variant, so match case variants explicitly rather than a
    // single assumed spelling.
    listQuery<SyncLogRow[]>(
      "Recent failure log",
      supabase
        .from("sync_logs")
        .select("id,event_type,status,message,created_at,media_id")
        .in("status", ["FAILED", "failed", "failure"])
        .order("created_at", { ascending: false })
        .limit(5)
        .then((r) => ({
          data: (r.data as unknown as SyncLogRow[] | null) ?? null,
          error: r.error?.message ?? null,
        })),
    ),

    // Drive health changes = most recently health-checked accounts.
    listQuery<DriveAccountRow[]>(
      "Recent Drive health checks",
      supabase
        .from("drive_accounts")
        .select(DRIVE_ACCOUNT_COLUMNS)
        .order("last_health_check_at", { ascending: false, nullsFirst: false })
        .limit(5)
        .then((r) => ({
          data: (r.data as unknown as DriveAccountRow[] | null) ?? null,
          error: r.error?.message ?? null,
        })),
    ),

    ...DESTINATIONS.flatMap((destination) =>
      JOB_STATUSES.map((status) =>
        destinationCount(
          `${destination.label} ${status.toLowerCase()} jobs`,
          destination.key,
          status,
        ),
      ),
    ),
  ]);

  // ── Assemble per-destination summaries ────────────────────────────────
  const flat = destinationCounts as (number | null)[];
  const destinations: DestinationSummary[] = DESTINATIONS.map((destination, dIndex) => {
    const slice = flat.slice(
      dIndex * JOB_STATUSES.length,
      dIndex * JOB_STATUSES.length + JOB_STATUSES.length,
    );
    const [pending, processing, completed, failed, retrying, skipped] = slice;
    return {
      key: destination.key,
      label: destination.label,
      PENDING: pending ?? 0,
      PROCESSING: processing ?? 0,
      COMPLETED: completed ?? 0,
      FAILED: failed ?? 0,
      RETRYING: retrying ?? 0,
      SKIPPED: skipped ?? 0,
    };
  });

  // Overview job stats are derived from the same counts (no extra queries).
  const jobsPending = destinations.reduce((sum, d) => sum + d.PENDING, 0) +
    destinations.reduce((sum, d) => sum + d.RETRYING, 0);
  const jobsFailed = destinations.reduce((sum, d) => sum + d.FAILED, 0);

  const accounts = driveAccounts ?? [];
  const telegram = destinations.find((d) => d.key === "telegram");
  const drive = destinations.find((d) => d.key === "google_drive");

  const counts = {
    totalUsers: totalUsers ?? 0,
    activeUsers: activeUsers ?? 0,
    suspendedUsers: suspendedUsers ?? 0,
    devices: devices ?? 0,
    mediaTotal: mediaTotal ?? 0,
    mediaReady: mediaReady ?? 0,
    mediaFailed: mediaFailed ?? 0,
    mediaToday: mediaToday ?? 0,
    jobsPending,
    jobsFailed,
    telegramConfigs: telegramConfigs ?? 0,
    telegramConfigsEnabled: telegramConfigsEnabled ?? 0,
    telegramConfigsInvalid: telegramConfigsInvalid ?? 0,
  };

  return {
    generatedAt: now.toISOString(),
    errors,
    queryCount,
    counts,
    driveAccounts: accounts,
    destinations,
    recentFailures: recentFailures ?? [],
    recentSuccesses: recentSuccesses ?? [],
    recentUploads: recentUploads ?? [],
    recentFailureLogs: recentFailureLogs ?? [],
    recentDriveHealth: recentDriveHealth ?? [],
    systemHealth: buildSystemHealth({
      errors,
      queryCount,
      counts,
      accounts,
      telegram: telegram ?? null,
      drive: drive ?? null,
    }),
  };
}

// ── Presentation mappings (pure functions, no I/O) ────────────────────────

export function jobStatusTone(status: string): Tone {
  switch (status) {
    case "COMPLETED":
      return "success";
    case "FAILED":
      return "danger";
    case "RETRYING":
      return "warning";
    case "PROCESSING":
      return "info";
    case "PENDING":
      return "neutral";
    default:
      return "neutral";
  }
}

export function mediaStatusTone(status: string): Tone {
  switch (status) {
    case "READY":
      return "success";
    case "FAILED":
      return "danger";
    case "UPLOADING":
      return "info";
    case "DELETED":
      return "neutral";
    default:
      return "neutral";
  }
}

export function accountHealthTone(account: DriveAccountRow): Tone {
  if (!account.enabled || account.status === "disabled") return "neutral";
  if (account.health_status === "healthy" && account.status === "active") return "success";
  if (account.health_status === "degraded" || account.status === "quota_full") return "warning";
  if (
    account.health_status === "unhealthy" ||
    account.status === "reauth_required" ||
    account.status === "error"
  ) {
    return "danger";
  }
  return "neutral";
}

export function connectionTone(connectionStatus: string): Tone {
  switch (connectionStatus) {
    case "connected":
      return "success";
    case "unknown":
      return "neutral";
    case "reauth_required":
    case "error":
      return "danger";
    case "disconnected":
      return "warning";
    default:
      return "neutral";
  }
}

/** Aggregates the storage pool from stored quota columns. */
export function storagePool(accounts: DriveAccountRow[]) {
  const sum = (pick: (a: DriveAccountRow) => number | string | null) =>
    accounts.reduce<bigint>((total, account) => {
      const raw = pick(account);
      if (raw === null || raw === undefined || raw === "") return total;
      try {
        return total + BigInt(typeof raw === "string" ? raw : Math.trunc(raw));
      } catch {
        return total;
      }
    }, BigInt(0));

  return {
    accounts: accounts.length,
    enabled: accounts.filter((a) => a.enabled).length,
    healthy: accounts.filter((a) => accountHealthTone(a) === "success").length,
    warning: accounts.filter((a) => accountHealthTone(a) === "warning").length,
    unhealthy: accounts.filter((a) => accountHealthTone(a) === "danger").length,
    disabled: accounts.filter((a) => !a.enabled || a.status === "disabled").length,
    totalBytes: sum((a) => a.storage_limit_bytes),
    usedBytes: sum((a) => a.storage_used_bytes),
    availableBytes: sum((a) => a.storage_available_bytes),
    reservedBytes: sum((a) => a.reserved_bytes),
    quotaKnown: accounts.some((a) => a.storage_limit_bytes !== null),
  };
}

function buildSystemHealth(input: {
  errors: string[];
  queryCount: number;
  counts: DashboardData["counts"];
  accounts: DriveAccountRow[];
  telegram: DestinationSummary | null;
  drive: DestinationSummary | null;
}): SystemState[] {
  const { errors, queryCount, counts, accounts, telegram, drive } = input;

  // Backend connectivity is proven by the reads themselves.
  const failed = errors.length;
  const backend = failed === 0
    ? {
      badge: "Operational",
      tone: "success" as Tone,
      detail: `Supabase reachable — ${queryCount} read${queryCount === 1 ? "" : "s"} succeeded`,
    }
    : {
      badge: failed === queryCount ? "Unavailable" : "Degraded",
      tone: (failed === queryCount ? "danger" : "warning") as Tone,
      detail: `${failed} of ${queryCount} reads failed`,
    };

  const healthy = accounts.filter((a) => accountHealthTone(a) === "success").length;
  const unhealthy = accounts.filter((a) => accountHealthTone(a) === "danger").length;

  const driveIntegration = accounts.length === 0
    ? {
      badge: "Not configured",
      tone: "warning" as Tone,
      detail: "No Google Drive account connected",
    }
    : healthy > 0
    ? {
      badge: unhealthy > 0 ? "Degraded" : "Operational",
      tone: (unhealthy > 0 ? "warning" : "success") as Tone,
      detail: `${healthy} healthy · ${unhealthy} needing attention`,
    }
    : {
      badge: "Unavailable",
      tone: "danger" as Tone,
      detail: "No Drive account is currently usable — run a health check",
    };

  const telegramFailed = telegram?.FAILED ?? 0;
  const telegramQueued = (telegram?.PENDING ?? 0) + (telegram?.RETRYING ?? 0);
  const telegramState = counts.telegramConfigs === 0
    ? {
      badge: "Not configured",
      tone: "warning" as Tone,
      detail: "No Telegram destination configured",
    }
    : counts.telegramConfigsInvalid > 0
    ? {
      badge: counts.telegramConfigsInvalid === counts.telegramConfigs
        ? "Unavailable"
        : "Degraded",
      tone: (counts.telegramConfigsInvalid === counts.telegramConfigs
        ? "danger"
        : "warning") as Tone,
      detail: `${counts.telegramConfigsInvalid} of ${counts.telegramConfigs} destination(s) invalid`,
    }
    : telegramFailed > 0
    ? {
      badge: "Degraded",
      tone: "warning" as Tone,
      detail: `${telegramFailed} failed job(s) need attention`,
    }
    : {
      badge: "Operational",
      tone: "success" as Tone,
      detail: `${counts.telegramConfigsEnabled} enabled destination(s) · ${telegramQueued} queued`,
    };

  const accountsState = accounts.length === 0
    ? {
      badge: "None",
      tone: "warning" as Tone,
      detail: "No Drive account configured",
    }
    : healthy > 0
    ? {
      badge: `${accounts.length} configured`,
      tone: "success" as Tone,
      detail: `${healthy} eligible for routing · ${counts.jobsFailed} failed job(s) overall`,
    }
    : {
      badge: `${accounts.length} configured`,
      tone: "warning" as Tone,
      detail: `None eligible${drive && (drive.PENDING + drive.RETRYING) > 0
        ? ` · ${drive.PENDING + drive.RETRYING} Drive job(s) queued`
        : ""}`,
    };

  return [
    { label: "Supabase / backend", ...backend },
    { label: "Google Drive integration", ...driveIntegration },
    { label: "Telegram replication", ...telegramState },
    { label: "Configured Drive accounts", ...accountsState },
  ];
}
