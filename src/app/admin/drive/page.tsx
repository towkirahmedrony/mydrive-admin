import { createClient } from "@/lib/supabase/server";
import ConnectGoogleDriveButton from "@/components/ConnectGoogleDriveButton";
import DriveAccountCard, { type DriveAccount } from "@/components/DriveAccountCard";

/**
 * Edge Function that owns every Drive account read/write for the admin panel.
 * It is deployed with verify_jwt=true and is admin-only; calling it with the
 * signed-in admin's session JWT (forwarded automatically by
 * `supabase.functions.invoke`) is the only supported way to reach Drive data.
 * The service-role key never leaves the server.
 */
const DRIVE_ADMIN_FUNCTION = "drive-admin";

/** Shape of the `{ action: "list" }` response. */
interface DriveAdminListResponse {
  success?: boolean;
  accounts?: DriveAccount[];
  error?: string;
}

/** Shape of the `{ action: "routing" }` response. */
interface DriveAdminRoutingResponse {
  success?: boolean;
  total_accounts?: number;
  eligible_count?: number;
  eligible?: DriveAccount[];
  accounts?: Array<DriveAccount & { eligible?: boolean }>;
  safety_margin_bytes?: number;
  required_bytes?: number;
  error?: string;
}

/** Safe diagnostic logging: never tokens, JWTs, headers, cookies or secrets. */
function logDriveAccountsFetch(fields: Record<string, unknown>): void {
  console.info(
    `[GoogleDrive][drive_accounts_fetch] ${JSON.stringify({
      scope: "GoogleDrive",
      operation: "drive_accounts_fetch",
      timestamp: new Date().toISOString(),
      ...fields,
    })}`
  );
}

/**
 * Reads the JSON error body returned by the Edge Function (if any) so the admin
 * sees the actionable server message instead of a generic failure. Function
 * errors use `error`; the Supabase gateway uses `message`/`msg`. Never contains
 * token or header material.
 */
async function describeInvokeError(error: unknown): Promise<string> {
  const sdkMessage = (error as Error)?.message ?? null;
  const context = (error as { context?: unknown } | null)?.context;

  if (context && typeof (context as Response).json === "function") {
    try {
      const body = (await (context as Response).json()) as Record<
        string,
        unknown
      > | null;
      if (body && typeof body === "object") {
        for (const key of ["error", "message", "msg"] as const) {
          const value = body[key];
          if (typeof value === "string" && value.trim()) {
            return value;
          }
        }
      }
    } catch {
      // Non-JSON body: fall through to the SDK message.
    }
  }

  return sdkMessage ?? "The drive-admin service could not be reached.";
}

/**
 * Builds `accountId -> eligible` from the routing response.
 *
 * The response carries `accounts` (each with an `eligible` flag) and a
 * convenience `eligible` array; either is used so the indicator stays correct
 * regardless of which one the deployment returns.
 */
function buildEligibilityMap(
  routing: DriveAdminRoutingResponse | null
): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const item of routing?.accounts ?? []) {
    if (item?.id) map[item.id] = item.eligible === true;
  }
  for (const item of routing?.eligible ?? []) {
    if (item?.id) map[item.id] = true;
  }
  return map;
}

export default async function DriveAccountsPage() {
  const supabase = await createClient();

  // All Drive data comes from the `drive-admin` Edge Function. No direct
  // `drive_accounts` table access happens here (the browser and the server
  // never read credential columns).
  const [listResult, routingResult] = await Promise.all([
    supabase.functions.invoke<DriveAdminListResponse>(DRIVE_ADMIN_FUNCTION, {
      body: { action: "list" },
    }),
    supabase.functions.invoke<DriveAdminRoutingResponse>(DRIVE_ADMIN_FUNCTION, {
      body: { action: "routing", required_bytes: 0 },
    }),
  ]);

  let accounts: DriveAccount[] = [];
  let loadError: string | null = null;

  if (listResult.error) {
    loadError = await describeInvokeError(listResult.error);
    console.error(
      `[GoogleDrive][drive_accounts_fetch] ${JSON.stringify({
        scope: "GoogleDrive",
        operation: "drive_accounts_fetch",
        event: "invoke_failed",
        action: "list",
        errorMessage: loadError,
        timestamp: new Date().toISOString(),
      })}`
    );
  } else if (listResult.data?.success === false) {
    loadError =
      listResult.data.error ?? "The drive-admin service refused the request.";
  } else {
    accounts = listResult.data?.accounts ?? [];
  }

  // Routing failures are non-fatal: the accounts list still renders and the
  // eligibility indicator simply shows "unknown".
  let routingError: string | null = null;
  let routingAvailable = false;

  if (routingResult.error) {
    routingError = await describeInvokeError(routingResult.error);
  } else if (routingResult.data?.success === false) {
    routingError =
      routingResult.data.error ?? "Upload routing information is unavailable.";
  } else {
    routingAvailable = true;
  }

  const eligibleById = buildEligibilityMap(
    routingAvailable ? routingResult.data ?? null : null
  );

  if (!loadError) {
    logDriveAccountsFetch({
      event: "query_succeeded",
      accountCount: accounts.length,
      routingAvailable,
      timestamp: new Date().toISOString(),
    });
  }

  const totalAccounts = accounts.length;
  const activeAccounts = accounts.filter((a) => a.status === "active").length;
  const quotaFullAccounts = accounts.filter(
    (a) => a.status === "quota_full"
  ).length;
  const needsAttentionAccounts = accounts.filter(
    (a) =>
      ["reauth_required", "error", "disabled"].includes(a.status ?? "") ||
      Boolean(a.last_error)
  ).length;

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

      {loadError && (
        <div className="bg-white shadow rounded-lg p-6 border border-red-200">
          <div className="flex items-start space-x-3">
            <div className="text-2xl" aria-hidden="true">
              ⚠️
            </div>
            <div>
              <h2 className="text-lg font-medium text-gray-900">
                Could not load Drive accounts
              </h2>
              <p className="mt-1 text-sm text-red-700">{loadError}</p>
              <p className="mt-2 text-sm text-gray-500">
                The page is still usable — use Connect Google Drive above to add
                or reconnect an account, then reload this page.
              </p>
            </div>
          </div>
        </div>
      )}

      {!loadError && routingError && (
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded-lg text-sm">
          Upload routing information could not be loaded ({routingError}). The
          &ldquo;Eligible for new uploads&rdquo; indicator is shown as unknown.
        </div>
      )}

      {/* Account stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <div className="bg-white shadow rounded-lg p-4">
          <div className="text-sm text-gray-500">Total Accounts</div>
          <div className="text-2xl font-semibold text-gray-900">
            {totalAccounts}
          </div>
        </div>
        <div className="bg-white shadow rounded-lg p-4">
          <div className="text-sm text-gray-500">Active</div>
          <div className="text-2xl font-semibold text-green-600">
            {activeAccounts}
          </div>
        </div>
        <div className="bg-white shadow rounded-lg p-4">
          <div className="text-sm text-gray-500">Quota Full</div>
          <div className="text-2xl font-semibold text-yellow-600">
            {quotaFullAccounts}
          </div>
        </div>
        <div className="bg-white shadow rounded-lg p-4">
          <div className="text-sm text-gray-500">Needs Attention</div>
          <div className="text-2xl font-semibold text-red-600">
            {needsAttentionAccounts}
          </div>
        </div>
      </div>

      {/* Account list */}
      {loadError ? null : accounts.length > 0 ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {accounts.map((account) => (
            <DriveAccountCard
              key={account.id}
              account={account}
              eligible={eligibleById[account.id]}
              routingAvailable={routingAvailable}
            />
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
