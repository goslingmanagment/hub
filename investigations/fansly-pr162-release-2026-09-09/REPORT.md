# PR162 deployment and Fansly migration status

PR162 is deployed to API, worker and scheduler. Every previously approved
retained reply replay has completed successfully. All six original reply
cohorts have passed: 994/994 IDs and 27 attached messages. Current known-head
recovery remains separately gated; no recovery flag or A0/T0 clock has started.
Current evidence: 9 September 2026, through 21:20 UTC (10 September Moscow).

## PR and validation

[PR162](https://github.com/goslingmanagment/core/pull/162) scopes the chatless
cold-tombstone lookup to the current platform and OFAPI binding. Production is
`8b25d57e5d1343271177426ee9caf644cb1ee5c0`, the independently reviewed tree.
Decision 282 and the reply runbook update are included. No flag, schema, index,
timeout, dependency or privilege change was introduced.

- Before opening the PR, `pnpm check` passed: 3110 tests in 280 files,
  9 existing skips, lint/dashboard build, unchanged strictness budget.
- Five real Docker-Postgres suites passed 122 tests with zero skips: platform
  and binding isolation, chatless tombstones, version/source precedence,
  counts, windows/keysets, purchases, authentication and Read Plane evidence.
- The independent reviewer reran two focused Postgres files: 5 tests,
  zero skips. Findings were fixed; final review has no outstanding findings.
- All five final-head CI checks passed in
  [run 34386000613](https://github.com/goslingmanagment/core/actions/runs/34386000613).
  Production build passed before PR creation and at the exact merged revision.

## Deployment

The owner's “Да деплой на все” approved this revision on all three roles.
The first candidate build failed in BuildKit before runtime changes. A single
same-revision retry used the unchanged deployment gates and completed at
19:06:20.644854 UTC, exit 0. No image garbage collection ran. The previous
PR161 image is retained for an independently approved rollback.

All roles were verified healthy at 21:16:01, with zero restarts, 29 GiB free
(64% used), and loopback health reporting DB latency 20 ms. Their image is
`sha256:893cc4cc7fd2fadfd0afa204dd10c188b62449201adf4e668c7c1e2fd597a513`.
The production-pinned Hub CLI was rebuilt at the same revision and passed its
capability/contract checks. The authenticated Configuration DOM at 20:57 shows
running/editor catch-up `none`; no edit occurred. Its numeric config version
is not exposed by the UI, so no numeric version is invented in this report.

The sync-health deployment gate remains slow: three 150-second client timeouts,
then HTTP 200 in 144.240 seconds on the fourth request. This is unresolved.
The local benchmark (300000 unrelated cold rows visited to zero;
EXPLAIN 29.017 to 0.550 ms) is not production latency or a savings measurement.
Evidence: `evidence/retry-1/`, `runtime-final.txt`,
`sync-health-requests-final.json`, and the five-page runtime evidence.

## Reply repair

| Page | Original observations at v6 | Full page acceptance | Attached messages checked |
|---|---:|---:|---:|
| ari-1 | 128 | 9/9 | 0 |
| lora-3 | 31 | 54/54 | 1 |
| lora-2 | 43 | 63/63 | 2 |
| lora-1 | 170 | 143/143 | 1 |
| lilly-2 | 826 | 409/409 | 13 |
| lilly-1 | 1695 | 316/316 | 10 |

All 2893 original observations were confirmed v6 in timestamped per-page
censuses with no unavailable body. All 994 positive target IDs are present,
and every normalized text/media check passes, including all 27 attached
messages. **All 994 original positive targets are now accepted.**
These are retained exact-ID proofs with their own timestamps, not an atomic
snapshot, complete threads, explicit-clear coverage or a fresh-event percentile.

The three lora-1 reads blocked before PR162 passed after deployment in
5.725, 2.965 and 1.785 seconds including CLI overhead. The full 143-ID gate
passed at 19:09:02 with a fresh 170-observation source census. No replay was
repeated. Ari's original nine IDs freshly passed at 19:16–19:17.

Lilly-2's single replay ran 19:12:03–19:30:18: 1094.234 seconds, 826
scanned/stamped, 9963 appended and 14127 deduplicated; zero errors/skips,
binding/partition blockers or truncation. One later serving request failed
at transport; after health recovery only unmatched/unread groups continued.
After ordinary archive passes at 19:57, all 409 parent/root checks passed by
20:02:55; all 162 source/material checks passed at 20:03:31. Acceptance was
recorded at 20:03:55. The sampled historical repair bound is **50m52s from
write start**, or 32m38s after write finish.

Lilly-1's single replay ran 20:08:45–20:36:30: 1665.770 seconds, 1695
scanned/stamped, 14192 appended and 22783 deduplicated; zero errors/skips,
binding/partition blockers or truncation. All 1695 were confirmed v6 at
20:37:46. Full serving/material passes retain all 316 IDs and 112 exact
source receipts. Eight original mismatches fell to five, then three, then zero.
All 316 parent/root links passed by 21:15:25; the full 112-source material
comparison passed at 21:16:03, and acceptance was recorded at 21:16:10.
The sampled historical repair bound is **66m40s from write start**, or
38m54s after write finish. Original mismatches and each intermediate pass are
retained. The same corrected canonical output was eventually observed in
serving without any repeated replay or privileged production query.

All six original diagnostic examples passed fresh serving at 20:53:47 and
material comparisons at 20:54:14–20:54:41, including the previously populated
Lilly-2 parent. See the five-page operation's `evidence/diagnostic-six/accepted.json`.
The separate material comparator v2 fixes only null replyMetadata versus a
null root; missing-message/non-null-root negative guards remain. The [final independent review](../fansly-five-page-reply-replay-2026-09-08/FINAL-REVIEW.md)
confirmed the complete 994-ID/27-attachment union without findings. The acceptance
helper additionally requires the full original material ID set and replay exit 0.
Its local positive/negative guard checks passed. The original evidence is retained.

## Known heads and current queue

The independently reviewed original embedded-head corpus has 7422/7427 IDs
captured in retained message bodies through 18:09:10 UTC: Lilly-2 5615/5615,
Lilly-1 1667/1671, Lora-1 42/43, Lora-2 21/21, Lora-3 13/13, Ari 64/64.
Selected recovered Lilly-2 heads and the original recovered Ari target were
also confirmed in the archive. This is not an all-head archive census and is
not evidence that the head-recovery flag was active.

Four original Lilly-1 IDs remain visible, resolved and unexcluded, with zero
recovery attempts. The Lora-1 gap retains its partner-missing exclusion.
Ari's separate target 953208142580178944 is still pending after four attempts.
Its retained list advertises that ID but embeds explicit `lastMessage:null`;
its exact message receipt contains 953195879781658624 instead. No alternate
message/bulk ID was present. This is a provider-marker discrepancy, not proof
of deletion or aliasing. The debt remains open. Exact ordinary read_only
receipt queries succeeded without raising the 5-second timeout or bypassing roles.

At 21:20:18 the mutable Lilly-2 queue has **112 pending heads**: 93 hidden,
11 other excluded and **8 eligible**; none exhausted. Eight current eligible
IDs were frozen independently. All eight bounded Hub reads lacked the exact
ID, and no Lilly-2 DM observation exists in the declared 19:00–23:00 source
window as of that read. The earlier fixed 5615-head success does not make this
current queue empty. At 20:56 all 12 Fansly DM states had no failure streak or
blocker, but Lilly-2's last successful full list/DM completions were 18:13/15:41;
those success clocks are not current materialization proof.

The [60-minute Lilly-2 canary proposal](../fansly-lilly2-head-canary-2026-09-10/PROPOSAL.md)
is prepared with frozen targets, baseline, exact flag scope, existing budgets,
rollback and abort criteria. It has not been activated. The
preceding reply gate passed at 21:16:10; it still requires a separate explicit
owner yes for activation plus
return to `none`. Refresh the mutable baseline before any approved activation.

Evidence: `fixed-head-capture-result.json`, `head-report-final.txt`,
`head-eligibility-final.txt`, `dm-stream-state-final.txt`,
`ari-head-marker-discrepancy-fixture.json`, the canary's `evidence/baseline.txt`,
and [independent raw-cohort review](../fansly-pr162-review-2026-09-09/FIXED-COHORT-REVIEW.md).

## Latency, requests and remaining gates

Archive ticks completed at 19:57 with logged durations 2677.675, 1777.821
and 884.348 seconds. These passes overlap; their event counts must not be
summed as unique work. Later canonicalization sweeps still take 10–13 minutes,
and projection/backlog alerts remain. These are unresolved performance issues;
healthy processes and repaired historical examples do not prove fresh data.
The prepared five-ID privileged probe was never executed and was superseded
by successful ordinary Lilly-2 serving reads.

Completed worker summaries from 20:00:03–20:59:17 contain 368 distinct
page/stream/run IDs, 1402 Fansly HTTP attempts, 29 retries and zero terminal
failures. Retried transport/HTTP failures are present; zero terminal failures
must not be reported as zero errors. Lilly-2 has 82 list attempts (9 retries)
and no completed DM summary in that window. These bounded logs are not the
T0 attempt-table baseline, a complete canary total or a before/after saving.
The 994-ID repair added no manual Fansly history refetch; runtime CLI bootstrap
still performs its existing OFAPI whoami preflight and proof write.

| Stage | State | Measurement / next gate |
|---|---|---|
| Pre-A0 stale follow-up / Lilly-2 queue | PR157 deployed; Ari canary rolled back; current recovery off | Original Lilly-2 5615/5615 raw; 8 new eligible heads; separate bounded canary approval |
| Pre-A0 reply links | PR158–162 deployed; original bounded corpus accepted | 994/994 IDs, 27 attached messages; Lilly-2/Lilly-1 historical repair bounds 50m52s/66m40s |
| A0 + T0 | Not started | Actual pre-A0 exit, retained offline corpus, default-off shadow/report; then >=7 full days on all six pages and physical baseline |
| C1 | Not started | Three anomaly-trigger counts before the separate narrow followers fix |
| C2a | Not started | Earnings identity/replay/stale ordering and retained repair |
| C2b | Not started | Semantic dirty/receipt shadow with daily rotation retained |
| C2c | Gated | Coverage, costs and per-fan max-age before selection/rotation change |
| W0 | Not started | Offline fixtures; Management Session live probe needs approval |
| B0 | Gated by W0 | Capture-only receiver, >=7 days and sufficient event variety |
| B1 | Gated by B0/T0 | Added attempts, delivery lag and history fairness |
| A1 | Owner/calendar/evidence gated | No default freshness degradation; separate explicit yes |
| B2 | Not authorized | Separate decision, only if B1 measurements justify it |

No HTTP savings or fresh-event latency distribution has been measured; the
>=50% goal is not claimed. Uncovered: current
known-head recovery and marker ambiguities, full-thread completeness, explicit
clears/later edits/deletions, quiet-state freshness, outage gaps, retained media
file availability and Management Session socket scope. The migration is unfinished.
