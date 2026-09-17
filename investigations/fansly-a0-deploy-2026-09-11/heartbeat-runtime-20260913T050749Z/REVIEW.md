# Independent heartbeat evidence review — 13 September 2026, 05:07–05:09 UTC

Verdict: no open actionable findings in the reviewed observation package. Recommendation: DONT_NOTIFY. The new receipts extend the existing diagnosis without changing an operational action or acceptance gate.

Review scope: local raw reports, read identities, execution receipts, manifests, summaries and current sections of A0 STATE/REPORT/SHADOW-OBSERVATION/PROGRESS, C1 STATE/REPORT, and C2b stage/activation STATE and reports. No tests, production/provider/UI calls, source inspection, Git operations or central-state edits were performed by this reviewer. Only this review file was written.

## Evidence binding

- A0 snapshot: [snapshot-20260913T050855Z/report.json](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/activation/20260910T225618Z/snapshot-20260913T050855Z/report.json), SHA-256 `13b599a417063a4766e023a144fbf4ad4cf5c5bdae783c70cf836f465f22522e`. The manifest count/hash and original read receipt match the normalized report. The preceding 00:15 report hash was independently checked.
- C1 export: [collection.json](/Users/dmitriy/code/goose/hub/investigations/fansly-c1-deploy-2026-09-11/followup-20260913T050808Z/collection.json). All four report, manifest-file and read-receipt hashes match the collection/summary; each original receipt equals its normalized report. Cursor pages use one fixed window and upper ID 740027.

| C1 page | Rows | Report SHA-256 |
|---|---:|---|
| [page-1](/Users/dmitriy/code/goose/hub/investigations/fansly-c1-deploy-2026-09-11/followup-20260913T050808Z/page-1/report.json) | 500 | `411005e23140493cc129f0bafb08ca15f295e41a475fce1f0960ce87e957e8ba` |
| [page-2](/Users/dmitriy/code/goose/hub/investigations/fansly-c1-deploy-2026-09-11/followup-20260913T050808Z/page-2/report.json) | 500 | `56018e587d81f3de6779d0cbbccb7bd0e8ddce2d4296848c0a80f07f90e23084` |
| [page-3](/Users/dmitriy/code/goose/hub/investigations/fansly-c1-deploy-2026-09-11/followup-20260913T050808Z/page-3/report.json) | 500 | `8b6665bb151f8f58c06aff21fdd6265db3c489c5b82ebe2fda160bafc2a59b4a` |
| [page-4](/Users/dmitriy/code/goose/hub/investigations/fansly-c1-deploy-2026-09-11/followup-20260913T050808Z/page-4/report.json) | 333 | `6ee751e5591a23c0d0513608946dbac86320e97af0f75c424c95d2993b6ff90a` |

- C2b read: [read.raw.json](/Users/dmitriy/.codex/worktrees/hub-fansly-c2b-shadow/investigations/fansly-c2b-earnings-shadow-2026-09-10/activation/20260912T233234Z/observation-20260913T050954Z/read.raw.json), SHA-256 `c4e627227d1e078ceefed151ce7d3722830cfb3616e4d3f85c2c2f8b296a7c0a`, matches execution.json. READ ONLY / repeatable read / read_only identity and unchanged bounded SQL agree with the preceding 00:20 read.
- Runtime: [runtime.json](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260913T050749Z/runtime.json), SHA-256 `6320a829e16d265043d1249cb1629fae52b470eeeb97e33dc5b9a256adf6a668`. Parsed Docker stdout agrees with this file; image, source label, start times and restart counts agree with the prior 00:15 receipt.
- Worker tail: [worker-log.stdout](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260913T050749Z/worker-log.stdout), SHA-256 `2e1e5b392c484466e86f516a3e7b86c14c13e388dc0b0d87e3edc20a4b943542`. Independently parsed 3,000 records with zero malformed lines.

## Confirmed results and limits

A0 has 641 unique sweep rows: 400 complete, 241 incomplete and zero selected running rows. All 58 new rows are complete; the only two changed old rows are Lora-1 G4841 and Lora-3 G7652 completing. The other 581 old rows are unchanged. This is a non-atomic cumulative export, not a census or two additive cohorts.

