import { corsHeaders, handleCors } from "../shared/cors.ts";
import { getSupabaseAdmin, getSupabaseAuth } from "../shared/auth.ts";
import { accessTokenForAccount } from "../shared/drive-folders.ts";
import {
  fetchDriveAbout,
  httpStatusFromError,
} from "../shared/google-drive.ts";

/**
 * drive-admin — ADMIN-ONLY management of the Google Drive account pool.
 *
 * The admin can add/update/enable/disable ANY number of Drive accounts; there
 * is no hardcoded account limit. This function never uploads media and never
 * returns secrets.
 *
 * Security:
 *   - requires a valid user JWT AND profiles.role = 'admin'
 *   - uses the service-role client only after the admin check
 *   - never returns the refresh token or its Vault secret reference
 *   - refresh tokens are written to Supabase Vault via
 *     admin_store_drive_refresh_token() and only the secret reference is
 *     persisted on drive_accounts
 *   - the health/quota check talks to Google server-side only; the browser
 *     never receives a token, and nothing token-bearing is ever logged
 *
 * Usage:
 *   POST /functions/v1/drive-admin
 *   Headers: Authorization: Bearer <admin user JWT>, apikey: <anon key>
 *   Body: { "action": "...", ... }
 *
 * Actions:
 *   { "action": "list" }
 *   { "action": "create", "google_email": "...", "refresh_token": "...",
 *     "name": "...", "display_name": "...", "priority": 100, "enabled": true,
 *     "reserved_bytes": 0, "root_folder_id": "...", "notes": "..." }
 *   { "action": "update", "id": "<uuid>", "priority": 10, ... }
 *   { "action": "set_secret", "id": "<uuid>", "refresh_token": "..." }
 *   { "action": "set_enabled", "id": "<uuid>", "enabled": true }
 *   { "action": "refresh_health", "id": "<uuid>" }
 *   { "action": "routing", "required_bytes": 1234567 }
 *
 * Only configuration fields are writable through `create`/`update`. Health,
 * connection, status and quota/storage values are server-managed: they come
 * from a real Google API call (refresh_health) or from the OAuth callback, so
 * the Admin Panel can never show or set invented quota/health numbers.
 */

// Includes refresh_token_secret_id so `has_refresh_token` can be computed;
// publicAccount() strips it before anything is returned to the caller.
const ACCOUNT_SELECT_COLUMNS = [
  "id",
  "name",
  "display_name",
  "google_email",
  "refresh_token_secret_id",
  "root_folder_id",
  "priority",
  "enabled",
  "status",
  "connection_status",
  "health_status",
  "storage_limit_bytes",
  "storage_used_bytes",
  "storage_available_bytes",
  "reserved_bytes",
  "last_quota_check_at",
  "last_health_check_at",
  "refresh_token_updated_at",
  "last_error",
  "last_error_at",
  "notes",
  "created_at",
  "updated_at",
].join(", ");

// Configuration-only. Status/health/connection/quota/storage and the
// refresh-token reference are server-managed: writing them by hand would let
// the panel show routing data that no real Google call ever produced.
const UPDATABLE_FIELDS = new Set([
  "name",
  "display_name",
  "root_folder_id",
  "priority",
  "enabled",
  "reserved_bytes",
  "notes",
]);

// Default used when app_settings has no row (mirrors the routing SQL default).
const DEFAULT_SAFETY_MARGIN_BYTES = 1073741824n; // 1 GiB

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AdminClient = ReturnType<typeof getSupabaseAdmin>;

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    status,
  });
}

function publicAccount(row: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...row };
  delete out.refresh_token_secret_id;
  out.has_refresh_token = Boolean(row.refresh_token_secret_id);
  return out;
}

