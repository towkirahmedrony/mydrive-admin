/**
 * Display helpers for Admin Google Drive account rows.
 *
 * Labels are derived only from fields the `drive-admin` list payload already
 * returns. No client-side health check is performed here.
 */

export interface DriveAccountStateFields {
  status: string | null;
  connection_status: string | null;
  health_status: string | null;
  enabled: boolean | null;
  last_error: string | null;
}

export type DriveAccountSummaryKey =
  | "disabled"
  | "reauth_required"
  | "unhealthy"
  | "error"
  | "quota_full"
  | "connected_healthy"
  | "degraded"
  | "unknown";

export interface DriveAccountSummary {
  key: DriveAccountSummaryKey;
  label: string;
}

export function isAccountEnabled(account: DriveAccountStateFields): boolean {
  return account.enabled !== false && account.status !== "disabled";
}

/**
 * True when the backend says this account cannot be used until the admin
 * completes Google authorization again.
 */
export function accountNeedsReauth(account: DriveAccountStateFields): boolean {
  return (
    account.status === "reauth_required" ||
    account.health_status === "unhealthy" ||
    account.connection_status === "reauth_required" ||
    account.connection_status === "disconnected" ||
    account.connection_status === "error"
  );
}

export function accountHasVisibleError(
  account: DriveAccountStateFields,
): boolean {
  return (
    Boolean(account.last_error) &&
    (accountNeedsReauth(account) ||
      account.status === "error" ||
      account.health_status === "unhealthy" ||
      account.health_status === "degraded")
  );
}

export function summarizeDriveAccount(
  account: DriveAccountStateFields,
): DriveAccountSummary {
  if (!isAccountEnabled(account)) {
    return { key: "disabled", label: "Disabled" };
  }
  if (
    account.status === "reauth_required" ||
    account.connection_status === "reauth_required"
  ) {
    return { key: "reauth_required", label: "Re-authentication required" };
  }
  if (account.health_status === "unhealthy") {
    return { key: "unhealthy", label: "Unhealthy" };
  }
  if (
    account.status === "error" ||
    account.connection_status === "error"
  ) {
    return { key: "error", label: "Error" };
  }
  if (
    account.status === "quota_full" ||
    account.health_status === "quota_full"
  ) {
    return { key: "quota_full", label: "Quota full" };
  }
  if (
    account.status === "active" &&
    account.health_status === "healthy" &&
    (account.connection_status === "connected" ||
      account.connection_status === "unknown")
  ) {
    return { key: "connected_healthy", label: "Connected / Healthy" };
  }
  if (account.health_status === "degraded") {
    return { key: "degraded", label: "Degraded" };
  }
  return { key: "unknown", label: humanizeDriveStatus(account.status) };
}

export function humanizeDriveStatus(value: string | null | undefined): string {
  if (!value) return "Unknown";
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function summaryBadgeClass(key: DriveAccountSummaryKey): string {
  switch (key) {
    case "connected_healthy":
      return "bg-green-100 text-green-800";
    case "quota_full":
    case "degraded":
      return "bg-yellow-100 text-yellow-800";
    case "reauth_required":
      return "bg-orange-100 text-orange-800";
    case "unhealthy":
    case "error":
      return "bg-red-100 text-red-800";
    case "disabled":
    case "unknown":
    default:
      return "bg-gray-100 text-gray-800";
  }
}
