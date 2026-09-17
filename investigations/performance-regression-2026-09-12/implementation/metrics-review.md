# Independent review: recent ops metrics

Verdict: **APPROVE the code and architecture**, conditional on the coordinator's
serial PostgreSQL checks below. No deployment-blocking defect was found in the
reviewed patch. This is a static review, not a claim that the author ran the tests
or that production latency has already improved.

Reviewed worktree: `/Users/dmitriy/code/goose/.worktrees/hub-perf-metrics-20260912`.
Base: `31b73a9691f32f8c33c3fe479bca68533c7048d6`.
Reviewer: `/root/review_metrics_fix`, separate from the author.
Full `git diff --binary` SHA-256:
`071a9e982d24d8fa950999b7822d1447614a6b5905de4f3242e424976c4a6745`.

## What was independently checked

- Read `CLAUDE.md`, decisions 96/102/293 and the Stage 25 metrics contract; traced
  the schema, writer, repository caller, production migration runner, deployment
  migration allowlist and rollback decision path. The only runtime caller is
  `getGoldenSignalsReport`, passing the fixed integer `perSeries: 30`.
- The old query ranked all stored rows. The replacement has one recursive prefix
  enumerator and one bounded read per prefix. Both key columns are non-null text;
  SQL prefix comparison, the index and output ordering use the same database
  collation. There is no JavaScript ordering or hard-coded series list.
- The next-prefix predicate is strictly greater than the previous tuple and is
  ordered by that same tuple, so enumeration advances without duplicates or a
  cycle. Empty tables terminate immediately; arbitrary names, empty names,
  arbitrary stored quantiles and discontinued series remain discoverable.
- Discovery and reads use one statement snapshot. No cache, new write state,
  retention cutoff, collector change, public contract change or business-fact
  deletion was introduced. Newest-first selection and final ordering match the
  old defined behavior. The original query never specified a tie-breaker for
  equal timestamps; choosing another subset at a truncated tie is not a lost
  preexisting ordering guarantee.
- The supporting B-tree has the exact `(metric, quantile, sampled_at DESC)` key
  needed for both probes. `INCLUDE (value_ms)` permits an index-only path but is
  not required for correct results. Retaining the two earlier indexes preserves
  the one-metric history and retention/deadman access paths.
- Migration 0186 uses the established 0169/0177/0184 non-transactional protocol.
  The invalid-index cleanup is limited to one exact name in `public`; successful
  builds are retained. A restart after the build but before ledger insertion
  is idempotent. The global migration lock and nonblocking lock acquisition
  remain unchanged.
- 0186 is additive, has no constraints or column changes and is safe for the
  deployed old application. Its exact allowlist entry enables the existing
  rollback procedure only for this known-compatible delta; unrelated migrations
  still block automatic rollback. An unfinished additive index also does not
  make the old image incompatible.
- The regression test captures the actual repository SQL at the pool, compares
  legacy and current results, covers stored-series edge cases and timestamp
  ties, and checks actual PostgreSQL access plans. The separate benchmark also
  captures the real query and alternates legacy/new execution. These are useful
  behavioral/performance checks rather than a second maintained implementation.
- `git diff --check` passed during this independent review. No Vitest, database,
  production command, source edit, commit, push or deployment was performed by
  the reviewer.

## Execution gates for the coordinator

1. Run the new metrics integration suite plus `golden-signals.integration`,
   `ops-watchdog.integration`, `compose-config`, and migration runner/invariant
   tests serially. Require exact output comparison to pass outside unspecified
   timestamp ties, and the actual chosen new plan to use the new index with the
   fixture's bounded row work. No forced index/scan switches should be added to
   obtain a passing plan.
2. Run the provided representative benchmark serially. Preserve full plans,
   buffer counts, result equality and added-index size, not just wall time.
3. Exercise 0186 against a populated disposable table using the production
   runner, then rerun and verify the index stays valid and the ledger has one
   entry. The current integration setup and benchmark build the index on an
   empty table before filling it, so they do not themselves prove a populated
   concurrent build or rerun. Prefer also a cancelled/invalid-index recovery
   probe if the coordinator already has the migration harness available.
4. Before deployment, confirm 0186 is still the next free migration and current
   production is the reviewed schema base. Check free disk against the measured
   added index/build footprint. After deployment verify the index is valid, the
   metrics endpoint retains its response shape and a read-only EXPLAIN uses the
   intended bounded path under production statistics.

## Non-blocking limits, stated explicitly

- Valid finite integer limits preserve behavior, including zero and negatives.
  The early return broadens success for invalid negative numeric inputs (for
  example `-Infinity` or `-0.5`) which previously reached PostgreSQL and failed
  bigint parsing. An untyped caller passing `undefined` would reach `LIMIT NULL`
  and request all rows, whereas the legacy comparison to NULL yielded none.
  The sole runtime caller is fixed at 30 and the repository type requires a
  number, so this is not a reachable production regression. If the parameter
  later becomes externally configurable, validate it as a finite integer before
  calling this repository rather than exposing the internal helper directly.
- The asserted row-work reduction concerns visible tuples in these fixtures,
  not an absolute physical-I/O bound under arbitrary MVCC bloat or dead index
  entries. The benchmark vacuums its fixture; the integration test's freshly
  inserted heap additionally exercises a non-all-visible case. Neither predicts
  production latency or the number of invisible entries visited.
- The additional index costs disk, WAL and maintenance on each sample insert.
  With the existing small, repeated series set and minutely writer this is a
  proportionate tradeoff for removing repeated full-history reads. A workload
  where nearly every row introduces a new metric would need reassessment.
