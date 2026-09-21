# Users / Employee Maintain — implementation report

Branch base: `main` @ `dd1f10e` (pulled before any code was written).
Scope: the Users/Employee Maintain experience and the data fetching that
supports it. Nothing else in the panel, the backend, or the Android app was
touched.

Schema of record: `MYDRIVE_SCHEMA.md` (the file is named `MYDRIVE_SCHEMA.md` in
the repository). Every field rendered below is listed there.

---

## 1. Files changed

### Added

| File | Purpose |
|---|---|
| `src/lib/user-types.ts` | Pure schema-mapped types, the selected-column lists, search/filter/sort/window logic. No I/O. |
| `src/lib/user-display.ts` | Labels and tones for account status, device status, backup status, sync state, storage pressure, device policies. |
| `src/lib/user-data.ts` | Server data layer: `loadUserDirectory`, `loadUserDetail`, `normalizeDirectoryFilters`, `invalidateUserData`, bounded snapshot/detail caches. |
| `src/components/StorageBar.tsx` | Shared compact usage bar (`storage_used_bytes` / `storage_quota_bytes`). |
| `src/app/admin/users/actions.ts` | Server actions: `fetchUserDirectory`, `setAccountStatus` (the only write). |
| `src/app/admin/users/users-directory.tsx` | Client directory: toolbar, debounced search, filters, progressive list, SWR behaviour, empty/error states. |
| `src/app/admin/users/user-filters.tsx` | Filter controls, rendered inline on desktop and as the mobile bottom sheet. |
| `src/app/admin/users/user-rows.tsx` | Mobile two-line row, desktop table row, table head/colgroup, skeleton rows. |
| `src/app/admin/users/user-cache.ts` | Browser-side, memory-only, admin-scoped view snapshot (stale-while-revalidate). |
| `src/app/admin/users/loading.tsx` | Route skeleton (toolbar + rows). |
| `src/app/admin/users/[userId]/page.tsx` | Employee record: profile, storage, devices, backup/sync, device policies. |
| `src/app/admin/users/[userId]/user-actions.tsx` | View Media link, suspend/reactivate with confirmation dialog, result/error notices. |
| `src/app/admin/users/[userId]/loading.tsx` | Detail skeleton. |
| `src/app/admin/users/[userId]/not-found.tsx` | Unknown/unreadable employee state. |
| `tests/user-directory.test.ts` | 18 tests over the pure directory logic and the column projections. |
| `tests/user-render.test.tsx` | 6 tests rendering the real row/table components to markup. |
| `tests/register.mjs`, `tests/ts-path-loader.mjs` | Test-runner hooks (`@/` alias + `.ts`/`.tsx` transpile) so the tests can execute under `node --test`. |

### Modified

| File | Change |
|---|---|
| `src/app/admin/users/page.tsx` | Replaced the "Coming Soon" placeholder with the real directory route. |

Nothing else changed: no media page, no Drive/Telegram code, no migrations, no
`next.config.js`, no `package.json`, no auth/middleware changes.

---

## 2. Actual schema fields used

`profiles`
`id`, `full_name`, `email`, `employee_id`, `designation`, `role`, `status`,
`last_seen_at`, `created_at`, `storage_quota_bytes`, `storage_used_bytes`
(`updated_at` and `department_id` exist but are deliberately unused).

`devices`
`id`, `user_id`, `device_uid`, `device_name`, `brand`, `model`,
`android_version`, `status`, `last_seen_at`, `created_at`, `wifi_only_sync`,
`auto_delete_after_backup`.
**`push_token` and `push_token_updated_at` are never selected** — see §5.

`backup_sessions`
`id`, `device_id`, `started_at`, `completed_at`, `status`, `files_count`,
`files_uploaded`, `files_failed`, `total_size_bytes`, `error_message`
(read for a 90-day window, newest first).

`media_assets`
`owner_id`, `status`, `deleted_at` — used only to `COUNT` an employee's live
media for the detail page ("Media: N items"). No media rows, storage locators or
provider URLs are read.

`admin_audit_logs`
`actor_id`, `action`, `target_user_id`, `details`, `success` — one append-only
entry per account-status change.

Derived, not stored: device counts, last activity (`max(profiles.last_seen_at,
devices.last_seen_at)`), sync state (`backup_sessions.status`), storage
percentage (`storage_used_bytes / storage_quota_bytes`).

