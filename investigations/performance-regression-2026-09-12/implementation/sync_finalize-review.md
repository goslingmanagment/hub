# Independent review: sync cleanup versus finalizer

Verdict: **APPROVE**. No correctness, regression, code-quality, or architecture blocker found in the reviewed candidate. This is source-review approval; coordinator-run PostgreSQL tests and the final integrated release checks remain the execution gate.

Reviewer: `/root/review_sync_finalize_fix`, independent of the implementation author. Reviewed 2026-09-12 against author worktree `/Users/dmitriy/code/goose/.worktrees/hub-perf-sync_finalize-20260912`, base `31b73a9691f32f8c33c3fe479bca68533c7048d6`.

## Reviewed artifact identity

SHA-256:

- `packages/db/src/repositories/sync.ts`: `ef8996c703bb7da1bcb92ac6f04b43d442d5217ba5f8a6d723bc7f35ecf885e1`
- `tests/sync-finalization-race.integration.test.ts`: `187903e159a9c4bfd520bcb4c17cd681642d5b1809e5edb2847a0609f26cee62`
- `git diff --binary -- packages/db/src/repositories/sync.ts tests/sync-finalization-race.integration.test.ts`: `94a5a0cbe19d6fc98afc7eddcf08bf02fd2755f8fbf37f752b5f2343ac4c2ca5`

The production delta is six added lines: two target predicates and four comment lines. The new integration fixture is 229 lines. `git diff --check` passed during review. No source edits, test-suite execution, database operation, production access, commit, or push was performed by this reviewer.

## Correctness and architecture

Both added `and sr.outcome = 'running'` predicates qualify the actual outer UPDATE target, after the candidate-ID join. Keeping that condition only inside `orphaned_runs` or `inactive_runs` is insufficient because their source snapshot can still contain the pre-finalization row. The new outer condition can reject the updated target after its competing transaction commits. This follows PostgreSQL 16's documented UPDATE behavior under Read Committed: the waiting updater re-evaluates its condition against the updated row, while a rolled-back update leaves the original row available. [PostgreSQL 16 transaction isolation, section 13.2.1](https://www.postgresql.org/docs/16/transaction-iso.html#XACT-READ-COMMITTED)

I traced the real callers: planner cleanup calls the repository on `app.db`, startup orphan cleanup does the same, and the normal database factory supplies the pool without changing transaction isolation. The targeted concurrency tests also use the normal migrated PostgreSQL fixture. This is a same-target recheck, not an attempt to refresh all joined-table data after a lock wait.

The change preserves selection policy: inactivity timestamps still derive from the same per-running-run attempt/event probes; the orphan query keeps the same page, stream, generation, token, running-state, and lease-expiry conditions. Failed versus partial still depends on retained checkpoint events. The UPDATE assignments, error summaries, completion times, return shape, and affected-row classification are unchanged. A target that remains running can still be closed; a finalized target produces no cleanup row or cleanup count.

Leaving `finishSyncRun` unchanged is appropriate. The worker records the actual result for its own run ID, whereas cleanup infers a result from inactivity or missing ownership. If cleanup holds the lock first, the worker must retain its existing ability to supply the final result afterward. A new running-only finalizer would make the heuristic result permanently win that ordering. New runs have independent IDs, so this change does not introduce a mechanism for one run's finalizer to rewrite a replacement run.

No additional lock, transaction, retry, table, migration, API, or runtime flag is needed. The fix maintains Decision 293's bounded activity queries and the truthful terminal-status intent of Decision 191. I read those decisions, Decision 96 and the Stage 25 concurrency context, the author handoff, existing cleanup tests, the observability finalization caller, and the earlier race reproduction.

## Regression coverage assessment

The fixture meaningfully exercises the implementation rather than copied SQL. Single-connection pools keep each transaction and repository operation on its known backend. `pg_blocking_pids` must show the exact intended blocker before the transaction is released; the polling sleep alone cannot produce a passing interleaving. The immediate rejection handler and settling of pending updates before pool shutdown avoid the original race being hidden by an unhandled rejection or leftover query. Statement timeouts bound the contested statements.

The 12 cases cover both cleanup functions: four committed terminal statuses, a rolled-back finalizer, and cleanup winning the first lock. Committed finalizations must return zero cleanup counts and preserve status, stats, error summary and completion time. The rollback cases verify that a real checkpoint still causes partial cleanup and survives it. The reversed ordering pins the worker's existing authority. `getSyncRun` reads these fields directly from `sync_runs`; it does not reconstruct a successful result from an event or metadata fallback that could hide a database overwrite.

Existing `sync-orphaned-runs.integration.test.ts` supplies normal failed/partial cleanup, recent activity, event/attempt retention, and idempotence controls. Request metadata and the finalizer's stats/event construction are untouched. The new candidate prevents cleanup from replacing terminal fields; it does not change how the worker merges its request summary or records events.

Coordinator should run the author's proposed negative control with only `sync.ts` restored temporarily: all eight finalizer-first commit cases should fail on the unfixed source, while rollback and cleanup-first cases should remain valid. Restore the candidate and run both integration files serially with zero skipped prerequisites. No additional test expansion is required for approval if those checks pass.

## Limits

This fixes the confirmed terminal-result overwrite. It does not serialize newly arriving activity or lease changes in other tables with the cleanup snapshot, redesign stale-worker policy, or prove a measured CPU reduction. Those existing boundaries do not invalidate this narrow repair. Code rollback would reopen the race without any schema or data reversal.

## Coordinator validation received after review

The reviewer read `implementation/sync-wave-tests.log`: the integrated release worktree completed 15 test files and 172 tests successfully, with no skipped tests in the receipt. The coordinator confirms this run includes the 12 new race cases, existing cleanup tests, lease fencing, and lease/retry controls. The old-source negative control is running centrally; the coordinator will append its separate receipt. This does not change the APPROVE verdict or represent a reviewer-run database test.
