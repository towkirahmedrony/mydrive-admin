import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getSupabaseAdmin, getSupabaseAuth } from "../_shared/auth.ts";
import {
  CALLER_AUTH_REQUIRED_MESSAGE,
  decideAdminAuthorization,
  decideGooglePermissionId,
  decideRefreshTokenHandling,
  decideStateAuthorization,
  patchTouchesProtectedField,
  PERMISSION_ID_CONFLICT_MESSAGE,
  permissionIdNeedsWrite,
  planIdentityPatch,
  planReconnectPatch,
  REFRESH_TOKEN_REQUIRED_MESSAGE,
  type ReconnectAccountState,
  type StateConsumption,
} from "../_shared/oauth-callback-policy.ts";

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
 *   - CALLER BINDING: the HTTP caller must present a valid Supabase session and
 *     must be the SAME user the OAuth state was minted for. Possession of a
 *     `state` value alone never authorizes binding an account. A
 *     caller/state mismatch is refused with the same response as an unknown
 *     state, so the endpoint never discloses who a state belongs to.
 *   - the caller is authenticated and the state is authorized BEFORE the Google
 *     authorization code is exchanged, and before any state is consumed by an
 *     unauthenticated request.
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
 *
 * Deferred — deliberately NOT implemented in this change:
 *   - MIGRATION GUARD. `drive_accounts` has no migration/provenance column yet,
 *     so re-authorization cannot currently be blocked for an account that is
 *     being retired. When the retirement feature lands it MUST add an
 *     authoritative guard (e.g. `drive_accounts.retiring_migration_id`) and
 *     this callback MUST refuse to restore `status = 'active'` while that guard
 *     is set — otherwise a re-auth could silently return a retiring source
 *     account to routing eligibility. `planReconnectPatch()` in
 *     `_shared/oauth-callback-policy.ts` is the single place that decision is
 *     made, so the guard belongs there.
 *   - (implemented) STABLE GOOGLE IDENTITY. `about.user.permissionId` is
 *     requested from the same Drive `about` call that already supplies the
 *     email and quota, and is persisted to `drive_accounts.google_permission_id`
 *     (nullable, opaque). `google_email` remains the OAuth matching key and is
 *     unchanged for display/backward compatibility. The stable identity exists
 *     to detect the case the email cannot — the same address now belonging to a
 *     different Google account — which is REFUSED rather than silently rebound.
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

