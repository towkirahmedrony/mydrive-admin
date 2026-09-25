/**
 * oauth-callback-policy — pure decision logic for `google-oauth-callback`.
 *
 * Why this module exists
 * ----------------------
 * The callback's authorization decisions are security-critical and must be
 * provable without a live Google account. Keeping them as pure functions with
 * no Deno, network or database dependencies means:
 *
 *   - the Edge Function is the only production caller, and
 *   - the same code is exercised by `node --test` in `tests/`.
 *
 * Security invariant enforced here:
 *
 *     Possession of an OAuth `state` value must NEVER, by itself, authorize
 *     binding a Google account. The HTTP caller must be authenticated and must
 *     be the same user the state was issued to.
 *
 * Design notes
 * ------------
 *  - A caller/state mismatch returns the SAME message and status as an unknown
 *    state, so the endpoint never discloses that a given state exists but
 *    belongs to somebody else.
 *  - The state is still consumed atomically by the caller (a single filtered
 *    DELETE); this module only decides what to do with the outcome, so
 *    single-use behaviour and the 10-minute expiry are untouched.
 *  - Reconnect handling mirrors the reviewed repository implementation: it
 *    restores connection/health state on a successful re-authorization even
 *    when Google omits a new refresh token, and it clears stale `error` state
 *    as well as `reauth_required`.
 */

/** Returned for an unknown, forged, replayed — or mismatched — state. */
export const INVALID_STATE_MESSAGE =
  "Invalid OAuth state. Please start the connection again.";

/** Returned when the state existed but its 10-minute window has passed. */
export const EXPIRED_STATE_MESSAGE =
  "OAuth session expired. Please start the connection again.";

/** Returned when the caller presents no verifiable Supabase session. */
export const CALLER_AUTH_REQUIRED_MESSAGE =
  "Authentication is required to complete the Drive connection.";

/** Returned when the state owner is not an administrator. */
export const ADMIN_REQUIRED_MESSAGE =
  "Administrator privileges are required to connect a Drive account.";

/**
 * Returned when no refresh token is available and none is stored, so the
 * account could never be used. The wording points the admin at the fix.
 */
export const REFRESH_TOKEN_REQUIRED_MESSAGE =
  "Google did not return a refresh token and no stored credential exists for this account. " +
  "Remove this app's access at https://myaccount.google.com/permissions and connect again.";

/** The outcome of the caller's atomic single-use state consumption. */
export type StateConsumption =
  | { kind: "consumed"; userId: string | null }
  | { kind: "expired" }
  | { kind: "invalid" };

/** A refusal to continue the callback. */
export interface CallbackRejection {
  /** HTTP status to return. */
  status: number;
  /** Body `error` value. Must not disclose state ownership. */
  error: string;
  /** Structured reason for logs. Never returned to the client. */
  reason: string;
}

/**
 * Decide whether the callback may proceed past state validation.
 *
 * Returns `null` when the request is authorized, otherwise the rejection.
 *
 * The order of checks is deliberate: an unauthenticated caller is rejected
 * before a mismatch is considered, and a mismatch is reported identically to
 * an unknown state.
 */
export function decideStateAuthorization(input: {
  callerUserId: string | null;
  consumption: StateConsumption;
}): CallbackRejection | null {
  const { callerUserId, consumption } = input;

  if (consumption.kind === "expired") {
    return { status: 400, error: EXPIRED_STATE_MESSAGE, reason: "state_expired" };
  }

  if (consumption.kind === "invalid") {
    return { status: 400, error: INVALID_STATE_MESSAGE, reason: "state_invalid" };
  }

  const ownerId = typeof consumption.userId === "string"
    ? consumption.userId.trim()
    : "";

  // An unauthenticated caller can never complete a binding.
  if (!callerUserId) {
    return {
      status: 401,
      error: CALLER_AUTH_REQUIRED_MESSAGE,
      reason: "caller_unauthenticated",
    };
  }

  // A state whose owner is unknown or malformed is treated as invalid rather
  // than as a successful match against an empty id.
  if (!ownerId) {
    return {
      status: 400,
      error: INVALID_STATE_MESSAGE,
      reason: "state_owner_missing",
    };
  }

  // The core binding: the HTTP caller must be the user the state was minted
  // for. Reported exactly like an unknown state (see module docs).
  if (callerUserId !== ownerId) {
    return {
      status: 400,
      error: INVALID_STATE_MESSAGE,
      reason: "state_caller_mismatch",
    };
  }

  return null;
}

/**
 * Decide whether the (already authorized) actor may bind a Drive account.
 * Preserved from the existing implementation: the state owner's role is
 * re-read server-side because it may have changed since the state was minted.
 */
export function decideAdminAuthorization(
  role: string | null | undefined,
): CallbackRejection | null {
  if (role === "admin") return null;
  return {
    status: 403,
    error: ADMIN_REQUIRED_MESSAGE,
    reason: "caller_not_admin",
  };
}

/** Account columns that re-authorization must never overwrite. */
export const REAUTH_PROTECTED_FIELDS = [
  "id",
  "google_email",
  "priority",
  "reserved_bytes",
  "enabled",
  "root_folder_id",
  "notes",
  "name",
  "display_name",
  "created_at",
  "refresh_token_secret_id",
] as const;

/** The subset of account state the reconnect decision needs. */
export interface ReconnectAccountState {
  status: string | null;
  enabled: boolean | null;
  health_status: string | null;
}

