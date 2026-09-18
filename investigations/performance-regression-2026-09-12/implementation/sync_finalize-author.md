# Sync cleanup versus finalizer: author handoff

Author worktree: `/Users/dmitriy/code/goose/.worktrees/hub-perf-sync_finalize-20260912`

Base: `31b73a9691f32f8c33c3fe479bca68533c7048d6`.

Status: candidate implementation and regression fixture ready for independent review and coordinator-run PostgreSQL tests. No Vitest suite, database, production operation, commit, or push was run by this author.

## Problem and narrow change

Both `closeInactiveSyncRuns` and `closeOrphanedSyncRuns` select candidate IDs from a snapshot, then UPDATE the target by ID. A concurrent worker finalizer can hold the target row lock, write a terminal result, and commit after the cleanup has selected the old running version. Cleanup then waits and overwrites that real terminal result with its inferred failed/partial outcome.

The candidate adds `and sr.outcome = 'running'` to each outer UPDATE target's WHERE clause, plus a short explanation at each function. PostgreSQL rechecks the target-row predicate after waiting for a concurrent update, so a committed terminal result is no longer eligible. Candidate discovery, indexed activity probes, cleanup cutoffs, error text, timestamps, progress-event classification, counts, and retained event/attempt rows keep their existing semantics. No new locks, transaction, retry, migration, or API is added.

`finishSyncRun` is deliberately unchanged. The worker's actual result can still replace an earlier heuristic cleanup result when cleanup gets the lock first. Making every finalizer `running`-only would let a heuristic timeout win over a subsequently completed worker result and would be a different behavioral change.

The original review's "all three" refers to three revisions/index configurations of the same inactivity reproduction (baseline without 0184, baseline with 0184, candidate with 0184). There are two applicable UPDATE-from-candidate cleanup functions in the current source. `reclaimExpiredPageSync` acts on `page_sync_states`, holds its selected row locks, and repeats lease identity/expiry conditions; it does not update `sync_runs` and is outside this issue.

## Files

- `packages/db/src/repositories/sync.ts`: six added lines, including the two target predicates.
- `tests/sync-finalization-race.integration.test.ts`: 12 integration cases over the production repository functions and the normal migrated PostgreSQL fixture.

The test file uses one-connection `pg` pools to hold BEGIN and the actual repository operations on known backends. It imports no Drizzle internals and copies no repository SQL. Before releasing a transaction, `pg_blocking_pids` must prove that the exact competing backend has reached its lock; sleeps only poll that condition. Pending query rejections are handled immediately and pending queries settle before pools close. Statement timeouts bound failures.

Each cleanup has these cases:

1. Worker finalization to success, partial, failed, and skipped commits while cleanup waits. Cleanup returns zero affected counts, and the worker's exact status, stats, error summary, and completion time survive.
2. Worker finalizer rolls back while cleanup waits. The run is still eligible: a real earlier checkpoint event makes cleanup return one partial run, with the original cleanup summary/time and the event retained.
3. Cleanup gets the lock first. Worker finalization waits, then replaces the inferred failure after cleanup commits. This pins existing finalizer authority and prevents a tempting overbroad fix to `finishSyncRun`.

Existing `tests/sync-orphaned-runs.integration.test.ts` provides the healthy/non-racing controls for actual failed and partial cleanup, recent activity, preservation of attempts/events, and idempotence.

## Author checks performed

All passed:

```sh
pnpm install --offline --frozen-lockfile
pnpm exec eslint packages/db/src/repositories/sync.ts tests/sync-finalization-race.integration.test.ts
git diff --check
```

`git add -N tests/sync-finalization-race.integration.test.ts` exposes the new fixture in `git diff`; it does not stage its content. The worktree contains only the two candidate files above. Shared decisions were not edited.

## Coordinator validation commands

Run serially, with no other Vitest/Testcontainers suite active, from the candidate or integrated release worktree:

```sh
pnpm exec vitest run tests/sync-finalization-race.integration.test.ts tests/sync-orphaned-runs.integration.test.ts --maxWorkers=1 --no-file-parallelism
```

For the negative control, preserve the candidate `sync.ts` outside the worktree, replace that one file with `git show 31b73a9691f32f8c33c3fe479bca68533c7048d6:packages/db/src/repositories/sync.ts`, keep the new fixture, and run only `tests/sync-finalization-race.integration.test.ts`. Restore the preserved candidate file even if the expected failing command exits nonzero. Expected failure: the eight finalizer-first commit cases return one affected cleanup row instead of zero and overwrite the worker's result; the rollback and cleanup-first cases should remain valid. Do not roll back the entire release worktree to construct the control.

After restoration, repeat the candidate targeted command and include the integrated result in the normal `pnpm check` and final release validation. Test execution is pending; this handoff makes no pass claim for those commands.

## Suggested append-only decision note

**Sync cleanup rechecks the target after a concurrent finalizer.** Inactivity and orphan cleanup may infer a failed/partial outcome only while the UPDATE target still has `outcome = running`; both outer UPDATE predicates repeat that condition. The candidate SELECT's snapshot is insufficient because it can predate a concurrent worker finalizer whose row lock cleanup waits on. PostgreSQL's target recheck then preserves the worker's committed terminal outcome, stats, error summary, and completion time. Existing cleanup policy and stored observability are unchanged. The actual worker finalizer remains able to replace an earlier heuristic cleanup result; making it running-only would give a timeout estimate priority over the worker's eventual result. Local PostgreSQL integration coverage must establish both lock orders, terminal statuses, and a rolled-back finalizer. No schema or deployment flag changes are required.

## Limits and rollback

This fixes the confirmed same-row terminal overwrite. It does not redesign the policy whereby activity in another table can arrive after a cleanup statement's snapshot, nor does it claim to remove every possible coordination race or reduce production CPU by a measured amount. Rolling back code reintroduces the status-history race; there is no schema/data transformation to reverse.