async function assertAdmin(
  admin: AdminClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Admin check failed: ${error.message}`);
  }
  return (data as { role?: string } | null)?.role === "admin";
}

// Deno.serve is used instead of `import { serve } from "jsr:@std/http"`:
// the deployed edge runtime resolves that module to a version that does NOT
// export `serve`, which made this function fail with
// "worker boot error: ... does not provide an export named 'serve'".
// The repo's OAuth functions already rely on the built-in Deno.serve.
Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const { user } = await getSupabaseAuth(req);
    const admin = getSupabaseAdmin();

    if (!(await assertAdmin(admin, user.id))) {
      return json({ error: "Admin privileges required" }, 403);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const action = typeof body.action === "string" ? body.action : "";

    switch (action) {
      case "list":
        return await listAccounts(admin);
      case "create":
        return await createAccount(admin, body);
      case "update":
        return await updateAccount(admin, body);
      case "set_secret":
        return await setSecret(admin, body);
      case "set_enabled":
        return await setEnabled(admin, body);
      case "refresh_health":
        return await refreshHealth(admin, body);
      case "routing":
        return await routingPreview(admin, body);
      default:
        return json({ error: `Unknown action: ${action || "(missing)"}` }, 400);
    }
  } catch (error) {
    const message = (error as Error).message;
    const isAuthError = message.includes("Missing Authorization") ||
      message.includes("Invalid or expired token");
    console.error(
      "drive-admin failed:",
      isAuthError ? "auth error" : message,
    );
    return json({ error: message }, isAuthError ? 401 : 500);
  }
});

async function listAccounts(admin: AdminClient): Promise<Response> {
  const { data, error } = await admin
    .from("drive_accounts")
    .select(ACCOUNT_SELECT_COLUMNS)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to list Drive accounts: ${error.message}`);
  }

  const accounts = (data as unknown as Record<string, unknown>[] | null) ?? [];
  return json({ success: true, accounts: accounts.map(publicAccount) }, 200);
}

async function createAccount(
  admin: AdminClient,
  body: Record<string, unknown>,
): Promise<Response> {
  const googleEmail = typeof body.google_email === "string"
    ? body.google_email.trim()
    : "";
  if (!googleEmail) {
    return json({ error: "google_email is required" }, 400);
  }

  const refreshToken = typeof body.refresh_token === "string"
    ? body.refresh_token
    : "";
  if (!refreshToken.trim()) {
    // Every drive account must be bound to a stored credential: the live
    // schema requires refresh_token_secret_id, and a credential-less account
    // could never be routed to. Connect through the OAuth flow to obtain one.
    return json(
      {
        error:
          "refresh_token is required — connect the account through the Google OAuth flow",
      },
      400,
    );
  }

  const config: Record<string, unknown> = {};
  for (const field of UPDATABLE_FIELDS) {
    if (field in body && body[field] !== undefined) {
      config[field] = body[field];
    }
  }
  const name = typeof body.name === "string" && body.name.trim()
    ? body.name.trim()
    : googleEmail;

  // Creation and credential storage are atomic in this RPC (account row +
  // Vault secret), so a failure can never leave a half-connected account.
  const { data: createdId, error } = await admin.rpc(
    "admin_create_drive_account_with_refresh_token",
    {
      p_google_email: googleEmail,
      p_name: name,
      p_refresh_token: refreshToken,
    },
  );

  if (error) {
    if (error.code === "23505") {
      return json(
        { error: "A Drive account with that email already exists" },
        409,
      );
    }
    throw new Error(`Failed to create Drive account: ${error.message}`);
  }

  const accountId = typeof createdId === "string" ? createdId.trim() : "";
  if (!UUID_RE.test(accountId)) {
    throw new Error(
      "admin_create_drive_account_with_refresh_token returned an invalid account id",
    );
  }

  if (Object.keys(config).length > 0) {
    const { error: configError } = await admin
      .from("drive_accounts")
      .update({ ...config, updated_at: new Date().toISOString() })
      .eq("id", accountId);
    if (configError) {
      throw new Error(
        `Drive account created but configuration failed: ${configError.message}`,
      );
    }
  }

  console.log(
    `drive-admin created account ${accountId} (credentials stored in Vault)`,
  );
  return await getAccount(admin, accountId);
}

