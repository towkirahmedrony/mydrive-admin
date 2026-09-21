"use client";

/**
 * Actions for one employee record.
 *
 * Scope discipline
 * ----------------
 * `View Media` is a link — the media grid stays on the Media page and is never
 * duplicated here. The only mutation is the account status, which is the single
 * write the schema and the deployed authorization design support (see
 * `../actions.ts`).
 *
 * The confirmation dialog is not decoration: suspending is security-sensitive,
 * so it states exactly what changes, what does not, and that the change is
 * audited. The actual authorization decision is still made on the server — this
 * component only asks for it.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { setAccountStatus } from "../actions";

type AccountStatusValue = "active" | "suspended";

export default function UserActions({
  userId,
  name,
  status,
  isSelf,
}: {
  userId: string;
  name: string;
  status: string;
  /** True when this record is the signed-in admin's own profile. */
  isSelf: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<AccountStatusValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const nextStatus: AccountStatusValue =
    status === "suspended" ? "active" : "suspended";
  const suspending = nextStatus === "suspended";

  const apply = async () => {
    if (!confirming) return;
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const result = await setAccountStatus({ userId, status: confirming });
      setConfirming(null);

      if (!result.success) {
        setError(result.error ?? "The account status could not be updated.");
        return;
      }

      setNotice(
        result.auditLogged === false
          ? `${suspending ? "Account suspended" : "Account reactivated"}, but the audit entry could not be recorded.`
          : suspending
            ? "Account suspended."
            : "Account reactivated.",
      );
      router.refresh();
    } catch {
      setConfirming(null);
      setError("The change could not be applied. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/admin/media/${userId}`}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary-600 px-3 text-xs font-medium text-white shadow-sm hover:bg-primary-500"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path strokeLinecap="round" d="m3 16 5-4 4 3 3-2 6 5" />
          </svg>
          View Media
        </Link>

        {isSelf ? (
          <span className="text-[11px] text-gray-500">
            This is your own account.
          </span>
        ) : (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setNotice(null);
              setConfirming(nextStatus);
            }}
            className={
              suspending
                ? "inline-flex h-9 items-center rounded-lg border border-red-300 bg-white px-3 text-xs font-medium text-red-700 shadow-sm hover:bg-red-50"
                : "inline-flex h-9 items-center rounded-lg border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50"
            }
          >
            {suspending ? "Suspend account" : "Reactivate account"}
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="text-[11px] text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-[11px] text-green-700">
          {notice}
        </p>
      )}

      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
          role="presentation"
          onClick={() => (busy ? undefined : setConfirming(null))}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="status-dialog-title"
            className="w-full max-w-md rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2
              id="status-dialog-title"
              className="text-sm font-semibold text-gray-900"
            >
              {suspending ? "Suspend this account?" : "Reactivate this account?"}
            </h2>
            <p className="mt-2 text-xs leading-5 text-gray-600">
              {suspending ? (
                <>
                  <span className="font-medium text-gray-900">{name}</span> is set to{" "}
                  <span className="font-medium">Suspended</span>. Only the account
                  status changes — devices stay registered, and media, storage and
                  profile details are not touched. You can reactivate at any time.
                </>
              ) : (
                <>
                  <span className="font-medium text-gray-900">{name}</span> is set
                  back to <span className="font-medium">Active</span>. Nothing else
                  about this employee changes.
                </>
              )}
            </p>
            <p className="mt-2 text-[11px] text-gray-500">
              The change is applied by the backend and recorded in the admin audit
              log.
            </p>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(null)}
                disabled={busy}
                className="inline-flex h-9 items-center rounded-lg border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={apply}
                disabled={busy}
                className={
                  suspending
                    ? "inline-flex h-9 items-center rounded-lg bg-red-600 px-3 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
                    : "inline-flex h-9 items-center rounded-lg bg-primary-600 px-3 text-xs font-medium text-white hover:bg-primary-500 disabled:opacity-50"
                }
              >
                {busy
                  ? "Applying…"
                  : suspending
                    ? "Suspend account"
                    : "Reactivate account"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
