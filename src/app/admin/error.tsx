"use client";

import { useEffect } from "react";

/**
 * Error boundary for the admin segment (Next.js App Router convention).
 *
 * The dashboard already degrades per query — this catches unexpected render or
 * data failures and offers the same retry behaviour instead of a blank page.
 * The message shown is the framework's digest-safe message, never credentials.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side detail is logged by the platform; keep the client log minimal.
    console.error("Admin page error:", error.message);
  }, [error]);

  return (
    <div className="bg-white shadow rounded-lg">
      <div className="px-4 py-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="text-2xl" aria-hidden>
            ⚠️
          </span>
          <div>
            <h1 className="text-lg font-semibold text-gray-900">
              This page could not be loaded
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              The request to the backend failed. This is usually temporary — try
              again, or check the Supabase project status if it persists.
            </p>
            <p className="mt-1 text-xs text-gray-400">
              This boundary covers every admin page, so the failing section may
              be the dashboard, an accounts page or a settings page.
            </p>
            {error.digest && (
              <p className="mt-2 text-xs text-gray-400">
                Reference: {error.digest}
              </p>
            )}
            <div className="mt-4 flex gap-3">
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center rounded-md bg-primary-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-primary-500 transition-colors"
              >
                Try again
              </button>
              <a
                href="/admin"
                className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 transition-colors"
              >
                Go to dashboard
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
