/**
 * Presentation mapping for the Users / Employee Maintain pages.
 *
 * Pure label/tone lookups with no I/O, so they are shared by the Server
 * Components and the client components without pulling anything server-only
 * into the browser bundle. Labels are the only place a raw database value is
 * translated into something an admin reads, which keeps the wording consistent
 * between the list, the detail page and the filters.
 */
import type { Tone } from "@/lib/format";
import type { DeviceRow, SyncState } from "@/lib/user-types";

/** `profiles.status` is constrained to active | suspended. */
export function accountStatusLabel(status: string | null | undefined): string {
  if (status === "active") return "Active";
  if (status === "suspended") return "Suspended";
  return status?.trim() ? status : "Unknown";
}

export function accountStatusTone(status: string | null | undefined): Tone {
  if (status === "active") return "success";
  if (status === "suspended") return "danger";
  return "neutral";
}

/** `devices.status` is constrained to active | disabled. */
export function deviceStatusLabel(status: string | null | undefined): string {
  if (status === "active") return "Active";
  if (status === "disabled") return "Disabled";
  return status?.trim() ? status : "Unknown";
}

export function deviceStatusTone(status: string | null | undefined): Tone {
  if (status === "active") return "success";
  if (status === "disabled") return "neutral";
  return "neutral";
}

export function syncStateLabel(state: SyncState): string {
  switch (state) {
    case "ok":
      return "Synced";
    case "backing_up":
      return "Backing up";
    case "failed":
      return "Backup failed";
    case "cancelled":
      return "Backup cancelled";
    default:
      return "No recent backup";
  }
}

export function syncStateTone(state: SyncState): Tone {
  switch (state) {
    case "ok":
      return "success";
    case "backing_up":
      return "info";
    case "failed":
      return "danger";
    case "cancelled":
      return "warning";
    default:
      return "neutral";
  }
}

/** `backup_sessions.status` is constrained to these four values. */
export function backupStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "RUNNING":
      return "Running";
    case "COMPLETED":
      return "Completed";
    case "FAILED":
      return "Failed";
    case "CANCELLED":
      return "Cancelled";
    default:
      return status?.trim() ? status : "Unknown";
  }
}

export function backupStatusTone(status: string | null | undefined): Tone {
  switch (status) {
    case "COMPLETED":
      return "success";
    case "RUNNING":
      return "info";
    case "FAILED":
      return "danger";
    case "CANCELLED":
      return "warning";
    default:
      return "neutral";
  }
}

/** Compact one-line device identity: model (or name) plus brand. */
export function deviceTitle(device: Pick<DeviceRow, "device_name" | "model" | "brand" | "device_uid">): string {
  const model = device.model?.trim() || device.device_name?.trim();
  if (model && device.brand?.trim()) return `${model} · ${device.brand.trim()}`;
  if (model) return model;
  if (device.brand?.trim()) return device.brand.trim();
  return device.device_uid?.trim() || "Unnamed device";
}

/** Android platform string, when the device reported one. */
export function devicePlatform(device: Pick<DeviceRow, "android_version">): string | null {
  const version = device.android_version?.trim();
  return version ? `Android ${version}` : null;
}

/** The two per-device policy flags that exist on `devices`. */
export function policyLabels(
  device: Pick<DeviceRow, "wifi_only_sync" | "auto_delete_after_backup">,
): string[] {
  const labels: string[] = [];
  if (device.wifi_only_sync) labels.push("Wi-Fi only sync");
  if (device.auto_delete_after_backup) labels.push("Auto-delete after backup");
  return labels;
}

/** Storage pressure tone; `null` means no usable quota is configured. */
export function storageTone(percent: number | null): Tone {
  if (percent === null) return "neutral";
  if (percent >= 90) return "danger";
  if (percent >= 70) return "warning";
  return "success";
}

/** Progress-bar colour, matching the media page's thresholds. */
export function storageBarClass(percent: number | null): string {
  if (percent === null) return "bg-gray-300";
  if (percent >= 90) return "bg-red-500";
  if (percent >= 70) return "bg-yellow-500";
  return "bg-primary-500";
}

/** `profiles.role` is constrained to admin | user. */
export function roleLabel(role: string | null | undefined): string {
  if (role === "admin") return "Admin";
  if (role === "user") return "Employee";
  return role?.trim() ? role : "Employee";
}

export function isAdminRole(role: string | null | undefined): boolean {
  return role === "admin";
}

/**
 * Tooltip text for the list's sync indicator, so the single compact glyph can
 * still explain itself: which device, when, and how many files.
 *
 * Structurally typed so it accepts both the employee-level roll-up
 * (`BackupSummary`) and a raw `backup_sessions` row.
 */
export function backupSummaryTitle(
  backup: {
    status?: string | null;
    device_name?: string | null;
    files_uploaded?: number | null;
    files_count?: number | null;
  } | null,
  fallback = "No backup session in the last 90 days",
): string {
  if (!backup) return fallback;
  const parts = [backupStatusLabel(backup.status)];
  if (backup.device_name?.trim()) parts.push(backup.device_name.trim());
  if (typeof backup.files_uploaded === "number" || typeof backup.files_count === "number") {
    parts.push(`${backup.files_uploaded ?? 0}/${backup.files_count ?? 0} files`);
  }
  return parts.join(" · ");
}


