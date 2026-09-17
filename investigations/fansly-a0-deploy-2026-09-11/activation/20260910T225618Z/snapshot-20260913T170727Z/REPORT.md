# A0 cumulative observation — 13 September, 17:07 UTC

**787 retained sweeps: 542 complete, 245 incomplete, zero running.** The 74 newly selected rows comprise 70 complete comparisons and four incomplete comparisons on Lora-1. All previous 713 rows are unchanged; none disappeared or has a newly changed terminal receipt. No selected sweep has an update or finish timestamp beyond cutoff.

The cumulative window is **10 September 22:58:33.610 through 13 September 17:07:27.463975 UTC**, read completed at **17:07:35.860492 UTC**. The report SHA-256 is `dcb8306951cedb003ba9dea71630a21c3a232daf396c67b473b803359ac2c0fa`, matching its manifest. Raw and normalized reports are equal; the receipt confirms `read_only` / `on`. The unchanged helper used `BEGIN READ ONLY`, a 20-second statement bound and 40-second process deadline, and exited 0. No fallback, session kill, provider request, production write or configuration change occurred.

This replaces the [11:08 cumulative snapshot](../snapshot-20260913T110823Z/REPORT.md); **do not add snapshots**. The read remains non-atomic. Absence of selected running rows or post-cutoff timestamps does not establish that no other work was active.

## New comparisons

Each page except Lora-1 adds 12 complete rows. Lora-1 adds ten complete and the following four incomplete rows:

| Lora-1 generation | Finish UTC | Pages | Recorded reason | Boundary / virtual stop |
| --- | --- | ---: | --- | --- |
| 4864 | 11:47:51.828017 | 68 | snapshot overlap guard | known / 9 |
| 4865 | 11:55:31.454547 | 77 | uncertified or partial diagnostics | null / null |
| 4872 | 15:17:02.975353 | 58 | snapshot overlap guard | known / 9 |
| 4873 | 15:24:33.047406 | 77 | uncertified or partial diagnostics | null / null |

All four have `completeCoverage=true` and zero unknown material checks. Those scalars **do not override their incomplete status**. The two successor rows have no certified comparison boundary; the handler requires a non-null boundary as one of several certification conditions. Following comparisons G4866 and G4874 are complete, each reaching 77 pages. This sequence records the guards and subsequent comparisons; no provider deletion identity or cause of the overlap was inspected.

Four new completed state-change receipts each contain one exclusion-reason occurrence, all below virtual stop page 9:

| Page / generation | Finish UTC | Full pages | Exclusion occurrences |
| --- | --- | ---: | ---: |
| lora-1 / 4866 | 12:18:31.815539 | 77 | 1 |
| lora-1 / 4867 | 12:48:34.616714 | 77 | 1 |
| lora-3 / 7676 | 12:16:53.051159 | 33 | 1 |
| lora-1 / 4874 | 15:48:36.028542 | 77 | 1 |

The exclusion subtype was already measured on Lilly-2; these are its first retained positive receipts on Lora-1 and Lora-3 in this cumulative comparison. They do not identify distinct threads, old/new exclusion values, direction, cause or reader impact. The full sweep continued after each virtual stop. No new flag, changed-head, rollback, new-head or unread occurrence was added. Lilly-2 contributes another 24 repeated missing-hot-head occurrences (two in each of 12 sweeps), not proof of 24 distinct lost messages.

All 74 new rows have zero unknown material checks and all six added reason counters present. Each reason field is now known on **248 rows** (239 complete, nine incomplete), absent on **538**, and null on **one**. Cumulative unknown material remains **403,215**. Known-head `materialLagSamples` rises by 91,726; this is not fresh-event→reader latency.

Cumulative state-change occurrences are **2,397**, flags **nine**, exclusion-reason **five**. Incomplete reasons are **230 uncertified/partial** and **15 overlap guards**. Historical gaps remain explicit.

## Physical HTTP and coverage

| Counter | Previous cumulative snapshot | Current cumulative snapshot |
| --- | ---: | ---: |
| Physical attempt rows | 79,669 | 86,625 |
| Retry ordinals | 3,217 | 3,217 |
| Retry outcome rows | 3,219 | 3,219 |
| Failed outcome rows | 1,037 | 1,037 |
| HTTP 429 rows | 0 | 0 |
| Unknown captured-byte rows | 5,180 | 5,274 |
| Known captured payload bytes | 5,125,267,033 | 5,618,682,901 |
| Overlapping HTTP runs | 19,263 | 20,921 |
| Unknown HTTP runs | 4 | 4 |
| Boundary runs | 3 | 3 |
| Known unrecorded / unfinished sums | 0 / 0 | 0 / 0 |

The cumulative attempt difference is **+6,956**: scheduled **+6,220**, anomaly **+736**, recovery **0**. Current source totals are **72,198**, **9,342** and **5,085**, respectively. Retry/failed counts do not rise; the net outcome increase is entirely success. Attempt groups for complete UTC days before the prior cutoff are unchanged. These counter differences are not an independent interval census or proof of per-revision cost. Retries and failed rows are already included in total attempts; captured bytes are known serialized objects, not compressed wire traffic or a complete byte census.

DM run failures rise **26→28**, with both additional failures on Lora-1. This differs from physical HTTP failed outcomes, which remain unchanged. The report retains **eight lost DM reports and one unknown DM run**. Known zero HTTP loss sums do not cover the four unknown runs, and no historical missing receipt is erased by later successful comparisons.

## Unchanged decision and boundaries

Lora-1 G4830 is unchanged: **2,364 overlapping runtime head/rollback occurrences**, **2,363 independently paired raw pointer clearings**, and **one unexplained pre-apply occurrence**. Its six added reason fields remain absent. The [existing counterexample and NO-GO assessment](../../../lora1-4830-20260913T003537Z/GATE-ASSESSMENT.md) remain valid; no original provider bodies or historical pre-apply state were newly inspected.

The early-stop candidate remains **NO-GO**. Full polling and the original earliest seven-day report point, **17 September 22:58:33.610 UTC** (18 September 01:58:33.610 Moscow), remain. A0/A1 acceptance is not passed. The separate [physical traffic measurement](../../../../fansly-cost-latency-measurement-20260913T094049Z/MEASUREMENT.md) measured observed load change, not attributable migration savings; this heartbeat does not repeat that comparison or measure fresh-event latency.

Runtime and configuration receipts are handled separately by the coordinator. This SQL read does not prove configuration versions or uninterrupted historical continuity. For A0 alone, the new guard pairs are followed by completed comparisons and the exclusion subtype is already known; no changed operational action is established. The recommendation is quiet observation, with all incomplete rows retained. Independent [review](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260913T170716Z/REVIEW.md) passed with no open actionable findings.

Evidence: [report](report.json), [manifest](report.json.manifest.json), [raw read receipt](read-receipt.json), [execution and previous-file hashes](execution.json), [summary](summary.json). Exact pre-update local state/report/shadow backups are retained beside these files.