async function updateAccount(
  admin: AdminClient,
  body: Record<string, unknown>,
): Promise<Response> {
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!UUID_RE.test(id)) {
    return json({ error: "id must be a valid UUID" }, 400);
  }

  const patch: Record<string, unknown> = {};
  for (const field of UPDATABLE_FIELDS) {
    if (field in body && body[field] !== undefined) {
      patch[field] = body[field];
    }
  }
  if (Object.keys(patch).length === 0) {
    return json({ error: "No updatable fields provided" }, 400);
  }
  patch.updated_at = new Date().toISOString();

  const { error } = await admin
    .from("drive_accounts")
    .update(patch)
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to update Drive account: ${error.message}`);
  }
  return await getAccount(admin, id);
}

async function setSecret(
  admin: AdminClient,
  body: Record<string, unknown>,
): Promise<Response> {
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!UUID_RE.test(id)) {
    return json({ error: "id must be a valid UUID" }, 400);
  }
  const refreshToken = typeof body.refresh_token === "string"
    ? body.refresh_token
    : "";
  if (!refreshToken.trim()) {
    return json({ error: "refresh_token is required" }, 400);
  }

  await storeRefreshToken(admin, id, refreshToken);
  return await getAccount(admin, id);
}

async function setEnabled(
  admin: AdminClient,
  body: Record<string, unknown>,
): Promise<Response> {
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!UUID_RE.test(id)) {
    return json({ error: "id must be a valid UUID" }, 400);
  }
  if (typeof body.enabled !== "boolean") {
    return json({ error: "enabled must be a boolean" }, 400);
  }

  // Disabling only removes the account from the routing pool. It never deletes
  // files, folder mappings, replication jobs or media metadata: everything that
  // was already archived on this account stays valid historical storage.
  // Re-enabling restores 'active' only when the account was disabled; an
  // account that needs re-authorization stays 'reauth_required' until a health
  // check or the OAuth flow actually fixes it.
  const enabled = body.enabled;
  const patch: Record<string, unknown> = {
    enabled,
    updated_at: new Date().toISOString(),
  };
  if (!enabled) {
    patch.status = "disabled";
  }

  const { error } = await admin
    .from("drive_accounts")
    .update(patch)
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to toggle Drive account: ${error.message}`);
  }

  if (enabled) {
    const { error: restoreError } = await admin
      .from("drive_accounts")
      .update({ status: "active", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "disabled");
    if (restoreError) {
      throw new Error(
        `Failed to re-enable Drive account: ${restoreError.message}`,
      );
    }
  }

  await admin.from("sync_logs").insert({
    event_type: "drive_account_toggled",
    status: "success",
    message: `Drive account ${id} ${enabled ? "enabled" : "disabled"}`,
    metadata: { drive_account_id: id, enabled },
  });

  return await getAccount(admin, id);
}

async function storeRefreshToken(
  admin: AdminClient,
  accountId: string,
  refreshToken: string,
): Promise<void> {
  const { error } = await admin.rpc("admin_store_drive_refresh_token", {
    p_drive_account_id: accountId,
    p_refresh_token: refreshToken,
  });
  if (error) {
    // The token is intentionally never echoed back.
    throw new Error(`Failed to store Drive credentials: ${error.message}`);
  }
}

