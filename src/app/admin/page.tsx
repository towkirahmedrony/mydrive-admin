import { Suspense } from "react";

import RefreshButton from "@/components/RefreshButton";
import DashboardSection from "@/components/DashboardSection";
import DashboardStatCard from "@/components/DashboardStatCard";
import EmptyState from "@/components/EmptyState";
import StatusBadge from "@/components/StatusBadge";
import {
  accountHealthTone,
  connectionTone,
  jobStatusTone,
  loadDashboard,
  mediaStatusTone,
  storagePool,
} from "@/lib/dashboard-data";
import {
  formatBytes,
  formatRelative,
  formatTimestamp,
  usagePercent,
} from "@/lib/format";

/**
 * Admin dashboard — the operational overview of the My Drive backend.
 *
 * Every number on this page comes from a live Supabase aggregate query executed
 * server-side under the admin's own RLS session (see lib/dashboard-data.ts).
 * There are no mock values, and no credentials are read or rendered.
 *
 * The Google Drive quota section reads the columns the existing health check
 * persists — the dashboard never calls the Drive API and never touches OAuth.
 *
 * Only routes that exist and show relevant content are linked; the job/media/
 * user pages are still placeholders, so their sections stay self-contained.
 */

function destinationLabel(destinationType: string): string {
  return destinationType === "google_drive" ? "Google Drive" : "Telegram";
}

function mediaIdentifier(job: {
  media_assets: { file_name: string | null } | null;
  media_id: string | null;
}): string {
  return (
    job.media_assets?.file_name ??
    (job.media_id ? `${job.media_id.slice(0, 8)}…` : "—")
  );
}

