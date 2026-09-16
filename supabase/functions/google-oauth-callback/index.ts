import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * Encrypts a string using AES-256-GCM with a key derived from an environment secret.
 *
 * Security notes:
 * - The ENCRYPTION_KEY env var must be a 32-byte hex string (64 hex chars).
 *   Generate with: openssl rand -hex 32
 * - This uses a random 12-byte IV per encryption, so identical plaintexts produce
 *   different ciphertexts.
 * - The output is base64-encoded: iv(12) + ciphertext + tag(16)
 *
 * For production, prefer Supabase Vault (pgcrypto) or a dedicated secret manager.
 */
async function encryptSecret(plaintext: string): Promise<string> {
  const rawKey = Deno.env.get("ENCRYPTION_KEY");
  if (!rawKey || rawKey.length < 64) {
    throw new Error(
      "ENCRYPTION_KEY env var is missing or too short. " +
      "Generate one with: openssl rand -hex 32"
    );
  }

  const keyBytes = new Uint8Array(
    rawKey.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
  );
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );

  // Combine iv + ciphertext + tag into a single buffer, then base64-encode
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return btoa(String.fromCharCode(...combined));
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // This endpoint receives a POST from the admin panel callback page
    // with { code, state } extracted from the Google OAuth redirect.
    const { code, state } = await req.json();

    if (!code || !state) {
      return new Response(
        JSON.stringify({ error: "Missing code or state parameter" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify the state (CSRF protection) — must match an existing, unexpired state
    const { data: stateRecord, error: stateError } = await supabase
      .from("oauth_states")
      .select("user_id, expires_at")
      .eq("state", state)
      .single();

    if (stateError || !stateRecord) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired state parameter" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if the state has expired (10-minute TTL)
    if (new Date(stateRecord.expires_at) < new Date()) {
      // Clean up expired state
      await supabase.from("oauth_states").delete().eq("state", state);
      return new Response(
        JSON.stringify({ error: "OAuth state expired. Please try again." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = stateRecord.user_id;

    // Delete the used state immediately (single-use)
    await supabase.from("oauth_states").delete().eq("state", state);

    // Also clean up any other expired states while we're here
    await supabase.rpc("cleanup_expired_oauth_states");

    // Verify the user is still an admin (role may have changed since state was created)
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .single();

    if (profileError || !profile || profile.role !== "admin") {
      return new Response(
        JSON.stringify({ error: "Admin access required" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Exchange the authorization code for tokens
    const adminCallbackUrl = Deno.env.get("ADMIN_CALLBACK_URL") ||
      `${supabaseUrl.replace(".supabase.co", ".vercel.app")}/admin/drive/callback`;

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_uri: adminCallbackUrl,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error("Token exchange failed:", errorData);
      return new Response(
        JSON.stringify({ error: "Failed to exchange authorization code with Google" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const tokens = await tokenResponse.json();

    if (!tokens.refresh_token) {
      return new Response(
        JSON.stringify({
          error: "No refresh token received. This can happen if you previously authorized this account. Please revoke access in your Google account settings and try again.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get Google user info (email and display name)
    const userInfoResponse = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      }
    );

    if (!userInfoResponse.ok) {
      console.error("Failed to fetch Google user info");
      return new Response(
        JSON.stringify({ error: "Failed to retrieve Google account information" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userInfo = await userInfoResponse.json();

    // Create a root folder "My Drive Archive" on the connected Drive
    let rootFolderId: string | null = null;
    try {
      const folderResponse = await fetch(
        "https://www.googleapis.com/drive/v3/files",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "My Drive Archive",
            mimeType: "application/vnd.google-apps.folder",
          }),
        }
      );

      if (folderResponse.ok) {
        const folderData = await folderResponse.json();
        rootFolderId = folderData.id;
      } else {
        console.error("Failed to create root folder:", await folderResponse.text());
        // Non-fatal: the root folder can be created later
      }
    } catch (err) {
      console.error("Error creating root folder:", err);
      // Non-fatal
    }

    // Encrypt the refresh token with AES-256-GCM before storing.
    // This prevents plaintext token exposure if the database is compromised.
    // NOTE: In production, consider using Supabase Vault (pgcrypto) for
    // database-level encryption with key rotation support.
    let encryptedRefreshToken: string;
    try {
      encryptedRefreshToken = await encryptSecret(tokens.refresh_token);
    } catch (encryptError) {
      console.error("Failed to encrypt refresh token:", encryptError);
      return new Response(
        JSON.stringify({ error: "Server configuration error: ENCRYPTION_KEY not set" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create or update the drive account record.
    // The refresh_token_secret_id column currently references a secret store.
    // Since no dedicated secrets table exists yet, we store the encrypted token
    // in a new column. See README.md for migration notes.
    const { data: existingAccount } = await supabase
      .from("drive_accounts")
      .select("id")
      .eq("google_email", userInfo.email)
      .single();

    if (existingAccount) {
      // Update existing account — refresh token, metadata, and status.
      // Preserve admin-set fields like priority.
      const { error: updateError } = await supabase
        .from("drive_accounts")
        .update({
          name: userInfo.name || userInfo.email,
          refresh_token_encrypted: encryptedRefreshToken,
          root_folder_id: rootFolderId,
          status: "active",
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingAccount.id);

      if (updateError) {
        console.error("Error updating drive account:", updateError);
        return new Response(
          JSON.stringify({ error: "Failed to update Drive account record" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    } else {
      // Create new account with encrypted refresh token
      const { error: insertError } = await supabase.from("drive_accounts").insert({
        name: userInfo.name || userInfo.email,
        google_email: userInfo.email,
        refresh_token_encrypted: encryptedRefreshToken,
        root_folder_id: rootFolderId,
        priority: 100,
        status: "active",
      });

      if (insertError) {
        console.error("Error creating drive account:", insertError);
        return new Response(
          JSON.stringify({ error: "Failed to create Drive account record" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Log the OAuth connection event (no secrets in metadata)
    await supabase.from("sync_logs").insert({
      event_type: "oauth_connection",
      status: "success",
      message: `Connected Google Drive account: ${userInfo.email}`,
      metadata: {
        admin_user_id: userId,
        google_email: userInfo.email,
        root_folder_id: rootFolderId,
      },
    });

    // Return success — NEVER include refresh_token, access_token, or encrypted token in response
    return new Response(
      JSON.stringify({ success: true, email: userInfo.email }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("OAuth callback error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
