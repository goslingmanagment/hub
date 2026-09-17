# Read-only observation — 14 September 2026, 23:08 UTC

A0 has a meaningful new reader discrepancy on Lilly-1. A0/A1 remains NO-GO. This does not block default-off B0 development; this observer performs no implementation, flag or production changes.

## A0

Window: 2026-09-10T22:58:33.61+00:00 → 2026-09-14T23:08:36.010622+00:00. 1202 unique sweeps: 886 complete, 316 incomplete, no selected running. Compared with the prior 1089-row cumulative export: 113 new rows (52 complete, 61 incomplete); one old G4927 changes running → complete. No prior identities disappear or timestamps cross the current cutoff.

Lilly-1 G7527 completed 22:43:55–22:46:47 UTC with **806 reader_missing observations** below the candidate stop. G7528 ran 23:00:39–23:02:32 UTC with **711 observations in its incomplete cohort**, ending with snapshot_overlap_guard. These are repeated checks, not established counts of unique messages or lost content. Exact IDs and cause are not exported. The incomplete cohort is not added to complete acceptance statistics.

| Page | Complete | Incomplete | Complete reader rows / missing | Incomplete reader rows / missing |
|---|---:|---:|---|---|
| ari-1 | 157 | 37 | 13 / 0 | 2 / 0 |
| lilly-1 | 144 | 77 | 7 / 806 | 35 / 711 |
| lilly-2 | 144 | 44 | 12 / 12 | 8 / 0 |
| lora-1 | 142 | 63 | 10 / 0 | 9 / 0 |
| lora-2 | 149 | 51 | 13 / 0 | 7 / 0 |
| lora-3 | 150 | 44 | 13 / 0 | 0 / unknown (empty cohort) |

Instrumented complete: 68 rows, 818 missing (806 Lilly-1 +12 Lilly-2); instrumented incomplete:61 rows,711 missing. Deleted/pending/archive-only/unknown-reader counters are zero only within these instrumented cohorts. 1072 old rows lack reader fields and one row has explicit null; empty running cohort remains unknown, not a successful zero-miss test.

New incomplete reasons: {'dm_conversations_snapshot_overlap_guard': 52, 'uncertified_or_partial_diagnostics': 9}. All six pages have subsequent completed full sweeps. Full polling remains unchanged; a complete sweep with discrepancy does not certify the candidate stop.

Physical attempts (cumulative, not savings): {"attempts": 126644, "retry_attempts": 4447, "unknown_bytes": 7365, "captured_payload_bytes": 8381500146, "success": 120760, "retry": 4449, "failed": 1435, "started": 0, "http429": 0}. HTTP unknown runs4→6; boundary runs4→3; known unrecorded/unfinished counters remain0. DM failed runs35→88; lost-report runs remain8 and unknown DM runs1. New failed HTTP attempts are three Lora-2 HTTP500 rows; no causal link to Lilly-1 is established. Signed cumulative differences are not an independent interval census.

All legacy head/unread/flags/exclusion/material diagnostics and their presence/null coverage remain separately retained in [A0 summary](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/activation/20260910T225618Z/snapshot-20260914T230836Z/summary.json). Unknown coverage and old loss receipts are not erased by current known-zero counters.

## C1 / C2b

C1:8 repeatable-read pages, distinct asOf values and one fixed throughRunId753169.3527 unique rows,283 new; only prior row751072 changes unfinished_in_window from true to false.565 valid decisions=145 requested+420 no-request.143 exact request/terminal pairs; Lora-1 seq1282 and Lora-3 seq1540 remain pending at the cutoff, not failures.155 successful terminals=108 valid membership receipts+47 unchanged historical gaps. No new failed timeline outcomes. The previously closed Lora-2 seq1640 is not reopened.

C2b:asOf 2026-09-14T23:11:12.891858+00:00. Only read timestamps changed:99 tracked fans and198 valid checks/receipts per endpoint; no new independent daily sweep, qualification remains1of2. Daily checkpoint remains2026-09-14T10:53:41.787+00:00. Transition13September remains excluded; scope_complete=false, no quiet-correction/max-age or savings acceptance. Server identity asOf is179ms later than the local command completion clock; no cross-clock latency is inferred.

## Runtime and configuration

Read-only Docker evidence at23:09UTC: image32c80a117e2a, source label6e07620ab5b9; three roles healthy/restarts0, starts22:12:41–22:12:52UTC.17,291,509,760 bytes available,80% used. This PR200 runtime was already reported in the interactive handoff. Original deployment fields/clocks remain historical. Ordinary Docker health is not the protected deployment gate.

The first combined Docker source-template command emitted a parsing error even though the shell ended0 at df. Its stderr is preserved; source comes from the separate successful correctly quoted image-only read.

Chrome controller2 is unavailable; current browser inventory has only the in-app browser. No alternate authentication/browser or credential extraction was attempted. Current desired flags, override versions, per-role reported values and applied versions are unknown; last successful configuration evidence remains historical. No flag-off event is established and no clock is reset.

Bounded current-worker log scope begins at its22:12:52 start; earlier removed containers are uncovered. Exact warning counts: {"DM shadow material check unavailable; full sweep continues": 0, "DM shadow report could not persist; the full sweep continues": 0}. These counts do not repair historic sink/unknown coverage.

## Evidence and review

- A0 export: /Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/activation/20260910T225618Z/snapshot-20260914T230836Z.
- C1 export: /Users/dmitriy/code/goose/hub/investigations/fansly-c1-deploy-2026-09-11/followup-20260914T230836Z.
- C2b export: /Users/dmitriy/.codex/worktrees/hub-fansly-c2b-shadow/investigations/fansly-c2b-earnings-shadow-2026-09-10/activation/20260912T233234Z/observation-20260914T231110Z.
- [Independent A0 review](REVIEW-A0.md); [independent C1/C2b/runtime review](REVIEW-C1-C2B.md). Raw JSON, original failed attempts, SQL/role/hash/pagination receipts are retained.

Notification: new Lilly-1 A0 reader discrepancy. No production mutation or request to the provider. No observation report is marked delivered: A0 calendar point remains17September22:58:33.610UTC and C2b still needs its second qualifying walk. The shared heartbeat remains active.