Lilly-2 G6838 has one state-change and one exclusion-reason occurrence below stop, with no thread/value/direction attribution. Lilly-1 G7409 and Lilly-2 G6836 add three flags occurrences. The six added reason fields are each known on 102 rows (97 complete, five incomplete), absent on 538 and null on one. Unknown material remains 403,215; Lora-1 G4830 remains 2,364 runtime head/rollback occurrences with the previously documented one-occurrence raw/runtime gap. No new message-loss, freshness or savings conclusion follows.

A0 attempts total 72,568; retry ordinals 3,217, failed attempts 1,037, HTTP 429 zero, unknown byte counts 5,064. The increase of 385 failed attempts is entirely in existing media_offer_stats HTTP 500 buckets. HTTP coverage retains six unknown runs and three boundary runs; DM coverage retains one unknown and eight lost-report runs. New scheduled fan_earnings unknown buckets on Lora-2/Lilly-2 are explicit. Net aggregate changes do not explain individual receipt lifecycles or form a frozen new attempt interval.

C1 has 1,833 ordered unique runs and all 1,710 previous rows are unchanged. The 123 additions are 30 incremental decisions, 90 partial reconcile chunks and three exact-generation terminals. Of 313 valid decisions, 245 request no work and 68 have clean prior queues with exactly one later page/revision terminal; OR/count arithmetic agrees with exposed fields. Forty-seven historical terminal membership receipts and 38 incremental decision receipts remain missing.

The three new C1 terminals separately show grace protection and actual retirement: Lilly-2 G795 candidates/retired 0/0, Lilly-2 G796 1/1, and Lora-2 G1589 0/0; each has one grace-only protected row. No same-row identity across generations or immediate active-after measurement is exposed. The first-page follower aggregate has 7,950 attempts, 26 retry ordinals, zero failed/429 attempts and 495 unknown byte counts. Four repeatable snapshots are not one atomic timeline; repeated page aggregates are not summed.

C2b is unchanged after removing the report timestamp: endpoints/outcomes empty, unknown attribution zero, tracked_scope_complete=false, last daily completion 12 September 10:53:28.495 UTC before activation, and zero qualifying post-enable sweeps. Empty scope does not establish missed-correction coverage. Server statement time and client completion time remain separately recorded clock domains.

All three roles are healthy with zero restarts on source label 380326368fe3 / image c443947a3569. Docker labels are not a new compiled-source or protected-deployment-gate verification. Disk has 18,417,344 KiB available (17.56 GiB), 78% used. The ordinary health result is ok; 11 ms is checks.database.latencyMs, not measured API request latency.

The worker tail spans 01:13:35.471–05:07:50.722 UTC despite --since 00:15 because of --tail 3000. Zero warn/error records match the shadow/material/persist/diagnostic filter; this is not zero warnings or complete historical coverage. Two OnlyFans chargeback errors say list page continuation unavailable. The same message/category is retained in 11 and 12 September logs; these rows do not establish a new Fansly incident or resolution of the existing OnlyFans condition.

The current selected Chrome browser was unavailable. The 01:00:36–41 visible allowlist receipt remains historical; fresh effective configuration, per-role acknowledgements and uninterrupted continuity remain unverified. No clock resets: A0 began 10 September 22:58:33.610 UTC, earliest seven-day point 17 September 22:58:33.610 UTC; C2b all-role confirmation remains 12 September 23:38:22.888 UTC. Two qualifying independent C2b sweeps still need start/order and continuity evidence.

A0 early-stop remains NO-GO. Positive A0/A1 acceptance, C1 suppression/presence equivalence, C2c quiet-correction/max-age/cost acceptance, savings and fresh-event latency remain open. Calendar age and ordinary health do not pass these gates.

## Closed documentation finding

The activation C2b report had a second Latest observation heading pointing to 00:20 beneath the correct 05:09 introduction. It now labels that block Historical observation at 00:20 UTC and removes the stale below reference. The dated evidence is retained; the ambiguity is closed. The A0 report also correctly calls its 641 rows the entire cumulative cohort and distinguishes the coordinator’s read from the analyst’s local work.

Current documents are consistent with these retained observations. Review-completion pointers may be updated separately by the coordinator; this review does not authorize or perform an operational change.
