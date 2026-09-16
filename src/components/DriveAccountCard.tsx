"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Note: credential material is intentionally absent from this interface.
// Refresh tokens live in Supabase Vault; drive_accounts only holds the secret
// reference (refresh_token_secret_id), which must never be sent to the browser.
interface DriveAccount {
  id: string;
  name: string;
  google_email: string;
  status: string;
  priority: number;
  storage_limit_bytes: number | null;
  storage_used_bytes: number | null;
  storage_available_bytes: number | null;
  last_quota_check_at: string | null;
  root_folder_id: string | null;
  created_at: string;
  updated_at: string;
}

export default function DriveAccountCard({ account }: { account: DriveAccount }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  const formatBytes = (bytes: number | null) => {
    if (bytes === null || bytes === undefined) return null;
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active":
        return "bg-green-100 text-green-800";
      case "quota_full":
        return "bg-yellow-100 text-yellow-800";
      case "reauth_required":
        return "bg-orange-100 text-orange-800";
      case "disabled":
        return "bg-gray-100 text-gray-800";
      case "error":
        return "bg-red-100 text-red-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const handleToggleStatus = async (newStatus: string) => {
    setLoading(true);
    setError(null);
    try {
      const { error: updateError } = await supabase
        .from("drive_accounts")
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq("id", account.id);

      if (updateError) {
        console.error("Error updating account status:", updateError);
        setError("Failed to update account status. Please try again.");
      } else {
        router.refresh();
      }
    } catch {
      setError("An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    // Check for dependent replication jobs before disconnecting
    const { count, error: countError } = await supabase
      .from("replication_jobs")
      .select("id", { count: "exact", head: true })
      .eq("drive_account_id", account.id);

    if (!countError && count && count > 0) {
      const confirmed = window.confirm(
        `This Drive account has ${count} replication job(s) associated with it. ` +
        `Disconnecting will not delete existing jobs but may affect pending ones. ` +
        `Are you sure you want to disconnect?`
      );
      if (!confirmed) return;
    } else {
      const confirmed = window.confirm(
        `Are you sure you want to disconnect the Drive account "${account.name}" (${account.google_email})? ` +
        `This will remove the connection from the admin panel.`
      );
      if (!confirmed) return;
    }

    setLoading(true);
    setError(null);
    try {
      const { error: deleteError } = await supabase
        .from("drive_accounts")
        .delete()
        .eq("id", account.id);

      if (deleteError) {
        console.error("Error disconnecting account:", deleteError);
        setError("Failed to disconnect account. Please try again.");
      } else {
        router.refresh();
      }
    } catch {
      setError("An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  const usedPercent =
    account.storage_limit_bytes && account.storage_used_bytes
      ? Math.round(
          (account.storage_used_bytes / account.storage_limit_bytes) * 100
        )
      : null;

  const storageUsed = formatBytes(account.storage_used_bytes);
  const storageAvailable = formatBytes(account.storage_available_bytes);
  const storageTotal = formatBytes(account.storage_limit_bytes);

  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <div className="p-6">
        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
            {error}
          </div>
        )}

        <div className="flex items-start justify-between">
          <div className="flex items-center space-x-3">
            <div className="flex-shrink-0">
              <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center">
                <span className="text-xl">☁️</span>
              </div>
            </div>
            <div>
              <h3 className="text-lg font-medium text-gray-900">
                {account.name}
              </h3>
              <p className="text-sm text-gray-500">{account.google_email}</p>
            </div>
          </div>
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(
              account.status
            )}`}
          >
            {account.status.replace("_", " ")}
          </span>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4">
          <div>
            <dt className="text-sm text-gray-500">Priority</dt>
            <dd className="mt-1 text-sm text-gray-900">{account.priority}</dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500">Connected</dt>
            <dd className="mt-1 text-sm text-gray-900">
              {new Date(account.created_at).toLocaleDateString()}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500">Storage Used</dt>
            <dd className="mt-1 text-sm text-gray-900">
              {storageUsed || <span className="text-gray-400">Not synced yet</span>}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500">Storage Available</dt>
            <dd className="mt-1 text-sm text-gray-900">
              {storageAvailable || <span className="text-gray-400">Not synced yet</span>}
            </dd>
          </div>
        </div>

        {storageTotal && usedPercent !== null && (
          <div className="mt-4">
            <div className="flex items-center justify-between text-sm text-gray-500 mb-1">
              <span>Storage Usage</span>
              <span>{usedPercent}% of {storageTotal}</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className={`h-2 rounded-full ${
                  usedPercent > 90
                    ? "bg-red-500"
                    : usedPercent > 75
                    ? "bg-yellow-500"
                    : "bg-green-500"
                }`}
                style={{ width: `${Math.min(usedPercent, 100)}%` }}
              />
            </div>
          </div>
        )}

        {account.root_folder_id && (
          <div className="mt-3 text-xs text-gray-400">
            Root folder: <code className="bg-gray-50 px-1 rounded">{account.root_folder_id}</code>
          </div>
        )}

        {account.last_quota_check_at && (
          <div className="mt-2 text-xs text-gray-400">
            Last quota check:{" "}
            {new Date(account.last_quota_check_at).toLocaleString()}
          </div>
        )}
      </div>

      <div className="bg-gray-50 px-6 py-3 flex items-center justify-between">
        <div className="flex space-x-3">
          {account.status === "active" ? (
            <button
              onClick={() => handleToggleStatus("disabled")}
              disabled={loading}
              className="text-sm text-gray-600 hover:text-gray-900 disabled:opacity-50 transition-colors"
            >
              Disable
            </button>
          ) : account.status === "disabled" ? (
            <button
              onClick={() => handleToggleStatus("active")}
              disabled={loading}
              className="text-sm text-primary-600 hover:text-primary-800 disabled:opacity-50 transition-colors"
            >
              Enable
            </button>
          ) : null}

          <button
            onClick={handleDisconnect}
            disabled={loading}
            className="text-sm text-red-600 hover:text-red-800 disabled:opacity-50 transition-colors"
          >
            Disconnect
          </button>
        </div>
      </div>
    </div>
  );
}