- Migration construction can extend startup while application processes wait
  for the migration lock. The existing 1,200-second health window and concurrent
  build machinery handle that path; measurements still belong to the coordinator.

## Reviewed file hashes (SHA-256)

| File | SHA-256 |
| --- | --- |
| `packages/db/src/repositories/ops-metrics.ts` | `6a2e6b8b06d6b3d7d9aaa5b5bcaefaec68e9e440d56695966b89bd70b245ae6d` |
| `packages/db/migrations/0186_ops_metrics_recent_series.sql` | `8fde039eb9e8f0d211ab419f0cd7264e5186aa79d9e223c6a4a42a083d571b7e` |
| `tests/ops-metrics-recent.integration.test.ts` | `6cb23cac57d58861a34d84d35cefc164df3dbcac8814b67984769c2c4d2998d4` |
| `scripts/benchmark-ops-metrics.mjs` | `f1e90a5f148bd1c1ffac6de19ae50efbdee8e753d2ae0a37cd6275726d3e924b` |
| `scripts/deploy-production.sh` | `852d3ef6e32aba98b6eae3a30790c5cc06b8b2d94d8c74d90d177f01b0a328c3` |
| `tests/compose-config.test.ts` | `0900f616d9351bdb68a5614bd6aace9227cd7dfed3ce247885c2c5c71cb6cce7` |

## Re-review: range scan after the central plan gate failed

Final code-review verdict: **APPROVE the revised range query**. This approval
supersedes the initial candidate assessment above. The initial equality-based
candidate did not meet the mandatory execution gate: `metrics-plan-failure.json`
shows the sample read choosing `ops_metric_samples_sampled_at_idx`, filtering 266
other-series rows per loop across ten loops, for 2,971 visible tuple visits.
The earlier static assessment was conditional, and that candidate correctly did
not proceed to commit on its original evidence.

The updated author source was independently reread in full. It now starts the
limited scan at `prefix >= P`, orders by the complete composite index key, and
applies exact-prefix equality outside `LIMIT N`. The migration, benchmark code,
deployment allowlist and compose test are unchanged.

Correctness proof for the sparse case:

1. Under the same SQL ordering used by the range comparison and index, the
   ordered suffix beginning at P consists of all rows of P (newest first),
   followed by rows whose prefix is strictly greater than P.
2. If P has at least N rows, the first N suffix rows are precisely its newest N.
   If it has fewer than N rows, all of its rows are in that first N, followed by
   at most N minus count(P) rows from later prefixes.
3. The outer equality removes only the later-prefix rows. The output is thus
   exactly the newest `min(N, count(P))` rows of P. Those later-prefix rows are
   emitted only during their own recursive-prefix iteration, so overshoot does
   not introduce duplicates. The final sparse prefix simply reaches the end of
   the index. None of this depends on the age of the sparse samples.

The comparator and complete ORDER BY keep both prefix keys significant inside
the limited query. A global timestamp index alone cannot supply that order.
Keeping equality above LIMIT is an intentional access-path requirement and is
explained in the source; moving it back inside may recreate the observed poor
plan even though logical output still agrees. This is not an index hint or a
planner-GUC override. The central fresh-heap test is the empirical gate that
PostgreSQL 16 preserves the intended efficient path; a future optimizer or
materially different distribution must pass that gate and live plan validation
again. The limit bounds rows produced by each sample scan to N; the earlier
MVCC/dead-index-entry physical-I/O caveat still applies.

The schema still has non-null text prefix columns using their column/default
collation. Range comparison, full-key ordering, exact-prefix filtering and final
ordering are performed in SQL with that same collation. No locale-dependent
JavaScript comparison was added. Equal-timestamp ordering remains unspecified as
before. Both discovery and range reads are still inside one statement snapshot,
so a concurrent insertion or prune cannot create a between-phase membership
change.

The augmented plan fixture adds sparse first/middle/last prefixes, including a
previously unseen quantile within an existing metric, with timestamps older than
all dense samples. It compares the complete output against the legacy statement
and retains the <500 visit assertion over 50,003 stored rows. This checks both
overshoot filtering and the failure mode hidden by a vacuumed benchmark.

Evidence independently read during this re-review:

- `metrics-final-integration.log`: four suites, 59 tests passed. Reviewed runtime
  source and expanded integration-test hashes exactly match the release
  worktree where that log ran. The reviewer did not run another suite.
- `metrics-populated-control.json`: the unchanged migration built on 1,000,002
  rows and reran successfully; `indisvalid` and `indisready` are true; measured
  index size is 49,692,672 bytes. Its query timings belong to the initial query,
  so they are not acceptance measurements for the revised range query.
- `git diff --check` passed for the final author patch.

Before release, the coordinator must finish the revised-query representative
benchmark/equality checks, retain the normal combined gates, and verify the live
index and read plan after deployment. No new code or architecture blocker was
found. The prior nonblocking malformed-limit-input observations remain unchanged.

Final author `git diff --binary` SHA-256:
`cfa09195c8fc17b1ea48b6ce86113b007a7a97a09e5995b9a75da1ba53355cbb`.

Updated file SHA-256 (other four hashes above remain current):

| File | SHA-256 |
| --- | --- |
| `packages/db/src/repositories/ops-metrics.ts` | `788c7ca54ce4b65f29d0d42b09a47c28916bc367d92171a43ea031ee2e46fb38` |
| `tests/ops-metrics-recent.integration.test.ts` | `08ec6d56f9032441e616a553e033a5cce6cf4de5da15aad63f1dba2092aaeb6f` |
