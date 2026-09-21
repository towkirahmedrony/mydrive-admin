"use server";

/**
 * Server actions for the Admin Settings pages.
 *
 * Authorization
 * -------------
 * Every action re-checks the caller with `requireAdminActor` (session +
 * `profiles.role = 'admin'`). The database's own RLS policies remain the
 * final authority — no frontend-only gating is relied upon.
 *
 * Schema discipline
 * -----------------
 * Only columns documented in MYDRIVE_SCHEMA.md are written. No invented
 * fields, tables, or RPCs are used.
 */
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAdminActor } from "@/lib/media-data";

// ── Account status ────────────────────────────────────────────────────────

export type AccountStatus = "active" | "suspended";

export type AccountStatusResult = {
  success: boolean;
  error?: string;
  status?: AccountStatus;
};

/**
 * Admin can change their own `profiles.status` via the Security settings.
 * The `guard_profile_privileged_columns` trigger blocks non-admin writes
 * to `role`/`status`, so an admin-level write path is part of the deployed
 * design.
 */
export async function updateAccountStatus(
  status: AccountStatus,
): Promise<AccountStatusResult> {
  if (status !== "active" && status !== "suspended") {
    return { success: false, error: "Unsupported account status." };
  }

  const supabase = await createClient();
  const actor = await requireAdminActor(supabase);
  if (!actor.ok) {
    return { success: false, error: "Not authorized." };
  }

  const { data: current, error: readError } = await supabase
    .from("profiles")
    .select("id,status")
    .eq("id", actor.id)
    .maybeSingle();

  if (readError) {
    return { success: false, error: "Could not read profile." };
  }
  if (!current) {
    return { success: false, error: "Profile not found." };
  }

  const previous = (current as { status?: string }).status;
  if (previous === status) {
    return { success: true, status };
  }

  // Suspending your own account would revoke the session making this request.
  if (status === "suspended") {
    return {
      success: false,
      error: "You cannot suspend your own account from here.",
    };
  }

  const { data: updated, error: updateError } = await supabase
    .from("profiles")
    .update({ status })
    .eq("id", actor.id)
    .select("id,status")
    .maybeSingle();

  if (updateError) {
    const denied =
      updateError.code === "42501" ||
      /row-level security|permission denied/i.test(updateError.message);
    return {
      success: false,
      error: denied
        ? "This session is not allowed to change account status."
        : "The account status could not be updated.",
    };
  }

  if (!updated) {
    return {
      success: false,
      error: "The backend did not apply the change.",
    };
  }

  // Audit trail
  await supabase.from("admin_audit_logs").insert({
    actor_id: actor.id,
    action: "settings.account_status.update",
    details: { from: previous, to: status },
    success: true,
  });

  revalidatePath("/admin/settings");
  revalidatePath("/admin/settings/security");

  return {
    success: true,
    status: (updated as { status?: AccountStatus }).status ?? status,
  };
}

// ── App settings toggle ───────────────────────────────────────────────────

export type AppSettingsUpdateResult = {
  success: boolean;
  error?: string;
};

/**
 * Toggle a boolean `app_settings` field.
 *
 * The `app_settings` table is a single-row global config (id = true).
 * Only boolean fields documented in MYDRIVE_SCHEMA.md are supported.
 */
export async function updateAppSetting(
  field:
    | "compression_enabled"
    | "telegram_enabled"
    | "drive_enabled"
    | "auto_delete_primary_after_replication"
    | "auto_delete_telegram_on_media_delete"
    | "auto_delete_drive_on_media_delete",
  value: boolean,
): Promise<AppSettingsUpdateResult> {
  const supabase = await createClient();
  const actor = await requireAdminActor(supabase);
  if (!actor.ok) {
    return { success: false, error: "Not authorized." };
  }

  const { error } = await supabase
    .from("app_settings")
    .update({ [field]: value })
    .eq("id", true);

  if (error) {
    return { success: false, error: "Could not update setting." };
  }

  // Audit trail
  await supabase.from("admin_audit_logs").insert({
    actor_id: actor.id,
    action: `settings.app.${field}`,
    details: { value },
    success: true,
  });

  revalidatePath("/admin/settings");
  revalidatePath("/admin/settings/backup");
  revalidatePath("/admin/settings/storage");

  return { success: true };
}
