# MyDrive — Supabase Database Schema

**Project:** MyDrive
**Project ID:** `gpiuxcdjmrzcouhjapcs`
**Database:** PostgreSQL 17 (Supabase, ap-southeast-1)
**Schema:** `public`
All tables have Row Level Security (RLS) enabled.

---

## profiles
User accounts (extends `auth.users`).

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK, FK → auth.users.id |
| email | text | unique, nullable |
| full_name | text | nullable |
| role | text | default `'user'`, check: `admin`, `user` |
| status | text | default `'active'`, check: `active`, `suspended` |
| last_seen_at | timestamptz | nullable |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |

---

## devices
Android devices registered per user.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → profiles.id |
| device_uid | text | unique |
| device_name | text | nullable |
| brand | text | nullable |
| model | text | nullable |
| android_version | text | nullable |
| status | text | default `'active'`, check: `active`, `disabled` |
| last_seen_at | timestamptz | nullable |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |

---

## media_assets
Core table for uploaded media (photos/videos).

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK, default gen_random_uuid() |
| owner_id | uuid | FK → profiles.id |
| device_id | uuid | FK → devices.id |
| local_media_id | bigint | nullable |
| file_name | text | |
| mime_type | text | |
| file_size | bigint | check ≥ 0 |
| width | integer | nullable |
| height | integer | nullable |
| duration_ms | bigint | nullable, check ≥ 0 |
| storage_provider | text | check: `imagekit`, `cloudinary` |
| storage_asset_id | text | |
| storage_path | text | nullable |
| storage_url | text | nullable |
| thumbnail_url | text | nullable |
| sha256_hash | text | nullable |
| client_upload_id | uuid | |
| is_favorite | boolean | default false |
| status | text | default `'UPLOADING'`, check: `UPLOADING`, `READY`, `FAILED`, `DELETED` |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |
| uploaded_at | timestamptz | nullable |
| deleted_at | timestamptz | nullable |
| drive_archived_at | timestamptz | nullable |
| primary_cleanup_status | text | default `'none'`, check: `none`, `cleanup_pending`, `cleanup_processing`, `cleanup_success`, `cleanup_failed` |
| primary_cleanup_attempts | integer | default 0 |
| primary_cleanup_error | text | nullable |
| primary_cleanup_started_at | timestamptz | nullable |
| primary_cleanup_completed_at | timestamptz | nullable |
| primary_deleted_at | timestamptz | nullable |
| cleanup_telegram_override | boolean | default false |

---

## media_variants
Derived variants (thumbnail/telegram/preview) of a media asset.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK, default gen_random_uuid() |
| media_id | uuid | FK → media_assets.id |
| variant_type | text | check: `thumbnail`, `telegram`, `preview` |
| file_name | text | nullable |
| mime_type | text | nullable |
| file_size | bigint | nullable, check ≥ 0 |
| width | integer | nullable |
| height | integer | nullable |
| duration_ms | bigint | nullable, check ≥ 0 |
| storage_provider | text | nullable, check: `imagekit`, `cloudinary` |
| storage_asset_id | text | nullable |
| storage_path | text | nullable |
| storage_url | text | nullable |
| created_at | timestamptz | default now() |

---

## drive_accounts
Google Drive accounts used as replication destinations.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK, default gen_random_uuid() |
| name | text | |
| google_email | text | unique |
| refresh_token_secret_id | uuid | |
| root_folder_id | text | nullable |
| priority | integer | default 100 |
| status | text | default `'active'`, check: `active`, `quota_full`, `reauth_required`, `disabled`, `error` |
| storage_limit_bytes | bigint | nullable |
| storage_used_bytes | bigint | nullable |
| storage_available_bytes | bigint | nullable |
| last_quota_check_at | timestamptz | nullable |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |
| display_name | text | nullable |
| refresh_token_updated_at | timestamptz | nullable |
| token_expires_at | timestamptz | nullable |
| enabled | boolean | default true |
| connection_status | text | default `'unknown'`, check: `connected`, `disconnected`, `reauth_required`, `error`, `unknown` |
| health_status | text | default `'unknown'`, check: `healthy`, `degraded`, `unhealthy`, `unknown` |
| reserved_bytes | bigint | default 0, check ≥ 0 |
| last_health_check_at | timestamptz | nullable |
| last_error | text | nullable |
| last_error_at | timestamptz | nullable |
| notes | text | nullable |

---

