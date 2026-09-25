// Temporary read-only two-sided reconciliation — REMOVED.
//
// Neutralised: no logic, no credentials, no Google call, no database access,
// no input. Returns 410 Gone for every request.
//
// Its one paged run (2026-09-25) checked all 243 items on BOTH sides with zero
// anomalies; results are recorded in drive-migration-completion-report.md §9.
Deno.serve(() =>
  new Response(
    JSON.stringify({ error: "This temporary reconciliation endpoint has been removed." }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  )
);
