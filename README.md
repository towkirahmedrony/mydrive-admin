My Drive Admin Panel

Secure web-based administration panel for the My Drive media backup platform.

The Admin Panel is a standalone web application used by authorized administrators to manage backend infrastructure, Google Drive connections, backup jobs, storage health, and operational monitoring.

This repository is intentionally separate from the My Drive Android application.

---

## Quick Start

### Prerequisites

- Node.js 18+ 
- npm or yarn
- Supabase project with the My Drive schema
- Google Cloud OAuth credentials

### Local Development

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env.local` file with your environment variables (see `ENV_VARIABLES.md`)
4. Run the development server:
   ```bash
   npm run dev
   ```
5. Open http://localhost:3000

### Environment Variables

See `ENV_VARIABLES.md` for the complete list of required environment variables.

**Frontend-safe (exposed to browser):**
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

**Server-only (never expose to browser):**
- `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

### Google OAuth Setup

1. Create OAuth 2.0 credentials in Google Cloud Console
2. Add authorized redirect URI:
   - Development: `https://your-project.supabase.co/functions/v1/google-oauth-callback`
   - Production: `https://your-project.supabase.co/functions/v1/google-oauth-callback`
3. Set Supabase Edge Function secrets:
   ```bash
   supabase secrets set GOOGLE_CLIENT_ID=your-client-id
   supabase secrets set GOOGLE_CLIENT_SECRET=your-client-secret
   ```
4. Deploy Edge Functions:
   ```bash
   supabase functions deploy google-oauth-initiate
   supabase functions deploy google-oauth-callback
   ```

### Database Migration

Apply the OAuth states migration:
```bash
supabase db push
# or
psql -f supabase/migrations/001_oauth_states_and_admin.sql
```

### Deployment

**Vercel:**
1. Connect your GitHub repository to Vercel
2. Configure environment variables in Vercel dashboard
3. Deploy automatically on push to main

**Other Platforms:**
- Ensure `npm run build` succeeds
- Set all environment variables
- Configure Node.js 18+ runtime

---

---

1. Project Overview

My Drive is an office/group-oriented Android media backup system.

The Android application automatically detects photos and videos from the device and uploads each media file once to the primary cloud media origin, currently Cloudinary.

After the primary upload is finalized, the backend independently replicates the media to configured backup destinations:

Android
   │
   │ One upload
   ▼
Cloudinary
   │
   ▼
Supabase
   │
   ├───────────────┐
   ▼               ▼
Telegram         Google Drive
Job              Job
   │               │
   ▼               ▼
User Telegram     Central Archive
Destination       Storage

The Admin Panel is responsible for controlling and monitoring the backend side of this system.

The Android application is not an administration client and must not contain administrative credentials or backend infrastructure controls.

---

2. Purpose of This Repository

This repository contains only the web-based Admin Panel.

It is responsible for:

- Administrator authentication
- Administrator-only access control
- Google Drive account management
- Google OAuth connection flow
- Drive account status and health
- Storage/quota monitoring
- Drive routing configuration
- Backup job monitoring
- Retry and failure monitoring
- User/media operational visibility
- Audit and operational controls
- Future infrastructure management

It is not responsible for:

- Android media detection
- Android gallery rendering
- Android uploads
- Direct Telegram uploads from Android
- Direct Google Drive uploads from Android
- Cloudinary upload implementation
- Mobile authentication UI
- Device MediaStore processing

Those responsibilities belong to the Android application and Supabase backend.

---

3. Core Architecture

The system follows a single-upload + server-side fan-out architecture.

Primary media flow

Phone
  │
  │ MediaStore
  ▼
Room Queue
  │
  ▼
WorkManager
  │
  │ Upload once
  ▼
Cloudinary
  │
  ▼
Supabase media_assets
  │
  ├── Telegram replication job
  │
  └── Google Drive replication job

The Admin Panel operates primarily on the Supabase control plane.

Admin Browser
      │
      ▼
My Drive Admin Panel
      │
      ▼
Supabase Auth / Database / Edge Functions
      │
      ├── Google OAuth
      ├── Drive Accounts
      ├── Drive Router
      ├── Replication Jobs
      ├── Health / Quota
      └── Audit Data

---

4. Technology Stack

The Admin Panel uses:

- TypeScript
- Next.js
- Next.js App Router
- React
- Tailwind CSS
- Supabase
  - Auth
  - PostgreSQL
  - Row Level Security
  - Edge Functions
- Google Drive API
- Google OAuth 2.0

The project should follow the versions and dependency conventions established in the repository.

