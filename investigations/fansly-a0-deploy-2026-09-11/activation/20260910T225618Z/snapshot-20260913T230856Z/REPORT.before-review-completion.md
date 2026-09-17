# A0 cumulative observation — 13 September 2026, 23:08 UTC

A0 remains **NO-GO** for early acceptance. The fresh report contains **865 sweeps:
613 complete, 252 incomplete, zero selected running rows**. All previous 787 rows
are unchanged by stable `(page_id, generation)` identity; 78 are newly selected
(71 complete, seven incomplete). Snapshots overlap and must not be added.

The new signal is a Lilly-2 cluster: six overlap guards, then an uncertified
comparison, followed by four complete sweeps. Missing-hot-head observations rose
from two per completed sweep to 57, 146, 146 and then three in the latest sweep.
These are repeated observations, not a count of distinct missing messages.
The latest sweep completed; cause and reader impact have not been established.
The operational action remains observation with full polling.

| Lilly-2 generation | Result | Pages | Stop | Missing-hot-head occurrences |
| --- | --- | ---: | ---: | ---: |
| 6864–6870 | Complete, seven sweeps | 141 each | 3 or 4 | 2 each |
| 6871 | Incomplete, overlap guard | 16 | 4 | 0 |
| 6872–6876 | Incomplete, five overlap guards | 1 / 75 / 1 / 51 / 1 | null | 0 |
| 6877 | Incomplete, uncertified | 142 | null | 0 |
| 6878 | Complete | 142 | 4 | 57 |
| 6879 | Complete | 142 | 3 | 146 |
| 6880 | Complete | 142 | 3 | 146 |
| 6881 | Complete at 22:58:17.627656 UTC | 142 | 4 | 3 |

The incomplete cluster spans 20:46:13.688–21:21:49.031596 UTC. Six failed DM runs
were added on Lilly-2 (page total 4 → 10; all-page total 28 → 34). The report does
not establish a causal link between these aggregates. `completeCoverage=true`
and zero unknown-material counters do not override incomplete status. There are
now 21 overlap-guard and 231 uncertified/partial incomplete reports.

Four complete sweeps add one flags occurrence each: Lilly-1 G7445/G7448 and
Lora-2 G5526/G5531. Lilly-1 G7451 adds one exclusion-reason occurrence. Known
cumulative state-change observations are 2,402 (+5), flags 13 (+4), exclusion
reasons six (+1). Other added reason counters have known sums of zero. These
records do not reveal old/new values, affected threads or causation.

Each of the six added reason fields is known on 326 rows (310 complete,
16 incomplete), absent on 538 legacy rows and explicitly null on one. All 78 new
rows have known counters. Historical unknown-material observations remain
403,215; no new such observations were added. Missing-hot-head observations
increase by 366 to 165,248, entirely on Lilly-2 in this comparison.
Lora-1 G4830 is unchanged: 2,364 overlapping changed-head/rollback occurrences,
previously paired to 2,363 raw clearings and one unresolved pre-apply occurrence.
Do not sum the overlapping diagnostic categories or call them confirmed losses.

| Cumulative HTTP measurement | Current | Change from previous snapshot |
| --- | ---: | ---: |
| Physical attempts | 93,139 | +6,514 |
| Retry ordinals (subset of attempts) | 3,230 | +13 |
| Retry outcomes (subset of attempts) | 3,232 | +13 |
| Failed attempt outcomes | 1,037 | 0 |
| HTTP 429 attempts | 0 | 0 |
| Attempts with unknown bytes | 5,371 | +97 |
| Known captured-object bytes | 6,115,349,328 | +496,666,427 |

The 13 added retries are scheduled-source attempts. Recovery-source attempts
remain 5,085. There are 22,459 HTTP coverage runs, four unknown and three boundary
runs; known unfinished and unrecorded counts are zero. The four unknown buckets
are unchanged. Captured bytes are serialized capture-object bytes, not wire
traffic; 113 aggregate groups have null byte totals. DM lost reports remain eight
and unknown runs one. These gaps cannot be turned into zero loss.

The original observation starts **10 September 22:58:33.610 UTC**. The earliest
seven-day report remains **17 September 22:58:33.610 UTC**. This artifact neither
accepts A0 nor authorizes A1. It measures neither attributable migration savings
nor event → reader latency. The A0-only notification recommendation is quiet:
later sweeps completed, the latest mismatch count fell to three, and no changed
operational action is established. Independent artifact review is pending.

The shared [runtime/configuration packet](../../../heartbeat-runtime-20260913T230945Z/REPORT.md)
is separate evidence. Its coordinator reports healthy roles and visible
allowlists; this A0 SQL export cannot establish per-role application versions or
continuous historical flag coverage.

The reviewed helper performed one `read_only` / `BEGIN READ ONLY` report query
with a local 20-second statement timeout. The explicit cumulative window ends
at **2026-09-13T23:08:56.244621Z**; the read completed at
**2026-09-13T23:09:04.967532Z**. Role, transaction mode, raw receipt equality and
current/previous report hashes were verified locally. All selected starts are
inside the window; no selected row has a post-cutoff timestamp. The export is
non-atomic, so this does not prove absence of active work.

Report SHA-256: `c3cc29403d60aa5da94ff1c660a0783c560c226a9f0390cd33ae0ff72ef16676`.
Retained [summary](summary.json), [report](report.json), [read receipt](read-receipt.json),
[manifest](report.json.manifest.json), and [local analysis](analyze.py) make the
comparison reproducible. The [previous observation](../snapshot-20260913T170727Z/REPORT.md)
and exact pre-update state/documents are retained. No provider call, flag change,
socket, deployment, recovery, code/PR action or additional production query was
performed for this observation.
