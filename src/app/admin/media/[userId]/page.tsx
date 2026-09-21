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
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <p className="text-sm font-medium text-primary-600">Office Media Manager</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-gray-900">
            Media / {name}
          </h1>
          <nav className="mt-3 text-sm text-gray-500" aria-label="Breadcrumb">
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
        <RefreshButton label="Refresh" />
      </header>

      <Link
        href="/admin/media"
        className="inline-flex items-center text-sm font-medium text-primary-700 hover:text-primary-600"
      >
        ← Back to Employees
      </Link>

      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-4">
            <EmployeeAvatar
              initials={employeeInitials(employee.full_name, employee.email)}
              size="lg"
            />
            <div>
              <h2 className="text-xl font-semibold text-gray-900">{name}</h2>
              <p className="text-sm text-gray-500">
                Designation: {employee.designation || "Not assigned"}
              </p>
              {employee.status !== "active" && (
                <div className="mt-2">
                  <StatusBadge label={employee.status} tone="warning" />
                </div>
              )}
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-gray-500">Media</dt>
              <dd className="mt-1 font-semibold text-gray-900">{employee.media_count.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Storage</dt>
              <dd className="mt-1 font-semibold text-gray-900">
                {quota ? `${used} / ${quota}` : used}
              </dd>
              {percent !== null && (
                <p className="mt-1 text-xs text-gray-500">{percent}% used</p>
              )}
            </div>
            <div>
              <dt className="text-gray-500">Photos</dt>
              <dd className="mt-1 font-semibold text-gray-900">{employee.photo_count.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Videos</dt>
              <dd className="mt-1 font-semibold text-gray-900">{employee.video_count.toLocaleString()}</dd>
            </div>
          </dl>
        </div>
        {quota && percent !== null && (
          <div className="mt-5">
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

      <p className="text-sm text-gray-500">
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
