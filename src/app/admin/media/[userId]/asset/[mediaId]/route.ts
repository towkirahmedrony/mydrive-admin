import { type NextRequest } from "next/server";
import {
  deriveCloudinaryThumbnailUrl,
  isAllowedMediaUpstream,
  verifyMediaAccess,
} from "@/lib/media-access";
import { getAdminAccessToken, openArchivedMedia } from "@/lib/media-drive";
import {
  planAfterPrimary,
  planArchiveFailure,
  planInitialSource,
  type ArchiveFacts,
  type MediaFailure,
} from "@/lib/media-source";
import {
  loadMediaForAsset,
  requireAdminActor,
  type MediaAssetSource,
} from "@/lib/media-data";
import { isUuid, type MediaVariant } from "@/lib/media-types";
import { createClient } from "@/lib/supabase/server";

/**
 * Signed, admin-only media delivery with archive fallback.
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
 * Source priority — Cloudinary is TEMPORARY, the Drive archive is the record:
 *
 *   1. the current Cloudinary asset, if it actually exists;
 *   2. the Google Drive archived copy, resolved from the media's own completed
 *      replication job and read through the `media-drive` Edge Function;
 *   3. a genuine "no copy available" answer.
 *
 * The production lifecycle deletes the Cloudinary original *after* the Drive
 * copy is verified, so for most historical media step 1 is expected to be
 * empty. That is a normal, healthy state and must render as the archived file —
 * not as a missing one. A cleanup status of `cleanup_success` (or a
 * `primary_deleted_at`), or a 404/410 from Cloudinary, moves the request to the
 * archive instead of reporting the media as gone.
 *
 * Nothing here reads or forwards a Google credential: the Edge Function owns
 * the Vault-backed token exchange and the browser only ever sees this route.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

function jsonFailure(failure: MediaFailure) {
  return new Response(
    JSON.stringify({
      error: failure.message,
      reason: failure.reason,
      retryable: failure.retryable,
    }),
    {
      status: failure.status,
      headers: {
        ...NO_STORE_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
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

/** Headers copied from whichever upstream actually served the bytes. */
const PASSTHROUGH_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
] as const;

/**
 * How long a response may be reused by the admin's own browser.
 *
 * Thumbnails are small, immutable per file and safe to hold; a large original
 * is not worth pinning in a browser cache, so its lifetime stays short and
 * correctness comes from revalidation instead. Both are capped by the signed
 * grant's remaining life, and both stay `private` so no shared or CDN cache can
 * ever hold an employee's media.
 */
const THUMB_CACHE_MAX_AGE = 6 * 60 * 60;
const ORIGINAL_CACHE_MAX_AGE = 10 * 60;

