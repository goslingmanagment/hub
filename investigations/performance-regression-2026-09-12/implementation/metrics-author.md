# Metrics fix — author handoff

Worktree: `/Users/dmitriy/code/goose/.worktrees/hub-perf-metrics-20260912`.
Base: `31b73a9691f3` (production revision supplied by coordinator).
Scope: only latest-N-per-series ops metrics reads and their supporting index/deploy compatibility.

## Problem and implementation

`GET /api/v1/ops/metrics` requests 30 rows per `(metric, quantile)` but the original
`row_number() over (partition by metric, quantile order by sampled_at desc)` ranked
all retained samples. FOLLOWUP.md identified the exact query shape in live slow
logs at 10.1 and 12.9 seconds. These are historical measurements of the old path,
not a production benchmark of the proposed fix.

The replacement is one SQL statement:

1. Recursive loose index scan finds the first stored `(metric, quantile)` and
   jumps directly to the first prefix greater than the preceding prefix.
2. One lateral read starts at that prefix (`>=`), orders by the complete index
   key, and takes N rows; an equality filter outside that LIMIT removes any
   rows from later prefixes when the requested series has fewer than N rows.
3. Final ordering sorts only the returned rows, as before: metric, quantile,
   sampled_at descending within each series.

Migration `0186_ops_metrics_recent_series.sql` adds
`ops_metric_samples_series_time_idx (metric, quantile, sampled_at DESC) INCLUDE (value_ms)`.
The query can use one index both for prefix enumeration and bounded sample reads.
Included values allow index-only reads when visibility permits; correctness does
not depend on VACUUM or all-visible heap pages.

The initial equality-based lateral query passed semantic checks but failed the
coordinator's fresh-heap plan test: PostgreSQL chose the global sampled_at index
and filtered other series (2,971 visited tuples vs the required <500). The
vacuumed 1M-row benchmark alone hid this choice. This follow-up adopts the
coordinator's tested range candidate and documents the required query boundary.

For target prefix P, the range `prefix >= P` ordered by `(metric, quantile,
sampled_at DESC)` begins with every row of P in newest-first order. Therefore its
first N rows contain exactly the newest `min(N, count(P))` target rows; any spare
rows can only belong to later prefixes. The outer equality removes only those
spare rows. A sparse series does not lose results, and at most N rows are emitted
by each limited index scan. The LIMIT boundary must stay BEFORE the equality
filter; otherwise the planner can treat both leading index keys as constants
again and select a global-time scan. With the range predicate, the leading keys
remain part of the required ordering, matching the composite index instead of
the global time index. There are no planner GUC overrides or index hints.

This keeps the source of series membership in the stored samples. A hard-coded
registry would miss unknown, retired, or newly introduced quantiles; a time cutoff
would hide discontinued/sparse series. `DISTINCT` on the history would retain the
unbounded scan. A persistent registry would add write/retention consistency state
for this single read; no such state is needed here.

For S series, H total samples, and N requested samples per series, index row work
is proportional to S × N (plus prefix probes), instead of H. There is still one
index descent per prefix and per sample page. A workload where nearly every row
has a unique metric would lose this advantage; the existing sampler emits a small
number of repeated metric/quantile series. This is a targeted query design, not a
generic timeseries store.

## Semantics and architecture checks

- Both prefix columns are NOT NULL TEXT. Query comparisons, index order, grouping,
  and returned order all use the database column collation. No JavaScript lexical
  ordering or enum/registry assumptions are introduced.
- No time cutoff, fixed known-quantile list, recent-series cache, or writes.
- A single statement uses one MVCC snapshot for discovery and reads; a concurrent
  prune or insert cannot produce mixed snapshots between phases.
- `perSeries <= 0` returns empty, preserving the old `row_number <= N` result.
- Timestamps with ties had no secondary order in the old query. The fix does not
  add one; exact byte/membership equality at a truncated tie boundary is not a
  preexisting guarantee. Tests assert the defined newest-N and membership rules.
- Existing sampled_at and metric/time indexes remain for other callers. Keeping
  them avoids unrelated reader/migration changes, at the cost of one additional
  index per insert. The benchmark reports the added index size.

## Migration and rollback

