/**
 * Storage & Media settings sub-page.
 *
 * Shows infrastructure status for Google Drive, Cloudinary, Telegram,
 * and media assets. Only safe status information is displayed — no API
 * keys, secrets, tokens, or OAuth credentials are ever shown or fetched.
 *
 * Schema discipline:
 *   Only columns documented in MYDRIVE_SCHEMA.md are used.
 */
"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type DriveAccount = {
  id: string;
  google_email: string;
  name: string | null;
  display_name: string | null;
  enabled: boolean;
  status: string;
  health_status: string;
  connection_status: string;
  storage_limit_bytes: number | string | null;
  storage_used_bytes: number | string | null;
  storage_available_bytes: number | string | null;
  priority: number;
  last_health_check_at: string | null;
  last_quota_check_at: string | null;
  last_error: string | null;
};

type TelegramConfig = {
  id: string;
  enabled: boolean;
  status: string;
  last_tested_at: string | null;
};

type MediaCounts = {
  total: number;
  ready: number;
  uploading: number;
  failed: number;
  deleted: number;
};

type SettingsPage = {
  compression_enabled: boolean;
  telegram_enabled: boolean;
  drive_enabled: boolean;
};

function formatBytes(bytes: number | string | null | undefined): string | null {
  if (bytes === null || bytes === undefined || bytes === "") return null;
  const value = typeof bytes === "string" ? Number(bytes) : bytes;
  if (!Number.isFinite(value)) return null;
  if (value === 0) return "0 B";
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(Math.abs(value)) / Math.log(1024)),
    sizes.length - 1,
  );
  const scaled = value / Math.pow(1024, index);
  return `${scaled.toFixed(scaled >= 100 || index === 0 ? 0 : 1)} ${sizes[index]}`;
}



function usagePercent(
  used: number | string | null | undefined,
  total: number | string | null | undefined,
): number | null {
  const u = typeof used === "string" ? Number(used) : used;
  const t = typeof total === "string" ? Number(total) : total;
  if (!Number.isFinite(u) || !Number.isFinite(t) || !t || t <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((u! / t!) * 100)));
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

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 px-4 sm:px-5">
      <span className="text-sm text-gray-500 flex-shrink-0">{label}</span>
      <span className="text-sm font-medium text-gray-900 text-right">
        {children}
      </span>
    </div>
  );
}

