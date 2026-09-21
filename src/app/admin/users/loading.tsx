/**
 * Route-level loading state: the toolbar's shape plus skeleton rows, so the page
 * never shows a full-page spinner while the directory is being read.
 */
export default function UsersLoading() {
  return (
    <div className="space-y-3" aria-busy="true">
      <header className="space-y-2">
        <div className="h-3 w-20 animate-pulse rounded bg-gray-200" />
        <div className="h-6 w-28 animate-pulse rounded bg-gray-200" />
        <div className="h-3 w-40 animate-pulse rounded bg-gray-100" />
      </header>

      <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
        <div className="h-9 w-full animate-pulse rounded-lg bg-gray-100" />
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="divide-y divide-gray-100">
          {Array.from({ length: 10 }).map((_, index) => (
            <div key={index} className="flex items-center gap-2.5 px-3 py-2">
              <div className="h-8 w-8 shrink-0 animate-pulse rounded-xl bg-gray-200" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="h-3 w-32 animate-pulse rounded bg-gray-200" />
                <div className="h-2.5 w-24 animate-pulse rounded bg-gray-100" />
              </div>
              <div className="shrink-0 space-y-1.5">
                <div className="h-2.5 w-14 animate-pulse rounded bg-gray-200" />
                <div className="h-2.5 w-16 animate-pulse rounded bg-gray-100" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
