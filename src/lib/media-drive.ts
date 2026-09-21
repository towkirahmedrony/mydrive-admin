/**
 * Server-only client for the `media-drive` Edge Function: the read path into
 * the Google Drive archive.
 *
 * Why a separate module
 * ---------------------
 * The Google Drive credential is a refresh token in Supabase Vault, exchanged
 * for a short-lived access token by server-side code that already exists for
 * the archival worker. The Admin Panel therefore never talks to Google and
 * never holds a Google token: it asks the Edge Function — through the admin's
 * own Supabase session — for the bytes of one media id.
 *
 * Nothing in this file is importable from a client component in practice: it
 * reads server-only environment values and handles an admin access token. The
 * token it forwards is the signed-in administrator's own Supabase JWT, which
 * the function independently re-verifies against `profiles.role = 'admin'`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Machine-readable failure codes the Edge Function can return. */
export type ArchiveFailureReason =
  | "unauthenticated"
  | "forbidden"
  | "invalid_request"
  | "ownership_mismatch"
  | "media_not_found"
  | "not_archived"
  | "archive_missing"
  | "no_preview"
  | "account_missing"
  | "account_disabled"
  | "credential_error"
  | "provider_unavailable"
  | "range_not_satisfiable"
  | "server_error"
  | "unreachable";

export type ArchiveReadResult =
  | {
      ok: true;
      /** The Drive byte stream, ready to be piped onward. */
      upstream: Response;
      integrity: string;
    }
  | {
      ok: false;
      reason: ArchiveFailureReason;
      /** true only when repeating the identical read could plausibly succeed. */
      retryable: boolean;
      /** Upstream/provider status when one exists, otherwise the function's. */
      status: number;
      message: string;
    };

function serverEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  return url && anonKey ? { url, anonKey } : null;
}

function asReason(value: unknown): ArchiveFailureReason {
  const known: ArchiveFailureReason[] = [
    "unauthenticated",
    "forbidden",
    "invalid_request",
    "ownership_mismatch",
    "media_not_found",
    "not_archived",
    "archive_missing",
    "no_preview",
    "account_missing",
    "account_disabled",
    "credential_error",
    "provider_unavailable",
    "range_not_satisfiable",
  ];
  return known.includes(value as ArchiveFailureReason)
    ? (value as ArchiveFailureReason)
    : "server_error";
}

/**
 * The signed-in administrator's Supabase access token.
 *
 * Middleware refreshes the session on every admin request, so this is the
 * current token. `getUser()` remains the authorization check — this value is
 * only used to re-authenticate the same caller to the Edge Function.
 */
export async function getAdminAccessToken(
  supabase: SupabaseClient,
): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Requests one archived media file (or its Drive-generated thumbnail) through
 * the Edge Function.
 *
 * `mediaId` is the only media locator that crosses this boundary. The Drive
 * file id is resolved from the database by the function, so a caller cannot ask
 * for an arbitrary Drive file.
 */
export async function openArchivedMedia(params: {
  mediaId: string;
  ownerId: string;
  variant: "thumb" | "original";
  accessToken: string | null;
  range?: string | null;
  timeoutMs?: number;
}): Promise<ArchiveReadResult> {
  if (!params.accessToken) {
    return {
      ok: false,
      reason: "unauthenticated",
      retryable: true,
      status: 401,
      message: "No administrator session is available for the archive request.",
    };
  }

  const env = serverEnv();
  if (!env) {
    return {
      ok: false,
      reason: "server_error",
      retryable: false,
      status: 500,
      message: "Supabase is not configured for this deployment.",
    };
  }

  const headers: Record<string, string> = {
    apikey: env.anonKey,
    Authorization: `Bearer ${params.accessToken}`,
    "Content-Type": "application/json",
  };
  if (params.range) headers.Range = params.range;

  let upstream: Response;
  try {
    upstream = await fetch(`${env.url}/functions/v1/media-drive`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        media_id: params.mediaId,
        owner_id: params.ownerId,
        variant: params.variant,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(params.timeoutMs ?? 30_000),
    });
  } catch (error) {
    // A transport fault (DNS, TLS, timeout) is never "the file was deleted".
    const name = (error as Error)?.name ?? "error";
    return {
      ok: false,
      reason: name === "TimeoutError" || name === "AbortError"
        ? "provider_unavailable"
        : "unreachable",
      retryable: true,
      status: 504,
      message: "The archive service could not be reached from the server.",
    };
  }

  if (upstream.ok || upstream.status === 206) {
    return {
      ok: true,
      upstream,
      integrity: upstream.headers.get("x-mydrive-archive-integrity") ?? "unknown",
    };
  }

  // Failures are JSON: { success:false, error, reason, retryable }
  let reason: ArchiveFailureReason = upstream.status >= 500
    ? "provider_unavailable"
    : "server_error";
  let retryable = upstream.status >= 500;
  let message = `The archive request failed with status ${upstream.status}.`;
  let serverStatus = upstream.status;

  try {
    const payload = await upstream.json() as {
      reason?: unknown;
      error?: unknown;
      retryable?: unknown;
    };
    reason = asReason(payload.reason);
    if (typeof payload.error === "string" && payload.error.trim()) {
      message = payload.error.trim().slice(0, 300);
    }
    retryable = payload.retryable === true ||
      reason === "provider_unavailable" || reason === "unreachable";

    // The reason is the classification; the HTTP status the function chose is
    // kept so the panel can answer with the same shape it received.
    serverStatus = upstream.status;
  } catch {
    // Non-JSON body: the status alone still classifies the failure.
    if (upstream.status === 401) reason = "unauthenticated";
    if (upstream.status === 403) reason = "forbidden";
    if (upstream.status === 404) reason = "archive_missing";
  }

  // Never log the token; the reason and status are enough to diagnose.
  console.warn(
    `[media-drive] archive read failed (${reason}, status ${serverStatus})`,
  );

  return { ok: false, reason, retryable, status: serverStatus, message };
}
