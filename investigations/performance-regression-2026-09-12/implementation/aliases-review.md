# Independent review: alias lock order

**Verdict: APPROVE. No code, architecture or regression blocker found in the reviewed patch.**
Release remains contingent on the coordinator's real-PostgreSQL test gates below;
this reviewer did not execute a database or test suite.

Reviewed the actual diff in
`/Users/dmitriy/code/goose/.worktrees/hub-perf-aliases-20260912`, based on deployed
`31b73a9691f32f8c33c3fe479bca68533c7048d6`. The scope is five added runtime lines
and one 205-line integration fixture. The reviewer is independent of the author.

## Correctness and architecture

`packages/db/src/repositories/fans.ts:213–217` puts the alias INSERT values in a
common `(fanId, username)` order after conditional RETURNING and untouched-row
read-back. That is the correct boundary: those two result sources have no stable
combined order, while the alias statement can still take conflicting row locks
when its conditional UPDATE does no physical write. An autocommit call has
already released the preceding fan statement's locks. Removing the reciprocal
alias order addresses the demonstrated `40P01` at its cause.

The sort mutates only `aliasValues`, a new array of new objects. It cannot reorder
`rows`, the fan-presence groups, the fan INSERT itself, or the public result
reconstructed from `deduped`. No query, retry, transaction or lock class is added.
Both no-op predicates and the alias `least(first_seen_at)` /
`greatest(last_seen_at)` updates are unchanged, as are username filtering,
deletion detection, explicit NULL/omitted fields and retained alias history.

The comparator is deterministic across callers: numeric fan IDs followed by
JavaScript string ordering, with no locale dependency. It need not imitate the
database's text collation; participating writers need the same lock order. The
current data path yields at most one username per deduplicated fan ID, so the
numeric component alone orders its possible conflicts. IDs use the existing
schema's `bigserial`/`bigint` number mapping; this patch does not add a precision
conversion.

Repository search confirms `upsertFans` is the sole runtime writer of
`fan_username_aliases`. The alias primary key is `(fan_id, username)`; the other
repository-defined indexes are non-unique. No migration-defined alias trigger
changes this ordering contract. Read direct autocommit fan-identities callers
and transaction-scoped audience/DM callers: they retain their existing fan ID
maps, page-sync transaction boundaries and conversation-before-fan discipline.
The five added lines do not move an alias statement ahead of any existing lock.

This is not a proof that arbitrary multi-call outer transactions, reverse fan
input order, different presence-group order or concurrent erasure cannot
deadlock. Those broader lock-order issues precede this patch; it neither adds a
retry that would conceal them nor claims to fix them. Production occurrence
frequency has not been inferred from the synthetic witness.

## Fixture review

The new fixture exercises the real repository function using dedicated
PostgreSQL sessions and genuine autocommit statement boundaries. Its proxy only
pauses before alias INSERT, and the trigger only controls scheduling. Neither
rewrites SQL values or result rows. The trigger waits before the second alias,
after the first actual alias conflict has been acquired, and releases its shared
advisory lock before reaching the second alias. Thus the eventual old-code cycle
consists of real alias locks rather than the test gate itself.

The coordinator recognizes both relevant schedules: two different first aliases
held, or one shared-order first alias held while the other session waits for it.
It then releases the gate and requires both repository operations to resolve.
This avoids teaching the test to accept only the intended implementation's
schedule. Same-order and reversed-second-input cases also assert public result
order and final fan values. The no-op/rename case checks alias `xmin`, both
timestamps, old-history retention and the original first-seen time.

Timeouts and `finally` release the gate and settle operations; dedicated sessions
are destroyed so test-only settings cannot leak to later cases. The code follows
the repository's test helper and avoids Drizzle imports in tests. The important
remaining evidence is execution, especially the negative control.

## Required coordinator gates

1. Run `tests/fan-alias-concurrency.integration.test.ts` on this patch and require
   all three tests to pass.
2. Run the same new fixture against the original deployed writer as a negative
   control: the concurrency cases should reject with PostgreSQL `40P01`; the
   no-op/history case should pass. Restore the reviewed file afterward.
3. Run existing fan churn, DB write, fan-page identity repository and OFAPI fan
   identity integration tests serially, plus the combined release `pnpm check`.
4. Append the narrowly worded alias lock-order decision in the same problem
   commit. Do not claim all fan deadlocks are eliminated.

Root owns those database runs, final integration, commit and deployment. No
source edits, commits, pushes or production access were performed by this
reviewer.

## Independent local checks and reviewed bytes

`git diff --check -- packages/db/src/repositories/fans.ts tests/fan-alias-concurrency.integration.test.ts`
and targeted ESLint on those two files passed, exit 0.

SHA-256:

```text
457864b88645d8083f748aab30e50683dc23d3d3869ab5b386acd819191eb470  packages/db/src/repositories/fans.ts
b9de8710566c4db62b8416ce688c1aa863a58871929d6383fe6fdd29cfe84da8  tests/fan-alias-concurrency.integration.test.ts
```

Read `CLAUDE.md`, `SESSIONS.md`, the decisions quick reference and Decision 293's
fan-write follow-up, the Stage 14 identity contract, current writer/schema and
direct callers, the new fixture/helpers, existing fan-churn tests, author handoff,
and the earlier audit's reproduction report. Conclusions are based on the
current patch and data path; previous production measurements are not treated
as current validation of this fix.
