/**
 * Pure display helpers for a media asset.
 *
 * Shared by the media grid/list (`media-browser.tsx`) and by the viewer's
 * information panel so the same field is never formatted two different ways.
 * No Supabase / credential access lives here, so it is safe in client bundles.
 */
import type { Tone } from "@/lib/format";
import { mediaDevice, type MediaAsset, type MediaKindName } from "@/lib/media-types";

export function jobTone(status: string | undefined): Tone {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED") return "danger";
  if (status) return "warning";
  return "neutral";
}

export function cleanupTone(status: string | null | undefined): Tone {
  if (status === "cleanup_success") return "success";
  if (status === "cleanup_failed") return "danger";
  if (status === "cleanup_pending" || status === "cleanup_processing") return "warning";
  return "neutral";
}

export function cleanupLabel(status: string | null | undefined): string {
  switch (status) {
    case "cleanup_pending":
      return "Cleanup pending";
    case "cleanup_processing":
      return "Cleanup processing";
    case "cleanup_success":
      return "Cleanup success";
    case "cleanup_failed":
      return "Cleanup failed";
    default:
      return "Cleanup none";
  }
}

export function archiveLabel(media: MediaAsset): string {
  return media.drive_archived_at ? "Drive verified" : "Not archived";
}

export function deviceLabel(media: MediaAsset): string {
  const device = mediaDevice(media);
  if (!device) return "Unknown device";
  return (
    device.device_name ||
    [device.brand, device.model].filter(Boolean).join(" ") ||
    "Unnamed device"
  );
}

/** Duration in milliseconds -> compact label. */
export function durationLabel(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!n || !Number.isFinite(n)) return "—";
  const totalSeconds = Math.round(n / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Human label for the media kind derived from `media_assets.mime_type`. */
export function kindLabel(kind: MediaKindName): string {
  switch (kind) {
    case "image":
      return "Photo";
    case "video":
      return "Video";
    default:
      return "Other file";
  }
}
