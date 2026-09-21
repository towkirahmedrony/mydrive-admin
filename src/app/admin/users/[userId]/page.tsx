import Link from "next/link";
import { notFound } from "next/navigation";
import EmployeeAvatar from "@/components/EmployeeAvatar";
import EmptyState from "@/components/EmptyState";
import RefreshButton from "@/components/RefreshButton";
import StatusBadge from "@/components/StatusBadge";
import StorageBar from "@/components/StorageBar";
import { formatBytes, formatRelative, formatTimestamp } from "@/lib/format";
import { employeeDisplayName, employeeInitials } from "@/lib/media-types";
import {
  accountStatusLabel,
  accountStatusTone,
  backupStatusLabel,
  backupStatusTone,
  devicePlatform,
  deviceStatusLabel,
  deviceStatusTone,
  deviceTitle,
  isAdminRole,
  policyLabels,
  roleLabel,
  syncStateLabel,
  syncStateTone,
} from "@/lib/user-display";
import { BACKUP_LOOKBACK_DAYS, bytesRemaining } from "@/lib/user-types";
import { loadUserDetail } from "@/lib/user-data";
import UserActions from "./user-actions";

/**
 * One employee's record.
 *
 * Everything shown here is read from `profiles`, `devices` and `backup_sessions`
 * through the admin session (`loadUserDetail` re-checks it), so an id belonging
 * to another tenant or a non-admin caller resolves to not-found. Push tokens and
 * every other credential column are excluded at the query level, not hidden in
 * the markup.
 */
type Params = Promise<{ userId: string }>;

const CARD = "rounded-xl border border-gray-200 bg-white p-3 shadow-sm sm:p-4";
const CARD_TITLE =
  "text-[11px] font-semibold uppercase tracking-wide text-gray-500";
const TERM = "text-[11px] text-gray-500";
const VALUE = "text-[12px] font-medium text-gray-900";

function Field({
  label,
  value,
  title,
  mono = false,
}: {
  label: string;
  value: string | null;
  title?: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className={TERM}>{label}</dt>
      <dd
        className={`${VALUE} ${mono ? "font-mono text-[11px]" : ""} truncate`}
        title={title ?? value ?? undefined}
      >
        {value || <span className="font-normal text-gray-400">—</span>}
      </dd>
    </div>
  );
}

