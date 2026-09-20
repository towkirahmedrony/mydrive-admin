import Link from "next/link";

export default function Pager({
  page,
  pageCount,
  hrefFor,
}: {
  page: number;
  pageCount: number;
  hrefFor: (page: number) => string;
}) {
  const safeCount = Math.max(1, pageCount);
  const safePage = Math.min(Math.max(1, page), safeCount);

  return (
    <footer className="flex items-center justify-between">
      <p className="text-sm text-gray-500">
        Page {safePage} of {safeCount}
      </p>
      <div className="flex gap-2">
        {safePage <= 1 ? (
          <span className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-400">
            Previous
          </span>
        ) : (
          <Link
            href={hrefFor(safePage - 1)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Previous
          </Link>
        )}
        {safePage >= safeCount ? (
          <span className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-400">
            Next
          </span>
        ) : (
          <Link
            href={hrefFor(safePage + 1)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Next
          </Link>
        )}
      </div>
    </footer>
  );
}
