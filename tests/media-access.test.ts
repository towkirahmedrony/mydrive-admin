/**
 * Grant-stability tests for `src/lib/media-access.ts`.
 *
 * These exist because the performance bug and the caching fix both live here.
 * A grant used to be minted as "now + TTL", so every page render produced a new
 * `?e=&t=` pair, every thumbnail url changed on every refresh, and the browser
 * cache could never be reused — the grid re-fetched every tile through the
 * server to Google Drive on each load.
 *
 * The assertions below pin the two properties that make browser caching work
 * without weakening the grant:
 *   1. two renders inside the same window mint the SAME url;
 *   2. only the current, previous and next windows are accepted, so a forged or
 *      stale expiry cannot be extended into a long-lived url.
 *
 * Run: npm run test:media-access
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { issueMediaAccess, verifyMediaAccess } from "../src/lib/media-access";

const USER = "b2114a98-de9c-4e5e-add3-ac60e1414e6e";
const OTHER_USER = "036a2dc1-8a8b-4f5f-9a0d-0f859b5141cc";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

test("two renders in the same window mint an identical grant", () => {
  const first = issueMediaAccess(USER);
  const second = issueMediaAccess(USER);

  // Identical token AND identical expiry: the thumbnail url is byte-identical,
  // which is what lets the browser reuse its cached copy instead of paying for
  // a fresh Drive request on every refresh.
  assert.equal(second.token, first.token);
  assert.equal(second.expiresAt, first.expiresAt);
});

test("the minted grant verifies, and is bound to its employee", () => {
  const grant = issueMediaAccess(USER);

  assert.equal(
    verifyMediaAccess({
      userId: USER,
      token: grant.token,
      expiresAt: grant.expiresAt,
    }),
    true,
  );

  assert.equal(
    verifyMediaAccess({
      userId: OTHER_USER,
      token: grant.token,
      expiresAt: grant.expiresAt,
    }),
    false,
  );
});

test("a grant stays usable across a window boundary", () => {
  // Previous window: a url minted a moment before the boundary must keep
  // working, otherwise every cached tile would break at the boundary.
  const windowSeconds = 6 * 60 * 60;
  const now = nowSeconds();
  const previousWindowEnd = Math.floor(now / windowSeconds) * windowSeconds;
  const grant = issueMediaAccess(USER);

  assert.notEqual(previousWindowEnd, grant.expiresAt);
  // The real boundary case: the token minted in the previous window verifies.
  const previousToken = (() => {
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const secret = process.env.MEDIA_ACCESS_TOKEN_SECRET ??
      process.env.SUPABASE_SERVICE_ROLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
      "";
    return createHmac("sha256", secret)
      .update(`media-access.v2.${USER}.${previousWindowEnd}`)
      .digest("base64url");
  })();

  assert.equal(
    verifyMediaAccess({
      userId: USER,
      token: previousToken,
      expiresAt: previousWindowEnd,
    }),
    true,
  );
});

test("distant windows and forged expiries are rejected", () => {
  const windowSeconds = 6 * 60 * 60;
  const now = nowSeconds();
  const farFuture = (Math.floor(now / windowSeconds) + 40) * windowSeconds;

  // Signature valid for a far-future expiry, but the window itself is not one
  // the server accepts: the grant cannot be stretched into a long-lived url.
  const { createHmac } = require("node:crypto") as typeof import("node:crypto");
  const secret = process.env.MEDIA_ACCESS_TOKEN_SECRET ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    "";
  const forged = createHmac("sha256", secret)
    .update(`media-access.v2.${USER}.${farFuture}`)
    .digest("base64url");

  assert.equal(
    verifyMediaAccess({ userId: USER, token: forged, expiresAt: farFuture }),
    false,
  );
});

test("a tampered expiry or missing token is rejected", () => {
  const grant = issueMediaAccess(USER);

  assert.equal(
    verifyMediaAccess({
      userId: USER,
      token: grant.token,
      expiresAt: grant.expiresAt + 1,
    }),
    false,
  );
  assert.equal(
    verifyMediaAccess({ userId: USER, token: null, expiresAt: grant.expiresAt }),
    false,
  );
  assert.equal(
    verifyMediaAccess({ userId: USER, token: "deadbeef", expiresAt: grant.expiresAt }),
    false,
  );
  assert.equal(
    verifyMediaAccess({ userId: USER, token: grant.token, expiresAt: Number.NaN }),
    false,
  );
});
