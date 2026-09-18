# A0 measurement-only shadow: observation in progress

Latest: [14 September, 11:06 observation](activation/20260910T225618Z/snapshot-20260914T110648Z/REPORT.md).
The cumulative report has **1,009 sweeps: 757 complete, 252 incomplete, zero
selected running**. All 937 prior rows are unchanged; all 72 new rows complete,
twelve per page. Lilly-2 adds twelve repeated hot-head observations; no new
state, flags, reason or rollback counters appear. Each reason field is known on
470 rows, absent on 538 and null on one. Unknown material remains 403,215.

HTTP attempts total 109,663 (+5,397), with one new earnings timeout retry and
no additional failed/429 outcomes. Unchanged media attempts do not prove recovery.
DM failed/lost/unknown totals stay 34 / 8 / 1. HTTP unknown runs change six to four
as two earnings buckets become known; the report does not infer a repair cause.
All six pages progress; no changed owner action is established. A0 remains
**NO-GO**, full polling is retained, and the earliest seven-day report stays
**17 September 22:58:33.610 UTC**. Independent artifact review is pending.
Runtime/configuration is separate; cumulative snapshots are never added.

Previous snapshot (historical): [14 September, 05:08 observation](activation/20260910T225618Z/snapshot-20260914T050830Z/REPORT.md).
The cumulative report has **937 sweeps: 685 complete, 252 incomplete and zero
selected running rows**. All 72 new rows completed (twelve per page); every
previous row is unchanged. Lilly-2 adds three exclusion-reason occurrences and
18 repeated missing-hot-head observations. Each added reason field is known on
398 rows, absent on 538 and null on one. Historical unknown material remains
403,215; incomplete/priming coverage and the existing early-stop counterexample
remain. Original seven-day earliest report: **17 September 22:58:33.610 UTC**.

Recorded HTTP attempts total 104,266 (+11,127); failed outcomes add 393, all
media-offer stats (386 HTTP 500, seven transport), with 1,173 associated retry
outcomes. This failure class was already present on the preceding three days;
new dated counts do not establish a new outage or cause. DM failed/lost/unknown
run totals remain 34 / 8 / 1, HTTP 429 remains zero, and all six A0 pages progress.
Two new earnings buckets have unknown HTTP coverage. The A0-only recommendation
is quiet; acceptance remains **NO-GO**, and independent artifact review is
pending. Runtime/configuration evidence is maintained separately by the
coordinator. Snapshots overlap and are never added; no savings or event latency
is inferred.

Previous snapshot (historical): [13 September, 23:08 observation](activation/20260910T225618Z/snapshot-20260913T230856Z/REPORT.md).
The cumulative report has **865 sweeps: 613 complete, 252 incomplete, zero selected
running rows**. All prior 787 rows are unchanged; 78 new rows are 71 complete and
seven Lilly-2 incomplete. Six overlap guards and one uncertified comparison are
followed by completed G6878–G6881. Missing-hot-head observations rose from two
per completed sweep to **57 / 146 / 146 / 3**, then fell in the latest sweep;
these are repeated observations, not distinct missing messages or proven loss.

Four flags occurrences and one exclusion-reason occurrence were added. Each
new reason field is known on 326 rows, absent on 538 and null on one. Historical
unknown material remains 403,215. DM failed runs rose 28 → 34 on Lilly-2; lost
reports remain eight and unknown runs one. HTTP attempts total 93,139 (+6,514),
retry ordinals 3,230 (+13), failed outcomes 1,037 (unchanged). Four HTTP unknown
runs and three boundary runs remain. Do not add snapshots or infer savings.

A0 early acceptance remains **NO-GO**; full polling and the original clock remain.
The earliest seven-day report is **17 September 22:58:33.610 UTC**. Cause and reader
impact of the new cluster are unproven; no changed operational action is established.
Independent artifact review is pending. The separate
[23:09 runtime and 23:10 configuration packet](heartbeat-runtime-20260913T230945Z/REPORT.md)
does not prove per-role application versions or historical flag continuity.

