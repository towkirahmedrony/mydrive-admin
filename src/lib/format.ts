/**
 * Server-safe display formatting helpers for the admin dashboard.
 *
 * Deliberately free of any Supabase / credential access so it can be imported
 * from a Server Component without pulling client-only code into the render.
 */

/** Status tone vocabulary shared by the dashboard UI components. */
export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

/** Bytes -> human readable string. Accepts bigint-as-string from PostgREST. */
export function formatBytes(
  bytes: number | string | null | undefined,
): string | null {
  if (bytes === null || bytes === undefined || bytes === "") return null;
  const value = typeof bytes === "string" ? Number(bytes) : bytes;
  if (!Number.isFinite(value)) return null;
  if (value === 0) return "0 B";

  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(
    Math.floor(Math.log(Math.abs(value)) / Math.log(1024)),
    sizes.length - 1,
  );
  const scaled = value / Math.pow(1024, index);
  return `${scaled.toFixed(scaled >= 100 || index === 0 ? 0 : 1)} ${sizes[index]}`;
}

/** Timestamp -> short, stable label. Null-safe. */
export function formatTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/** Timestamp -> "3m ago" style label for activity lists. */
export function formatRelative(
  value: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (seconds < 0) return formatTimestamp(value);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatTimestamp(value);
}

/**
 * Percentage of a total, clamped to 0-100. Returns null when the total is
 * unknown/zero so callers can render "—" instead of a misleading 100%.
 */
export function usagePercent(
  used: number | string | null | undefined,
  total: number | string | null | undefined,
): number | null {
  const u = typeof used === "string" ? Number(used) : used;
  const t = typeof total === "string" ? Number(total) : total;
  if (!Number.isFinite(u) || !Number.isFinite(t) || !t || t <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((u! / t!) * 100)));
}
