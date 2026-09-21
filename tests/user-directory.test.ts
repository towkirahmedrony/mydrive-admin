/**
 * Tests for the Users / Employee Maintain directory logic.
 *
 * Everything asserted here is pure (`@/lib/user-types`), so it runs without a
 * database and without a Supabase session:
 *
 *   - the selected columns contain no credential column (FCM/push tokens);
 *   - the device/backup derivation matches the documented columns;
 *   - search, filters, sorting and the progressive window behave as specified;
 *   - the URL parameters round-trip and reject anything undocumented.
 *
 * Run:
 *   node --experimental-strip-types --import ./tests/register.mjs --test tests/user-directory.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BACKUP_LOOKBACK_DAYS,
  DEVICE_COLUMNS,
  DIRECTORY_VIEW_MAX,
  DIRECTORY_WINDOW,
  PROFILE_COLUMNS,
  SESSION_COLUMNS,
  buildDirectory,
  buildUserDevices,
  bytesRemaining,
  directoryHref,
  directorySearchParams,
  rollupSyncState,
  syncStateOf,
  viewDirectory,
  DEFAULT_DIRECTORY_FILTERS,
  filterDirectory,
  parseDirectoryFilters,
  searchOrGroup,
  sortDirectory,
  type BackupSessionRow,
  type DeviceRow,
  type DirectoryFilters,
  type ProfileRow,
} from "@/lib/user-types";

// ── Fixtures ───────────────────────────────────────────────────────────────

function profile(overrides: Partial<ProfileRow> & { id: string }): ProfileRow {
  return {
    full_name: null,
    email: null,
    employee_id: null,
    designation: null,
    role: "user",
    status: "active",
    last_seen_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    storage_quota_bytes: null,
    storage_used_bytes: 0,
    ...overrides,
  };
}

function device(overrides: Partial<DeviceRow> & { id: string; user_id: string }): DeviceRow {
  return {
    device_uid: null,
    device_name: null,
    brand: null,
    model: null,
    android_version: null,
    status: "active",
    last_seen_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    wifi_only_sync: false,
    auto_delete_after_backup: false,
    ...overrides,
  };
}

function session(
  overrides: Partial<BackupSessionRow> & { id: string; device_id: string },
): BackupSessionRow {
  return {
    started_at: "2026-09-01T00:00:00.000Z",
    completed_at: null,
    status: "COMPLETED",
    files_count: 0,
    files_uploaded: 0,
    files_failed: 0,
    total_size_bytes: 0,
    error_message: null,
    ...overrides,
  };
}

function filters(patch: Partial<DirectoryFilters> = {}): DirectoryFilters {
  return { ...DEFAULT_DIRECTORY_FILTERS, ...patch };
}

// ── Schema discipline ──────────────────────────────────────────────────────

test("no credential column is ever selected", () => {
  const deviceColumns = DEVICE_COLUMNS.split(",");
  assert.equal(deviceColumns.includes("push_token"), false);
  assert.equal(deviceColumns.includes("push_token_updated_at"), false);

  // Only documented columns, and only the ones the UI needs.
  assert.deepEqual(
    deviceColumns.sort(),
    [
      "android_version",
      "auto_delete_after_backup",
      "brand",
      "created_at",
      "device_name",
      "device_uid",
      "id",
      "last_seen_at",
      "model",
      "status",
      "user_id",
      "wifi_only_sync",
    ].sort(),
  );

  // Department is out of scope for this page.
  assert.equal(PROFILE_COLUMNS.includes("department_id"), false);
  assert.equal(PROFILE_COLUMNS.includes("role"), true);

  // No token/secret column anywhere in the session projection.
  for (const column of SESSION_COLUMNS.split(",")) {
    assert.match(column, /^(id|device_id|started_at|completed_at|status|files_count|files_uploaded|files_failed|total_size_bytes|error_message)$/);
  }
});

// ── Derivation ─────────────────────────────────────────────────────────────

test("device roll-up counts states and picks the newest last_seen_at", () => {
  const users = buildDirectory(
    [profile({ id: "u1", full_name: "Towkir Shahriar" })],
    [
      device({ id: "d1", user_id: "u1", status: "active", last_seen_at: "2026-09-10T10:00:00.000Z" }),
      device({ id: "d2", user_id: "u1", status: "disabled", last_seen_at: "2026-09-12T10:00:00.000Z" }),
    ],
    [],
  );

  assert.equal(users.length, 1);
  assert.equal(users[0].device_count, 2);
  assert.equal(users[0].active_device_count, 1);
  assert.equal(users[0].disabled_device_count, 1);
  assert.equal(users[0].last_device_seen_at, "2026-09-12T10:00:00.000Z");
  // profiles.last_seen_at is older, so the newer device wins.
  assert.equal(users[0].last_activity_at, "2026-09-12T10:00:00.000Z");
  // No sessions: never reported as synced.
  assert.equal(users[0].sync_state, "none");
});

test("sync state comes from backup_sessions.status", () => {
  assert.equal(syncStateOf("RUNNING"), "backing_up");
  assert.equal(syncStateOf("COMPLETED"), "ok");
  assert.equal(syncStateOf("FAILED"), "failed");
  assert.equal(syncStateOf("CANCELLED"), "cancelled");
  assert.equal(syncStateOf("SOMETHING_ELSE"), "none");
});

test("an employee roll-up never hides a failure behind a sibling success", () => {
  assert.equal(rollupSyncState(["ok", "failed"]), "failed");
  assert.equal(rollupSyncState(["ok", "backing_up"]), "backing_up");
  assert.equal(rollupSyncState(["ok", "cancelled"]), "ok");
  assert.equal(rollupSyncState([]), "none");
  assert.equal(rollupSyncState(["none"]), "none");
});

test("the latest backup is the newest session across the employee's devices", () => {
  const profiles = [profile({ id: "u1" })];
  const devices = [
    device({ id: "d1", user_id: "u1", device_name: "Pixel 7" }),
    device({ id: "d2", user_id: "u1", device_name: "Galaxy S22" }),
  ];
  const sessions = [
    session({
      id: "s1",
      device_id: "d1",
      started_at: "2026-09-01T00:00:00.000Z",
      status: "COMPLETED",
      files_count: 10,
    }),
    session({
      id: "s2",
      device_id: "d1",
      started_at: "2026-09-05T00:00:00.000Z",
      status: "FAILED",
      files_count: 20,
      error_message: "network",
    }),
    session({
      id: "s3",
      device_id: "d2",
      started_at: "2026-09-03T00:00:00.000Z",
      status: "COMPLETED",
    }),
  ];

  const [user] = buildDirectory(profiles, devices, sessions);
  assert.equal(user.last_backup?.device_id, "d1");
  assert.equal(user.last_backup?.status, "FAILED");
  assert.equal(user.last_backup?.device_name, "Pixel 7");
  assert.equal(user.last_backup?.files_count, 20);
  assert.equal(user.sync_state, "failed");
});

test("per-device backup is resolved per device, not globally", () => {
  const devices = [
    device({ id: "d1", user_id: "u1", device_name: "Pixel 7" }),
    device({ id: "d2", user_id: "u1", device_name: "Galaxy S22" }),
  ];
  const sessions = [
    session({ id: "s1", device_id: "d1", started_at: "2026-09-01T00:00:00.000Z", status: "COMPLETED" }),
    session({ id: "s2", device_id: "d2", started_at: "2026-09-02T00:00:00.000Z", status: "RUNNING" }),
  ];

  const perDevice = buildUserDevices(devices, sessions);
  assert.equal(perDevice[0].last_backup?.status, "COMPLETED");
  assert.equal(perDevice[1].last_backup?.status, "RUNNING");
});

test("storage percentage needs a positive quota and is null otherwise", () => {
  const [withQuota] = buildDirectory(
    [profile({ id: "u1", storage_quota_bytes: 10_737_418_240, storage_used_bytes: 2_576_980_377 })],
    [],
    [],
  );
  assert.equal(withQuota.storage_percent, 24);

  const [noQuota] = buildDirectory([profile({ id: "u2" })], [], []);
  assert.equal(noQuota.storage_percent, null);

  const [zeroQuota] = buildDirectory(
    [profile({ id: "u3", storage_quota_bytes: 0, storage_used_bytes: 100 })],
    [],
    [],
  );
  assert.equal(zeroQuota.storage_percent, null);
});

test("bigint-as-string storage columns are handled", () => {
  const [user] = buildDirectory(
    [profile({ id: "u1", storage_quota_bytes: "1000", storage_used_bytes: "250" })],
    [],
    [],
  );
  assert.equal(user.storage_percent, 25);
  assert.equal(bytesRemaining("1000", "250"), "750");
  // Never negative, and unknown quota stays unknown.
  assert.equal(bytesRemaining("100", "250"), "0");
  assert.equal(bytesRemaining(null, "250"), null);
});

// ── Search ─────────────────────────────────────────────────────────────────

test("search matches across name, email, employee id and designation", () => {
  const users = buildDirectory(
    [
      profile({
        id: "u1",
        full_name: "Towkir Shahriar",
        email: "towkir@office.test",
        employee_id: "EMP-001",
        designation: "Developer",
      }),
      profile({
        id: "u2",
        full_name: "Rony Ahmed",
        email: "rony@office.test",
        employee_id: "EMP-002",
        designation: "Designer",
      }),
    ],
    [],
    [],
  );

  const byId = filterDirectory(users, filters({ search: "emp-002" }));
  assert.deepEqual(byId.map((u) => u.id), ["u2"]);

  const byEmail = filterDirectory(users, filters({ search: "towkir@" }));
  assert.deepEqual(byEmail.map((u) => u.id), ["u1"]);

  const byDesignation = filterDirectory(users, filters({ search: "developer" }));
  assert.deepEqual(byDesignation.map((u) => u.id), ["u1"]);

  // Every token must match somewhere: a name token and a designation token.
  const multiToken = filterDirectory(users, filters({ search: "towkir developer" }));
  assert.deepEqual(multiToken.map((u) => u.id), ["u1"]);

  const noCrossToken = filterDirectory(users, filters({ search: "towkir designer" }));
  assert.deepEqual(noCrossToken, []);
});

test("the SQL search group searches the same four columns", () => {
  assert.equal(
    searchOrGroup("emp-001"),
    "full_name.ilike.%emp-001%,email.ilike.%emp-001%,employee_id.ilike.%emp-001%,designation.ilike.%emp-001%",
  );
});

test("search terms are sanitised before they reach a query", () => {
  const parsed = parseDirectoryFilters({ q: "  tow%kir_,(dev)  " });
  assert.equal(parsed.search.includes("%"), false);
  assert.equal(parsed.search.includes("_"), false);
  assert.equal(parsed.search.includes(","), false);
  assert.equal(parsed.search.includes("("), false);
  assert.equal(parsed.search, "tow kir dev");
});

// ── Filters ────────────────────────────────────────────────────────────────

test("account, device, sync and storage filters select the documented states", () => {
  const users = buildDirectory(
    [
      profile({ id: "active-full", full_name: "A", status: "active", storage_quota_bytes: 100, storage_used_bytes: 95 }),
      profile({ id: "suspended-empty", full_name: "B", status: "suspended" }),
      profile({ id: "mid", full_name: "C", storage_quota_bytes: 100, storage_used_bytes: 60 }),
      profile({ id: "no-quota", full_name: "D", storage_used_bytes: 10 }),
    ],
    [
      device({ id: "d1", user_id: "active-full", status: "active" }),
      device({ id: "d2", user_id: "active-full", status: "disabled" }),
      device({ id: "d3", user_id: "mid", status: "active" }),
    ],
    [session({ id: "s1", device_id: "d3", status: "RUNNING" })],
  );

  const ids = (list: ReturnType<typeof filterDirectory>) => list.map((u) => u.id).sort();

  assert.deepEqual(ids(filterDirectory(users, filters({ status: "suspended" }))), ["suspended-empty"]);
  assert.deepEqual(ids(filterDirectory(users, filters({ devices: "without_devices" }))), ["no-quota", "suspended-empty"]);
  assert.deepEqual(ids(filterDirectory(users, filters({ devices: "with_disabled" }))), ["active-full"]);
  assert.deepEqual(ids(filterDirectory(users, filters({ sync: "backing_up" }))), ["mid"]);
  assert.deepEqual(ids(filterDirectory(users, filters({ sync: "none" }))), ["active-full", "no-quota", "suspended-empty"]);
  assert.deepEqual(ids(filterDirectory(users, filters({ storage: "used_high" }))), ["active-full"]);
  assert.deepEqual(ids(filterDirectory(users, filters({ storage: "used_mid" }))), ["mid"]);
  assert.deepEqual(ids(filterDirectory(users, filters({ storage: "used_low" }))), []);
  assert.deepEqual(ids(filterDirectory(users, filters({ storage: "no_quota" }))), ["no-quota", "suspended-empty"]);
});

// ── Sort / window ──────────────────────────────────────────────────────────

test("sorting is stable and null-safe", () => {
  const users = buildDirectory(
    [
      profile({ id: "b", full_name: "Beta", last_seen_at: "2026-09-01T00:00:00.000Z", storage_used_bytes: 10, created_at: "2026-02-01T00:00:00.000Z" }),
      profile({ id: "a", full_name: "Alpha", last_seen_at: null, storage_used_bytes: 30, created_at: "2026-03-01T00:00:00.000Z" }),
      profile({ id: "c", full_name: "Gamma", last_seen_at: "2026-09-05T00:00:00.000Z", storage_used_bytes: 20, created_at: "2026-01-01T00:00:00.000Z" }),
    ],
    [],
    [],
  );

  assert.deepEqual(sortDirectory(users, "name").map((u) => u.id), ["a", "b", "c"]);
  assert.deepEqual(
    sortDirectory(users, "recent").map((u) => u.id),
    ["c", "b", "a"],
  );
  assert.deepEqual(sortDirectory(users, "storage").map((u) => u.id), ["a", "c", "b"]);
  assert.deepEqual(sortDirectory(users, "newest").map((u) => u.id), ["a", "b", "c"]);
});

test("the window reports the true match count and caps at the documented maximum", () => {
  const many = Array.from({ length: DIRECTORY_VIEW_MAX + 40 }, (_, index) =>
    profile({ id: `u${index}`, full_name: `Employee ${String(index).padStart(3, "0")}` }),
  );
  const users = buildDirectory(many, [], []);

  const first = viewDirectory(users, filters());
  assert.equal(first.users.length, DIRECTORY_WINDOW);
  assert.equal(first.matched, DIRECTORY_VIEW_MAX + 40);
  assert.equal(first.capped, true);

  const everything = viewDirectory(users, filters(), 10_000);
  assert.equal(everything.users.length, DIRECTORY_VIEW_MAX);
  assert.equal(everything.matched, DIRECTORY_VIEW_MAX + 40);
  assert.equal(everything.capped, true);

  const exact = viewDirectory(users, filters(), DIRECTORY_VIEW_MAX + 40);
  assert.equal(exact.users.length, DIRECTORY_VIEW_MAX);
});

test("an empty roster and an over-filtered view both report zero matches", () => {
  assert.deepEqual(viewDirectory([], filters()).matched, 0);
  const users = buildDirectory([profile({ id: "u1", status: "active" })], [], []);
  assert.equal(viewDirectory(users, filters({ status: "suspended" })).matched, 0);
});

// ── URL parameters ─────────────────────────────────────────────────────────

test("unknown parameter values fall back to the documented ones", () => {
  const parsed = parseDirectoryFilters({
    status: "deleted",
    devices: "something",
    sync: "maybe",
    storage: "huge",
    sort: "size",
  });
  assert.equal(parsed.status, "ALL");
  assert.equal(parsed.devices, "ALL");
  assert.equal(parsed.sync, "ALL");
  assert.equal(parsed.storage, "ALL");
  assert.equal(parsed.sort, "name");
});

test("URL round-trips and omits defaults", () => {
  assert.equal(directoryHref(DEFAULT_DIRECTORY_FILTERS), "/admin/users");

  const view = filters({ search: "towkir", status: "suspended", storage: "used_high" });
  const query = directorySearchParams(view);
  assert.equal(query.get("q"), "towkir");
  assert.equal(query.get("status"), "suspended");
  assert.equal(query.get("storage"), "used_high");
  assert.equal(query.has("devices"), false);
  assert.equal(directoryHref(view), "/admin/users?q=towkir&status=suspended&storage=used_high");

  const reparsed = parseDirectoryFilters({ q: "towkir", status: "suspended", storage: "used_high" });
  assert.deepEqual(reparsed, view);
});

test("the lookback window is the documented constant", () => {
  assert.equal(BACKUP_LOOKBACK_DAYS, 90);
});
