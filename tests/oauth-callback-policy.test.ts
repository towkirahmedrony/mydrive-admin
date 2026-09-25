/**
 * Authorization and re-authorization policy tests for `google-oauth-callback`.
 *
 * These cover the two invariants that matter most:
 *
 *   H1  possession of an OAuth `state` must never, by itself, authorize binding
 *       a Google Drive account — the caller must be authenticated AND must be
 *       the user the state was minted for;
 *
 *   D5  a successful re-authorization must not leave an otherwise valid
 *       credential looking broken, and must not disturb account identity,
 *       routing or capacity state.
 *
 * Everything here is pure: no network, no database, no Google account, no
 * credentials. Run with:
 *
 *     node --test tests/oauth-callback-policy.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADMIN_REQUIRED_MESSAGE,
  CALLER_AUTH_REQUIRED_MESSAGE,
  decideAdminAuthorization,
  decideGooglePermissionId,
  decideRefreshTokenHandling,
  decideStateAuthorization,
  EXPIRED_STATE_MESSAGE,
  INVALID_STATE_MESSAGE,
  patchTouchesProtectedField,
  permissionIdNeedsWrite,
  planIdentityPatch,
  planReconnectPatch,
  REAUTH_PROTECTED_FIELDS,
  type ReconnectAccountState,
  type StateConsumption,
} from "../supabase/functions/_shared/oauth-callback-policy.ts";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-09-25T12:00:00.000Z";

const consumed = (userId: string | null): StateConsumption => ({
  kind: "consumed",
  userId,
});

// ── 1. valid admin caller + matching state -> accepted ──────────────────────

test("1. authenticated caller with a matching state is accepted", () => {
  assert.equal(
    decideStateAuthorization({
      callerUserId: ADMIN_ID,
      consumption: consumed(ADMIN_ID),
    }),
    null,
  );
});

test("1b. the matched caller still has to pass the admin re-check", () => {
  assert.equal(decideAdminAuthorization("admin"), null);
});

// ── 2. valid admin caller + different user's state -> rejected ──────────────

test("2. a caller presenting another user's state is rejected", () => {
  const rejection = decideStateAuthorization({
    callerUserId: OTHER_ID,
    consumption: consumed(ADMIN_ID),
  });

  assert.notEqual(rejection, null);
  assert.equal(rejection?.status, 400);
  assert.equal(rejection?.reason, "state_caller_mismatch");
});

test("2b. mismatch, unknown state and reuse are INDISTINGUISHABLE", () => {
  const mismatch = decideStateAuthorization({
    callerUserId: OTHER_ID,
    consumption: consumed(ADMIN_ID),
  });
  const unknown = decideStateAuthorization({
    callerUserId: OTHER_ID,
    consumption: { kind: "invalid" },
  });

  // The endpoint must never disclose that a state exists but belongs to
  // somebody else.
  assert.equal(mismatch?.error, unknown?.error);
  assert.equal(mismatch?.status, unknown?.status);
  assert.equal(mismatch?.error, INVALID_STATE_MESSAGE);
});

test("2c. a state whose owner id is missing or blank is rejected", () => {
  for (const owner of [null, "", "   "]) {
    const rejection = decideStateAuthorization({
      callerUserId: ADMIN_ID,
      consumption: consumed(owner),
    });
    assert.equal(rejection?.status, 400, `owner=${JSON.stringify(owner)}`);
    assert.equal(rejection?.error, INVALID_STATE_MESSAGE);
  }
});

// ── 3. non-admin caller + valid state -> rejected ───────────────────────────

test("3. a non-admin actor is refused even with a valid state", () => {
  const callerOk = decideStateAuthorization({
    callerUserId: ADMIN_ID,
    consumption: consumed(ADMIN_ID),
  });
  assert.equal(callerOk, null, "state authorization passes first");

  const rejection = decideAdminAuthorization("user");
  assert.equal(rejection?.status, 403);
  assert.equal(rejection?.error, ADMIN_REQUIRED_MESSAGE);
});

test("3b. a null/absent role is refused", () => {
  assert.equal(decideAdminAuthorization(null)?.status, 403);
  assert.equal(decideAdminAuthorization(undefined)?.status, 403);
});

// ── 4. expired state -> rejected ────────────────────────────────────────────

test("4. an expired state is rejected with the expiry message", () => {
  const rejection = decideStateAuthorization({
    callerUserId: ADMIN_ID,
    consumption: { kind: "expired" },
  });

  assert.equal(rejection?.status, 400);
  assert.equal(rejection?.error, EXPIRED_STATE_MESSAGE);
  assert.equal(rejection?.reason, "state_expired");
});

// ── 5. nonexistent state -> rejected ────────────────────────────────────────

test("5. an unknown state is rejected", () => {
  const rejection = decideStateAuthorization({
    callerUserId: ADMIN_ID,
    consumption: { kind: "invalid" },
  });

  assert.equal(rejection?.status, 400);
  assert.equal(rejection?.error, INVALID_STATE_MESSAGE);
  assert.equal(rejection?.reason, "state_invalid");
});

// ── 6. reused state -> rejected ─────────────────────────────────────────────

test("6. a replayed state is rejected (reuse looks identical to unknown)", () => {
  // A reuse is observed as "consumed nothing", i.e. the invalid branch: the
  // row was already deleted by the first, successful callback.
  const replay = decideStateAuthorization({
    callerUserId: ADMIN_ID,
    consumption: { kind: "invalid" },
  });

  assert.equal(replay?.status, 400);
  assert.equal(replay?.error, INVALID_STATE_MESSAGE);
});

// ── 7. no new refresh token during valid re-auth -> credential preserved ────

test("7. re-auth with no new refresh token preserves the stored credential", () => {
  const decision = decideRefreshTokenHandling(null, true);

  assert.equal(decision.store, false, "must not try to store nothing");
  assert.equal(decision.reject, false, "must NOT be treated as a failure (D5-a)");
});

test("7b. an empty/whitespace refresh token is not treated as a token", () => {
  assert.deepEqual(decideRefreshTokenHandling("   ", true), {
    store: false,
    reject: false,
  });
});

test("7c. a new refresh token is stored", () => {
  assert.deepEqual(decideRefreshTokenHandling("1//new-token", false), {
    store: true,
    reject: false,
  });
});

test("7d. no token AND no stored secret is rejected as unusable", () => {
  const decision = decideRefreshTokenHandling(null, false);
  assert.equal(decision.store, false);
  assert.equal(decision.reject, true);
});

// ── 8. auth error cleared by a valid re-auth ────────────────────────────────

test("8. re-auth clears reauth_required and restores connection state", () => {
  const account: ReconnectAccountState = {
    status: "reauth_required",
    enabled: true,
    health_status: "unhealthy",
  };
  const patch = planReconnectPatch(account, NOW);

  assert.equal(patch.status, "active");
  assert.equal(patch.connection_status, "connected");
  assert.equal(patch.health_status, "healthy");
  assert.equal(patch.last_error, null);
  assert.equal(patch.last_error_at, null);
  assert.equal(patch.last_health_check_at, NOW);
  assert.equal(patch.updated_at, NOW);
});

test("8b. re-auth clears stale status='error' too, not only reauth_required (D5-b)", () => {
  const patch = planReconnectPatch(
    { status: "error", enabled: true, health_status: "unknown" },
    NOW,
  );

  assert.equal(patch.status, "active");
  assert.equal(patch.connection_status, "connected");
  assert.equal(patch.last_error, null);
});

// ── 9. account identity and lifecycle state preserved ───────────────────────

test("9. the reconnect patch never carries identity or routing fields", () => {
  const patch = planReconnectPatch(
    { status: "reauth_required", enabled: true, health_status: "degraded" },
    NOW,
  );

  assert.equal(patchTouchesProtectedField(patch), false);
  for (const field of REAUTH_PROTECTED_FIELDS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(patch, field),
      false,
      `patch must not set ${field}`,
    );
  }
});

test("9b. the guard DETECTS a patch that would touch a protected field", () => {
  // Proves the guard is not vacuous: it must fail on a bad patch.
  assert.equal(patchTouchesProtectedField({ priority: 5 }), true);
  assert.equal(patchTouchesProtectedField({ google_email: "x@y.z" }), true);
  assert.equal(patchTouchesProtectedField({ enabled: false }), true);
  assert.equal(patchTouchesProtectedField({ id: ADMIN_ID }), true);
});

test("9c. a disabled account is NOT reactivated by re-auth", () => {
  const patch = planReconnectPatch(
    { status: "disabled", enabled: false, health_status: "unhealthy" },
    NOW,
  );

  assert.equal(
    Object.prototype.hasOwnProperty.call(patch, "status"),
    false,
    "status must be left alone for a disabled account",
  );
  assert.equal(patch.connection_status, "connected");
});

test("9d. quota_full is not silently reset to active", () => {
  const patch = planReconnectPatch(
    { status: "quota_full", enabled: true, health_status: "degraded" },
    NOW,
  );

  assert.equal(Object.prototype.hasOwnProperty.call(patch, "status"), false);
});

// ── unauthenticated caller ─────────────────────────────────────────────────

test("unauthenticated caller is refused even when the state matches", () => {
  const rejection = decideStateAuthorization({
    callerUserId: null,
    consumption: consumed(ADMIN_ID),
  });

  assert.equal(rejection?.status, 401);
  assert.equal(rejection?.error, CALLER_AUTH_REQUIRED_MESSAGE);
  assert.equal(rejection?.reason, "caller_unauthenticated");
});

test("an unauthenticated caller is refused BEFORE an admin check is reached", () => {
  // Ordering guarantee: state authorization runs first, so a caller with no
  // session never reaches the role check with a bound identity.
  const stateRejection = decideStateAuthorization({
    callerUserId: null,
    consumption: consumed(ADMIN_ID),
  });
  assert.notEqual(stateRejection, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stable Google identity — `drive_accounts.google_permission_id`
//
// `google_email` remains the OAuth matching key. The stable identity exists to
// catch what the email cannot: the same address now belonging to a DIFFERENT
// Google account.
// ═══════════════════════════════════════════════════════════════════════════

const PID_A = "118273645192837465192"; // opaque; never parsed
const PID_B = "118273645192837465199";

// ── 6.1 new OAuth account stores google_permission_id ───────────────────────

test("6.1 a new account stamps the identity Google returned", () => {
  const decision = decideGooglePermissionId(null, PID_A);

  assert.deepEqual(decision, { action: "set", value: PID_A });
  assert.equal(permissionIdNeedsWrite(decision), true);
});

test("6.1b the identity patch writes exactly the one intended column", () => {
  const patch = planIdentityPatch(PID_A);

  assert.deepEqual(patch, { google_permission_id: PID_A });
  assert.deepEqual(Object.keys(patch), ["google_permission_id"]);
});

test("6.1c the identity patch never leaks into lifecycle state", () => {
  const patch = planIdentityPatch(PID_A);

  // Stamping an identity must not be able to mark an account healthy, restore
  // routing, or alter quota — the account is not "healthy because it has an id".
  for (const forbidden of [
    "status",
    "health_status",
    "connection_status",
    "enabled",
    "quota_full",
    "priority",
    "reserved_bytes",
    "root_folder_id",
    "refresh_token_secret_id",
    "last_error",
    "last_health_check_at",
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(patch, forbidden),
      false,
      `identity patch must not set ${forbidden}`,
    );
  }
  assert.equal(patchTouchesProtectedField(patch), false);
});

// ── 6.2 re-auth updates google_permission_id (incl. backfill) ───────────────

test("6.2 re-auth stamps an existing row that has no identity yet", () => {
  // This is how the live production account acquires an identity: from a real
  // OAuth event, never from a fabricated backfill.
  const decision = decideGooglePermissionId(null, PID_A);

  assert.equal(decision.action, "set");
  assert.equal(permissionIdNeedsWrite(decision), true);
});

test("6.2b re-auth leaves an already-correct identity untouched", () => {
  const decision = decideGooglePermissionId(PID_A, PID_A);

  assert.deepEqual(decision, { action: "unchanged" });
  assert.equal(permissionIdNeedsWrite(decision), false);
});

test("6.2c surrounding whitespace is normalised, not treated as a change", () => {
  assert.equal(decideGooglePermissionId(PID_A, `  ${PID_A}  `).action, "unchanged");
  assert.deepEqual(decideGooglePermissionId(null, ` ${PID_A} `), {
    action: "set",
    value: PID_A,
  });
});

// ── 6.3 re-auth preserves the same drive_accounts.id ────────────────────────

test("6.3 neither the identity nor the lifecycle patch carries an account id", () => {
  const identity = planIdentityPatch(PID_A);
  const lifecycle = planReconnectPatch(
    { status: "reauth_required", enabled: true, health_status: "unknown" },
    NOW,
  );

  for (const patch of [identity, lifecycle]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(patch, "id"),
      false,
      "a patch must never rewrite the primary key; the row is UPDATEd in place",
    );
    assert.equal(patchTouchesProtectedField(patch), false);
  }
});

// ── 6.4 re-auth preserves protected lifecycle fields ────────────────────────

test("6.4 the two patches are disjoint in what they may write", () => {
  const identityKeys = Object.keys(planIdentityPatch(PID_A));
  const lifecycleKeys = Object.keys(
    planReconnectPatch({ status: "error", enabled: true, health_status: "degraded" }, NOW),
  );

  // Identity owns one column; the lifecycle patch owns credential/health state.
  // Neither may write the other's concern, so a failure in one cannot corrupt
  // the other.
  assert.deepEqual(identityKeys, ["google_permission_id"]);
  assert.equal(lifecycleKeys.includes("google_permission_id"), false);
});

// ── 6.5 missing/null identity must not break account creation ───────────────

test("6.5 Google legitimately omitting the identity never blocks creation", () => {
  for (const incoming of [null, undefined, "", "   "]) {
    const decision = decideGooglePermissionId(null, incoming);
    assert.deepEqual(decision, { action: "skip" }, `incoming=${JSON.stringify(incoming)}`);
    assert.equal(
      permissionIdNeedsWrite(decision),
      false,
      "no write is attempted when Google omits the field",
    );
  }
});

test("6.5b a missing identity never produces a conflict", () => {
  // Even when a row already holds a value, an omitted field must not be read as
  // a mismatch — otherwise every re-auth without the field would be refused.
  assert.equal(decideGooglePermissionId(PID_A, null).action, "skip");
  assert.equal(decideGooglePermissionId(PID_A, "").action, "skip");
});

test("6.5c an omitted identity never clears a stored one", () => {
  const decision = decideGooglePermissionId(PID_A, null);

  assert.equal(
    Object.prototype.hasOwnProperty.call(decision, "value"),
    false,
    "skip carries no value, so nothing can null the stored identity",
  );
});

// ── 6.6 existing google_email behavior is unchanged ─────────────────────────

test("6.6 google_email is never written by the identity path", () => {
  const patch = planIdentityPatch(PID_A);

  assert.equal(Object.prototype.hasOwnProperty.call(patch, "google_email"), false);
  // and it remains protected against accidental lifecycle writes
  assert.equal(patchTouchesProtectedField({ google_email: "x@y.z" }), true);
  assert.ok((REAUTH_PROTECTED_FIELDS as readonly string[]).includes("google_email"));
});

// ── 6.7 duplicate stable identity cannot split one logical account ──────────

test("6.7 a different Google account on a known email is a CONFLICT, not a rebind", () => {
  const decision = decideGooglePermissionId(PID_A, PID_B);

  assert.equal(decision.action, "conflict");
  if (decision.action === "conflict") {
    assert.equal(decision.existing, PID_A);
    assert.equal(decision.incoming, PID_B);
  }
  assert.equal(
    permissionIdNeedsWrite(decision),
    false,
    "a conflict must never write, so the row keeps its original identity",
  );
});

test("6.7b the same identity on a known email is idempotent, never a second row", () => {
  // Re-auth of the SAME Google account must be a no-op for identity, which is
  // what keeps one Google account mapped to one drive_accounts row.
  assert.equal(decideGooglePermissionId(PID_A, PID_A).action, "unchanged");
});

// ── 6.8 disabled / quota_full lifecycle behavior unchanged ──────────────────

test("6.8 stamping an identity cannot reactivate a disabled account", () => {
  const identity = planIdentityPatch(PID_A);
  const lifecycle = planReconnectPatch(
    { status: "disabled", enabled: false, health_status: "unhealthy" },
    NOW,
  );

  assert.equal(Object.prototype.hasOwnProperty.call(identity, "enabled"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(identity, "status"), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(lifecycle, "status"),
    false,
    "disabled stays disabled through re-auth (unchanged behavior)",
  );
});

test("6.8b stamping an identity cannot reset a quota_full account", () => {
  const lifecycle = planReconnectPatch(
    { status: "quota_full", enabled: true, health_status: "degraded" },
    NOW,
  );

  assert.equal(Object.prototype.hasOwnProperty.call(lifecycle, "status"), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(planIdentityPatch(PID_A), "status"),
    false,
  );
});
