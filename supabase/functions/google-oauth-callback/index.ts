import { serve } from "jsr:@std/http";
import { corsHeaders, handleCors } from "../shared/cors.ts";
import { getSupabaseAdmin } from "../shared/auth.ts";

/**
 * google-oauth-callback — completes the admin Google Drive OAuth connection.
 *
 * Flow (authoritative MyDrive credential architecture):
 *   Google OAuth -> authorization code -> this function
 *     -> admin_store_drive_refresh_token(p_drive_account_id, p_refresh_token)
 *     -> Supabase Vault
 *     -> drive_accounts.refresh_token_secret_id
 *     -> worker_lookup_drive_refresh_token() -> drive-replicate
 *
 * Security:
 *   - the OAuth state is single-use: it is atomically deleted only when it is
 *     unexpired, so it cannot be replayed or raced
 *   - the admin role of the state owner is re-checked server-side before any
 *     credential is stored
 *   - the authorization code is exchanged server-side; the client secret never
 *     leaves the server
 *   - the refresh token is stored ONLY through admin_store_drive_refresh_token()
 *     (Supabase Vault). It is never written to drive_accounts, never logged,
 *     and never returned to the browser.
 *
 * Usage:
 *   POST /functions/v1/google-oauth-callback
 *   Body: { "code": "...", "state": "..." }
 *   Returns: { "success": true, "email": "..." } or { "error": "..." }
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_ABOUT_URL = "https://www.googleapis.com/drive/v3/about";

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    status,
  });
}

/**
 * Same OAuth client the drive-replicate worker uses to refresh access tokens.
 * Both halves MUST share one client, otherwise the stored refresh token is
 * unusable by the worker.
 */
function getGoogleCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

async function writeAuditLog(
  admin: ReturnType<typeof getSupabaseAdmin>,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await admin.from("sync_logs").insert(payload);
  } catch {
    // Audit logging must never break the connection flow.
  }
}

serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const admin = getSupabaseAdmin();

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const code = typeof body.code === "string" ? body.code.trim() : "";
    const state = typeof body.state === "string" ? body.state.trim() : "";
    if (!code || !state) {
      return json({ error: "Missing code or state parameter" }, 400);
    }

    const credentials = getGoogleCredentials();
    if (!credentials) {
      console.error(
        "google-oauth-callback: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not configured",
      );
      return json({ error: "Google OAuth is not configured on the server." }, 500);
    }

    const callbackUrl = Deno.env.get("ADMIN_CALLBACK_URL");
    if (!callbackUrl) {
      console.error("google-oauth-callback: ADMIN_CALLBACK_URL not configured");
      return json(
        { error: "Google OAuth callback URL is not configured on the server." },
        500,
      );
    }

    // ── 1. Consume the single-use state atomically ──────────────────────────
    // The DELETE only matches an unexpired row, so exactly one concurrent
    // request can win and an already-used/expired state matches nothing.
    const nowIso = new Date().toISOString();
    const { data: consumed, error: consumeError } = await admin
      .from("oauth_states")
      .delete()
      .eq("state", state)
      .gt("expires_at", nowIso)
      .select("user_id");

    if (consumeError) {
      throw new Error(`Failed to validate OAuth state: ${consumeError.message}`);
    }

    if (!consumed || consumed.length === 0) {
      // Distinguish an expired-but-present state (clean it up) from an
      // unknown/forged/reused one, without leaking any other detail.
      const { data: stale } = await admin
        .from("oauth_states")
        .select("expires_at")
        .eq("state", state)
        .maybeSingle();

      if (stale) {
        await admin.from("oauth_states").delete().eq("state", state);
        return json(
          { error: "OAuth session expired. Please start the connection again." },
          400,
        );
      }
      return json(
        { error: "Invalid OAuth state. Please start the connection again." },
        400,
      );
    }

    const userId = (consumed[0] as { user_id: string }).user_id;

    // ── 2. Re-verify the initiating admin (role may have changed) ───────────
    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .maybeSingle();

    if (profileError) {
      throw new Error(`Admin re-check failed: ${profileError.message}`);
    }
    if ((profile as { role?: string } | null)?.role !== "admin") {
      return json(
        { error: "Administrator privileges are required to connect a Drive account." },
        403,
      );
    }

    // ── 3. Exchange the authorization code server-side ─────────────────────
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        redirect_uri: callbackUrl,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!tokenResponse.ok) {
      // Never log the response body: it can echo token material.
      console.error(
        `google-oauth-callback: token exchange failed (HTTP ${tokenResponse.status})`,
      );
      return json(
        { error: "Failed to exchange the authorization code with Google." },
        502,
      );
    }

    const tokens = await tokenResponse.json() as {
      access_token?: string;
      refresh_token?: string;
    };

    if (!tokens.access_token) {
      console.error(
        "google-oauth-callback: token exchange returned no access token",
      );
      return json({ error: "Google did not return an access token." }, 502);
    }

    // Google omits refresh_token when the account previously authorized the
    // app. That must NOT clobber an existing Vault credential.
    const refreshToken =
      typeof tokens.refresh_token === "string" &&
        tokens.refresh_token.trim().length > 0
        ? tokens.refresh_token
        : null;

    // ── 4. Identify the Google account using the Drive API only ────────────
    // `about.get` accepts the drive.file scope, so no extra OAuth scope is
    // needed to learn which account was just connected.
    const aboutUrl = new URL(DRIVE_ABOUT_URL);
    aboutUrl.searchParams.set("fields", "user(emailAddress,displayName)");

    const aboutResponse = await fetch(aboutUrl.toString(), {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(20_000),
    });

    if (!aboutResponse.ok) {
      console.error(
        `google-oauth-callback: Drive about.get failed (HTTP ${aboutResponse.status})`,
      );
      return json(
        { error: "Failed to retrieve the Google account identity." },
        502,
      );
    }

    const about = await aboutResponse.json() as {
      user?: { emailAddress?: string; displayName?: string };
    };
    const email = about.user?.emailAddress?.trim() ?? "";
    const displayName = about.user?.displayName?.trim() ?? "";

    if (!email) {
      console.error("google-oauth-callback: Drive about.get returned no email");
      return json(
        { error: "Google did not return an account email address." },
        502,
      );
    }

    // ── 5. Find an existing account (reconnect, never duplicate) ───────────
    const { data: existing, error: existingError } = await admin
      .from("drive_accounts")
      .select("id, status, refresh_token_secret_id")
      .eq("google_email", email)
      .maybeSingle();

    if (existingError) {
      throw new Error(`Drive account lookup failed: ${existingError.message}`);
    }

    const existingRow = existing as {
      id: string;
      status: string | null;
      refresh_token_secret_id: string | null;
    } | null;

    const existingHasSecret = Boolean(existingRow?.refresh_token_secret_id);

    // A brand-new account (or one without a credential) is useless without a
    // refresh token. Fail with an actionable message instead of storing nothing.
    if (!refreshToken && !existingHasSecret) {
      return json(
        {
          error:
            "Google did not return a refresh token. Remove this app's access at " +
            "https://myaccount.google.com/permissions and try connecting again.",
        },
        400,
      );
    }

    const now = new Date().toISOString();
    let accountId: string;

    if (existingRow) {
      // Preserve all other account data — only refresh the reconnect state
      // using columns that exist in the live drive_accounts schema.
      const patch: Record<string, unknown> = {
        updated_at: now,
      };
      if (existingRow.status === "reauth_required") {
        patch.status = "active";
      }

      const { error: updateError } = await admin
        .from("drive_accounts")
        .update(patch)
        .eq("id", existingRow.id);
      if (updateError) {
        throw new Error(`Failed to update Drive account: ${updateError.message}`);
      }
      accountId = existingRow.id;
    } else {
      const insert = {
        google_email: email,
        name: displayName || email,
        status: "active",
      };

      const { data: created, error: insertError } = await admin
        .from("drive_accounts")
        .insert(insert)
        .select("id")
        .maybeSingle();

      if (insertError) {
        // Lost an insert race: reconnect to the row that won.
        if (insertError.code === "23505") {
          const { data: raced } = await admin
            .from("drive_accounts")
            .select("id")
            .eq("google_email", email)
            .maybeSingle();
          if (!raced) {
            throw new Error(
              `Failed to create Drive account: ${insertError.message}`,
            );
          }
          accountId = (raced as { id: string }).id;
        } else {
          throw new Error(
            `Failed to create Drive account: ${insertError.message}`,
          );
        }
      } else {
        accountId = (created as { id: string }).id;
      }
    }

    // ── 6. Store the refresh token through the authoritative Vault RPC ─────
    // Only the secret reference is persisted on drive_accounts; the token
    // itself is never written here and never leaves the server.
    if (refreshToken) {
      const { error: rpcError } = await admin.rpc(
        "admin_store_drive_refresh_token",
        {
          p_drive_account_id: accountId,
          p_refresh_token: refreshToken,
        },
      );

      if (rpcError) {
        console.error(
          `google-oauth-callback: credential storage failed for account ${accountId}`,
        );
        // Leave the row in a recoverable state without storing any token.
        await admin
          .from("drive_accounts")
          .update({
            status: "error",
            updated_at: new Date().toISOString(),
          })
          .eq("id", accountId);

        return json(
          { error: "Failed to store the Drive credentials securely." },
          500,
        );
      }
    }

    await writeAuditLog(admin, {
      event_type: "oauth_connection",
      status: "success",
      message: `Connected Google Drive account: ${email}`,
      metadata: {
        admin_user_id: userId,
        google_email: email,
        drive_account_id: accountId,
        new_refresh_token: Boolean(refreshToken),
      },
    });

    // ── 7. Success response — no token material is ever returned ───────────
    return json({ success: true, email }, 200);
  } catch (error) {
    console.error("google-oauth-callback failed:", (error as Error).message);
    return json({ error: "Internal server error" }, 500);
  }
});
