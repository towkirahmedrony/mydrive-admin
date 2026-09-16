import { createClient } from "@/lib/supabase/server";
import ConnectGoogleDriveButton from "@/components/ConnectGoogleDriveButton";
import DriveAccountCard from "@/components/DriveAccountCard";

export default async function DriveAccountsPage() {
  const supabase = await createClient();

  // Fetch all drive accounts (admin-only via RLS), using only columns that
  // exist in the live drive_accounts schema.
  // refresh_token_secret_id is selected server-side only to determine whether
  // a credential is stored; it is stripped before accounts reach the browser.
  const { data: accounts, error } = await supabase
    .from("drive_accounts")
    .select("id, name, google_email, refresh_token_secret_id, root_folder_id, priority, status, storage_limit_bytes, storage_used_bytes, storage_available_bytes, last_quota_check_at, created_at, updated_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error fetching drive accounts:", error);
  }

  const safeAccounts = (accounts ?? []).map(({ refresh_token_secret_id, ...row }) => row);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Drive Accounts</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage Google Drive accounts connected to your My Drive system
          </p>
        </div>
        <ConnectGoogleDriveButton />
      </div>

      {/* Account stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <div className="bg-white shadow rounded-lg p-4">
          <div className="text-sm text-gray-500">Total Accounts</div>
          <div className="text-2xl font-semibold text-gray-900">
            {safeAccounts.length || 0}
          </div>
        </div>
        <div className="bg-white shadow rounded-lg p-4">
          <div className="text-sm text-gray-500">Active</div>
          <div className="text-2xl font-semibold text-green-600">
            {safeAccounts.filter((a) => a.status === "active").length || 0}
          </div>
        </div>
        <div className="bg-white shadow rounded-lg p-4">
          <div className="text-sm text-gray-500">Quota Full</div>
          <div className="text-2xl font-semibold text-yellow-600">
            {safeAccounts.filter((a) => a.status === "quota_full").length || 0}
          </div>
        </div>
        <div className="bg-white shadow rounded-lg p-4">
          <div className="text-sm text-gray-500">Needs Attention</div>
          <div className="text-2xl font-semibold text-red-600">
            {safeAccounts.filter((a) =>
              ["reauth_required", "error", "disabled"].includes(a.status)
            ).length || 0}
          </div>
        </div>
      </div>

      {/* Account list */}
      {safeAccounts.length > 0 ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {safeAccounts.map((account) => (
            <DriveAccountCard key={account.id} account={account} />
          ))}
        </div>
      ) : (
        <div className="bg-white shadow rounded-lg p-12 text-center">
          <div className="text-4xl mb-4">☁️</div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            No Drive Accounts Connected
          </h3>
          <p className="text-sm text-gray-500 mb-6 max-w-md mx-auto">
            Connect a Google Drive account to start backing up media files. You
            can connect multiple accounts for redundancy and load balancing.
          </p>
          <ConnectGoogleDriveButton />
        </div>
      )}
    </div>
  );
}
