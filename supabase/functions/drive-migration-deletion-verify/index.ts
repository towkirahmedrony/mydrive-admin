// Temporary read-only deletion-phase verifier — REMOVED.
//
// Neutralised: no logic, no credentials, no Google call, no database access,
// no input. Returns 410 Gone for every request.
//
// Its runs (2026-09-25) verified all 243 items on both sides after every
// deletion batch and once more in full; results are recorded in
// drive-migration-source-deletion-report.md.
Deno.serve(() =>
  new Response(
    JSON.stringify({ error: "This temporary verification endpoint has been removed." }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  )
);
