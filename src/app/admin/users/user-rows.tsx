import Link from "next/link";
import EmployeeAvatar from "@/components/EmployeeAvatar";
import StatusBadge from "@/components/StatusBadge";
import StorageBar from "@/components/StorageBar";
import { formatBytes, formatRelative } from "@/lib/format";
import { employeeDisplayName, employeeInitials } from "@/lib/media-types";
import {
  accountStatusLabel,
  accountStatusTone,
  backupSummaryTitle,
  isAdminRole,
  syncStateLabel,
  syncStateTone,
} from "@/lib/user-display";
import type { DirectoryUser } from "@/lib/user-types";

/**
 * Directory rows.
 *
 * Mobile and desktop are two different presentations of the same row rather
 * than one table scaled down: a phone gets two compact lines (~52px) so a dozen
 * employees fit without scrolling, a desktop gets the same facts in a dense
 * table. Labels are kept where a value would otherwise be ambiguous; the second
 * line's glyphs only carry state that is secondary to identity.
 */

function deviceMeta(user: DirectoryUser): string {
  if (user.device_count === 0) return "No devices";
  const base = `${user.device_count} ${user.device_count === 1 ? "device" : "devices"}`;
  return user.disabled_device_count > 0
    ? `${base} · ${user.disabled_device_count} disabled`
    : base;
}

/**
 * Backup attention marker.
 *
 * Rendered only when something needs attention, so a healthy roster has no
 * glyphs at all — "Synced" is the expected state and does not deserve ink on
 * every row. The full state (with device and file counts) is on the detail page
 * and in the element's title.
 */
