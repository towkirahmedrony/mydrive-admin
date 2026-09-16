import { corsHeaders, handleCors } from "../shared/cors.ts";
import { getSupabaseAdmin, getSupabaseAuth } from "../shared/auth.ts";

/**
 * google-oauth-initiate — starts the admin Google Drive OAuth connection flow.
 *
 * Security:
 *   - requires a valid user JWT AND profiles.role = 'admin'
 *   - generates a cryptographically random, single-use OAuth state and stores it
 *     in oauth_states with a short TTL, bound to the initiating admin
 *   - the Google Client Secret is NEVER handled here; only the public client id
 *     is used to build the authorization URL
 *   - no token, secret, or encryption key is returned to the browser
 *
 * Usage:
 *   POST /functions/v1/google-oauth-initiate
 *   Headers: Authorization: Bearer <admin user JWT>, apikey: <anon key>
 *   Returns: { "url": "https://accounts.google.com/o/oauth2/v2/auth?..." }
 */

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

// Minimum scope required by the drive-replicate worker. The worker only ever
// lists, creates and uploads files/folders that this application itself
// created (folder resolution + resumable uploads + duplicate guard), which is
// exactly what `drive.file` grants. No broader Drive scope is requested.
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

// OAuth states are short-lived and single-use.
const STATE_TTL_MINUTES = 10;

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    status,
  });
}

/**
 * Structured, secret-free diagnostic logging.
 *
 * NEVER pass tokens, JWTs, authorization headers, OAuth codes, cookies,
 * client secrets, encryption keys, or full session/user objects as fields.
 */
function log(
  level: "info" | "error",
  operation: string,
  fields: Record<string, unknown> = {},
): void {
  const line = `[GoogleDrive][${operation}] ${JSON.stringify({
    scope: "GoogleDrive",
    operation,
    timestamp: new Date().toISOString(),
    ...fields,
  })}`;
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

/** Extracts the safe, structural fields of a Supabase/PostgREST error. */
function dbErrorFields(
  error:
    | { code?: string | null; message?: string | null; details?: string | null; hint?: string | null }
    | null
    | undefined,
): Record<string, unknown> {
  return {
    supabaseErrorCode: error?.code ?? null,
    supabaseErrorMessage: error?.message ?? null,
    supabaseErrorDetails: error?.details ?? null,
    supabaseErrorHint: error?.hint ?? null,
  };
}

/**
 * The OAuth client id MUST be the same client the drive-replicate worker uses
 * to refresh access tokens (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET),
 * otherwise the stored refresh token cannot be exchanged for an access token.
 */
function getGoogleClientId(): string | null {
  return Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") ?? null;
}

/** 256 bits of cryptographic randomness, hex-encoded. */
function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  const OPERATION = "oauth_initiate";

  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  log("info", OPERATION, { event: "request_received", method: req.method });

  if (req.method !== "POST") {
    log("error", OPERATION, {
      event: "method_not_allowed",
      method: req.method,
    });
    return json({ error: "Method not allowed" }, 405);
  }

  // The id is a UUID and is safe to log; the JWT is never logged.
  let userId: string | null = null;

  try {
    // 1. Authenticated admin (server-side, never trusted from the browser).
    const hasAuthorizationHeader = Boolean(req.headers.get("Authorization"));
    try {
      const { user } = await getSupabaseAuth(req);
      userId = user.id;
      log("info", OPERATION, {
        event: "auth_validated",
        result: "success",
        hasAuthorizationHeader,
        userId,
      });
    } catch (authError) {
      log("error", OPERATION, {
        event: "auth_validated",
        result: "failure",
        hasAuthorizationHeader,
        userId: null,
        errorName: (authError as Error)?.name ?? null,
        errorMessage: (authError as Error)?.message ?? null,
      });
      return json({ error: "Authentication required" }, 401);
    }

    const admin = getSupabaseAdmin();
    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .maybeSingle();

    if (profileError) {
      log("error", OPERATION, {
        event: "admin_role_check",
        result: "failure",
        userId,
        errorName: "PostgrestError",
        errorMessage: profileError.message,
        ...dbErrorFields(profileError),
      });
      throw new Error(`Admin check failed: ${profileError.message}`);
    }

    const isAdmin = (profile as { role?: string } | null)?.role === "admin";
    log(isAdmin ? "info" : "error", OPERATION, {
      event: "admin_role_check",
      result: isAdmin ? "success" : "failure",
      isAdmin,
      userId,
    });
    if (!isAdmin) {
      return json({ error: "Admin privileges required" }, 403);
    }

    // 2. Server configuration (fail clearly instead of guessing a URL).
    const clientId = getGoogleClientId();
    if (!clientId) {
      log("error", OPERATION, {
        event: "config_check",
        result: "failure",
        userId,
        missingConfig: "GOOGLE_OAUTH_CLIENT_ID",
      });
      return json({ error: "Google OAuth is not configured on the server." }, 500);
    }

    const callbackUrl = Deno.env.get("ADMIN_CALLBACK_URL");
    if (!callbackUrl) {
      log("error", OPERATION, {
        event: "config_check",
        result: "failure",
        userId,
        missingConfig: "ADMIN_CALLBACK_URL",
      });
      return json(
        { error: "Google OAuth callback URL is not configured on the server." },
        500,
      );
    }

    // 3. Single-use CSRF state bound to this admin.
    const state = generateState();
    const expiresAt = new Date(
      Date.now() + STATE_TTL_MINUTES * 60 * 1000,
    ).toISOString();

    const { error: stateError } = await admin.from("oauth_states").insert({
      user_id: userId,
      state,
      expires_at: expiresAt,
    });

    if (stateError) {
      log("error", OPERATION, {
        event: "oauth_state_creation",
        result: "failure",
        userId,
        errorName: "PostgrestError",
        errorMessage: stateError.message,
        ...dbErrorFields(stateError),
      });
      throw new Error(`Failed to persist OAuth state: ${stateError.message}`);
    }

    log("info", OPERATION, {
      event: "oauth_state_creation",
      result: "success",
      userId,
      expiresAt,
    });

    // 4. Server-side authorization URL. The redirect target is the Admin Panel
    //    callback page (ADMIN_CALLBACK_URL), which receives ?code=&state= and
    //    forwards them to google-oauth-callback for the server-side exchange.
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      response_type: "code",
      scope: DRIVE_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    });

    log("info", OPERATION, {
      event: "authorization_url_generated",
      result: "success",
      userId,
    });

    return json({ url: `${GOOGLE_AUTH_URL}?${params.toString()}` }, 200);
  } catch (error) {
    log("error", OPERATION, {
      event: "unexpected_exception",
      result: "failure",
      userId,
      errorName: (error as Error)?.name ?? null,
      errorMessage: (error as Error)?.message ?? null,
    });
    return json({ error: "Internal server error" }, 500);
  }
});
