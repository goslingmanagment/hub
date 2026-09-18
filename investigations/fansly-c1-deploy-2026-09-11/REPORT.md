# C1 diagnostic deployment — 11 September 2026

Latest: [14 September, 11:07 observation](followup-20260914T110744Z/REPORT.md).
The exhausted six-page timeline contains 2,937 unique runs; all 2,845 prior rows
are unchanged. New decisions are 33 no-request and three mismatch requests;
all 117 cumulative requests have later exact-generation terminals. Three new
valid terminal receipts retain two retirement and one grace-only occurrences.
Historical gaps remain 47 terminal membership receipts and 78 incremental final
receipts; no new failure or gap appears. Physical attempts are 12,869 (+344),
not measured savings. PR166 remains merged; policy and deployment gates are
unchanged. Independent review passed; [review receipt](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260914T110644Z/REVIEW-C1.md); runtime/configuration belongs
to the coordinator's separate packet.

Previous observation (historical): [14 September, 05:11 observation](followup-20260914T051155Z/REPORT.md).
The exhausted six-page timeline contains 2,845 ordered unique runs; all 2,604
prior rows are unchanged. Of 457 valid decisions, 343 request nothing and 114
request from clean queues, each with a later exact-generation terminal. Ten new
terminal receipts retain six retirement and five grace-only occurrences. The 47
historical membership gaps are unchanged; missing final incremental receipts
rise to 78 because 18 new partial chunks precede Lora-1's settled decision.
Cumulative follower attempts are 12,525 (+1,084), with no added retry ordinal or
failed/429 row. No suppression, presence-equivalence, savings or gate is proven.
Retained final receipts establish PR166 merged at 00:29:23 UTC; dated draft labels
below are historical. No production deployment occurred in this heartbeat.
Independent numerical review is pending. Runtime/configuration belongs to the
coordinator's separate packet.

Previous observation (historical): [13 September, 23:10 observation](followup-20260913T231017Z/REPORT.md).
The exhausted six-page timeline contains 2,604 ordered unique runs; all 2,493
previous rows are unchanged. Of 421 valid decisions, 316 request nothing and
105 request from clean queues, each with one later exact-generation terminal.
Six new valid membership terminals retain four retirement and two grace-only
occurrences. The same 47 historical membership and 60 incremental receipt gaps
remain. Lilly-1, Ari and Lora-1 have later matching comparisons; relation identity
and atomic active-after remain unknown. Cumulative follower attempts are 11,441
(+446), with six additional retry ordinals and no failed/429 attempt rows.
No suppression, presence-equivalence, savings or stage result is established.
Independent numerical review is pending. Runtime/configuration fields are
maintained separately by the coordinator.

Previous observation (historical): [13 September, 17:09 observation](followup-20260913T170906Z/REPORT.md).
The exhausted, non-atomic five-page timeline contains 2,493 unique runs;
all 2,289 previous rows are unchanged. There are 385 valid decisions: 286
no-request and 99 clean-queue requests, each with one later exact-generation
terminal. All 11 new terminals have valid membership receipts; the same 47
historical terminal gaps and 60 missing incremental decisions remain.
Lora-2 and Lora-3 have later matching no-request comparisons after further
natural reconcile receipts; relation identity and atomic active-after remain
unproven. Cumulative follower attempts are 10,995, not savings. No suppression,
presence-equivalence or stage gate changes. Independent [review](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260913T170716Z/REVIEW.md) passed with no open actionable findings.
Current runtime/config fields are maintained separately by the coordinator.

Shared [17:07 runtime and 17:08 configuration evidence](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260913T170716Z/REPORT.md)
shows the unchanged healthy image and visible allowlists. Per-role application,
continuous history and the current protected deploy gate remain unverified.

Previous observation (historical): [13 September, 11:09 observation](followup-20260913T110957Z/REPORT.md).
The exhausted, non-atomic five-page timeline contains 2,289 unique runs;
all 1,833 previous rows are unchanged. There are 349 valid decisions: 260
no-request and 89 clean-queue requests, each with one later exact-generation
terminal. Twenty-two new terminal membership receipts extend the natural grace
and retirement evidence; the 47 historical missing membership receipts remain,
with none new. The 22 added missing incremental decisions are partial chunks.
Lilly-2 generation 797 retired one candidate and has three later matching
no-request comparisons. Cumulative follower attempts are 10,102, not savings.
Presence equivalence, safe suppression and all stage gates remain unproven.
The 11:09 packet passed independent numerical review with no open findings;
runtime/configuration observations are recorded separately by the coordinator.

