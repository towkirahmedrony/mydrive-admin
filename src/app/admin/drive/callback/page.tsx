"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

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

function OAuthCallbackContent() {
  const [status, setStatus] = useState<"loading" | "success" | "error">(
    "loading"
  );
  const [message, setMessage] = useState("Processing Google Drive connection...");
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();

  useEffect(() => {
    const handleCallback = async () => {
      const code = searchParams.get("code");
      const state = searchParams.get("state");
      const error = searchParams.get("error");
      const errorDescription = searchParams.get("error_description");

      // Handle Google OAuth errors (user denied, server error, etc.)
      if (error) {
        setStatus("error");
        if (error === "access_denied") {
          setMessage("Authorization was denied. You can close this tab and return to the admin panel.");
        } else {
          setMessage(
            errorDescription
              ? `OAuth error: ${errorDescription}`
              : `OAuth error: ${error}`
          );
        }
        return;
      }

      // Validate required parameters
      if (!code || !state) {
        setStatus("error");
        setMessage(
          "Invalid callback parameters. This may indicate a CSRF attack or an incomplete OAuth flow. Please try connecting again."
        );
        return;
      }

      try {
        // Forward the authorization code and state to the server-side Edge Function
        // for secure token exchange. The refresh token is handled entirely server-side
        // and never exposed to the browser.
        const { data, error: invokeError } = await supabase.functions.invoke(
          "google-oauth-callback",
          {
            body: { code, state },
          }
        );

        if (invokeError) {
          console.error("OAuth callback Edge Function error:", invokeError);

          // Prefer the server's actionable message (expired/invalid state,
          // admin re-check, missing refresh token guidance, etc.).
          const serverMessage = await extractServerError(invokeError);
          setStatus("error");
          setMessage(
            serverMessage ??
              "Failed to complete Google Drive connection. The server encountered an error. Please try again."
          );
          return;
        }

        if (data?.success) {
          setStatus("success");
          setMessage(
            `Google Drive account ${data.email ? `(${data.email})` : ""} connected successfully!`
          );
          // Refresh the account list, then return to the Drive Accounts page.
          setTimeout(() => {
            router.refresh();
            router.push("/admin/drive");
          }, 2000);
        } else {
          setStatus("error");
          setMessage(
            data?.error || "Failed to connect Google Drive account. Please try again."
          );
        }
      } catch (err) {
        console.error("Unexpected OAuth callback error:", err);
        setStatus("error");
        setMessage(
          "An unexpected error occurred while processing the OAuth callback. Please try again."
        );
      }
    };

    handleCallback();
  }, [searchParams, router, supabase]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="max-w-md w-full text-center">
        {status === "loading" && (
          <>
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto mb-4" />
            <h2 className="text-lg font-medium text-gray-900 mb-2">
              Connecting Google Drive...
            </h2>
            <p className="text-sm text-gray-500">{message}</p>
          </>
        )}

        {status === "success" && (
          <>
            <div className="rounded-full h-12 w-12 bg-green-100 flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl text-green-600">✓</span>
            </div>
            <h2 className="text-lg font-medium text-gray-900 mb-2">
              Connection Successful!
            </h2>
            <p className="text-sm text-gray-500 mb-4">{message}</p>
            <p className="text-xs text-gray-400">
              Redirecting to Drive Accounts...
            </p>
          </>
        )}

        {status === "error" && (
          <>
            <div className="rounded-full h-12 w-12 bg-red-100 flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl text-red-600">✗</span>
            </div>
            <h2 className="text-lg font-medium text-gray-900 mb-2">
              Connection Failed
            </h2>
            <p className="text-sm text-gray-500 mb-6">{message}</p>
            <button
              onClick={() => router.push("/admin/drive")}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-primary-600 bg-primary-100 hover:bg-primary-200 transition-colors"
            >
              Return to Drive Accounts
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function OAuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-[60vh] flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
        </div>
      }
    >
      <OAuthCallbackContent />
    </Suspense>
  );
}
