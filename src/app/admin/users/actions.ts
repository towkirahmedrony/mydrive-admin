"use server";

/**
 * Server actions for the Users / Employee Maintain pages.
 *
 * Authorization
 * -------------
 * Every action re-checks the caller with `requireAdminActor` (session +
 * `profiles.role = 'admin'`) and then writes through the request-scoped client,
 * so the database's own RLS policies remain the final authority. Hiding a
 * button in the browser is never the boundary.
 *
 * Writes are deliberately minimal. Only one mutation is exposed, and only
 * because the schema and the deployed authorization design support it:
 *
 *   `profiles.status` (active | suspended)
 *     `MYDRIVE_SCHEMA.md` documents the column and its check constraint, and
 *     `guard_profile_privileged_columns` exists precisely to stop non-admins
 *     changing `role`/`status` — i.e. an administrative path for these columns
 *     is part of the deployed design.
 *
 * No action is provided for `devices`: nothing in the repository or the schema
 * documents an administrative write path for that table (its columns are
 * backend-owned), so device management is presented read-only rather than
 * faked. Profile editing (name / employee id / designation) is likewise left to
 * the backend's owner-scoped update path. See the handover notes for the full
 * list of what was intentionally not built.
 */
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAdminActor } from "@/lib/media-data";
import { isUuid } from "@/lib/media-types";
import {
  DIRECTORY_WINDOW,
  type DirectoryFilters,
} from "@/lib/user-types";
import {
  invalidateUserData,
  loadUserDirectory,
  normalizeDirectoryFilters,
  type DirectoryLoadResult,
} from "@/lib/user-data";

/** Account states `profiles.status` actually allows (check constraint). */
export type AccountStatus = "active" | "suspended";

export type AccountStatusInput = {
  userId: string;
  status: AccountStatus;
};

export type AccountStatusResult = {
  success: boolean;
  /** Operator-safe message; raw database text is never returned. */
  error?: string;
  /** The state the row holds after the call, on success. */
  status?: AccountStatus;
  /** False when the audit entry could not be written (the change still stands). */
  auditLogged?: boolean;
};

/**
 * Directory read for search, filtering, sorting and "show more".
 *
 * Called by the browser instead of navigating: a filter change must not reload
 * the route, and an identical view is served from the server-side snapshot
 * cache without touching the database at all.
 */
export async function fetchUserDirectory(input: {
  filters: Partial<DirectoryFilters> & { search?: string | null };
  limit?: number;
  /** Read the database again instead of replaying the cached snapshot. */
  force?: boolean;
}): Promise<DirectoryLoadResult> {
  const filters = normalizeDirectoryFilters(input.filters ?? {});
  const limitInput = Number(input.limit);
  const limit = Number.isFinite(limitInput) && limitInput > 0
    ? Math.floor(limitInput)
    : DIRECTORY_WINDOW;

  return loadUserDirectory(filters, limit, input.force === true);
}

export async function setAccountStatus(
  input: AccountStatusInput,
): Promise<AccountStatusResult> {
  const userId = typeof input?.userId === "string" ? input.userId.trim() : "";
  if (!isUuid(userId)) return { success: false, error: "Invalid employee." };

  const status = input?.status;
  if (status !== "active" && status !== "suspended") {
    return { success: false, error: "Unsupported account status." };
  }

  const supabase = await createClient();
  const actor = await requireAdminActor(supabase);
  if (!actor.ok) return { success: false, error: "Not authorized." };

  // Suspending the signed-in admin's own account would revoke the session used
  // to make the change. Refused here as well as in the UI.
  if (actor.id === userId) {
    return { success: false, error: "You cannot change your own account status." };
  }

  const { data: current, error: readError } = await supabase
    .from("profiles")
    .select("id,status")
    .eq("id", userId)
    .maybeSingle();

  if (readError) {
    console.error(`[users] status preflight read failed: ${readError.message}`);
    return { success: false, error: "The employee could not be read. Try again." };
  }
  if (!current) return { success: false, error: "Employee not found." };

  const previous = (current as { status?: string }).status ?? null;
  if (previous === status) {
    return { success: true, status, auditLogged: true };
  }

  // `.select()` makes the write return the persisted row: an update blocked by
  // RLS affects zero rows instead of throwing, so "no row came back" is treated
  // as "not permitted" rather than reported as success.
  const { data: updated, error: updateError } = await supabase
    .from("profiles")
    .update({ status })
    .eq("id", userId)
    .select("id,status")
    .maybeSingle();

  if (updateError) {
    console.error(`[users] status update failed: ${updateError.message}`);
    const denied =
      updateError.code === "42501" ||
      /row-level security|permission denied/i.test(updateError.message);
    return {
      success: false,
      error: denied
        ? "This admin session is not allowed to change account status."
        : "The account status could not be updated. Try again.",
    };
  }

  if (!updated) {
    return {
      success: false,
      error: "The backend did not apply the change. The account status is unchanged.",
    };
  }

  // Append-only audit trail. A failed audit write does not roll back a change
  // the database already accepted, but it is reported so it cannot pass as
  // silently logged.
  const { error: auditError } = await supabase.from("admin_audit_logs").insert({
    actor_id: actor.id,
    action: "user.account_status.update",
    target_user_id: userId,
    details: { from: previous, to: status },
    success: true,
  });
  const auditLogged = !auditError;
  if (auditError) {
    console.error(`[users] audit write failed: ${auditError.message}`);
  }

  invalidateUserData();
  revalidatePath("/admin/users");
  revalidatePath(`/admin/users/${userId}`);

  return {
    success: true,
    status: (updated as { status?: AccountStatus }).status ?? status,
    auditLogged,
  };
}