function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-gray-200 ${className}`} />;
}

/**
 * Streamed while the aggregate queries run. Scoped to this page via Suspense
 * rather than a route-level loading.tsx, so the other admin pages keep their
 * own rendering.
 */
function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading dashboard</span>
      <div className="space-y-2">
        <SkeletonBlock className="h-8 w-48" />
        <SkeletonBlock className="h-4 w-80" />
      </div>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="bg-white shadow rounded-lg p-5">
            <SkeletonBlock className="h-4 w-24" />
            <SkeletonBlock className="mt-3 h-7 w-16" />
            <SkeletonBlock className="mt-2 h-3 w-28" />
          </div>
        ))}
      </div>
      {[0, 1].map((index) => (
        <div key={index} className="bg-white shadow rounded-lg p-6 space-y-3">
          <SkeletonBlock className="h-5 w-40" />
          <SkeletonBlock className="h-4 w-full" />
          <SkeletonBlock className="h-4 w-5/6" />
          <SkeletonBlock className="h-4 w-2/3" />
        </div>
      ))}
    </div>
  );
}

export default function AdminDashboard() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardContent />
    </Suspense>
  );
}

async function DashboardContent() {
  const data = await loadDashboard();
  const { counts } = data;

  const pool = storagePool(data.driveAccounts);
  const pendingJobs = data.destinations.reduce((s, d) => s + d.PENDING, 0);
  const retryingJobs = data.destinations.reduce((s, d) => s + d.RETRYING, 0);
  const processingJobs = data.destinations.reduce((s, d) => s + d.PROCESSING, 0);

  const poolTotal = pool.quotaKnown ? formatBytes(pool.totalBytes.toString()) ?? "—" : null;
  const poolUsed = pool.quotaKnown ? formatBytes(pool.usedBytes.toString()) ?? "—" : null;
  const poolAvailable = pool.quotaKnown
    ? formatBytes(pool.availableBytes.toString()) ?? "—"
    : null;
  const poolPercent = usagePercent(pool.usedBytes.toString(), pool.totalBytes.toString());

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">
            Operational overview of the My Drive backend. All values are live
            database aggregates.
          </p>
          <p className="mt-1 text-xs text-gray-400">
            Loaded {formatTimestamp(data.generatedAt)} UTC · {data.queryCount}{" "}
            aggregate {data.queryCount === 1 ? "query" : "queries"}
          </p>
        </div>
        <RefreshButton />
      </div>

      {/* Partial-failure banner: one section failing must not blank the page */}
      {data.errors.length > 0 && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-yellow-900">
                Some data could not be loaded
              </h2>
              <p className="mt-1 text-xs text-yellow-800">
                {data.errors.length} of {data.queryCount} queries failed. The
                affected sections show what did load.
              </p>
              <ul className="mt-2 space-y-0.5 text-xs text-yellow-800">
                {data.errors.slice(0, 4).map((error) => (
                  <li key={error} className="break-words">
                    • {error}
                  </li>
                ))}
                {data.errors.length > 4 && (
                  <li>• +{data.errors.length - 4} more</li>
                )}
              </ul>
            </div>
            <RefreshButton label="Retry" />
          </div>
        </div>
      )}

      {/* 1. Overview statistics */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <DashboardStatCard
          label="Total users"
          value={counts.totalUsers}
          hint={`${counts.activeUsers} active · ${counts.suspendedUsers} suspended`}
        />
        <DashboardStatCard
          label="Active users"
          value={counts.activeUsers}
          tone="success"
        />
        <DashboardStatCard
          label="Suspended users"
          value={counts.suspendedUsers}
          tone={counts.suspendedUsers > 0 ? "warning" : "neutral"}
        />
        <DashboardStatCard
          label="Registered devices"
          value={counts.devices}
        />
        <DashboardStatCard
          label="Total media assets"
          value={counts.mediaTotal}
          hint={`${counts.mediaReady} ready · ${counts.mediaFailed} failed upload${counts.mediaFailed === 1 ? "" : "s"}`}
        />
        <DashboardStatCard
          label="Media uploaded today"
          value={counts.mediaToday}
          hint="since 00:00 UTC"
        />
        <DashboardStatCard
          label="Pending replication jobs"
          value={counts.jobsPending}
          tone={counts.jobsPending > 0 ? "warning" : "neutral"}
          hint={`${pendingJobs} pending · ${retryingJobs} retrying · ${processingJobs} processing`}
        />
        <DashboardStatCard
          label="Failed replication jobs"
          value={counts.jobsFailed}
          tone={counts.jobsFailed > 0 ? "danger" : "success"}
          badge={counts.jobsFailed === 0 ? "clear" : undefined}
        />
      </div>

      {/* 2. Storage overview */}
      <DashboardSection
        title="Storage overview"
        description="Google Drive storage pool, from the stored quota of each configured account."
        linkHref="/admin/drive"
        linkLabel="Manage accounts"
      >
        {data.driveAccounts.length === 0 ? (
          <EmptyState
            icon="☁️"
            title="No Drive account configured"
            detail="Connect a Google Drive account to enable the archive pool."
          />
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <div>
                <p className="text-sm text-gray-500">Total storage</p>
                <p className="mt-1 text-xl font-semibold text-gray-900">
                  {poolTotal ?? "Not synced"}
                </p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {pool.accounts} account{pool.accounts === 1 ? "" : "s"} ·{" "}
                  {pool.healthy} healthy
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Used storage</p>
                <p className="mt-1 text-xl font-semibold text-gray-900">
                  {poolUsed ?? "Not synced"}
                </p>
                {poolPercent !== null && (
                  <p className="mt-0.5 text-xs text-gray-500">{poolPercent}% of pool</p>
                )}
              </div>
              <div>
                <p className="text-sm text-gray-500">Available storage</p>
                <p className="mt-1 text-xl font-semibold text-green-600">
                  {poolAvailable ?? "Not synced"}
                </p>
                {pool.reservedBytes > BigInt(0) && (
                  <p className="mt-0.5 text-xs text-gray-500">
                    {formatBytes(pool.reservedBytes.toString())} reserved
                  </p>
                )}
              </div>
              <div>
                <p className="text-sm text-gray-500">Account health</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <StatusBadge label={`${pool.healthy} healthy`} tone="success" />
                  <StatusBadge label={`${pool.warning} warning`} tone="warning" />
                  <StatusBadge label={`${pool.unhealthy} unhealthy`} tone="danger" />
                  <StatusBadge label={`${pool.disabled} disabled`} tone="neutral" />
                </div>
              </div>
            </div>

            {!pool.quotaKnown && (
              <p className="rounded-md bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
                No quota has been synced yet — run <strong>Refresh health/quota</strong>{" "}
                on the Drive accounts page.
              </p>
            )}

            <div className="-mx-4 overflow-x-auto sm:mx-0">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                    <th scope="col" className="py-2 pr-4 font-medium">Account</th>
                    <th scope="col" className="py-2 pr-4 font-medium">State</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Usage</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Available</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Priority</th>
                    <th scope="col" className="py-2 font-medium">Last quota check</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.driveAccounts.map((account) => {
                    const percent = usagePercent(
                      account.storage_used_bytes,
                      account.storage_limit_bytes,
                    );
                    return (
                      <tr key={account.id} className="align-top">
                        <td className="py-3 pr-4">
                          <p className="font-medium text-gray-900">
                            {account.google_email}
                          </p>
                          {account.name && (
                            <p className="text-xs text-gray-500">{account.name}</p>
                          )}
                        </td>
                        <td className="py-3 pr-4">
                          <div className="flex flex-col gap-1">
                            <StatusBadge
                              label={account.enabled ? account.status : "disabled"}
                              tone={accountHealthTone(account)}
                            />
                            <StatusBadge
                              label={account.health_status}
                              tone={accountHealthTone(account)}
                            />
                            <StatusBadge
                              label={account.connection_status}
                              tone={connectionTone(account.connection_status)}
                            />
                          </div>
                        </td>
                        <td className="py-3 pr-4">
                          <p className="whitespace-nowrap text-gray-900">
                            {formatBytes(account.storage_used_bytes) ?? "—"}
                            {" / "}
                            {formatBytes(account.storage_limit_bytes) ?? "—"}
                          </p>
                          <div className="mt-1 h-1.5 w-32 rounded-full bg-gray-200">
                            <div
                              className={`h-1.5 rounded-full ${
                                percent === null
                                  ? "bg-gray-300"
                                  : percent >= 90
                                  ? "bg-red-500"
                                  : percent >= 75
                                  ? "bg-yellow-500"
                                  : "bg-green-500"
                              }`}
                              style={{ width: `${percent ?? 0}%` }}
                            />
                          </div>
                        </td>
                        <td className="py-3 pr-4 whitespace-nowrap text-gray-900">
                          {formatBytes(account.storage_available_bytes) ?? "—"}
                        </td>
                        <td className="py-3 pr-4 text-gray-900">{account.priority}</td>
                        <td className="py-3 text-gray-500">
                          {formatRelative(account.last_quota_check_at) ?? "never"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {data.driveAccounts.some((a) => a.last_error) && (
              <ul className="space-y-1 text-xs text-red-700">
                {data.driveAccounts
                  .filter((a) => a.last_error)
                  .map((a) => (
                    <li key={a.id} className="break-words">
                      {a.google_email}: {a.last_error}
                    </li>
                  ))}
              </ul>
            )}
          </div>
        )}
      </DashboardSection>

      {/* 3. Replication overview */}
      <DashboardSection
        title="Replication overview"
        description="Job queue by destination. Statuses come from the replication_jobs table."
      >
        <div className="-mx-4 overflow-x-auto sm:mx-0">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                <th scope="col" className="py-2 pr-4 font-medium">Destination</th>
                <th scope="col" className="py-2 pr-4 font-medium">Pending</th>
                <th scope="col" className="py-2 pr-4 font-medium">Processing</th>
                <th scope="col" className="py-2 pr-4 font-medium">Successful</th>
                <th scope="col" className="py-2 pr-4 font-medium">Failed</th>
                <th scope="col" className="py-2 pr-4 font-medium">Retrying</th>
                <th scope="col" className="py-2 font-medium">Skipped</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.destinations.map((destination) => (
                <tr key={destination.key}>
                  <td className="py-3 pr-4 font-medium text-gray-900">
                    {destination.label}
                  </td>
                  <td className="py-3 pr-4 text-gray-900">{destination.PENDING}</td>
                  <td className="py-3 pr-4 text-gray-900">{destination.PROCESSING}</td>
                  <td className="py-3 pr-4 text-green-700">{destination.COMPLETED}</td>
                  <td
                    className={`py-3 pr-4 ${
                      destination.FAILED > 0 ? "font-medium text-red-700" : "text-gray-900"
                    }`}
                  >
                    {destination.FAILED}
                  </td>
                  <td className="py-3 pr-4 text-gray-900">{destination.RETRYING}</td>
                  <td className="py-3 text-gray-500">{destination.SKIPPED}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="mt-6 text-sm font-semibold text-gray-900">
          Recent failed jobs
        </h3>
        {data.recentFailures.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              icon="✅"
              title="No failed replication jobs"
              detail="Nothing has permanently failed."
            />
          </div>
        ) : (
          <div className="mt-3 -mx-4 overflow-x-auto sm:mx-0">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                  <th scope="col" className="py-2 pr-4 font-medium">Media</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Destination</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Error</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Attempts</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Retry</th>
                  <th scope="col" className="py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.recentFailures.map((job) => (
                  <tr key={job.id} className="align-top">
                    <td className="py-3 pr-4">
                      <p className="font-medium text-gray-900">
                        {mediaIdentifier(job)}
                      </p>
                      <p className="text-xs text-gray-400">{job.id.slice(0, 8)}…</p>
                    </td>
                    <td className="py-3 pr-4">
                      <StatusBadge
                        label={destinationLabel(job.destination_type)}
                        tone="neutral"
                      />
                      {job.drive_accounts?.google_email && (
                        <p className="mt-1 text-xs text-gray-500">
                          {job.drive_accounts.google_email}
                        </p>
                      )}
                    </td>
                    <td className="py-3 pr-4 max-w-md">
                      <p
                        className="text-red-700 line-clamp-2 break-words"
                        title={job.last_error ?? undefined}
                      >
                        {job.last_error ?? "No error message recorded"}
                      </p>
                    </td>
                    <td className="py-3 pr-4 text-gray-900">{job.attempt_count}</td>
                    <td className="py-3 pr-4 text-gray-500">
                      {job.next_retry_at
                        ? formatRelative(job.next_retry_at)
                        : "not scheduled"}
                    </td>
                    <td className="py-3 whitespace-nowrap text-gray-500">
                      <p>
                        <StatusBadge
                          label={job.status}
                          tone={jobStatusTone(job.status)}
                        />
                      </p>
                      <p className="mt-1 text-xs">
                        {formatRelative(job.updated_at ?? job.created_at)}
                      </p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DashboardSection>

      {/* 4. Recent activity */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <DashboardSection title="Recent media uploads" description="Latest registered media assets.">
          {data.recentUploads.length === 0 ? (
            <EmptyState icon="🖼️" title="No media uploaded yet" />
          ) : (
            <ul className="divide-y divide-gray-100">
              {data.recentUploads.map((media) => (
                <li key={media.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-900" title={media.file_name ?? undefined}>
                      {media.file_name ?? `${media.id.slice(0, 8)}…`}
                    </p>
                    <p className="text-xs text-gray-500">
                      {media.profiles?.email ?? "unknown owner"}
                      {media.file_size ? ` · ${formatBytes(media.file_size)}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 whitespace-nowrap">
                    <StatusBadge label={media.status} tone={mediaStatusTone(media.status)} />
                    <span className="text-xs text-gray-400">
                      {formatRelative(media.created_at)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DashboardSection>

        <DashboardSection
          title="Recent successful replications"
          description="Completed job deliveries."
        >
          {data.recentSuccesses.length === 0 ? (
            <EmptyState icon="📦" title="No completed replications yet" />
          ) : (
            <ul className="divide-y divide-gray-100">
              {data.recentSuccesses.map((job) => (
                <li key={job.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-900" title={mediaIdentifier(job)}>
                      {mediaIdentifier(job)}
                    </p>
                    <p className="text-xs text-gray-500">
                      {destinationLabel(job.destination_type)}
                      {job.drive_accounts?.google_email
                        ? ` · ${job.drive_accounts.google_email}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 whitespace-nowrap">
                    <StatusBadge
                      label={job.status}
                      tone={jobStatusTone(job.status)}
                    />
                    <span className="text-xs text-gray-400">
                      {formatRelative(job.updated_at ?? job.created_at)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DashboardSection>

        <DashboardSection
          title="Recent failures"
          description="Audit-log entries recorded with a failure status."
        >
          {data.recentFailureLogs.length === 0 ? (
            <EmptyState icon="🎉" title="No failures recorded" />
          ) : (
            <ul className="divide-y divide-gray-100">
              {data.recentFailureLogs.map((entry) => (
                <li key={entry.id} className="py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-medium text-gray-900">
                      {entry.event_type}
                    </p>
                    <span className="whitespace-nowrap text-xs text-gray-400">
                      {formatRelative(entry.created_at)}
                    </span>
                  </div>
                  <p className="mt-0.5 break-words text-xs text-red-700">
                    {entry.message ?? "No message recorded"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </DashboardSection>

        <DashboardSection
          title="Drive account health checks"
          description="Latest stored health/quota result per account (last_health_check_at)."
        >
          {data.recentDriveHealth.length === 0 ? (
            <EmptyState icon="☁️" title="No Drive account to check" />
          ) : (
            <ul className="divide-y divide-gray-100">
              {data.recentDriveHealth.map((account) => (
                <li key={account.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-900">
                      {account.google_email}
                    </p>
                    <p className="text-xs text-gray-500">
                      {account.last_error
                        ? account.last_error
                        : `available ${formatBytes(account.storage_available_bytes) ?? "unknown"}`}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 whitespace-nowrap">
                    <StatusBadge
                      label={account.health_status}
                      tone={accountHealthTone(account)}
                    />
                    <span className="text-xs text-gray-400">
                      {formatRelative(account.last_health_check_at) ?? "never checked"}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DashboardSection>
      </div>

      {/* 5. System health */}
      <DashboardSection
        title="System health"
        description="Derived from live reads and the configured integrations."
      >
        <ul className="divide-y divide-gray-100">
          {data.systemHealth.map((item) => (
            <li
              key={item.label}
              className="flex flex-wrap items-center justify-between gap-2 py-3"
            >
              <span className="text-sm text-gray-700">{item.label}</span>
              <span className="flex items-center gap-3">
                <span className="text-xs text-gray-500">{item.detail}</span>
                <StatusBadge label={item.badge} tone={item.tone} />
              </span>
            </li>
          ))}
        </ul>
      </DashboardSection>
    </div>
  );
}