Do not unnecessarily upgrade framework versions or replace libraries without a concrete reason.

---

5. Repository Separation

The project is intentionally split into separate repositories.

Android

My Drive Android App

Responsibilities:

- MediaStore
- Room
- WorkManager
- Cloudinary primary upload
- Gallery
- User authentication
- User Telegram configuration
- Sync status

Backend

Existing Supabase Project

Responsibilities:

- Authentication
- Database
- RLS
- Media metadata
- Upload finalization
- Replication jobs
- Telegram processing
- Google Drive processing
- OAuth/token handling
- Routing
- Retry/reconciliation
- Server-side secrets

Admin Panel

mydrive-admin

Responsibilities:

- Administrative control
- Infrastructure management
- Drive account management
- Monitoring
- Operational tools
- Admin-only dashboards

The Admin Panel must not duplicate backend business logic unnecessarily.

---

6. Security Model

Security is a core requirement.

The Admin Panel handles infrastructure-level operations, so sensitive credentials must remain server-side.

Never expose to the browser

The following must never be returned to client-side code:

- Google Client Secret
- Google refresh tokens
- Google access tokens when not strictly required
- Supabase service-role key
- Cloudinary API Secret
- Telegram bot tokens
- Central Drive credentials
- Encryption keys
- Internal backend secrets

Browser-accessible public environment variables must never contain secrets.

---

7. Google Drive Authentication

Google Drive is connected using OAuth 2.0.

The expected flow is:

Admin
  │
  │ Click "Connect Google Drive"
  ▼
Admin Panel
  │
  ▼
Secure OAuth initiation
  │
  ▼
Google
  │
  │ Authorization
  ▼
OAuth Callback
  │
  ▼
Supabase Edge Function / secure backend
  │
  │ Exchange authorization code
  ▼
Secure token storage
  │
  ▼
Drive account registered

Google Client ID and Google Client Secret are maintained server-side.

They must not be hardcoded into React components or exposed through "NEXT_PUBLIC_*" variables.

Refresh tokens must never be displayed in the UI.

---

8. Google Drive Accounts

The system must support an arbitrary number of Google Drive accounts.

There must be no architectural assumption such as:

Drive A
Drive B
Drive C

or:

Exactly 3 accounts
Exactly 4 accounts

Instead, administrators can connect as many authorized Drive accounts as the system supports.

Example:

Drive Account 1
Drive Account 2
Drive Account 3
Drive Account 4
Drive Account 5
...

Each account may have:

- provider
- Google account email
- account name
- enabled/disabled state
- health state
- quota information
- priority
- connection status
- last health check
- created_at
- updated_at

---

9. Google Drive Storage Pool

The Drive system is a logical storage pool.

It is not a single native pooled Google Drive.

Example:

Drive A
└── My Drive Archive
    └── User A
        ├── photo1.jpg
        └── video1.mp4

Drive B
└── My Drive Archive
    └── User A
        ├── photo2.jpg
        └── video2.mp4

The application should still treat these files as belonging to the same logical user/media collection.

If Drive A becomes full or unavailable, the backend may route future uploads to Drive B.

---

10. User Folder Mapping

Each application user has a logical archive location.

When a media file is routed to a specific Google Drive account:

1. Check whether that user's folder exists on the selected Drive.
2. If it exists, use the existing folder.
3. If it does not exist, create it.
4. Store the resulting Drive folder ID.
5. Upload the media into that folder.

Example:

Drive A
└── My Drive Archive
    └── Shakib

Later:

Drive B
└── My Drive Archive
    └── Shakib

The same logical user may therefore have folders on multiple physical Drive accounts.

This is expected behavior.

---

11. Drive Router

The backend contains a Drive Router responsible for determining where new media should be stored.

The Admin Panel provides configuration and visibility for this router.

Potential routing factors include:

- Drive enabled state
- health state
- available quota
- configured safety margin
- priority
- availability
- temporary failure state

The router must not be implemented as a static list.

Example:

Available accounts:

Drive A
  Healthy
  500 GB free
  Priority 1

Drive B
  Healthy
  1.2 TB free
  Priority 2

Drive C
  Unavailable
  0 GB usable
  Disabled

The exact routing algorithm belongs to the backend, not to the browser.

The Admin Panel should configure or display routing information rather than independently deciding where media files should be uploaded.

---

12. Replication Architecture

After Cloudinary finalization, replication jobs are created independently.

Example:

media_assets
      │
      ├── Telegram Job
      │
      └── Drive Job

The destinations are independent.

Therefore:

Cloudinary SUCCESS
      │
      ├── Telegram SUCCESS
      │
      └── Drive FAILED

