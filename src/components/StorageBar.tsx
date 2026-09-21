import { storageBarClass } from "@/lib/user-display";

/**
 * Compact storage-usage bar for `profiles.storage_used_bytes` /
 * `storage_quota_bytes`.
 *
 * A single shared bar keeps the pressure thresholds in one place (see
 * `storageBarClass`) so the list and the employee detail page cannot drift.
 * When no usable quota is configured nothing is filled and the bar is neutral —
 * it never implies a percentage the data does not support.
 */
export default function StorageBar({
  percent,
  width = "w-full",
  className,
}: {
  percent: number | null;
  width?: string;
  className?: string;
}) {
  const filled = percent === null ? 0 : Math.max(0, Math.min(100, percent));

  return (
    <div
      className={`h-1.5 overflow-hidden rounded-full bg-gray-100 ${width} ${className ?? ""}`}
      role="img"
      aria-label={
        percent === null
          ? "Storage quota not configured"
          : `${percent}% of storage quota used`
      }
    >
      <div
        className={`h-full rounded-full ${storageBarClass(percent)}`}
        style={{ width: `${filled}%` }}
      />
    </div>
  );
}
