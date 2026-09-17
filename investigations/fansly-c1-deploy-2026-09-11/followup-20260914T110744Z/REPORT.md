# C1 cumulative observation — 14 September 2026, 11:07 UTC

C1's stage diagnosis is unchanged. The exhausted timeline contains **2,937
ordered unique runs** through **749100**; all **2,845** prior rows are unchanged.
The **92 new rows** comprise 36 valid incremental decisions, 53 partial reconcile
chunks and three successful exact-generation terminals. No new failure, invalid
receipt, missing terminal receipt or OR combination appears.

The original window stays **2026-09-11T01:05:57.089215Z** through
**2026-09-14T11:07:44.958433+00:00**; collection completed at **2026-09-14T11:08:08.993552+00:00**.
Six exports used the unchanged reviewed reader, SHA-256
75bf0c1b841d26cdea469d3f39dd238f7817fdd1d8ed721f57c99f6d86abdf3f. Each uses an explicit
REPEATABLE READ, READ ONLY transaction with a 20-second statement timeout and
40-second subprocess deadline. All raw receipts confirm read_only and read-only
mode; isolation is explicit in SQL, not separately echoed by the receipt.

| Page | Records | asOf UTC | after → next |
|---|---:|---|---|
| 1 | 500 | 2026-09-14T11:07:46.746512+00:00 | 0 → 727169 |
| 2 | 500 | 2026-09-14T11:07:52.457666+00:00 | 727169 → 731728 |
| 3 | 500 | 2026-09-14T11:07:56.453072+00:00 | 731728 → 736301 |
| 4 | 500 | 2026-09-14T11:08:00.075865+00:00 | 736301 → 740790 |
| 5 | 500 | 2026-09-14T11:08:03.665653+00:00 | 740790 → 743572 |
| 6 | 437 | 2026-09-14T11:08:07.25483+00:00 | 743572 → exhausted |

First-page throughRunId and the window remain fixed; returned cursors drive
pagination. Report and manifest hashes, raw equality, role/mode, counts, ordering,
uniqueness and exhaustion were verified. Every selected run starts in the window
and finishes by its cutoff. Each page is atomic; the whole six-page timeline
is not. Exhaustion proves retained-row delivery, not provider completeness.
See [collection](collection.json), [manifests](timeline-pages.json),
[summary](summary.json) and the [92 new rows](new-rows.json).

Of **571 incremental runs**, **493** have valid final decisions: **376 no-request,
110 count-mismatch only, and seven count-mismatch plus exhausted-without-known**.
The other five OR combinations remain unobserved. New decisions split into
**33 no-request and three mismatch-only requests**. First-page aggregate decision
counts agree with the drained timeline; exported count, OR and queue increment
arithmetic agree. Hidden checkpoint identity/encounter predicates are not exported
and were not reconstructed.

All **117 requests** have known queue receipts and exactly one later successful
terminal for the same page and requested revision, with exact-generation proof.
Pending at request remains **0/117**; this is not current queue state or coalescing
savings. The other nine successful terminals are scheduled reconciles.

The same **78 incremental runs** lack a final receipt: **77 partial chunks and
one historical failed run**. No new partial incremental chunk was added; partial
is neither failed nor no-request. Invalid/duplicate decisions and unknown
request-queue receipts remain zero. Across **126 successful reconcile terminals**,
**79** have valid membership receipts; the same **47 historical gaps** remain
(44 pre-instrumentation and known writer-boundary runs 733622, 733859, 734003).
One older nonterminal receipt brings valid membership receipts to 80. All three
new terminal receipts are valid, and no non-destructive completion appears.

The new terminals sum to **two actual-deactivation occurrences and one grace-only
occurrence**. Lora-3 generation 786 retires one candidate and has five later
matching no-request comparisons. Lora-1 generation 1233 protects one row; generation
1234 records one actual deactivation, followed by two matching 9,476/9,476 no-request
comparisons. These separate observations do not identify the same relation across
generations, measure atomic active-after state, or establish equivalent presence.
The closed Lora-3 generation 775/776 case remains unchanged; no targeted read or
historical reinvestigation was performed.

| Cumulative source / stream | Physical attempts | Retry ordinals | Attempts with unknown bytes |
|---|---:|---:|---:|
| anomaly/followers_reconcile | 10,632 | 23 | 265 |
| scheduled/followers_reconcile | 841 | 1 | 19 |
| scheduled/followers | 1,396 | 8 | 501 |

Only the **first-page aggregate** contributes: **12,869 attempts**, 32 retry
ordinals, zero failed/429 outcomes and 785 attempts with unknown bytes. Attempt
states are 12,837 success and 32 retry outcomes. The cumulative difference is
**+344 attempts** (272 anomaly reconcile and 72 incremental), with no extra retry
ordinal or failed/429 outcome, and 42 additional unknown-byte attempts. These
differences are not a separately queried interval, per-revision attribution or
savings measurement. Follower HTTP coverage has 2,937 runs and zero known
unknown/boundary/unrecorded/unfinished counters. Snapshots and repeated aggregates
are not added together.

PR166 remains **merged**, as established by the retained final receipt; its
diagnostic publication does not accept a suppression/presence policy or prove
a deployment. No GitHub, Git, code, test, provider/socket, forced sync, recovery,
flag, deployment or automation change occurred. Six exports succeeded; the
database lane was released immediately afterward.

The coordinator owns [runtime/configuration evidence](../../fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260914T110644Z/REPORT.md).
Historical owned deployment checks are separate from the current protected gate.
Presence equivalence, safe suppression, causal savings and event-to-reader latency
remain unproven. Independent numerical review is pending.

## Independent review completion

2026-09-14T11:21:40.240910+00:00 — [Independent review](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260914T110644Z/REVIEW-C1.md) passed with no actionable findings. Numerical evidence and original clocks are unchanged. The earlier pending marker is the retained author snapshot; this completion supersedes it. No final bounded report delivery or stage acceptance.