Previous snapshot (historical): [13 September, 17:07 observation](activation/20260910T225618Z/snapshot-20260913T170727Z/REPORT.md).
Its independent [review](heartbeat-runtime-20260913T170716Z/REVIEW.md) passed;
that verdict applies to the previous packet. Exact pre-update local documents
are retained with the latest snapshot. The separate
[completed-day traffic measurement](../fansly-cost-latency-measurement-20260913T094049Z/MEASUREMENT.md)
records load change without proving migration savings or event latency.

Previous snapshot (historical): [13 September, 05:08 observation](activation/20260910T225618Z/snapshot-20260913T050855Z/REPORT.md).
The cumulative report has **641 sweeps: 400 complete, 241 incomplete, zero running**.
There are 58 new complete rows; two prior running rows completed and all 581
prior terminal rows remain unchanged. Lilly-2 G6838 supplies the first positive
retained exclusion-reason counter (one occurrence); three additional flags
occurrences belong to the already known discrepancy class. There is no thread,
value, direction or content-loss attribution and no changed operational action.
Each added reason field is known on 102 rows (97 complete, five incomplete),
absent on 538 and null on one. Unknown material remains 403,215; eight DM lost
reports and one unknown DM run remain. HTTP unknown runs are six, including
new scheduled fan_earnings unknown buckets for Lora-2 and Lilly-2.

Lora-1 G4830 remains 2,364 runtime head/rollback occurrences versus 2,363 paired
raw clearings plus one pre-apply unknown. The early-stop candidate stays **NO-GO**;
full polling, the original seven-day clock and all acceptance gates remain.
The [05:07 runtime receipt](heartbeat-runtime-20260913T050749Z/runtime.json)
shows the same image/source label `380326368fe3`, all roles healthy, zero restarts;
ordinary API/database health is ok with an 11 ms database probe. This is not a
protected deployment gate. The [05:08 Chrome attempt](heartbeat-runtime-20260913T050749Z/configuration-read.json)
was unavailable. The 01:00:36–41 UTC visible configuration receipt remains
historical; no fresh effective-value or uninterrupted-continuity proof is claimed.
The A0-only notification recommendation is quiet; independent artifact review is pending.

Previous snapshot (historical): [12 September, 18:37 observation](OBSERVATION-20260912T183741Z.md).
All 87 newly selected sweeps are complete with zero unknown material checks;
the earlier running sweep also completed. Cumulative: 276 complete, 236
incomplete, zero running. Four new generic state-change observations remain
unexplained by retained raw metadata. Current-container logs have no matching
material or persistence warnings, but earlier containers remain outside that
read. Keep the original seven-day clock and unresolved freshness/savings gates.
Snapshots are not additive, and exact effective configuration was not reread.

The owner approved the explicit six-page shadow enable with “давай”.
Only `fanslyDmShadowPageAllowlist` changed, through the authenticated normal
Configuration UI. Full polling, history, head catch-up and replay policies
remain unchanged. No deployment, socket or A1 action was performed.

| Event | UTC | Moscow |
|---|---|---|
| Save dispatched | 10 September 22:57:40.139 | 11 September 01:57:40.139 |
| All three active roles first observed with the exact allowlist | 10 September 22:58:33.610 | 11 September 01:58:33.610 |
| Earliest seven-day observation point | 17 September 22:58:33.610 | 18 September 01:58:33.610 |

Allowlist: `ari-1,lilly-1,lilly-2,lora-1,lora-2,lora-3`.
Observed propagation upper bound: 53.471 seconds from the save dispatch.
The Configuration read at 23:01:04 UTC showed 59 editable controls with
exactly one changed control. Head catch-up was `none`; replay was `off`.
The activation used deployment image `148188403f92...`, source `a3caa0e9`.

Evidence: [configuration receipt](activation/20260910T225618Z/configuration-verified.json),
[pre-activation health](activation/20260910T225618Z/runtime-before.txt).

## First report

Window `[22:58:33.610, 23:02:00.177131)` UTC, read completed at 23:02:02.246750.
The read-only identity, READ ONLY transaction and SHA-256 manifest passed.

- 116 recorded physical attempts, all HTTP 200 / success, zero retry ordinals.
- 28 overlapping runs; two unknown loss-counter runs and three boundary runs.
  Known lost-insert / unfinished-update counter sums were zero.
- A live Lilly-1 shadow row reached page 13 across two resumes; virtual stop
  was page 4, and the full sweep continued for nine more pages. This directly
  shows that production measurement runs past its candidate stop.
