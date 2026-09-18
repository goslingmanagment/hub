# C1 cumulative observation — 13 September 2026, 11:09 UTC

The exhausted timeline contains **2,289 ordered unique runs** through `741760`. All **1,833** rows from the previous 05:08 snapshot are unchanged; **456** new rows add 36 valid incremental decisions, 22 partial incremental chunks, 376 partial reconcile chunks and 22 exact-generation completions. Natural grace and retirement evidence continues. No suppression or presence-equivalence gate changes.

Window: `2026-09-11T01:05:57.089215Z` to `2026-09-13T11:09:57.464858+00:00`. Collection finished at `2026-09-13T11:10:20.242710+00:00`. Five sequential pages used the same window and pinned upper ID. Each page is one REPEATABLE READ, READ ONLY snapshot as `read_only`; the whole export is **not atomic**. The reviewed exporter remains SHA-256 `75bf0c1b841d26cdea469d3f39dd238f7817fdd1d8ed721f57c99f6d86abdf3f`. No export failed, and no fallback, session termination or production mutation occurred.

| Page | Records | asOf UTC | after → next |
|---|---:|---|---|
| 1 | 500 | 2026-09-13T11:09:59.443278+00:00 | 0 → 727169 |
| 2 | 500 | 2026-09-13T11:10:07.042464+00:00 | 727169 → 731728 |
| 3 | 500 | 2026-09-13T11:10:11.559916+00:00 | 731728 → 736301 |
| 4 | 500 | 2026-09-13T11:10:15.31219+00:00 | 736301 → 740790 |
| 5 | 289 | 2026-09-13T11:10:18.837371+00:00 | 740790 → exhausted |

All report hashes, manifest counts and read-receipt payloads were checked. IDs are unique and ordered; all starts are inside the frozen window and all finishes are at or before its cutoff. [Collection](collection.json), [page manifests](timeline-pages.json) and [numerical summary](summary.json) retain the exact scope and individual SHA-256 values. Pagination exhaustion covers the retained diagnostic timeline, not uncaptured facts.

Of **409 incremental runs**, **349** have valid decisions: **260 no-request, 83 count-mismatch only, six count-mismatch plus exhausted-without-known**. All **89** requests have a valid clean prior queue and exactly one later exact-generation terminal for that page and requested revision. Requested revisions are the queue-before revision plus one; partial chunks do not count as terminals. Seven additional successful terminals are scheduled reconciles, separate from those 89 requests.

Missing incremental decisions are **59 partial chunks and one historical failed run**. The increase from 38 to 60 missing decisions is entirely the 22 new partial chunks; it is not a new failed final-decision receipt or a no-request decision. There are no invalid or duplicate decision receipts, unknown/pending-at-request queue receipts, unfinished-in-window or running rows. The two historical failed runs in the entire timeline are unchanged.

The new valid decisions are **15 no-request and 21 requests** (19 mismatch-only, two mismatch/exhausted). The latter two combinations occur on Lilly-1 run `740154` and Lora-2 run `741064`; this combination was already observed, so no new OR branch appears. Exported count and OR arithmetic is consistent. The reader does not expose native follower/head identities or `sawKnownCheckpoint`; hidden checkpoint equality cannot be independently reconstructed.

## Natural follow-up to the previous cutoff

- **Lilly-2:** after generation 796 retained a grace-protected row, the next clean-queue decision `740222` requested revision 2546 on counts 18,323 / 18,322. Generation **797**, terminal `740301` at **05:47:35.603 UTC**, records one candidate and one actual deactivation, with protection buckets zero. The next three comparisons (`740482`, `740729`, `740982`, 06:32–08:32) match 18,322 / 18,322 and request nothing. This supplies the previously absent subsequent comparison and continues the observed repair chain.
- **Lora-2:** after generation 1589 protected one row, decision `740268` still mismatched 8,136 / 8,135 and requested revision 1628. Generation **1590**, terminal `740325` at **05:51:06.272 UTC**, records one candidate and one actual deactivation. Its next comparison `740510` sees 8,135 / 8,134 and requests another walk. There is no claim that the old protected row is the retired row, or that the changed provider count identifies a new deletion.
- Later **Lilly-2 generation 798** again records one grace-only row and zero deactivations. **Generation 799** (`741451`, revision 2548) is a **scheduled** reconcile, not another incremental request; it retires one candidate. The 10:32 comparison then matches 18,321 / 18,321 and requests nothing. Keep this scheduled-source boundary when attributing requests or cost.

All **22 new terminal membership receipts** are valid and exact-generation. They contain 12 actual-deactivation occurrences and 13 grace-only protection occurrences across separate generations. These sums do not identify distinct relations or the same relation across generations. The cumulative 96 terminals have 49 valid terminal membership receipts and **47 historical missing receipts**: 44 before instrumentation plus the three known writer-boundary runs `733622`, `733859`, `734003`. None newly disappears. There are 50 valid membership receipts across all runs because one historical nonterminal receipt is also retained; no invalid/duplicate membership receipt appears.

The latest Lora-1 generation 1221, Lora-2 generation 1595 and Lora-3 generation 781 have no subsequent valid incremental comparison in this cutoff. The separately reviewed Lora-3 generation 775/776 case remains closed as recorded in its [00:02 report](../lora3-followup-20260913T000235Z/REPORT.md) and [review](../lora3-followup-20260913T000235Z/REVIEW.md); these later generations do not reopen that case.

Counts are pre-UPDATE aggregate receipts and later independent comparisons, not immediate atomic active-after-UPDATE measurements. They prove neither relation identity nor presence coverage, provider deletion causality, the necessity of every walk or safe suppression.

## Retained follower HTTP attempts

| Cumulative source / stream | Physical attempts | Retry ordinals | Attempts with unknown payload bytes |
|---|---:|---:|---:|
| anomaly/followers_reconcile | 8,416 | 23 | 209 |
| scheduled/followers | 1,008 | 2 | 351 |
| scheduled/followers_reconcile | 678 | 1 | 15 |

Only the **first-page** aggregate is used: **10,102 follower attempts**, 26 retry ordinals, zero failed/429 attempt rows and 575 unknown payload-byte rows. Retained follower HTTP coverage has 2,289 runs and zero unknown/boundary/unrecorded/unfinished counters. The prior cumulative total was 7,950; the difference is **2,152 attempts** (1,777 anomaly reconcile, 188 scheduled reconcile, 187 scheduled incremental), with 80 additional unknown-byte rows. These are differences between retained cumulative snapshots, not a separately queried interval or per-revision worker-log reconciliation. Do not add repeated page aggregates, overlapping snapshots or logs. The C1 collector did not read worker logs; the coordinator retained shared runtime/log evidence separately. No physical savings or event-latency measurement was performed.

Current classification is additional natural protection/retirement evidence with unchanged diagnosis and gates; no new operational action follows from this packet. The coordinator's separate [11:08 runtime receipt](../../fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260913T110856Z/runtime.json) identifies the runtime observation; this SQL export does not attribute changes to a release or prove continuous flag propagation. No application code, tests, git/PR, flag, provider/socket probe, recovery, deployment or automation change occurred. Independent [numerical and report review](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260913T110856Z/REVIEW.md) passed with no open findings.
