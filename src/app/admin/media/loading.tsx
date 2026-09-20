export default function MediaLoading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="h-10 w-48 animate-pulse rounded bg-gray-200" />
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="h-24 animate-pulse rounded-xl bg-gray-200" />
        ))}
      </div>
      <div className="h-14 animate-pulse rounded-xl bg-gray-200" />
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="h-44 animate-pulse rounded-xl border border-gray-200 bg-white" />
        ))}
      </div>
    </div>
  );
}
