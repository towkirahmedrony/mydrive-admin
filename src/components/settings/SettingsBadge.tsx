/**
 * Tiny status badge for inline settings status display.
 *
 * Slightly smaller than the main `StatusBadge` component, designed for
 * the compact settings row layout.
 */

import type { Tone } from "@/lib/format";

const TONE_CLASSES: Record<Tone, string> = {
  success: "bg-green-50 text-green-700 ring-green-600/20",
  warning: "bg-yellow-50 text-yellow-700 ring-yellow-600/20",
  danger: "bg-red-50 text-red-700 ring-red-600/20",
  info: "bg-primary-50 text-primary-700 ring-primary-600/20",
  neutral: "bg-gray-50 text-gray-600 ring-gray-500/20",
};

export default function SettingsBadge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: Tone;
}) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ring-1 ring-inset whitespace-nowrap ${TONE_CLASSES[tone]}`}
    >
      {label}
    </span>
  );
}
