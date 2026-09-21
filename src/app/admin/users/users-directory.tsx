"use client";

/**
 * Employee directory: toolbar, search, filters and the list itself.
 *
 * Why the data work happens here instead of in the route
 * ------------------------------------------------------
 * Search, filtering, sorting and "show more" must not reload the route. Each of
 * them asks the server action for the view that is now wanted; the action
 * answers out of the server-side snapshot cache (`@/lib/user-data`), so an
 * interaction that only re-shapes data the server already holds costs no
 * database round trip, and one that was answered before is served from this
 * component's own memory snapshot while it revalidates in the background.
 *
 * URL handling
 * ------------
 * The view is still expressed in the URL (`?q=&status=&devices=&sync=&storage=&sort=`),
 * but it is written with `history.replaceState` rather than a router push: the
 * admin keeps a shareable/back-button-correct URL, and the browser does not pay
 * for a full route render on every keystroke. Deep links work because the route
 * parses the same parameters server-side for the first paint.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import EmptyState from "@/components/EmptyState";
import { sanitizeSearch } from "@/lib/media-types";
import {
  DEFAULT_DIRECTORY_FILTERS,
  DIRECTORY_VIEW_MAX,
  DIRECTORY_WINDOW,
  directoryHref,
  filtersActive,
  type DirectoryFilters,
} from "@/lib/user-types";
import { fetchUserDirectory } from "./actions";
import {
  readView,
  toDirectoryData,
  viewKeyFor,
  writeView,
  type UserDirectoryData,
} from "./user-cache";
import {
  DirectoryFilterControls,
  DirectoryFilterSheet,
} from "./user-filters";
import {
  DirectorySkeleton,
  UserListRow,
  UserTableColgroup,
  UserTableHead,
  UserTableRow,
} from "./user-rows";

/** Debounce for the search box: fast enough to feel instant, slow enough that
 *  typing does not issue a request per character. */
const SEARCH_DEBOUNCE_MS = 300;

type InitialDirectory = {
  users: UserDirectoryData["users"];
  matched: number;
  capped: boolean;
  scanned: number;
  scanCapped: boolean;
  total: number;
  generatedAt: string;
  viewerId: string | null;
  error: string | null;
};

const GENERIC_ERROR =
  "The employee directory could not be loaded. Please try again.";

function sameFilters(a: DirectoryFilters, b: DirectoryFilters): boolean {
  return (
    a.search === b.search &&
    a.status === b.status &&
    a.devices === b.devices &&
    a.sync === b.sync &&
    a.storage === b.storage &&
    a.sort === b.sort
  );
}

/** Restores the previously revealed window for this exact view, if any. */
function initialLimit(viewerId: string | null, filters: DirectoryFilters): number {
  if (!viewerId || typeof window === "undefined") return DIRECTORY_WINDOW;
  return readView(viewKeyFor(viewerId, filters))?.limit ?? DIRECTORY_WINDOW;
}

