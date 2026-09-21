/** Skeleton for the employee record: the same card grid, without a spinner. */
export default function UserDetailLoading() {
  return (
    <div className="space-y-3 sm:space-y-4" aria-busy="true">
      <div className="space-y-2">
        <div className="h-3 w-48 animate-pulse rounded bg-gray-200" />
        <div className="h-6 w-40 animate-pulse rounded bg-gray-200" />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="h-40 animate-pulse rounded-xl border border-gray-200 bg-white lg:col-span-2" />
        <div className="h-40 animate-pulse rounded-xl border border-gray-200 bg-white" />
        <div className="h-44 animate-pulse rounded-xl border border-gray-200 bg-white lg:col-span-3" />
        <div className="h-40 animate-pulse rounded-xl border border-gray-200 bg-white lg:col-span-2" />
        <div className="h-40 animate-pulse rounded-xl border border-gray-200 bg-white" />
      </div>
    </div>
  );
}
