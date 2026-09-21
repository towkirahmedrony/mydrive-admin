/**
 * Backup & Sync settings sub-page.
 *
 * Shows backup session history, retry configuration, and auto-delete
 * policies from the `app_settings` table. Only fields documented in
 * MYDRIVE_SCHEMA.md are exposed.
 *
 * The auto-delete toggles write to `app_settings` via server actions,
 * guarded by `requireAdminActor`.
 */
"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { updateAppSetting } from "../actions";

type AppSettings = {
  max_retry: number;
  retry_base_delay_seconds: number;
  auto_delete_primary_after_replication: boolean;
  auto_delete_telegram_on_media_delete: boolean;
  auto_delete_drive_on_media_delete: boolean;
};

type BackupSession = {
  id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  files_count: number | null;
  files_uploaded: number | null;
  files_failed: number | null;
  total_size_bytes: number | string | null;
  error_message: string | null;
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

function formatTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
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

function ToggleSetting({
  label,
  description,
  enabled,
  onToggle,
  saving,
}: {
  label: string;
  description: string;
  enabled: boolean;
  onToggle: () => void;
  saving: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 px-4 sm:px-5">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900">{label}</p>
        <p className="mt-0.5 text-xs text-gray-500">{description}</p>
      </div>
      <button
        onClick={onToggle}
        disabled={saving}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:opacity-50 ${
          enabled ? "bg-primary-600" : "bg-gray-200"
        }`}
        role="switch"
        aria-checked={enabled}
        aria-label={label}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
            enabled ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

const SESSION_STATUS_TONE: Record<string, string> = {
  COMPLETED: "bg-green-100 text-green-800",
  FAILED: "bg-red-100 text-red-800",
  RUNNING: "bg-blue-100 text-blue-800",
  CANCELLED: "bg-yellow-100 text-yellow-800",
};

export default function BackupSettingsPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sessions, setSessions] = useState<BackupSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingField, setSavingField] = useState<string | null>(null);

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
      { data: appSettings },
      { data: backupSessions },
    ] = await Promise.all([
      supabase
        .from("app_settings")
        .select(
          "max_retry,retry_base_delay_seconds,auto_delete_primary_after_replication,auto_delete_telegram_on_media_delete,auto_delete_drive_on_media_delete",
        )
        .eq("id", true)
        .maybeSingle(),
      supabase
        .from("backup_sessions")
        .select(
          "id,status,started_at,completed_at,files_count,files_uploaded,files_failed,total_size_bytes,error_message",
        )
        .order("started_at", { ascending: false })
        .limit(20),
    ]);

    setSettings(appSettings as AppSettings | null);
    setSessions((backupSessions ?? []) as BackupSession[]);
    setLoading(false);
  }, [supabase, router]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleToggle = async (
    field:
      | "auto_delete_primary_after_replication"
      | "auto_delete_telegram_on_media_delete"
      | "auto_delete_drive_on_media_delete",
  ) => {
    if (!settings) return;
    setSavingField(field);
    const newValue = !settings[field];
    const result = await updateAppSetting(field, newValue);
    if (result.success) {
      setSettings((prev) =>
        prev ? { ...prev, [field]: newValue } : prev,
      );
    }
    setSavingField(null);
  };

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
            className="h-14 w-full animate-pulse rounded-lg bg-gray-100"
          />
        ))}
      </div>
    );
  }

  const completedCount = sessions.filter(
    (s) => s.status === "COMPLETED",
  ).length;
  const failedCount = sessions.filter((s) => s.status === "FAILED").length;

  return (
    <div className="space-y-6">
      <BackLink />

      <div>
        <h1 className="text-2xl font-bold text-gray-900">Backup & Sync</h1>
        <p className="mt-1 text-sm text-gray-500">
          Backup policies, retry configuration, and auto-delete settings
        </p>
      </div>

      {/* ── Retry Policy ────────────────────────────────────────── */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span aria-hidden>🔁</span>
            Retry Policy
          </h2>
        </div>
        <div className="divide-y divide-gray-50">
          <Row label="Max retries">
            {settings?.max_retry ?? 5}
          </Row>
          <Row label="Base delay">
            {settings?.retry_base_delay_seconds ?? 60}s
          </Row>
        </div>
      </div>

      {/* ── Auto-Delete Policies ─────────────────────────────────── */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span aria-hidden>🗑</span>
            Auto-Delete
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Control when primary media is deleted after replication
          </p>
        </div>
        <div className="divide-y divide-gray-50">
          <ToggleSetting
            label="Delete primary after Drive archive"
            description="Remove the Cloudinary original once a verified Google Drive copy exists"
            enabled={settings?.auto_delete_primary_after_replication ?? false}
            onToggle={() =>
              handleToggle("auto_delete_primary_after_replication")
            }
            saving={savingField === "auto_delete_primary_after_replication"}
          />
          <ToggleSetting
            label="Delete on Telegram media delete"
            description="Remove the primary file when its Telegram replication is deleted"
            enabled={
              settings?.auto_delete_telegram_on_media_delete ?? false
            }
            onToggle={() =>
              handleToggle("auto_delete_telegram_on_media_delete")
            }
            saving={savingField === "auto_delete_telegram_on_media_delete"}
          />
          <ToggleSetting
            label="Delete on Drive media delete"
            description="Remove the primary file when its Drive archive is deleted"
            enabled={settings?.auto_delete_drive_on_media_delete ?? false}
            onToggle={() =>
              handleToggle("auto_delete_drive_on_media_delete")
            }
            saving={savingField === "auto_delete_drive_on_media_delete"}
          />
        </div>
      </div>

      {/* ── Recent Backup Sessions ──────────────────────────────── */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span aria-hidden>📋</span>
            Recent Backup Sessions
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {sessions.length} session{sessions.length === 1 ? "" : "s"} in
            history · {completedCount} completed · {failedCount} failed
          </p>
        </div>

        {sessions.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-sm text-gray-500">
              No backup sessions recorded
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {sessions.map((session) => (
              <div
                key={session.id}
                className="px-4 py-3 sm:px-5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${
                          SESSION_STATUS_TONE[session.status] ?? "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {session.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      {session.files_uploaded ?? 0}/{session.files_count ?? 0}{" "}
                      files · {formatBytes(session.total_size_bytes) ?? "—"}
                    </p>
                    {session.error_message && (
                      <p className="mt-0.5 text-xs text-red-600 line-clamp-1">
                        {session.error_message}
                      </p>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-xs text-gray-400">
                      {formatRelative(session.started_at)}
                    </p>
                    {session.completed_at && (
                      <p className="text-xs text-gray-400">
                        {formatTimestamp(session.completed_at)}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
