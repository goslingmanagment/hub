# PR162 deployment and Fansly migration status

PR162 is deployed to all three production roles. Lora-1 and Lilly-2 have passed
their complete retained reply cohorts. The already approved Lilly-1 replay is
running; no new flag, socket probe or head-recovery activation has occurred.
Latest operational snapshots: 9 September 2026, 20:04–20:11 UTC.

## PR, validation and deployment

[PR162](https://github.com/goslingmanagment/core/pull/162) fixes the chatless
cold-tombstone lookup by resolving the page's OFAPI binding once and constraining
the lookup by platform and account. The merged revision is
`8b25d57e5d1343271177426ee9caf644cb1ee5c0`. The clean deployed tree equals the
independently reviewed final tree. Decision 282 and the runbook update are included.
No flag, schema, index, timeout, dependency or runtime privilege changed.

Before PR creation, `pnpm check` passed 3110 tests in 280 files, with 9 existing
skips; lint, dashboard build and the unchanged strictness budget passed. Five
real Docker-Postgres suites passed 122 tests without skips. They cover platform
and binding isolation, chatless tombstones, version/source precedence, counts,
windows/keysets, purchases, authentication and Read Plane evidence. The independent
reviewer reran two focused Postgres suites:5 tests,0 skips. Its findings were
fixed. All5 final-head CI checks passed in
[run34386000613](https://github.com/goslingmanagment/core/actions/runs/34386000613).
Production build passed before the PR and on the exact merged revision.

The owner's `Да деплой на все` authorized deployment of this reviewed revision
to API, worker and scheduler. The first candidate build failed inside BuildKit
before production runtime changes. Logs and resource checks were saved; a single
same-revision retry used the unchanged normal deployment gates and rollback.
That retry completed at 19:06:20.644854 UTC, exit0. No image garbage collection
ran, and the previous image remains available for an approved rollback.

At20:04:36 all three roles were healthy with 0 restarts on image
`sha256:893cc4cc7fd2fadfd0afa204dd10c188b62449201adf4e668c7c1e2fd597a513`.
Disk had29 GiB free (64% used); loopback health passed with DB latency18ms.
The production-pinned Hub CLI is built from the exact merged revision and its
contract validation passed. The authenticated Configuration DOM still showed
catch-up `none`; no edit occurred and its config version was not exposed.

The sync-health deployment gate remains slow: three 150-second client timeouts
preceded HTTP200 in 144.240 seconds on the fourth request. This latency is
unresolved. PR162's local benchmark (300000 unrelated cold rows visited to0;
EXPLAIN29.017 to0.550ms) is not a production percentile or cost forecast.
Evidence: `evidence/retry-1/`, `runtime-after-deploy.txt`,
`sync-health-requests-final.json`, and the five-page operation's latest runtime read.

## Reply repair acceptance

| Page | Original observations at v6 | Positive targets accepted | Attached messages |
|---|---:|---:|---:|
| ari-1 | 128 | 9/9 | 0 |
| lora-3 | 31 | 54/54 | 1 |
| lora-2 | 43 | 63/63 | 2 |
| lora-1 | 170 | 143/143 | 1 |
| lilly-2 | 826 | 409/409 | 13 |
| lilly-1 | Replay in progress,1695  original observations | Pending,316  original targets | 10 pending |
| Total accepted | — | 678/994 | 17/27 |

Each accepted page preserves its original full ID cohort. Matching fields are
archive source, parent/root, canonical parent/root, normalized text, media count,
stable media metadata and direct raw media refs. All exact source receipts used
for comparison are v6. Earlier successful reads keep their timestamps; these
are retained positive proofs, not one atomic snapshot or complete threads.
Coverage blockers and limitations for later changes/clears are preserved.

The three lora-1 reads blocked before PR162 passed after deployment in 5.725,
2.965 and 1.785 seconds including CLI overhead. The entire143-ID gate passed
at 19:09:02, after a fresh170-observation source census. No lora-1 replay was repeated.
Ari's9  original IDs were freshly verified again at 19:16–19:17.

Lilly-2's one approved replay ran19:12:03.941–19:30:18.164 UTC:1094.234s,
826 scanned/stamped,9963 appended,14127 deduplicated, zero errors, missing bodies,
unmapped/unparseable rows, partition or binding blockers, and no truncation.
All826 were independently confirmed v6 at 19:31. One serving request later failed
at the transport layer; subsequent health checks passed. Only unmatched/unread
groups were continued, with all original 409 IDs retained.

Five roots and four normalized-text values lagged behind the completed replay.
After ordinary archive passes completed at 19:57, all 409 parent/root pairs passed
at 20:02:55.861. The full162-source material check passed at 20:03:31.350, including
all 13 attached messages, and page acceptance was recorded at 20:03:55.139.
The confirmation bound is50m52s from replay start, or32m38s after replay finish;
this is a historical repair bound, not fresh-event latency.

Worker logs record archive/tick durations2677.675s,1777.821s and 884.348s with
completions close together. The passes overlap in time; their event counts must
not be summed as unique work. Other projections were skipped by those ticks
and later ran. The long archive pass is an unresolved performance concern.
A prepared five-ID privileged diagnostic became unnecessary after ordinary
serving proof passed. It was never executed in production.

One local comparator incorrectly distinguished null replyMetadata from a null
nested root. The separate `check-material-v2.mts` normalizes only that nullable
representation and retains negative guards for missing rows/non-null expected
roots. Original evidence remains available. This is semantic root parity, not
proof of field clocks or later explicit clears.

Lilly-1's fresh preflight found all 1695  original pull observations at v5 with
available bodies and attached partitions. Its preview passed in 94.859s with
35280 draft events and no blockers. A second preflight passed at 20:08:43.144;
one approved replay began20:08:45.025. At20:11:16,59 observations were v6 and
1636 remained v5. Serving acceptance of all 316 IDs follows the terminal replay
result; the process must not be restarted merely because a tool wait yields.

Detailed evidence and dispatch guards:
[reply operation](../fansly-five-page-reply-replay-2026-09-08/REPORT.md),
its `evidence/operation-status.json` and each page's `accepted.json`.

## Known-head prerequisite

The independently reviewed original 7427-head corpus was matched against8939
retained message observations through 9 September18:09:10.055267 UTC. No inspected
body was unavailable. This proves raw capture, separately from serving acceptance:

| Page | Original heads captured | Missing |
|---|---:|---:|
| lora-1 | 42/43 | 1 |
| lora-2 | 21/21 | 0 |
| lora-3 | 13/13 | 0 |
| lilly-1 | 1667/1671 | 4 |
| lilly-2 | 5615/5615 | 0 |
| ari-1 | 64/64 | 0 |
| Total | 7422/7427 | 5 |

Three selected recovered Lilly-2 heads and the recovered ari head were also
found in the archive through ordinary Hub reads. These are selected serving
proofs, not an all-head archive census or attribution to recovery activation.
At20:11:17 Lilly-2 had0 eligible unresolved debts,104 total uncaptured debts,
and 0 exhausted IDs. Excluded/hidden/unresolved-identity rows are not silently
counted as recovered. Other pages had eligible counts ari1, Lilly-1 4, Lora-1 11,
Lora-2 1 and Lora-3 1; live debt and the original frozen corpus are different scopes.

At20:10, the five original raw gaps were still unconfirmed: four visible,
identity-resolved, unexcluded Lilly-1 heads with 0 attempts, plus one Lora-1 head
excluded for `partner_missing_from_aggregation_accounts`. None is called deleted.
Ari head953208142580178944 remains unresolved after 4 attempts, outside the
original 7427-head corpus. At its timestamp the archive returns953195879781658624;
exact retained observation2286645 confirms that different ID. No alternate bulk
or broadcast ID appeared in that source message. Alias/deletion is not established. An exact retained list read additionally
confirmed that `data.lastMessageId` advertises953208142580178944 while the
same group's embedded `lastMessage` is explicitly null. A control group has
matching list and embedded IDs. This classifies a provider-marker discrepancy
without closing the debt or calling it a deletion. See
`evidence/ari-head-marker-discrepancy-fixture.json`.
The original failed5s query was preserved; a1ms metadata lookup and one exact-body
read succeeded with the same role/timeout. No role exception was used.

See `evidence/fixed-head-capture-result.json`, `head-eligibility-after-lilly2.txt`,
`missing-head-classification-after-lilly2.txt`, `ari-head-identity-status.json`,
and the [independent raw-cohort review](../fansly-pr162-review-2026-09-09/FIXED-COHORT-REVIEW.md).

## Stage state and remaining scope

| Stage | State | Measured result / remaining gate |
|---|---|---|
| Pre-A0 known-head debt / Lilly-2 queue | PR157 deployed; final acceptance synthesis pending | Lilly-2  original raw5615/5615; selected archive proofs; unresolved cases itemized |
| Pre-A0 reply links | PR158–162 deployed; final Lilly replay complete; eight reply mismatches remain | 678/994 accepted; Lilly-2 repair bound50m52s; all 316 IDs/text/media found; eight reply mismatches remain; six diagnostics passed |
| A0 + T0 | Not started | Pre-A0 exit, retained offline corpus, default-off shadow/report; then >=7 full shadow days on all 6 pages and physical-attempt baseline |
| C1 | Not started | Three anomaly-trigger counts before narrow followers fix |
| C2a | Not started | Earnings identity correctness, replay and stale-after-fresh; retained repair |
| C2b | Not started | Semantic dirty/receipt shadow; daily rotation retained |
| C2c | Gated | Coverage, costs and per-fan max-age before selection/rotation changes |
| W0 | Not started | Offline fixtures, then separately approved Management Session live probes |
| B0 | Gated by W0 | Capture-only receiver; >=7 days and sufficient event variety |
| B1 | Gated by B0/T0 | Added attempts, delivery lag and history fairness |
| A1 | Separate owner/calendar/evidence gate | A0/T0 stop contract and measured freshness; no default degradation |
| B2 | Not authorized | Separate decision; only if B1 evidence justifies it |

No physical HTTP savings or fresh-event latency distribution has been measured;
the >=50% goal is not claimed. Still uncovered: eight Lilly-1 reply mismatches and long archive passes, unresolved known-head identities, full-thread
completeness, quiet-state freshness, old edits/deletions, outage recovery and
Management Session socket scope. Provider-deleted-head repair remains outside
A0; its shadow only counts that discrepancy. The complete migration goal remains
unfinished. No A0/T0 clock, A1 or B2 advancement occurred.

## Acceptance refresh — 9 September 20:54 UTC

The single Lilly-1 replay completed at 20:36:30 UTC: 1695 observations at v6,
14192 appended, 22783 deduplicated, 1665.770 seconds, zero errors/skips/blockers.
The full 316-ID first serving pass completed at 20:46:47; the retained source
comparison at 20:52:24 confirms every ID/text/media (10 attached messages),
but seven parents and eight roots still differ across eight messages. No repeat
replay or privileged production probe has run. All six original diagnostic
examples freshly passed serving/material checks at 20:53–20:54, preserving
the existing Lilly-2 link. Full page acceptance remains 678/994; another 308
Lilly-1 targets have complete positive material checks, and eight are open.

The new head report at 20:53:39 shows Lilly-2 pending debt of 112 (93 hidden),
up from the prior timestamped 104. This mutable queue is separate from the
original fixed 5615/5615 raw capture proof and must not be described as empty.
The exact eligible/excluded split is being refreshed.