async function getAccount(
  admin: AdminClient,
  id: string,
): Promise<Response> {
  const { data, error } = await admin
    .from("drive_accounts")
    .select(ACCOUNT_SELECT_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load Drive account: ${error.message}`);
  }
  if (!data) {
    return json({ error: "Drive account not found" }, 404);
  }
  return json({
    success: true,
    account: publicAccount(data as unknown as Record<string, unknown>),
  }, 200);
}

// ─── Health / quota ────────────────────────────────────────────────────────

/**
 * Server-side health + quota check for one account.
 *
 * It verifies that the stored credential can still reach the Drive API and
 * reads the real storage quota, then persists ONLY server-managed columns:
 * storage_*_bytes, last_quota_check_at, last_health_check_at, health_status,
 * connection_status, status, last_error, last_error_at.
 *
 * Health vocabulary is the one the schema already defines — health_status
 * (healthy | degraded | unhealthy | unknown) and connection_status
 * (connected | disconnected | reauth_required | error | unknown) plus the
 * existing account status (active | quota_full | reauth_required | disabled |
 * error) — so no parallel state system is introduced.
 *
 * A Google-side failure is reported in the response body (success:false) with
 * the account's real post-check state; it never throws a 500 and never crashes
 * the panel. Tokens are never logged, returned, or embedded in errors.
 */
async function refreshHealth(
  admin: AdminClient,
  body: Record<string, unknown>,
): Promise<Response> {
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!UUID_RE.test(id)) {
    return json({ error: "id must be a valid UUID" }, 400);
  }

  const { data, error } = await admin
    .from("drive_accounts")
    .select(ACCOUNT_SELECT_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load Drive account: ${error.message}`);
  }
  if (!data) {
    return json({ error: "Drive account not found" }, 404);
  }

  const account = data as unknown as Record<string, unknown>;
  const isDisabled = account.enabled === false;
  const nowIso = new Date().toISOString();
  const margin = await getSafetyMargin(admin);

  const patch: Record<string, unknown> = {
    last_health_check_at: nowIso,
    updated_at: nowIso,
  };

  // ── 1. Prove the stored credential still works ──────────────────────────
  let accessToken: string;
  try {
    accessToken = await accessTokenForAccount(admin, id);
  } catch (tokenError) {
    const message = safeMessage(tokenError);
    const httpStatus = httpStatusFromError(tokenError);
    // A refused refresh-token exchange means the stored credential is dead:
    // Google answers a revoked token with 400 invalid_grant, not 401. Only a
    // transport failure, 429 or 5xx is worth retrying without reconnecting.
    const transient = httpStatus === 0 || httpStatus === 429 || httpStatus >= 500;

    patch.last_error = message;
    patch.last_error_at = nowIso;
    if (transient) {
      patch.connection_status = "unknown";
      patch.health_status = "degraded";
    } else {
      patch.connection_status = "reauth_required";
      patch.health_status = "unhealthy";
      if (!isDisabled) patch.status = "reauth_required";
    }

    const updated = await persistHealth(admin, id, patch);
    logHealth("drive_health_check", {
      accountId: id,
      result: transient ? "credential_check_transient" : "auth_required",
      httpStatus,
    });
    return json(
      {
        success: false,
        error: transient
          ? "Google could not be reached to validate the credential; the account is marked degraded."
          : "The stored Google credential is no longer usable. Reconnect this account through the OAuth flow.",
        http_status: httpStatus,
        account: publicAccount(updated),
      },
      200,
    );
  }

  // ── 2. Real quota read straight from the Drive API ──────────────────────
  try {
    const about = await fetchDriveAbout(accessToken);

    patch.storage_limit_bytes = about.storageLimitBytes;
    patch.storage_used_bytes = about.storageUsageBytes;
    patch.storage_available_bytes = about.storageAvailableBytes;
    patch.last_quota_check_at = nowIso;
    patch.connection_status = "connected";
    patch.last_error = null;

    const available = about.storageAvailableBytes === null
      ? null
      : BigInt(about.storageAvailableBytes);
    // "below margin" is advisory reporting only; the routing decision itself
    // stays in the database (list_eligible_drive_accounts).
    const belowMargin = available === null ? null : available <= margin;

    if (isDisabled) {
      patch.status = "disabled";
      patch.health_status = "healthy";
    } else if (belowMargin === null) {
      // Google returned no usable quota, so capacity cannot be confirmed.
      patch.status = "active";
      patch.health_status = "degraded";
    } else if (belowMargin) {
      patch.status = "quota_full";
      patch.health_status = "degraded";
    } else {
      patch.status = "active";
      patch.health_status = "healthy";
    }

    const updated = await persistHealth(admin, id, patch);
    logHealth("drive_health_check", {
      accountId: id,
      result: isDisabled ? "disabled" : belowMargin ? "quota_full" : "healthy",
      httpStatus: 200,
      hasQuota: available !== null,
      safetyMarginBytes: margin.toString(),
      status: patch.status,
      healthStatus: patch.health_status,
    });

    return json(
      {
        success: true,
        account: publicAccount(updated),
        safety_margin_bytes: margin.toString(),
        quota_available: available !== null,
      },
      200,
    );
  } catch (googleError) {
    const httpStatus = httpStatusFromError(googleError);
    const message = safeMessage(googleError);
    // 400 is included because Google reports an expired/revoked grant as
    // 400 invalid_grant; 401/403 mean the token was rejected outright.
    const authProblem = httpStatus === 400 || httpStatus === 401 ||
      httpStatus === 403;

    patch.last_error = message;
    patch.last_error_at = nowIso;

    if (authProblem) {
      // The credential was revoked or lost its scope: reconnect required.
      patch.connection_status = "reauth_required";
      patch.health_status = "unhealthy";
      if (!isDisabled) patch.status = "reauth_required";
    } else {
      // Transient (429 / 5xx / network): keep the credential, drop out of
      // routing until the next successful check, and say so honestly.
      patch.connection_status = "unknown";
      patch.health_status = "degraded";
      if (!isDisabled && account.status !== "active") {
        patch.status = account.status;
      }
    }

    const updated = await persistHealth(admin, id, patch);
    logHealth("drive_health_check", {
      accountId: id,
      result: authProblem ? "auth_required" : "provider_unavailable",
      httpStatus,
      status: patch.status,
      healthStatus: patch.health_status,
    });

    return json(
      {
        success: false,
        error: authProblem
          ? "Google rejected the stored credential. Reconnect this account."
          : "Google Drive could not be reached; the account is marked degraded and will be retried.",
        http_status: httpStatus,
        account: publicAccount(updated),
      },
      200,
    );
  }
}