function buildStreamHeaders(
  upstream: Response,
  media: MediaAssetSource,
  expiresAt: number,
  source: "cloudinary" | "drive-archive",
  variant: MediaVariant,
  integrity?: string,
): Headers {
  // Never outlive the grant that authorises this exact url.
  const grantRemaining = Math.max(
    60,
    expiresAt - Math.floor(Date.now() / 1000),
  );
  const staleWhileRevalidate = variant === "thumb"
    ? `, stale-while-revalidate=${THUMB_CACHE_MAX_AGE}`
    : "";

  const headers = new Headers({
    "Cache-Control": `private, max-age=${
      variant === "thumb"
        ? Math.min(grantRemaining, THUMB_CACHE_MAX_AGE)
        : Math.min(grantRemaining, ORIGINAL_CACHE_MAX_AGE)
    }${staleWhileRevalidate}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": contentDisposition(media),
    "X-MyDrive-Media-Source": source,
  });
  if (integrity) headers.set("X-MyDrive-Archive-Integrity", integrity);

  for (const header of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(header);
    if (value) headers.set(header, value);
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", media.mime_type || "application/octet-stream");
  }
  // Range support is what lets the HTML5 player seek and start playing before
  // the whole file arrives; advertise it even when the origin omitted it.
  if (!headers.has("accept-ranges")) headers.set("accept-ranges", "bytes");
  return headers;
}

/** What the Cloudinary probe found. */
type PrimaryProbe =
  | { outcome: "ok"; response: Response }
  | { outcome: "missing" }
  | { outcome: "failed"; failure: MediaFailure };

/**
 * Probes/serves the temporary Cloudinary original (or a derived preview).
 *
 * A 404/410 is reported as `missing` rather than as an error: that is exactly
 * the expected state after cleanup, and the caller falls through to the archive.
 */
async function probePrimary(
  upstream: string,
  request: NextRequest,
): Promise<PrimaryProbe> {
  const conditional: Record<string, string> = { "Accept-Encoding": "identity" };
  const range = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  const ifNoneMatch = request.headers.get("if-none-match");
  const ifModifiedSince = request.headers.get("if-modified-since");
  if (range) conditional.Range = range;
  if (ifRange) conditional["If-Range"] = ifRange;
  if (ifNoneMatch) conditional["If-None-Match"] = ifNoneMatch;
  if (ifModifiedSince) conditional["If-Modified-Since"] = ifModifiedSince;

  let response: Response;
  try {
    response = await fetch(upstream, {
      headers: conditional,
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // A transport failure to the provider is not "the file was deleted".
    return {
      outcome: "failed",
      failure: {
        status: 504,
        reason: "provider_unavailable",
        retryable: true,
        message: "The media provider could not be reached from the server.",
      },
    };
  }

  // A provider redirect must not become an SSRF hop: re-validate the host the
  // response actually came from.
  if (response.redirected && !isAllowedMediaUpstream(response.url)) {
    return {
      outcome: "failed",
      failure: {
        status: 502,
        reason: "provider_unavailable",
        retryable: true,
        message: "The media provider redirected to an untrusted host.",
      },
    };
  }

  if (response.status === 404 || response.status === 410) {
    return { outcome: "missing" };
  }

  if (!response.ok && response.status !== 206) {
    if (response.status >= 500) {
      return {
        outcome: "failed",
        failure: {
          status: 502,
          reason: "provider_unavailable",
          retryable: true,
          message: "The media provider is temporarily unavailable.",
        },
      };
    }
    // A 4xx that is not a plain "gone" answer (401/403/429/…) is a provider
    // refusal: retryable, and never reported as a deleted file.
    return {
      outcome: "failed",
      failure: {
        status: response.status === 429 ? 429 : 502,
        reason: "provider_unavailable",
        retryable: true,
        message: "The media provider refused the request.",
      },
    };
  }

  return { outcome: "ok", response };
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
    return jsonFailure({
      status: 404,
      reason: "media_not_found",
      retryable: false,
      message: "Media not found.",
    });
  }

  if (!verifyMediaAccess({ userId, token, expiresAt })) {
    return jsonFailure({
      status: 401,
      reason: "session_required",
      retryable: true,
      message: "This media link is invalid or has expired.",
    });
  }

  // Session re-check. This is the real authorization boundary.
  const supabase = await createClient();
  const actor = await requireAdminActor(supabase);
  if (!actor.ok) {
    return jsonFailure(
      actor.error === "Not authenticated."
        ? {
          status: 401,
          reason: "session_required",
          retryable: true,
          message: "Not authenticated.",
        }
        : {
          status: 403,
          reason: "forbidden",
          retryable: false,
          message: "Not authorized.",
        },
    );
  }

  const { media, error } = await loadMediaForAsset(userId, mediaId);
  if (error) {
    return jsonFailure({
      status: 502,
      reason: "provider_unavailable",
      retryable: true,
      message: "Media metadata could not be read.",
    });
  }
  if (!media) {
    return jsonFailure({
      status: 404,
      reason: "media_not_found",
      retryable: false,
      message: "Media not found.",
    });
  }

  // Everything the source decision needs. The Drive archive relationship comes
  // from the media's own completed replication job, never from the request.
  const facts: ArchiveFacts = {
    driveArchived: media.drive_archived,
    cleanupStatus: media.primary_cleanup_status,
    primaryDeletedAt: media.primary_deleted_at,
    storageUrl: media.storage_url,
    // Prefer a persisted preview, then derive one from the original using the
    // existing Cloudinary delivery pipeline. A grid tile never pulls the
    // full-size original when the archive can supply a thumbnail.
    previewUrl: media.thumbnail_url ||
      deriveCloudinaryThumbnailUrl(media.storage_url),
    variant,
    upstreamAllowed: isAllowedMediaUpstream,
  };

  // ── 1. The current Cloudinary asset, if it actually exists ──────────────
  const initial = planInitialSource(facts);
  let decision:
    | { action: "use-archive" }
    | { action: "fail"; failure: MediaFailure };

  if (initial.action === "try-primary") {
    const probe = await probePrimary(initial.upstream, request);

    if (probe.outcome === "ok") {
      if (probe.response.status === 304) {
        return new Response(null, { status: 304, headers: NO_STORE_HEADERS });
      }
      return new Response(probe.response.body, {
        status: probe.response.status,
        statusText: probe.response.statusText,
        headers: buildStreamHeaders(
          probe.response,
          media,
          expiresAt,
          "cloudinary",
          variant,
        ),
      });
    }

    decision = planAfterPrimary(
      facts,
      probe.outcome === "missing"
        ? { outcome: "missing" }
        : { outcome: "failed", failure: probe.failure },
    );
  } else if (initial.action === "use-archive") {
    decision = { action: "use-archive" };
  } else {
    decision = { action: "fail", failure: initial.failure };
  }

  // ── 2. The Google Drive archived copy ───────────────────────────────────
  if (decision.action === "use-archive") {
    const accessToken = await getAdminAccessToken(supabase);
    const archive = await openArchivedMedia({
      mediaId: media.id,
      ownerId: media.owner_id,
      variant,
      accessToken,
      range: request.headers.get("range"),
      // Let the archive answer a conditional request with 304 instead of
      // re-sending bytes the admin's browser already has.
      ifNoneMatch: request.headers.get("if-none-match"),
      // Thumbnails are small and latency-sensitive; an original streams and may
      // legitimately take much longer to transfer.
      timeoutMs: variant === "thumb" ? 30_000 : 600_000,
    });

    if (archive.ok) {
      if (archive.upstream.status === 304) {
        return new Response(null, {
          status: 304,
          headers: buildStreamHeaders(
            archive.upstream,
            media,
            expiresAt,
            "drive-archive",
            variant,
            archive.integrity,
          ),
        });
      }
      return new Response(archive.upstream.body, {
        status: archive.upstream.status,
        statusText: archive.upstream.statusText,
        headers: buildStreamHeaders(
          archive.upstream,
          media,
          expiresAt,
          "drive-archive",
          variant,
          archive.integrity,
        ),
      });
    }

    return jsonFailure(
      planArchiveFailure(archive.reason, archive.status, archive.retryable),
    );
  }

  // ── 3. A genuine "no copy available" answer ─────────────────────────────
  // Reached only when Cloudinary is provably gone (recorded cleanup, or a
  // 404/410 from the provider) and no Drive archive exists — i.e. the server
  // confirmed the media is unavailable instead of assuming it.
  return jsonFailure(decision.failure);
}
