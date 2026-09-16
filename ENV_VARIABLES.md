# My Drive Admin Panel - Environment Variables

## Quick Setup

Copy the relevant values into `.env.local` (which is gitignored):

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
ENCRYPTION_KEY=generate-with-openssl-rand-hex-32
ADMIN_CALLBACK_URL=http://localhost:3000/admin/drive/callback
```

---

## Frontend-safe variables (exposed to browser)

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |

## Server-only variables (NEVER expose to browser)

| Variable | Description |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key for admin operations |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `ENCRYPTION_KEY` | AES-256-GCM key for encrypting refresh tokens (64 hex chars). Generate with `openssl rand -hex 32` |
| `ADMIN_CALLBACK_URL` | OAuth redirect URI. Must match Google Cloud Console authorized redirect URI exactly |

---

## Supabase Edge Function Secrets

These are set via Supabase CLI or Dashboard and are injected as Deno environment variables at runtime. They are NOT the same as `.env.local` variables.

```bash
supabase secrets set GOOGLE_CLIENT_ID=your-google-client-id
supabase secrets set GOOGLE_CLIENT_SECRET=your-google-client-secret
supabase secrets set ENCRYPTION_KEY=your-64-char-hex-string
supabase secrets set ADMIN_CALLBACK_URL=https://your-admin-domain.com/admin/drive/callback
```

Or via: Dashboard > Edge Functions > Secrets

---

## Google OAuth Redirect URI

The exact redirect URI **must** be registered in Google Cloud Console under your OAuth 2.0 credentials:

- **Development**: `http://localhost:3000/admin/drive/callback`
- **Production**: `https://your-admin-domain.com/admin/drive/callback`

The value of `ADMIN_CALLBACK_URL` must match exactly.

---

## ENCRYPTION_KEY

The `ENCRYPTION_KEY` is used to encrypt Google Drive refresh tokens before storing them in the database. This prevents plaintext token exposure if the database is compromised.

Generate a secure key:

```bash
openssl rand -hex 32
```

This produces a 64-character hex string (256 bits).

**Important**: Store this key securely. If lost, existing encrypted refresh tokens cannot be decrypted, and all Drive accounts will need to be reconnected.

---

## Security Rules

**NEVER create these variables:**
- `NEXT_PUBLIC_GOOGLE_CLIENT_SECRET`
- `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_GOOGLE_REFRESH_TOKEN`
- `NEXT_PUBLIC_ENCRYPTION_KEY`

**Google Client Secret** must remain server-side only.

**Refresh tokens** are encrypted with AES-256-GCM and stored in the database — never in environment variables.

**The service role key** is only used in Edge Functions for admin operations.
