"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import ConnectGoogleDriveButton from "@/components/ConnectGoogleDriveButton";
import {
  accountHasVisibleError,
  accountNeedsReauth,
  humanizeDriveStatus,
  isAccountEnabled,
  summarizeDriveAccount,
  summaryBadgeClass,
} from "@/lib/drive-account-state";

/**
 * Edge Function that owns every Drive account read/write for the admin panel.
 * All mutations below go through it (admin-only, JWT verified server-side) —
 * the browser never touches the `drive_accounts` table directly and never
 * handles credential material.
 */
const DRIVE_ADMIN_FUNCTION = "drive-admin";

/**
 * Safe, server-stripped account projection returned by the `drive-admin`
 * function. Credential material and its vault reference are never part of this
 * payload, so they can never be rendered here.
 */
export interface DriveAccount {
  id: string;
  name: string | null;
  display_name: string | null;
  google_email: string | null;
  root_folder_id: string | null;
  priority: number | null;
  enabled: boolean | null;
  status: string | null;
  connection_status: string | null;
  health_status: string | null;
  storage_limit_bytes: number | null;
  storage_used_bytes: number | null;
  storage_available_bytes: number | null;
  reserved_bytes: number | null;
  last_quota_check_at: string | null;
  last_health_check_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Response of every `drive-admin` action used from the card. */
interface DriveAdminResponse {
  success?: boolean;
  error?: string | null;
  account?: DriveAccount | null;
  http_status?: number | null;
  safety_margin_bytes?: number | null;
  quota_available?: boolean | null;
}

interface DriveAccountCardProps {
  account: DriveAccount;
  /** From the page's `routing` call: may be undefined when unsupported. */
  eligible?: boolean;
  /** False when the routing call itself failed (indicator shows "unknown"). */
  routingAvailable?: boolean;
}

/**
 * Reads the JSON error body returned by the Edge Function (if any) so the admin
 * sees the actionable server message. Never contains token/header material.
 */
async function extractServerError(error: unknown): Promise<string | null> {
  const context = (error as { context?: unknown } | null)?.context;
  if (context && typeof (context as Response).json === "function") {
    try {
      const body = (await (context as Response).json()) as Record<
        string,
        unknown
      > | null;
      if (body && typeof body === "object") {
        for (const key of ["error", "message", "msg"] as const) {
          const value = body[key];
          if (typeof value === "string" && value.trim()) {
            return value;
          }
        }
      }
    } catch {
      // Non-JSON body: fall through to the SDK message.
    }
  }
  return (error as Error)?.message ?? null;
}

function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined) return null;
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

function humanize(value: string | null | undefined): string {
  return humanizeDriveStatus(value);
}

function getStatusColor(status: string | null): string {
  switch (status) {
    case "active":
      return "bg-green-100 text-green-800";
    case "quota_full":
      return "bg-yellow-100 text-yellow-800";
    case "reauth_required":
      return "bg-orange-100 text-orange-800";
    case "disabled":
      return "bg-gray-100 text-gray-800";
    case "error":
      return "bg-red-100 text-red-800";
    default:
      return "bg-gray-100 text-gray-800";
  }
}

function getConnectionColor(connection: string | null): string {
  switch (connection) {
    case "connected":
      return "bg-green-100 text-green-800";
    case "reauth_required":
      return "bg-orange-100 text-orange-800";
    case "disconnected":
      return "bg-gray-100 text-gray-800";
    case "error":
      return "bg-red-100 text-red-800";
    default:
      return "bg-gray-100 text-gray-800";
  }
}

function getHealthColor(health: string | null): string {
  switch (health) {
    case "healthy":
      return "bg-green-100 text-green-800";
    case "degraded":
      return "bg-yellow-100 text-yellow-800";
    case "quota_full":
      return "bg-yellow-100 text-yellow-800";
    case "unhealthy":
    case "error":
      return "bg-red-100 text-red-800";
    default:
      return "bg-gray-100 text-gray-800";
  }
}

const badgeBase =
  "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium";

