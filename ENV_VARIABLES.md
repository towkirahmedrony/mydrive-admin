# My Drive Admin Panel - Environment Variables

## Quick Setup

Copy the relevant values into `.env.local` (which is gitignored):

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

The Google Drive OAuth credentials are **not** frontend variables. They are
Supabase Edge Function secrets (see below) and must never be exposed with a
`NEXT_PUBLIC_*` prefix.

---

## Frontend-safe variables (exposed to browser)

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |

---

## Supabase Edge Function Secrets

These are set via the Supabase CLI or Dashboard and are injected as Deno
environment variables at runtime. They are what the OAuth Edge Functions
(`google-oauth-initiate`, `google-oauth-callback`) and the Drive worker
consume centrally.

| Variable | Description |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth client secret |
| `ADMIN_CALLBACK_URL` | OAuth redirect URI. Must match the Google Cloud Console authorized redirect URI exactly |

```bash
supabase secrets set GOOGLE_OAUTH_CLIENT_ID=your-google-client-id
supabase secrets set GOOGLE_OAUTH_CLIENT_SECRET=your-google-client-secret
supabase secrets set ADMIN_CALLBACK_URL=https://your-admin-domain.com/admin/drive/callback
```

Or via: Dashboard > Edge Functions > Secrets

Supabase provides `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` automatically.

---

## Credential storage

Google Drive refresh tokens are stored in **Supabase Vault**, never in an
environment variable and never in a plaintext table column. The OAuth callback
stores a token only through the authoritative RPC:

```
admin_store_drive_refresh_token(p_drive_account_id, p_refresh_token)
```

`drive_accounts` keeps only the Vault reference in `refresh_token_secret_id`.
The Drive worker later retrieves the token via
`worker_lookup_drive_refresh_token()`.

There is **no** `ENCRYPTION_KEY` in the Drive OAuth flow. Do not add one and do
not reintroduce `drive_accounts.refresh_token_encrypted`.

---

## Google OAuth Redirect URI

The browser is redirected to the **Admin Panel callback page**, which receives
`?code=...&state=...` and forwards them server-side to the Edge Function:

- **Development**: `http://localhost:3000/admin/drive/callback`
- **Production**: `https://your-admin-domain.com/admin/drive/callback`

The value of `ADMIN_CALLBACK_URL` must match exactly, and the same value is
used for both the Google authorization request and the token exchange.

The Edge Function URL (`.../functions/v1/google-oauth-callback`) is **not** the
Google redirect target.

---

## OAuth scope

The flow requests only:

```
https://www.googleapis.com/auth/drive.file
```

This is the minimum scope required by `drive-replicate`: the worker only lists,
creates, and uploads files/folders that this application itself created. No
broader Drive scope is requested.

---

## Security Rules

**NEVER create these variables:**
- `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_SECRET`
- `NEXT_PUBLIC_GOOGLE_CLIENT_SECRET`
- `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_GOOGLE_REFRESH_TOKEN`
- `NEXT_PUBLIC_ENCRYPTION_KEY`

**Google Client Secret** must remain server-side only.

**Refresh tokens** live in Supabase Vault and are never returned to the
browser, logged, or stored in `drive_accounts`.

**The service role key** is only used in Edge Functions for admin operations.
