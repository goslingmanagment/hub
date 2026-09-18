# A0 observation — 13 September 2026, 05:08 UTC

The new finding is a positive retained exclusion-reason counter: Lilly-2 generation 6838 completed at 04:28:00.609529 UTC with `stateChangesBelowStop=1` and `exclusionReasonChangesBelowStop=1`. The other five added reason counters are zero. This records a metadata discrepancy below the candidate stop; it does not identify a thread, the old/new exclusion value, its direction, a root cause, content loss or reader impact. The A0-only notification recommendation is **quiet**: subtype coverage improved, while the operational action and NO-GO verdict are unchanged.

The cumulative window is 10 September 22:58:33.610 through 13 September 05:08:55.255307 UTC. The export completed at 05:08:58.128444 UTC as `read_only`, transaction read-only `on`. SHA-256 is `13b599a417063a4766e023a144fbf4ad4cf5c5bdae783c70cf836f465f22522e`; the manifest count and original receipt report exactly match the normalized report. The prior snapshot hash was also verified. This reader declares `atomicSnapshot=false`. No selected sweep timestamp exceeds this cutoff, which does not turn the export into an atomic census.

**641 sweeps: 400 complete, 241 incomplete, zero running.** Compared with [00:15](../snapshot-20260913T001518Z/REPORT.md), 581 of 583 previous rows are unchanged and none are missing. The only two mutations are ordinary completion of the previously running Lora-3 G7652 (10→33 pages) and Lora-1 G4841 (32→77). All 58 newly selected rows are complete. Thus the increase of 60 complete rows includes two already selected rows; these overlapping cohorts must not be summed twice. Zero selected running reports does not establish that no sync work was active.

| Page | Complete | Incomplete | Running | New complete rows |
|---|---:|---:|---:|---:|
| ari-1 | 74 | 35 | 0 | 10 |
| lilly-1 | 67 | 42 | 0 | 10 |
| lilly-2 | 63 | 28 | 0 | 10 |
| lora-1 | 64 | 48 | 0 | 9 |
| lora-2 | 66 | 44 | 0 | 10 |
| lora-3 | 66 | 44 | 0 | 9 |

The incomplete reasons remain 228 `uncertified_or_partial_diagnostics` and 13 overlap-guard rejections. All 58 new rows retain complete diagnostic coverage, a non-null predecessor boundary, zero unknown material checks, and all six added reason fields. Across the entire cumulative cohort of 641 report rows, each added field is known on 102 rows (97 complete and five incomplete), absent on 538 and null on one legacy row (Lilly-2 G6823). Of the known values, only the exclusion field now has a nonzero sum, equal to one. A report row marked complete is not proof that every historical reason field was measured.

Other new state-change receipts are Lilly-1 G7409 (two flags occurrences, completed 00:33:53.656921 UTC) and Lilly-2 G6836 (one flags occurrence, completed 03:27:57.357760 UTC). Together with G6838, the new rows contain four generic state-change occurrences. There are no new changed-head or rollback occurrences. Cumulative generic state changes are 2,392, flags eight, and changed heads/rollbacks remain 2,364 each. Categories can overlap; these are not unique messages.

The [Lora-1 G4830 counterexample](../../../lora1-4830-20260913T003537Z/REPORT.md) is unchanged: 2,364 runtime occurrences, 2,363 historically paired common-group pointer clearings, and one unresolved pre-apply occurrence. Its six added fields remain absent. The prior raw comparison does not distinguish omission from explicit null and does not establish deletion or content loss. The current early-stop candidate remains **NO-GO**, alongside the earlier flags counterexamples.

Cumulative unknown material remains 403,215 observations; none were added by the new rows or the two completed continuations. Missing-hot observations rise by 20 to 164,834. Material-lag sample occurrences rise by 76,056 to 466,675, including one from a previously running row; these repeated/scoped receipts do not measure fresh-event-to-reader latency.

| Physical-attempt source | Current attempts | Arithmetic increase | Retry ordinals | Failed attempts | Unknown bytes |
|---|---:|---:|---:|---:|---:|
| anomaly | 6,829 | 461 | 25 | 0 | 171 |
| recovery | 5,085 | 1,475 | 2,528 | 842 | 3,372 |
| scheduled | 60,654 | 7,073 | 664 | 195 | 1,521 |

Total retained attempts are 72,568 (+9,009), with 3,217 retry ordinals (+1,151), 1,037 failed attempts (+385), zero HTTP 429 and 5,064 unknown byte counts (+1,600). Retry-state attempts are a different aggregate (3,219). All 385 added failed attempts belong to the already present `media_offer_stats` HTTP 500 buckets across six pages. The added retry-state attempts comprise 1,149 in those same 500 buckets and one `messaging_groups` timeout on Lilly-2. This does not identify a new DM terminal failure or establish the severity/root cause of the continuing media failures. Arithmetic differences between cumulative aggregates are not a separately frozen attempt interval or a savings measurement.

HTTP coverage has 17,615 runs, six unknown runs (previously seven), three boundary runs (previously four), and zero recorded unfinished/unrecorded attempt counters. The net reduction in unknown runs conceals two new unknown buckets on 13 September: scheduled `fan_earnings` for Lora-2 and Lilly-2, one each. Three earlier unknown buckets are no longer unknown in the new aggregate: scheduled Ari `media_stats`, recovery Lilly-1 `media_stats`, and scheduled Lora-1 `dm_conversations`. These aggregate changes do not explain the underlying receipt lifecycle.

DM coverage has 7,679 runs, 26 failed runs unchanged, one unknown run (Lora-2; previously also Lora-1) and eight lost-report runs unchanged. The known zero attempt-loss counters do not remove these coverage gaps or prove complete telemetry. The original seven-day clock and A0/A1 gates remain unchanged; neither ≥50% savings nor fresh-event latency is established.

This analysis reused the coordinator's fresh bounded read-only export and made no additional production query. It updated this snapshot report, [summary](summary.json) and the central A0 status documents. No code/git action, flag change, provider request, recovery or deployment was performed. Runtime/configuration receipts were supplied separately by the coordinator; C2b remains a separate check.
