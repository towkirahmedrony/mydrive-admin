"use client";

/**
 * Directory filter controls.
 *
 * The same controls are rendered twice, which is the point of this module:
 *   - `variant="inline"` — a dense labelled row for `lg` and up.
 *   - `variant="sheet"`  — the body of the mobile bottom sheet, so small screens
 *     never carry a permanent filter panel.
 *
 * Every option maps to a documented column:
 *   status → `profiles.status` (active | suspended)
 *   devices → `devices` rows in the documented `active | disabled` states
 *   sync → `backup_sessions.status`
 *   storage → `profiles.storage_used_bytes` vs `profiles.storage_quota_bytes`
 * There is deliberately no Department control: the office has a single
 * department, so `profiles.department_id` is not surfaced.
 */
import { useEffect } from "react";
import {
  DEFAULT_DIRECTORY_FILTERS,
  filtersActive,
  type AccountStatusFilter,
  type DeviceFilter,
  type DirectoryFilters,
  type DirectorySort,
  type StorageFilter,
  type SyncFilter,
} from "@/lib/user-types";

type Option<T extends string> = { value: T; label: string };

const STATUS_OPTIONS: Option<AccountStatusFilter>[] = [
  { value: "ALL", label: "Any status" },
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
];

const DEVICE_OPTIONS: Option<DeviceFilter>[] = [
  { value: "ALL", label: "Any devices" },
  { value: "with_devices", label: "Has devices" },
  { value: "without_devices", label: "No devices" },
  { value: "with_disabled", label: "Has disabled device" },
];

const SYNC_OPTIONS: Option<SyncFilter>[] = [
  { value: "ALL", label: "Any sync state" },
  { value: "ok", label: "Synced" },
  { value: "backing_up", label: "Backing up" },
  { value: "failed", label: "Backup failed" },
  { value: "none", label: "No recent backup" },
];

const STORAGE_OPTIONS: Option<StorageFilter>[] = [
  { value: "ALL", label: "Any usage" },
  { value: "used_high", label: "90%+ of quota" },
  { value: "used_mid", label: "50–89% of quota" },
  { value: "used_low", label: "Under 50% of quota" },
  { value: "no_quota", label: "No quota set" },
];

const SORT_OPTIONS: Option<DirectorySort>[] = [
  { value: "name", label: "Name" },
  { value: "recent", label: "Last activity" },
  { value: "storage", label: "Storage used" },
  { value: "newest", label: "Recently added" },
];

const SELECT_CLASS =
  "h-8 w-full rounded-md border border-gray-300 bg-white px-2 text-xs text-gray-800 shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500";

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-gray-500">
        {label}
      </span>
      {children}
    </label>
  );
}

export function DirectoryFilterControls({
  filters,
  onChange,
  variant = "inline",
}: {
  filters: DirectoryFilters;
  onChange: (patch: Partial<DirectoryFilters>) => void;
  variant?: "inline" | "sheet";
}) {
  return (
    <div
      className={
        variant === "sheet"
          ? "grid grid-cols-1 gap-3 sm:grid-cols-2"
          : "hidden gap-2 lg:grid lg:grid-cols-3 xl:grid-cols-5"
      }
    >
      <Field label="Account">
        <select
          aria-label="Filter by account status"
          className={SELECT_CLASS}
          value={filters.status}
          onChange={(event) =>
            onChange({ status: event.target.value as AccountStatusFilter })
          }
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Devices">
        <select
          aria-label="Filter by device state"
          className={SELECT_CLASS}
          value={filters.devices}
          onChange={(event) =>
            onChange({ devices: event.target.value as DeviceFilter })
          }
        >
          {DEVICE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Backup">
        <select
          aria-label="Filter by backup and sync state"
          className={SELECT_CLASS}
          value={filters.sync}
          onChange={(event) => onChange({ sync: event.target.value as SyncFilter })}
        >
          {SYNC_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Storage">
        <select
          aria-label="Filter by storage usage"
          className={SELECT_CLASS}
          value={filters.storage}
          onChange={(event) =>
            onChange({ storage: event.target.value as StorageFilter })
          }
        >
          {STORAGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Sort">
        <select
          aria-label="Sort employees"
          className={SELECT_CLASS}
          value={filters.sort}
          onChange={(event) => onChange({ sort: event.target.value as DirectorySort })}
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

/**
 * Compact trigger plus the bottom sheet itself.
 *
 * The sheet is `lg:hidden`: on desktop the inline row is always visible, so
 * opening a sheet there would be redundant.
 */
export function DirectoryFilterSheet({
  filters,
  onChange,
  onReset,
  open,
  onOpenChange,
}: {
  filters: DirectoryFilters;
  onChange: (patch: Partial<DirectoryFilters>) => void;
  onReset: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const activeCount = filtersActive(filters);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(true)}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 lg:hidden"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" d="M4 6h16M7 12h10M10 18h4" />
        </svg>
        Filters
        {activeCount > 0 && (
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary-600 px-1 text-[10px] font-semibold text-white">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/40 lg:hidden"
          role="presentation"
          onClick={() => onOpenChange(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Employee filters"
            className="max-h-[85vh] w-full overflow-y-auto rounded-t-2xl bg-white p-4 pb-5 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold text-gray-900">Filters</p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={onReset}
                  disabled={activeCount === 0 && filters.sort === DEFAULT_DIRECTORY_FILTERS.sort}
                  className="text-xs font-medium text-primary-700 disabled:text-gray-400"
                >
                  Reset
                </button>
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  aria-label="Close filters"
                  className="text-gray-400 hover:text-gray-600"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="h-5 w-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <DirectoryFilterControls
              filters={filters}
              onChange={onChange}
              variant="sheet"
            />

            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="mt-4 h-10 w-full rounded-lg bg-primary-600 text-sm font-medium text-white hover:bg-primary-500"
            >
              Show results
            </button>
          </div>
        </div>
      )}
    </>
  );
}
