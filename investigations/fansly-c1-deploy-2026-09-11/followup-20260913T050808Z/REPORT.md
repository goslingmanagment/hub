# C1 cumulative observation — 13 September 2026, 05:08 UTC

The exhausted timeline contains **1,833 ordered unique runs** through `740027`. All 1,710 rows from the previous 00:16 snapshot are unchanged; 123 new rows add 30 valid incremental decisions, 90 partial reconcile chunks and three exact-generation completions. This extends the existing protection/repair evidence; it does not justify trigger suppression.

Window: `2026-09-11T01:05:57.089215Z` to `2026-09-13T05:08:08.857546+00:00`. Collection finished at `2026-09-13T05:08:29.595926+00:00`. Four sequential pages used the same window and pinned upper ID. Each page is one REPEATABLE READ, READ ONLY snapshot as `read_only`; the whole export is **not atomic**. No attempt failed, and no fallback, session termination or production mutation occurred.

| Page | Records | asOf UTC | after → next |
|---|---:|---|---|
| 1 | 500 | 2026-09-13T05:08:10.76624+00:00 | 0 → 727169 |
| 2 | 500 | 2026-09-13T05:08:20.545229+00:00 | 727169 → 731728 |
| 3 | 500 | 2026-09-13T05:08:25.104504+00:00 | 731728 → 736301 |
| 4 | 333 | 2026-09-13T05:08:28.402363+00:00 | 736301 → exhausted |

All report hashes, manifest counts and read receipts were checked. [Collection](collection.json), [page manifests](timeline-pages.json) and [numerical summary with hashes](summary.json) retain the exact scope.

Of 351 incremental runs, 313 have valid decisions: **245 no-request, 64 count-mismatch only, four count-mismatch plus exhausted-without-known**. All 68 requests have a valid clean prior queue and exactly one later exact-generation terminal for that page/revision. The 38 missing decisions are 37 partial chunks and one failed run, unchanged from before; partial is not failure or a no-request decision. No invalid/duplicate receipt, unfinished run or window-boundary row is present in this retained timeline.

The new decisions are 27 no-request and three count-mismatch requests. No new OR combination or pending-at-request case appeared. Count/OR arithmetic agrees with the exported fields; the reader does not expose the follower IDs or sawKnownCheckpoint needed to independently reconstruct checkpoint equality.

| Page / revision | Decision run → terminal run | Generation / completion UTC | Pre-UPDATE evidence | Actual retired |
|---|---|---|---|---:|
| lilly-2 / 2544 | 739229 → 739302 | 795 / 2026-09-13T03:47:45.889+00:00 | active 18324, observed 18323, candidates 0, grace-only 1 | 0 |
| lilly-2 / 2545 | 739673 → 739818 | 796 / 2026-09-13T04:47:38.697+00:00 | active 18324, observed 18322, candidates 1, grace-only 1 | 1 |
| lora-2 / 1627 | 739787 → 739845 | 1589 / 2026-09-13T04:51:14.928+00:00 | active 8136, observed 8135, candidates 0, grace-only 1 | 0 |

Lilly-2 generation 795 closed with one grace-protected row and zero retirements. The next decision still mismatched (18,324 active / 18,322 headline); generation 796 retired one candidate while another row remained in grace. Lora-2 generation 1589 closed with one grace-protected row and zero retirements. The last Lilly-2 and Lora-2 terminals have no subsequent incremental comparison in this cutoff. Counts do not establish the same row across generations or a measured active-after count; the changing headline is not proof of a particular provider deletion or new-follower cause.

All three new membership receipts are valid and exact-generation. Forty-seven historical terminal receipts remain missing; none newly disappeared. The cumulative 74 terminals include six scheduled reconciles, separate from the 68 incrementally requested revisions. The earlier partial restart note remains distinct from terminal membership.

| Cumulative source / stream | Physical attempts | Retry ordinals | Unknown payload bytes |
|---|---:|---:|---:|
| anomaly/followers_reconcile | 6,639 | 23 | 167 |
| scheduled/followers | 821 | 2 | 315 |
| scheduled/followers_reconcile | 490 | 1 | 13 |

The first-page aggregate contains **7,950 follower attempts**, 26 retry ordinals, zero failed/429 rows and 495 unknown payload-byte rows. Retained HTTP coverage has 1,833 runs and zero unknown/boundary/unrecorded/unfinished counters. The earlier cumulative total was 7,429; the difference is 521 attempts (461 anomaly reconcile, 60 scheduled incremental), not a separate interval or per-revision log reconciliation. Do not add repeated page aggregates, snapshots or logs. No new worker-log read or physical savings/event-latency measurement was performed.

Current classification: additional natural protection and retirement receipts, with the C1 diagnosis and gates unchanged. Presence equivalence, safe suppression and cross-generation row identity remain unproven. The coordinator owns the separate fresh Docker runtime evidence; this SQL packet makes no attribution to a runtime replacement.
