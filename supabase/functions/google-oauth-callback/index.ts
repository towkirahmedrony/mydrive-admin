import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/auth.ts";

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
 * Structured, secret-free diagnostic logging.
 *
 * NEVER pass the raw authorization code, access token, refresh token, client
 * secret, authorization header, cookies, or full session/user objects.
 * Booleans, ids, counts, HTTP statuses and provider error strings are safe.
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

function requireRpcUuid(value: unknown, operation: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${operation} returned an invalid account id`);
  }
  return value;
}

/**
 * Reads Google's error response body and returns only the safe error fields.
 * The body can echo token material, so the raw body is never logged.
 */
async function googleErrorFields(
  response: Response,
): Promise<Record<string, unknown>> {
  try {
    const body = await response.json() as {
      error?: string | { code?: number | string; message?: string; status?: string };
      error_description?: string;
    };
    if (typeof body.error === "string") {
      return {
        googleError: body.error,
        googleErrorDescription: body.error_description ?? null,
      };
    }
    if (body.error && typeof body.error === "object") {
      return {
        googleErrorStatus: body.error.status ?? null,
        googleErrorCode: body.error.code ?? null,
        googleErrorMessage: body.error.message ?? null,
      };
    }
  } catch {
    // Response was not JSON; nothing safe to extract.
  }
  return {};
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

Deno.serve(async (req: Request) => {
  const OPERATION = "oauth_callback";

  // Log BEFORE the CORS preflight short-circuit so a request that is rejected
  // by the platform (404 / boot failure) — which never reaches this function —
  // is distinguishable from one that arrived and was answered here.
  log("info", OPERATION, {
    event: "callback_request_received",
    method: req.method,
    isCorsPreflight: req.method === "OPTIONS",
  });

  const corsResponse = handleCors(req);
  if (corsResponse) {
    log("info", OPERATION, {
      event: "cors_preflight_answered",
      result: "success",
    });
    return corsResponse;
  }

  if (req.method !== "POST") {
    log("error", OPERATION, { event: "method_not_allowed", method: req.method });
    return json({ error: "Method not allowed" }, 405);
  }

  // The admin user id is a UUID and is safe to log; tokens/JWTs never are.
  let userId: string | null = null;

  try {
    const admin = getSupabaseAdmin();

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch (parseError) {
      log("error", OPERATION, {
        event: "body_parse",
        result: "failure",
        errorName: (parseError as Error)?.name ?? null,
        errorMessage: (parseError as Error)?.message ?? null,
      });
      return json({ error: "Invalid JSON body" }, 400);
    }

    const code = typeof body.code === "string" ? body.code.trim() : "";
    const state = typeof body.state === "string" ? body.state.trim() : "";

    // Booleans only — never the raw code or state values.
    log("info", OPERATION, {
      event: "code_state_presence_check",
      hasCode: code.length > 0,
      hasState: state.length > 0,
    });

    if (!code || !state) {
      log("error", OPERATION, {
        event: "code_state_presence_check",
        result: "failure",
        reason: "missing_code_or_state",
      });
      return json({ error: "Missing code or state parameter" }, 400);
    }

    const credentials = getGoogleCredentials();
    if (!credentials) {
      log("error", OPERATION, {
        event: "config_check",
        result: "failure",
        missingConfig: "GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET",
      });
      return json({ error: "Google OAuth is not configured on the server." }, 500);
    }

    const callbackUrl = Deno.env.get("ADMIN_CALLBACK_URL");
    if (!callbackUrl) {
      log("error", OPERATION, {
        event: "config_check",
        result: "failure",
        missingConfig: "ADMIN_CALLBACK_URL",
      });
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
      log("error", OPERATION, {
        event: "oauth_state_consumption",
        result: "failure",
        errorName: "PostgrestError",
        errorMessage: consumeError.message,
        ...dbErrorFields(consumeError),
      });
      throw new Error(`Failed to validate OAuth state: ${consumeError.message}`);
    }

    log("info", OPERATION, {
      event: "oauth_state_consumption",
      result: "success",
      consumedCount: consumed?.length ?? 0,
    });

    if (!consumed || consumed.length === 0) {
      // Distinguish an expired-but-present state (clean it up) from an
      // unknown/forged/reused one, without leaking any other detail.
      const { data: stale, error: staleError } = await admin
        .from("oauth_states")
        .select("expires_at")
        .eq("state", state)
        .maybeSingle();

      log("info", OPERATION, {
        event: "oauth_state_lookup",
        result: staleError ? "failure" : "success",
        staleFound: Boolean(stale),
        ...(staleError ? dbErrorFields(staleError) : {}),
      });

      if (stale) {
        await admin.from("oauth_states").delete().eq("state", state);
        log("error", OPERATION, {
          event: "oauth_state_validation",
          result: "expired",
          stateDeleted: true,
        });
        return json(
          { error: "OAuth session expired. Please start the connection again." },
          400,
        );
      }

      log("error", OPERATION, {
        event: "oauth_state_validation",
        result: "invalid",
      });
      return json(
        { error: "Invalid OAuth state. Please start the connection again." },
        400,
      );
    }

    userId = (consumed[0] as { user_id: string }).user_id;

    log("info", OPERATION, {
      event: "oauth_state_validation",
      result: "valid",
      userId,
    });

    // ── 2. Re-verify the initiating admin (role may have changed) ───────────
    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .maybeSingle();

    if (profileError) {
      log("error", OPERATION, {
        event: "admin_verification",
        result: "failure",
        userId,
        errorName: "PostgrestError",
        errorMessage: profileError.message,
        ...dbErrorFields(profileError),
      });
      throw new Error(`Admin re-check failed: ${profileError.message}`);
    }

    const isAdmin = (profile as { role?: string } | null)?.role === "admin";
    log(isAdmin ? "info" : "error", OPERATION, {
      event: "admin_verification",
      result: isAdmin ? "success" : "failure",
      isAdmin,
      userId,
    });
    if (!isAdmin) {
      return json(
        { error: "Administrator privileges are required to connect a Drive account." },
        403,
      );
    }

    // ── 3. Exchange the authorization code server-side ─────────────────────
    log("info", OPERATION, {
      event: "google_token_exchange",
      result: "started",
      userId,
    });

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
      // Never log the response body verbatim: it can echo token material.
      const safe = await googleErrorFields(tokenResponse);
      log("error", OPERATION, {
        event: "google_token_exchange",
        result: "failure",
        userId,
        httpStatus: tokenResponse.status,
        ...safe,
      });
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
      log("error", OPERATION, {
        event: "google_token_exchange",
        result: "failure",
        userId,
        httpStatus: tokenResponse.status,
        reason: "no_access_token",
      });
      return json({ error: "Google did not return an access token." }, 502);
    }

    // Google omits refresh_token when the account previously authorized the
    // app. That must NOT clobber an existing Vault credential.
    const refreshToken =
      typeof tokens.refresh_token === "string" &&
        tokens.refresh_token.trim().length > 0
        ? tokens.refresh_token
        : null;

    // Booleans only — the token values are never logged.
    log("info", OPERATION, {
      event: "google_token_exchange",
      result: "completed",
      userId,
      httpStatus: tokenResponse.status,
      hasAccessToken: true,
      hasRefreshToken: Boolean(refreshToken),
    });

    // ── 4. Identify the Google account using the Drive API only ────────────
    // `about.get` accepts the drive.file scope, so no extra OAuth scope is
    // needed to learn which account was just connected.
    const aboutUrl = new URL(DRIVE_ABOUT_URL);
    aboutUrl.searchParams.set("fields", "user(emailAddress,displayName)");

    log("info", OPERATION, {
      event: "google_userinfo_request",
      result: "started",
      userId,
    });

    const aboutResponse = await fetch(aboutUrl.toString(), {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(20_000),
    });

    if (!aboutResponse.ok) {
      const safe = await googleErrorFields(aboutResponse);
      log("error", OPERATION, {
        event: "google_userinfo_request",
        result: "failure",
        userId,
        httpStatus: aboutResponse.status,
        ...safe,
      });
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
      log("error", OPERATION, {
        event: "google_userinfo_request",
        result: "failure",
        userId,
        httpStatus: aboutResponse.status,
        reason: "no_email",
      });
      return json(
        { error: "Google did not return an account email address." },
        502,
      );
    }

    log("info", OPERATION, {
      event: "google_userinfo_request",
      result: "completed",
      userId,
      httpStatus: aboutResponse.status,
      email,
    });

    // ── 5. Find an existing account (reconnect, never duplicate) ───────────
    const { data: existing, error: existingError } = await admin
      .from("drive_accounts")
      .select("id, status, refresh_token_secret_id")
      .eq("google_email", email)
      .maybeSingle();

    if (existingError) {
      log("error", OPERATION, {
        event: "drive_account_lookup",
        result: "failure",
        userId,
        email,
        errorName: "PostgrestError",
        errorMessage: existingError.message,
        ...dbErrorFields(existingError),
      });
      throw new Error(`Drive account lookup failed: ${existingError.message}`);
    }

    const existingRow = existing as {
      id: string;
      status: string | null;
      refresh_token_secret_id: string | null;
    } | null;

    const existingHasSecret = Boolean(existingRow?.refresh_token_secret_id);

    log("info", OPERATION, {
      event: "drive_account_lookup",
      result: "success",
      userId,
      email,
      existingAccountFound: Boolean(existingRow),
      existingAccountId: existingRow?.id ?? null,
      existingStatus: existingRow?.status ?? null,
      existingHasSecret,
      branch: existingRow ? "reconnect" : "new_account",
    });

    // A brand-new account (or one without a credential) is useless without a
    // refresh token. Fail with an actionable message instead of storing nothing.
    if (!refreshToken && !existingHasSecret) {
      log("error", OPERATION, {
        event: "refresh_token_check",
        result: "failure",
        userId,
        email,
        reason: "missing_refresh_token_for_new_account",
      });
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
    let refreshTokenStored = false;

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
        log("error", OPERATION, {
          event: "drive_account_update",
          result: "failure",
          userId,
          accountId: existingRow.id,
          errorName: "PostgrestError",
          errorMessage: updateError.message,
          ...dbErrorFields(updateError),
        });
        throw new Error(`Failed to update Drive account: ${updateError.message}`);
      }
      accountId = existingRow.id;
      log("info", OPERATION, {
        event: "drive_account_update",
        result: "success",
        userId,
        accountId,
      });
    } else {
      const { data: createdAccountId, error: createError } = await admin.rpc(
        "admin_create_drive_account_with_refresh_token",
        {
          p_google_email: email,
          p_name: displayName || email,
          p_refresh_token: refreshToken,
        },
      );

      if (createError) {
        // Lost an insert race: reconnect to the row that won.
        if (createError.code === "23505") {
          const { data: raced, error: racedLookupError } = await admin
            .from("drive_accounts")
            .select("id, status, refresh_token_secret_id")
            .eq("google_email", email)
            .maybeSingle();
          if (racedLookupError || !raced) {
            log("error", OPERATION, {
              event: "drive_account_insert",
              result: "failure",
              userId,
              email,
              errorName: "PostgrestError",
              errorMessage: racedLookupError?.message ?? createError.message,
              ...dbErrorFields(racedLookupError ?? createError),
            });
            throw new Error(
              `Failed to create Drive account: ${
                racedLookupError?.message ?? createError.message
              }`,
            );
          }
          accountId = (raced as { id: string }).id;
          log("info", OPERATION, {
            event: "drive_account_insert",
            result: "recovered_from_race",
            userId,
            accountId,
          });
        } else {
          log("error", OPERATION, {
            event: "drive_account_insert",
            result: "failure",
            userId,
            email,
            errorName: "PostgrestError",
            errorMessage: createError.message,
            ...dbErrorFields(createError),
          });
          throw new Error(
            `Failed to create Drive account: ${createError.message}`,
          );
        }
      } else {
        accountId = requireRpcUuid(
          createdAccountId,
          "admin_create_drive_account_with_refresh_token",
        );
        refreshTokenStored = true;
        log("info", OPERATION, {
          event: "drive_account_insert",
          result: "success",
          userId,
          accountId,
        });
      }
    }

    // ── 6. Store the refresh token through the authoritative Vault RPC ─────
    // Only the secret reference is persisted on drive_accounts; the token
    // itself is never written here and never leaves the server.
    if (refreshToken && !refreshTokenStored) {
      // The drive account UUID is safe to log.
      log("info", OPERATION, {
        event: "admin_store_drive_refresh_token",
        result: "started",
        userId,
        accountId,
      });

      const { error: rpcError } = await admin.rpc(
        "admin_store_drive_refresh_token",
        {
          p_drive_account_id: accountId,
          p_refresh_token: refreshToken,
        },
      );

      if (rpcError) {
        log("error", OPERATION, {
          event: "admin_store_drive_refresh_token",
          result: "failure",
          userId,
          accountId,
          errorName: "PostgrestError",
          errorMessage: rpcError.message,
          ...dbErrorFields(rpcError),
        });
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

      log("info", OPERATION, {
        event: "admin_store_drive_refresh_token",
        result: "success",
        userId,
        accountId,
      });
    } else {
      log("info", OPERATION, {
        event: "admin_store_drive_refresh_token",
        result: "skipped",
        reason: refreshTokenStored ? "already_stored_atomically" : "no_new_refresh_token",
        userId,
        accountId,
      });
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
    log("info", OPERATION, {
      event: "flow_completed",
      result: "success",
      userId,
      accountId,
      email,
    });

    return json({ success: true, email }, 200);
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
