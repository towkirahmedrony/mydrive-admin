/**
 * Minimal server-side Google Drive client for the MyDrive archive.
 *
 * Scope: OAuth refresh-token exchange plus FOLDER resolution/creation only.
 * This module does NOT upload media — the actual Drive replication worker is
 * intentionally out of scope for the current foundation.
 *
 * Security:
 *   - refresh tokens are only ever read from the server-side secret store and
 *     are never logged, returned to clients, or persisted in plaintext.
 *   - OAuth client credentials come from Edge Function secrets
 *     (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).
 */

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface DriveFolderClient {
  /** Returns the id of an existing folder, or null when absent. */
  findFolder(
    name: string,
    parentId: string | null,
    accessToken: string,
  ): Promise<string | null>;

  /** Creates a folder and returns its id. */
  createFolder(
    name: string,
    parentId: string | null,
    accessToken: string,
  ): Promise<string>;

  /** find-or-create. Safe to call repeatedly. */
  ensureFolder(
    name: string,
    parentId: string | null,
    accessToken: string,
  ): Promise<string>;
}

/**
 * Returns the id of an existing NON-folder file with the given name inside
 * `parentId`, or null. Used as a best-effort duplicate guard before the worker
 * creates a new Drive file for the same media (idempotency reconciliation).
 */
export async function findFileByName(
  name: string,
  parentId: string | null,
  accessToken: string,
): Promise<string | null> {
  const clauses = [
    `name = '${escapeDriveQuery(name)}'`,
    `mimeType != '${FOLDER_MIME}'`,
    "trashed = false",
  ];
  if (parentId) {
    clauses.push(`'${escapeDriveQuery(parentId)}' in parents`);
  }

  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set("q", clauses.join(" and "));
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`Drive files.list failed: HTTP ${res.status}`);
  }

  const json = await res.json() as { files?: Array<{ id?: string }> };
  const id = json.files?.[0]?.id;
  return id ?? null;
}

export interface AccessTokenResult {
  accessToken: string;
  expiresInSeconds: number;
}

/**
 * Exchanges a stored refresh token for a short-lived access token.
 * The refresh token is held only in memory for the duration of the call.
 */
export async function getDriveAccessToken(params: {
  refreshToken: string;
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
}): Promise<AccessTokenResult> {
  const clientId = params.clientId ?? Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = params.clientSecret ??
    Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new Error(
      "Google OAuth client credentials missing (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET)",
    );
  }
  if (!params.refreshToken) {
    throw new Error("Missing Google Drive refresh token");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: params.refreshToken,
    grant_type: "refresh_token",
  });

  const fetchImpl = params.fetchImpl ?? fetch;
  const res = await fetchImpl(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    // Never include the response body verbatim: it can echo token hints.
    throw new Error(
      `Google OAuth token exchange failed: HTTP ${res.status}`,
    );
  }

  const json = await res.json() as {
    access_token?: string;
    expires_in?: number;
  };

  if (!json.access_token) {
    throw new Error("Google OAuth token exchange returned no access token");
  }

  return {
    accessToken: json.access_token,
    expiresInSeconds: json.expires_in ?? 3600,
  };
}

export class GoogleDriveRestClient implements DriveFolderClient {
  async findFolder(
    name: string,
    parentId: string | null,
    accessToken: string,
  ): Promise<string | null> {
    const clauses = [
      `name = '${escapeDriveQuery(name)}'`,
      `mimeType = '${FOLDER_MIME}'`,
      "trashed = false",
    ];
    if (parentId) {
      clauses.push(`'${escapeDriveQuery(parentId)}' in parents`);
    }

    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set("q", clauses.join(" and "));
    url.searchParams.set("fields", "files(id,name)");
    url.searchParams.set("pageSize", "1");
    url.searchParams.set("spaces", "drive");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(`Drive files.list failed: HTTP ${res.status}`);
    }

    const json = await res.json() as { files?: Array<{ id?: string }> };
    const id = json.files?.[0]?.id;
    return id ?? null;
  }

  async createFolder(
    name: string,
    parentId: string | null,
    accessToken: string,
  ): Promise<string> {
    const metadata: Record<string, unknown> = {
      name,
      mimeType: FOLDER_MIME,
    };
    if (parentId) metadata.parents = [parentId];

    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set("fields", "id");
    url.searchParams.set("supportsAllDrives", "true");

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(metadata),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(`Drive files.create failed: HTTP ${res.status}`);
    }

    const json = await res.json() as { id?: string };
    if (!json.id) {
      throw new Error("Drive files.create returned no folder id");
    }
    return json.id;
  }

  async ensureFolder(
    name: string,
    parentId: string | null,
    accessToken: string,
  ): Promise<string> {
    const existing = await this.findFolder(name, parentId, accessToken);
    if (existing) return existing;
    return await this.createFolder(name, parentId, accessToken);
  }
}

/**
 * Escapes a value for use inside a Drive `q` string literal.
 * The database mapping remains authoritative; this is only used as a
 * best-effort secondary lookup inside the target account.
 */
export function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