/** Persists a server-managed health/quota patch and returns the new row. */
async function persistHealth(
  admin: AdminClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await admin
    .from("drive_accounts")
    .update(patch)
    .eq("id", id)
    .select(ACCOUNT_SELECT_COLUMNS)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to persist Drive account health: ${error.message}`);
  }
  return (data as unknown as Record<string, unknown>) ?? {};
}

/** Current routing safety margin (app_settings), with a safe fallback. */
async function getSafetyMargin(admin: AdminClient): Promise<bigint> {
  const { data, error } = await admin
    .from("app_settings")
    .select("drive_safety_margin_bytes")
    .eq("id", true)
    .maybeSingle();

  if (error) return DEFAULT_SAFETY_MARGIN_BYTES;

  const raw = (data as { drive_safety_margin_bytes?: unknown } | null)
    ?.drive_safety_margin_bytes;
  if (raw === null || raw === undefined) return DEFAULT_SAFETY_MARGIN_BYTES;

  try {
    const value = BigInt(raw as number | string);
    return value >= 0n ? value : DEFAULT_SAFETY_MARGIN_BYTES;
  } catch {
    return DEFAULT_SAFETY_MARGIN_BYTES;
  }
}

// ─── Routing visibility (read-only) ────────────────────────────────────────

/**
 * Read-only view of the router's current decision inputs.
 *
 * Eligibility comes from the database router itself
 * (list_eligible_drive_accounts), so the panel displays routing information
 * without re-implementing — or overriding — the selection predicate.
 */
async function routingPreview(
  admin: AdminClient,
  body: Record<string, unknown>,
): Promise<Response> {
  const rawRequired = Number(body.required_bytes ?? 0);
  const requiredBytes = Number.isFinite(rawRequired) && rawRequired > 0
    ? Math.floor(rawRequired)
    : 0;

  const [{ data: eligible, error: eligibleError }, { data: all, error: allError }] =
    await Promise.all([
      admin.rpc("list_eligible_drive_accounts", {
        p_required_bytes: requiredBytes,
        p_exclude_account_ids: [],
        p_safety_margin_bytes: null,
      }),
      admin
        .from("drive_accounts")
        .select(ACCOUNT_SELECT_COLUMNS)
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true }),
    ]);

  if (eligibleError) {
    throw new Error(
      `Failed to list eligible Drive accounts: ${eligibleError.message}`,
    );
  }
  if (allError) {
    throw new Error(`Failed to list Drive accounts: ${allError.message}`);
  }

  const eligibleRows =
    (eligible as unknown as Record<string, unknown>[] | null) ?? [];
  const eligibleIds = new Set(eligibleRows.map((row) => String(row.id)));
  const allRows = (all as unknown as Record<string, unknown>[] | null) ?? [];

  return json(
    {
      success: true,
      required_bytes: requiredBytes,
      safety_margin_bytes: (await getSafetyMargin(admin)).toString(),
      total_accounts: allRows.length,
      eligible_count: eligibleRows.length,
      eligible: eligibleRows.map(publicAccount),
      accounts: allRows.map((row) => ({
        ...publicAccount(row),
        eligible: eligibleIds.has(String(row.id)),
      })),
    },
    200,
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Truncated, secret-free error message. */
function safeMessage(err: unknown): string {
  const message = (err as Error)?.message ?? "Unknown error";
  return String(message).slice(0, 500);
}

/** Structured, token-free health-check logging. */
function logHealth(
  operation: string,
  fields: Record<string, unknown>,
): void {
  console.log(
    `[GoogleDrive][${operation}] ${JSON.stringify({
      scope: "GoogleDrive",
      operation,
      timestamp: new Date().toISOString(),
      ...fields,
    })}`,
  );
}
