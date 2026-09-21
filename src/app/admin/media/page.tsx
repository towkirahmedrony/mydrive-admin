import Link from "next/link";
import EmptyState from "@/components/EmptyState";
import EmployeeAvatar from "@/components/EmployeeAvatar";
import Pager from "@/components/Pager";
import RefreshButton from "@/components/RefreshButton";
import StatusBadge from "@/components/StatusBadge";
import { formatBytes } from "@/lib/format";
import {
  employeeDisplayName,
  employeeInitials,
  loadEmployeeFolders,
} from "@/lib/media-data";
import EmployeeSearch from "./employee-search";

type SearchParams = Promise<{ q?: string; page?: string }>;

function hrefFor(search: string, page: number): string {
  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/admin/media?${query}` : "/admin/media";
}

export default async function MediaEmployeesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const search = params.q?.trim() ?? "";
  const page = Math.max(1, Number(params.page) || 1);
  const { employees, total, pageSize, error } = await loadEmployeeFolders({
    search,
    page,
  });
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4 sm:space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-primary-600 sm:text-sm">Office Media Manager</p>
          <h1 className="mt-0.5 text-2xl font-bold tracking-tight text-gray-900 sm:mt-1 sm:text-3xl">Media</h1>
          <p className="mt-1 hidden text-sm text-gray-500 sm:mt-2 sm:block">
            Open an employee folder to browse that employee&apos;s media.
          </p>
          <nav className="mt-1 text-xs text-gray-500 sm:mt-3 sm:text-sm" aria-label="Breadcrumb">
            <ol className="flex items-center gap-2">
              <li>
                <Link href="/admin" className="hover:text-gray-700">
                  Dashboard
                </Link>
              </li>
              <li aria-hidden>/</li>
              <li className="font-medium text-gray-900">Employees</li>
            </ol>
          </nav>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <EmployeeSearch defaultValue={search} compact />
          <RefreshButton label="Refresh" iconOnly />
        </div>
      </header>

      <section className="grid grid-cols-3 gap-2 sm:gap-4">
        <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm sm:rounded-xl sm:p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Employees</p>
          <p className="mt-1 text-xl font-bold text-gray-900 sm:mt-2 sm:text-2xl">{total.toLocaleString()}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm sm:rounded-xl sm:p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">This page</p>
          <p className="mt-1 text-xl font-bold text-gray-900 sm:mt-2 sm:text-2xl">{employees.length}</p>
          <p className="mt-0.5 truncate text-[10px] text-gray-500 sm:mt-1 sm:text-xs">Folders</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm sm:rounded-xl sm:p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Search</p>
          <p className="mt-1 truncate text-xl font-bold text-gray-900 sm:mt-2 sm:text-2xl">{search ? "On" : "All"}</p>
          <p className="mt-0.5 truncate text-[10px] text-gray-500 sm:mt-1 sm:text-xs">Name / email</p>
        </div>
      </section>

      <div className="hidden sm:block">
        <EmployeeSearch defaultValue={search} />
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {employees.length === 0 ? (
        <EmptyState
          icon="[]"
          title={search ? "No employees match this search" : "No employees yet"}
          detail={
            search
              ? "Try a different name, email, employee ID, or designation."
              : "Employee folders appear here once profiles exist."
          }
        />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {employees.map((employee) => {
            const name = employeeDisplayName(employee);
            const used = formatBytes(employee.storage_used_bytes);
            return (
              <Link
                key={employee.id}
                href={`/admin/media/${employee.id}`}
                className="group block overflow-hidden rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-primary-300 hover:shadow-md"
              >
                <div className="flex items-start gap-4">
                  <EmployeeAvatar initials={employeeInitials(employee.full_name, employee.email)} />
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-base font-semibold text-gray-900" title={name}>
                      {name}
                    </h2>
                    <p className="truncate text-sm text-gray-500">
                      {employee.designation || "No designation"}
                    </p>
                  </div>
                  {employee.status !== "active" && (
                    <StatusBadge label={employee.status} tone="warning" />
                  )}
                </div>
                <div className="mt-5 border-t border-gray-100 pt-4">
                  <p className="text-sm font-medium text-gray-900">
                    {employee.media_count.toLocaleString()} media
                  </p>
                  <p className="mt-1 text-sm text-gray-500">{used ?? "0 B"}</p>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {total > pageSize && <Pager page={page} pageCount={pageCount} hrefFor={(next) => hrefFor(search, next)} />}
    </div>
  );
}
