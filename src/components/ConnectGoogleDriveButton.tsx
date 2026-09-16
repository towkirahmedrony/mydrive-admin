"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/** Name of the Edge Function that starts the Google OAuth flow. */
const FUNCTION_NAME = "google-oauth-initiate";

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

/**
 * Resolves the exact URL `supabase.functions.invoke` will request.
 *
 * Mirrors the SDK's own derivation (SupabaseClient builds
 * `new URL("functions/v1", supabaseUrl)`, then FunctionsClient appends the
 * function name) so the logged endpoint is provably the one that was called.
 * Contains only the public project URL and the function name — no key, no
 * token, no secret.
 */
function resolveInvokeEndpoint(): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return null;
  try {
    const functionsUrl = new URL("functions/v1", base);
    return new URL(`${functionsUrl.href}/${FUNCTION_NAME}`).href;
  } catch {
    return null;
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
 * `error.context` is a `Response` for HTTP/relay errors (so the platform or
 * function JSON body can be read) and the raw fetch error for transport
 * failures, where no status is available at all. Function errors use `error`;
 * the Supabase platform uses `code` + `message` (e.g. `NOT_FOUND`,
 * `NOT_FOUND_FUNCTION_BLOB`, `BOOT_ERROR`).
 *
 * Never reads or returns token/header material.
 */
interface InvokeErrorInfo {
  /** SDK error class name: FunctionsFetchError | FunctionsHttpError | FunctionsRelayError. */
  name: string | null;
  /** Message produced by the SDK itself. */
  sdkMessage: string | null;
  /** HTTP status, or null when no readable response was received. */
  httpStatus: number | null;
  /** Platform/function error code from the response body. */
  serverCode: string | number | null;
  /** Platform/function error message from the response body. */
  serverMessage: string | null;
}

/**
 * Turns a failed invocation into a single, actionable failure class so the
 * console and the UI never flatten distinct causes into "check your connection".
 */
type FailureClass =
  | "server_rejected"
  | "authentication"
  | "authorization"
  | "function_not_deployed"
  | "function_boot_error"
  | "endpoint_unreachable"
  | "unknown";

async function describeInvokeError(error: unknown): Promise<InvokeErrorInfo> {
  const name = (error as Error)?.name ?? null;
  const sdkMessage = (error as Error)?.message ?? null;
  const context = (error as { context?: unknown } | null)?.context;

  let httpStatus: number | null = null;
  if (context && typeof (context as Response).status === "number") {
    httpStatus = (context as Response).status;
  }

  let serverMessage: string | null = null;
  let serverCode: string | number | null = null;

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
            serverMessage = value;
            break;
          }
        }
        const rawCode = body.code;
        if (typeof rawCode === "string" || typeof rawCode === "number") {
          serverCode = rawCode;
        }
      }
    } catch {
      // Non-JSON body: fall through with the fields gathered so far.
    }
  }

  return { name, sdkMessage, httpStatus, serverCode, serverMessage };
}

/**
 * Classifies a failed invocation using both the SDK error and the server body.
 *
 * The `endpoint_unreachable` class is the important one: Supabase documents
 * that the browser cannot observe platform 404s (the function name is not
 * recognised, or its deployed bundle is missing) or boot-time 503s — browsers
 * report them as CORS failures and the SDK collapses them into
 * "Failed to send a request to the Edge Function". It is therefore NOT
 * evidence of a client network problem.
 */
function classifyInvokeFailure(info: InvokeErrorInfo): FailureClass {
  const text = `${info.sdkMessage ?? ""} ${info.serverMessage ?? ""}`.toLowerCase();
  const code = String(info.serverCode ?? "").toUpperCase();

  if (code === "NOT_FOUND" || code === "NOT_FOUND_FUNCTION_BLOB") {
    return "function_not_deployed";
  }
  if (code === "BOOT_ERROR") {
    return "function_boot_error";
  }
  if (text.includes("admin privileges required")) {
    return "authorization";
  }
  if (
    text.includes("authentication required") ||
    text.includes("missing authorization") ||
    text.includes("invalid or expired token")
  ) {
    return "authentication";
  }
  // A server body was readable, so the endpoint was reached and rejected us.
  if (info.serverMessage) {
    return "server_rejected";
  }
  if (info.httpStatus === 404) {
    return "function_not_deployed";
  }
  if (info.httpStatus === 401 || info.httpStatus === 403) {
    return "authentication";
  }
  if (info.httpStatus === 503) {
    return "function_boot_error";
  }
  if (info.name === "FunctionsFetchError") {
    return "endpoint_unreachable";
  }
  return "unknown";
}

