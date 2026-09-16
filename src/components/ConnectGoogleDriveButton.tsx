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
 * Safe, non-secret description of a failed Edge Function invocation.
 *
 * Reads the JSON error body (function errors use `error`; the Supabase gateway
 * uses `message`/`msg`/`code`) so a real cause is never masked by the generic
 * client message. Never reads or returns token/header material.
 */
interface InvokeErrorInfo {
  message: string | null;
  status: number | null;
  code: string | number | null;
  name: string | null;
}

async function describeInvokeError(error: unknown): Promise<InvokeErrorInfo> {
  const name = (error as Error)?.name ?? null;
  const context = (error as { context?: unknown } | null)?.context;

  let status: number | null = null;
  if (context && typeof (context as Response).status === "number") {
    status = (context as Response).status;
  }

  let message: string | null = null;
  let code: string | number | null = null;

  if (context && typeof (context as Response).json === "function") {
    try {
      const body = (await (context as Response).json()) as Record<
        string,
        unknown
      > | null;
      if (body && typeof body === "object") {
        for (const key of ["error", "message", "msg"] as const) {
          const value = body[key];
          if (typeof value === "string" && value.trim()) {
            message = value;
            break;
          }
        }
        const rawCode = body.code;
        if (typeof rawCode === "string" || typeof rawCode === "number") {
          code = rawCode;
        }
      }
    } catch {
      // Non-JSON body: fall through with the fields gathered so far.
    }
  }

  return { message, status, code, name };
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
      // Record whether a user session exists (a boolean only — never the token)
      // so an auth/session problem is visible without exposing credentials.
      const {
        data: { session },
      } = await supabase.auth.getSession();

      // Call the Edge Function to initiate Google OAuth.
      // The function verifies admin status server-side, generates a CSRF state,
      // stores it in the oauth_states table, and returns the Google authorization URL.
      const FUNCTION_NAME = "google-oauth-initiate";
      logOAuthInitiate("info", {
        event: "functions_invoke_attempt",
        functionName: FUNCTION_NAME,
        hasSession: Boolean(session),
      });

      const { data, error: invokeError } = await supabase.functions.invoke(
        FUNCTION_NAME,
        {
          body: {},
        }
      );

      if (invokeError) {
        const info = await describeInvokeError(invokeError);
        logOAuthInitiate("error", {
          event: "edge_function_failed",
          functionName: FUNCTION_NAME,
          ...safeErrorFields(invokeError),
          httpStatus: info.status,
          errorCode: info.code,
          hasServerMessage: Boolean(info.message),
        });

        if (info.message) {
          setError(info.message);
        } else if (
          invokeError.message?.includes("Admin privileges required")
        ) {
          setError("Your account does not have administrator privileges.");
        } else if (
          invokeError.message?.includes("Authentication required") ||
          invokeError.message?.includes("Missing authorization")
        ) {
          setError("Please sign in again to connect Google Drive.");
        } else if (info.status === 404) {
          setError(
            "The Google Drive connection service is unavailable (Edge Function not found or not deployed)."
          );
        } else if (info.status === 401 || info.status === 403) {
          setError("Please sign in again to connect Google Drive.");
        } else if (
          invokeError.message?.includes("Failed to send a request")
        ) {
          setError(
            "Could not reach the Google Drive connection service. Please check your connection and try again."
          );
        } else {
          setError(
            `Failed to initiate Google Drive connection${
              info.status ? ` (HTTP ${info.status})` : ""
            }. Please try again.`
          );
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