### Requested by the brief but **not** in the schema (so not implemented)

- **"Disabled" as an account status** — `profiles.status` only allows
  `active | suspended`. `active | disabled` is `devices.status`. The account
  filter therefore offers Active/Suspended, and device state is a separate
  filter ("Has disabled device").
- **Department** — `profiles.department_id` / `departments` exist but are out of
  scope by instruction: no column, filter, grouping or reporting.
- **Device-level edits** — `devices` has no administrative write path documented
  anywhere in the repository or the schema (its rows are backend-owned), so
  device management is read-only. Policies (`wifi_only_sync`,
  `auto_delete_after_backup`) are displayed, not edited.
- **Profile editing (name / employee ID / designation)** — `employee_id` has a
  partial unique index and only the owner-scoped update policy is documented
  (`"Users can update own profile"`), so no admin edit form was invented.
- **`device_storage_usage` view** — available in the schema, but
  `profiles.storage_used_bytes` is trigger-maintained and already gives the
  per-employee figure the page needs, so the view is not queried.

---

## 3. Caching / data-fetching strategy

The project has no client data library (no React Query/SWR, no `unstable_cache`).
Its established pattern is: request-scoped Supabase client in Server Components,
`revalidatePath` after writes, small in-process TTL caches inside `lib/`, and
`router.refresh()` for re-render. This page uses exactly that, in two layers.

**Layer 1 — server snapshot cache (`src/lib/user-data.ts`).**
One database read per `(admin id, search term)`, cached in-process for 20 s,
bounded to 64 entries, holding only the non-sensitive projection above.
Filters, sorting, "show more" and repeat navigation are then computed in memory
from that snapshot, so they cost **zero** database round trips. `setAccountStatus`
calls `invalidateUserData()` before `revalidatePath(...)`, so a write can never
be masked by the cache. Mirrors the existing `roleCache` / `sourceCache`
approach rather than adding a second caching story.

**Layer 2 — browser view snapshot (`src/app/admin/users/user-cache.ts`).**
Memory only (no `localStorage`/`sessionStorage`/IndexedDB), keyed by the
signed-in admin's id, holding the same non-sensitive projection. On a view change
(search, filter, sort, show-more) the previously answered view is painted
immediately and revalidated in the background; the revealed window is restored
when returning to a view. Nothing is read during SSR (guarded), so it cannot
affect server HTML or hydration.

**Query shape — no N+1.** A directory load is a fixed number of round trips
regardless of roster size: one `profiles` page (≤1000 rows, `count: exact`), one
chunked `devices` read per 100 profiles, one chunked `backup_sessions` read per
100 devices inside the 90-day window. The previous Employees list ran one
`COUNT` per profile; this does not.

**Search.** Debounced at 300 ms, sanitised (no `% _ , ( )`), executed as one
ANDed `or=(...)` group per token across `full_name`, `email`, `employee_id`,
`designation`, then mirrored in memory so the rendered count and rows always
agree. Identical terms are answered from the snapshot cache without a query.
The URL is updated with `history.replaceState` (shareable and back-button
correct) rather than a router push, so typing never triggers a route render.

**Window.** 25 rows initially, +25 per "Show more", hard-capped at 200 with an
explicit "Showing the first 200 of N matches" message — the cap is stated, never
silent.

**Loading UX.** No full-page spinner anywhere: `loading.tsx` skeletons for route
transitions, cached/previous rows kept on screen during a refetch with a small
inline "Updating…" indicator, and one failed request degrades to an inline notice
instead of blanking the page.

---

## 4. Mobile UX decisions

- **`< xl` uses rows, `>= xl` uses a table** — not one table scaled down. At
  tablet widths a 7-column table cannot fit beside the 256 px sidebar, so the row
  layout is used there too and only switches to a table when the width exists.
- **Row height ≈ 52 px** (2 lines, `py-2`, 32 px avatar): a phone shows 12+
  employees without scrolling. Line 1 = avatar, name, optional Admin chip,
  optional backup-attention dot; line 2 = `EMP-001 · Developer` and, right
  aligned, `2 dev · 2.4 GB`.