export default async function UserDetailPage({ params }: { params: Params }) {
  const { userId } = await params;
  const { detail, error, authorized, viewerId } = await loadUserDetail(userId);

  // A non-admin caller learns nothing: this is the same "not found" the panel
  // shows for an id that does not exist.
  if (!authorized) notFound();
  if (!detail && !error) notFound();

  if (!detail) {
    return (
      <div className="space-y-3">
        <BackLink />
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 shadow-sm"
        >
          <div>
            <p className="text-sm font-medium text-red-800">
              This employee&apos;s details could not be loaded
            </p>
            <p className="mt-0.5 text-xs text-red-700">
              {error} The reference for support is in the server log.
            </p>
          </div>
          <RefreshButton label="Try again" />
        </div>
      </div>
    );
  }

  const { user, devices, media_count } = detail;
  const name = employeeDisplayName(user);
  const used = formatBytes(user.storage_used_bytes) ?? "0 B";
  const quota = formatBytes(user.storage_quota_bytes);
  const remaining = formatBytes(bytesRemaining(user.storage_quota_bytes, user.storage_used_bytes));
  const latest = user.last_backup;

  return (
    <div className="space-y-3 sm:space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <nav aria-label="Breadcrumb" className="text-xs sm:text-sm">
            <ol className="flex flex-wrap items-center gap-2 text-gray-500">
              <li>
                <Link href="/admin" className="hover:text-gray-700">
                  Dashboard
                </Link>
              </li>
              <li aria-hidden>/</li>
              <li>
                <Link href="/admin/users" className="hover:text-gray-700">
                  Users
                </Link>
              </li>
              <li aria-hidden>/</li>
              <li className="truncate font-medium text-gray-900">{name}</li>
            </ol>
          </nav>
          <h1 className="mt-1 truncate text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
            {name}
          </h1>
        </div>
        <UserActions
          userId={userId}
          name={name}
          status={user.status}
          isSelf={Boolean(viewerId) && viewerId === userId}
        />
      </header>

      <div className="grid gap-3 lg:grid-cols-3">
        <section className={`${CARD} lg:col-span-2`} aria-labelledby="profile-heading">
          <h2 id="profile-heading" className={CARD_TITLE}>
            Profile
          </h2>

          <div className="mt-2 flex items-start gap-3">
            <EmployeeAvatar
              initials={employeeInitials(user.full_name, user.email)}
              size="lg"
            />
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-gray-900" title={name}>
                {name}
              </p>
              <p className="truncate text-xs text-gray-500">
                {user.designation?.trim() || "No designation"}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <StatusBadge
                  label={accountStatusLabel(user.status)}
                  tone={accountStatusTone(user.status)}
                />
                <StatusBadge
                  label={roleLabel(user.role)}
                  tone={isAdminRole(user.role) ? "info" : "neutral"}
                />
                <StatusBadge
                  label={syncStateLabel(user.sync_state)}
                  tone={syncStateTone(user.sync_state)}
                />
              </div>
            </div>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            <Field label="Employee ID" value={user.employee_id} mono />
            <Field label="Email" value={user.email} />
            <Field
              label="Media"
              value={`${media_count.toLocaleString()} item${media_count === 1 ? "" : "s"}`}
            />
            <Field
              label="Devices"
              value={
                user.device_count === 0
                  ? "None"
                  : `${user.device_count}${user.disabled_device_count > 0 ? ` (${user.disabled_device_count} disabled)` : ""}`
              }
            />
            <Field
              label="Last activity"
              value={formatRelative(user.last_activity_at)}
              title={formatTimestamp(user.last_activity_at) ?? undefined}
            />
            <Field
              label="Added"
              value={formatTimestamp(user.created_at)}
              title={formatTimestamp(user.created_at) ?? undefined}
            />
          </dl>
        </section>

        <section className={CARD} aria-labelledby="storage-heading">
          <h2 id="storage-heading" className={CARD_TITLE}>
            Storage
          </h2>

          <dl className="mt-2 space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <dt className={TERM}>Used</dt>
              <dd className={`${VALUE} text-sm`}>{used}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt className={TERM}>Quota</dt>
              <dd className={VALUE}>{quota ?? "Not set"}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt className={TERM}>Remaining</dt>
              <dd className={VALUE}>{remaining ?? "—"}</dd>
            </div>
          </dl>

          <StorageBar percent={user.storage_percent} className="mt-2.5" />

          <p className="mt-1.5 text-[11px] text-gray-500">
            {user.storage_percent === null
              ? user.storage_quota_bytes === null
                ? "No per-employee quota is configured, so no percentage is shown."
                : "The configured quota is zero, so no percentage is shown."
              : `${user.storage_percent}% of quota used`}
          </p>
          <p className="mt-1 text-[10px] text-gray-400">
            Usage is maintained by the backend from this employee&apos;s media.
          </p>
        </section>

        <section className={`${CARD} lg:col-span-3`} aria-labelledby="devices-heading">
          <h2 id="devices-heading" className={CARD_TITLE}>
            Devices ({devices.length})
          </h2>

          {devices.length === 0 ? (
            <div className="mt-2">
              <EmptyState
                title="No registered devices"
                detail="A device appears here once the app registers it for this account."
              />
            </div>
          ) : (
            <ul className="mt-1 divide-y divide-gray-100">
              {devices.map((device) => {
                const policies = policyLabels(device);
                return (
                  <li key={device.id} className="py-2 first:pt-1.5 last:pb-1">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium text-gray-900">
                          {deviceTitle(device)}
                        </p>
                        <p
                          className="truncate text-[11px] text-gray-500"
                          title={device.device_uid ?? undefined}
                        >
                          {[devicePlatform(device), device.device_uid]
                            .filter(Boolean)
                            .join(" · ") || "No platform information"}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <StatusBadge
                          label={deviceStatusLabel(device.status)}
                          tone={deviceStatusTone(device.status)}
                        />
                      </div>
                    </div>

                    <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                      <Field
                        label="Last seen"
                        value={formatRelative(device.last_seen_at)}
                        title={formatTimestamp(device.last_seen_at) ?? undefined}
                      />
                      <Field
                        label="Backup"
                        value={backupStatusLabel(device.last_backup?.status ?? null)}
                      />
                      <Field
                        label="Registered"
                        value={formatTimestamp(device.created_at)}
                      />
                      <Field
                        label="Policies"
                        value={policies.length > 0 ? policies.join(" · ") : "None"}
                      />
                    </dl>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className={`${CARD} lg:col-span-2`} aria-labelledby="backup-heading">
          <h2 id="backup-heading" className={CARD_TITLE}>
            Backup &amp; sync
          </h2>

          {!latest ? (
            <p className="mt-2 text-xs text-gray-500">
              No backup session recorded for this employee&apos;s devices in the
              last {BACKUP_LOOKBACK_DAYS} days.
            </p>
          ) : (
            <>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StatusBadge
                  label={backupStatusLabel(latest.status)}
                  tone={backupStatusTone(latest.status)}
                />
                <span className="text-xs text-gray-600">
                  {latest.device_name?.trim() || "Device"}
                </span>
                <span className="text-[11px] text-gray-400">
                  {latest.completed_at
                    ? `completed ${formatTimestamp(latest.completed_at)}`
                    : `started ${formatTimestamp(latest.started_at) ?? "—"}`}
                </span>
              </div>

              <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                <Field
                  label="Files uploaded"
                  value={
                    latest.files_count === null && latest.files_uploaded === null
                      ? null
                      : `${latest.files_uploaded ?? 0} / ${latest.files_count ?? 0}`
                  }
                />
                <Field
                  label="Failed files"
                  value={
                    latest.files_failed === null ? null : String(latest.files_failed)
                  }
                />
                <Field label="Total size" value={formatBytes(latest.total_size_bytes)} />
                <Field label="Started" value={formatTimestamp(latest.started_at)} />
              </dl>

              {latest.status === "FAILED" && latest.error_message && (
                <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-800">
                  {latest.error_message}
                </p>
              )}

              <div className="mt-3 border-t border-gray-100 pt-2">
                <p className={CARD_TITLE}>Latest per device</p>
                <ul className="mt-1 space-y-1">
                  {devices.map((device) => (
                    <li
                      key={device.id}
                      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[11px]"
                    >
                      <span className="min-w-0 truncate text-gray-600">
                        {device.device_name?.trim() || deviceTitle(device)}
                      </span>
                      <span className="shrink-0 text-gray-500">
                        {device.last_backup
                          ? `${backupStatusLabel(device.last_backup.status)} · ${
                              device.last_backup.completed_at
                                ? formatTimestamp(device.last_backup.completed_at)
                                : formatTimestamp(device.last_backup.started_at) ?? "—"
                            } · ${device.last_backup.files_uploaded ?? 0}/${
                              device.last_backup.files_count ?? 0
                            } files`
                          : `No session in ${BACKUP_LOOKBACK_DAYS} days`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </section>

        <section className={CARD} aria-labelledby="policies-heading">
          <h2 id="policies-heading" className={CARD_TITLE}>
            Device policies
          </h2>

          {devices.length === 0 ? (
            <p className="mt-2 text-xs text-gray-500">No devices to show.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {devices.map((device) => {
                const policies = policyLabels(device);
                return (
                  <li key={device.id}>
                    <p className="truncate text-[11px] font-medium text-gray-800">
                      {device.device_name?.trim() || deviceTitle(device)}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {policies.length > 0 ? (
                        policies.map((policy) => (
                          <span
                            key={policy}
                            className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-700"
                          >
                            {policy}
                          </span>
                        ))
                      ) : (
                        <span className="text-[10px] text-gray-400">
                          No policies set
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="mt-2 border-t border-gray-100 pt-2 text-[10px] text-gray-400">
            Read-only. These flags live on the device record and are not changed
            from this page.
          </p>
        </section>
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/admin/users"
      className="inline-flex text-xs font-medium text-primary-700 hover:text-primary-600 sm:text-sm"
    >
      ← Users
    </Link>
  );
}
