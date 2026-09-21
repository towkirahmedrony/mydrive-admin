"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-runs the dashboard server render (fresh aggregate queries).
 * Uses the same router.refresh() pattern as the rest of the panel.
 */
export default function RefreshButton({
  label = "Refresh",
  className,
  iconOnly = false,
}: {
  label?: string;
  className?: string;
  iconOnly?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={isPending}
      aria-label={label}
      title={label}
      onClick={() => startTransition(() => router.refresh())}
      className={
        className ??
        (iconOnly
          ? "inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 shadow-sm transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          : "inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50")
      }
    >
      {iconOnly ? (
        <svg viewBox="0 0 24 24" className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M20 11a8.1 8.1 0 0 0-14.9-3M4 5v4h4M4 13a8.1 8.1 0 0 0 14.9 3M20 19v-4h-4" />
        </svg>
      ) : isPending ? (
        "Refreshing…"
      ) : (
        label
      )}
    </button>
  );
}
