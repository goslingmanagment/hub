Fansly's full DM sweep has no reliable measurement of where a proposed early stop would miss data or how many physical requests it would avoid. This adds A0/T0 diagnostics behind `fanslyDmShadowPageAllowlist=none`, while retaining the full HTTP sequence, business streak, checkpoint authority, membership finalization, follow-ups and scheduled slots.

Scalar diagnostics survive chunk resumes. Independent report/run-event receipts preserve missing and incomplete measurements. T0 includes retries, source, lost insert/terminal receipts and boundary-crossing runs. Bounded read operations and a hashed corpus exporter support the retained September 1–6 comparison at nine depth/overlap settings. Duplicate aggregation heads, truncated exports and mutable-offset blind spots cannot be presented as safe-stop proof. The new report table participates in page erasure; a concurrent finished-at index supports the overlapping-run read.

Decision 284, the flag/rollback runbook, stage evidence and independent review are included. New production helpers are 15–117 lines; offline tooling is split into 46/72/159-line files. The existing sweep test fixture was extracted for shared parity tests.

### Validation

- `pnpm check`: **passed**, 3134 tests / 284 files, 9 existing skips; lint and dashboard build pass. Strictness ratchet unchanged: 1908 known errors across 121 files.
- Real Docker-Postgres, one serial invocation: **44 tests in 6 files passed, zero skips**, 15.11 seconds:
  - `fansly-events-measurement.integration.test.ts`
  - `fansly-dm-shadow.integration.test.ts`
  - `fansly-dm-conversations-sweep.integration.test.ts`
  - `fansly-dm-generation-membership.integration.test.ts`
  - `fansly-dm-head-debt.integration.test.ts`
  - `erasure-page-owned-tables.integration.test.ts`
- The tests cover shadow/off parity, persisted continuation, a two-hour outage, failed sinks, rejected full sweeps, exact hot-ID receipts, retries/source/boundary loss, read privileges and bounded corpus export. EXPLAIN tests the actual report query at 50,000 runs and physical-attempt aggregation at 50,000 attempts; time indexes are used without a sequential runs scan.
- Independent review completed; all findings fixed. See `investigations/fansly-a0-shadow-2026-09-10/REVIEW.md`. Tests above were run separately by the coordinator.

### Production evidence and remaining gates

The Lilly-2 hour is closed and rolled back: zero eligible targets / zero recovery attempts, 104 excluded debts unchanged, selected material 8/8 intact, two ordinary list completions. Those eight recovered before activation, so the canary proves no recovery efficacy. The prior bounded reply corpus passed 994/994 IDs with 27 attached messages across timestamped reads; old head discrepancies remain explicit.

**A0-only is deployed** at `a3caa0e9f7b37a5cde83485613d8a059c0050aca`. The standard full build/deployment completed on September 10 at 22:03:36 UTC. API, worker and scheduler use image `sha256:148188403f92bef8d8804cad6358abf841805f2245a6d91ffca8cb966704fea2`; health/capability/protected sync/dashboard gates passed. Final checks at 22:40–22:42 UTC found all roles healthy, zero restarts, 27 GiB free and a successful read_only / READ ONLY connection with zero other reader sessions. The owner subsequently approved measurement-only shadow on all six pages. The allowlist was saved at 22:57:40.139 UTC and verified on all three active roles at 22:58:33.610 UTC (53.471 seconds observed upper bound). Exactly one of 59 editable controls changed; head catch-up remains `none`, replay remains `off`. C2a/C2b are excluded from this deployment.

**Measured T0, September 1–6 UTC:** 183,416 retained physical-attempt rows, including 5,241 attempts with retry ordinal >1; 1,709 terminal-failed rows. Known captured payload bytes total 12,888,887,748, with 9,100 unknown-byte rows. All 42,839 overlapping historical runs have unknown loss counters, so this is instrumented retained workload, not a proven complete census. The dm_conversations producer stream contains 94,125 attempts, including 93,110 messaging_groups calls.

**Completed historical comparison:** 93,130 raw list-page envelopes, all six pages, through pinned raw ID 2,794,341. SHA-256 `4427fc91ce476e936df767aa51a0f784b9f098ae133776a9b4d6a055d3194992`. Raw envelopes and physical-attempt rows are different populations. Each of nine policies has 1,478 complete comparisons, 214 priming and 98 incomplete sweeps, plus 1,046 invalid/unattached records. These are shared cohorts, not nine independent samples.

At K=3 / 60s, 70,907 of 78,582 complete-cohort list pages lie below the virtual stop, with **28 state-change occurrences in 26 sweeps**: 25 flag observations, one group absent from the predecessor and two list/embedded head conflicts. In the conflicts, embedded ID/sender/time change while the list ID remains stale. K=1 still misses 42 state-change occurrences; K=5 still misses 16. **No candidate passed safe-stop acceptance.** These hypothetical excluded list responses are not actual HTTP savings. The default policy also sees 3,061,782 invalid-marker occurrences below stop; raw metadata cannot establish material completeness or latency.

Independent operational review verified the complete corpus hash/count, ordered bounded IDs, timestamps, aggregations and three concrete before/after examples. Export cancellation findings were fixed; four real local Docker-Postgres cases verify SIGINT, SIGTERM, pre-connection cancellation and completed export through the unchanged analyzer. The 2.23 GB metadata corpus is retained locally, not uploaded here. Original implementation validation is listed above.

The historical investigation prerequisite is complete. **Measurement-only runtime shadow is now active** on `ari-1,lilly-1,lilly-2,lora-1,lora-2,lora-3`; full polling continues. The first verified observation point is **2026-09-10T22:58:33.610Z**. Seven full days cannot elapse before **2026-09-17T22:58:33.610Z** (September 18, 01:58:33 Moscow).

The first cumulative report through 23:02 UTC recorded 116 physical attempts, all HTTP 200/success, zero retry ordinals, and a live Lilly-1 shadow row at page 13 across two resumes. Its virtual stop was page 4, so the full production sweep visibly continued nine pages beyond it. This is a running row, not a completed zero-miss comparison; the short window does not prove fleet coverage or fresh-event latency. Two overlapping runs retained unknown loss counters and three crossed the window boundary. The report hash and role/READ ONLY receipt were verified.

A read-only thread heartbeat collects cumulative reports every six hours and reports after the minimum seven-day period. It cannot change production flags, deploy, replay/recover or advance A1. Snapshots are not summed; later completions can update earlier rows. A0 exit, A1, actual HTTP savings, pending-history origin age, archive/serving completeness and fresh-event latency remain unproven. No socket, cadence, owner-token or B2 change is included.
