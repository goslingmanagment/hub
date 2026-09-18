# Independent review: avoid discarded follower counts

Verdict: **APPROVE**. No blocking correctness, architecture, or code-quality
finding in the reviewed two-file patch. Approval applies to the source/test
bytes below; combined-release checks remain the coordinator's responsibility.

Reviewer: `/root/review_seed_count_fix` (not the author).
Reviewed worktree: `/Users/dmitriy/code/goose/.worktrees/hub-perf-seed_count-20260912`.
Base: `31b73a9691f32f8c33c3fe479bca68533c7048d6`.

## Why the change is correct

The only consumer whose result depends on `activeFollowerCount` is a newly
constructed Fansly `followers_reconcile` state outside onboarding
(`buildSeedPageSyncState`, `page-sync.ts:1044–1125`). For other streams,
`shouldRecover` depends on the stream's trusted timestamp. During onboarding
it is derived from the stream name, independently of the count. OnlyFans does
not seed a reconcile stream (`getSyncStreamsForPlatform`, lines 886–902).

The CASE at lines 1545–1557 mirrors those conditions and leaves the active-only
count expression unchanged. Existing reconcile rows are excluded from state
construction by the existing-key check at lines 1582–1590. That includes
pending, running, blocked, and paused rows: the presence of a row is decisive,
not its status. Returning zero for this unused internal field therefore does
not change their recovery decision or scheduling state.

Initial and partial Fansly seeding still count whenever reconcile is missing.
The unchanged builder retains mismatch, missing/old trusted timestamp,
onboarding, and default-paused stream rules. Null headline count still follows
the previous normalization to zero; this patch does not reinterpret unknown
vendor counts. Tombstoned-page filtering is unchanged.

There is no early return for a fully populated stream set. The legacy
light-trust repair, cadence/slot update transaction, final read, planner gate
reconciliation, and standalone `scheduleDuePageSync` ensure all remain present.
Removing the duplicate planner ensure would cross the gate-reconciliation
boundary; retaining it here is a sound narrow choice.

## Concurrency and query behavior

- The metadata, existence predicate, and any executed count share one SQL
  statement snapshot. There is no extra count round trip or process cache.
- The new existence predicate has the existing `(page_id, stream)` primary key
  available. It probes the small state table instead of aggregating the much
  larger follower relation on every normal preflight.
- A concurrent seeder can insert between this SELECT and the later state read.
  That can waste a count, but cannot overwrite its row: the later existing-key
  check and `ON CONFLICT DO NOTHING` are unchanged.
- Reset, pause, resume, auth recovery, and feature gates update durable state
  rows in place. They do not make an existing reconcile disappear. No new row
  locks, lock-order edge, CAS write, or lease change is introduced.
- The explicit page/model erasure path does delete sync states, together with
  page follows in its hot-data transaction. This is not a routine reset. The
  seeder was and remains a multi-statement operation without an erasure fence;
  this review does not claim to establish atomic seeding against an overlapping
  destructive erasure. No supported ordinary-control regression was found.

## Evidence reviewed

I read the complete changed source and test, the builder/callers/control paths,
schema primary key, planner and executor entry points, relevant decisions
(including 294 and the production-load entry), and Stage 25. I also inspected
the coordinator's actual test logs:

- `seed-count-integration.log`: 4 files, 28 tests passed.
- `seed-count-negative-control.log`: restoring the old writer makes the five
  no-read plan checks fail with `Actual Loops = 1`; all five recovery-semantic
  cases still pass. This distinguishes the saved performance work from a
  behavior rewrite.
- `git diff --check`: passed during this review.

The new tests use real repository calls and bind values, real PostgreSQL
EXPLAIN ANALYZE, active/inactive follower fixtures, preserved paused state,
partial seeding, recovery variations, and legacy/cadence maintenance. This is
meaningful regression coverage. I did not run a database, Vitest, production
probe, source edit, or commit; the coordinator serializes those operations.

One non-blocking test limitation: the EXPLAIN helper executes the captured
SELECT after seeding. In the onboarding case, reconcile then exists, so that
case alone would not catch deleting just the onboarding CASE condition: the
existence condition would also suppress the later EXPLAIN count. The reviewed
condition is correct, and full/partial preflight fixtures already have the
reconcile row before the original call. If the tests are extended later, assert
the onboarding plan before the state insertion to isolate that particular
performance branch. This limitation does not invalidate the recovery assertions
or the normal-preflight negative control.

## SHA-256 receipts

| Item | SHA-256 |
|---|---|
| Candidate `packages/db/src/repositories/page-sync.ts` | `599f79ed1df6f3a281f86771e61ecb36dddf1533cc2a9532bf5a6c91f011f1d4` |
| Candidate `tests/page-sync-seed-count.integration.test.ts` | `1464d967889b87395c79cfd812951d210b77e0768c958cd44d106661cd553502` |
| Base `page-sync.ts` | `8b928a114b576017578855d112dd0cdb7a064c215a144be01c87fd472fdb7768` |
| Two-file `git diff --binary` | `1e0d3162ab5fbbc9a9b657acc74696ad339b12b0fd1b00b54bf469345cd6dbb9` |
| Positive test log | `91f79db681366f5ff0d9e75fe9d068ced1efed2a40e49ca70f5eb8055fc9225c` |
| Negative-control test log | `1f3435ed4a895c823615b69a076d5cd9822548237893f781efd7b2ac2864f84a` |
