/**
 * Per-user Google Drive folder resolution.
 *
 * Every application user gets a dedicated folder on whichever Drive account
 * actually stores their media:
 *
 *   Drive Account A / MyDrive Archive / <user> / ...
 *
 * If a user is later routed to another account (A full/unavailable), the same
 * resolver creates/binds their folder on account B and persists the new
 * mapping. The mapping lives in `drive_folders`, so the system never searches
 * or creates the same folder on every upload.
 *
 * Idempotency / concurrency:
 *   - `claim_drive_folder()` takes a transaction-scoped advisory lock per
 *     (account, owner, folder_type), then hands out a short creation lease.
 *   - only the lease holder calls the Drive API; everyone else reuses the
 *     stored mapping.
 *   - the `google_folder_id` is persisted before the lease is released, and
 *     the folder name is never used as the primary identity.
 */

import { getSupabaseAdmin } from "./auth.ts";
import {
  DriveFolderClient,
  getDriveAccessToken,
  GoogleDriveRestClient,
} from "./google-drive.ts";
import type { DriveAccount } from "./drive-router.ts";

type AdminClient = ReturnType<typeof getSupabaseAdmin>;

export interface DriveFolderRow {
  id: string;
  drive_account_id: string;
  parent_folder_id: string | null;
  owner_id: string | null;
  folder_name: string;
  google_folder_id: string | null;
  folder_type: string;
  folder_status: string;
  create_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClaimFolderResult {
  folder: DriveFolderRow;
  acquired: boolean;
}

export interface ResolveFolderOptions {
  folderName?: string;
  rootFolderName?: string;
  client?: DriveFolderClient;
}

/** Atomically finds/creates the mapping row and leases its Drive creation. */
export async function claimDriveFolder(
  admin: AdminClient,
  params: {
    driveAccountId: string;
    ownerId: string | null;
    folderName: string;
    folderType?: string;
    parentFolderId?: string | null;
  },
): Promise<ClaimFolderResult> {
  const { data, error } = await admin.rpc("claim_drive_folder", {
    p_drive_account_id: params.driveAccountId,
    p_owner_id: params.ownerId,
    p_folder_name: params.folderName,
    p_folder_type: params.folderType ?? "user",
    p_parent_folder_id: params.parentFolderId ?? null,
  });

  if (error) {
    throw new Error(`claim_drive_folder failed: ${error.message}`);
  }

  const rows = (data as ClaimFolderResult[] | null) ?? [];
  const first = rows[0];
  if (!first) {
    throw new Error("claim_drive_folder returned no row");
  }
  return first;
}

export async function completeDriveFolder(
  admin: AdminClient,
  folderRowId: string,
  googleFolderId: string,
): Promise<DriveFolderRow | null> {
  const { data, error } = await admin.rpc("complete_drive_folder", {
    p_folder_row_id: folderRowId,
    p_google_folder_id: googleFolderId,
  });
  if (error) {
    throw new Error(`complete_drive_folder failed: ${error.message}`);
  }
  return (data as DriveFolderRow | null) ?? null;
}

export async function failDriveFolder(
  admin: AdminClient,
  folderRowId: string,
  errorMessage: string,
): Promise<void> {
  const { error } = await admin.rpc("fail_drive_folder", {
    p_folder_row_id: folderRowId,
    p_error: errorMessage,
  });
  if (error) {
    throw new Error(`fail_drive_folder failed: ${error.message}`);
  }
}

/**
 * Resolves the archive root folder for a Drive account, creating it under the
 * account's My Drive on first use. Returns null while another process holds
 * the creation lease (caller should retry later).
 */
export async function ensureArchiveRootFolder(
  admin: AdminClient,
  account: Pick<DriveAccount, "id" | "display_name" | "root_folder_id">,
  options: ResolveFolderOptions = {},
): Promise<string | null> {
  if (account.root_folder_id) return account.root_folder_id;

  const client = options.client ?? new GoogleDriveRestClient();
  const name = options.rootFolderName ?? account.display_name ??
    "MyDrive Archive";

  const { folder, acquired } = await claimDriveFolder(admin, {
    driveAccountId: account.id,
    ownerId: null,
    folderName: name,
    folderType: "root",
    parentFolderId: null,
  });

  if (folder.google_folder_id) return folder.google_folder_id;
  if (!acquired) return null;

  try {
    const accessToken = await accessTokenForAccount(admin, account.id);
    const googleId = await client.ensureFolder(name, null, accessToken);
    await completeDriveFolder(admin, folder.id, googleId);

    const { error } = await admin
      .from("drive_accounts")
      .update({
        root_folder_id: googleId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", account.id);
    if (error) {
      throw new Error(`Failed to cache root_folder_id: ${error.message}`);
    }

    return googleId;
  } catch (err) {
    await failDriveFolder(admin, folder.id, (err as Error).message);
    throw err;
  }
}

/**
 * Resolves (or creates) the user's folder on a specific Drive account and
 * returns the persisted mapping. Returns null when the account's archive root
 * is not ready yet — retry on a later invocation.
 */
export async function resolveUserDriveFolder(
  admin: AdminClient,
  account: DriveAccount,
  userId: string,
  options: ResolveFolderOptions = {},
): Promise<DriveFolderRow | null> {
  const client = options.client ?? new GoogleDriveRestClient();

  const parentGoogleId = account.root_folder_id ??
    await ensureArchiveRootFolder(admin, account, options);
  if (!parentGoogleId) return null;

  const folderName = options.folderName ?? await userFolderName(admin, userId);

  const { folder, acquired } = await claimDriveFolder(admin, {
    driveAccountId: account.id,
    ownerId: userId,
    folderName,
    folderType: "user",
    parentFolderId: null,
  });

  // Already created (by us or a previous run).
  if (folder.google_folder_id) return folder;

  // Another process is creating it right now; reuse on a later attempt.
  if (!acquired) return folder;

  try {
    const accessToken = await accessTokenForAccount(admin, account.id);
    const googleId = await client.ensureFolder(
      folderName,
      parentGoogleId,
      accessToken,
    );
    const completed = await completeDriveFolder(admin, folder.id, googleId);
    return completed ?? folder;
  } catch (err) {
    await failDriveFolder(admin, folder.id, (err as Error).message);
    throw err;
  }
}

/** Exchanges the account's stored refresh token for a short-lived access token. */
export async function accessTokenForAccount(
  admin: AdminClient,
  driveAccountId: string,
): Promise<string> {
  const { data: account, error } = await admin
    .from("drive_accounts")
    .select("refresh_token_secret_id")
    .eq("id", driveAccountId)
    .maybeSingle();

  if (error) {
    throw new Error(`Drive account lookup failed: ${error.message}`);
  }
  const secretId =
    (account as { refresh_token_secret_id: string | null } | null)
      ?.refresh_token_secret_id;
  if (!secretId) {
    throw new Error("Drive account has no stored credentials");
  }

  const { data: refreshToken, error: tokenError } = await admin.rpc(
    "worker_lookup_drive_refresh_token",
    { p_secret_id: secretId, p_drive_account_id: driveAccountId },
  );
  if (tokenError) {
    throw new Error(`Drive refresh token lookup failed: ${tokenError.message}`);
  }
  if (!refreshToken) {
    throw new Error("Could not retrieve Drive refresh token from secret store");
  }

  const { accessToken } = await getDriveAccessToken({
    refreshToken: refreshToken as string,
  });
  return accessToken;
}

/** Human-friendly, Drive-safe folder name for a user (falls back to user id). */
async function userFolderName(
  admin: AdminClient,
  userId: string,
): Promise<string> {
  const { data } = await admin
    .from("profiles")
    .select("full_name")
    .eq("id", userId)
    .maybeSingle();

  const fullName = (data as { full_name: string | null } | null)?.full_name;
  const cleaned = (fullName ?? "").trim().replace(/[\/\\:*?"<>|]/g, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 100) : `user_${userId}`;
}
