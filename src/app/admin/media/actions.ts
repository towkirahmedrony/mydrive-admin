"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { issueMediaAccess } from "@/lib/media-access";
import {
  isUuid,
  loadEmployeeMedia,
  ownedMediaIds,
  requireAdminActor,
} from "@/lib/media-data";
import type { MediaAccessGrant, MediaListFilters } from "@/lib/media-types";

export async function retryEmployeeMediaJobs(
  userId: string,
  mediaIds: string[],
): Promise<{ success: boolean; retried: number; error?: string }> {
  if (!isUuid(userId)) {
    return { success: false, retried: 0, error: "Invalid employee." };
  }

  const supabase = await createClient();
  const actor = await requireAdminActor(supabase);
  if (!actor.ok) {
    return { success: false, retried: 0, error: actor.error };
  }

  const { data: employee } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  if (!employee) {
    return { success: false, retried: 0, error: "Employee not found." };
  }

  const owned = await ownedMediaIds(userId, mediaIds);
  if (owned.length === 0) {
    return { success: false, retried: 0, error: "No media belonging to this employee was selected." };
  }

  const { data, error } = await supabase.functions.invoke<{
    success?: boolean;
    retried?: number;
    error?: string;
  }>("admin-media", {
    body: { action: "retry", media_ids: owned, user_id: userId },
  });

  if (error || data?.success === false) {
    return {
      success: false,
      retried: 0,
      error: data?.error || error?.message || "Retry was not available.",
    };
  }

  revalidatePath(`/admin/media/${userId}`);
  return { success: true, retried: data?.retried ?? 0 };
}

/**
 * Mints a fresh short-lived grant for one employee's media set.
 *
 * Called by the viewer when a media element reports a load failure, so a grant
 * that expired while the viewer stayed open is renewed without a page reload,
 * and immediately on demand rather than pre-emptively for every asset.
 */
export async function refreshMediaAccess(
  userId: string,
): Promise<{ success: boolean; grant?: MediaAccessGrant; error?: string }> {
  if (!isUuid(userId)) return { success: false, error: "Invalid employee." };

  const supabase = await createClient();
  const actor = await requireAdminActor(supabase);
  if (!actor.ok) return { success: false, error: actor.error };

  const { data: employee, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  if (error) return { success: false, error: "Employee could not be read." };
  if (!employee) return { success: false, error: "Employee not found." };

  return { success: true, grant: issueMediaAccess(userId) };
}

/**
 * Fetches an additional page of media for infinite scroll.
 *
 * The browser calls this as the user scrolls toward the end of the gallery.
 * Only metadata is returned — thumbnails are loaded by the browser through
 * the signed asset route, so this action never touches provider URLs.
 */
export async function loadMoreMedia(
  userId: string,
  page: number,
  filters: {
    kind?: string;
    status?: string;
    archive?: string;
    cleanup?: string;
    sort?: string;
    q?: string;
    from?: string;
    to?: string;
  },
): Promise<{
  media: Awaited<ReturnType<typeof loadEmployeeMedia>>["media"];
  total: number;
  page: number;
  pageSize: number;
  error: string | null;
}> {
  if (!isUuid(userId)) {
    return { media: [], total: 0, page, pageSize: 0, error: "Invalid employee." };
  }

  const inputFilters: MediaListFilters = {
    kind: (filters.kind as MediaListFilters["kind"]) ?? undefined,
    status: (filters.status as MediaListFilters["status"]) ?? undefined,
    archive: (filters.archive as MediaListFilters["archive"]) ?? undefined,
    cleanup: (filters.cleanup as MediaListFilters["cleanup"]) ?? undefined,
    sort: (filters.sort as MediaListFilters["sort"]) ?? undefined,
    search: filters.q || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
    page,
  };

  return loadEmployeeMedia(userId, inputFilters);
}