function StatusDot({ tone }: { tone: "success" | "warning" | "danger" | "neutral" }) {
  const colors = {
    success: "bg-green-500",
    warning: "bg-yellow-500",
    danger: "bg-red-500",
    neutral: "bg-gray-400",
  };
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${colors[tone]}`}
    />
  );
}

function accountHealthTone(account: DriveAccount): "success" | "warning" | "danger" | "neutral" {
  if (!account.enabled || account.status === "disabled") return "neutral";
  if (account.health_status === "healthy" && account.status === "active") return "success";
  if (account.health_status === "degraded" || account.status === "quota_full") return "warning";
  if (
    account.health_status === "unhealthy" ||
    account.status === "reauth_required" ||
    account.status === "error"
  ) {
    return "danger";
  }
  return "neutral";
}

export default function StorageSettingsPage() {
  const router = useRouter();
  const [driveAccounts, setDriveAccounts] = useState<DriveAccount[]>([]);
  const [telegramConfigs, setTelegramConfigs] = useState<TelegramConfig[]>([]);
  const [mediaCounts, setMediaCounts] = useState<MediaCounts>({
    total: 0,
    ready: 0,
    uploading: 0,
    failed: 0,
    deleted: 0,
  });
  const [appSettings, setAppSettings] = useState<SettingsPage | null>(null);
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

    const [
      { data: accounts },
      { data: configs },
      { data: settings },
      mediaTotal,
      mediaReady,
      mediaUploading,
      mediaFailed,
      mediaDeleted,
    ] = await Promise.all([
      supabase
        .from("drive_accounts")
        .select(
          "id,google_email,name,display_name,enabled,status,health_status,connection_status,storage_limit_bytes,storage_used_bytes,storage_available_bytes,priority,last_health_check_at,last_quota_check_at,last_error",
        )
        .order("created_at", { ascending: true }),
      supabase
        .from("telegram_configs")
        .select("id,enabled,status,last_tested_at"),
      supabase
        .from("app_settings")
        .select("compression_enabled,telegram_enabled,drive_enabled")
        .eq("id", true)
        .maybeSingle(),
      supabase
        .from("media_assets")
        .select("id", { count: "exact", head: true })
        .is("deleted_at", null)
        .neq("status", "DELETED"),
      supabase
        .from("media_assets")
        .select("id", { count: "exact", head: true })
        .eq("status", "READY")
        .is("deleted_at", null),
      supabase
        .from("media_assets")
        .select("id", { count: "exact", head: true })
        .eq("status", "UPLOADING")
        .is("deleted_at", null),
      supabase
        .from("media_assets")
        .select("id", { count: "exact", head: true })
        .eq("status", "FAILED")
        .is("deleted_at", null),
      supabase
        .from("media_assets")
        .select("id", { count: "exact", head: true })
        .eq("status", "DELETED"),
    ]);

    setDriveAccounts((accounts ?? []) as DriveAccount[]);
    setTelegramConfigs((configs ?? []) as TelegramConfig[]);
    setAppSettings(settings as SettingsPage | null);
    setMediaCounts({
      total: mediaTotal.count ?? 0,
      ready: mediaReady.count ?? 0,
      uploading: mediaUploading.count ?? 0,
      failed: mediaFailed.count ?? 0,
      deleted: mediaDeleted.count ?? 0,
    });
    setLoading(false);
  }, [supabase, router]);

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
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-16 w-full animate-pulse rounded-lg bg-gray-100"
          />
        ))}
      </div>
    );
  }

  const totalPoolUsed = driveAccounts.reduce<bigint>((sum, a) => {
    const v = a.storage_used_bytes;
    if (v === null || v === undefined || v === "") return sum;
    try {
      return sum + BigInt(typeof v === "string" ? v : Math.trunc(v));
    } catch {
      return sum;
    }
  }, BigInt(0));

  const totalPoolLimit = driveAccounts.reduce<bigint>((sum, a) => {
    const v = a.storage_limit_bytes;
    if (v === null || v === undefined || v === "") return sum;
    try {
      return sum + BigInt(typeof v === "string" ? v : Math.trunc(v));
    } catch {
      return sum;
    }
  }, BigInt(0));

  return (
    <div className="space-y-6">
      <BackLink />

      <div>
        <h1 className="text-2xl font-bold text-gray-900">Storage & Media</h1>
        <p className="mt-1 text-sm text-gray-500">
          Cloud storage configuration and media status
        </p>
      </div>

      {/* ── Google Drive Accounts ──────────────────────────────── */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span aria-hidden>📁</span>
            Google Drive
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Archive storage pool — connected accounts and health
          </p>
        </div>

        {driveAccounts.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-sm text-gray-500">
              No Google Drive accounts connected
            </p>
            <a
              href="/admin/drive"
              className="mt-2 inline-block text-sm font-medium text-primary-600 hover:text-primary-500"
            >
              Connect a Drive account →
            </a>
          </div>
        ) : (
          <>
            {/* Pool summary */}
            <div className="px-4 py-3 sm:px-5 bg-gray-50 border-b border-gray-100">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <p className="text-xs text-gray-500">Total</p>
                  <p className="text-sm font-medium text-gray-900">
                    {formatBytes(totalPoolLimit.toString()) ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Used</p>
                  <p className="text-sm font-medium text-gray-900">
                    {formatBytes(totalPoolUsed.toString()) ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Accounts</p>
                  <p className="text-sm font-medium text-gray-900">
                    {driveAccounts.length}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Healthy</p>
                  <p className="text-sm font-medium text-green-600">
                    {driveAccounts.filter((a) => accountHealthTone(a) === "success").length}
                  </p>
                </div>
              </div>
            </div>

            {/* Individual accounts */}
            <div className="divide-y divide-gray-50">
              {driveAccounts.map((account) => {
                const tone = accountHealthTone(account);
                const percent = usagePercent(
                  account.storage_used_bytes,
                  account.storage_limit_bytes,
                );
                return (
                  <div key={account.id} className="px-4 py-3 sm:px-5">
                    <div className="flex items-center gap-2.5">
                      <StatusDot tone={tone} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {account.display_name || account.name || account.google_email}
                        </p>
                        <p className="text-xs text-gray-500 truncate">
                          {account.google_email}
                        </p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-xs font-medium text-gray-700">
                          {account.enabled ? account.status : "disabled"}
                        </p>
                        {percent !== null && (
                          <div className="mt-1 h-1.5 w-16 rounded-full bg-gray-200">
                            <div
                              className={`h-1.5 rounded-full ${
                                percent >= 90
                                  ? "bg-red-500"
                                  : percent >= 75
                                    ? "bg-yellow-500"
                                    : "bg-green-500"
                              }`}
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                    {account.last_error && (
                      <p className="mt-1.5 text-xs text-red-600 line-clamp-1">
                        {account.last_error}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="px-4 py-3 sm:px-5 border-t border-gray-100">
              <a
                href="/admin/drive"
                className="text-sm font-medium text-primary-600 hover:text-primary-500"
              >
                Manage Drive accounts →
              </a>
            </div>
          </>
        )}
      </div>

      {/* ── Cloudinary ─────────────────────────────────────────── */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span aria-hidden>⚡</span>
            Cloudinary
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Primary media storage provider
          </p>
        </div>
        <div className="divide-y divide-gray-50">
          <Row label="Status">
            <span className="inline-flex items-center gap-1.5">
              <StatusDot tone={mediaCounts.ready > 0 ? "success" : "neutral"} />
              {mediaCounts.ready > 0 ? "Active" : "No media stored"}
            </span>
          </Row>
          <Row label="Compression">
            {appSettings?.compression_enabled ?? true ? "Enabled" : "Disabled"}
          </Row>
          <Row label="Stored media">
            {mediaCounts.ready} ready · {mediaCounts.failed} failed
          </Row>
        </div>
      </div>

      {/* ── Telegram Replication ────────────────────────────────── */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span aria-hidden>✈</span>
            Telegram
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Replication destination status
          </p>
        </div>
        <div className="divide-y divide-gray-50">
          <Row label="Replication">
            <span className="inline-flex items-center gap-1.5">
              <StatusDot
                tone={
                  !appSettings?.telegram_enabled
                    ? "neutral"
                    : telegramConfigs.some((c) => c.enabled && c.status === "active")
                      ? "success"
                      : "warning"
                }
              />
              {!appSettings?.telegram_enabled
                ? "Disabled"
                : telegramConfigs.some((c) => c.enabled && c.status === "active")
                  ? "Operational"
                  : telegramConfigs.length > 0
                    ? "Degraded"
                    : "Not configured"}
            </span>
          </Row>
          <Row label="Destinations">
            {telegramConfigs.length} configured ·{" "}
            {telegramConfigs.filter((c) => c.enabled).length} enabled
          </Row>
          {telegramConfigs.some((c) => c.status === "invalid") && (
            <Row label="Invalid configs">
              <span className="text-red-600">
                {telegramConfigs.filter((c) => c.status === "invalid").length} need attention
              </span>
            </Row>
          )}
        </div>
      </div>

      {/* ── Media Overview ──────────────────────────────────────── */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span aria-hidden>🖼</span>
            Media Assets
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Aggregate media status
          </p>
        </div>
        <div className="divide-y divide-gray-50">
          <Row label="Total">{mediaCounts.total}</Row>
          <Row label="Ready">{mediaCounts.ready}</Row>
          <Row label="Uploading">{mediaCounts.uploading}</Row>
          <Row label="Failed">
            <span className={mediaCounts.failed > 0 ? "text-red-600" : ""}>
              {mediaCounts.failed}
            </span>
          </Row>
          <Row label="Deleted">{mediaCounts.deleted}</Row>
        </div>
        <div className="px-4 py-3 sm:px-5 border-t border-gray-100">
          <Link
            href="/admin/media"
            className="text-sm font-medium text-primary-600 hover:text-primary-500"
          >
            Browse media →
          </Link>
        </div>
      </div>
    </div>
  );
}
