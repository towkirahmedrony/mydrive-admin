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
}: {
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => startTransition(() => router.refresh())}
      className={
        className ??
        "inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      }
    >
      {isPending ? "Refreshing…" : label}
    </button>
  );
}
