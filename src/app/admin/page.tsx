import { createClient } from "@/lib/supabase/server";
import Link from "next/link";

export default async function AdminDashboard() {
  const supabase = await createClient();

  // Fetch drive account statistics
  const { data: driveStats } = await supabase
    .from("drive_accounts")
    .select("status");

  const stats = {
    total: driveStats?.length || 0,
    active: driveStats?.filter((a) => a.status === "active").length || 0,
    quotaFull: driveStats?.filter((a) => a.status === "quota_full").length || 0,
    reauthRequired:
      driveStats?.filter((a) => a.status === "reauth_required").length || 0,
    disabled: driveStats?.filter((a) => a.status === "disabled").length || 0,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">
          Overview of your My Drive system
        </p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <span className="text-3xl">☁️</span>
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    Total Drive Accounts
                  </dt>
                  <dd className="text-lg font-semibold text-gray-900">
                    {stats.total}
                  </dd>
                </dl>
              </div>
            </div>
          </div>
          <div className="bg-gray-50 px-5 py-3">
            <Link
              href="/admin/drive"
              className="text-sm font-medium text-primary-600 hover:text-primary-500"
            >
              View all →
            </Link>
          </div>
        </div>

        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <span className="text-3xl">✅</span>
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    Active Accounts
                  </dt>
                  <dd className="text-lg font-semibold text-green-600">
                    {stats.active}
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <span className="text-3xl">⚠️</span>
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    Quota Full
                  </dt>
                  <dd className="text-lg font-semibold text-yellow-600">
                    {stats.quotaFull}
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <span className="text-3xl">🔑</span>
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">
                    Re-auth Required
                  </dt>
                  <dd className="text-lg font-semibold text-red-600">
                    {stats.reauthRequired}
                  </dd>
                </dl>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg font-medium leading-6 text-gray-900">
            Quick Actions
          </h3>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Link
              href="/admin/drive"
              className="relative rounded-lg border border-gray-300 bg-white px-6 py-5 shadow-sm flex items-center space-x-3 hover:border-primary-400 hover:ring-1 hover:ring-primary-400 transition-all"
            >
              <div className="flex-shrink-0">
                <span className="text-2xl">☁️</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900">
                  Manage Drive Accounts
                </p>
                <p className="text-sm text-gray-500 truncate">
                  Connect, disconnect, and manage Google Drive accounts
                </p>
              </div>
            </Link>

            <Link
              href="/admin/jobs"
              className="relative rounded-lg border border-gray-300 bg-white px-6 py-5 shadow-sm flex items-center space-x-3 hover:border-primary-400 hover:ring-1 hover:ring-primary-400 transition-all"
            >
              <div className="flex-shrink-0">
                <span className="text-2xl">📋</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900">
                  View Backup Jobs
                </p>
                <p className="text-sm text-gray-500 truncate">
                  Monitor replication status and failures
                </p>
              </div>
            </Link>
          </div>
        </div>
      </div>

      {/* System status */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg font-medium leading-6 text-gray-900">
            System Status
          </h3>
          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">
                Database Connection
              </span>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                Connected
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">Drive System</span>
              <span
                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                  stats.active > 0
                    ? "bg-green-100 text-green-800"
                    : "bg-yellow-100 text-yellow-800"
                }`}
              >
                {stats.active > 0 ? "Operational" : "No Active Accounts"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
