/**
 * Drive Router — server-side selection of a Google Drive archive account.
 *
 * The router works over the `drive_accounts` table, so it scales to ANY number
 * of accounts: there is deliberately no hardcoded account list or fixed
 * account order. Selection considers:
 *
 *   - enabled / disabled
 *   - OAuth connection status and health
 *   - remaining quota vs the required bytes
 *   - the configured safety margin (app_settings.drive_safety_margin_bytes)
 *   - per-account priority (lower number wins)
 *
 * When the preferred account is full, disconnected or unhealthy, callers pass
 * the accounts already tried via `excludeAccountIds` and the router returns
 * the next eligible account — this is the failover primitive.
 *
 * This module only plans/assigns; it never uploads media.
 */

import { getSupabaseAdmin } from "./auth.ts";

type AdminClient = ReturnType<typeof getSupabaseAdmin>;

export interface DriveAccount {
  id: string;
  name: string;
  display_name: string | null;
  google_email: string | null;
  root_folder_id: string | null;
  priority: number;
  enabled: boolean;
  status: string;
  connection_status: string;
  health_status: string;
  storage_limit_bytes: number | null;
  storage_used_bytes: number | null;
  storage_available_bytes: number | null;
  reserved_bytes: number;
  last_quota_check_at: string | null;
  last_error: string | null;
}

export interface RouteOptions {
  /** Size of the file to be stored, in bytes. */
  requiredBytes?: number;
  /** Accounts that must not be chosen (already tried / known bad). */
  excludeAccountIds?: string[];
  /** Overrides app_settings.drive_safety_margin_bytes when provided. */
  safetyMarginBytes?: number | null;
}

function rpcArgs(options: RouteOptions) {
  return {
    p_required_bytes: Math.max(options.requiredBytes ?? 0, 0),
    p_exclude_account_ids: options.excludeAccountIds ?? [],
    p_safety_margin_bytes: options.safetyMarginBytes ?? null,
  };
}

/** Every account that can currently accept the file, in routing order. */
export async function listEligibleDriveAccounts(
  admin: AdminClient,
  options: RouteOptions = {},
): Promise<DriveAccount[]> {
  const { data, error } = await admin.rpc(
    "list_eligible_drive_accounts",
    rpcArgs(options),
  );
  if (error) {
    throw new Error(`list_eligible_drive_accounts failed: ${error.message}`);
  }
  return (data as DriveAccount[] | null) ?? [];
}

/** The single best eligible account (read-only; does not reserve quota). */
export async function selectDriveAccount(
  admin: AdminClient,
  options: RouteOptions = {},
): Promise<DriveAccount | null> {
  const { data, error } = await admin.rpc(
    "select_drive_account",
    rpcArgs(options),
  );
  if (error) {
    throw new Error(`select_drive_account failed: ${error.message}`);
  }
  return asAccountOrNull(data);
}

/**
 * Atomically selects the best eligible account and reserves its quota. This is
 * the call the worker should use before uploading: concurrent workers cannot
 * reserve the same capacity twice.
 */
export async function reserveDriveAccount(
  admin: AdminClient,
  options: RouteOptions = {},
): Promise<DriveAccount | null> {
  const { data, error } = await admin.rpc(
    "reserve_drive_account",
    rpcArgs(options),
  );
  if (error) {
    throw new Error(`reserve_drive_account failed: ${error.message}`);
  }
  return asAccountOrNull(data);
}

/**
 * A NULL composite from PostgREST arrives as an object whose fields are all
 * null (not as null), so id presence decides whether an account was selected.
 */
function asAccountOrNull(data: unknown): DriveAccount | null {
  const row = data as DriveAccount | null;
  return row && row.id ? row : null;
}

/** Reverses a reservation when the worker abandons an account. */
export async function releaseDriveQuota(
  admin: AdminClient,
  driveAccountId: string,
  bytes: number,
): Promise<void> {
  const { error } = await admin.rpc("release_drive_quota", {
    p_drive_account_id: driveAccountId,
    p_bytes: Math.max(bytes, 0),
  });
  if (error) {
    throw new Error(`release_drive_quota failed: ${error.message}`);
  }
}

/** Health/status feedback so the router stops choosing broken accounts. */
export async function markDriveAccountResult(
  admin: AdminClient,
  driveAccountId: string,
  result: {
    healthStatus?: "healthy" | "degraded" | "unhealthy" | "unknown";
    status?: "active" | "quota_full" | "reauth_required" | "disabled" | "error";
    lastError?: string | null;
  },
): Promise<void> {
  const { error } = await admin.rpc("mark_drive_account_result", {
    p_drive_account_id: driveAccountId,
    p_health_status: result.healthStatus ?? null,
    p_status: result.status ?? null,
    p_last_error: result.lastError ?? null,
  });
  if (error) {
    throw new Error(`mark_drive_account_result failed: ${error.message}`);
  }
}

/**
 * Picks the next account for a Drive job, excluding every account the job has
 * already failed on. Reads the exclusion list from the job row itself, so
 * failover state survives across worker invocations.
 */
export async function planNextDriveAccount(
  admin: AdminClient,
  jobId: string,
  options: RouteOptions = {},
): Promise<{
  account: DriveAccount | null;
  excludedAccountIds: string[];
}> {
  const { data: job, error } = await admin
    .from("replication_jobs")
    .select("id, failed_drive_account_ids")
    .eq("id", jobId)
    .maybeSingle();

  if (error) {
    throw new Error(`Drive job lookup failed: ${error.message}`);
  }
  if (!job) {
    throw new Error(`Drive job ${jobId} not found`);
  }

  const previouslyFailed = (job.failed_drive_account_ids as string[] | null) ??
    [];
  const excludedAccountIds = Array.from(
    new Set([...previouslyFailed, ...(options.excludeAccountIds ?? [])]),
  );

  const account = await reserveDriveAccount(admin, {
    ...options,
    excludeAccountIds: excludedAccountIds,
  });

  return { account, excludedAccountIds };
}

/** Persists the router's choice onto the job (see assign_drive_replication_job). */
export async function assignDriveAccountToJob(
  admin: AdminClient,
  jobId: string,
  driveAccountId: string,
  driveFolderId: string | null = null,
): Promise<void> {
  const { error } = await admin.rpc("assign_drive_replication_job", {
    p_job_id: jobId,
    p_drive_account_id: driveAccountId,
    p_drive_folder_id: driveFolderId,
  });
  if (error) {
    throw new Error(`assign_drive_replication_job failed: ${error.message}`);
  }
}

/**
 * Gives up on the current account and requeues the SAME job for another one.
 * The next planNextDriveAccount() call will skip every account in
 * failed_drive_account_ids.
 */
export async function failoverDriveJob(
  admin: AdminClient,
  jobId: string,
  failedAccountId: string,
  errorMessage: string | null,
  nextRetryAt?: string,
): Promise<void> {
  const { error } = await admin.rpc("failover_drive_replication_job", {
    p_job_id: jobId,
    p_failed_account_id: failedAccountId,
    p_error: errorMessage,
    p_next_retry_at: nextRetryAt ?? null,
  });
  if (error) {
    throw new Error(`failover_drive_replication_job failed: ${error.message}`);
  }
}
