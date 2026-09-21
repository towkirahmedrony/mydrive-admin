/**
 * Decision-table tests for `src/lib/media-source.ts` — the Cloudinary →
 * Google Drive → "unavailable" priority used by the signed asset route.
 *
 * The product deletes the Cloudinary original AFTER the Drive copy is verified,
 * so the assertions that matter most are:
 *
 *   - archived media with a cleaned-up original is served from the archive and
 *     never probed against a Cloudinary URL that cannot work;
 *   - a credential problem, a timeout, a 429 or a provider outage is never
 *     reported as a deleted file — only a confirmed missing archive is;
 *   - a grid thumbnail never falls back to a full-size original.
 *
 * Run: npm run test:media-source
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanupConfirmed,
  planAfterPrimary,
  planArchiveFailure,
  planInitialSource,
  resolvePrimaryUpstream,
  type ArchiveFacts,
} from "../src/lib/media-source";

const CLOUDINARY_ORIGINAL =
  "https://res.cloudinary.com/drnbvmrq1/image/upload/v1/mydrive/u/a.jpg";
const CLOUDINARY_PREVIEW =
  "https://res.cloudinary.com/drnbvmrq1/image/upload/c_fill,w_480/mydrive/u/a.jpg";

function facts(overrides: Partial<ArchiveFacts> = {}): ArchiveFacts {
  return {
    driveArchived: true,
    cleanupStatus: "cleanup_success",
    primaryDeletedAt: "2026-09-20T23:40:08.143605+00:00",
    storageUrl: CLOUDINARY_ORIGINAL,
    previewUrl: CLOUDINARY_PREVIEW,
    variant: "original",
    upstreamAllowed: () => true,
    ...overrides,
  };
}

/* ───────────────────────── the reported bug ───────────────────────────── */

test("archived media with a cleaned-up original is served from the archive", () => {
  // This is the exact production state of all 243 archived media rows.
  const plan = planInitialSource(facts());
  assert.deepEqual(plan, { action: "use-archive" });
});

test("the archive is used without probing Cloudinary when cleanup is confirmed", () => {
  let probed = false;
  const plan = planInitialSource(
    facts({
      upstreamAllowed: () => {
        probed = true;
        return true;
      },
    }),
  );
  assert.deepEqual(plan, { action: "use-archive" });
  assert.equal(probed, false, "a cleaned-up Cloudinary URL must not be probed");
});

test("a primary_deleted_at timestamp alone is enough to confirm cleanup", () => {
  const plan = planInitialSource(
    facts({ cleanupStatus: "cleanup_failed", primaryDeletedAt: "2026-09-20T06:04:13Z" }),
  );
  assert.deepEqual(plan, { action: "use-archive" });
  assert.equal(
    cleanupConfirmed(facts({ cleanupStatus: null, primaryDeletedAt: null })),
    false,
  );
});

/* ─────────────────── priority 1: a real Cloudinary asset ──────────────── */

test("a healthy Cloudinary original is preferred over the archive", () => {
  const plan = planInitialSource(
    facts({ cleanupStatus: null, primaryDeletedAt: null }),
  );
  assert.deepEqual(plan, { action: "try-primary", upstream: CLOUDINARY_ORIGINAL });
});

test("a 404 from a non-cleaned-up original falls through to the archive", () => {
  const decision = planAfterPrimary(
    facts({ cleanupStatus: null, primaryDeletedAt: null }),
    { outcome: "missing" },
  );
  assert.deepEqual(decision, { action: "use-archive" });
});

test("a provider outage still prefers the archive when one exists", () => {
  const decision = planAfterPrimary(facts({ cleanupStatus: null }), {
    outcome: "failed",
    failure: {
      status: 502,
      reason: "provider_unavailable",
      retryable: true,
      message: "unavailable",
    },
  });
  assert.deepEqual(decision, { action: "use-archive" });
});

/* ────────────── priority 3: the real "unavailable" answers ────────────── */

test("cleanup confirmed with no archive is the only media-gone answer", () => {
  const plan = planInitialSource(facts({ driveArchived: false }));
  assert.equal(plan.action, "fail");
  assert.equal(plan.action === "fail" && plan.failure.reason, "file_unavailable");
  assert.equal(plan.action === "fail" && plan.failure.status, 404);
});

test("a 404 with no archive is also a confirmed-gone answer", () => {
  const decision = planAfterPrimary(facts({ driveArchived: false }), {
    outcome: "missing",
  });
  assert.equal(decision.action, "fail");
  assert.equal(
    decision.action === "fail" && decision.failure.reason,
    "file_unavailable",
  );
});

