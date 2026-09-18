# C1 cumulative observation — 14 September 2026, 05:11 UTC

The exhausted timeline contains **2,845 ordered unique runs** through `747772`.
All **2,604** prior rows are unchanged. The **241 new rows** contain 36 valid
incremental decisions, 18 partial incremental chunks, 177 partial reconcile
chunks and ten successful exact-generation terminals. No new failure, invalid
receipt or terminal membership gap appears. The stage diagnosis is unchanged.

The original window remains `2026-09-11T01:05:57.089215Z` through
`2026-09-14T05:11:55.543170+00:00`. Collection completed at `2026-09-14T05:12:26.244255+00:00`.
Six sequential exports used the unchanged reviewed reader, SHA-256
`75bf0c1b841d26cdea469d3f39dd238f7817fdd1d8ed721f57c99f6d86abdf3f`. Its SQL explicitly uses
`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, a 20-second statement limit,
and a 40-second local subprocess deadline. Every raw receipt confirms `read_only`
and `transaction_read_only=on`. Isolation is explicit in SQL; it is not separately
echoed by the receipt. No fallback or failed export occurred.

| Page | Records | asOf UTC | after → next |
|---|---:|---|---|
| 1 | 500 | 2026-09-14T05:11:57.400359+00:00 | 0 → 727169 |
| 2 | 500 | 2026-09-14T05:12:07.725314+00:00 | 727169 → 731728 |
| 3 | 500 | 2026-09-14T05:12:11.944713+00:00 | 731728 → 736301 |
| 4 | 500 | 2026-09-14T05:12:15.539684+00:00 | 736301 → 740790 |
| 5 | 500 | 2026-09-14T05:12:19.754969+00:00 | 740790 → 743572 |
| 6 | 345 | 2026-09-14T05:12:24.69165+00:00 | 743572 → exhausted |

The first response fixes the upper run ID; returned `nextRunId` drives each
following page with the same window. All hashes, raw/report parity, page counts,
ordered unique IDs and cursor transitions were verified. All runs start in the
window and finish before its cutoff. Each page is atomic; the six-page timeline
is **not globally atomic**. Exhaustion establishes delivery of retained diagnostic
rows, not completeness of provider facts. See [collection](collection.json),
[manifests](timeline-pages.json), [new rows](new-rows.json) and [summary](summary.json).

Of **535 incremental runs**, **457** have valid final decisions: **343 no-request,
107 count-mismatch only, and seven count-mismatch plus exhausted-without-known**.
The other five OR combinations have zero observed valid receipts, including every
unchanged-head-with-rows combination. All **114 requests** have valid clean-queue
receipts and exactly one later successful terminal for the same page and requested
revision, with exact-generation proof. Pending at request is **0/114**, not a measure
of coalescing. The other nine successful terminals are scheduled reconciles.
First-page aggregate counts agree with the fully drained timeline; exported OR,
count and queue increment arithmetic agree. Native checkpoint identity and whether
the known checkpoint was encountered are not exported; hidden equality is unknown.

The new 36 decisions comprise **27 no-request, eight mismatch-only requests and
one mismatch-plus-exhaustion request**. The last is Lora-1 run `745802`, revision
1273, after **18 partial incremental chunks** (`745712`–`745798`) advanced to 95
pages; the terminal decision records active/source **9,477/9,476**. Partial chunks
have no final decision by design. The cumulative missing-final-receipt count is now
**78: 77 partial chunks and the same one historical failed run**. This increase
is not 18 new telemetry failures or no-request results. Invalid and duplicate
decisions and unknown request-queue receipts remain zero. The OR combination is
new for Lora-1 in this cohort, but was already observed on other pages.

All ten new terminal membership receipts are valid and retain exact-generation
proof. Across **123 successful terminals**, **76** have valid membership receipts;
the same **47 historical gaps** remain: 44 pre-instrumentation and the three known
writer-boundary runs `733622`, `733859`, `734003`. One older nonterminal receipt
brings valid membership receipts to 77. No new terminal is missing its receipt.

The new terminals sum to **six actual-deactivation occurrences and five grace-only
protection occurrences**. These are occurrences across generations, not distinct
relations or proof that a protected relation was later retired.

- Lora-1 revision 1273/generation 1230 retires one candidate at 00:52:13 UTC;
  two later comparisons match 9,478/9,478 and request nothing. Later generation
  1231 protects one row, then 1232 retires one candidate. No subsequent comparison
  after 1232 is retained by this cutoff.
- Lilly-2 generations 800/801 retain two grace-protected occurrences followed by
  two actual deactivations. Ari generations 66/67 retain one followed by one.
  No later incremental comparison after the final generation in either pair is
  present. Aggregate counts do not identify the same relation across generations.
- Lora-2 generation 1598 retires one candidate. Lora-3 scheduled generation 784
  has no candidates; a later matching no-request comparison is followed by another
  mismatch and anomaly generation 785, which protects one row. These new endpoints
  have no subsequent comparison by the cutoff.

Later incremental comparisons are separate observations, not atomic active-after
measurements. The [Lora-3 generation 775/776 follow-up](../lora3-followup-20260913T000235Z/REPORT.md)
and its independent review remain closed. This cumulative export retains those
unchanged rows; it does not repeat a targeted read or reopen the case.

| Cumulative source / stream | Physical attempts | Retry ordinals | Unknown payload bytes |
|---|---:|---:|---:|
| anomaly/followers_reconcile | 10,360 | 23 | 259 |
| scheduled/followers_reconcile | 841 | 1 | 19 |
| scheduled/followers | 1,324 | 8 | 465 |

Only the **first-page aggregate** contributes: **12,525 attempts**, 32 retry
ordinals, zero failed/429 attempt rows and 743 attempts with unknown payload bytes.
Attempt states retain 12,493 success and 32 retry rows; zero failed rows does not
mean no retry or transport problem. Relative to the prior cumulative snapshot:
**+1,084 attempts** (840 anomaly reconcile, 78 scheduled reconcile, 166 incremental),
no additional retry ordinals, and 56 additional unknown-byte attempts. These are
cumulative differences, not independently queried interval costs, per-revision log
attribution, physical savings or latency. Follower HTTP coverage reports 2,845
runs with zero unknown, boundary, unrecorded or unfinished counters. Overlapping
snapshots and repeated page aggregates are not summed.

The retained [PR166 receipt](/Users/dmitriy/code/goose/hub/investigations/fansly-migration-audit-2026-09-14/followup/final-pr-receipts/pr-166.json) establishes its merge at **00:29:23 UTC**
from head `37033f41d665` into commit `b41ebbd268d9`, after five successful required
checks. This corrects the current local draft label while preserving dated history.
It publishes diagnostic implementation; it does not accept suppression/presence
policy or establish a deployment. No GitHub or Git operation occurred here.

Runtime/configuration evidence belongs to the coordinator's separate
[shared packet](../../fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260914T050824Z/REPORT.md).
No code, test, provider/socket, forced sync, recovery, flag, deployment or automation
change occurred. Historical owned deployment checks do not establish the current
protected gate. Presence equivalence, safe suppression, causal savings and
event-to-reader latency remain unproven. Independent numerical review is pending.
