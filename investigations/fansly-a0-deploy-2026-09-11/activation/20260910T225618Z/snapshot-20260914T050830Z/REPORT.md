# A0 cumulative observation — 14 September 2026, 05:08 UTC

A0 remains **NO-GO**. All **72 newly selected sweeps completed**, twelve on each
of the six pages. The cumulative report contains **937 rows: 685 complete,
252 incomplete and zero selected running rows**. Every prior row is unchanged
by `(page_id, generation)` identity: 865 retained unchanged, zero changed or
missing. The overlapping snapshots must not be added.

The A0-only recommendation is quiet: all six pages continue completing sweeps,
no new incomplete comparison or unknown-material observation was added, and
the existing acceptance blockers remain. Recorded media-stats failures are a
recurring failure class; the new dated counts are retained below. They do not
establish a new ongoing outage, its cause or a changed operational action.

| Page | Cumulative complete / incomplete | New complete | Latest completion UTC |
| --- | ---: | ---: | --- |
| Ari-1 | 122 / 35 | 12 | 05:06:28.943555 |
| Lilly-1 | 115 / 42 | 12 | 05:03:18.633521 |
| Lilly-2 | 110 / 35 | 12 | 04:59:42.287804 |
| Lora-1 | 110 / 52 | 12 | 04:48:38.281600 |
| Lora-2 | 114 / 44 | 12 | 05:01:41.916459 |
| Lora-3 | 114 / 44 | 12 | 04:46:57.420985 |

Lilly-2 G6882–G6887 each records two missing-hot-head observations; G6888–G6893
each records one. Those 18 repeated observations bring the cumulative total
to 165,266; they are not eighteen distinct missing messages or proven losses.
The previous overlap cluster and 57/146/146/3 sequence remain historical.
G6883 adds one exclusion-reason occurrence and G6890 adds two. Cumulative
state-change observations become 2,405 and known exclusion occurrences nine.
Flags remain 13; the other newly added reason fields have known sums of zero.
No old/new provider fields or causal explanation were newly inspected.

Each of the six added reason counters is now known on **398 rows** (382 complete,
16 incomplete), absent on **538** legacy rows and explicitly null on **one**.
All 72 new rows have known counters. The 252 incomplete rows still comprise
231 uncertified/partial reports and 21 overlap guards. Twenty-three historical
rows have null comparison boundaries: 16 uncertified/partial and seven overlap
guards. No new row has a null boundary. Twelve new Ari-1 rows have no virtual
stop. `completeCoverage=true` on an incomplete row does not certify a comparison;
null boundaries cannot establish a primed baseline.

Unknown-material observations remain **403,215**. New material-lag samples
total 92,925, describing known-head diagnostics rather than fresh event-to-reader
latency. The per-field coverage and historical-age maxima remain in the summary.
Lora-1 G4830 is unchanged: 2,364 overlapping changed-head/rollback observations,
previously paired to 2,363 raw clearings plus one unresolved pre-apply occurrence.
None of these counters repairs the material-reader coverage gap or clears A0.

## Recorded HTTP attempts and coverage

| Cumulative measurement | Current | Change from previous snapshot |
| --- | ---: | ---: |
| Physical attempts | 104,266 | +11,127 |
| Retry ordinals, subset of attempts | 4,416 | +1,186 |
| Retry outcomes, subset of attempts | 4,418 | +1,186 |
| Failed attempt outcomes | 1,430 | +393 |
| HTTP 429 attempts | 0 | 0 |
| Attempts with unknown bytes | 7,042 | +1,671 |
| Known captured-object bytes | 6,774,440,090 | +659,090,762 |

All 393 added failed outcomes concern `media_stats` / `media_offer_stats` on
14 September: **386 HTTP 500 and seven transport failures**, across all six
pages. Of them, 326 have recorded `recovery` source and Ari-1's 67 have scheduled
source. This is recorded request provenance, not evidence of a recovery action
performed by this observation. The same operation adds 1,173 retry outcomes;
the stream adds 1,800 total attempts and 234 successes. The previous snapshot
already contained 1,036 media-stats failures, including 303 / 321 / 405 failed
HTTP 500 outcomes on 11 / 12 / 13 September, respectively; their retry-500
counts were 927 / 955 / 1,208. This is an existing failure class, not a newly
proved outage. These daily buckets have unequal durations. Current endpoint availability,
unique failing objects and causation cannot be inferred from these cumulative
day buckets. Exact signed bucket differences are retained in `summary.json`.

DM conversation attempts add seven transport retries and zero failed outcomes.
DM run coverage totals 11,006 (+819), with failed runs still 34, lost reports
still eight and unknown runs still one. All six pages make diagnostic progress.
HTTP coverage totals 24,946 overlapping runs (+2,487). Unknown runs rise four
to six: the new scheduled `fan_earnings` buckets are Lilly-2 and Lora-2 on
14 September. The three boundary runs remain. Known unfinished/unrecorded
attempt sums are zero; unknown runs and lost diagnostics remain uncovered.
There are 145 groups with null captured-byte totals. Captured-object bytes are
not wire traffic, and this observation measures no attributable savings.

## Evidence and gates

The original window starts **10 September 22:58:33.610 UTC** and this export ends
at **14 September 05:08:30.553593 UTC**. The earliest seven-day report stays
**17 September 22:58:33.610 UTC**, not automatic acceptance. Full polling and
the existing stage gates remain. No A1 activation or shortened observation gate
is authorized by this report. Independent artifact review is **pending**.

The existing reviewed `read-report.py` performed one report query as
`read_only` inside `BEGIN READ ONLY`, with a local 20-second statement timeout.
It completed at **05:08:39.909054 UTC**, exit zero. The receipt's role/mode,
normalized/raw report equality, current and previous SHA-256 hashes and
manifest row count were verified locally. All starts are within the window;
no selected row has a post-cutoff timestamp. This export is non-atomic, so zero
selected running rows does not prove absence of active work.

Report SHA-256: `34def0bd2cd881486dbefc6e2035bf600254d5c2ae62279640cb14e3ecabb5e8`.
The [summary](summary.json), [raw receipt](read-receipt.json),
[manifest](report.json.manifest.json), [invocation](export-invocation.json) and
[local analysis](analyze.py) retain reproducible evidence. The
[previous observation](../snapshot-20260913T230856Z/REPORT.md) and exact
pre-update local state/documents are preserved. Runtime/configuration evidence
belongs to the coordinator; this SQL export does not prove current effective
flag values or historical continuity. No additional production query, provider
request, code/PR change, flag, socket, deploy, recovery or automation action was
performed by this observer.

## Review completion — 2026-09-14T05:27:59.628465+00:00

The pending review above is complete: [independent review](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260914T050824Z/REVIEW-A0.md).
No open actionable findings remain. Numerical content is unchanged from
`REPORT.before-review-completion.md`. This closes the packet review only;
no stage gate or bounded observation-report delivery is declared.
