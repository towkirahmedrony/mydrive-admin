// Temporary read-only source-preservation check — REMOVED.
//
// Neutralised: no logic, no credentials, no Google call, no database access,
// no input. Returns 410 Gone for every request.
//
// Its one run (2026-09-25) returned source_intact = 5 / 5 with zero anomalies
// and is recorded in drive-migration-dry-run-report.md §12.
Deno.serve(() =>
  new Response(
    JSON.stringify({ error: "This temporary diagnostic endpoint has been removed." }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  )
);
