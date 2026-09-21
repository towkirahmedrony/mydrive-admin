"use client";

/**
 * Browser-side snapshot cache for the Users directory (stale-while-revalidate).
 *
 * What it is for
 * --------------
 * `Open Users → cached list appears immediately → background refresh`.
 * The route still renders its first paint from the server (which answers out of
 * the server-side snapshot cache in `@/lib/user-data`, so it costs no database
 * round trip). This browser cache covers the interactions *after* that:
 *
 *   - changing search / filters / sort paints the previous answer immediately
 *     and revalidates in the background, so the list never blanks out;
 *   - returning to a view that was already visited paints from the snapshot
 *     instead of waiting for a round trip;
 *   - the revealed window ("show more") is restored, so an admin comes back to
 *     the list exactly as they left it.
 *
 * Safety properties
 * -----------------
 * - Memory only. Nothing is written to localStorage/sessionStorage/IndexedDB,
 *   so no employee data survives the tab and no partially-cleared state can leak
 *   into another session.
 * - Keyed by the signed-in admin's id, so two admins sharing a browser cannot
 *   read each other's entries — and `clearUserCache()` is called on sign-out.
 * - Only the same non-sensitive projection the server would render anyway is
 *   stored: no tokens, no storage URLs, no credentials (the row shapes in
 *   `@/lib/user-types` cannot express them).
 * - Read only inside client components, and only after the browser has mounted
 *   (`typeof window` guard at the call site) so it can never affect the
 *   server-rendered HTML or cause a hydration mismatch.
 */
import type { DirectoryUser } from "@/lib/user-types";
import { directoryViewKey, type DirectoryFilters } from "@/lib/user-types";

/** Data as the browser keeps it — the answer to one view. */
export type UserDirectoryData = {
  users: DirectoryUser[];
  /** Rows matching the view before the window was applied. */
  matched: number;
  capped: boolean;
  scanned: number;
  scanCapped: boolean;
  /** Roster size for the search term, before view filters. */
  total: number;
  generatedAt: string;
};

type CachedView = {
  data: UserDirectoryData;
  /** Window size the admin had revealed, so "show more" survives navigation. */
  limit: number;
  at: number;
};

/**
 * Projection of a server answer down to what the browser keeps.
 *
 * Structurally typed on purpose: the client never imports the server module's
 * result type, so no server-only import can be pulled into the browser bundle
 * through a type reference.
 */
export function toDirectoryData(result: {
  users: DirectoryUser[];
  matched: number;
  capped: boolean;
  scanned: number;
  scanCapped: boolean;
  total: number;
  generatedAt: string;
}): UserDirectoryData {
  return {
    users: result.users,
    matched: result.matched,
    capped: result.capped,
    scanned: result.scanned,
    scanCapped: result.scanCapped,
    total: result.total,
    generatedAt: result.generatedAt,
  };
}

/** Entry lifetime: how long a snapshot may be *rendered* before it is ignored. */
const VIEW_TTL_MS = 5 * 60 * 1000;

/** Age at which a snapshot is revalidated in the background on mount. */
export const FRESH_MS = 30 * 1000;

const MAX_ENTRIES = 24;

const views = new Map<string, CachedView>();

/** Cache identity of one view: the admin, the filters, the sort — nothing else. */
export function viewKeyFor(
  viewerId: string,
  filters: DirectoryFilters,
): string {
  return `${viewerId}::${directoryViewKey(filters)}`;
}

export function readView(key: string): (CachedView & { stale: boolean }) | null {
  const entry = views.get(key);
  if (!entry) return null;
  const age = Date.now() - entry.at;
  if (age > VIEW_TTL_MS) {
    views.delete(key);
    return null;
  }
  return { ...entry, stale: age > FRESH_MS };
}

export function writeView(
  key: string,
  data: UserDirectoryData,
  limit: number,
): void {
  views.set(key, { data, limit, at: Date.now() });
  if (views.size > MAX_ENTRIES) {
    const oldest = views.keys().next().value;
    if (oldest !== undefined) views.delete(oldest);
  }
}

/** Drops every cached view. Called on sign-out so nothing outlives the session. */
export function clearUserCache(): void {
  views.clear();
}