## drive_folders
Folder tree mirrored on each Drive account.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK, default gen_random_uuid() |
| drive_account_id | uuid | FK → drive_accounts.id |
| parent_folder_id | uuid | nullable, FK → drive_folders.id (self) |
| owner_id | uuid | nullable, FK → profiles.id |
| folder_name | text | |
| google_folder_id | text | nullable |
| folder_type | text | default `'media'`, check: `root`, `media`, `user`, `year`, `month`, `custom` |
| created_at | timestamptz | default now() |
| folder_status | text | default `'active'`, check: `pending`, `active`, `error` |
| create_lease_until | timestamptz | nullable |
| create_attempts | integer | default 0, check ≥ 0 |
| last_error | text | nullable |
| updated_at | timestamptz | default now() |

---

## replication_jobs
Jobs that copy media to Telegram and/or Google Drive.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK, default gen_random_uuid() |
| media_id | uuid | FK → media_assets.id |
| destination_type | text | check: `telegram`, `google_drive` |
| telegram_config_id | uuid | nullable, FK → telegram_configs.id |
| drive_account_id | uuid | nullable, FK → drive_accounts.id |
| drive_folder_id | uuid | nullable, FK → drive_folders.id |
| variant_id | uuid | nullable, FK → media_variants.id |
| status | text | default `'PENDING'`, check: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `RETRYING`, `SKIPPED` |
| attempt_count | integer | default 0, check ≥ 0 |
| last_error | text | nullable |
| next_retry_at | timestamptz | nullable |
| telegram_message_id | bigint | nullable |
| telegram_file_id | text | nullable |
| google_drive_file_id | text | nullable |
| started_at | timestamptz | nullable |
| completed_at | timestamptz | nullable |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |
| failed_drive_account_ids | uuid[] | default `'{}'` |
| google_drive_upload_url | text | nullable |
| google_drive_upload_chunk | bigint | default 0, check ≥ 0 |
| google_drive_upload_attempts | integer | default 0, check ≥ 0 |

---

## telegram_configs
Per-user Telegram bot/chat configuration for replication.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | unique, FK → profiles.id |
| chat_id | text | |
| bot_token_secret_id | uuid | nullable |
| enabled | boolean | default true |
| status | text | default `'unverified'`, check: `unverified`, `active`, `invalid`, `disabled` |
| last_tested_at | timestamptz | nullable |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |

---

## app_settings
Single-row global configuration table.

| Column | Type | Constraints |
|---|---|---|
| id | boolean | PK, default true |
| compression_enabled | boolean | default true |
| telegram_enabled | boolean | default true |
| drive_enabled | boolean | default true |
| telegram_target_mb | integer | default 45, check > 0 |
| telegram_hard_limit_mb | integer | default 50, check > 0 |
| max_retry | integer | default 5, check ≥ 0 |
| retry_base_delay_seconds | integer | default 60, check > 0 |
| auto_delete_primary_after_replication | boolean | default false |
| auto_delete_telegram_on_media_delete | boolean | default false |
| auto_delete_drive_on_media_delete | boolean | default false |
| drive_safety_margin_bytes | bigint | default 1073741824, check ≥ 0 |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |

---

## sync_logs
Event log for replication activity.

| Column | Type | Constraints |
|---|---|---|
| id | bigint | PK, identity |
| media_id | uuid | nullable, FK → media_assets.id |
| replication_job_id | uuid | nullable, FK → replication_jobs.id |
| event_type | text | |
| status | text | nullable |
| message | text | nullable |
| metadata | jsonb | nullable |
| created_at | timestamptz | default now() |

---

## notifications
In-app user notifications.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → profiles.id |
| title | text | |
| body | text | nullable |
| notification_type | text | nullable |
| is_read | boolean | default false |
| created_at | timestamptz | default now() |
| read_at | timestamptz | nullable |

---

## oauth_states
Short-lived state tokens for Google OAuth flow.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → auth.users.id |
| state | text | unique |
| created_at | timestamptz | default now() |
| expires_at | timestamptz | default now() + 10 minutes |

---

## admin_audit_logs
Audit trail for admin actions.

| Column | Type | Constraints |
|---|---|---|
| id | bigint | PK, identity |
| actor_id | uuid | FK → profiles.id |
| action | text | |
| media_id | uuid | nullable, FK → media_assets.id |
| target_user_id | uuid | nullable, FK → profiles.id |
| details | jsonb | default `{}` |
| success | boolean | default true |
| created_at | timestamptz | default now() |

---

## Relationship overview

- `profiles` (users) → owns `devices`, `media_assets`, `drive_folders`, `notifications`, `telegram_configs`
- `devices` → source of `media_assets`
- `media_assets` → has many `media_variants`, `replication_jobs`, `sync_logs`
- `drive_accounts` → has many `drive_folders`; `drive_folders` is self-referencing (parent/child tree)
- `replication_jobs` → links a `media_asset`/`media_variant` to a destination (`telegram_configs` or `drive_accounts` + `drive_folders`)
- `sync_logs` and `admin_audit_logs` are append-only logs referencing the above
