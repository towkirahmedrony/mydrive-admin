import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import EmployeeAvatar from "@/components/EmployeeAvatar";
import Pager from "@/components/Pager";
import RefreshButton from "@/components/RefreshButton";
import StatusBadge from "@/components/StatusBadge";
import { formatBytes, usagePercent } from "@/lib/format";
import {
  employeeDisplayName,
  employeeInitials,
  loadEmployeeMedia,
  loadEmployeeSummary,
  type ArchiveFilter,
  type CleanupFilter,
  type MediaKind,
  type MediaSort,
  type MediaStatusFilter,
} from "@/lib/media-data";
import MediaBrowser from "./media-browser";

type SearchParams = Promise<{
  q?: string;
  kind?: string;
  status?: string;
  archive?: string;
  cleanup?: string;
  sort?: string;
  from?: string;
  to?: string;
  view?: string;
  page?: string;
}>;

function asKind(value: string | undefined): MediaKind {
  return value === "IMAGE" || value === "VIDEO" ? value : "ALL";
}

function asStatus(value: string | undefined): MediaStatusFilter {
  return value === "UPLOADING" || value === "READY" || value === "FAILED" || value === "DELETED"
    ? value
    : "ALL";
}

function asArchive(value: string | undefined): ArchiveFilter {
  return value === "archived" || value === "pending" ? value : "ALL";
}

function asCleanup(value: string | undefined): CleanupFilter {
  return value === "none" ||
    value === "cleanup_pending" ||
    value === "cleanup_processing" ||
    value === "cleanup_success" ||
    value === "cleanup_failed"
    ? value
    : "ALL";
}

function asSort(value: string | undefined): MediaSort {
  return value === "oldest" ||
    value === "largest" ||
    value === "smallest" ||
    value === "name"
    ? value
    : "newest";
}

function hrefFor(userId: string, current: URLSearchParams, page: number): string {
  const params = new URLSearchParams(current);
  if (page > 1) params.set("page", String(page));
  else params.delete("page");
  const query = params.toString();
  return query ? `/admin/media/${userId}?${query}` : `/admin/media/${userId}`;
}

export default async function EmployeeMediaPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: SearchParams;
}) {
  const { userId } = await params;
  const query = await searchParams;
  const { employee, error: employeeError } = await loadEmployeeSummary(userId);
  if (!employee) notFound();

  const filters = {
    search: query.q?.trim() || undefined,
    kind: asKind(query.kind),
    status: asStatus(query.status),
    archive: asArchive(query.archive),
    cleanup: asCleanup(query.cleanup),
    sort: asSort(query.sort),
    from: query.from || undefined,
    to: query.to || undefined,
    page: Math.max(1, Number(query.page) || 1),
  };

  const { media, total, page, pageSize, sessionsByDevice, error } = await loadEmployeeMedia(
    userId,
    filters,
  );
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const name = employeeDisplayName(employee);
  const used = formatBytes(employee.storage_used_bytes) ?? "0 B";
  const quota = formatBytes(employee.storage_quota_bytes);
  const percent =
    employee.storage_quota_bytes != null
      ? usagePercent(employee.storage_used_bytes, employee.storage_quota_bytes)
      : null;

  const current = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) current.set(key, value);
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="hidden text-sm font-medium text-primary-600 sm:block">Office Media Manager</p>
          <h1 className="mt-0.5 hidden text-3xl font-bold tracking-tight text-gray-900 sm:mt-1 sm:block">
            Media / {name}
          </h1>
          <nav className="mt-0 hidden text-sm text-gray-500 sm:mt-3 sm:block" aria-label="Breadcrumb">
            <ol className="flex flex-wrap items-center gap-2">
              <li>
                <Link href="/admin" className="hover:text-gray-700">
                  Dashboard
                </Link>
              </li>
              <li aria-hidden>/</li>
              <li>
                <Link href="/admin/media" className="hover:text-gray-700">
                  Employees
                </Link>
              </li>
              <li aria-hidden>/</li>
              <li className="font-medium text-gray-900">{name}</li>
            </ol>
          </nav>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/admin/media"
            className="inline-flex items-center text-sm font-medium text-primary-700 hover:text-primary-600 sm:hidden"
          >
            ← Employees
          </Link>
          <span className="sm:hidden"><RefreshButton label="Refresh" iconOnly /></span>
          <span className="hidden sm:inline-flex"><RefreshButton label="Refresh" /></span>
        </div>
      </header>

      <Link
        href="/admin/media"
        className="hidden items-center text-sm font-medium text-primary-700 hover:text-primary-600 sm:inline-flex"
      >
        ← Back to Employees
      </Link>

      <section className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm sm:rounded-xl sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between sm:gap-5">
          <div className="flex items-start gap-4">
            <EmployeeAvatar
              initials={employeeInitials(employee.full_name, employee.email)}
              size="md"
            />
            <div>
              <h2 className="text-lg font-semibold text-gray-900 sm:text-xl">{name}</h2>
              <p className="text-xs text-gray-500 sm:text-sm">
                Designation: {employee.designation || "Not assigned"}
              </p>
              {employee.status !== "active" && (
                <div className="mt-2">
                  <StatusBadge label={employee.status} tone="warning" />
                </div>
              )}
            </div>
          </div>
          <dl className="grid grid-cols-4 gap-3 text-xs sm:gap-x-8 sm:gap-y-3 sm:text-sm">
            <div>
              <dt className="text-gray-500">Media</dt>
              <dd className="mt-0.5 font-semibold text-gray-900 sm:mt-1">{employee.media_count.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Storage</dt>
              <dd className="mt-0.5 font-semibold text-gray-900 sm:mt-1">
                {quota ? `${used} / ${quota}` : used}
              </dd>
              {percent !== null && (
                <p className="mt-1 hidden text-xs text-gray-500 sm:block">{percent}% used</p>
              )}
            </div>
            <div>
              <dt className="text-gray-500">Photos</dt>
              <dd className="mt-0.5 font-semibold text-gray-900 sm:mt-1">{employee.photo_count.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Videos</dt>
              <dd className="mt-0.5 font-semibold text-gray-900 sm:mt-1">{employee.video_count.toLocaleString()}</dd>
            </div>
          </dl>
        </div>
        {quota && percent !== null && (
          <div className="mt-4 hidden sm:block sm:mt-5">
            <div className="h-2 overflow-hidden rounded-full bg-gray-100">
              <div
                className={`h-full rounded-full ${percent >= 90 ? "bg-red-500" : percent >= 70 ? "bg-yellow-500" : "bg-primary-500"}`}
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        )}
      </section>

      {employeeError && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {employeeError}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <p className="hidden text-sm text-gray-500 sm:block">
        {total.toLocaleString()} media · {used}
      </p>

      <Suspense fallback={<div className="h-40 animate-pulse rounded-xl bg-gray-200" />}>
        <MediaBrowser
          userId={userId}
          employeeName={name}
          employeeId={employee.employee_id}
          designation={employee.designation}
          media={media}
          sessionsByDevice={sessionsByDevice}
        />
      </Suspense>

      {total > pageSize && (
        <Pager page={page} pageCount={pageCount} hrefFor={(next) => hrefFor(userId, current, next)} />
      )}
    </div>
  );
}