- That row is **running**, not an accepted completed comparison. Its current
  below-stop discrepancy counters were zero. Thirty pending-history entries
  have unknown due-origin age. The 1,299 material receipt samples concern
  previously known heads and do not measure fresh-event-to-reader latency.
- DM run receipts were visible for Lilly-1, Lilly-2 and Lora-2; one was still
  unknown and none reported a lost diagnostic row. The other pages and full
  sweep completion are not proven by this short observation.

[Report](activation/20260910T225618Z/snapshot-20260910T230200Z/report.json),
[manifest](activation/20260910T225618Z/snapshot-20260910T230200Z/report.json.manifest.json),
[summary](activation/20260910T225618Z/snapshot-20260910T230200Z/summary.json).

At 23:06:20 UTC all three roles remained healthy on the same image, with zero
restarts and 27 GiB free; API/DB health was OK. The bounded worker-log sample
had no shadow-persistence error. It did contain the existing
`obs_backlog_webhook_ofapi_v5` threshold warning: the same breach category was
present before activation at 22:45–22:56 UTC and afterwards. This is an open
OnlyFans observation backlog, not a newly observed Fansly shadow error; the
log messages alone do not quantify whether its severity changed. Two
transaction lower-bound stop warnings were also retained separately.

[Post-activation health](activation/20260910T225618Z/runtime-after.txt),
[bounded log check](activation/20260910T225618Z/worker-log-check.json),
[before/after warning evidence](activation/20260910T225618Z/golden-signal-before-after.json).

## Cumulative observation through 00:34 UTC

Cumulative window: 10 September 22:58:33.610 UTC through 11 September
00:34:30.513788 UTC. This replaces the previous short snapshot; do not add them.
The read_only / READ ONLY receipt, 20-row sweep count and SHA-256 manifest
`912122b7822d5e627cef11b099233aca6f64307439f263980aa2f0a2cf6e732c` were verified.

- 3,007 physical attempt rows: 2,697 success, 240 retry-state, 70 failed-state.
  Retry ordinal >1 totals 239; these are different dimensions. Of the 70 failed
  rows, 66 are media-offer HTTP500 and four are media-offer transport failures.
- 647 overlapping runs; four loss-counter unknowns and three boundary runs.
  Known unrecorded/unfinished sums remain zero. Zero does not cover unknown rows.
- 16 completed comparisons across all six pages; three running and one incomplete.
  Lilly-2 generation 6751 stopped at the existing snapshot-overlap guard.
  An incomplete comparison is excluded from acceptance even if its internal
  `completeCoverage` scalar was previously true.
- Completed-sweep hot-head mismatch occurrences: Lilly-1 141, Lilly-2 9,120,
  Lora-1 three; other pages zero in this cohort. These are repeated observations,
  not distinct lost messages. Archive/serving presence remains unverified.
- 3,800 unknown material observations across the current cohort. The bounded
  worker log has 39 material-check statement timeouts from 00:25:31 through
  00:34:27, at the existing 500ms query budget. Full polling continues. Causal
  attribution to load, the release or earnings replay has not been established.
  A subsequent read-only snapshot found the exact lookup indexes in place and
  no waiting relation lock. Docker CPU samples were PostgreSQL 276%, worker
  145%, API 137%; those samples identify concurrent load, not its cause.

At 00:33:18 UTC, all three roles were healthy with zero restarts and 25 GiB
free on image `f742e86eca4c...`, source `32478124`. This differs from the initial
A0 image; this turn did not deploy it. The worker container started at 23:35:33 UTC (API/scheduler at 23:35:22);
the deployment dispatch was not observed. A0 reports continued after the release. Configuration was
not freshly inspected; the last full UI verification remains 23:01:04 UTC.
The measurement interval therefore includes an intervening release and must
not be treated as one unchanged-runtime cohort.

[Snapshot and summary](activation/20260910T225618Z/snapshot-20260911T003430Z/summary.json),
[read manifest](activation/20260910T225618Z/snapshot-20260911T003430Z/report.json.manifest.json),
[runtime](activation/20260910T225618Z/snapshot-20260911T003430Z/runtime.json),
[bounded warning check](activation/20260910T225618Z/snapshot-20260911T003430Z/worker-log-check.json).