is a valid state.

A Drive failure must not undo a successful Telegram replication.

Likewise:

Telegram FAILED
Drive SUCCESS

must remain possible.

---

13. Drive Job States

A Drive replication job can use states such as:

PENDING
PROCESSING
SUCCESS
FAILED
RETRYING
RETRY_AFTER
SKIPPED

Actual values must follow the existing Supabase schema.

The Admin Panel should display these states clearly without changing the underlying state machine unnecessarily.

---

14. Retry and Recovery

The backend must be retry-safe and idempotent.

The Admin Panel may provide operational controls for:

- viewing failed jobs
- inspecting errors
- retrying failed jobs
- monitoring retry counts
- identifying permanently failing accounts
- reviewing recent failures

Retrying a job must not create duplicate media files.

Idempotency must be enforced by the backend.

The browser must not attempt to implement its own duplicate-prevention logic as a replacement for backend idempotency.

---

15. Large Media

The system is designed to support large photos and videos.

Examples:

100 MB
500 MB
1 GB
2 GB+

Large files must not be fully buffered into browser memory.

The Admin Panel does not transfer large media files.

Large file processing belongs to backend workers using appropriate streaming/resumable techniques.

The Admin Panel should instead expose status and operational information.

---

16. Telegram Architecture

Telegram is another independent replication destination.

The Android app may allow a user to configure:

- Bot Token
- Chat ID
- Enable/Disable
- Connection status

However:

«Android must not upload media directly to Telegram.»

The intended flow is:

Android
   ↓
Cloudinary
   ↓
Supabase
   ↓
Telegram Job
   ↓
Server-side Telegram Worker
   ↓
User Telegram Destination

Telegram bot tokens must remain server-side.

The Admin Panel may eventually provide operational visibility into Telegram replication, but Telegram upload implementation is outside this repository's frontend responsibility.

---

17. Admin Authorization

Administrative access must be enforced at the backend/data layer.

The existing Supabase authorization mechanism should be reused.

Where available, use:

public.is_admin()

or the existing equivalent.

Client-side UI checks are useful for navigation but must not be treated as the security boundary.

An authenticated non-admin must not gain access to administrative data simply by modifying browser requests.

---

18. Database Rules

The existing live Supabase database is the source of truth.

Important rules:

- Do not reset the database.
- Do not run destructive schema operations.
- Do not replay unreliable historical migrations.
- Do not assume old migrations represent current production state.
- Inspect existing schema before adding tables.
- Reuse existing tables whenever appropriate.
- Add only minimal new migrations when required.
- Keep RLS enabled for sensitive data.
- Do not create redundant tables for concepts that already exist.

Sensitive Drive credentials must never be readable by ordinary application users.

---

19. Admin Panel Navigation

The initial Admin Panel can use a simple structure:

Dashboard
Drive Accounts
Backup Jobs
Users
Media
Telegram
Audit Logs
Settings

Some sections may initially be placeholders or limited to read-only views.

The implementation should prioritize working infrastructure features over visual complexity.

---

20. Initial Dashboard

The dashboard should eventually provide an operational overview such as:

Connected Drive Accounts
Healthy Drive Accounts
Unavailable Drive Accounts
Total Available Storage
Used Storage
Pending Drive Jobs
Processing Jobs
Failed Jobs
Retrying Jobs
Recent Upload Activity

Values must come from real backend data.

Do not use hardcoded fake statistics in production pages.

---

21. Drive Account Management

The Drive Accounts page should eventually support:

Account connection

+ Connect Google Drive

Account information

Google Account
Status
Health
Storage
Priority
Enabled
Last Checked

Operational actions

Depending on backend support:

Enable
Disable
Reconnect
Refresh Health
Remove Connection

Dangerous/destructive operations must require appropriate confirmation.

---

22. Media Administration

The Admin Panel may eventually allow administrators to search and inspect media metadata.

Possible filters:

- user
- date
- upload status
- Telegram status
- Drive status
- Drive account
- file type
- file size

The Admin Panel should display metadata and operational state.

It should not unnecessarily download or proxy original media through the Admin Panel.

---

23. Logical Media Aggregation

A user's media may physically exist across multiple Drive accounts.

Example:

User A

Cloudinary
 ├── photo1
 ├── photo2
 └── photo3

Drive A
 ├── photo1
 └── photo2

Drive B
 └── photo3

The Admin Panel should eventually present this as one logical media collection.

Physical storage location should remain visible as metadata when useful:

photo1 → Drive A
photo2 → Drive A
photo3 → Drive B

This prevents administrators from needing to manually search every Drive account.

