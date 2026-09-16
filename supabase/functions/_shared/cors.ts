/**
 * Shared CORS headers for browser-invoked Edge Functions.
 *
 * The header allow-list must cover every header the calling clients send.
 * The Admin Panel uses @supabase/ssr + @supabase/supabase-js, which send:
 *   authorization, apikey, x-client-info, content-type
 * (plus x-retry-count / traceparent / tracestate / baggage in some SDK
 * configurations), so those are listed defensively.
 *
 * `Access-Control-Allow-Methods` is required for the POST preflight of
 * `supabase.functions.invoke`. When the preflight response is incomplete the
 * browser rejects the call before any request reaches the function, and the
 * SDK reports it only as the generic
 * "Failed to send a request to the Edge Function" — indistinguishable from a
 * platform 404 / boot error, which is exactly what makes this class of bug
 * hard to diagnose.
 */
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

/**
 * Answers a CORS preflight (OPTIONS) request, or returns null when the request
 * is a normal invocation that the caller must continue handling.
 */
export function handleCors(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}
