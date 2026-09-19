# Physical-attempt remeasurement — 14 September 2026

**The ≥50% saving is not demonstrated. Causal migration savings remain unmeasured.**
The retained 1–6 September baseline is available: **183,416 physical attempts,
30,569.33/day**. The earlier **+21.46%** is correct arithmetic for 5 versus
12 September; it is neither a fleet trend nor an estimate of migration impact.
This packet recomputes the retained evidence locally. **No new production query,
provider call, test, flag change or deployment was performed.**

## What was counted

The source is `sync_http_attempts`, selected by attempt `started_at` in a
half-open UTC window, joined to retained `sync_runs` and `pages`. All returned
sources, streams, operations, outcomes and retries are included. This counts
instrumented physical attempts, including failed attempts; it does not count
observations as attempts. Source falls back from attempt source to run source.

The matrix covers the same six page IDs and all 17 retained streams. A cell with
no retained row is shown as zero **recorded attempts**, not proof that no provider
request occurred. Run coverage has a different grain: overlapping runs, grouped
by run start date. Boundary losses cannot be assigned to a specific attempt day.
Coverage is therefore reported per original export window, without adding
overlapping snapshots or apportioning loss counters into the selected days.

## Day and page means

| Complete UTC day | Physical attempts | Retry ordinal >1 | Failed outcomes |
|---|---:|---:|---:|
| 1 September | 29,670 | 889 | 294 |
| 2 September | 31,732 | 870 | 282 |
| 3 September | 30,679 | 939 | 298 |
| 4 September | 30,581 | 822 | 267 |
| 5 September | 30,684 | 875 | 290 |
| 6 September | 30,070 | 846 | 278 |
| 11 September | 24,131 | 1,041 | 311 |
| 12 September | 37,268 | 963 | 321 |

| Page | 1–6 September daily mean | 5 September | 11 September | 12 September | 11–12 September daily mean |
|---|---:|---:|---:|---:|---:|
| ari-1 | 707.50 | 669 | 869 | 845 | 857.00 |
| lilly-1 | 2,682.83 | 2,861 | 2,579 | 2,714 | 2,646.50 |
| lilly-2 | 11,591.67 | 10,859 | 5,754 | 17,309 | 11,531.50 |
| lora-1 | 6,951.33 | 7,303 | 6,498 | 7,597 | 7,047.50 |
| lora-2 | 4,806.50 | 4,845 | 4,656 | 5,003 | 4,829.50 |
| lora-3 | 3,829.50 | 4,147 | 3,775 | 3,800 | 3,787.50 |
| **Fleet** | **30,569.33** | **30,684** | **24,131** | **37,268** | **30,699.50** |

The two later complete days average **+0.426%** against the six-day baseline mean.
These are different weekday mixes and execution conditions; this second view
shows sensitivity to the chosen window, not a corrected causal saving. The
12 September value alone is **+21.913%** above the six-day mean. Partial
10 and 13 September are excluded from the means.

Every page×stream mean, daily range and count is in
[page-stream-means.csv](page-stream-means.csv) (102 rows); all eight complete
day×page×stream cells, retry counts and byte coverage are in
[day-page-stream.csv](day-page-stream.csv) (816 rows).

## What +21.46% actually shows

The day pair increased **6,584 attempts**. Lilly-2 contributed **6,450 (97.96%)**;
the other five pages increased **134**, from 19,825 to 19,959 (**+0.676%**).

| Lilly-2 stream | 1–6 September daily mean | 5 September | 11 September | 12 September | 12 minus 5 September |
|---|---:|---:|---:|---:|---:|
| dm_messages | 224.00 | 2 | 563 | 4,014 | +4,012 |
| fan_earnings | 2,010.33 | 2,010 | 0 | 4,028 | +2,018 |
| followers_reconcile | 1,597.50 | 1,128 | 963 | 1,880 | +752 |
| dm_conversations | 6,916.17 | 6,843 | 3,930 | 6,860 | +17 |
| media_stats | 300.00 | 300 | 0 | 50 | −250 |

All other Lilly-2 streams net **−99**. Fleet-wide `dm_messages` increased
4,209 and `fan_earnings` increased 2,046; these are accounting decompositions.
The Lilly-2 earnings sequence (zero recorded on 11 September, 4,028 on the 12th)
is consistent with work shifting between days. These aggregates do not identify
the scheduling cause or prove that each message request was required by a new
thread. They contain neither fan/thread identities nor hourly timestamps.