---

24. Audit Logging

Administrative actions should eventually be auditable.

Examples:

Admin connected Drive account
Admin disabled Drive account
Admin changed routing priority
Admin retried replication job
Admin changed backup configuration
Admin removed Drive connection

Audit records should contain appropriate metadata such as:

- administrator
- action
- target
- timestamp
- relevant result/status

Never store secrets inside audit logs.

---

25. Error Handling

The UI should clearly distinguish:

Loading
Success
Warning
Temporary failure
Permanent failure
Unauthorized
Configuration error
Connection error

Backend error details should not accidentally expose secrets or internal credentials.

User-friendly messages should be shown in the UI while detailed operational information may remain available to authorized administrators.

---

26. Development Principles

All future changes should follow these principles:

Inspect before modifying

Always inspect:

- existing files
- Supabase schema
- existing Edge Functions
- existing database policies
- existing components
- existing authentication implementation

before creating replacements.

Prefer reuse

Do not create duplicate:

- auth systems
- Drive account tables
- OAuth handlers
- API clients
- state machines
- database concepts

when an existing implementation already provides the required functionality.

Minimal changes

Avoid broad refactors.

A feature should modify only the necessary files.

Security first

Sensitive operations belong on the server side.

Backend is authoritative

The Admin Panel is an administrative client.

It is not the source of truth for:

- authorization
- media ownership
- replication state
- routing
- credentials
- idempotency

Those belong to Supabase/backend infrastructure.

---

27. Environment Variables

Environment variables must be separated by exposure level.

Frontend-safe values may include values such as:

NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=

Server-only values may include:

SUPABASE_SERVICE_ROLE_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

Actual secret storage should prefer Supabase Edge Function secrets when the operation is implemented there.

Never use:

NEXT_PUBLIC_GOOGLE_CLIENT_SECRET
NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY
NEXT_PUBLIC_GOOGLE_REFRESH_TOKEN

or equivalent client-exposed secrets.

---

28. Google OAuth Redirect URI

The exact redirect URI must be based on the deployed environment.

Development example:

http://localhost:3000/...

Production example:

https://<admin-domain>/...

The actual callback path must match the implementation.

The final redirect URI must be registered in Google Cloud OAuth credentials.

Do not hardcode a development callback as the production callback.

---

29. Deployment

The Admin Panel is designed as an independent web application.

Typical deployment architecture:

GitHub
   ↓
Deployment Platform
   ↓
My Drive Admin Panel
   ↓
Supabase

Suitable deployment platforms may include:

- Vercel
- Cloudflare
- another platform supporting Next.js

The chosen provider should be configured with production-safe environment variables.

Secrets must never be committed to Git.

---

30. Local Development

Typical development workflow:

npm install
npm run dev

Then open the local development URL provided by Next.js.

The exact commands may differ if the repository structure requires them.

Do not assume a package manager or script if the repository already defines a different standard.

---

31. Current Implementation Scope

The initial development milestone is:

Phase 1 — Admin Foundation

- Next.js project
- TypeScript
- Tailwind
- Supabase connection
- Admin login
- Admin route protection
- Dashboard shell
- Drive Accounts page
- Google OAuth connection
- Secure token handling
- Drive account registration
- RLS/security verification

Phase 2 — Drive Operations

- Drive account health
- Storage/quota monitoring
- Drive account priority
- Enable/disable account
- User folder mapping
- Drive routing visibility
- Drive replication job monitoring

Phase 3 — Backup Operations

- Failed job management
- Retry controls
- Queue monitoring
- Telegram job monitoring
- Drive job monitoring
- Reconciliation
- Operational logs

Phase 4 — Advanced Administration

- Logical media search
- Multi-account archive browsing
- Audit logs
- Advanced routing controls
- Storage analytics
- Retention management
- Lifecycle policies

---

32. What This Repository Must Never Do

The Admin Panel must never:

- contain Cloudinary API Secret in client code
- contain Telegram bot tokens in client code
- contain Google refresh tokens in client code
- contain Supabase service-role credentials in client code
- upload Android media directly
- upload media directly to Telegram from the browser
- upload media directly to Google Drive from the browser
- bypass Supabase authorization
- bypass RLS
- implement hardcoded 3/4 Drive accounts
- create duplicate media records simply because storage moved
- perform destructive database resets
- store secrets in Git
- treat client-side admin checks as sufficient authorization

---

33. Success Criteria

The Admin Panel foundation is considered successful when:

