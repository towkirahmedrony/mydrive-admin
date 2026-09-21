/**
 * Notifications settings sub-page.
 *
 * Shows admin notifications from the `notifications` table. Only fields
 * documented in MYDRIVE_SCHEMA.md are used.
 *
 * Notification types are whatever the backend stores in `notification_type`;
 * no types are invented.
 */
"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Notification = {
  id: string;
  title: string;
  body: string | null;
  notification_type: string | null;
  is_read: boolean;
  created_at: string | null;
  read_at: string | null;
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

const TYPE_ICONS: Record<string, string> = {
  backup_failed: "⚠️",
  backup_completed: "✅",
  system_alert: "🔔",
  quota_warning: "💾",
  drive_error: "📁",
};

function typeIcon(type: string | null): string {
  if (!type) return "📩";
  return TYPE_ICONS[type] ?? "📩";
}

export default function NotificationsSettingsPage() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]);
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

    const { data } = await supabase
      .from("notifications")
      .select("id,title,body,notification_type,is_read,created_at,read_at")
      .order("created_at", { ascending: false })
      .limit(50);

    setNotifications((data ?? []) as Notification[]);
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
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-16 w-full animate-pulse rounded-lg bg-gray-100"
          />
        ))}
      </div>
    );
  }

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  // Group by type
  const grouped = new Map<string, Notification[]>();
  for (const notif of notifications) {
    const type = notif.notification_type ?? "other";
    const list = grouped.get(type);
    if (list) list.push(notif);
    else grouped.set(type, [notif]);
  }

  return (
    <div className="space-y-6">
      <BackLink />

      <div>
        <h1 className="text-2xl font-bold text-gray-900">Notifications</h1>
        <p className="mt-1 text-sm text-gray-500">
          System alerts and admin notifications
        </p>
      </div>

      {/* Summary */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-3 sm:px-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span aria-hidden>🔔</span>
              <span className="text-sm font-medium text-gray-900">
                {notifications.length} notification{notifications.length === 1 ? "" : "s"}
              </span>
            </div>
            {unreadCount > 0 && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                {unreadCount} unread
              </span>
            )}
          </div>
        </div>
      </div>

      {notifications.length === 0 ? (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <div className="px-4 py-8 text-center">
            <span className="text-3xl" aria-hidden>
              🔔
            </span>
            <p className="mt-2 text-sm font-medium text-gray-700">
              No notifications
            </p>
            <p className="mt-1 text-xs text-gray-500">
              System alerts and admin notifications will appear here
            </p>
          </div>
        </div>
      ) : (
        Array.from(grouped.entries()).map(([type, notifs]) => (
          <div
            key={type}
            className="bg-white shadow rounded-lg overflow-hidden"
          >
            <div className="px-4 py-3 sm:px-5 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                <span aria-hidden>{typeIcon(type)}</span>
                {type.replace(/_/g, " ")}
                <span className="text-xs font-normal text-gray-400">
                  ({notifs.length})
                </span>
              </h2>
            </div>
            <div className="divide-y divide-gray-50">
              {notifs.map((notif) => (
                <div
                  key={notif.id}
                  className={`px-4 py-3 sm:px-5 ${
                    !notif.is_read ? "bg-primary-50/30" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {!notif.is_read && (
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary-600 flex-shrink-0" />
                        )}
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {notif.title}
                        </p>
                      </div>
                      {notif.body && (
                        <p className="mt-0.5 text-xs text-gray-500 line-clamp-2">
                          {notif.body}
                        </p>
                      )}
                    </div>
                    <span className="text-xs text-gray-400 flex-shrink-0 whitespace-nowrap">
                      {formatRelative(notif.created_at)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
