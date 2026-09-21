/**
 * Developer settings sub-page.
 *
 * Shows system health diagnostics, recent sync and audit log activity,
 * and links to existing admin routes. This does NOT create duplicate
 * logging infrastructure — it surfaces data already stored in
 * `sync_logs` and `admin_audit_logs`.
 *
 * Schema discipline:
 *   Only columns documented in MYDRIVE_SCHEMA.md are used.
 */
"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type SyncLog = {
  id: number;
  event_type: string;
  status: string | null;
  message: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  media_id: string | null;
  replication_job_id: string | null;
};

type AuditLog = {
  id: number;
  action: string;
  success: boolean;
  details: Record<string, unknown> | null;
  created_at: string;
  actor_id: string | null;
  target_user_id: string | null;
};

type HealthCheck = {
  label: string;
  status: "ok" | "warning" | "error";
  detail: string;
};

function formatRelative(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}



function BackLink() {
  return (
    <a
      href="/admin/settings"
      className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-4"
    >
      <svg
        className="h-4 w-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
      </svg>
      Settings
    </a>
  );
}

const STATUS_COLORS: Record<string, string> = {
  ok: "bg-green-100 text-green-800",
  warning: "bg-yellow-100 text-yellow-800",
  error: "bg-red-100 text-red-800",
};

const LOG_STATUS_COLORS: Record<string, string> = {
  COMPLETED: "bg-green-100 text-green-800",
  FAILED: "bg-red-100 text-red-800",
  PENDING: "bg-gray-100 text-gray-700",
  PROCESSING: "bg-blue-100 text-blue-800",
  RETRYING: "bg-yellow-100 text-yellow-800",
  failed: "bg-red-100 text-red-800",
  success: "bg-green-100 text-green-800",
};