/**
 * Build the reconnect patch for an existing account row.
 *
 * This is the reviewed repository behaviour, unchanged:
 *
 *  - credential-derived state (`connection_status`, `last_error*`,
 *    `last_health_check_at`) is restored from the Drive API call that just
 *    succeeded, so a valid existing credential is never left looking broken
 *    merely because Google omitted a new refresh token (D5-a);
 *  - stale `error` state is cleared alongside `reauth_required` (D5-b);
 *  - a disabled account stays disabled — re-authorization restores credentials,
 *    never routing eligibility;
 *  - `priority`, `reserved_bytes`, `root_folder_id`, `enabled`, `id` and the
 *    timestamps that represent account history are never included.
 *
 * The returned patch is guaranteed not to contain any protected field.
 */
export function planReconnectPatch(
  account: ReconnectAccountState,
  nowIso: string,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    updated_at: nowIso,
    connection_status: "connected",
    last_error: null,
    last_error_at: null,
    last_health_check_at: nowIso,
  };

  const disabled = account.enabled === false || account.status === "disabled";

  // Restore an authentication-recovery status, but never override an
  // admin-controlled `disabled`, and never resurrect a quota_full account.
  if (!disabled && (account.status === "reauth_required" || account.status === "error")) {
    patch.status = "active";
  }

  if (
    account.health_status === "unhealthy" ||
    account.health_status === "unknown" ||
    account.health_status === "degraded"
  ) {
    patch.health_status = "healthy";
  }

  return patch;
}

/** True when the patch contains no field that re-auth must never touch. */
export function patchTouchesProtectedField(
  patch: Record<string, unknown>,
): boolean {
  return REAUTH_PROTECTED_FIELDS.some((field) =>
    Object.prototype.hasOwnProperty.call(patch, field)
  );
}

/** Returned when Google reports a different stable identity for a known email. */
export const PERMISSION_ID_CONFLICT_MESSAGE =
  "This Google account does not match the account previously connected for that email address. " +
  "A different Google account now owns the address. Remove the existing Drive connection before connecting again.";

/**
 * The stable Google identity returned by `about.user.permissionId`.
 *
 * Per Google's Drive reference, `permissionId` is the `permissions.id` of the
 * `user` grantee — "a unique identifier for the grantee" — and IDs "should be
 * treated as opaque values". It is therefore handled as an opaque trimmed
 * string, never parsed.
 */
export type PermissionIdDecision =
  /** Google omitted the field. Keep whatever is stored; never clear it. */
  | { action: "skip" }
  /** Stamp a value onto a row that has none (new account, or a backfill). */
  | { action: "set"; value: string }
  /** Already matches. Nothing to write. */
  | { action: "unchanged" }
  /** Same email, different Google account. Refuse; never rebind silently. */
  | { action: "conflict"; existing: string; incoming: string };

function normalizePermissionId(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Decide how a stable Google identity relates to the stored one.
 *
 * The email remains the matching key, so this function exists purely to catch
 * the case the email CANNOT: the same address now belonging to a different
 * Google account. In that situation the stored credential belongs to the old
 * account and re-pointing the row at the new one would silently transfer a
 * media archive to a different party, so the callback refuses instead.
 *
 * A missing incoming value is never treated as a conflict — Google may
 * legitimately omit `permissionId`, and that must not break account creation.
 */
export function decideGooglePermissionId(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): PermissionIdDecision {
  const next = normalizePermissionId(incoming);
  const current = normalizePermissionId(existing);

  // "It is only possible to set the identity when a value is supplied."
  if (!next) return { action: "skip" };

  // Stamp on first sight — this is how an existing un-stamped row acquires its
  // identity, from a legitimate OAuth event rather than a fabricated backfill.
  if (!current) return { action: "set", value: next };

  if (current === next) return { action: "unchanged" };

  return { action: "conflict", existing: current, incoming: next };
}

/** True when the decision requires writing to `drive_accounts`. */
export function permissionIdNeedsWrite(decision: PermissionIdDecision): boolean {
  return decision.action === "set";
}

/**
 * Build the narrow identity patch.
 *
 * Deliberately separate from `planReconnectPatch`: identity is not lifecycle
 * state, and stamping an identity must NOT be able to influence health,
 * connection, status or routing. It writes exactly one column.
 */
export function planIdentityPatch(permissionId: string): {
  google_permission_id: string;
} {
  return { google_permission_id: normalizePermissionId(permissionId) };
}

/**
 * Decide what to do with the refresh token Google returned.
 *
 * Google omits `refresh_token` whenever the account has already authorized the
 * app. That is a SUCCESSFUL re-authorization for an account that keeps its
 * stored credential — it must not be rejected, and the existing Vault secret
 * must not be clobbered.
 *
 *  - token present                -> store it
 *  - token absent, secret exists  -> keep the stored credential (D5-a)
 *  - token absent, no secret      -> reject; the account would be unusable
 */
export function decideRefreshTokenHandling(
  newRefreshToken: string | null,
  hasExistingSecret: boolean,
): { store: boolean; reject: boolean } {
  const token = typeof newRefreshToken === "string" ? newRefreshToken.trim() : "";

  if (token.length > 0) return { store: true, reject: false };
  if (hasExistingSecret) return { store: false, reject: false };
  return { store: false, reject: true };
}

/**
 * True when the caller may be trusted to have reached this endpoint through the
 * browser OAuth redirect. Used only for logging/diagnostics — authorization is
 * decided by `decideStateAuthorization`.
 */
export function isPlausibleCallbackRequest(method: string): boolean {
  return method === "POST";
}
