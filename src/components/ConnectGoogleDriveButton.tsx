"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Browser-console diagnostic logging. Only safe, non-secret fields are ever
 * included: never tokens, JWTs, authorization headers, OAuth codes, cookies,
 * secrets, or full session/user objects.
 */
function logOAuthInitiate(
  level: "info" | "error",
  fields: Record<string, unknown>
): void {
  const line = `[GoogleDrive][oauth_initiate] ${JSON.stringify({
    scope: "GoogleDrive",
    operation: "oauth_initiate",
    timestamp: new Date().toISOString(),
    ...fields,
  })}`;
  if (level === "error") {
    console.error(line);
  } else {
    console.info(line);
  }
}

/** Safe error metadata for the console (name + message only). */
function safeErrorFields(error: unknown): Record<string, unknown> {
  return {
    errorName: (error as Error)?.name ?? null,
    errorMessage: (error as Error)?.message ?? null,
  };
}

/**
 * Reads the JSON error body returned by the Edge Function (if any) so the
 * admin sees the actionable server message. Never contains token material.
 */
async function extractServerError(error: unknown): Promise<string | null> {
  const context = (error as { context?: unknown } | null)?.context;
  if (context && typeof (context as Response).json === "function") {
    try {
      const body = await (context as Response).json();
      if (body && typeof body.error === "string" && body.error.trim()) {
        return body.error;
      }
    } catch {
      // Fall through to the generic message below.
    }
  }
  return null;
}

export default function ConnectGoogleDriveButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supabase = createClient();

  const handleConnect = async () => {
    setLoading(true);
    setError(null);
    logOAuthInitiate("info", { event: "initiation_started" });

    try {
      // Call the Edge Function to initiate Google OAuth.
      // The function verifies admin status server-side, generates a CSRF state,
      // stores it in the oauth_states table, and returns the Google authorization URL.
      const { data, error: invokeError } = await supabase.functions.invoke(
        "google-oauth-initiate",
        {
          body: {},
        }
      );

      if (invokeError) {
        const serverMessage = await extractServerError(invokeError);
        logOAuthInitiate("error", {
          event: "edge_function_failed",
          ...safeErrorFields(invokeError),
          hasServerMessage: Boolean(serverMessage),
        });
        if (serverMessage) {
          setError(serverMessage);
        } else if (invokeError.message?.includes("Admin privileges required")) {
          setError("Your account does not have administrator privileges.");
        } else if (
          invokeError.message?.includes("Authentication required") ||
          invokeError.message?.includes("Missing authorization")
        ) {
          setError("Please sign in again to connect Google Drive.");
        } else {
          setError("Failed to initiate Google Drive connection. Please try again.");
        }
        return;
      }

      if (data?.url) {
        // Redirect the browser to Google's OAuth consent screen.
        // After authorization, Google redirects back to the admin panel callback page.
        logOAuthInitiate("info", {
          event: "authorization_url_received",
          result: "success",
        });
        window.location.href = data.url;
      } else {
        logOAuthInitiate("error", {
          event: "authorization_url_received",
          result: "failure",
          reason: "missing_url_in_response",
        });
        setError("Failed to get OAuth URL from server. Please try again.");
      }
    } catch (err) {
      logOAuthInitiate("error", {
        event: "unexpected_exception",
        ...safeErrorFields(err),
      });
      setError("An unexpected error occurred. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button
        onClick={handleConnect}
        disabled={loading}
        className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? (
          <>
            <svg
              className="animate-spin -ml-1 mr-2 h-4 w-4 text-white"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            Connecting...
          </>
        ) : (
          <>
            <span className="mr-2">+</span>
            Connect Google Drive
          </>
        )}
      </button>
      {error && (
        <p className="mt-2 text-sm text-red-600">{error}</p>
      )}
    </div>
  );
}
