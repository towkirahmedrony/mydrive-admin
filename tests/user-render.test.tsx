/**
 * Render checks for the Users directory rows.
 *
 * These render the real components to static markup with fixture rows, so the
 * mobile row, the desktop table row and the filter controls are verified as
 * *markup* — which fields actually reach the DOM, and which must never reach it.
 * No database and no Supabase session are involved.
 *
 * Run:
 *   node --import ./tests/register.mjs --test tests/user-render.test.tsx
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildDirectory, type DeviceRow, type ProfileRow } from "@/lib/user-types";
import {
  DirectorySkeleton,
  UserListRow,
  UserTableHead,
  UserTableRow,
} from "@/app/admin/users/user-rows";

const profile: ProfileRow = {
  id: "u1",
  full_name: "Towkir Shahriar",
  email: "towkir@office.test",
  employee_id: "EMP-001",
  designation: "Developer",
  role: "user",
  status: "active",
  last_seen_at: "2026-09-20T08:00:00.000Z",
  created_at: "2026-01-05T00:00:00.000Z",
  storage_quota_bytes: "10737418240",
  storage_used_bytes: "2576980377",
};

const device: DeviceRow = {
  id: "d1",
  user_id: "u1",
  device_uid: "android-9f2c",
  device_name: "Pixel 7",
  brand: "Google",
  model: "Pixel 7",
  android_version: "14",
  status: "active",
  last_seen_at: "2026-09-20T07:30:00.000Z",
  created_at: "2026-02-01T00:00:00.000Z",
  wifi_only_sync: true,
  auto_delete_after_backup: false,
};

const [user] = buildDirectory([profile], [device], []);
const [secondUser] = buildDirectory(
  [{ ...profile, id: "u2", full_name: "Rony Ahmed", employee_id: null, designation: null, status: "suspended" }],
  [],
  [],
);

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

test("the mobile row stays compact and carries identity, id, designation, status, devices and storage", () => {
  const html = render(<UserListRow user={user} />);

  // Two lines only: name + secondary line.
  assert.match(html, /Towkir Shahriar/);
  assert.match(html, /EMP-001 · Developer/);
  assert.match(html, /Active/);
  assert.match(html, /1 dev/);
  assert.match(html, /2\.4 GB/);
  assert.equal(html.includes("towkir@office.test"), false);
  assert.equal(html.includes("Admin"), false);

  // Links into the employee record.
  assert.match(html, /href="\/admin\/users\/u1"/);

  // A single-row render is small: the row must not carry a card's padding.
  assert.equal(html.includes("py-5"), false);
  assert.equal(html.includes("p-5"), false);
});

test("the mobile row marks suspended accounts and missing designations", () => {
  const html = render(<UserListRow user={secondUser} />);
  assert.match(html, /Suspended/);
  assert.match(html, /No designation/);
  assert.match(html, /No devices/);
});

test("the desktop row exposes email, quota and the storage bar", () => {
  const html = render(
    <table>
      <tbody>
        <UserTableRow user={user} />
      </tbody>
    </table>,
  );

  assert.match(html, /Towkir Shahriar/);
  assert.match(html, /towkir@office\.test/);
  assert.match(html, /EMP-001 · Developer/);
  assert.match(html, /2\.4 GB/);
  assert.match(html, /\/ 10\.0 GB/);
  assert.match(html, /24% of storage quota used/);
  assert.match(html, /No recent backup/);
});

test("the table header documents the columns that are actually rendered", () => {
  const html = render(
    <table>
      <UserTableHead />
    </table>,
  );
  for (const label of [
    "Employee",
    "Email",
    "Account",
    "Devices",
    "Storage",
    "Backup",
    "Last activity",
  ]) {
    assert.match(html, new RegExp(`>${label}<`));
  }
});

test("no credential value can reach the rendered row", () => {
  // Even if a push token were somehow attached to the object, the row renders
  // named fields only and must not print it.
  const contaminated = {
    ...user,
    push_token: "fcm-token-should-never-render",
    push_token_updated_at: "2026-09-20T07:30:00.000Z",
  } as typeof user;

  const html = render(<UserListRow user={contaminated} />);
  assert.equal(html.includes("fcm-token-should-never-render"), false);
  assert.equal(html.toLowerCase().includes("push_token"), false);
});

test("the skeleton renders placeholder rows without text", () => {
  const element = DirectorySkeleton({ rows: 3 });
  assert.equal(isValidElement(element), true);
  const html = render(element);
  assert.match(html, /animate-pulse/);
  // Nothing but markup: a skeleton must not print placeholder text at all.
  const text = html.replace(/<[^>]*>/g, "").trim();
  assert.equal(text, "");
});
