export default function EmployeeMediaLoading() {
  return (
    <div className="flex h-full flex-col" aria-busy="true">
      {/* Compact header skeleton */}
      <div className="flex shrink-0 items-center gap-2 border-b border-gray-100 bg-white px-3 py-2 sm:px-4">
        <div className="h-8 w-8 animate-pulse rounded-lg bg-gray-200" />
        <div className="min-w-0 flex-1">
          <div className="h-4 w-32 animate-pulse rounded bg-gray-200" />
          <div className="mt-1 h-3 w-48 animate-pulse rounded bg-gray-200" />
        </div>
      </div>

      {/* Toolbar skeleton */}
      <div className="flex shrink-0 items-center gap-2 border-b border-gray-100 bg-white px-3 py-2 sm:px-4">
        <div className="h-7 flex-1 animate-pulse rounded bg-gray-200" />
        <div className="h-7 w-16 animate-pulse rounded bg-gray-200" />
      </div>

      {/* Gallery skeleton */}
      <div className="min-h-0 flex-1 overflow-y-auto p-0.5">
        <div className="date-group-header">
          <div className="h-3 w-28 animate-pulse rounded bg-gray-200" />
        </div>
        <div className="gallery-grid">
          {Array.from({ length: 30 }).map((_, index) => (
            <div
              key={index}
              className="animate-pulse bg-gray-200"
              style={{ aspectRatio: "1" }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