export default function ConnectGoogleDriveButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supabase = createClient();

  const handleConnect = async () => {
    setLoading(true);
    setError(null);

    // 1. Button clicked.
    logOAuthInitiate("info", {
      event: "button_clicked",
      functionName: FUNCTION_NAME,
      resolvedEndpoint: resolveInvokeEndpoint(),
      hasSupabaseUrlInBrowserBundle: Boolean(
        process.env.NEXT_PUBLIC_SUPABASE_URL
      ),
      hasAnonKeyInBrowserBundle: Boolean(
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      ),
    });

    try {
      // Record whether a user session exists (a boolean only — never the token)
      // so an auth/session problem is visible without exposing credentials.
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        // Not fatal on its own, but the function requires an admin JWT, so this
        // is logged explicitly rather than silently falling through to a
        // misleading network error later.
        logOAuthInitiate("error", {
          event: "session_missing",
          functionName: FUNCTION_NAME,
          hint: "The Edge Function requires a signed-in admin JWT.",
        });
      }

      // 2. Invoke about to start.
      // The function verifies admin status server-side, generates a CSRF state,
      // stores it in the oauth_states table, and returns the Google authorization URL.
      logOAuthInitiate("info", {
        event: "invoke_starting",
        functionName: FUNCTION_NAME,
        resolvedEndpoint: resolveInvokeEndpoint(),
        hasSession: Boolean(session),
      });

      const { data, error: invokeError } = await supabase.functions.invoke(
        FUNCTION_NAME,
        {
          body: {},
        }
      );

      // 3. Invoke returned.
      logOAuthInitiate(invokeError ? "error" : "info", {
        event: "invoke_returned",
        functionName: FUNCTION_NAME,
        result: invokeError ? "error" : "success",
        hasData: Boolean(data),
      });

      if (invokeError) {
        // 4. Error details (HTTP / network / function).
        const info = await describeInvokeError(invokeError);
        const failureClass = classifyInvokeFailure(info);

        logOAuthInitiate("error", {
          event: "invoke_failed",
          functionName: FUNCTION_NAME,
          resolvedEndpoint: resolveInvokeEndpoint(),
          failureClass,
          ...safeErrorFields(invokeError),
          sdkErrorMessage: info.sdkMessage,
          httpStatus: info.httpStatus,
          serverErrorCode: info.serverCode,
          serverErrorMessage: info.serverMessage,
        });

        switch (failureClass) {
          case "function_not_deployed":
            setError(
              `The Google Drive connection service (Edge Function "${FUNCTION_NAME}") is not deployed on the Supabase project. ` +
                "Redeploy it with `supabase functions deploy " +
                FUNCTION_NAME +
                "` and check Supabase → Edge Functions → Logs."
            );
            break;
          case "function_boot_error":
            setError(
              `The Google Drive connection service (Edge Function "${FUNCTION_NAME}") failed to start. ` +
                "Check Supabase → Edge Functions → Logs for a boot error and redeploy it."
            );
            break;
          case "authorization":
            setError("Your account does not have administrator privileges.");
            break;
          case "authentication":
            setError("Please sign in again to connect Google Drive.");
            break;
          case "server_rejected":
            setError(info.serverMessage ?? "The server rejected the request.");
            break;
          case "endpoint_unreachable":
            setError(
              `Could not reach the Google Drive connection service (Edge Function "${FUNCTION_NAME}"). ` +
                "The browser received no readable response from the function endpoint, which is how a " +
                "platform 404 (function not deployed, or its deployed bundle missing) and a boot-time 503 " +
                "both appear — this is not evidence of a problem with your internet connection. " +
                "Verify the deployment and check Supabase → Edge Functions → Logs."
            );
            break;
          default:
            setError(
              `Failed to initiate Google Drive connection${
                info.httpStatus ? ` (HTTP ${info.httpStatus})` : ""
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
      setError(
        "An unexpected error occurred. Please check your connection and try again."
      );
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
