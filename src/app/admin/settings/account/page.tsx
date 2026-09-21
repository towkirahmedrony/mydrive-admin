/**
 * Account settings sub-page.
 *
 * Shows the signed-in admin's profile information and provides a sign-out
 * action. The sign-out uses the same Supabase client + router pattern
 * already present in AdminShell.tsx.
 *
 * No database fields are invented. Only `profiles` columns documented
 * in MYDRIVE_SCHEMA.md are displayed.
 */
"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type ProfileData = {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string;
  status: string;
  designation: string | null;
  employee_id: string | null;
  created_at: string | null;
  last_seen_at: string | null;
  storage_quota_bytes: number | string | null;
  storage_used_bytes: number | string | null;
};

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

export default function AccountSettingsPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingOut, setSigningOut] = useState(false);

  const supabase = createClient();

  const fetchProfile = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.push("/auth/login");
      return;
    }

    const { data } = await supabase
      .from("profiles")
      .select(
        "id,full_name,email,role,status,designation,employee_id,created_at,last_seen_at,storage_quota_bytes,storage_used_bytes",
      )
      .eq("id", user.id)
      .maybeSingle();

    setProfile(data as ProfileData | null);
    setLoading(false);
  }, [supabase, router]);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

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
        {Array.from({ length: 8 }).map((_, i) => (
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
        <h1 className="text-2xl font-bold text-gray-900">Account</h1>
        <p className="mt-1 text-sm text-gray-500">
          Your admin profile and account information
        </p>
      </div>

      {/* Profile card */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span aria-hidden>👤</span>
            Admin profile
          </h2>
        </div>
        <div className="divide-y divide-gray-50">
          <Row label="Full name">
            {profile?.full_name?.trim() || "—"}
          </Row>
          <Row label="Email">{profile?.email || "—"}</Row>
          <Row label="Role">
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                profile?.role === "admin"
                  ? "bg-primary-100 text-primary-800"
                  : "bg-gray-100 text-gray-700"
              }`}
            >
              {profile?.role === "admin" ? "Admin" : profile?.role ?? "—"}
            </span>
          </Row>
          <Row label="Account status">
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                profile?.status === "active"
                  ? "bg-green-100 text-green-800"
                  : "bg-red-100 text-red-800"
              }`}
            >
              {profile?.status === "active" ? "Active" : profile?.status ?? "—"}
            </span>
          </Row>
          {profile?.designation && (
            <Row label="Designation">{profile.designation}</Row>
          )}
          {profile?.employee_id && (
            <Row label="Employee ID">{profile.employee_id}</Row>
          )}
        </div>
      </div>

      {/* Storage card */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span aria-hidden>💾</span>
            Storage
          </h2>
        </div>
        <div className="divide-y divide-gray-50">
          <Row label="Used">
            {formatBytes(profile?.storage_used_bytes) ?? "—"}
          </Row>
          <Row label="Quota">
            {formatBytes(profile?.storage_quota_bytes) ?? "Not configured"}
          </Row>
        </div>
      </div>

      {/* Activity card */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span aria-hidden>🕐</span>
            Activity
          </h2>
        </div>
        <div className="divide-y divide-gray-50">
          <Row label="Account created">
            {formatTimestamp(profile?.created_at) ?? "—"}
          </Row>
          <Row label="Last seen">
            {formatTimestamp(profile?.last_seen_at) ?? "Never"}
          </Row>
        </div>
      </div>

      {/* Sign out */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5">
          <button
            onClick={handleSignOut}
            disabled={signingOut}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors disabled:opacity-50"
          >
            {signingOut ? (
              <>
                <svg
                  className="animate-spin h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                Signing out…
              </>
            ) : (
              <>
                <span aria-hidden>🚪</span>
                Sign out
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
