/**
 * Security settings sub-page.
 *
 * Shows authentication status, account security information, and provides
 * account status management. No secrets, tokens, or credentials are
 * ever displayed.
 *
 * The account status toggle uses the existing `guard_profile_privileged_columns`
 * trigger-protected write path.
 */
"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { updateAccountStatus } from "../actions";

type SecurityData = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: string;
  status: string;
  created_at: string | null;
  last_seen_at: string | null;
  deviceCount: number;
  activeDeviceCount: number;
};

function formatTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
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

export default function SecuritySettingsPage() {
  const router = useRouter();
  const [data, setData] = useState<SecurityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

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
      { data: profile },
      { count: deviceCount },
      { count: activeDeviceCount },
    ] = await Promise.all([
      supabase
        .from("profiles")
        .select("id,email,full_name,role,status,created_at,last_seen_at")
        .eq("id", user.id)
        .maybeSingle(),
      supabase
        .from("devices")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id),
      supabase
        .from("devices")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("status", "active"),
    ]);

    setData({
      ...(profile as SecurityData),
      deviceCount: deviceCount ?? 0,
      activeDeviceCount: activeDeviceCount ?? 0,
    });
    setLoading(false);
  }, [supabase, router]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleStatusToggle = async () => {
    if (!data) return;
    setStatusUpdating(true);
    setStatusMessage(null);

    const newStatus = data.status === "active" ? "suspended" : "active";
    const result = await updateAccountStatus(newStatus);

    if (result.success) {
      setData((prev) =>
        prev ? { ...prev, status: result.status! } : prev,
      );
      setStatusMessage(
        `Account status changed to ${result.status === "active" ? "Active" : "Suspended"}`,
      );
    } else {
      setStatusMessage(result.error ?? "Failed to update status");
    }

    setStatusUpdating(false);
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    await supabase.auth.signOut();
    router.push("/auth/login");
    router.refresh();
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

  return (
    <div className="space-y-6">
      <BackLink />

      <div>
        <h1 className="text-2xl font-bold text-gray-900">Security</h1>
        <p className="mt-1 text-sm text-gray-500">
          Authentication status and account controls
        </p>
      </div>

      {/* Status message */}
      {statusMessage && (
        <div className="rounded-lg border border-primary-200 bg-primary-50 p-4">
          <p className="text-sm text-primary-800">{statusMessage}</p>
        </div>
      )}

      {/* ── Authentication ────────────────────────────────────── */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span aria-hidden>🔐</span>
            Authentication
          </h2>
        </div>
        <div className="divide-y divide-gray-50">
          <Row label="Provider">Supabase Auth (email + password)</Row>
          <Row label="Admin role">
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                data?.role === "admin"
                  ? "bg-primary-100 text-primary-800"
                  : "bg-gray-100 text-gray-700"
              }`}
            >
              {data?.role === "admin" ? "Admin" : data?.role ?? "—"}
            </span>
          </Row>
          <Row label="Email verified">
            {data?.email ? "Yes" : "No email on file"}
          </Row>
        </div>
      </div>

      {/* ── Account Status ────────────────────────────────────── */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span aria-hidden>👤</span>
            Account Status
          </h2>
        </div>
        <div className="divide-y divide-gray-50">
          <Row label="Current status">
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                data?.status === "active"
                  ? "bg-green-100 text-green-800"
                  : "bg-red-100 text-red-800"
              }`}
            >
              {data?.status === "active"
                ? "Active"
                : data?.status === "suspended"
                  ? "Suspended"
                  : data?.status ?? "—"}
            </span>
          </Row>
          <Row label="Account created">
            {formatTimestamp(data?.created_at) ?? "—"}
          </Row>
          <Row label="Last seen">
            {formatTimestamp(data?.last_seen_at) ?? "Never"}
          </Row>
        </div>

        <div className="px-4 py-3 sm:px-5 border-t border-gray-100">
          <button
            onClick={handleStatusToggle}
            disabled={statusUpdating}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-200 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            {statusUpdating
              ? "Updating…"
              : data?.status === "active"
                ? "Deactivate account"
                : "Reactivate account"}
          </button>
        </div>
      </div>

      {/* ── Registered Devices ────────────────────────────────── */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span aria-hidden>📱</span>
            Registered Devices
          </h2>
        </div>
        <div className="divide-y divide-gray-50">
          <Row label="Total devices">{data?.deviceCount ?? 0}</Row>
          <Row label="Active devices">
            <span
              className={
                (data?.activeDeviceCount ?? 0) > 0
                  ? "text-green-600"
                  : "text-gray-500"
              }
            >
              {data?.activeDeviceCount ?? 0}
            </span>
          </Row>
        </div>
      </div>

      {/* ── Sign Out ──────────────────────────────────────────── */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span aria-hidden>🚪</span>
            Session
          </h2>
        </div>
        <div className="px-4 py-3 sm:px-5">
          <p className="text-sm text-gray-500 mb-3">
            Sign out of this admin session. You will need to re-authenticate
            to access the panel.
          </p>
          <button
            onClick={handleSignOut}
            disabled={signingOut}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors disabled:opacity-50"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </div>
    </div>
  );
}
