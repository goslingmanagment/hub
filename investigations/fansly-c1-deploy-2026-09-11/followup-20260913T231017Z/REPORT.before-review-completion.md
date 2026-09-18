# C1 cumulative observation — 13 September 2026, 23:10 UTC

The exhausted timeline contains **2,604 ordered unique runs** through `745172`.
All **2,493** rows from the previous 17:09 snapshot are unchanged. The **111 new
rows** comprise 36 valid incremental decisions, 69 partial reconcile chunks and
six successful exact-generation terminals. Natural grace and retirement receipts
continue; no new failure, missing receipt, OR branch or acceptance result appears.

The original window starts at `2026-09-11T01:05:57.089215Z` and now ends at
`2026-09-13T23:10:17.269959+00:00`. Collection completed at
`2026-09-13T23:10:39.179678+00:00`. Six sequential pages retained the same window
and first-page upper run ID. The unchanged reviewed reader has SHA-256
`75bf0c1b841d26cdea469d3f39dd238f7817fdd1d8ed721f57c99f6d86abdf3f`.
Its exact SQL starts `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, with a
20-second statement limit and 40-second local subprocess deadline. Every raw
receipt verifies `read_only` and `transaction_read_only=on`; isolation is explicit
in the reviewed SQL, rather than separately echoed by this reader's receipt.
Each page is one transaction; the six-page timeline is **not globally atomic**.

| Page | Records | asOf UTC | after → next |
|---|---:|---|---|
| 1 | 500 | 2026-09-13T23:10:19.097940+00:00 | 0 → 727169 |
| 2 | 500 | 2026-09-13T23:10:23.183240+00:00 | 727169 → 731728 |
| 3 | 500 | 2026-09-13T23:10:26.965379+00:00 | 731728 → 736301 |
| 4 | 500 | 2026-09-13T23:10:30.502055+00:00 | 736301 → 740790 |
| 5 | 500 | 2026-09-13T23:10:34.018945+00:00 | 740790 → 743572 |
| 6 | 104 | 2026-09-13T23:10:37.778837+00:00 | 743572 → exhausted |

All report/manifest hashes, raw report parity, counts and cursor transitions
were verified. All selected runs start within the frozen window and finish by
its cutoff; there are no running or unfinished-in-window rows. [Collection](collection.json),
[page manifests](timeline-pages.json) and [summary](summary.json) retain bounds,
asOf values and receipts. Exhaustion proves delivery of retained diagnostic rows,
not completeness of provider facts.

Of **481 incremental runs**, **421** have valid decisions: **316 no-request,
99 count-mismatch only and six count-mismatch plus exhausted-without-known**.
All **105 requests** have valid clean-queue receipts and exactly one later
exact-generation terminal for the same page and requested revision. The other
eight successful terminals are scheduled reconciles. The new 36 decisions split
into **30 no-request and six mismatch-only requests**. First-page aggregate
decision counts agree with the fully drained timeline. Exported count/OR and
queue increment arithmetic agree; native head identity and `sawKnownCheckpoint`
are not exported, so hidden checkpoint equality is not reconstructed.

The same **59 partial incremental chunks and one historical failed run** lack a
final decision; partial does not mean failure or no-request. There are no invalid
or duplicate decision receipts or unknown request-queue receipts. All **six new
terminal membership receipts** are valid with exact-generation proof. Across
**113 successful terminals**, 66 have valid receipts and the same **47 historical
receipts** remain missing: 44 before instrumentation and three known writer-boundary
runs `733622`, `733859`, `734003`. One older nonterminal receipt brings the total
valid membership receipts to 67. No new terminal lacks one.

The new terminals contain **four actual-deactivation occurrences and two grace-only
protection occurrences**. These sums across generations do not identify distinct
relations or link a protected relation to a later retirement.

- **Lilly-1:** revision 746/generation 697 (`744385`, 20:19:09.229 UTC) protects one
  row under generation grace and retires none. The next clean-queue mismatch
  requests revision 747; generation 698 (`744645`, 21:19:26.787) records one candidate
  and one actual deactivation with protection buckets zero. The 22:16 incremental
  (`744912`) matches 3,357 / 3,357 and requests nothing. This is another aggregate
  repair chain, not a same-relation or presence-equivalence proof.
- **Ari:** generation 65 (`743659`, 17:52:33.418) records one candidate and one
  deactivation, with protection buckets zero. Five later comparisons at 18:52–22:52
  match and request nothing: 265 / 265, twice 266 / 266, 267 / 267 and 269 / 269.
  Provider and active counts change in those separate runs; do not infer row identity.
- **Lora-1:** generation 1227 retires one candidate, followed by another mismatch
  with one processed row. Generation 1228 protects one row; after another processed
  row, generation 1229 (`744073`, 19:36:13.037) retires one candidate. Three later
  comparisons at 20:28–22:28 match 9,474 / 9,474 and request nothing. Intervening
  activity and changing counts prevent identifying the retired relation.

These later comparisons are not atomic active-after-UPDATE measurements. The
completed [Lora-3 generation 775/776 follow-up](../lora3-followup-20260913T000235Z/REPORT.md)
and its independent review remain closed. No separate snapshot or targeted
production read repeated that case. This cumulative export simply retains its
unchanged historical rows and newer natural decisions.

| Cumulative source / stream | Physical attempts | Retry ordinals | Attempts with unknown payload bytes |
|---|---:|---:|---:|
| anomaly/followers_reconcile | 9,520 | 23 | 241 |
| scheduled/followers | 1,158 | 8 | 429 |
| scheduled/followers_reconcile | 763 | 1 | 17 |

Only the first-page aggregate contributes: **11,441 attempts**, 32 retry ordinals,
zero failed/429 attempt rows and 687 attempts with unknown payload bytes. Relative
to the previous cumulative snapshot, the differences are **446 attempts**, six
retry ordinals and 54 unknown-byte attempts. The attempt difference comprises
368 anomaly reconcile and 78 scheduled incremental attempts; scheduled reconcile
is unchanged. These are cumulative differences, not separately queried interval
costs, per-revision log attribution or savings. Follower HTTP coverage retains
2,604 runs with zero unknown/boundary/unrecorded/unfinished counters. Repeated
page aggregates and overlapping snapshots are not added together.

Six bounded read-only exports succeeded. No role fallback, session termination,
code/test/git/PR change, provider/socket probe, forced sync, recovery, flag,
deployment or automation action occurred. Runtime and configuration belong to
the coordinator's [separate packet](../../fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260913T230945Z/REPORT.md);
this observation does not establish continuous propagation or the current
protected deployment gate. Independent numerical review is pending.

The stage diagnosis is unchanged. Presence equivalence, safe suppression, causal
savings and event-to-reader latency remain unproven. These additional natural
receipts do not justify suppressing the observed repair path or passing a gate.
