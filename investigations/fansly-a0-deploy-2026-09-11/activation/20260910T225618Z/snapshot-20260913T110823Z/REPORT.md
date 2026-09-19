# A0 cumulative observation — 13 September, 11:08 UTC

**713 retained sweeps: 472 complete, 241 incomplete, zero running.** All 72 newly selected sweeps are complete: 12 on each of the six pages. Every one of the previous 641 rows is unchanged; none disappeared, and no selected row has an update or finish timestamp beyond the requested cutoff.

Window: **10 September 22:58:33.610 through 13 September 11:08:23.329422 UTC**. The read completed at **11:08:31.155154 UTC**. The report hash is `25b45b48bc4fa3b8a08f3d4b1f10fb7ea6f41c27b5839646e43857f9243f8d2c`; it matches the manifest. The raw receipt confirms `read_only` / `on` and equals the normalized report. The existing helper used `BEGIN READ ONLY`, a 20-second statement bound and 40-second process deadline. Execution exited 0; no fallback role, session kill, provider request or production mutation occurred.

This cumulative snapshot replaces the [05:08 report](../snapshot-20260913T050855Z/REPORT.md). **Do not sum snapshots.** The non-atomic report and its overlap denominators are retained as such; no selected running row does not prove that no work was active outside this result.

## Diagnostics and coverage

- All 72 new sweeps have zero unknown material checks and all six added reason counters present. Cumulatively each reason field is known on **174 rows** (169 complete and five incomplete), absent on **538**, and null on **one**. These historical unknowns are not converted to zero.
- Lilly-2 **G6848**, started **09:16:12.227** and finished **09:27:53.112372 UTC**, has one `stateChangesBelowStop` / `flagsChangesBelowStop` occurrence. Its virtual stop was page **4**; the ordinary sweep continued through **141 pages**. All six added reason counters are zero on this row. This is a further occurrence of the known flags class, without thread, value, direction, cause or reader-impact attribution.
- The new cohort adds **24 missing-hot-head occurrences**, all on Lilly-2; these are repeated comparison occurrences, not 24 distinct missing messages or demonstrated losses. It adds no new-head, changed-head, rollback or unread occurrence. `materialLagSamples` adds 91,497 known-head samples; these are not fresh-event→reader latency samples.
- Cumulative generic state occurrences are **2,393**, flags **nine**, and exclusion-reason **one**. Unknown material checks remain **403,215**. The earlier incomplete reasons remain **228 uncertified/partial** and **13 snapshot-overlap guards**.
- The **eight lost DM reports, one unknown DM run and 26 failed DM runs remain**. More complete current sweeps do not erase these historical coverage gaps.

The Lora-1 **G4830** row is unchanged: **2,364 overlapping runtime changed-head/rollback occurrences**, compared with **2,363 paired raw pointer clearings** and **one unexplained pre-apply occurrence**. Its added reason fields remain absent. The [independently reviewed counterexample and gate assessment](../../../lora1-4830-20260913T003537Z/GATE-ASSESSMENT.md) remain valid: all nine proposed stop policies miss those raw clearings. This read does not revisit provider bodies or reconstruct historical pre-apply state.

## Physical HTTP and loss accounting

| Counter | Previous cumulative snapshot | Current cumulative snapshot |
| --- | ---: | ---: |
| Retained physical attempt rows | 72,568 | 79,669 |
| Retry ordinals (`attempt_number > 1`) | 3,217 | 3,217 |
| Retry outcome rows | 3,219 | 3,219 |
| Failed outcome rows | 1,037 | 1,037 |
| HTTP 429 rows | 0 | 0 |
| Unknown captured-byte rows | 5,064 | 5,180 |
| Known captured payload bytes | 4,595,879,760 | 5,125,267,033 |
| Overlapping HTTP runs | 17,615 | 19,263 |
| Unknown HTTP runs | 6 | 4 |
| Boundary runs | 3 | 3 |
| Known unrecorded / unfinished sums | 0 / 0 | 0 / 0 |

The cumulative attempt count increased by **7,101**: scheduled **+5,324**, anomaly **+1,777**, recovery **0**. Current source totals are respectively **65,978**, **8,606** and **5,085**. Retry and failed outcome counts did not rise; all additional counted outcomes are success. All attempt groups for UTC days completed before the prior cutoff are unchanged. This subtraction is not an independent interval census or a revision-cost attribution, and failures/retries are already included in total attempts.

The two formerly unknown scheduled `fan_earnings` buckets for Lilly-2 and Lora-2 now have known receipts. The other four unknown HTTP runs remain; known zero loss sums do not cover them. DM loss/unknown counts did not change. Captured byte sums cover known serialized capture objects, not compressed wire traffic or a complete byte census.

## State and limits

The early-stop candidate remains **NO-GO**, full polling remains required, and A0/A1 acceptance is unchanged. The original earliest seven-day report remains **17 September 22:58:33.610 UTC** (18 September 01:58:33.610 Moscow). Calendar age alone cannot pass the gate. This artifact measures neither attributable migration savings nor fresh-event→reader latency; the separate [cost/latency measurement](../../../../fansly-cost-latency-measurement-20260913T094049Z/MEASUREMENT.md) retains that distinction.

Runtime and Configuration UI evidence belong to the coordinator's separate read. This SQL result does not prove effective configuration versions or uninterrupted historical flag continuity. For A0 alone, this is continued complete measurement with one further known discrepancy; **no new operational action or notification is warranted**. Independent [review](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260913T110856Z/REVIEW.md) passed; all actionable findings were closed.

Evidence: [raw report](report.json), [manifest](report.json.manifest.json), [read receipt](read-receipt.json), [execution](execution.json), [computed summary](summary.json).