function normalizeGoogleByteCount(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^\d+$/.test(normalized) ? normalized : null;
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

    // ── 0. Authenticate the caller ──────────────────────────────────────────
    // Possession of a `state` value must never be sufficient to bind a Google
    // account. The admin panel invokes this function from the authenticated
    // browser client, so an Authorization header is expected. The caller is
    // resolved BEFORE the state is consumed, so an unauthenticated request
    // cannot burn a legitimate admin's pending state.
    let callerUserId: string | null = null;
    try {
      const auth = await getSupabaseAuth(req);
      callerUserId = auth.user.id;
      log("info", OPERATION, {
        event: "caller_authentication",
        result: "success",
        callerUserId,
      });
    } catch (authError) {
      // The error text from the auth helper never contains the token itself.
      log("error", OPERATION, {
        event: "caller_authentication",
        result: "failure",
        errorName: (authError as Error)?.name ?? null,
        errorMessage: (authError as Error)?.message ?? null,
      });
      return json({ error: CALLER_AUTH_REQUIRED_MESSAGE }, 401);
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

    // Classify the consumption outcome; authorization is decided from it below.
    let consumption: StateConsumption;

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
        // Expired rows are cleaned up here; the 10-minute window is unchanged.
        await admin.from("oauth_states").delete().eq("state", state);
        log("error", OPERATION, {
          event: "oauth_state_validation",
          result: "expired",
          stateDeleted: true,
        });
        consumption = { kind: "expired" };
      } else {
        log("error", OPERATION, {
          event: "oauth_state_validation",
          result: "invalid",
        });
        consumption = { kind: "invalid" };
      }
    } else {
      consumption = {
        kind: "consumed",
        userId: (consumed[0] as { user_id: string | null }).user_id ?? null,
      };
    }

    // ── 1b. Authorize the CALLER against the state owner ────────────────────
    // The state proves an administrator STARTED this flow; it does not prove
    // who is FINISHING it. Without this check, anyone who obtained a live state
    // could bind an arbitrary Google account into the archive pool. Both
    // refusals happen before the authorization code is exchanged.
    const stateRejection = decideStateAuthorization({
      callerUserId,
      consumption,
    });

    if (stateRejection) {
      log("error", OPERATION, {
        event: "oauth_state_authorization",
        result: "failure",
        reason: stateRejection.reason,
        // Logged for triage only; the response never discloses ownership.
        callerUserId,
        stateOwnerUserId: consumption.kind === "consumed"
          ? consumption.userId
          : null,
        statePresent: consumption.kind !== "invalid",
      });
      return json({ error: stateRejection.error }, stateRejection.status);
    }

    if (consumption.kind !== "consumed") {
      // Unreachable: every non-consumed outcome rejects above.
      throw new Error("OAuth state authorized without a consumed state");
    }

    userId = consumption.userId;

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

    const adminRejection = decideAdminAuthorization(
      (profile as { role?: string } | null)?.role,
    );
    log(adminRejection ? "error" : "info", OPERATION, {
      event: "admin_verification",
      result: adminRejection ? "failure" : "success",
      isAdmin: !adminRejection,
      userId,
    });
    if (adminRejection) {
      return json({ error: adminRejection.error }, adminRejection.status);
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
    // `permissionId` is the stable Google account identity (Drive's `User`
    // resource). It is requested from this SAME call — no extra Google request
    // and no scope change — alongside the existing identity and quota fields.
    const aboutUrl = new URL(DRIVE_ABOUT_URL);
    aboutUrl.searchParams.set(
      "fields",
      "user(permissionId,emailAddress,displayName),storageQuota(limit,usage)",
    );

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
      user?: {
        permissionId?: string;
        emailAddress?: string;
        displayName?: string;
      };
      storageQuota?: {
        limit?: string | null;
        usage?: string | null;
      } | null;
    };
    const email = about.user?.emailAddress?.trim() ?? "";
    const displayName = about.user?.displayName?.trim() ?? "";
    // Stable Google identity. Opaque; may legitimately be absent.
    const googlePermissionId = about.user?.permissionId?.trim() ?? "";
    const storageLimit = normalizeGoogleByteCount(about.storageQuota?.limit);
    const storageUsage = normalizeGoogleByteCount(about.storageQuota?.usage);
    const storageAvailable = storageLimit !== null && storageUsage !== null
      ? (() => {
          const available = BigInt(storageLimit) - BigInt(storageUsage);
          return (available >= 0n ? available : 0n).toString();
        })()
      : null;
    const hasValidQuotaResponse =
      about.storageQuota !== null && typeof about.storageQuota === "object";

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
      // Opaque stable identity; safe to log, never returned to the client.
      googlePermissionId: googlePermissionId || null,
    });

    // ── 5. Find an existing account (reconnect, never duplicate) ───────────
    const { data: existing, error: existingError } = await admin
      .from("drive_accounts")
      .select(
        "id, status, enabled, connection_status, health_status, refresh_token_secret_id, google_permission_id",
      )
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
      enabled: boolean | null;
      connection_status: string | null;
      health_status: string | null;
      refresh_token_secret_id: string | null;
      google_permission_id: string | null;
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

    // ── 5b. Reconcile the stable Google identity ────────────────────────────
    // `google_email` remains the matching key. `google_permission_id` exists to
    // catch what the email cannot: the same address now belonging to a
    // DIFFERENT Google account. Re-pointing an existing row at a different
    // Google account would silently hand one party's media archive to another,
    // so that case is refused rather than resolved.
    //
    // No write has happened at this point, so a conflict aborts with no side
    // effects — the stored credential, Vault secret and account row are intact.
    const permissionDecision = decideGooglePermissionId(
      existingRow?.google_permission_id ?? null,
      googlePermissionId,
    );

    log(permissionDecision.action === "conflict" ? "error" : "info", OPERATION, {
      event: "google_identity_reconciliation",
      result: permissionDecision.action === "conflict" ? "failure" : "success",
      userId,
      email,
      action: permissionDecision.action,
      accountId: existingRow?.id ?? null,
      existingPermissionId: existingRow?.google_permission_id ?? null,
      incomingPermissionId: googlePermissionId || null,
    });

    if (permissionDecision.action === "conflict") {
      return json({ error: PERMISSION_ID_CONFLICT_MESSAGE }, 409);
    }

    /** True when this run should stamp `google_permission_id`. */
    const shouldStampIdentity = permissionIdNeedsWrite(permissionDecision);

    // A brand-new account (or one without a credential) is useless without a
    // refresh token. An account that ALREADY holds a credential keeps it:
    // Google omits `refresh_token` whenever the account previously authorized
    // the app, and that is a successful re-authorization, not a failure — so an
    // otherwise valid credential must NOT be left in `reauth_required` (D5-a).
    const refreshDecision = decideRefreshTokenHandling(
      refreshToken,
      existingHasSecret,
    );

    log(refreshDecision.reject ? "error" : "info", OPERATION, {
      event: "refresh_token_check",
      result: refreshDecision.reject ? "failure" : "success",
      userId,
      email,
      newRefreshTokenReturned: Boolean(refreshToken),
      existingHasSecret,
      action: refreshDecision.store
        ? "store_new_token"
        : (refreshDecision.reject ? "reject" : "preserve_existing_secret"),
      ...(refreshDecision.reject
        ? { reason: "missing_refresh_token_for_new_account" }
        : {}),
    });

    if (refreshDecision.reject) {
      return json({ error: REFRESH_TOKEN_REQUIRED_MESSAGE }, 400);
    }

    const now = new Date().toISOString();
    let accountId: string;
    let refreshTokenStored = false;

    if (existingRow) {
      // Reconnect the existing row (matched by google_email). Never insert a
      // second account. Restore connection/health from this proven Drive API
      // call even when Google omits a new refresh token, so last_error is not
      // left behind after a successful re-authorization.
      const reconnectAccount: ReconnectAccountState = {
        status: existingRow.status,
        enabled: existingRow.enabled,
        health_status: existingRow.health_status,
      };
      const patch = planReconnectPatch(reconnectAccount, now);

      // Guard: re-authorization restores credentials and health, but must never
      // disturb account identity, admin-controlled routing/capacity state, or
      // the stored secret reference. A migration feature will add its own
      // guard on top of this (see the deferred note in the handler docs).
      if (patchTouchesProtectedField(patch)) {
        log("error", OPERATION, {
          event: "drive_account_update",
          result: "failure",
          userId,
          accountId: existingRow.id,
          errorName: "ProtectedFieldGuard",
          errorMessage:
            "Refusing to reconnect with a patch that touches protected fields",
        });
        throw new Error(
          "Refusing to reconnect with a patch that touches protected fields",
        );
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

    // ── 5c. Stamp the stable Google identity ────────────────────────────────
    // One narrow write to exactly one column, applied identically on the
    // reconnect and new-account paths. It is deliberately NOT part of the
    // lifecycle patch: knowing the stable identity must not be able to
    // influence health, connection, status or routing, and an account is NOT
    // marked healthy merely because this field became known.
    //
    // `updated_at` is maintained by the existing `set_updated_at` trigger.
    //
    // Failure here is logged but non-fatal: the account is fully usable without
    // the identity, and the next successful OAuth event re-attempts the stamp
    // (`decideGooglePermissionId` returns `set` for any row with no value).
    // A transient write failure must not block connecting a Drive account.
    if (shouldStampIdentity) {
      const { error: identityError } = await admin
        .from("drive_accounts")
        .update(planIdentityPatch(googlePermissionId))
        .eq("id", accountId)
        // Only fill an empty slot, so a concurrent callback cannot be clobbered
        // and the write stays idempotent.
        .is("google_permission_id", null);

      log(identityError ? "error" : "info", OPERATION, {
        event: "google_identity_store",
        result: identityError ? "failure" : "success",
        userId,
        email,
        accountId,
        googlePermissionId,
        ...(identityError ? dbErrorFields(identityError) : {}),
      });
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

    if (hasValidQuotaResponse) {
      const quotaPatch = {
        storage_limit_bytes: storageLimit,
        storage_used_bytes: storageUsage,
        storage_available_bytes: storageAvailable,
        last_quota_check_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const { error: quotaError } = await admin
        .from("drive_accounts")
        .update(quotaPatch)
        .eq("id", accountId);

      if (quotaError) {
        log("error", OPERATION, {
          event: "drive_quota_sync",
          result: "failure",
          userId,
          accountId,
          email,
          hasStorageLimit: storageLimit !== null,
          hasStorageUsage: storageUsage !== null,
          errorName: "PostgrestError",
          errorMessage: quotaError.message,
          ...dbErrorFields(quotaError),
        });
      } else {
        log("info", OPERATION, {
          event: "drive_quota_sync",
          result: "success",
          userId,
          accountId,
          email,
          hasStorageLimit: storageLimit !== null,
          hasStorageUsage: storageUsage !== null,
        });
      }
    } else {
      log("info", OPERATION, {
        event: "drive_quota_sync",
        result: "skipped",
        userId,
        accountId,
        email,
        reason: "quota_data_missing_from_successful_about_response",
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
