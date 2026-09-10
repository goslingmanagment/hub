# A0/T0 implementation and evidence

Authority: the migration plan and reviews dated 7 September, and the cross-check
DECISION. Implementation branch: `feat/fansly-a0-shadow`, based on main
`ce2485ae` / Decision 283. This stage adds measurement only; no production
shadow, savings result or A1 gate is claimed.

The completed pre-A0 work is recorded separately from the new measurement:

- PR157's stale-follow-up/known-head debt correction is deployed. The frozen
  Lilly-2 corpus was 5615/5615 in retained message bodies. That is not an
  all-message archive census. Four Lilly-1 and one Lora-1 original head gaps,
  plus a separate Ari marker discrepancy, remain explicitly unconfirmed in
  the 9 September evidence; they were not reclassified as deletions.
- PR158–162's original reply corpus passed: 994 exact IDs / 2893 observations /
  27 attached messages across six pages, using separately timestamped reads.
  It is not an atomic census, later-edit guarantee or fresh-event latency test.
- The approved Lilly-2 hour on 10 September ended with the flag back at `none`
  on all roles, verified 16:30:12 UTC; heartbeat paused. There were zero eligible
  targets and zero recovery attempts. 104 excluded debts remained (93 hidden,
  11 other excluded). The original eight targets were recovered by ordinary
  collection before activation; post-rollback material checks passed 8/8.
  Two ordinary full lists completed. Canary recovery efficacy is unmeasured.
  Rollback dispatch was 7.735 seconds after the planned deadline; <=60-second
  configuration propagation was not established.

The detailed operational evidence remains in the primary workspace under
`investigations/fansly-pr162-release-2026-09-09/`,
`investigations/fansly-five-page-reply-replay-2026-09-08/`, and
`investigations/fansly-lilly2-head-canary-2026-09-10/`. No canary is active.

A read_only / READ ONLY privilege probe during A0 preparation confirmed that
production exposes observations but not sync_raw_payloads, sync_runs or
sync_run_events directly. Observations lack the retained request offset needed
to assemble complete sweeps. The narrow migration read operations solve this
without granting base-table access. Historical September 1–6 export and
sensitivity are pending their inert deployment; activation follows that pass.

Implementation: scalar cursor diagnostics, pre-apply full-scope head diffs,
exact hot-ID checks, separate reports with independent run-event loss receipts,
physical-attempt loss counters, bounded read/export and offline sensitivity.
The default flag is `none`. Policy is a candidate K=3 / 60-second overlap;
the offline report evaluates nine settings and never certifies safe early stop.

Validation: `pnpm check` passed (3134 tests, 284 files, 9 existing skips;
strictness ratchet 1908 known errors in 121 existing files; lint and dashboard
build pass). The final serial Docker-Postgres run passed 44 tests in six files,
zero skips, in 15.11 seconds. It covers shadow/off parity across chunks,
failed diagnostic sinks, guard rejection, a two-hour outage, exact hot receipts,
T0 sources/retries/boundary losses, read privilege isolation, capped corpus
export and page-erasure inventory. EXPLAIN at 50,000 runs and 50,000 physical
attempts verifies the actual report query uses time indexes; this is local
query-plan evidence, not production latency. Executable offline CLI tests verify
nine-policy output and reject a corpus truncated between completed sweeps.

Independent reviewer `review_pr162` reviewed the complete code and fixtures in
several rounds. All findings were fixed: timestamp coercion, false history age,
missing report denominator, source and boundary loss, overlap-query index,
erasure inventory, capture-byte basis, hot-material scope, manifest validation
and ambiguous duplicate aggregation heads. Final review: no actionable findings;
reviewer did not run production or test suites. Test runs above are coordinator
verification. The [runbook](../../docs/runbooks/fansly-events-shadow.md) defines reads,
activation, interpretation and rollback. No owner input is needed to finish
implementation/review. An inert deployment and activation remain separate
concrete owner gates once the reviewed revision is ready.