0186 follows 0169/0177/0184: `agency-hub:no-transaction`, generated cleanup ONLY
for an invalid index of this exact name, then idempotent `CREATE INDEX CONCURRENTLY`.
No applied migrations or schema columns change. Old application code runs against
the new schema and can use its existing indexes; reverting application images
does not require dropping the new index.

Per coordinator instruction, the exact migration filename is added to
`ROLLBACK_COMPATIBLE_MIGRATIONS` in `scripts/deploy-production.sh`, with a focused
assertion in its existing compose-config test. No other deployment behavior is
changed. Concurrent index construction still consumes temporary disk/IO while
building; actual local size and plan measurements are delegated to the coordinator.

## Files

- `packages/db/src/repositories/ops-metrics.ts`: replacement query and nonpositive-N handling.
- `packages/db/migrations/0186_ops_metrics_recent_series.sql`: supporting concurrent index.
- `tests/ops-metrics-recent.integration.test.ts`: five correctness/access-path cases.
- `scripts/benchmark-ops-metrics.mjs`: disposable PostgreSQL 16 benchmark, no external URL support.
- `scripts/deploy-production.sh`: additive index migration rollback allowlist entry.
- `tests/compose-config.test.ts`: pin for that compatibility entry.

## Validation handoff

Author ran successfully: offline frozen dependency install; targeted ESLint over
the modified TypeScript/JavaScript files; `node --check` benchmark script;
`bash -n` deployment script; `git diff --check`; `pnpm typecheck` passed the
strictness ratchet (1,897 known errors within the existing 120-file debt budget,
not a claim of zero-error tsc).
After the range-scan follow-up, targeted ESLint and `git diff --check` were rerun
successfully. No DB processes or suites were launched by the author.

As requested, the author has NOT run Vitest, Testcontainers, PostgreSQL, production
commands, git commits, pushes, or deployment. Independent reviewer and coordinator
execution are required before approval. Shared `docs/decisions.md` is untouched.

Coordinator serial test command from this worktree:

```sh
pnpm exec vitest run tests/ops-metrics-recent.integration.test.ts tests/golden-signals.integration.test.ts tests/ops-watchdog.integration.test.ts tests/compose-config.test.ts --maxWorkers=1 --no-file-parallelism
```

The new integration test seeds 50,003 rows, captures the exact shipped repository
query at the pg pool, compares legacy/new results, and runs EXPLAIN ANALYZE with no
planner switches or pre-test VACUUM. It requires legacy table visits >=50,003 and
new visits <500 for 10 dense series ×30 samples plus three sparse prefixes
(first/middle/last, including a new quantile within an existing metric), and
verifies the supporting index is selected. The sparse points predate every dense
sample, so an accidental global-time scan cannot find them near the time head.

Coordinator evidence for the initial equality query and the experimental range
candidate is in `implementation/metrics-followup.md`, `metrics-plan-failure.json`,
`metrics-populated-control.json`, and `metrics-range-control.log`. The final range
patch plus expanded sparse plan fixture still needs the coordinator's serial
suite/benchmark runs and independent re-review; no new timing result is claimed
by the author.

Standalone representative benchmark (run after tests, never concurrently):

```sh
node --import tsx/esm scripts/benchmark-ops-metrics.mjs > metrics-benchmark.json
```

Default fixture: 1,000,002 rows, 20 dense series and two sparse/discontinued series;
N=30; 602 output rows. It installs migrations through 0186 with the production
runner, captures the real repository SQL, asserts full result equality, alternates
three legacy/new EXPLAIN ANALYZE passes, checks bounded logical row work, and emits
full plans, timing, buffers, and index bytes. Times apply to this synthetic local
fixture only. Optional positional `samples-per-series` is bounded to 1,000–100,000.

## Proposed decision text for coordinator

Recent ops metric history is served by discovering stored `(metric, quantile)`
prefixes through the composite B-tree and reading the requested latest N per
prefix in one statement. Historical/unknown series remain visible. Migration 0186
adds the concurrent covering index without replacing existing indexes or changing
sample writers/retention. No new registry or cutoff is introduced. The additive
index permits application rollback. Regression evidence compares semantic output
and actual PostgreSQL row work; local benchmark timings are not production claims.