export default function DeveloperSettingsPage() {
  const router = useRouter();
  const [syncLogs, setSyncLogs] = useState<SyncLog[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [healthChecks, setHealthChecks] = useState<HealthCheck[]>([]);
  const [loading, setLoading] = useState(true);

  const supabase = createClient();

  const loadData = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push("/auth/login");
      return;
    }

    // Run all reads in parallel
    const [
      { data: syncData },
      { data: auditData },
      { data: settingsData },
      { data: driveAccounts },
      { count: totalMedia },
      { count: failedMedia },
      { count: pendingJobs },
      { count: failedJobs },
    ] = await Promise.all([
      supabase
        .from("sync_logs")
        .select(
          "id,event_type,status,message,metadata,created_at,media_id,replication_job_id",
        )
        .order("created_at", { ascending: false })
        .limit(30),
      supabase
        .from("admin_audit_logs")
        .select("id,action,success,details,created_at,actor_id,target_user_id")
        .order("created_at", { ascending: false })
        .limit(30),
      supabase
        .from("app_settings")
        .select("id")
        .eq("id", true)
        .maybeSingle(),
      supabase
        .from("drive_accounts")
        .select("id,health_status,enabled")
        .order("created_at", { ascending: true }),
      supabase
        .from("media_assets")
        .select("id", { count: "exact", head: true })
        .is("deleted_at", null)
        .neq("status", "DELETED"),
      supabase
        .from("media_assets")
        .select("id", { count: "exact", head: true })
        .eq("status", "FAILED")
        .is("deleted_at", null),
      supabase
        .from("replication_jobs")
        .select("id", { count: "exact", head: true })
        .in("status", ["PENDING", "RETRYING"]),
      supabase
        .from("replication_jobs")
        .select("id", { count: "exact", head: true })
        .eq("status", "FAILED"),
    ]);

    setSyncLogs((syncData ?? []) as SyncLog[]);
    setAuditLogs((auditData ?? []) as AuditLog[]);

    // Build health checks
    const accounts = (driveAccounts ?? []) as {
      id: string;
      health_status: string;
      enabled: boolean;
    }[];
    const healthy = accounts.filter(
      (a) => a.enabled && a.health_status === "healthy",
    ).length;
    const unhealthy = accounts.filter(
      (a) => a.health_status === "unhealthy" || a.health_status === "degraded",
    ).length;

    const checks: HealthCheck[] = [
      {
        label: "Supabase backend",
        status: settingsData ? "ok" : "error",
        detail: settingsData
          ? "Connected and operational"
          : "Could not read app_settings",
      },
      {
        label: "Media storage",
        status: (failedMedia ?? 0) > 0 ? "warning" : "ok",
        detail: `${totalMedia ?? 0} assets stored · ${failedMedia ?? 0} failed`,
      },
      {
        label: "Replication queue",
        status: (failedJobs ?? 0) > 0 ? "warning" : "ok",
        detail: `${pendingJobs ?? 0} pending/retrying · ${failedJobs ?? 0} failed`,
      },
      {
        label: "Drive accounts",
        status: accounts.length === 0
          ? "warning"
          : unhealthy > 0
            ? "error"
            : "ok",
        detail:
          accounts.length === 0
            ? "No accounts configured"
            : `${healthy} healthy · ${unhealthy} unhealthy · ${accounts.length} total`,
      },
      {
        label: "Sync logs",
        status: syncLogs.some((l) => l.status === "FAILED") ? "warning" : "ok",
        detail: `${syncLogs.length} recent entries`,
      },
    ];

    setHealthChecks(checks);
    setLoading(false);
  }, [supabase, router, syncLogs]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) {
    return (
      <div className="space-y-6">
        <BackLink />
        <div className="space-y-2">
          <div className="h-8 w-48 animate-pulse rounded bg-gray-200" />
          <div className="h-4 w-64 animate-pulse rounded bg-gray-200" />
        </div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-12 w-full animate-pulse rounded-lg bg-gray-100"
          />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <BackLink />

      <div>
        <h1 className="text-2xl font-bold text-gray-900">Developer</h1>
        <p className="mt-1 text-sm text-gray-500">
          System diagnostics and activity logs
        </p>
      </div>

      {/* ── System Health ──────────────────────────────────────── */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span aria-hidden>📊</span>
            System Health
          </h2>
        </div>
        <div className="divide-y divide-gray-50">
          {healthChecks.map((check) => (
            <div
              key={check.label}
              className="px-4 py-3 sm:px-5 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900">
                  {check.label}
                </p>
                <p className="text-xs text-gray-500">{check.detail}</p>
              </div>
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ring-1 ring-inset whitespace-nowrap ${
                  STATUS_COLORS[check.status]
                }`}
              >
                {check.status === "ok"
                  ? "Operational"
                  : check.status === "warning"
                    ? "Degraded"
                    : "Error"}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Quick Links ────────────────────────────────────────── */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span aria-hidden>🔗</span>
            Quick Links
          </h2>
        </div>
        <div className="divide-y divide-gray-50">
          <Link
            href="/admin"
            className="flex items-center gap-3 px-4 py-3 sm:px-5 hover:bg-gray-50 transition-colors"
          >
            <span className="text-sm">📊</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900">Dashboard</p>
              <p className="text-xs text-gray-500">Operational overview</p>
            </div>
            <svg
              className="h-4 w-4 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </Link>
          <Link
            href="/admin/drive"
            className="flex items-center gap-3 px-4 py-3 sm:px-5 hover:bg-gray-50 transition-colors"
          >
            <span className="text-sm">☁</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900">Drive Accounts</p>
              <p className="text-xs text-gray-500">Google Drive management</p>
            </div>
            <svg
              className="h-4 w-4 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </Link>
          <Link
            href="/admin/media"
            className="flex items-center gap-3 px-4 py-3 sm:px-5 hover:bg-gray-50 transition-colors"
          >
            <span className="text-sm">🖼</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900">Media Browser</p>
              <p className="text-xs text-gray-500">Browse and manage media</p>
            </div>
            <svg
              className="h-4 w-4 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>
      </div>

      {/* ── Recent Sync Logs ──────────────────────────────────── */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span aria-hidden>🔄</span>
            Recent Sync Logs
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {syncLogs.length} entries from the sync_logs table
          </p>
        </div>

        {syncLogs.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-sm text-gray-500">No sync log entries</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50 max-h-[400px] overflow-y-auto">
            {syncLogs.map((log) => (
              <div key={log.id} className="px-4 py-2.5 sm:px-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 truncate">
                        {log.event_type}
                      </span>
                      {log.status && (
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            LOG_STATUS_COLORS[log.status] ?? "bg-gray-100 text-gray-700"
                          }`}
                        >
                          {log.status}
                        </span>
                      )}
                    </div>
                    {log.message && (
                      <p className="mt-0.5 text-xs text-gray-500 line-clamp-1">
                        {log.message}
                      </p>
                    )}
                  </div>
                  <span className="text-[11px] text-gray-400 flex-shrink-0 whitespace-nowrap">
                    {formatRelative(log.created_at)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Recent Audit Logs ──────────────────────────────────── */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span aria-hidden>📝</span>
            Recent Audit Logs
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {auditLogs.length} entries from the admin_audit_logs table
          </p>
        </div>

        {auditLogs.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-sm text-gray-500">No audit log entries</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50 max-h-[400px] overflow-y-auto">
            {auditLogs.map((log) => (
              <div key={log.id} className="px-4 py-2.5 sm:px-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 truncate">
                        {log.action}
                      </span>
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          log.success
                            ? "bg-green-100 text-green-800"
                            : "bg-red-100 text-red-800"
                        }`}
                      >
                        {log.success ? "success" : "failed"}
                      </span>
                    </div>
                    {log.details && Object.keys(log.details).length > 0 && (
                      <p className="mt-0.5 text-xs text-gray-500 truncate">
                        {JSON.stringify(log.details)}
                      </p>
                    )}
                  </div>
                  <span className="text-[11px] text-gray-400 flex-shrink-0 whitespace-nowrap">
                    {formatRelative(log.created_at)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