Previous observation (historical): [13 September, 05:08 observation](followup-20260913T050808Z/REPORT.md).
The exhausted, non-atomic four-page timeline contains 1,833 unique runs;
all 1,710 previous rows are unchanged. There are 313 valid decisions: 245
no-request and 68 clean-queue requests, each with one later exact-generation
terminal. The three new terminals record grace protection and one actual
retirement; 47 historical membership gaps remain, with no new missing receipt.
Cumulative follower attempts are 7,950, not savings. Source `380326368fe3`
remained healthy on all three roles with zero restarts at 05:07 UTC.
PR166 remains draft at `3a6eace1`, with five required CI checks passed in its
retained receipt. No policy, presence-equivalence or deployment gate changed.

Previous observation (historical): [13 September, 00:16 observation](followup-20260913T001617Z/REPORT.md).
The exhausted, non-atomic four-page timeline contains 1,710 unique runs and
283 valid decisions: 65 clean-queue requests, each with one later exact terminal,
and 218 no-request decisions. Forty-seven historical membership receipts remain
absent; no new terminal lacks one. No suppression or presence-equivalence gate
is passed. Source label `380326368fe3` was healthy on all roles at 00:15 UTC.

Previous observation (historical): [12 September, 18:37](followup-20260912T183741Z/REPORT.md).
Lilly-2 generation 792 completed with two actual retirements and later matching
counts. All 49 observed clean-queue requests have an exact-generation terminal.
At 18:38 UTC the three roles were healthy on `31b73a96`, preserving restored
membership diagnostics. Three older missing-writer receipts remain unknown.
Both independent reviews are clean. C1 policy, presence equivalence, A0
acceptance, physical savings and fresh-event latency remain open.
The following dated release records are historical.

