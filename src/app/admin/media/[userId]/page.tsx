import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import RefreshButton from "@/components/RefreshButton";
import { formatBytes } from "@/lib/format";
import { issueMediaAccess } from "@/lib/media-access";
import {
  employeeDisplayName,
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

  const name = employeeDisplayName(employee);
  const used = formatBytes(employee.storage_used_bytes) ?? "0 B";
  const access = issueMediaAccess(userId);

  return (
    <div className="flex h-full flex-col">
      {/* ── Compact header ─────────────────────────────────────── */}
      <header className="flex shrink-0 items-center gap-2 border-b border-gray-100 bg-white px-3 py-2 sm:px-4">
        <Link
          href="/admin/media"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700"
          aria-label="Back to employees"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-gray-900">{name}</h1>
          <p className="truncate text-xs text-gray-500">
            {total.toLocaleString()} items · {used}
            {employee.photo_count > 0 && ` · ${employee.photo_count} photos`}
            {employee.video_count > 0 && ` · ${employee.video_count} videos`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <RefreshButton label="Refresh" iconOnly />
        </div>
      </header>

      {/* ── Error banners ──────────────────────────────────────── */}
      {employeeError && (
        <div role="alert" className="mx-3 mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          {employeeError}
        </div>
      )}
      {error && (
        <div role="alert" className="mx-3 mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </div>
      )}

      {/* ── Gallery ────────────────────────────────────────────── */}
      <Suspense
        fallback={
          <div className="flex-1 p-2">
            <div className="gallery-grid">
              {Array.from({ length: 30 }).map((_, index) => (
                <div key={index} className="animate-pulse bg-gray-200" style={{ aspectRatio: "1" }} />
              ))}
            </div>
          </div>
        }
      >
        <MediaBrowser
          userId={userId}
          employeeName={name}
          employeeId={employee.employee_id}
          designation={employee.designation}
          media={media}
          sessionsByDevice={sessionsByDevice}
          access={access}
          total={total}
          initialPage={page}
          pageSize={pageSize}
        />
      </Suspense>
    </div>
  );
}
