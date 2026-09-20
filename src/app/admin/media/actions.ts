"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isUuid, ownedMediaIds } from "@/lib/media-data";

export async function retryEmployeeMediaJobs(
  userId: string,
  mediaIds: string[],
): Promise<{ success: boolean; retried: number; error?: string }> {
  if (!isUuid(userId)) {
    return { success: false, retried: 0, error: "Invalid employee." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, retried: 0, error: "Not authenticated." };
  }

  const { data: actor } = await supabase
    .from("profiles")
    .select("id,role")
    .eq("id", user.id)
    .maybeSingle();
  if (!actor || actor.role !== "admin") {
    return { success: false, retried: 0, error: "Not authorized." };
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
