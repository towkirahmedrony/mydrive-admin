/**
 * Admin Settings — index page.
 *
 * The settings page is a compact, mobile-first overview that groups all
 * configurable areas into scannable sections. Each section links to a
 * dedicated sub-page for detailed controls.
 *
 * Architecture:
 *   - Server Component: all data is fetched server-side in one parallel
 *     batch (no client-side waterfalls).
 *   - Uses the project's existing card style (`bg-white shadow rounded-lg`).
 *   - Rows are compact (py-3) to minimise vertical scrolling on mobile.
 *   - No search bar: the total number of sections (6) is small enough
 *     that search would add cognitive overhead without reducing scroll.
 *
 * Schema discipline:
 *   Only values from MYDRIVE_SCHEMA.md are shown. No invented settings.
 */

import RefreshButton from "@/components/RefreshButton";
import SettingsSection from "@/components/settings/SettingsSection";
import SettingsRow from "@/components/settings/SettingsRow";
import { loadSettingsData } from "@/lib/settings-data";
import { formatBytes, formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

function syncLogStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return status;
}

function syncLogStatusTone(
  status: string | null | undefined,
): "neutral" | "success" | "warning" | "danger" {
  if (status === "COMPLETED" || status === "completed") return "success";
  if (status === "FAILED" || status === "failed") return "danger";
  if (status === "RETRYING" || status === "retrying") return "warning";
  return "neutral";
}