test("a provider fault with no archive stays retryable and is not 'deleted'", () => {
  const decision = planAfterPrimary(facts({ driveArchived: false }), {
    outcome: "failed",
    failure: {
      status: 504,
      reason: "provider_unavailable",
      retryable: true,
      message: "The media provider could not be reached from the server.",
    },
  });
  assert.equal(decision.action, "fail");
  assert.equal(
    decision.action === "fail" && decision.failure.reason,
    "provider_unavailable",
  );
  assert.equal(decision.action === "fail" && decision.failure.retryable, true);
});

test("a record with no usable source at all is a metadata fault, not a deletion", () => {
  // No archive, no provider URL, and no recorded cleanup: the record itself is
  // incomplete, which is a metadata fault rather than a deleted file.
  const plan = planInitialSource(
    facts({
      driveArchived: false,
      storageUrl: null,
      previewUrl: null,
      cleanupStatus: null,
      primaryDeletedAt: null,
    }),
  );
  assert.equal(plan.action, "fail");
  assert.equal(plan.action === "fail" && plan.failure.reason, "invalid_metadata");
  assert.equal(plan.action === "fail" && plan.failure.status, 422);
});

test("a disallowed provider host falls back to the archive, or is rejected", () => {
  const blocked = facts({ upstreamAllowed: () => false });
  assert.deepEqual(planInitialSource(blocked), { action: "use-archive" });
  assert.equal(
    planInitialSource({ ...blocked, driveArchived: false }).action,
    "fail",
  );
});

/* ──────────────────────────── thumbnails ─────────────────────────────── */

test("a grid thumbnail prefers the derived preview, never the original", () => {
  assert.equal(
    resolvePrimaryUpstream(
      facts({ variant: "thumb", previewUrl: CLOUDINARY_PREVIEW }),
    ),
    CLOUDINARY_PREVIEW,
  );
});

test("an archived tile with no derivable preview goes to Drive, not the original", () => {
  assert.equal(
    resolvePrimaryUpstream(facts({ variant: "thumb", previewUrl: null })),
    null,
  );
  assert.deepEqual(
    planInitialSource(facts({ variant: "thumb", previewUrl: null, cleanupStatus: null })),
    { action: "use-archive" },
  );
});

test("an unarchived tile with no derivable preview may use the original", () => {
  assert.equal(
    resolvePrimaryUpstream(
      facts({ variant: "thumb", previewUrl: null, driveArchived: false }),
    ),
    CLOUDINARY_ORIGINAL,
  );
});

/* ──────────────────── archive failure → browser reason ────────────────── */

test("archive_missing is the only archive failure reported as unavailable", () => {
  const failure = planArchiveFailure("archive_missing", 404, false);
  assert.equal(failure.reason, "file_unavailable");
  assert.equal(failure.status, 404);
  assert.equal(failure.retryable, false);
});

test("a Drive credential problem is reported as an account problem", () => {
  for (const reason of ["credential_error", "account_missing", "account_disabled"]) {
    const failure = planArchiveFailure(reason, 503, false);
    assert.equal(failure.reason, "archive_credential_error", reason);
    assert.equal(failure.status, 503);
    assert.notEqual(failure.reason, "file_unavailable");
  }
});

test("transient archive failures are retryable and never 'file_unavailable'", () => {
  const failure = planArchiveFailure("provider_unavailable", 502, true);
  assert.equal(failure.reason, "archive_unavailable");
  assert.equal(failure.retryable, true);
  assert.notEqual(failure.reason, "file_unavailable");

  assert.equal(planArchiveFailure("provider_unavailable", 429, true).status, 429);
});

test("no_preview, auth, ownership and range failures each stay distinguishable", () => {
  assert.equal(planArchiveFailure("no_preview", 404, false).reason, "archive_no_preview");
  assert.equal(planArchiveFailure("unauthenticated", 401, false).status, 401);
  assert.equal(planArchiveFailure("ownership_mismatch", 403, false).status, 403);
  assert.equal(planArchiveFailure("forbidden", 403, false).status, 403);
  assert.equal(
    planArchiveFailure("range_not_satisfiable", 416, false).status,
    416,
  );
  assert.equal(planArchiveFailure("media_not_found", 404, false).reason, "media_not_found");
});

test("only a confirmed missing archive maps to the deleted-file message", () => {
  const reasons = [
    "no_preview",
    "credential_error",
    "account_missing",
    "account_disabled",
    "unauthenticated",
    "forbidden",
    "ownership_mismatch",
    "range_not_satisfiable",
    "media_not_found",
    "provider_unavailable",
    "unreachable",
    "server_error",
    "",
  ];
  for (const reason of reasons) {
    const failure = planArchiveFailure(reason, 500, true);
    assert.notEqual(
      failure.reason,
      "file_unavailable",
      `reason ${reason} must not be reported as a deleted file`,
    );
  }
});
