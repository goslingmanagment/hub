# Avoid discarded follower COUNT during sync-state seeding

Author worktree: `/Users/dmitriy/code/goose/.worktrees/hub-perf-seed_count-20260912`.
Base: deployed `31b73a9691f32f8c33c3fe479bca68533c7048d6`.
No commit, push, production operation, Vitest suite or database was run by this author.

## Change

`packages/db/src/repositories/page-sync.ts` wraps the correlated active-follower
aggregate in `CASE`. It runs only when all three conditions hold:

- the invocation is not onboarding;
- the page is Fansly;
- the page has no `followers_reconcile` state, regardless of status.

The existence check uses the existing `(page_id, stream)` primary key. The page
metadata and count stay in the same SQL statement/snapshot. Existing states
already bypass `buildSeedPageSyncState`, and onboarding or OnlyFans cannot use
the follower count to request a reconcile. The `ELSE 0` therefore substitutes
only a value the current seeder cannot consume. A missing ordinary Fansly
reconcile still sees the real active count and all prior recovery rules.

This is deliberately not an early return from `ensurePageSyncStates`: legacy
light-derived trusted-state repair, cadence/slot maintenance, partial seeding,
paused/gated stream behavior and the return shape are retained. The planner's
explicit ensure, the ensure inside standalone `scheduleDuePageSync`, and
executor preflight are unchanged; each avoids the expensive aggregate when
fully seeded. Removing the duplicate planner ensure would require a distinct
seeding-bypass contract around gate reconciliation and is not needed to remove
these discarded counts.

Routine pause/reset/recovery controls update states in place. A concurrent
insert can still make a rare count unnecessary between the SELECT and the later
state read; `ON CONFLICT DO NOTHING` preserves the prior insert behavior. There
is no new cache, invalidation mechanism, schema, public API or retention action.

## Tests prepared for the coordinator

New `tests/page-sync-seed-count.integration.test.ts` has ten cases using the
real repository and PostgreSQL:

- Fully populated 17-stream Fansly page, including a paused reconcile: exact
  states survive a changed page follower total; the real repository planner
  ensure/schedule chain and executor ensure produce three SELECTs whose
  analyzed plans perform zero `page_follows` scan loops.
- A partial state set missing DM/messages and gated posts is completed without
  reading followers or reopening an existing paused reconcile.
- Five missing-reconcile cases preserve recovery decisions: matching active
  count, mismatch, unknown source count, no trusted timestamp, expired trust.
  The fixture has two active follows plus an inactive follow, so the matching
  count case detects loss of active-only semantics as well as a skipped count.
- Onboarding preserves its initial state rules and performs no follower scan.
- Complete state sets still receive legacy repair and cadence maintenance.
- Initial OnlyFans seeding does not read followers and retains its stream set.

Plan checks capture the exact page SELECT and binds emitted through the real
pool, then run `EXPLAIN (ANALYZE, FORMAT JSON)` on that SELECT. The cases which
assert zero loops already have a reconcile (or exclude it through onboarding /
platform) during the original ensure. Plans are not used as proof of the
initial missing-reconcile path; those cases assert the resulting states.

Recommended serialized commands:

```sh
pnpm exec vitest run tests/page-sync-seed-count.integration.test.ts tests/page-sync-repository-schema.test.ts tests/posts-sync-state.integration.test.ts tests/fansly-bulk-stream-gate.integration.test.ts --maxWorkers=1 --no-file-parallelism
```

For a negative control, run only the first test with the base version of
`page-sync.ts`: its unconditional follower scan should have `Actual Loops = 1`
and fail the no-read assertion. Restore the candidate before integration.
The old `ensure-seeded-count-probe.mjs` counts SQL text occurrences, so it cannot
distinguish this candidate's unexecuted CASE subplan from an executed count;
the real PostgreSQL plan assertion is the appropriate replacement evidence.

Author checks completed:

- `pnpm install --offline --frozen-lockfile`: passed, lockfile unchanged.
- Targeted ESLint of the changed source and test: passed.
- `git diff --check`: passed.
- `pnpm typecheck`: passed; existing strictness ratchet remains 1,897 known
  errors in 120 files. Receipt: `implementation/seed_count-typecheck.log`.
- Integration/Vitest and database checks: intentionally not run; root serializes
  all database suites. Independent review is still required.

## Proposed decision note for the coordinator

Sync-state maintenance counts active followers only while initially creating a
missing Fansly `followers_reconcile` state outside onboarding. The aggregate is
guarded by the existing state primary key inside the page SELECT, preserving a
single metadata/count snapshot. Fully seeded planner/executor preflights keep
legacy repair and cadence maintenance but do not scan `page_follows`; existing
paused states remain authoritative. No stream scheduling, recovery threshold,
feature-gate or standalone schedule contract changes. PostgreSQL integration
checks cover the execution plan and initial/partial-state recovery semantics.

## Patch contents

- `packages/db/src/repositories/page-sync.ts`: 12 added, 2 removed lines.
- `tests/page-sync-seed-count.integration.test.ts`: new, 226 lines, marked
  intent-to-add so a normal `git diff --binary` includes it.

No other worktree files changed. This report is written only into the
coordinator's investigation directory.