1. Only administrators can access protected admin pages.
2. Existing Supabase authentication remains the source of authentication.
3. Google OAuth can securely connect a Drive account.
4. Google refresh tokens remain server-side.
5. Multiple Google accounts can be connected without hardcoded limits.
6. Drive account metadata is stored securely.
7. RLS prevents normal application users from accessing administrative Drive credentials.
8. The Android application remains unaffected.
9. No production secret is committed to the repository.
10. The Admin Panel can serve as the foundation for future Drive routing and backup monitoring.

---

34. Architectural Principle

The most important principle of My Drive is:

«Upload media once, then replicate it server-side.»

Android should not become responsible for managing multiple cloud destinations.

The backend controls replication.

The Admin Panel controls and monitors the backend.

                    ┌─────────────────────┐
                    │     Admin Panel      │
                    │  Control & Monitor   │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │       Supabase      │
                    │  Auth + DB + Jobs   │
                    └──────────┬──────────┘
                               │
                ┌──────────────┴──────────────┐
                ▼                             ▼
        ┌──────────────┐              ┌──────────────┐
        │  Cloudinary  │              │ Replication  │
        │ Primary Media│              │   Workers    │
        └──────────────┘              └──────┬───────┘
                                             │
                                  ┌──────────┴──────────┐
                                  ▼                     ▼
                             Telegram              Google Drive

This separation keeps the Android application lightweight, keeps credentials server-side, and allows the backend to manage multiple backup destinations independently.

---

## Implementation Report

### Files Created/Modified

| File | Status | Purpose |
|---|---|---|
| `supabase/functions/google-oauth-initiate/index.ts` | Created | Edge Function: initiates Google OAuth, returns auth URL |
| `supabase/functions/google-oauth-callback/index.ts` | Created | Edge Function: exchanges code for tokens, stores encrypted refresh token |
| `supabase/migrations/001_oauth_states_and_admin.sql` | Created | OAuth states table for CSRF protection |
| `supabase/migrations/002_add_refresh_token_encrypted.sql` | Created | Adds encrypted token column to drive_accounts |
| `supabase/config.toml` | Created | Local Edge Function dev config |
| `src/app/admin/drive/page.tsx` | Modified | Excludes refresh_token_encrypted from browser query |
| `src/app/admin/drive/callback/page.tsx` | Modified | Improved OAuth error handling |
| `src/components/ConnectGoogleDriveButton.tsx` | Modified | Inline error feedback |
| `src/components/DriveAccountCard.tsx` | Modified | Better error handling, disconnect safety |
| `ENV_VARIABLES.md` | Modified | Added ENCRYPTION_KEY and ADMIN_CALLBACK_URL docs |

### Database Migrations

- **001**: Creates `oauth_states` table (CSRF protection, 10-min TTL, admin-only RLS)
- **002**: Adds `refresh_token_encrypted` column to `drive_accounts`

### Edge Functions

- **`google-oauth-initiate`**: Admin auth → CSRF state → Google auth URL
- **`google-oauth-callback`**: Validate state → Exchange code → Encrypt token → Store in drive_accounts

### Environment Variables

Frontend: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
Server: `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ENCRYPTION_KEY`, `ADMIN_CALLBACK_URL`
Edge Function secrets: Same server vars set via `supabase secrets set`

### Google OAuth Redirect URI

Development: `http://localhost:3000/admin/drive/callback`
Production: `https://your-admin-domain.com/admin/drive/callback`

### How to Run

```bash
npm install
# Create .env.local with all required variables (see ENV_VARIABLES.md)
supabase db push  # Apply migrations
# Set Edge Function secrets via supabase secrets set ...
# Deploy Edge Functions via supabase functions deploy ...
npm run dev
```

### How to Deploy

Vercel: Connect repo → Set env vars → Auto-deploy on push.
Edge Functions: `supabase functions deploy google-oauth-initiate google-oauth-callback`
Update `ADMIN_CALLBACK_URL` and Google Cloud Console redirect URI for production.

### Security Considerations

1. Refresh tokens encrypted with AES-256-GCM, never returned to browser
2. Google Client Secret server-side only
3. CSRF protection via random state tokens with 10-min expiry
4. Admin auth checked server-side in middleware AND Edge Functions
5. RLS: drive_accounts admin-only; encrypted column excluded from select queries
6. No public admin signup
7. Admin role re-verified at token exchange time

### Schema Limitations Discovered

1. `drive_accounts.refresh_token_secret_id` references nonexistent secret store → resolved with migration 002
2. No `oauth_states` table → created in migration 001
3. `private.is_admin()` exists in DB but admin panel uses equivalent `profiles.role` checks
4. No key rotation for encryption key — if rotated, existing tokens become undecryptable
