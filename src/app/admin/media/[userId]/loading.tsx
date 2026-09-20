export default function EmployeeMediaLoading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="h-10 w-64 animate-pulse rounded bg-gray-200" />
      <div className="h-32 animate-pulse rounded-xl bg-gray-200" />
      <div className="h-24 animate-pulse rounded-xl bg-gray-200" />
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="aspect-[4/3] animate-pulse bg-gray-200" />
            <div className="space-y-3 p-4">
              <div className="h-4 w-3/4 animate-pulse rounded bg-gray-200" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-gray-200" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
