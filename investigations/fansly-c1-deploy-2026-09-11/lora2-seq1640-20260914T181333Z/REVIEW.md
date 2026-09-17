# Independent targeted C1 closure review

Verdict: **pass; no actionable findings**. This review closes the specific
Lora-2 revision 1640 observation only. It does not advance the cumulative
observation or accept C1 policy.

Verified all 11 artifact-manifest hashes, raw/report equality, invocation and
manifest agreement, successful exit and empty error receipts. The retained
receipt confirms `read_only` and transaction read-only `on`. The unchanged reader
contains REPEATABLE READ READ ONLY SQL, a 20-second statement timeout and a
40-second subprocess deadline. No additional production read or test was run
for this review.

The single exhausted page contains 37 unique ordered cohort rows, all starting
in the explicit 17:44:00–18:13:33.785535 UTC window, with upper run ID 751150,
`afterRunId=0` and `nextRunId=null`. Its 18:13:38.766546 asOf falls within the
export interval. The exporter lacks a page filter; all 18 Lora-2 rows were
independently selected from the full retained cohort and match selected-rows.json.

The chain contains one original scheduled incremental request (751019), 16
partial reconcile chunks and exactly one successful terminal (751074). The
request advances queue revision 1639 to 1640. The terminal retains leased,
request and checkpoint revision 1640, generation 1602 in membership/statistics /
checkpoint, one valid membership receipt 5921313 and an exact-generation marker.
The 17:51:20.799 membership receipt precedes the 17:51:20.822 successful finish;
both precede the new cutoff. Observed/source counts equal 8,140, and disjoint
membership arithmetic supports one deactivation with zero protection-category
occurrences. Destructive finalization is explicit. Relation identity, atomic
after-state and presence equivalence are not inferred.

No later Lora-2 incremental row exists in this exhausted window. Therefore the
later no-request comparison is unobserved (`null`), not a false decision or a
zero-request count. Natural completion means the retained original scheduled
request and subsequent anomaly reconcile chain; the collector itself only reads.

All 17 shared Lora-2 rows were independently compared against the prior seven-page
packet. Only run 751072's cutoff-dependent `unfinished_in_window` changes from
true to false; its partial outcome and actual finish remain identical. All 48
frozen prior artifact hashes still match. The old cumulative pending-at-cutoff
conclusion remains correct. This targeted HTTP aggregate is not added to the
cumulative totals. No STATE, gate, flag or code was changed by this review.

Verified SHA-256 fingerprints:

| File | SHA-256 |
|---|---|
| REPORT.md | `ade7d20fbd3499a1434d2f93e398ce6e7950e8ac889163b2c258c2897bf359e3` |
| summary.json | `8cc4db7820d9f7167e5e2b3904cd61bbf3dd6385865948eb4d6ddb804e43c625` |
| artifact-manifest.json | `244384531726e26401f3a53f026e0bf7747f750ad686a893517d8eef9f827af1` |
| page-1/report.json | `480247c39db15a16fdbcd1057ac042e75b97ff63f0208218e50f83c50a70b056` |
| analyze.py | `0a6283e78322a28d609fd5bc9cb5f745f3616f3908993c4481207bce198b33c3` |

The author's frozen pending-review sentence is historical; this receipt closes
independent numerical review without modifying that report or its manifest.
