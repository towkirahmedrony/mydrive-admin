/**
 * Server-only: minting and verifying short-lived media access grants, plus the
 * guard that decides which upstream URL the proxy may fetch.
 *
 * Why this layer exists
 * ---------------------
 * `media_assets.storage_url` / `thumbnail_url` are permanent provider URLs
 * (ImageKit / Cloudinary delivery URLs). Handing those to the browser means the
 * DOM, devtools, browser history and any screenshot carry a link that never
 * expires, and it means the client holds a storage locator it does not need.
 *
 * Instead the admin panel hands the browser a compact admin route:
 *
 *     /admin/media/<userId>/asset/<mediaId>?e=<expiry>&t=<signature>
 *
 * Verified by `src/app/admin/media/[userId]/asset/[mediaId]/route.ts`, which:
 *   1. re-checks the Supabase admin session (the real authorization boundary),
 *   2. verifies this grant (integrity + expiry),
 *   3. re-checks that the asset is owned by the requested employee,
 *   4. streams the bytes with Range support so video seeks without a full
 *      download.
 *
 * The provider URL never leaves the server, no storage key is ever read here,
 * and the URL the browser keeps stops working when the grant expires.
 *
 * Signing key
 * -----------
 * `MEDIA_ACCESS_TOKEN_SECRET` is the intended key. `SUPABASE_SERVICE_ROLE_KEY`
 * is used as a fallback when present (already server-only). If neither is set
 * the public anon key is used, which still binds a grant to an employee and an
 * expiry but is not secret — that is acceptable because the session check in
 * the route handler remains the authorization boundary, and the signature only
 * needs to carry integrity and expiry. Set the dedicated secret to keep the
 * signature confidential as well.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { MEDIA_ACCESS_TTL_SECONDS, type MediaAccessGrant } from "@/lib/media-types";

/** Upper bound accepted when verifying, so a forged far-future expiry is rejected. */
const MAX_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;

function signingKey(): string {
  const dedicated = process.env.MEDIA_ACCESS_TOKEN_SECRET?.trim();
  if (dedicated) return dedicated;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (serviceRole) return serviceRole;
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
}

function sign(userId: string, expiresAt: number): string {
  return createHmac("sha256", signingKey())
    .update(`media-access.v1.${userId}.${expiresAt}`)
    .digest("base64url");
}

/** Mints a grant for one employee's media set. Server-side callers only. */
export function issueMediaAccess(
  userId: string,
  ttlSeconds: number = MEDIA_ACCESS_TTL_SECONDS,
): MediaAccessGrant {
  const ttl = Math.min(
    Math.max(60, Math.trunc(ttlSeconds) || MEDIA_ACCESS_TTL_SECONDS),
    MAX_TOKEN_LIFETIME_SECONDS,
  );
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  return { token: sign(userId, expiresAt), expiresAt };
}

/** Constant-time verification of a grant presented by the browser. */
export function verifyMediaAccess(input: {
  userId: string;
  token: string | null | undefined;
  expiresAt: number;
}): boolean {
  const { userId, token, expiresAt } = input;
  if (!userId || !token) return false;
  if (!Number.isFinite(expiresAt)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (expiresAt <= now) return false;
  if (expiresAt > now + MAX_TOKEN_LIFETIME_SECONDS) return false;

  const expected = Buffer.from(sign(userId, expiresAt), "utf8");
  const received = Buffer.from(token, "utf8");
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

/** True for hosts the proxy must never reach: loopback, link-local, private ranges. */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;
  // Any bare IP literal is refused: media providers deliver from a hostname.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(":")) return true;
  return false;
}

/**
 * Validates a stored provider URL before the server fetches it, so a poisoned
 * or unexpected value in `media_assets` cannot turn the proxy into an SSRF
 * primitive: only http(s), only a hostname (never an IP literal), and never
 * loopback, link-local or private-network names.
 *
 * Set `MEDIA_ASSET_ALLOWED_HOSTS` (comma separated) to pin the exact provider
 * hostnames for a deployment; when set, that list wins over the checks above.
 */
export function isAllowedMediaUpstream(raw: string | null | undefined): boolean {
  if (!raw) return false;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  // Credentials in the URL would be harvested into a request the server makes.
  if (parsed.username || parsed.password) return false;

  const host = parsed.hostname.toLowerCase();
  const allowList = (process.env.MEDIA_ASSET_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (allowList.length > 0) {
    return allowList.some(
      (allowed) => host === allowed || host.endsWith(`.${allowed}`),
    );
  }

  return !isBlockedHost(host);
}