function SyncMarker({ user }: { user: DirectoryUser }) {
  if (user.device_count === 0 || user.sync_state === "ok") return null;

  const tone = syncStateTone(user.sync_state);
  const color =
    tone === "danger"
      ? "bg-red-500"
      : tone === "info"
        ? "bg-primary-500 animate-pulse"
        : "bg-yellow-500";

  return (
    <span
      role="img"
      aria-label={`Backup: ${syncStateLabel(user.sync_state)}`}
      title={`${syncStateLabel(user.sync_state)} · ${backupSummaryTitle(user.last_backup)}`}
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${color}`}
    />
  );
}

function AdminChip() {
  return (
    <span className="shrink-0 rounded border border-primary-200 bg-primary-50 px-1 text-[10px] font-semibold uppercase tracking-wide text-primary-700">
      Admin
    </span>
  );
}

/** Two-line, tap-target row for phones and tablets. */
export function UserListRow({ user }: { user: DirectoryUser }) {
  const name = employeeDisplayName(user);

  return (
    <Link
      href={`/admin/users/${user.id}`}
      className="flex items-center gap-2.5 px-3 py-2 transition-colors active:bg-gray-100"
    >
      <EmployeeAvatar
        initials={employeeInitials(user.full_name, user.email)}
        size="sm"
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-[13px] font-semibold leading-5 text-gray-900">
            {name}
          </p>
          {isAdminRole(user.role) && <AdminChip />}
          <SyncMarker user={user} />
        </div>
        <p className="truncate text-[11px] leading-4 text-gray-500">
          {user.employee_id ? `${user.employee_id} · ` : ""}
          {user.designation?.trim() || "No designation"}
        </p>
      </div>

      <div className="shrink-0 text-right">
        <p
          className={`text-[11px] font-medium leading-5 ${
            user.status === "active" ? "text-green-700" : "text-red-700"
          }`}
        >
          <span
            aria-hidden
            className={`mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle ${
              user.status === "active" ? "bg-green-500" : "bg-red-500"
            }`}
          />
          {accountStatusLabel(user.status)}
        </p>
        <p className="text-[11px] leading-4 text-gray-500" title={deviceMeta(user)}>
          {user.device_count > 0 ? `${user.device_count} dev · ` : ""}
          {formatBytes(user.storage_used_bytes) ?? "0 B"}
        </p>
      </div>
    </Link>
  );
}

const CELL = "px-3 py-2 align-middle";
const HEAD =
  "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500";

/**
 * Dense table row for wide screens.
 *
 * The table is `table-fixed` with a `<colgroup>`, so it always fits the content
 * column and long values truncate instead of forcing a horizontal scrollbar.
 * Identity, employee id and designation share the first cell the way the mobile
 * row does, which keeps the remaining columns wide enough to be readable.
 * The whole row is clickable through the overlay link on the name.
 */
export function UserTableRow({ user }: { user: DirectoryUser }) {
  const name = employeeDisplayName(user);
  const used = formatBytes(user.storage_used_bytes) ?? "0 B";
  const quota = formatBytes(user.storage_quota_bytes);
  const secondary = [user.employee_id?.trim(), user.designation?.trim()]
    .filter(Boolean)
    .join(" · ");

  return (
    <tr className="relative border-t border-gray-100 hover:bg-gray-50">
      <td className={CELL}>
        <div className="flex items-center gap-2.5">
          <EmployeeAvatar
            initials={employeeInitials(user.full_name, user.email)}
            size="sm"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Link
                href={`/admin/users/${user.id}`}
                className="truncate text-[13px] font-semibold text-gray-900 after:absolute after:inset-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
                title={name}
              >
                {name}
              </Link>
              {isAdminRole(user.role) && <AdminChip />}
            </div>
            <p className="truncate text-[11px] text-gray-500" title={secondary}>
              {secondary || "No employee ID"}
            </p>
          </div>
        </div>
      </td>

      <td className={`${CELL} truncate text-xs text-gray-700`} title={user.email ?? undefined}>
        {user.email || <span className="text-gray-400">—</span>}
      </td>

      <td className={`${CELL} truncate`}>
        <StatusBadge
          label={accountStatusLabel(user.status)}
          tone={accountStatusTone(user.status)}
        />
      </td>

      <td className={`${CELL} truncate text-xs text-gray-700`} title={deviceMeta(user)}>
        {user.device_count === 0 ? (
          <span className="text-gray-400">No devices</span>
        ) : (
          <>
            {user.device_count}
            {user.disabled_device_count > 0 && (
              <span className="text-gray-400"> · {user.disabled_device_count} off</span>
            )}
          </>
        )}
      </td>

      <td className={CELL}>
        <p className="truncate text-xs text-gray-700">
          {used}
          {quota ? <span className="text-gray-400"> / {quota}</span> : null}
        </p>
        <StorageBar percent={user.storage_percent} className="mt-1" />
      </td>

      <td className={CELL}>
        <span className="flex items-center gap-1.5">
          <SyncMarker user={user} />
          <StatusBadge
            label={syncStateLabel(user.sync_state)}
            tone={syncStateTone(user.sync_state)}
            title={backupSummaryTitle(user.last_backup)}
          />
        </span>
      </td>

      <td className={`${CELL} truncate text-xs text-gray-700`}>
        {formatRelative(user.last_activity_at) ?? <span className="text-gray-400">—</span>}
      </td>
    </tr>
  );
}

/**
 * Column widths. Percentage-based so the table fills the admin content column
 * at every desktop width without ever overflowing it.
 */
export function UserTableColgroup() {
  return (
    <colgroup>
      <col className="w-[24%]" />
      <col className="w-[21%]" />
      <col className="w-[10%]" />
      <col className="w-[9%]" />
      <col className="w-[14%]" />
      <col className="w-[12%]" />
      <col className="w-[10%]" />
    </colgroup>
  );
}

export function UserTableHead() {
  return (
    <thead className="bg-gray-50">
      <tr>
        <th scope="col" className={HEAD}>
          Employee
        </th>
        <th scope="col" className={HEAD}>
          Email
        </th>
        <th scope="col" className={HEAD}>
          Account
        </th>
        <th scope="col" className={HEAD}>
          Devices
        </th>
        <th scope="col" className={HEAD}>
          Storage
        </th>
        <th scope="col" className={HEAD}>
          Backup
        </th>
        <th scope="col" className={HEAD}>
          Last activity
        </th>
      </tr>
    </thead>
  );
}

/** Placeholder rows: the list keeps its shape while data is in flight. */
export function DirectorySkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="divide-y divide-gray-100" aria-hidden>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-2.5 px-3 py-2">
          <div className="h-8 w-8 shrink-0 animate-pulse rounded-xl bg-gray-200" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-32 animate-pulse rounded bg-gray-200" />
            <div className="h-2.5 w-24 animate-pulse rounded bg-gray-100" />
          </div>
          <div className="shrink-0 space-y-1.5">
            <div className="h-2.5 w-14 animate-pulse rounded bg-gray-200" />
            <div className="h-2.5 w-16 animate-pulse rounded bg-gray-100" />
          </div>
        </div>
      ))}
    </div>
  );
}