export default function UserDirectory({
  initial,
  initialFilters,
}: {
  initial: InitialDirectory;
  initialFilters: DirectoryFilters;
}) {
  const viewerId = initial.viewerId;

  const [filters, setFilters] = useState<DirectoryFilters>(initialFilters);
  const [limit, setLimit] = useState(() => initialLimit(viewerId, initialFilters));
  const [searchInput, setSearchInput] = useState(initialFilters.search);
  const [data, setData] = useState<UserDirectoryData | null>(() =>
    initial.viewerId ? toDirectoryData(initial) : null,
  );
  const [error, setError] = useState<string | null>(initial.error);
  const [busy, setBusy] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Mirrors of the live view for use inside async callbacks, so a debounced
  // search can never commit against a stale filter set.
  const viewRef = useRef({ filters, limit });
  const requestRef = useRef(0);
  const initialRef = useRef(initial);

  useEffect(() => {
    viewRef.current = { filters, limit };
  }, [filters, limit]);

  /**
   * Fetches one view. A previously answered view paints immediately from the
   * browser snapshot and is then revalidated, so the list never blanks out
   * while the request is in flight.
   */
  const run = useCallback(
    async (
      nextFilters: DirectoryFilters,
      nextLimit: number,
      options?: { force?: boolean },
    ) => {
      const requestId = requestRef.current + 1;
      requestRef.current = requestId;

      const key = viewerId ? viewKeyFor(viewerId, nextFilters) : null;
      const cached = options?.force || !key ? null : readView(key);
      if (cached) {
        // Paint what was already answered, trimmed to the window that is being
        // asked for now — the snapshot may hold more rows than this step wants.
        setData({ ...cached.data, users: cached.data.users.slice(0, nextLimit) });
        setError(null);
      }

      setBusy(true);
      try {
        const result = await fetchUserDirectory({
          filters: nextFilters,
          limit: nextLimit,
          force: options?.force === true,
        });
        if (requestId !== requestRef.current) return;

        if (result.error) {
          // Cached rows stay on screen; only the notice changes.
          setError(result.error);
          return;
        }

        const next = toDirectoryData(result);
        setData(next);
        setError(null);
        if (key) writeView(key, next, nextLimit);
      } catch {
        if (requestId === requestRef.current) setError(GENERIC_ERROR);
      } finally {
        if (requestId === requestRef.current) setBusy(false);
      }
    },
    [viewerId],
  );

  /** Applies a new view: local state, URL, then the data fetch. */
  const commit = useCallback(
    (next: { filters: DirectoryFilters; limit: number }, options?: { force?: boolean }) => {
      viewRef.current = next;
      setFilters(next.filters);
      setLimit(next.limit);
      if (typeof window !== "undefined") {
        window.history.replaceState(null, "", directoryHref(next.filters));
      }
      void run(next.filters, next.limit, options);
    },
    [run],
  );

  /**
   * A server re-render (for example the panel's RefreshButton, or the
   * revalidation a write triggers) delivers fresh props: adopt them and refresh
   * the browser snapshot so the next view change is instant.
   */
  useEffect(() => {
    if (initialRef.current === initial) return;
    initialRef.current = initial;

    if (initial.error) {
      setError(initial.error);
      return;
    }

    const next = toDirectoryData(initial);
    setData(next);
    setError(null);
    if (viewerId) {
      writeView(
        viewKeyFor(viewerId, viewRef.current.filters),
        next,
        viewRef.current.limit,
      );
    }
  }, [initial, viewerId]);

  /** Debounced search. The URL and the query are updated once typing pauses. */
  useEffect(() => {
    const term = sanitizeSearch(searchInput);
    if (term === viewRef.current.filters.search) return;

    const timer = window.setTimeout(() => {
      if (term === viewRef.current.filters.search) return;
      commit({
        filters: { ...viewRef.current.filters, search: term },
        limit: DIRECTORY_WINDOW,
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [searchInput, commit]);

  const updateFilters = useCallback(
    (patch: Partial<DirectoryFilters>) => {
      const next = { ...viewRef.current.filters, ...patch };
      if (sameFilters(next, viewRef.current.filters)) return;
      // A new filter set is a new question: start its window at the top.
      commit({ filters: next, limit: DIRECTORY_WINDOW });
    },
    [commit],
  );

  const resetFilters = useCallback(() => {
    commit({ filters: { ...DEFAULT_DIRECTORY_FILTERS, search: viewRef.current.filters.search }, limit: DIRECTORY_WINDOW });
  }, [commit]);

  const clearSearch = useCallback(() => {
    setSearchInput("");
    commit({
      filters: { ...viewRef.current.filters, search: "" },
      limit: DIRECTORY_WINDOW,
    });
  }, [commit]);

  const showMore = useCallback(() => {
    const nextLimit = Math.min(viewRef.current.limit + DIRECTORY_WINDOW, DIRECTORY_VIEW_MAX);
    if (nextLimit === viewRef.current.limit) return;
    commit({ filters: viewRef.current.filters, limit: nextLimit });
  }, [commit]);

  const refresh = useCallback(() => {
    void run(viewRef.current.filters, viewRef.current.limit, { force: true });
  }, [run]);

  const users = data?.users ?? [];
  const shown = users.length;
  const matched = data?.matched ?? 0;
  const activeFilterCount = filtersActive(filters);
  const hasQuery = filters.search !== "" || activeFilterCount > 0;
  const canShowMore =
    data !== null && data.capped && shown < DIRECTORY_VIEW_MAX && shown > 0;

  const countLabel = (() => {
    if (!data) return "Loading employees…";
    if (hasQuery) {
      return `Showing ${shown} of ${matched} match${matched === 1 ? "" : "es"}`;
    }
    const roster = data.total ?? matched;
    return `Showing ${shown} of ${roster} employee${roster === 1 ? "" : "s"}`;
  })();

  return (
    <div className="space-y-3">
      <section
        aria-label="Employee search and filters"
        className="sticky top-16 z-20 -mx-4 border-b border-gray-200 bg-gray-100/95 px-4 py-2 backdrop-blur lg:static lg:mx-0 lg:rounded-xl lg:border lg:border-gray-200 lg:bg-white lg:p-3 lg:shadow-sm"
      >
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1 lg:max-w-sm">
            <svg
              viewBox="0 0 24 24"
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="6.5" />
              <path strokeLinecap="round" d="m16 16 4 4" />
            </svg>
            <input
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search name, ID, email or designation"
              aria-label="Search employees"
              enterKeyHint="search"
              className="h-9 w-full rounded-lg border border-gray-300 bg-white pl-8 pr-3 text-sm text-gray-900 shadow-sm outline-none placeholder:text-gray-400 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
            />
          </div>

          <DirectoryFilterSheet
            filters={filters}
            onChange={updateFilters}
            onReset={resetFilters}
            open={sheetOpen}
            onOpenChange={setSheetOpen}
          />

          <button
            type="button"
            onClick={refresh}
            disabled={busy}
            aria-label="Refresh employee directory"
            title="Refresh employee directory"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-300 bg-white text-gray-600 shadow-sm transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg
              viewBox="0 0 24 24"
              className={`h-4 w-4 ${busy ? "animate-spin" : ""}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M20 11a8.1 8.1 0 0 0-14.9-3M4 5v4h4M4 13a8.1 8.1 0 0 0 14.9 3M20 19v-4h-4"
              />
            </svg>
          </button>
        </div>

        <div className="hidden lg:mt-3 lg:block">
          <DirectoryFilterControls
            filters={filters}
            onChange={updateFilters}
            variant="inline"
          />
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-2 lg:mt-3">
          <p className="min-w-0 truncate text-[11px] text-gray-500" aria-live="polite">
            {countLabel}
            {activeFilterCount > 0 && filters.search !== "" ? (
              <span className="text-gray-400"> · {activeFilterCount} filter(s)</span>
            ) : null}
            {data?.scanCapped ? (
              <span className="text-yellow-700"> · refine the search to see the rest</span>
            ) : null}
          </p>
          {busy && (
            <span className="shrink-0 text-[11px] text-gray-400">Updating…</span>
          )}
        </div>
      </section>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={refresh}
            className="shrink-0 rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
          >
            Retry
          </button>
        </div>
      )}

      {data !== null && data.users.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="divide-y divide-gray-100 xl:hidden">
            {users.map((user) => (
              <UserListRow key={user.id} user={user} />
            ))}
          </div>
          <div className="hidden xl:block">
            <table className="w-full table-fixed border-collapse">
              <UserTableColgroup />
              <UserTableHead />
              <tbody>
                {users.map((user) => (
                  <UserTableRow key={user.id} user={user} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* No rows yet and no failure: keep the list's shape instead of a spinner. */}
      {data === null && !error && (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <DirectorySkeleton rows={8} />
        </div>
      )}

      {data !== null && data.users.length === 0 && !busy && !error && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <EmptyState
            title={hasQuery ? "No employees found" : "No employees yet"}
            detail={
              hasQuery
                ? "No employee matches this search and filter combination."
                : "Employee accounts appear here once profiles exist."
            }
          />
          {hasQuery && (
            <div className="flex justify-center gap-2 px-4 pb-4">
              {filters.search !== "" && (
                <button
                  type="button"
                  onClick={clearSearch}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  Clear search
                </button>
              )}
              {activeFilterCount > 0 && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  Clear filters
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {(canShowMore || (data !== null && data.capped && shown >= DIRECTORY_VIEW_MAX)) && (
        <footer className="flex items-center justify-end gap-2">
          {shown >= DIRECTORY_VIEW_MAX ? (
            <p className="text-right text-[11px] text-gray-500">
              Showing the first {DIRECTORY_VIEW_MAX} of {matched} matches — narrow
              the search or add a filter.
            </p>
          ) : (
            <button
              type="button"
              onClick={showMore}
              disabled={busy}
              className="inline-flex h-9 items-center rounded-lg border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Show more
            </button>
          )}
        </footer>
      )}
    </div>
  );
}
