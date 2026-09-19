# PR161 deployment and reply acceptance

PR [#161](https://github.com/goslingmanagment/core/pull/161) was deployed with
owner approval as `34d897779fd004336e114333501f284f1faeefc1`, but it did not resolve
the production transcript timeout. Lora-1 remains 140/143 verified across earlier
timestamped reads; the remaining Lilly replay permission persists, but its
per-page acceptance gate is still closed. No new replay or flag flip occurred.

The next concrete owner decision is one plan-only diagnostic via an explicit
role exception: [prepared SQL and procedure](exact-plan-probe/PROPOSAL.md).
The allowed `read_only` role was tried and denied table permission. The exception was later approved and executed once at 17:34 UTC; see the dated
update below. A separate query fix now has production-plan and local evidence.
All timestamps below are UTC.

## Validation and production limits

Before PR161 opened, `pnpm check` passed: 3,110 unit tests, nine existing skips,
lint/build passed and the unchanged strictness budget remained 1,908 existing
errors across 121 files. Four real Docker-Postgres integration suites passed
120 tests with zero skips. They cover window boundaries/nulls, source precedence,
reply material, delete/purchase overlays, keysets/counts, page isolation and API
evidence/auth gates. Independent review of implementation and final docs found
no blockers; all five CI checks passed. The merged tree matches the reviewed
final tree. These checks and the local benchmark prove semantics and less local
query work, not production latency resolution.

The exact plan-probe SQL passed one additional local Docker-Postgres test with
zero skips; it validates syntax, JSON planning and rollback, not production
planner choice. The approved deployment worktree remains clean at the merged
revision; the temporary diagnostic test was moved into this evidence directory.

## Timestamped execution evidence

Preflight: at 10:14:32 UTC all roles healthy with zero restarts on image revision 18649bd95f3b; 29 GiB free; loopback health OK (DB 1 ms). Read-only SQL at 10:15:18 found no parse-zero rows in the five inspected pull families; v5 DM 28379 and earnings 9923 remain. DB size at 10:16:17 was 33544715287 bytes. Approved local worktree is clean at 34d897779fd004336e114333501f284f1faeefc1, tree-identical to independently reviewed 6488e0bb. PR161 is merged with all five CI checks passed.

Deployment started at 10:16:57.173 UTC with the standard dist-only/no-image-gc command, run ID 20260909T101657Z-47601. Rollback image and release files were captured. Authenticated Configuration immediately before deployment showed catch-up running/editor none and Save disabled. No flag edit occurred. Pure local material validation now imports the pinned approved worktree; its canonicalizer and text-normalizer files are unchanged from deployed 18649bd9.

Deployment completed at 10:30:43.066 UTC, exit 0, 825.891 s. The standard
sync-health gate had two 150-second client timeouts before its third request
returned 200. The successful API request ran 10:28:42.281–10:30:27.779 UTC,
105497.693 ms. This is a passed deployment gate, not resolution of the latency
incident. No additional sync-health request was sent. The production-pinned CLI
is 34d897779fd004336e114333501f284f1faeefc1; capabilities passed. At 10:31:48 all
three roles were healthy on the same new image with zero restart counts, 29 GiB
free, and loopback health OK (DB 9 ms). Catch-up remained none in authenticated
Configuration at about 10:32.

The first approved exact transcript retry after rollout failed again: lora-1,
conversation 790634843078664193, message 953135194070597632, 2 ms window. API
request req-2e ran 10:32:10.139–10:32:24.685 UTC, returned 503 in 14545.109 ms.
The full original 143-ID comparison stopped immediately; the 140 earlier
successful targets retain their prior timestamps, one target failed and the
other two pending targets were not read. No new lora-1 replay and neither Lilly
preview/write was dispatched. PR161's local query improvement did not resolve
the production timeout. Source/body stamps are not serving acceptance.

The selected pg_stat_activity view hides other-role query details; only 22
other-role connections were visible at 10:27:53. No grant or role bypass was
attempted. Postgres has only the plpgsql extension, so pg_stat_statements is not
available. One resource sample during the gate showed PostgreSQL 149.01% CPU,
worker 57.36% and API 0%; it is not a utilization average or a proven cause.

PostgreSQL error logs now identify the failing phase: backend 799 timed out in
the main list SELECT at 10:32:24.550 UTC; its next count SELECT failed as an
aborted-transaction consequence. The statement includes PR161 window_refs.
The independent archive-floor query is not the failing statement in this
request. Query hashes and phase classification are retained without message
bodies. Actual execution-plan causality remains unknown.

Prepared exact plan-only probe matches that logged SELECT with its actual ASC
ordering and 31 known control parameters. It passed one local Docker-Postgres
test without skips. A single production attempt through the allowed read_only
role was rejected for page_dm_messages permission (exit 3). No role bypass or
new grant was performed. The concrete next owner gate is
exact-plan-probe/PROPOSAL.md: one non-ANALYZE EXPLAIN through postgres in a
10-second read-only transaction. It is prepared but not authorized or run.


At 10:46:32 the final runtime check again found all three roles running/healthy
with zero restart counts and 29 GiB free. Loopback health at 10:46:46 was OK,
DB 9 ms. The final bounded read-only parse-lane census started at 10:46:39 but
hit its statement timeout; it returned no counts and was not retried. The shell
wrapper reported exit 0, so that exit is not a successful census; the timeout
was present in tool stderr. The latest successful lane counts remain the
10:15:18 pre-deploy sample. No claim of post-deploy freshness recovery follows.

## Stage state at this pause

| Stage | State | Measured savings / latency | Remaining gate |
|---|---|---|---|
| Pre-A0 stale known head and lilly-2 queue | PR157 deployed; ari known head archived; second ari target unresolved; lilly-2 catch-up off | Historical exact ari capture: 188.695 s after canary activation; no fleet distribution | Scoped head-recovery approval and source/serving acceptance |
| Pre-A0 reply material / honest sweep | PR158/159/160/161 deployed; 266/994 original targets verified across timestamped samples; exact lora-1 read still times out | Lora-3 serving within 7m05s of replay start; lora-2 within 4m20s; no HTTP savings measured | Plan-only role exception pending; resolve lora-1 reads, complete approved Lilly scopes and full freshness acceptance |
| A0 + T0 | Not started | No shadow clock or physical-attempt baseline | All prerequisites accepted, retained offline corpus, then >=7 full shadow days on all six pages |
| C1 | Not started | Unmeasured | After A0 starts; diagnostic trigger counts before narrow fix |
| C2a | Not started | Unmeasured | Correctness and retained repair acceptance |
| C2b | Not started | Unmeasured | C2a; semantic dirty/receipt shadow, daily rotation retained |
| C2c | Gated | Unmeasured | Coverage, per-fan max-age and cost evidence |
| W0 | Not started | Unmeasured | Management Session fixtures; separate explicit approval for live socket probe |
| B0 | Not started | Unmeasured | W0, capture-only receiver, >=7 days and sufficient event diversity |
| B1 | Not started | Unmeasured | B0/T0, delivery lag, added attempts and history fairness evidence |
| A1 | Separate owner/calendar/evidence gate | Unmeasured | A0/T0 safe-stop and freshness evidence; independent of WS |
| B2 | Not authorized | Unmeasured | Separate owner decision; do not build by default |

The >=50% savings goal is not claimed. Physical-attempt totals and fresh-event
latency percentiles remain unmeasured. Current production latency samples are
105.498 s for the successful sync-health request after two 150 s client timeouts,
and 14.545 s for the failed exact transcript read. Earlier replay confirmation
bounds in the table are historical samples, not current latency distributions.

Still uncovered: three lora-1 targets, 725 Lilly targets, the complete 27-message
attachment cohort (four verified in these five-page passes), final six-ID and ari
rereads, explicit reply clears/later revisions in production, broad conversation
coverage, unresolved known heads, quiet-state freshness, old edits/deletions,
outage gaps and Management Session socket coverage. Provider-deleted-head repair
stays outside A0; its planned shadow only counts that discrepancy. Lilly-2 head
recovery remains off and separately gated. No A0/T0 shadow clock has started.


## Follow-up at 17:34 UTC

Owner-approved one-file plan probe completed once, exit 0. See
exact-plan-probe/dispatch.json and production-plan.parsed.json. The main SELECT's
estimated plan searches cold tombstones by message ID before checking the page's
OFAPI binding. A separate mixed-platform local fixture reproduces the unnecessary
archive scan; an addressable lookup with a scalar binding and platform scope
removes that work while preserving output. The fix is isolated in
hub-agent-transcript-tombstone / fix/agent-transcript-tombstone-lookup, Decision
282. No new deployment, serving retry, Lilly replay, recovery flag or A0/T0
activation occurred. Prior serving acceptance and runtime measurements retain
their timestamps; they are not fresh 17:34 samples.


The resulting separate fix is [PR162](https://github.com/goslingmanagment/core/pull/162), draft at
708585d249f5d9cd31e875e6bab28026925287b7. pnpm check, production build and five Docker-Postgres
files / 122 tests / zero skips passed before opening. Baseline regression proves
cross-platform tombstone poisoning; the mixed-platform benchmark removes
300000 unrelated cold-row visits (local EXPLAIN 29.017→0.550 ms). Independent
review is pending; no merge or new deployment occurred. The exact review scope
is prepared in PR162-REVIEW-GATE.md. At 17:43 UTC production roles remained
healthy with zero restarts on PR161's image and 29 GiB free; corrected loopback
/api/v1/health passed at 17:44:34 UTC (DB 6 ms). No new serving acceptance or
physical-attempt savings measurement occurred.