export default function DriveAccountCard({
  account,
  eligible,
  routingAvailable = true,
}: DriveAccountCardProps) {
  const [pending, setPending] = useState<
    "enable" | "refresh" | "priority" | "disconnect" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [priorityInput, setPriorityInput] = useState<string>(
    account.priority === null || account.priority === undefined
      ? "0"
      : String(account.priority)
  );
  const router = useRouter();
  const supabase = createClient();

  // Keep the inline editor in sync with the server state after a refresh.
  useEffect(() => {
    setPriorityInput(
      account.priority === null || account.priority === undefined
        ? "0"
        : String(account.priority)
    );
  }, [account.priority]);

  const isBusy = pending !== null;

  /** Single entry point for every mutation: the drive-admin Edge Function. */
  const invokeDriveAdmin = async (
    body: Record<string, unknown>
  ): Promise<DriveAdminResponse | null> => {
    const { data, error: invokeError } = await supabase.functions.invoke(
      DRIVE_ADMIN_FUNCTION,
      { body }
    );

    if (invokeError) {
      const message = await extractServerError(invokeError);
      throw new Error(
        message ?? "The drive-admin service could not be reached."
      );
    }

    return (data as DriveAdminResponse | null) ?? null;
  };

  const handleToggleEnabled = async () => {
    const nextEnabled = account.enabled === false;
    setPending("enable");
    setError(null);
    setNotice(null);
    try {
      const result = await invokeDriveAdmin({
        action: "set_enabled",
        id: account.id,
        enabled: nextEnabled,
      });

      if (!result || result.success === false) {
        setError(
          result?.error ??
            "Failed to update the account. Please try again."
        );
        return;
      }

      router.refresh();
    } catch (err) {
      setError((err as Error)?.message ?? "An unexpected error occurred.");
    } finally {
      setPending(null);
    }
  };

  const handleRefreshHealth = async () => {
    setPending("refresh");
    setError(null);
    setNotice(null);
    try {
      const result = await invokeDriveAdmin({
        action: "refresh_health",
        id: account.id,
      });

      if (!result) {
        setError("Failed to refresh the account. Please try again.");
        return;
      }

      if (result.success === false) {
        // Non-fatal: the function still returns the account's real
        // post-check state, so the refreshed data is shown alongside the
        // server-reported reason.
        setNotice(
          `Health/quota check reported a problem: ${
            result.error ?? "unknown error"
          }`
        );
        router.refresh();
        return;
      }

      setNotice("Health and quota refreshed.");
      router.refresh();
    } catch (err) {
      setError((err as Error)?.message ?? "An unexpected error occurred.");
    } finally {
      setPending(null);
    }
  };

  const handlePrioritySubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = Number.parseInt(priorityInput, 10);

    if (!Number.isFinite(parsed)) {
      setError("Priority must be a whole number.");
      return;
    }

    setPending("priority");
    setError(null);
    setNotice(null);
    try {
      const result = await invokeDriveAdmin({
        action: "update",
        id: account.id,
        priority: parsed,
      });

      if (!result || result.success === false) {
        setError(
          result?.error ?? "Failed to update priority. Please try again."
        );
        return;
      }

      setNotice("Priority updated.");
      router.refresh();
    } catch (err) {
      setError((err as Error)?.message ?? "An unexpected error occurred.");
    } finally {
      setPending(null);
    }
  };

  const handleDisconnect = async () => {
    setPending("disconnect");
    setError(null);
    setNotice(null);
    try {
      const result = await invokeDriveAdmin({
        action: "set_enabled",
        id: account.id,
        enabled: false,
      });

      if (!result || result.success === false) {
        setError(
          result?.error ??
            "Failed to disconnect the account. Please try again."
        );
        return;
      }

      setConfirmDisconnect(false);
      setNotice(
        "Account disconnected from upload routing. Media, Drive files, Cloudinary objects and job history were not deleted."
      );
      router.refresh();
    } catch (err) {
      setError((err as Error)?.message ?? "An unexpected error occurred.");
    } finally {
      setPending(null);
    }
  };

  const limit = account.storage_limit_bytes;
  const used = account.storage_used_bytes;
  const free =
    account.storage_available_bytes ??
    (limit !== null && used !== null ? Math.max(limit - used, 0) : null);

  const usedPercent =
    limit !== null && limit > 0 && used !== null
      ? Math.round((used / limit) * 100)
      : null;

  const storageTotal = formatBytes(limit);
  const storageUsed = formatBytes(used);
  const storageFree = formatBytes(free);
  const reserved = formatBytes(account.reserved_bytes);
  const lastHealthCheck = formatTimestamp(account.last_health_check_at);
  const lastQuotaCheck = formatTimestamp(account.last_quota_check_at);
  const lastErrorAt = formatTimestamp(account.last_error_at);

  const isEnabled = isAccountEnabled(account);
  const needsReauth = accountNeedsReauth(account);
  const showLastError = accountHasVisibleError(account);
  const summary = summarizeDriveAccount(account);

  const displayName = account.display_name ?? account.name ?? "Unnamed account";

  const eligibleLabel =
    !routingAvailable || eligible === undefined
      ? "unknown"
      : eligible
      ? "yes"
      : "no";
  const eligibleColor =
    eligibleLabel === "yes"
      ? "bg-green-100 text-green-800"
      : eligibleLabel === "no"
      ? "bg-gray-100 text-gray-800"
      : "bg-gray-100 text-gray-500";

  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <div className="p-6">
        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
            {error}
          </div>
        )}

        {notice && (
          <div className="mb-4 bg-yellow-50 border border-yellow-200 text-yellow-800 px-3 py-2 rounded text-sm">
            {notice}
          </div>
        )}

        <div className="flex items-start justify-between">
          <div className="flex items-center space-x-3">
            <div className="flex-shrink-0">
              <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center">
                <span className="text-xl">☁️</span>
              </div>
            </div>
            <div>
              <h3 className="text-lg font-medium text-gray-900">
                {displayName}
              </h3>
              <p className="text-sm text-gray-500">
                {account.google_email ?? "No Google account email on file"}
              </p>
            </div>
          </div>
          <span className={`${badgeBase} ${summaryBadgeClass(summary.key)}`}>
            {summary.label}
          </span>
        </div>

        {/* Badges: backend status, connection, health, eligibility */}
        <div className="mt-4 flex flex-wrap gap-2">
          <span className={`${badgeBase} ${getStatusColor(account.status)}`}>
            Status: {humanize(account.status)}
          </span>
          <span
            className={`${badgeBase} ${
              isEnabled
                ? "bg-green-100 text-green-800"
                : "bg-gray-100 text-gray-800"
            }`}
          >
            {isEnabled ? "Enabled" : "Disabled"}
          </span>
          <span
            className={`${badgeBase} ${getConnectionColor(
              account.connection_status
            )}`}
          >
            Connection: {humanize(account.connection_status)}
          </span>
          <span
            className={`${badgeBase} ${getHealthColor(account.health_status)}`}
          >
            Health: {humanize(account.health_status)}
          </span>
          <span className={`${badgeBase} ${eligibleColor}`}>
            Eligible for new uploads: {eligibleLabel}
          </span>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4">
          <div>
            <dt className="text-sm text-gray-500">Storage Total</dt>
            <dd className="mt-1 text-sm text-gray-900">
              {storageTotal ?? (
                <span className="text-gray-400">Not synced yet</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500">Storage Used</dt>
            <dd className="mt-1 text-sm text-gray-900">
              {storageUsed ?? (
                <span className="text-gray-400">Not synced yet</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500">Storage Free</dt>
            <dd className="mt-1 text-sm text-gray-900">
              {storageFree ?? (
                <span className="text-gray-400">Not synced yet</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500">Connected</dt>
            <dd className="mt-1 text-sm text-gray-900">
              {formatTimestamp(account.created_at) ?? (
                <span className="text-gray-400">Unknown</span>
              )}
            </dd>
          </div>
          {account.reserved_bytes ? (
            <div>
              <dt className="text-sm text-gray-500">Reserved</dt>
              <dd className="mt-1 text-sm text-gray-900">{reserved}</dd>
            </div>
          ) : null}
        </div>

        {storageTotal && usedPercent !== null && (
          <div className="mt-4">
            <div className="flex items-center justify-between text-sm text-gray-500 mb-1">
              <span>Storage Usage</span>
              <span>
                {usedPercent}% of {storageTotal}
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className={`h-2 rounded-full ${
                  usedPercent > 90
                    ? "bg-red-500"
                    : usedPercent > 75
                    ? "bg-yellow-500"
                    : "bg-green-500"
                }`}
                style={{ width: `${Math.min(usedPercent, 100)}%` }}
              />
            </div>
          </div>
        )}

        <div className="mt-4 grid grid-cols-1 gap-2 text-xs text-gray-400">
          <div>
            Last health check:{" "}
            {lastHealthCheck ?? <span className="text-gray-400">Never</span>}
          </div>
          <div>
            Last quota refresh:{" "}
            {lastQuotaCheck ?? <span className="text-gray-400">Never</span>}
          </div>
          {account.root_folder_id && (
            <div>
              Root folder:{" "}
              <code className="bg-gray-50 px-1 rounded">
                {account.root_folder_id}
              </code>
            </div>
          )}
        </div>

        {showLastError && account.last_error && (
          <div className="mt-4 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-xs">
            <div className="font-medium">Last error</div>
            <div className="mt-0.5 break-words">{account.last_error}</div>
            {lastErrorAt && <div className="mt-1 text-red-500">{lastErrorAt}</div>}
          </div>
        )}

        {needsReauth && (
          <div className="mt-4 border border-orange-200 bg-orange-50 rounded p-3">
            <p className="text-sm font-medium text-orange-900">
              Re-authentication required
            </p>
            <p className="text-sm text-orange-800 mt-1 mb-3">
              This account cannot be used for new uploads until Google
              authorization is completed again
              {account.google_email ? ` for ${account.google_email}` : ""}.
              Re-authenticate updates this existing account; it does not create
              a second Drive account.
            </p>
            <ConnectGoogleDriveButton
              mode="reauthenticate"
              googleEmail={account.google_email}
              compact
              disabled={isBusy}
            />
          </div>
        )}
      </div>

      <div className="bg-gray-50 px-6 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            onClick={handleToggleEnabled}
            disabled={isBusy}
            className={`text-sm disabled:opacity-50 transition-colors ${
              isEnabled
                ? "text-gray-600 hover:text-gray-900"
                : "text-primary-600 hover:text-primary-800"
            }`}
          >
            {pending === "enable"
              ? "Saving..."
              : isEnabled
              ? "Disable"
              : "Enable"}
          </button>

          <button
            onClick={handleRefreshHealth}
            disabled={isBusy}
            className="text-sm text-primary-600 hover:text-primary-800 disabled:opacity-50 transition-colors"
          >
            {pending === "refresh" ? "Refreshing..." : "Refresh health / quota"}
          </button>

          {!needsReauth && (
            <ConnectGoogleDriveButton
              mode="reauthenticate"
              googleEmail={account.google_email}
              variant="link"
              disabled={isBusy}
            />
          )}

          <form
            onSubmit={handlePrioritySubmit}
            className="flex items-center gap-2"
          >
            <label
              htmlFor={`priority-${account.id}`}
              className="text-sm text-gray-500"
            >
              Priority
            </label>
            <input
              id={`priority-${account.id}`}
              type="number"
              inputMode="numeric"
              value={priorityInput}
              onChange={(event) => setPriorityInput(event.target.value)}
              disabled={isBusy}
              className="w-16 border border-gray-300 rounded px-2 py-1 text-sm text-gray-900 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={isBusy}
              className="text-sm text-primary-600 hover:text-primary-800 disabled:opacity-50 transition-colors"
            >
              {pending === "priority" ? "Saving..." : "Save"}
            </button>
          </form>
        </div>

        {isEnabled && !confirmDisconnect && (
          <button
            type="button"
            onClick={() => setConfirmDisconnect(true)}
            disabled={isBusy}
            className="text-sm text-red-600 hover:text-red-800 disabled:opacity-50 transition-colors"
          >
            Disconnect
          </button>
        )}

        {confirmDisconnect && (
          <div className="border border-red-200 bg-red-50 rounded p-3 space-y-2">
            <p className="text-sm font-medium text-red-900">
              Disconnect this Drive account?
            </p>
            <p className="text-xs text-red-800">
              This disables the account and removes it from upload routing. It
              does not delete media assets, replication jobs, Google Drive
              files, Cloudinary media, or archive metadata. Active jobs keep
              their history; the existing router/failover will skip this
              account until it is enabled again.
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleDisconnect}
                disabled={isBusy}
                className="text-sm font-medium text-white bg-red-600 hover:bg-red-700 px-3 py-1.5 rounded disabled:opacity-50"
              >
                {pending === "disconnect"
                  ? "Disconnecting..."
                  : "Confirm disconnect"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDisconnect(false)}
                disabled={isBusy}
                className="text-sm text-gray-700 hover:text-gray-900 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <p className="text-xs text-gray-500">
          Disconnect/Disable only removes this account from upload routing.
          Nothing is deleted — already-archived files, folder mappings and job
          history are always kept. Use Connect Google Drive to add a different
          Google account.
        </p>
      </div>
    </div>
  );
}
