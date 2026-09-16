# MyDrive — Database Schema Reference

Supabase project: **MyDrive** (`gpiuxcdjmrzcouhjapcs`, region `ap-southeast-1`, Postgres 17)
Schema: `public`
Purpose (inferred): Android media backup/replication system — devices upload media, which gets compressed/variant-processed and replicated to Telegram and/or one of several pooled Google Drive accounts via a job queue.

All tables have Row Level Security (RLS) **enabled**. Admin bypass is via a `private.is_admin()` function used across nearly every policy.

---

## profiles
User account/profile record, 1:1 with `auth.users`.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK, FK → `auth.users.id` |
| email | text | nullable, unique |
| full_name | text | nullable |
| role | text | default `'user'`, check: `admin` \| `user` |
| status | text | default `'active'`, check: `active` \| `suspended` |
| last_seen_at | timestamptz | nullable |
| created_at | timestamptz | default `now()` |
| updated_at | timestamptz | default `now()` |

**Referenced by:** `devices.user_id`, `telegram_configs.user_id`, `media_assets.owner_id`, `drive_folders.owner_id`, `notifications.user_id`

**RLS:**
- SELECT: `id = auth.uid() OR is_admin()`
- UPDATE: `id = auth.uid() OR is_admin()`
- ALL (admin): `is_admin()`

---

## devices
Registered Android devices per user.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK, default `gen_random_uuid()` |
| user_id | uuid | FK → `profiles.id` |
| device_uid | text | unique |
| device_name | text | nullable |
| brand | text | nullable |
| model | text | nullable |
| android_version | text | nullable |
| status | text | default `'active'`, check: `active` \| `disabled` |
| last_seen_at | timestamptz | nullable |
| created_at / updated_at | timestamptz | default `now()` |

**Referenced by:** `media_assets.device_id`

**RLS:**
- SELECT/UPDATE/DELETE: `user_id = auth.uid() OR is_admin()`
- INSERT: `with_check: user_id = auth.uid()`

---

## media_assets
Core file/photo/video records.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK, default `gen_random_uuid()` |
| owner_id | uuid | FK → `profiles.id` |
| device_id | uuid | FK → `devices.id` |
| local_media_id | bigint | nullable |
| file_name | text | |
| mime_type | text | |
| file_size | bigint | check `>= 0` |
| width / height | integer | nullable |
| duration_ms | bigint | nullable, check `>= 0` |
| storage_provider | text | check: `imagekit` \| `cloudinary` |
| storage_asset_id | text | |
| storage_path | text | nullable |
| storage_url | text | nullable |
| thumbnail_url | text | nullable |
| sha256_hash | text | nullable |
| client_upload_id | uuid | |
| is_favorite | boolean | default `false` |
| status | text | default `'UPLOADING'`, check: `UPLOADING` \| `READY` \| `FAILED` \| `DELETED` |
| created_at / updated_at | timestamptz | default `now()` |
| uploaded_at | timestamptz | nullable |
| deleted_at | timestamptz | nullable |

**Referenced by:** `media_variants.media_id`, `replication_jobs.media_id`, `sync_logs.media_id`

**RLS:**
- SELECT/UPDATE/DELETE: `owner_id = auth.uid() OR is_admin()`
- INSERT: `with_check: owner_id = auth.uid()`

---

## media_variants
Derived versions of a media asset (thumbnail, telegram-sized, preview).

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK, default `gen_random_uuid()` |
| media_id | uuid | FK → `media_assets.id` |
| variant_type | text | check: `thumbnail` \| `telegram` \| `preview` |
| file_name | text | nullable |
| mime_type | text | nullable |
| file_size | bigint | nullable, check `>= 0` |
| width / height | integer | nullable |
| duration_ms | bigint | nullable, check `>= 0` |
| storage_provider | text | nullable, check: `imagekit` \| `cloudinary` |
| storage_asset_id | text | nullable |
| storage_path | text | nullable |
| storage_url | text | nullable |
| created_at | timestamptz | default `now()` |

**Referenced by:** `replication_jobs.variant_id`

**RLS:**
- SELECT/INSERT: allowed if the parent `media_assets` row is owned by the user (or admin) — via `EXISTS` subquery
- ALL (admin): `is_admin()`

---

## drive_accounts
Pool of Google Drive accounts used as replication destinations.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK, default `gen_random_uuid()` |
| name | text | |
| google_email | text | unique |
| refresh_token_secret_id | uuid | (points to a secret store, not stored inline) |
| root_folder_id | text | nullable |
| priority | integer | default `100` |
| status | text | default `'active'`, check: `active` \| `quota_full` \| `reauth_required` \| `disabled` \| `error` |
| storage_limit_bytes | bigint | nullable |
| storage_used_bytes | bigint | nullable |
| storage_available_bytes | bigint | nullable |
| last_quota_check_at | timestamptz | nullable |
| created_at / updated_at | timestamptz | default `now()` |

**Referenced by:** `replication_jobs.drive_account_id`, `drive_folders.drive_account_id`

**RLS:**
- ALL: `is_admin()` only (no direct user access)

---

## drive_folders
Folder tree mirrored on each Drive account.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK, default `gen_random_uuid()` |
| drive_account_id | uuid | FK → `drive_accounts.id` |
| parent_folder_id | uuid | nullable, FK → `drive_folders.id` (self-referencing) |
| owner_id | uuid | nullable, FK → `profiles.id` |
| folder_name | text | |
| google_folder_id | text | |
| folder_type | text | default `'media'`, check: `root` \| `media` \| `user` \| `year` \| `month` \| `custom` |
| created_at | timestamptz | default `now()` |