- **Labels kept where they disambiguate** (account status as dot + word, storage
  as a value); only genuinely secondary state (backup attention, admin role) is
  carried by a small glyph with a title, and the glyph is absent for healthy
  rows so a normal roster renders with no extra ink.
- **Filters live in a bottom sheet** below `lg` (`Filters` button with an active
  count badge), so no permanent filter panel consumes the viewport; they apply
  live and the sheet closes on "Show results" or Escape. Desktop (`lg+`) gets a
  dense inline filter row instead.
- **Sticky compact toolbar** (`top-16`, just under the panel's top bar) with the
  search field always reachable; no horizontal scrolling anywhere; no oversized
  headers, cards or buttons (all controls are `h-9`, typography `text-[11px]`–
  `text-sm` in the list, `text-xl` page title).

---

## 5. Security / authorization implementation

- **Route gate (existing, unchanged):** `src/middleware.ts` already requires a
  session and `profiles.role = 'admin'` for every `/admin` path — verified for
  the new routes in §6.
- **Server-side re-check:** the directory loader, the detail loader and both
  server actions call the existing `requireAdminActor` (`@/lib/media-data`), which
  re-verifies the session and the admin role. Reused, not reimplemented — no
  client-side-only check is the boundary.
- **Data-layer authority:** every read/write goes through the request-scoped anon
  client, so the deployed RLS policies (`private.is_admin()`) remain the final
  authority. No service-role key is used or referenced anywhere in this feature.
- **IDOR / not-found:** `[userId]` is UUID-validated; an unknown id, a malformed
  id and a non-admin caller all render the same `not-found` state, so ids cannot
  be probed. Devices are only ever read with `user_id = <the requested employee>`.
- **Never exposed:** `devices.push_token`, `push_token_updated_at`,
  `drive_accounts.refresh_token_secret_id`, `telegram_configs.bot_token_secret_id`,
  OAuth/refresh tokens. The token columns are absent from the selected columns and
  from the row types, so they cannot be selected, cached, serialised or rendered
  by accident. Service-role/refresh/bot-token identifiers do not appear anywhere
  in the build output, including the client bundles.
- **Writes:** exactly one mutation (`profiles.status`, values `active|suspended`).
  It validates the UUID and the target state, refuses to change the signed-in
  admin's own account, reads the current value first, uses `.select()` after the
  update so a silently-blocked (0-row) update is reported as *not applied* rather
  than success, maps RLS/permission failures to a human message, writes an
  `admin_audit_logs` entry (reporting if that entry could not be recorded), then
  invalidates the cache and revalidates both routes. No other action exists — no
  device or profile mutation was invented.
- **No raw database errors to admins:** loaders log the PostgREST message
  server-side (`console.error`) and return a fixed, human-readable message.
- **Logging:** no credential, token or key value is read or logged. Exact
  commands/queries are not logged either.

---

## 6. Tests / build results

Environment: Node v22.23.2, Next.js 15.1.11, React 19. Commands run from the
repository root (the `node_modules/.bin` shims are absent in this checkout, so
the binaries were invoked directly — equivalent to `npm run ...`).

| Check | Result |
|---|---|
| `node node_modules/typescript/bin/tsc --noEmit` | **clean** (0 errors) |
| `node node_modules/next/dist/bin/next lint` | **✔ No ESLint warnings or errors** |
| `node node_modules/next/dist/bin/next build` | **✓ compiled successfully**, `/admin/users` 7.75 kB (117 kB first load), `/admin/users/[userId]` 2.26 kB (111 kB) |
| `tests/user-directory.test.ts` | **18/18 pass** |
| `tests/user-render.test.tsx` | **6/6 pass** |
| Pre-existing `tests/media-access.test.ts` + `tests/media-source.test.ts` | 22/24 pass; the 2 failures are pre-existing and unrelated (`require is not defined` inside an ESM test file). They were **not** modified. |

Test commands (the loader hooks in `tests/` make the TypeScript sources runnable
under `node --test`; nothing in `src/` imports them):

```bash
node --experimental-strip-types --import ./tests/register.mjs --test tests/user-directory.test.ts
node --import ./tests/register.mjs --test tests/user-render.test.tsx
```

### Runtime verification performed

A local PostgREST/GoTrue-shaped mock (kept outside the repository) plus a forged
admin session cookie was used to render the real pages over HTTP, with the mock
recording every query the app emitted:

- `/admin/users` (signed in) → **200**, listing rows with name,
  `EMP-001 · Developer`, Active/Suspended, `2 dev · 2.4 GB`, "Showing 4 of 4
  employees".
- Emitted queries: `profiles` select contains only the documented columns (no
  `department_id`, no push token), requests `count: exact`, and produces one
  ANDed `or=(full_name.ilike.%t%,email.ilike.%t%,employee_id.ilike.%t%,designation.ilike.%t%)`
  group per search token; `devices` select contains **no** `push_token`;
  `backup_sessions` is filtered with `started_at=gte.<now-90d>` and `limit=2000`;
  the sync policy read is a `HEAD media_assets?...&owner_id=eq.<uuid>` count.
- Filters, driven through the URL: `?q=developer`, `?status=suspended`,
  `?storage=used_high`, `?devices=with_disabled`, `?sync=failed` each returned
  exactly the expected single employee; `?q=zzz-nothing` returned the
  "No employees found" empty state with a clear-search action.
- `/admin/users/<uuid>` → **200** with Profile / Storage (2.4 GB of 10.0 GB,
  7.6 GB remaining, 24 %) / Devices (2, one disabled, Android version, last seen,
  policies) / Backup & sync (completed run, 120/120 files, 2.4 GB, per-device
  latest) / Device policies.
- `/admin/users/<unknown-uuid>` and `/admin/users/not-a-uuid` → the not-found
  state; a request with no session → **307** to `/auth/login?returnTo=...`.
- `setAccountStatus` invoked through the real server-action endpoint:
  it issued `PATCH /rest/v1/profiles?id=eq.<uuid>` with body `{"status":"active"}`
  and then `POST /rest/v1/admin_audit_logs` with
  `{actor_id, action:"user.account_status.update", target_user_id, details:{from:"suspended",to:"active"}, success:true}`.
- Refusals verified: self-status change, malformed UUID, unsupported status and
  unauthenticated call were all rejected and issued **zero** writes.
- Static scan of the build output: `push_token` appears nowhere in
  `.next/static` or `.next/server`; no service-role / refresh-token /
  bot-token identifier appears in any client bundle.

---

## 7. Not verified / limitations

1. **Production database and policies.** There is no access to the production
   Supabase project, so the deployed RLS policies were not exercised. In
   particular, `setAccountStatus` assumes the deployed policies grant an admin an
   `UPDATE` on `profiles` (the `guard_profile_privileged_columns` trigger
   explicitly implements an admin path for `role`/`status`, which is the evidence
   for it). If a deployment denies the update, the action returns
   "This admin session is not allowed to change account status." and leaves the
   account unchanged — it never reports a change that did not persist.
   Likewise the `admin_audit_logs` insert is best-effort: if it is denied, the
   status change still stands and the dialog reports that the audit entry could
   not be recorded.
2. **`backup_sessions` lookback.** "Latest backup" is read from a bounded 90-day
   window (`BACKUP_LOOKBACK_DAYS`) rather than an unbounded history scan, so a
   purely historical session shows as "No recent backup". This is a deliberate
   trade-off and is stated in the UI.
3. **Visual/browser verification.** No browser or logged-in session is available
   in this environment, so layouts were verified by rendering the real components
   to markup (rows, table, header, skeleton) plus markup-level checks of the
   responsive class structure, not by pixel inspection in a device viewport.
   Breakpoint behaviour (`< xl` rows / `>= xl` table, mobile bottom sheet) is
   reasoned from the markup and Tailwind breakpoints and should get one pass in a
   real browser before release.
4. **Route-state caching nuance.** Because the admin layout is `force-dynamic`,
   navigating back to `/admin/users` still performs the route's server render
   (which the snapshot cache answers without a database round trip); the
   framework-level client router cache was deliberately left untouched, since
   `experimental.staleTimes` in `next.config.js` is an app-wide behaviour change
   for every admin page. In-page interactions (search, filters, sort, show more)
   never reload the route.
5. **Serverless cache locality.** The in-process caches behave per server
   instance, exactly like the existing `roleCache`/`sourceCache`. On a
   multi-instance deployment each instance keeps its own snapshot; correctness is
   unaffected (writes invalidate explicitly and the TTL is 20 s).