## Continued observation

The active thread heartbeat `fansly-a0-shadow` reads reports every six hours.
It performs production reads only and notifies on meaningful change, failure,
required owner action or the seven-day report. It cannot deploy, flip flags,
restart/replay/recover, open a socket or advance A1. The older Lilly-2 canary
heartbeat remains paused.

Use the reviewed `read-report.py` with explicit `--from` equal to
`2026-09-10T22:58:33.610Z`, `--to` equal to the current UTC time, and a fresh
timestamped `--output` directory under `activation/20260910T225618Z`.
Snapshots are cumulative: late completions update earlier run/sweep rows, so
never sum snapshots or treat moving unknown counts as independently lost work.
If a wake occurs beyond eight days, pin the end to the seven-day boundary and
label the delayed read; never enlarge the database reader's window cap.

The seven-day date is a minimum observation period, not an acceptance or an
automatic stop. Check all six pages, activity, incomplete/unknown/lost ratios,
material coverage, history and current-window sensitivity. The historical
candidates already missed changes. Actual HTTP savings, fresh-event latency
and A1 safety are still unproven. The heartbeat pauses after delivering that
report; further flags or A1 actions remain separate owner decisions.

## C1 diagnostic runtime boundary — 11 September 01:05 UTC

The owner-approved C1 diagnostic source `d47dc9b09f87` replaced main
`32478124`. Its worker started at 01:05:57.089214971 UTC; all three roles
were healthy with zero restarts at 01:07:45 UTC, with 25 GiB free. The
standard deploy exited 1 at 01:33:29 UTC after its protected sync-health
gate failed. No automatic rollback ran because the schema changed; see
[the C1 deployment report](../fansly-c1-deploy-2026-09-11/REPORT.md).

No flag changed. Keep the original shadow start and the earliest seven-day
point; classify the observation as spanning multiple runtime revisions. The
existing six-hour heartbeat now retains C1 diagnostic decisions as well. Its
A0 schedule, quiet-notification rule and seven-day pause are unchanged.
At that handoff the latest A0 measurement was the 00:34:30 snapshot. The
following cumulative report supersedes it; the C1 export covers a different
interval and must not be added to either A0 report.

## Cumulative observation through 02:58 UTC: coverage degraded

The read-only export ending **11 September 02:58:38 UTC** contains 43 sweeps:
17 complete, 25 incomplete and one running. Its verified SHA-256 is
`80cc7653352c4f83f7eea1349e190101cc81c91823ebf0d58571be4ce62aea2c`.
This replaces the 00:34 snapshot; late outcomes and cumulative counters must
not be added across snapshots. The A0 export is not an atomic snapshot.

- Twenty-four sweeps have uncertified or partial diagnostics; one Lilly-2
  sweep hit the snapshot-overlap guard. Complete sweeps exist on all six pages.
- Material checks are unknown for 49,215 observations. These are repeated
  observations, not distinct missing messages. The DM coverage receipts record
  one lost-report run each on Lilly-1 and Lilly-2, and three failed DM runs.
- The window retained 5,288 physical attempts, including 780 retry ordinals
  and 230 failed-state rows. HTTP coverage has two unknown-counter runs and
  four boundary runs. These are costs and coverage limits, not measured savings.
- The separate bounded worker-log window, 01:05:57–02:53:01 UTC, contains
  346 unavailable-material-check warnings and six report-persistence warnings.
  This shorter interval cannot be added to the earlier warning sample.
  The cause and any relation to a deployment remain unproven.

| Page | Complete | Incomplete | Running | Unknown material observations |
|---|---:|---:|---:|---:|
| ari-1 | 4 | 4 | 0 | 715 |
| lilly-1 | 3 | 5 | 0 | 6,400 |
| lilly-2 | 2 | 2 | 1 | 4,700 |
| lora-1 | 3 | 4 | 0 | 21,700 |
| lora-2 | 2 | 5 | 0 | 8,900 |
| lora-3 | 3 | 5 | 0 | 6,800 |

The same three C1 runtime roles were healthy at 02:52 UTC, with zero restarts,
API/database health OK and about 24 GiB free. The protected sync-health gate
remains failed. No deployment, flag change or calendar restart occurred during
this follow-up; the last full configuration verification remains 23:01:04 UTC.

