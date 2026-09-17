# Alias deadlock fix: author handoff

Prepared on `31b73a9691f32f8c33c3fe479bca68533c7048d6` in
`/Users/dmitriy/code/goose/.worktrees/hub-perf-aliases-20260912`.
No production access, commits, pushes or database/test-suite processes were run
by this implementation agent.

## Change

- `packages/db/src/repositories/fans.ts:213–217`: sort the new alias-values array
  by `(fanId, username)` before issuing its bulk INSERT. The numeric/string
  comparison is deterministic and does not depend on process locale.
- `tests/fan-alias-concurrency.integration.test.ts`: permanent real-PostgreSQL
  witness for overlapping autocommit batches, public return order, final values,
  unchanged alias versions and retained username history.

The query after conditional RETURNING appends skipped rows, so the temporary
array order depends on which identities changed. A batch changing only A can
write aliases A/B while another changing only B writes B/A. Each alias INSERT
holds its first conflicting tuple lock until that statement commits, even when
the conditional UPDATE is skipped. A common order removes the reciprocal wait
introduced by this path without an automatic retry or extra SQL round trip.

Repository search found one runtime writer of `fan_username_aliases`:
`upsertFans`. The other occurrences under packages/apps/scripts are readers,
schema declarations and historical migration/index statements. This fixes all
runtime callers of that bulk writer without changing call-site behavior.

The sort changes only the new `aliasValues` array. It preserves fan field-presence
groups, `hasPresentIdentity` template behavior, dedupe rules, fan INSERT order,
read-back and public input-order reconstruction. Both conditional UPDATE
predicates and `least(first_seen_at)` / `greatest(last_seen_at)` remain unchanged.
There are no schema changes, locks outside the existing statements or new
transaction boundaries.

## Regression witness

The fixture uses two dedicated PostgreSQL clients and the actual `upsertFans`.
Only the scheduling is instrumented; query text, parameters and results are not
rewritten. First A changes and commits its fan statement, then B changes in the
second call. Both alias statements are released together. A test-only trigger
pauses immediately before each statement's second alias, after a real first-row
lock. It releases the shared advisory lock before trying the second row.

The coordinator releases the gate for either possible schedule: one statement
holds the first alias and the other waits for it (fixed order), or both own
different first aliases (the old regression). The test then requires both
actual calls to succeed. It does not force the fixed order or assert a specific
Drizzle SQL column layout. Thus the unfixed writer should fail with the actual
`40P01`, whereas the fix serializes the overlapping alias statements.

Two concurrency cases cover the same input order and a reversed second input;
both require the caller's return order and the final A1/B1 profile state. A third
case compares alias `xmin` and timestamps across a no-op, then verifies a rename
keeps the original history and original first-seen timestamp. Dedicated sessions
are closed after every case so their trigger gates/timeouts cannot leak through
the pool.

## Validation and coordinator commands

Completed locally: offline frozen-lockfile dependency install; targeted ESLint
for both files (exit 0); `git diff --check` (exit 0). The new file has intent-to-add
only so `git diff` includes it. No suite was run, per the shared Testcontainers
serialization rule.

Run serially from the worktree:

```sh
pnpm exec vitest run tests/fan-alias-concurrency.integration.test.ts tests/fan-churn.integration.test.ts tests/db-write.integration.test.ts tests/fan-page-identity.repository.integration.test.ts tests/ofapi-fan-identities.integration.test.ts --maxWorkers=1 --no-file-parallelism
```

A useful negative control is the new fixture against the original `31b73a96`
writer in a separate disposable test checkout: expect the two concurrency cases
to fail with `40P01` and the no-op/history case to pass. Root owns execution and
records actual receipts; this author note does not claim those runs passed.

## Review boundaries

This removes the alias tuple-order regression within an INSERT. It is not a
claim that arbitrary outer transactions with multiple calls, differently ordered
fan-presence groups or erasure can never deadlock. Those fan/transaction ordering
risks predate this change and are not concealed by retries. Runtime reachability
and uncertain production frequency remain as recorded in `reviews/fan-writes.md`.

## Proposed decision note for root to append

Following Decision 293's conditional fan writes, `upsertFans` orders username
history writes by `(fan_id, username)` before every bulk alias INSERT. Conditional
RETURNING plus untouched-row read-back must not determine lock order: concurrent
autocommit callers have already released their fan locks. The writer preserves
field-presence groups, caller result order, last-seen write suppression and
history timestamps, with no extra retry or transaction scope. A PostgreSQL
overlap witness verifies both calls finish, including reversed caller order;
alias `xmin` and rename-history assertions guard the previous optimization.

Memory was consulted only to locate the prior load context (`MEMORY.md:249–250`,
rollout `01a091e1-f935-71e1-af7c-edd42fa6405d`); this implementation and its reasoning
are based on the current writer/schema, repository contracts and saved audit
evidence.
