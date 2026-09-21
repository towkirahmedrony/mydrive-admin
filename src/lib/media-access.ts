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
import { type MediaAccessGrant } from "./media-types";

/**
 * Length of the url-stability window.
 *
 * Six hours keeps the signed url identical across a working session (so the
 * browser serves thumbnails from cache) while keeping a leaked url's useful
 * life short. `verifyMediaAccess` accepts the neighbouring windows too, so a url
 * minted a moment before a boundary keeps working across it.
 */
const MEDIA_ACCESS_WINDOW_SECONDS = 6 * 60 * 60;

function signingKey(): string {
  const dedicated = process.env.MEDIA_ACCESS_TOKEN_SECRET?.trim();
  if (dedicated) return dedicated;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (serviceRole) return serviceRole;
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
}

function sign(userId: string, expiresAt: number): string {
  return createHmac("sha256", signingKey())
    .update(`media-access.v2.${userId}.${expiresAt}`)
    .digest("base64url");
}

/**
 * The end of the window a grant belongs to.
 *
 * Grants are anchored to a fixed window instead of "now + TTL" so that two
 * renders in the same window mint the SAME url. That is what makes browser
 * caching work at all: a per-render expiry produced a new `?e=&t=` pair on
 * every page load, so every thumbnail was a cache miss and every refresh paid
 * for a full round of Drive traffic again.
 *
 * `offset` selects the previous or next window, which lets a url minted just
 * before a boundary keep working just after it.
 */
function windowEnd(offset: number, now = Math.floor(Date.now() / 1000)): number {
  const index = Math.floor(now / MEDIA_ACCESS_WINDOW_SECONDS) + offset;
  return (index + 1) * MEDIA_ACCESS_WINDOW_SECONDS;
}

/** Mints a grant for one employee's media set. Server-side callers only. */
export function issueMediaAccess(userId: string): MediaAccessGrant {
  const expiresAt = windowEnd(0);
  return { token: sign(userId, expiresAt), expiresAt };
}

/**
 * Constant-time verification of a grant presented by the browser.
 *
 * Accepts the current, previous and next window so a cached url does not stop
 * working at a window boundary, and rejects any expiry outside that band — a
 * far-future expiry cannot be forged into a long-lived url.
 */
export function verifyMediaAccess(input: {
  userId: string;
  token: string | null | undefined;
  expiresAt: number;
}): boolean {
  const { userId, token, expiresAt } = input;
  if (!userId || !token) return false;
  if (!Number.isFinite(expiresAt)) return false;

  const now = Math.floor(Date.now() / 1000);
  const allowed = new Set([windowEnd(-1, now), windowEnd(0, now), windowEnd(1, now)]);
  if (!allowed.has(Math.trunc(expiresAt))) return false;

  const expected = Buffer.from(sign(userId, Math.trunc(expiresAt)), "utf8");
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

/**
 * Derive a lightweight Cloudinary delivery URL from the persisted original.
 * Upload finalisation currently stores the original secure_url but not a
 * separate thumbnail_url, so the admin grid must use Cloudinary's delivery
 * transformations rather than requesting the full asset.
 */
export function deriveCloudinaryThumbnailUrl(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.hostname.toLowerCase() !== "res.cloudinary.com") return null;

  const marker = "/upload/";
  const uploadIndex = parsed.pathname.indexOf(marker);
  if (uploadIndex < 0) return null;

  const prefix = parsed.pathname.slice(0, uploadIndex + marker.length);
  const deliveryPath = parsed.pathname.slice(uploadIndex + marker.length);
  const segments = deliveryPath.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  const resourceType = parsed.pathname.slice(1, uploadIndex).split("/")[0];
  const isVideo = resourceType === "video";
  const last = segments.length - 1;
  if (isVideo) {
    // Cloudinary generates a poster frame from the video when the delivery
    // format is changed to JPG. `so_0` makes the selected frame deterministic.
    segments[last] = segments[last].replace(/\.[^/.]+$/, "") + ".jpg";
  }

  const transformation = isVideo
    ? "so_0,c_fill,w_480,h_360,q_auto,f_jpg"
    : "c_fill,w_480,h_360,q_auto,f_auto";
  parsed.pathname = `${prefix}${transformation}/${segments.join("/")}`;
  parsed.search = "";
  return parsed.toString();
}
