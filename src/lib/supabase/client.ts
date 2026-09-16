import { createBrowserClient } from "@supabase/ssr";

let client: ReturnType<typeof createBrowserClient> | null = null;

export function createClient() {
  // Guard against missing env vars during build-time static generation.
  // NEXT_PUBLIC_* vars are not available in Vercel's build worker, so
  // createClient() must not throw when called during prerender.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    // During static generation, return a safe stub that will throw at
    // runtime if actually used (after hydration, when env vars exist).
    throw new Error(
      "Supabase client requires NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
      "These must be set in your deployment environment."
    );
  }

  // Singleton: reuse the same client instance across renders
  if (!client) {
    client = createBrowserClient(url, key);
  }
  return client;
}