The earliest seven-day point remains **18 September 01:58:33 Moscow**.
These incomplete and unknown observations prevent an A0 acceptance claim;
the calendar alone cannot pass the gate. Full polling continues. Material
coverage, discrepancies, loss receipts and fresh-event latency remain open.

[Summary](activation/20260910T225618Z/snapshot-20260911T025838Z/summary.json),
[manifest](activation/20260910T225618Z/snapshot-20260911T025838Z/report.json.manifest.json),
[bounded log summary](../fansly-c1-deploy-2026-09-11/followup-20260911T025228Z/follower-attempt-summary.json).

## Cumulative observation — 11 September 05:07 UTC

Window end: **05:07:39 UTC**; read completed at 05:07:49.091911. The
`read_only` / READ ONLY receipt, 69 sweep rows and SHA-256 were verified:
`747f27b29397f9fdf2a60d83dfeb35c42f4c6886255ad37154b8442204c7b024`.
This cumulative export supersedes the earlier A0 snapshots. Late row updates
remain possible; the export is not an atomic frozen history.

| Page | Complete | Incomplete | Running | Unknown material observations |
|---|---:|---:|---:|---:|
| ari-1 | 5 | 7 | 0 | 1,015 |
| lilly-1 | 3 | 9 | 1 | 10,300 |
| lilly-2 | 2 | 4 | 0 | 10,500 |
| lora-1 | 3 | 8 | 1 | 37,800 |
| lora-2 | 2 | 10 | 0 | 15,100 |
| lora-3 | 3 | 11 | 0 | 11,200 |

There are **18 complete, 49 incomplete and two running sweeps**. Forty-five
incomplete rows have uncertified/partial diagnostics; four hit snapshot-overlap
guards. No separate priming status is returned. The 85,915 unknown material
observations are repeated checks, not distinct missing messages. DM coverage
has two lost-report runs, three unknown receipts and eleven failed runs.

The window retained 7,100 physical attempts, including 873 retry ordinals,
256 failed-state rows and zero HTTP 429 rows. HTTP coverage reports eight
unknown-counter runs and three boundary runs. Zero known lost/unfinished
attempt counters do not cover unknown runs. The separate C1 runtime log window
01:05:57–05:07:39 contains 731 material-check warnings and six report-persistence
warnings; do not add it to previous cumulative log counts.

Lilly-2 generation 6753 now contains one state-change observation below the
virtual stop at page four. Its narrower head-ID, unread and flag counters are
zero; the exact remaining subtype is not exported. The sweep is incomplete
with 3,500 unknown material checks, so it cannot enter the accepted comparison
denominator. The observation is not evidence of a lost new message.

Docker observed the worker restarted at **03:08:13.699 UTC**, still on source
`d47dc9b09f87`. A pg-boss pool checkout timeout emitted an error and the existing
handler exited the process. Subsequent logs show resumed work. The checkout
timeout's underlying cause and any relationship to protected sync-health are unproven.
Startup orphan-cleanup count zero does not exclude interrupted runs with valid
leases; retain their telemetry uncertainty. No restart was issued by this task.

At 05:06 UTC all three roles were healthy; worker restart count one, API and
scheduler zero, about 24 GiB free. API/database health passed (probe 311ms).
The protected deploy gate remains failed. Direct reads of configuration and
runtime-instance tables are denied to `read_only`; the exact allowlist was
not freshly verified. Recent shadow activity exists on all six pages, with no
confirmed flag interruption. No flag action or calendar restart occurred.

The earliest seven-day point remains **18 September 01:58:33 Moscow**. The
coverage, discrepancy and freshness gates remain open. The pending one-use
planner-only EXPLAIN has not run; this heartbeat does not authorize it.

[Summary](activation/20260910T225618Z/snapshot-20260911T050739Z/summary.json),
[manifest](activation/20260910T225618Z/snapshot-20260911T050739Z/report.json.manifest.json),
[runtime](../fansly-c1-deploy-2026-09-11/followup-20260911T050632Z/runtime.json),
[bounded log summary](../fansly-c1-deploy-2026-09-11/followup-20260911T050632Z/worker-log-summary.json).
