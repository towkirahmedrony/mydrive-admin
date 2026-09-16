import { serve } from "jsr:@std/http";
import { corsHeaders, handleCors } from "../shared/cors.ts";
import { getSupabaseAdmin, getSupabaseAuth } from "../shared/auth.ts";

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
 *
 * Usage:
 *   POST /functions/v1/drive-admin
 *   Headers: Authorization: Bearer <admin user JWT>, apikey: <anon key>
 *   Body: { "action": "...", ... }
 *
 * Actions:
 *   { "action": "list" }
 *   { "action": "create", "google_email": "...", "display_name": "...",
 *     "name": "...", "priority": 100, "enabled": true,
 *     "root_folder_id": "...", "notes": "...", "refresh_token": "..." }
 *   { "action": "update", "id": "<uuid>", "display_name": "...", ... }
 *   { "action": "set_secret", "id": "<uuid>", "refresh_token": "..." }
 *   { "action": "set_enabled", "id": "<uuid>", "enabled": true }
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

const UPDATABLE_FIELDS = new Set([
  "name",
  "display_name",
  "google_email",
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
  "notes",
]);

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

serve(async (req: Request) => {
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

  const insert: Record<string, unknown> = { google_email: googleEmail };
  for (const field of UPDATABLE_FIELDS) {
    if (field in body && body[field] !== undefined) {
      insert[field] = body[field];
    }
  }
  if (insert.name === undefined) insert.name = "Google Drive";

  const { data, error } = await admin
    .from("drive_accounts")
    .insert(insert)
    .select(ACCOUNT_SELECT_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return json(
        { error: "A Drive account with that email already exists" },
        409,
      );
    }
    throw new Error(`Failed to create Drive account: ${error.message}`);
  }

  const created = data as unknown as Record<string, unknown>;

  if (typeof body.refresh_token === "string" && body.refresh_token.trim()) {
    await storeRefreshToken(admin, created.id as string, body.refresh_token);
    return await getAccount(admin, created.id as string);
  }

  return json({ success: true, account: publicAccount(created) }, 201);
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

  const { error } = await admin
    .from("drive_accounts")
    .update({
      enabled: body.enabled,
      status: body.enabled ? "active" : "disabled",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to toggle Drive account: ${error.message}`);
  }
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
