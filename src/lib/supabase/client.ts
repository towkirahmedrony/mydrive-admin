import { createBrowserClient } from "@supabase/ssr";

let client: ReturnType<typeof createBrowserClient> | null = null;

/**
 * Structured, secret-free diagnostic logging for the browser Supabase client.
 *
 * Only the resolved project host and booleans are ever logged. The API key,
 * the anon key, the session, the JWT and the Authorization header are never
 * read or logged here.
 */
function logSupabaseClient(fields: Record<string, unknown>): void {
  console.info(
    `[GoogleDrive][supabase_client] ${JSON.stringify({
      scope: "GoogleDrive",
      operation: "supabase_client_init",
      timestamp: new Date().toISOString(),
      ...fields,
    })}`
  );
}

/**
 * Extracts the host of the configured Supabase project so the browser console
 * proves which project this bundle is actually pointing at. This is the check
 * that distinguishes "the browser bundle is pointed at the wrong/old project"
 * from "the project is correct but the Edge Function is missing".
 */
function describeProject(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "INVALID_URL";
  }
}

export function createClient() {
  // NEXT_PUBLIC_* variables are inlined into the browser bundle at BUILD time
  // by Next.js. They must therefore exist in the environment that runs the
  // build (for Vercel: the project's Environment Variables before the build
  // runs); adding or changing them later has no effect on an existing bundle
  // until it is rebuilt and redeployed.
  //
  // Server-side code reads the same variables at RUNTIME, so a browser bundle
  // can silently point at a different project than the server for exactly this
  // reason.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    const missing = [
      !url ? "NEXT_PUBLIC_SUPABASE_URL" : null,
      !key ? "NEXT_PUBLIC_SUPABASE_ANON_KEY" : null,
    ].filter(Boolean);

    logSupabaseClient({
      event: "configuration_missing",
      result: "failure",
      missingVariables: missing,
      isBrowserBundle: typeof window !== "undefined",
    });

    throw new Error(
      `Supabase client requires ${missing.join(" and ")}. ` +
        "These are build-time inlined NEXT_PUBLIC_* variables: set them in the " +
        "build environment and redeploy."
    );
  }

  // Singleton: reuse the same client instance across renders.
  if (!client) {
    logSupabaseClient({
      event: "client_initialized",
      result: "success",
      projectHost: describeProject(url),
      hasAnonKey: Boolean(key),
      isBrowserBundle: typeof window !== "undefined",
    });

    client = createBrowserClient(url, key);
  }
  return client;
}