**Referenced by:** `replication_jobs.drive_folder_id`

**RLS:**
- ALL: `is_admin()` only

---

## telegram_configs
Per-user Telegram bot destination config.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK, default `gen_random_uuid()` |
| user_id | uuid | unique, FK → `profiles.id` |
| chat_id | text | |
| bot_token_secret_id | uuid | nullable (secret store reference) |
| enabled | boolean | default `true` |
| status | text | default `'unverified'`, check: `unverified` \| `active` \| `invalid` \| `disabled` |
| last_tested_at | timestamptz | nullable |
| created_at / updated_at | timestamptz | default `now()` |

**Referenced by:** `replication_jobs.telegram_config_id`

**RLS:**
- SELECT/UPDATE/DELETE: `user_id = auth.uid() OR is_admin()`
- INSERT: `with_check: user_id = auth.uid()`

---

## replication_jobs
Queue of replication tasks (media → Telegram / Google Drive).

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK, default `gen_random_uuid()` |
| media_id | uuid | FK → `media_assets.id` |
| destination_type | text | check: `telegram` \| `google_drive` |
| telegram_config_id | uuid | nullable, FK → `telegram_configs.id` |
| drive_account_id | uuid | nullable, FK → `drive_accounts.id` |
| drive_folder_id | uuid | nullable, FK → `drive_folders.id` |
| variant_id | uuid | nullable, FK → `media_variants.id` |
| status | text | default `'PENDING'`, check: `PENDING` \| `PROCESSING` \| `COMPLETED` \| `FAILED` \| `RETRYING` \| `SKIPPED` |
| attempt_count | integer | default `0`, check `>= 0` |
| last_error | text | nullable |
| next_retry_at | timestamptz | nullable |
| telegram_message_id | bigint | nullable |
| telegram_file_id | text | nullable |
| google_drive_file_id | text | nullable |
| started_at / completed_at | timestamptz | nullable |
| created_at / updated_at | timestamptz | default `now()` |

**Referenced by:** `sync_logs.replication_job_id`

**RLS:**
- SELECT: allowed if parent `media_assets` row is owned by user (or admin) — via `EXISTS` subquery
- ALL (admin): `is_admin()`

---

## sync_logs
Event/audit log for replication activity.

| Column | Type | Notes |
|---|---|---|
| id | bigint | PK, identity (`ALWAYS`) |
| media_id | uuid | nullable, FK → `media_assets.id` |
| replication_job_id | uuid | nullable, FK → `replication_jobs.id` |
| event_type | text | |
| status | text | nullable |
| message | text | nullable |
| metadata | jsonb | nullable |
| created_at | timestamptz | default `now()` |

**RLS:**
- SELECT: allowed if parent `media_assets` row is owned by user (or admin) — via `EXISTS` subquery
- ALL (admin): `is_admin()`

---

## notifications
In-app notifications per user.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK, default `gen_random_uuid()` |
| user_id | uuid | FK → `profiles.id` |
| title | text | |
| body | text | nullable |
| notification_type | text | nullable |
| is_read | boolean | default `false` |
| created_at | timestamptz | default `now()` |
| read_at | timestamptz | nullable |

**RLS:**
- SELECT: `user_id = auth.uid() OR is_admin()`
- UPDATE: `user_id = auth.uid()`
- ALL (admin): `is_admin()`

---

## app_settings
Single-row global config table (PK is a boolean, effectively a singleton).

| Column | Type | Notes |
|---|---|---|
| id | boolean | PK, default `true` |
| compression_enabled | boolean | default `true` |
| telegram_enabled | boolean | default `true` |
| drive_enabled | boolean | default `true` |
| telegram_target_mb | integer | default `45`, check `> 0` |
| telegram_hard_limit_mb | integer | default `50`, check `> 0` |
| max_retry | integer | default `5`, check `>= 0` |
| retry_base_delay_seconds | integer | default `60`, check `> 0` |
| auto_delete_primary_after_replication | boolean | default `false` |
| auto_delete_telegram_on_media_delete | boolean | default `false` |
| auto_delete_drive_on_media_delete | boolean | default `false` |
| drive_safety_margin_bytes | bigint | default `1073741824` (1 GiB) |
| created_at / updated_at | timestamptz | default `now()` |

**RLS:**
- ALL: `is_admin()` only

---

## Entity relationship summary

```
auth.users ──1:1── profiles
profiles ──1:N── devices
profiles ──1:N── media_assets
devices  ──1:N── media_assets
media_assets ──1:N── media_variants
media_assets ──1:N── replication_jobs
media_assets ──1:N── sync_logs
profiles ──1:1── telegram_configs
telegram_configs ──1:N── replication_jobs
drive_accounts ──1:N── drive_folders
drive_accounts ──1:N── replication_jobs
drive_folders  ──1:N── drive_folders (self, parent/child)
drive_folders  ──1:N── replication_jobs
media_variants ──1:N── replication_jobs
replication_jobs ──1:N── sync_logs
profiles ──1:N── notifications
```

## RLS pattern summary

- Most user-owned tables (`profiles`, `devices`, `media_assets`, `telegram_configs`, `notifications`) follow: **owner can SELECT/UPDATE/DELETE/INSERT their own rows; admin can do anything** via `private.is_admin()`.
- Child tables without a direct owner column (`media_variants`, `replication_jobs`, `sync_logs`) check ownership through an `EXISTS` subquery back to `media_assets.owner_id`.
- Infrastructure/admin-only tables (`drive_accounts`, `drive_folders`, `app_settings`) have **no end-user access at all** — admin only.
