import { type NextRequest } from "next/server";
import {
  deriveCloudinaryThumbnailUrl,
  isAllowedMediaUpstream,
  verifyMediaAccess,
} from "@/lib/media-access";
import { loadMediaForAsset, requireAdminActor } from "@/lib/media-data";
import { isUuid, type MediaVariant } from "@/lib/media-types";
import { createClient } from "@/lib/supabase/server";

/**
 * Signed, admin-only media delivery.
 *
 *   GET /admin/media/<userId>/asset/<mediaId>?e=<expiry>&t=<signature>[&variant=thumb]
 *
 * Layered checks, cheapest first:
 *   1. grant: the HMAC minted by `issueMediaAccess` must cover this employee and
 *      must not be expired. A stale/garbage link fails here, before any DB or
 *      network work.
 *   2. session: the caller must still be an authenticated admin (`profiles.role`).
 *      This is the authorization boundary; the signature only adds integrity and
 *      expiry.
 *   3. ownership: the asset is looked up with `owner_id = userId` in the query,
 *      so a grant for one employee can never fetch another employee's media.
 *
 * Bytes are then proxied from the provider instead of handing the browser the
 * permanent CDN URL, and the `Range` header is forwarded both ways so video
 * seeks without downloading the whole file.
 *
 * Nothing here reads a service-role key, a provider API secret or a Telegram
 * token; the browser only ever sees this route.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

function plain(status: number, message: string, headers: Record<string, string> = {}) {
  return new Response(message, {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      ...headers,
    },
  });
}

function asVariant(value: string | null): MediaVariant {
  return value === "thumb" ? "thumb" : "original";
}

/**
 * The browser should never render this as a document. `inline` keeps images and
 * video behaving normally while a sanitised filename stops any header splitting.
 */
function contentDisposition(media: {
  file_name: string | null;
  id: string;
}): string {
  const raw = (media.file_name || media.id).replace(/[\r\n"\\]/g, "_").slice(0, 120);
  const ascii = raw.replace(/[^\x20-\x7e]/g, "_") || "media";
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ userId: string; mediaId: string }> },
) {
  const { userId, mediaId } = await context.params;
  const search = request.nextUrl.searchParams;
  const expiresAt = Number(search.get("e"));
  const token = search.get("t");
  const variant = asVariant(search.get("variant"));

  if (!isUuid(userId) || !isUuid(mediaId)) {
    return plain(404, "Media not found.");
  }

  if (!verifyMediaAccess({ userId, token, expiresAt })) {
    return plain(401, "This media link is invalid or has expired.");
  }

  // Session re-check. `revalidate: 0` is not needed: a cookie-bound client is
  // always request-scoped.
  const supabase = await createClient();
  const actor = await requireAdminActor(supabase);
  if (!actor.ok) {
    return plain(actor.error === "Not authenticated." ? 401 : 403, actor.error);
  }

  const { media, error } = await loadMediaForAsset(userId, mediaId);
  if (error) return plain(502, "Media metadata could not be read.");
  if (!media) return plain(404, "Media not found.");

  const upstream =
    variant === "thumb"
      ? // Prefer a persisted preview, then derive one from the original using
        // the existing Cloudinary delivery pipeline. Never fall back to the
        // full-size original for a grid request.
        media.thumbnail_url || deriveCloudinaryThumbnailUrl(media.storage_url)
      : media.storage_url;

  if (!isAllowedMediaUpstream(upstream)) {
    return plain(422, "Media metadata does not contain a valid playable source.");
  }

  const range = request.headers.get("range");
  // Media must travel uncompressed: the browser has nothing to decode, and a
  // transformed body would invalidate the length/range headers we forward.
  const conditional: Record<string, string> = { "Accept-Encoding": "identity" };
  const ifRange = request.headers.get("if-range");
  const ifNoneMatch = request.headers.get("if-none-match");
  const ifModifiedSince = request.headers.get("if-modified-since");
  if (range) conditional.Range = range;
  if (ifRange) conditional["If-Range"] = ifRange;
  if (ifNoneMatch) conditional["If-None-Match"] = ifNoneMatch;
  if (ifModifiedSince) conditional["If-Modified-Since"] = ifModifiedSince;

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstream!, {
      headers: conditional,
      cache: "no-store",
      redirect: "follow",
    });
  } catch {
    return plain(502, "The media could not be reached from the server.");
  }

  // A provider redirect must not become an SSRF hop: re-validate the host the
  // response actually came from.
  if (upstreamResponse.redirected && !isAllowedMediaUpstream(upstreamResponse.url)) {
    return plain(502, "The media provider redirected to an untrusted host.");
  }

  if (upstreamResponse.status === 304) {
    return new Response(null, { status: 304, headers: NO_STORE_HEADERS });
  }

  if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
    if (upstreamResponse.status === 404 || upstreamResponse.status === 410) {
      return plain(404, "This file is no longer available in storage.");
    }
    if (upstreamResponse.status >= 500) {
      return plain(502, "The media provider is temporarily unavailable.");
    }
    return plain(502, "The media provider refused the request.");
  }

  const remaining = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  const headers = new Headers({
    // The grant is what expires, so the response is cached privately only for
    // the remainder of its lifetime and never by a shared/CDN cache.
    "Cache-Control": `private, max-age=${remaining}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": contentDisposition(media),
  });

  const passthrough = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ] as const;
  for (const header of passthrough) {
    const value = upstreamResponse.headers.get(header);
    if (value) headers.set(header, value);
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", media.mime_type || "application/octet-stream");
  }
  // Range support is what lets the HTML5 player seek and start playing before
  // the whole file arrives; advertise it even when the provider omitted it.
  if (!headers.has("accept-ranges")) headers.set("accept-ranges", "bytes");

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}
