# Physical HTTP measurement — 13 September 2026

**Recorded traffic rose from 30,684 to 37,268 attempts per complete UTC day: +6,584 (+21.46%). A ≥50% reduction is not demonstrated; there is no such reduction in this recorded scope.** This is an observed before/after comparison, not causal migration savings under an experimentally matched workload.

The comparison uses **5 September 00:00–6 September 00:00 UTC** and **12 September 00:00–13 September 00:00 UTC**: two Saturdays and the exact same six page IDs/labels. The original T0 export retained 5 September before this measurement was chosen. Its 256 attempt groups equal the fresh historical reread exactly. The 260 current-day groups also equal the same day's slice in the earlier 05:08 A0 export. These checks detect no change to these retained groups between the respective captures; they do not prove absent telemetry was recorded.

**Completeness of the historical denominator is unknown:** all 7,125 overlapping baseline runs lack loss counters. Their loss sums remain `null`, not zero. The current read has known zero loss counters across 8,539 retained overlapping runs, but this is still not a census of browser, Management Session/bootstrap or other uninstrumented provider traffic. No saving is inferred from those unknown paths.

## Results

| Metric | 5 September | 12 September |
| --- | ---: | ---: |
| Retained physical attempt rows | 30,684 | 37,268 |
| Retry ordinal rows (`attempt_number > 1`) | 875 | 963 |
| Retry outcome rows (`state = retry`) | 875 | 964 |
| Failed outcome rows (`state = failed`) | 290 | 321 |
| Still-started outcome rows | 0 | 0 |
| HTTP 429 rows | 0 | 0 |
| Rows with unknown captured bytes | 1,547 | 1,671 |
| Known captured payload bytes | 2,160,806,622 | 2,227,831,205 |
| Overlapping sync runs | 7,125 | 8,539 |
| Runs with unknown loss counters | 7,125 | 0 |
| Runs crossing a day boundary | 2 | 4 |
| Reported unrecorded / unfinished attempts | unknown / unknown | 0 / 0 |

Retries and failed outcomes are subsets of physical attempts, not additions. Retry ordinal and retry outcome describe different facts; their current counts differ by one. The report does not expose identities needed to explain that difference. Captured bytes are serialized payload-object UTF-8 sizes where recorded, **not** compressed network bytes, billed egress or a complete byte census. No money saving is calculated.

The six original T0 days (1–6 September) contain 183,416 physical attempt rows: **30,569.33/day on average, range 29,670–31,732**. The current day is **21.91% above that mean** and above every day in that retained six-day baseline. The plan's roughly 29.4k captured responses/day is a different denominator and is not used here.

| Page | Baseline attempts | Current attempts | Change |
| --- | ---: | ---: | ---: |
| ari-1 | 669 | 845 | +176 |
| lilly-1 | 2,861 | 2,714 | −147 |
| lilly-2 | 10,859 | 17,309 | +6,450 |
| lora-1 | 7,303 | 7,597 | +294 |
| lora-2 | 4,845 | 5,003 | +158 |
| lora-3 | 4,147 | 3,800 | −347 |

| Run source | Baseline attempts | Current attempts | Change |
| --- | ---: | ---: | ---: |
| scheduled | 24,800 | 31,392 | +6,592 |
| anomaly | 3,875 | 4,217 | +342 |
| recovery | 2,009 | 1,659 | −350 |

The largest stream increases are `dm_messages` **164→4,373 (+4,209)** and `fan_earnings` **5,728→7,774 (+2,046)**. `dm_conversations` is **15,616→16,070 (+454)**, and `followers_reconcile` **4,148→4,434 (+286)**. This is an accounting decomposition; it does not identify why those requests occurred. The JSON includes every stream, operation, source, page and outcome, without dropping recoveries or failures to improve the result.

## What this establishes

The physical reader selects Fansly attempt rows by **attempt `started_at` in `[from, to)`**, joined to their retained run and page. All returned sources, streams and outcomes are included. Source is the attempt source with run source as fallback. Loss denominators separately include overlapping runs, including those starting before the window. Boundary losses cannot be assigned to an exact attempt time. The two day reports are separate snapshots; they are not an atomic A/B experiment. Manifest `records` values **0 and 292 count shadow sweeps**, not physical attempts.

The baseline predates the prerequisite DM defect fixes. Backlog, roster/activity, provider failures, pre-A0 correctness and other deployments were not held constant; freshness parity has not been proved by this measurement. The lower counts on two pages and any falling stream are therefore not attributed to the event migration.

A0 continues full polling and its current early-stop candidate is NO-GO. C1 has no trigger suppression, C2b only measures existing daily responses, and A1/B1/C2c request-reduction policies are not active. These policy facts explain why this is not a measurement of an enabled request-suppression treatment. **Causal migration savings remain unmeasured; event→reader latency is outside this HTTP artifact.** No stage gate or clock changes result from these reads.

## Reproduction and receipts

The unchanged [existing read helper](../fansly-a0-deploy-2026-09-11/read-report.py) called only `fansly_events_measurement_report` as `read_only` in `BEGIN READ ONLY`, with a 20-second statement timeout and 40-second outer helper deadline. Both reads exited 0 at **09:44:49.816566** and **09:44:55.330309 UTC**. There were no failed reads, role fallbacks, provider calls, flag changes, session kills or production writes. Each retained response confirms `read_only` / `on`; report hashes, window identity and normalized raw response equality were verified locally.

- [Computed summary and all breakdowns](http-summary.json); reproduce with `python3 summarize-http.py` from any directory. This script only reads local evidence.
- [Baseline day reread](baseline-day-reread/report.json), [manifest](baseline-day-reread/report.json.manifest.json), [execution](baseline-day-reread.execution.json).
- [Current day](current-day/report.json), [manifest](current-day/report.json.manifest.json), [execution](current-day.execution.json).
- [Original six-day T0 baseline](../fansly-a0-deploy-2026-09-11/evidence/t0-2/baseline.json), [original manifest](../fansly-a0-deploy-2026-09-11/evidence/t0-2/baseline.json.manifest.json).
- [Earlier current-day containing snapshot](../fansly-a0-deploy-2026-09-11/activation/20260910T225618Z/snapshot-20260913T050855Z/report.json).

Independent review is recorded separately by the coordinator. This report's calculations and receipt checks are the collector's verification.
