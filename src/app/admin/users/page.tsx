import Link from "next/link";
import { DIRECTORY_WINDOW, parseDirectoryFilters } from "@/lib/user-types";
import { loadUserDirectory } from "@/lib/user-data";
import UserDirectory from "./users-directory";

/**
 * Users / Employee Maintain — the directory.
 *
 * The route renders the first paint from the database (through the request-
 * scoped admin session, so RLS decides what is visible) and hands the result to
 * the client directory, which owns every interaction after that. Deep links with
 * `?q=&status=&devices=&sync=&storage=&sort=` are honoured here, which is why
 * the filter set is parsed on the server as well as in the browser.
 */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function UsersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const filters = parseDirectoryFilters(params);
  const initial = await loadUserDirectory(filters, DIRECTORY_WINDOW);

  return (
    <div className="space-y-3 sm:space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="text-xs font-medium text-primary-600 sm:text-sm">
            Employee Maintain
          </p>
          <h1 className="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
            Users
          </h1>
          <nav aria-label="Breadcrumb" className="mt-0.5 text-xs sm:text-sm">
            <ol className="flex items-center gap-2 text-gray-500">
              <li>
                <Link href="/admin" className="hover:text-gray-700">
                  Dashboard
                </Link>
              </li>
              <li aria-hidden>/</li>
              <li className="font-medium text-gray-900">Users</li>
            </ol>
          </nav>
        </div>
        <p className="hidden max-w-md text-xs text-gray-500 sm:block">
          Employee accounts with their devices, storage and backup state. Open an
          employee for the full record.
        </p>
      </header>

      <UserDirectory initial={initial} initialFilters={filters} />
    </div>
  );
}