At 19:48 UTC, runtime was `66d6ac1a`: the owner-approved combined C1 release with
merged [PR172](https://github.com/goslingmanagment/core/pull/172) and PR171.
The standard deploy exited **0** at 11 September **19:47:07 UTC**. Protected
sync-health returned **200** with all eight pages, after two 150-second timeouts;
the successful request took **133.3 seconds**. Its latency remains unresolved.
API, worker and scheduler were healthy with zero restarts at 19:48, their
compiled files matched the approved build, and the production-pinned CLI passed.

The [deployment report](../fansly-c1-deploy-2026-09-11/health-deploy-20260911T191946Z/REPORT.md)
retains the actual exit, response bodies, log timings, image/CLI evidence and
independent review. The exact approved tree had 3251 passing unit tests, nine
existing skips, 81 real Postgres tests without skips and all five CI checks.
All 179 migration files were retained; no flag was changed.

The first new-runtime window ends at 19:49:43 UTC: C1 has two valid no-request
decisions. A0 has one incomplete sweep, three running, none complete and 1100
unknown material checks; DM coverage includes one lost-report receipt in an
intersecting run, which cannot be attributed to the release. These are coverage
gaps, not distinct lost-message counts. This window is not added
to older snapshots. The original A0 clock and all other stage gates remain.
The approved deployment and earlier one-use EXPLAIN permissions are consumed.

The following dated records retain the earlier deployments and observations.

The owner approved deployment of reviewed source
`d47dc9b09f87988a53bd80435f0d11534beba15c` from
[PR166](https://github.com/goslingmanagment/core/pull/166).
The diagnostic code is running. The standard deploy script exited **1** at
01:33:29.249597 UTC because the protected sync-health gate did not complete.
This is not a successful deployment-gate result; C1 remains a draft.

The last cumulative window ends at **17:07:08 UTC**: 430 retained runs, 97 valid incremental
decisions, 84 no-request and 13 clean-queue count mismatches. One failed Lora-2
incremental run has an unknown decision. Lora-3/1520 completed in generation 771
after generation 770 failed membership proof: 156 attempts, 50m27.337s across both
walks, then six matching no-request decisions. Lora-1/1250 has a similar internal
retry and was still partial at that cutoff; its later completion is recorded above.
Suppression and savings are not established.

Costs are 197 scheduled incremental, 1,197 anomaly reconcile and 273 scheduled
reconcile attempts. Exactly 429 runs finished before cutoff have one summary
each; their 1,665 attempts leave two extra persisted Lora-1 attempts unattributed
to a run. Boundary run 726856 finished after the requested end. Its later 3,000-row
checkpoint must not replace the 2,500 rows completed before cutoff. Low tail-log
counts proved insufficient; time-only retries restored the early interval.

At 17:06 all roles were healthy on the same source, with no new worker restart,
23.94 GiB free and a 20ms ordinary database probe. The protected deploy gate remains
failed. A0's new 66-sweep cohort has no complete sweep; coverage remains degraded.
That 17:07 observation performed no runtime, migration, flag, test or EXPLAIN
action. Its historical validation was 3,210 unit and 70 Docker-Postgres tests
on `13537b6b`; the newer combined-candidate results are recorded above.

[Latest summary](followup-20260911T170629Z/snapshot-20260911T170708Z/summary.json),
[manifest](followup-20260911T170629Z/snapshot-20260911T170708Z/report.json.manifest.json),
[log summary](followup-20260911T170629Z/worker-log-summary.json),
[runtime](followup-20260911T170629Z/runtime.json).
The previous window is retained in its [summary](followup-20260911T110759Z/snapshot-20260911T110856Z/summary.json).

## What changed and what was checked

The C1 delta names and records the existing follower decision predicates,
retains the atomic queue receipt and installs two restricted read functions.
No predicate, cadence, presence writer or flag changed. The production base
already included C2a/C2b code; this deployment does not bump their parser again.

- `pnpm check`: 3,205 tests passed in 292 files, nine existing skips. The
  strictness baseline remains 1,908 known errors in 121 files. Lint and build pass.
- Serial Docker-Postgres: 70 tests in five suites, no skips, 27.03 seconds.
  These cover real handler/queue receipts, all decision branches, lease and
  generation guards, membership outcomes, pagination and restricted access.
- The local production build and all five GitHub checks passed on `d47dc9b0`:
  [CI run](https://github.com/goslingmanagment/core/actions/runs/34547632176).
- Independent code review is closed. The separate export helper was also
  reviewed; its cursor-variable finding was fixed before first execution.

## Production evidence

Evidence directory: `20260911T005704Z/`. Deployment started at
00:58:05.966 UTC using the standard dist-only script with image GC disabled.
The previous source was `32478124`, image `f742e86eca4c…`.

At 01:07:45 UTC, API, worker and scheduler were running and healthy with zero
restarts on image
`sha256:c8a5567e229b012bea7f2c63baf0c398aae3990cf04b8710b01e4f08b99fe851`.
Its source label is `d47dc9b09f87`, dependency checksum
`f4612198158624cc37aaff52d11d72c4ef3f679d41df7386f52d039e29b74bee`.
The worker started at 01:05:57.089214971 UTC. At 01:08:55 UTC, the API and
database health checks were OK (database probe 7 ms); 25 GiB remained free.
The final check at 01:34–01:35 UTC confirmed the same image and three healthy
roles with zero restarts. API/database health remained OK (probe 1 ms), with
25 GiB free. The local Hub CLI was pinned to this actual source and its live
capabilities contract verified at 01:35:06 UTC; the previous install was kept.
At 01:36:18 UTC, a separate loopback read verified the dashboard HTML/root
mount, and both local and remote deploy locks were absent. These checks do not
override the failed protected-health gate or turn the script's exit into success.

At 01:06:30 UTC, catalog verification as `read_only` in READ ONLY confirmed
execute access to both C1 readers and the existing A0 report. Direct SELECT
on `sync_runs`, `sync_run_events` and `page_sync_states` remains denied.

The first report covers **01:05:57.089215–01:07:55.428842 UTC**. Its manifest
and payload SHA-256 were verified:
`e2cf141a31c299453c4a9a2eb4ed2e2f86dcd0d453450c3e75b58d5beee4f1d4`.
The three functions share one repeatable, read-only snapshot.

- One completed incremental run, on lora-3, with one valid decision receipt.
- Active and source counts both equal 7,551; zero new rows before the known
  checkpoint. All three predicates are false; no reconcile request was made.
- No missing, duplicate, malformed or unfinished receipt in this one-run cohort.
  The other five pages have no incremental run in this short window.
- Two physical follower-stream attempts, both successful: account metadata
  and the follower page. There is no full-reconcile run in this window.

This verifies the no-request diagnostic path in production. It does not measure
trigger frequencies across the fleet, completed-generation consolidation,
membership repair, request savings or provider-event-to-reader latency.
Pagination exhaustion covers retained rows only, not telemetry completeness.

A second cumulative export ends at **01:21:45.993638 UTC**, with snapshot time
01:22:04.754827 UTC. Its verified SHA-256 is
`d278bb130be2b6ba6831a5fd22eabe209a43ea0cb2266b92423d5c01a4c3f1f4`.
It contains the same single follower run and the same two follower attempts;
no full reconciliation appeared. Across all Fansly streams this later window
has 157 retained physical attempts: 111 success, 36 retry-state and 10
failed-state rows. These are interval counts, not a baseline comparison or a
complete request census. The two cumulative exports must not be added together.

## Verification caveat

Five protected sync-health attempts each exceeded the script's existing
150-second budget. The last owned SSH child then remained stuck for over ten
minutes, although its curl command had the same limit. A fresh read-only SSH
status check succeeded. At 01:33:03 UTC only that verified local SSH child was
terminated, allowing the standard script to record failure and run cleanup.
The sixth attempt is an interrupted SSH read, not a sixth measured HTTP timeout.
No parallel protected sync-health request, timeout increase or database query
cancellation was added.

Automatic rollback was skipped by the existing schema-change guard. The new
0182–0183 read functions are now applied and must not be edited or renumbered.
Any subsequent SQL change needs a new forward migration. A future rollback
still needs to retain the inherited C2a v2 readers. No guard was weakened and
no manual production rollback was performed. The protected-health issue needs
separate diagnosis; its cause and pre-deploy latency were not established.

At 01:11 UTC, one Docker sample showed Postgres at 303.78% CPU. The bounded
post-start logs contained no level-50-or-higher entries, but retained 18
warnings for unavailable DM shadow material checks, a warning already present
before this deployment. The 01:12 lock snapshot had no ungranted locks;
activity details for other database roles are not visible to `read_only`.
These observations do not establish the cause of the slow health summary.

`runtime-after.json` retains an initial image lookup that used an exported
config digest, which Docker did not resolve. `runtime-verified.json` uses the
actual container image ID and the deploy script's 12-character source label.
Those local verification corrections did not change production.

## Remaining work

C1 remains one draft PR. Retain natural incremental decisions and subsequent
completed reconcile runs, attribute each valid request to the actual terminal
revision/membership result, establish the headline/deletion/pagination cause,
then implement and independently review the narrow fix in PR166. Pending at
request time and sequence differences alone do not prove consolidation.
No new owner action is needed to collect read-only evidence.

The existing `fansly-a0-shadow` heartbeat now collects C1 evidence as well,
with the same six-hour cadence, notification preferences and A0 seven-day
pause. It may prepare the already authorized local C1 fix when evidence is
sufficient, but cannot deploy, enable a flag, replay, recover or create a
socket. Its updated prompt was read back and verified. A later runtime that
stops emitting C1 notes must be treated as an instrumentation boundary.

| Stage | State | Savings and latency / remaining coverage |
| --- | --- | --- |
| Pre-A0, PR157–162 | Fixes deployed; bounded repairs verified | Lilly-2 canary had zero eligible recovery attempts; effectiveness remains unmeasured. |
| A0/T0, PR164 | Shadow running across six pages | Earliest seven-day point: 17 September 22:58:33 UTC. Unknown material checks and discrepancies remain; A1 gate has not passed. |
| C1, PR166 | Diagnostics running; protected deploy gate failed | At 17:07 UTC: 97 valid decisions, 13 requests and 14 completed generations. No redundant generation, suppression fix or measured savings is established. |
| C2a, PR165 | Code present in production | Replay completion and projection repair acceptance unverified. |
| C2b, PR169 | Code present in production | Enablement and correction/max-age measurements unverified. |
| C2c | Gated | Candidate selection waits for C2b coverage and freshness/cost evidence. |
| W0, PR167 | Offline draft | Live Management Session protocol/fanout/presence/continuity checks remain gated. |
| A1, B0, B1 | Gated | No measured physical savings or fresh-event latency. |
| B2 | Not built | Requires a separate owner decision. |

Documentation-only commit `a0d9274dc23b87ff978759b3909c2315e8d5a42c` records
these results in PR166. It changes no runtime code or tests. The final report,
three Markdown changes and PR body passed independent review with no
actionable findings. The PR body was updated and read back exactly; it remains
a draft. The local tracked worktree is clean.

## Read-only follow-up — 11 September 02:53 UTC

The cumulative C1 snapshot ends at 02:53:01 UTC. All 75 timeline rows were
read atomically as `read_only` in READ ONLY, with verified SHA-256
`9e161a83bdd5bda6320e97b0628f350ccaf1aa2140ba2e0258bb23750942875a`.
This supersedes the earlier short C1 exports; do not add cumulative snapshots.
Pagination exhaustion establishes retained-row delivery, not provider completeness.

- All six pages produced incremental decisions: 11 valid receipts, nine
  no-request decisions and two Lilly-2 count-mismatch requests. Both requests
  arrived at clean queues, so pending-at-request is 0/2. Active/source counts
  were 18,325/18,324 on each receipt; the other two OR branches were false.
- Revision 2530/generation 780 completed 184 pages at 02:33:40.230 UTC, with
  18,324 generation rows matching the provider headline, `exact_generation`
  membership proof and zero deactivation candidates. Its 46 chunks used 206
  physical attempts, including 18 retries and no terminal failed attempts.
  The full-generation elapsed time was 54m43.140s.
- Revision 2531 was requested 2m22.028s later. Generation 781 has 18 partial
  chunks, 85 pages and 8,500 observed rows in this snapshot. It used 88 attempts,
  including one retry and no terminal failed attempts; completion is pending.
- Exactly one worker request-summary log maps to each of the 75 timeline run
  IDs. Their 294 reconcile and 22 incremental attempts agree with the persisted
  aggregates. No missing, unfinished or boundary attempt receipt is reported
  for these two streams in this cohort.

The existing absence rule protects a missing row seen in generation 779 from
deactivation in 780. It may be retired only if 781 also misses it, subject to
the live-touch guard. This is a compatible explanation, not an identified
production row: its exact identity/protection reason and intervening activity
remain unknown. The second walk must not be classified as redundant merely
because the first matched its generation count. Follow its terminal result
and the next incremental decision before changing the trigger.

Independent review identified a missing regression for the same absent row
across both generations. The small addition in the C1 worktree now proves it
survives G and is retired after G+1 also misses it, using real Postgres. The
review found no actionable issues. The full `pnpm check` passed 3,210 tests
with nine existing skips; five serial Docker-Postgres suites passed all 70
tests with no skips in 19.77s. Runtime code and applied migrations are unchanged.

### Protected sync-health remains unresolved

Bounded API logs contain all six deploy requests, but no completion event for
them. Client aborts can prevent completion logging; this does not prove the
queries remained active. Static review found all-history monitor aggregates
and window scans. No production plan or dominant-cost attribution is available:
`read_only` cannot access the tables or other roles' query details, and
`pg_stat_statements` is absent. One lock snapshot found no waiting lock.

A single planner-only operation is prepared and independently reviewed locally:
READ ONLY, `EXPLAIN (ANALYZE FALSE)`, 10-second statement limit, 2-second lock
limit and 25-second outer deadline. **It has not run.** Execution as `postgres`
requires a new explicit one-use owner exception to the read_only-only rule.
Planner estimates would still not establish actual query execution time.

At 02:52 UTC all three roles remained healthy with zero restarts on the same
source/image; API/database health passed with a 1ms probe and about 24 GiB free.
The separate A0 report ending 02:58:38 has 17 complete, 25 incomplete and one
running sweep, with 49,215 unknown material observations and two lost-report
runs. A0 coverage and the protected-health failure remain open; cause is not
attributed to this release. No savings or provider-event-to-reader latency is
established by either report.

Evidence: [C1 manifest](followup-20260911T025228Z/snapshot-20260911T025301Z/report.json.manifest.json),
[attempt and warning summary](followup-20260911T025228Z/follower-attempt-summary.json),
[health request logs summary](followup-20260911T025228Z/health-request-log-summary.json),
[runtime](followup-20260911T025228Z/runtime.json).

Commit `13537b6b69a20ed9680458de30fa47f104da520c` adds the tested grace regression and this RCA evidence to
PR166. It changes no runtime code or applied migration. Both independent
reviews are closed, including corrected reader-limit and runtime-time wording.
The pushed PR body was read back exactly; the PR remains open and draft.
No new production operation ran. The prepared planner-only read is the sole
new owner approval request; natural C1 and A0 observations remain authorized.

## Follow-up — 11 September 05:07 UTC

The new atomic READ ONLY C1 snapshot contains **136 unique ordered runs** and
exhausted pagination (`throughRunId=723455`). All 75 previous rows are retained
unchanged. Verified SHA-256:
`7e9606f43c8943543c080c9eabcd368cf9331f01817b435f0b38002ae766e011`.
There are 25 valid incremental decisions: 20 no-request and five count mismatches.
All five requested from clean queues. The other two OR branches remain unobserved.

Lilly-2 revision 2531/generation 781 completed at 03:12:52.315 UTC: 184 pages,
18,324 generation rows, `exact_generation` and one pre-UPDATE deactivation
candidate. It used 193 physical attempts, including five retries, in 35m41.620s.
The following incremental receipts at 03:33 and 04:35 both show 18,324/18,324,
all predicates false and no new request. Actual retired-row identity and its
protection reason are not exported. This supports legitimate two-generation
repair; there is no basis to suppress the second request.

Ari-1 generations 54 and 55 also went from zero to one candidate, using five
attempts each. Its next no-request decision is 211/211 with one processed row,
so the headline has changed. Lora-2 requested revision 1614 at 8,130/8,129 after
processing two rows. Generation 1576 remains partial: 21 completed chunks,
74 pages/7,400 rows, plus one running chunk. Follow its terminal result and
next incremental counts before choosing a policy change.

The report retains 52 incremental and 487 reconcile attempts, with two and 23
retries respectively and zero terminal failed attempts. Exactly 135 finished
runs have one worker summary each. The running Lora-2 run has no summary and
unknown loss counters. Completed reconcile summaries cover 485 attempts; two
additional retained Lora-2 attempts cannot be assigned to a run by the aggregate.
Neither complete telemetry nor physical savings is established.

### Same-source worker restart

At 03:08:09.209 UTC the internal pg-boss heartbeat emitted a pool checkout
timeout; the existing worker error handler called `process.exit(1)`. The previous
sync-page heartbeat warning came from a separate caller. Pinned dependency code
places this exact message in the waiting-client queue, not the TCP-connect error
branch. Why a client was unavailable is unknown; neither a specific slow query
nor protected sync-health is causally established.

Docker shows the previous process finished at 03:08:09.645 and the worker
restarted at 03:08:13.699 on the same image/source. Successful post-start work
is retained. Generation 781 preserved its revision, generation and checkpoint
chain across this boundary. Startup orphan-cleanup count zero does not exclude
interrupted runs with valid matching leases. Retain uncertain final receipts;
current Docker exit status and empty retained events do not describe the old exit.

At 05:06 all roles were healthy, with one worker restart, zero API/scheduler
restarts, about 24 GiB free and API/database health OK (311ms probe). The protected
deploy gate remains failed. No production action or privileged EXPLAIN ran here.
A0 now has 18 complete, 49 incomplete and two running sweeps, with 85,915 unknown
material observations. Preserve the original seven-day clock and runtime boundaries.

`review_pr162` independently checked the report and repair interpretation;
`quality_c1` traced the restart mechanism and its evidence limits. Both used
local evidence and code only. No runtime or test changes were made, so the
existing validation on `13537b6b` applies; tests were not rerun for this observation.

[C1 summary](followup-20260911T050632Z/snapshot-20260911T050739Z/summary.json),
[manifest](followup-20260911T050632Z/snapshot-20260911T050739Z/report.json.manifest.json),
[restart logs summary](followup-20260911T050632Z/worker-log-summary.json),
[runtime](followup-20260911T050632Z/runtime.json).

Documentation commit `39e13ebce674fcdb9d4b43630e93c50edc938b52` records this follow-up in PR166.
The pushed PR body was read back exactly; it remains open and draft. Final
independent review found one undated A0 allowlist claim, which was corrected
and re-reviewed. No actionable findings remain. Runtime and tests are unchanged;
the separately requested one-use EXPLAIN permission is still pending.


### Shared runtime/config read — 13 September 11:12 UTC

All three roles remain healthy on `380326368fe3` / `c443947a3569`, with zero
restarts. The signed-in UI shows A0 all six pages, C2b `lilly-1` and recovery
`none`; role application/version and historical continuity remain unknown.
See the [shared observer report](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260913T110856Z/REPORT.md) for bounded logs, disk,
health and C2b transition-sweep limits. No production or gate change occurred.