One audit detail needs correction: **5 September was not Lilly-2's minimum
baseline day**. Its 10,859 attempts exceed 6 September's 10,118. Workload,
backlog, correctness fixes, deployment and scheduling differences prevent a
causal reading of either comparison. No event policy saving is attributed to
falling streams or pages.

## Coverage, retries and remaining debt

| Export scope | Overlapping runs | Unknown loss-counter runs | Unrecorded / unfinished attempts |
|---|---:|---:|---|
| Original 1–6 September | 42,839 | 42,839 | unknown / unknown |
| 5 September reread | 7,125 | 7,125 | unknown / unknown |
| 12 September reread | 8,539 | 0 | 0 / 0 |
| Containing snapshot, 10 September 22:58–13 September 05:08 UTC | 17,615 | 6 | known sums 0 / 0; completeness unknown |

The last row describes the entire containing snapshot, not just 11–12 September.
The original baseline has **1,602 attempt groups**, including **5,241 retry
ordinal rows** and **1,709 failed rows**. Retry and failure counts are subsets
of total attempts, never extra terms. `attempt_number > 1` and `state = retry`
mean different things: ordinal/outcome totals are 1,041/1,043 on 11 September
and 963/964 on the 12th. The aggregate reader cannot resolve those identities.

Retries are retained in the same attempt table. At production source
`380326368fe39a6a9d22eb73b0b955f8ecd7c3cc`, the shared HTTP loop emits a separate
started/terminal pair per attempt; the sync observer persists the DB row before
the independently filtered stdout traces. Quiet successful logs therefore do
not remove successful attempt rows. The telemetry retention setting defaults
to **30 days**; pruning applies to all outcomes through the same cutoff, with
no separate retry exclusion. This is source-verified policy, not a newly read
effective production setting. Historic retention is established only as far as
the copied exports and successful equal-day rereads prove it.

The original baseline's loss counters were absent. **A complete physical-request
census for 1–6 September cannot be reconstructed from these retained aggregates.**
There are 9,100 baseline attempts with unknown captured bytes; the known
12,888,887,748 bytes are serialized capture payload sizes, not compressed wire
bytes or billed traffic. Browser/extension requests, optional uninstrumented
diagnostics, and socket traffic are outside this denominator. Event→reader
latency and savings at unchanged freshness are still unmeasured here.

The remaining measurement needs are a comparable period with the relevant
request-suppression policy actually active, known telemetry coverage, explicit
workload/backlog and deployment context, and separate freshness/event-latency
evidence. This packet changes no gate or calendar clock.

## Reproduction and receipts

Run `python3 recalculate.py` in this directory (or use its absolute path).
It verifies every copied input hash, original report manifests and retained
`read_only` / `on` receipts, recomputes the matrix, and checks exact equality
of the 5 September T0 slice with its reread and of the 12 September containing
snapshot slice with its reread. Equal groups prove stability between those
captures; they do not prove telemetry that never existed.

The original six-day export completed on 10 September at **22:05:46.800 UTC**.
Its manifest lacks an embedded role field; the pinned exporter source checks
`read_only` / READ ONLY before reading. Its completed report is distinct from
the later failed corpus export in the same retained log. The day rereads have
embedded role receipts and completed on 13 September at **09:44:49.773** and
**09:44:55.300 UTC**. These are retained snapshots, not current production reads.

[source-manifest.json](source-manifest.json) records exact original paths,
raw hashes and source identities. [summary.json](summary.json) retains means,
null loss counters, page×stream coverage and original receipt metadata.
[bounded-report.sql](bounded-report.sql) and [the source function](raw/measurement-function.sql)
make the SQL inspectable; neither was executed here. A future collection uses
the copied reviewed helper, as `read_only`, in READ ONLY, with an explicit
window ≤8 days, statement timeout 20 seconds and outer timeout 40 seconds.
It returns aggregates without a row-limit truncation; the time window and
timeout are its bounds. No direct raw-table export or app-user fallback is needed.

The packet remains **untracked and excluded from the dashboard parity PR**.
