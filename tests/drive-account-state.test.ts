/**
 * Drive account admin-state helpers.
 *
 * These map backend `drive-admin` fields onto UI labels. They must not invent
 * health: every branch is a direct reading of status / health_status /
 * connection_status / enabled / last_error.
 *
 * Run:
 *   node --import ./tests/register.mjs --test tests/drive-account-state.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountHasVisibleError,
  accountNeedsReauth,
  isAccountEnabled,
  summarizeDriveAccount,
  type DriveAccountStateFields,
} from "@/lib/drive-account-state";

function account(
  overrides: Partial<DriveAccountStateFields> = {},
): DriveAccountStateFields {
  return {
    status: "active",
    connection_status: "connected",
    health_status: "healthy",
    enabled: true,
    last_error: null,
    ...overrides,
  };
}

test("healthy connected account is labeled Connected / Healthy", () => {
  const summary = summarizeDriveAccount(account());
  assert.equal(summary.key, "connected_healthy");
  assert.equal(summary.label, "Connected / Healthy");
  assert.equal(accountNeedsReauth(account()), false);
  assert.equal(isAccountEnabled(account()), true);
});

test("reauth_required status is labeled Re-authentication required", () => {
  const row = account({
    status: "reauth_required",
    connection_status: "reauth_required",
    health_status: "unhealthy",
    last_error: "invalid_grant",
  });
  const summary = summarizeDriveAccount(row);
  assert.equal(summary.key, "reauth_required");
  assert.equal(summary.label, "Re-authentication required");
  assert.equal(accountNeedsReauth(row), true);
  assert.equal(accountHasVisibleError(row), true);
});

test("unhealthy health_status requires reauth even when status is still active", () => {
  const row = account({ health_status: "unhealthy" });
  assert.equal(summarizeDriveAccount(row).key, "unhealthy");
  assert.equal(summarizeDriveAccount(row).label, "Unhealthy");
  assert.equal(accountNeedsReauth(row), true);
});

test("broken connection_status values require reauth", () => {
  for (const connection of ["reauth_required", "disconnected", "error"]) {
    const row = account({ connection_status: connection });
    assert.equal(accountNeedsReauth(row), true, connection);
  }
});

test("disabled accounts are labeled Disabled and are not treated as enabled", () => {
  const byFlag = account({ enabled: false, status: "active" });
  const byStatus = account({ enabled: true, status: "disabled" });
  assert.equal(summarizeDriveAccount(byFlag).key, "disabled");
  assert.equal(summarizeDriveAccount(byStatus).key, "disabled");
  assert.equal(isAccountEnabled(byFlag), false);
  assert.equal(isAccountEnabled(byStatus), false);
});

test("quota_full and error use backend status, not invented client health", () => {
  assert.equal(
    summarizeDriveAccount(account({ status: "quota_full", health_status: "degraded" }))
      .label,
    "Quota full",
  );
  assert.equal(
    summarizeDriveAccount(
      account({
        status: "error",
        health_status: "degraded",
        connection_status: "unknown",
      }),
    ).label,
    "Error",
  );
});

test("last_error is only treated as visible in unhealthy/reauth/error states", () => {
  const healthyWithStale = account({ last_error: "old" });
  assert.equal(accountHasVisibleError(healthyWithStale), false);

  const unhealthy = account({
    health_status: "unhealthy",
    last_error: "Google rejected the stored credential",
  });
  assert.equal(accountHasVisibleError(unhealthy), true);
});