export default async function SettingsPage() {
  const data = await loadSettingsData();
  const { adminProfile, storageSummary, backupSummary, notificationSummary } =
    data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="mt-1 text-sm text-gray-500">
            Configure the admin panel and office system
          </p>
        </div>
        <RefreshButton />
      </div>

      {/* Error banner */}
      {data.errors.length > 0 && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
          <h2 className="text-sm font-semibold text-yellow-900">
            Some data could not be loaded
          </h2>
          <ul className="mt-1.5 space-y-0.5 text-xs text-yellow-800">
            {data.errors.slice(0, 3).map((error) => (
              <li key={error} className="break-words">
                • {error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Sections */}
      <div className="space-y-4">
        {/* ── Account ──────────────────────────────────────────────── */}
        <SettingsSection
          icon="👤"
          title="Account"
          subtitle="Your admin profile and authentication"
          linkHref="/admin/settings/account"
          linkLabel="Manage"
        >
          <SettingsRow
            icon=""
            label="Admin profile"
            description={
              adminProfile?.full_name?.trim() ||
              adminProfile?.email?.trim() ||
              "Signed in"
            }
            value={
              adminProfile
                ? adminProfile.role === "admin"
                  ? "Admin"
                  : adminProfile.role
                : "—"
            }
            href="/admin/settings/account"
          />
        </SettingsSection>

        {/* ── Storage & Media ──────────────────────────────────────── */}
        <SettingsSection
          icon="☁"
          title="Storage & Media"
          subtitle="Cloud storage and media status"
          linkHref="/admin/settings/storage"
          linkLabel="Details"
        >
          {/* Google Drive */}
          <SettingsRow
            icon="📁"
            label="Google Drive"
            description={
              storageSummary.totalAccounts > 0
                ? `${storageSummary.activeAccounts} of ${storageSummary.totalAccounts} account${storageSummary.totalAccounts === 1 ? "" : "s"} active`
                : "No accounts connected"
            }
            tone={
              storageSummary.totalAccounts === 0
                ? "warning"
                : storageSummary.unhealthyAccounts > 0
                  ? "warning"
                  : storageSummary.healthyAccounts > 0
                    ? "success"
                    : "neutral"
            }
            value={
              storageSummary.totalAccounts === 0
                ? "Not configured"
                : storageSummary.unhealthyAccounts > 0
                  ? "Needs attention"
                  : "Operational"
            }
            href="/admin/settings/storage"
          />

          {/* Media */}
          <SettingsRow
            icon="🖼"
            label="Media assets"
            description={`${data.mediaReady} of ${data.mediaTotal} ready`}
            value={formatBytes(storageSummary.usedBytes) ?? "—"}
            href="/admin/settings/storage"
          />

          {/* Cloudinary */}
          <SettingsRow
            icon="⚡"
            label="Cloudinary"
            description="Primary media storage"
            tone={data.mediaReady > 0 ? "success" : "neutral"}
            value={data.mediaReady > 0 ? "Active" : "No media"}
          />

          {/* Telegram */}
          <SettingsRow
            icon="✈"
            label="Telegram replication"
            description={
              data.telegramConfigsCount > 0
                ? `${data.telegramConfigsActive} active destination${data.telegramConfigsActive === 1 ? "" : "s"}`
                : "No destinations configured"
            }
            tone={
              data.telegramConfigsCount === 0
                ? "warning"
                : data.telegramConfigsActive > 0
                  ? "success"
                  : "warning"
            }
            value={
              !data.telegramEnabled
                ? "Disabled"
                : data.telegramConfigsCount === 0
                  ? "Not configured"
                  : data.telegramConfigsActive > 0
                    ? "Operational"
                    : "Degraded"
            }
          />
        </SettingsSection>

        {/* ── Backup & Sync ────────────────────────────────────────── */}
        <SettingsSection
          icon="🔄"
          title="Backup & Sync"
          subtitle="Backup policies and retry configuration"
          linkHref="/admin/settings/backup"
          linkLabel="Configure"
        >
          <SettingsRow
            icon="📋"
            label="Backup sessions"
            description={
              backupSummary.sessionsTotal > 0
                ? `${backupSummary.sessionsCompleted} completed · ${backupSummary.sessionsFailed} failed`
                : "No backup sessions recorded"
            }
            tone={
              backupSummary.sessionsFailed > 0
                ? "warning"
                : backupSummary.sessionsCompleted > 0
                  ? "success"
                  : "neutral"
            }
            value={
              backupSummary.lastSessionStatus
                ? backupSummary.lastSessionStatus
                : "—"
            }
            href="/admin/settings/backup"
          />

          <SettingsRow
            icon="🔁"
            label="Retry policy"
            description={`Max ${backupSummary.maxRetry} retries · ${backupSummary.retryDelaySeconds}s base delay`}
            href="/admin/settings/backup"
          />

          <SettingsRow
            icon="🗑"
            label="Auto-delete"
            description={
              backupSummary.autoDeletePrimary
                ? "Primary deleted after Drive archive"
                : "Primary retained after archive"
            }
            tone={backupSummary.autoDeletePrimary ? "warning" : "neutral"}
            href="/admin/settings/backup"
          />
        </SettingsSection>

        {/* ── Notifications ────────────────────────────────────────── */}
        <SettingsSection
          icon="🔔"
          title="Notifications"
          subtitle="Admin alerts and system notifications"
          linkHref="/admin/settings/notifications"
          linkLabel="View"
        >
          <SettingsRow
            icon=""
            label="Unread notifications"
            description={
              notificationSummary.unread > 0
                ? `${notificationSummary.unread} unread of ${notificationSummary.total}`
                : notificationSummary.total > 0
                  ? `${notificationSummary.total} total, all read`
                  : "No notifications"
            }
            tone={
              notificationSummary.unread > 0 ? "warning" : "neutral"
            }
            value={`${notificationSummary.unread}`}
            href="/admin/settings/notifications"
          />

          {/* Show type breakdown if available */}
          {Object.keys(notificationSummary.byType).length > 0 &&
            Object.entries(notificationSummary.byType)
              .slice(0, 2)
              .map(([type, count]) => (
                <SettingsRow
                  key={type}
                  icon=""
                  label={type}
                  description={`${count} notification${count === 1 ? "" : "s"}`}
                  value={`${count}`}
                />
              ))}
        </SettingsSection>

        {/* ── Security ─────────────────────────────────────────────── */}
        <SettingsSection
          icon="🛡"
          title="Security"
          subtitle="Authentication and access controls"
          linkHref="/admin/settings/security"
          linkLabel="Manage"
        >
          <SettingsRow
            icon="🔐"
            label="Authentication"
            description="Supabase Auth with admin role verification"
            tone="success"
            value="Active"
            href="/admin/settings/security"
          />

          <SettingsRow
            icon="👤"
            label="Account status"
            description={
              adminProfile?.status === "active"
                ? "Your account is active"
                : `Status: ${adminProfile?.status ?? "unknown"}`
            }
            tone={
              adminProfile?.status === "active" ? "success" : "danger"
            }
            value={
              adminProfile?.status === "active"
                ? "Active"
                : adminProfile?.status === "suspended"
                  ? "Suspended"
                  : "—"
            }
            href="/admin/settings/security"
          />
        </SettingsSection>

        {/* ── Developer ────────────────────────────────────────────── */}
        <SettingsSection
          icon="🧰"
          title="Developer"
          subtitle="System diagnostics and activity logs"
          linkHref="/admin/settings/developer"
          linkLabel="View"
        >
          <SettingsRow
            icon="📊"
            label="System health"
            description={
              data.errors.length === 0
                ? "All subsystems operational"
                : `${data.errors.length} issue${data.errors.length === 1 ? "" : "s"} detected`
            }
            tone={data.errors.length === 0 ? "success" : "warning"}
            value={data.errors.length === 0 ? "Operational" : "Degraded"}
            href="/admin/settings/developer"
          />

          <SettingsRow
            icon="📝"
            label="Recent activity"
            description={`${data.recentSyncLogs.length + data.recentAuditLogs.length} recent log entries`}
            value={`${data.recentSyncLogs.length + data.recentAuditLogs.length}`}
            href="/admin/settings/developer"
          />

          {/* Quick sync log status */}
          {data.recentSyncLogs.length > 0 && (
            <SettingsRow
              icon="🔄"
              label="Latest sync event"
              description={
                data.recentSyncLogs[0]?.event_type ?? "—"
              }
              tone={syncLogStatusTone(data.recentSyncLogs[0]?.status)}
              value={syncLogStatusLabel(data.recentSyncLogs[0]?.status)}
            />
          )}
        </SettingsSection>
      </div>

      {/* Footer timestamp */}
      <p className="text-xs text-gray-400">
        Settings loaded {formatRelative(data.generatedAt)} ·{" "}
        {data.errors.length === 0 ? "all reads OK" : `${data.errors.length} error${data.errors.length === 1 ? "" : "s"}`}
      </p>
    </div>
  );
}
