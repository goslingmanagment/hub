# Full CI: remaining optimization candidates

Scope: read-only follow-up to PR #225; no workflow/test behavior changes made. A temporary local measurement test was removed after execution. No new hosted run was started.

## Evidence

- Hosted full run 35125171131: 47 rounded runner-minutes = 33 integration + 12 static + 2 admission/quality. These are aggregate runner minutes, not elapsed wait time.
- DB Vitest phase totals: import 131.00 + 116.46 + 140.11 = 387.57s; test execution 445.95 + 389.11 + 460.58 = 1295.64s. The three serial shards execute concurrently on separate runners.
- Unit phase import 438.69s and test execution 199.47s are cumulative across workers; they must not be added to or subtracted directly from the 375.31s unit wall time.
- The cold Docker build took 194s, including 87.5s initial cache preparation/export. The later warm frontend build took 92s. That comparison does not prove a saving against the earlier plain-Docker 86s build, and build-cache work cannot address the 33-minute DB share.
- Local reset microbenchmark: 30 resets, 3018ms total, median 99.38ms, 274 public tables (272 reset targets after two reference/migration exclusions). TRUNCATE alone used 2881ms / 95.5%; catalog lookup used 49.9ms total. Empty DB, Node22, local Docker: not a CI savings estimate.
- `resetIntegrationDatabase` appears in 202 test files. This is a file count, not a count of resets per run. The real suite also spends time seeding fixtures, building API servers and exercising password hashes.
- `tests/helpers/db.ts` imports two constants from `global-setup.ts`, which imports Testcontainers and the migration runner. Broad DB/shared barrel imports are another candidate dependency graph. Import narrowing needs a profile and before/after measurement; static dependency edges alone do not establish time saved.
- `fan-earnings-audit-scale.integration.test.ts` deliberately waits 100ms across 151 response batches (15.1s nominal) to simulate WAN latency. Its assertions count batches and validate results; the delay could be conditional on an explicit benchmark mode while correctness/scale coverage remains. Real transport deadlines and race synchronization must remain tested.

## Priority

1. Reduce the repeated import graph while retaining file isolation. First candidate: move the shared test-DB constants/type augmentation into a lightweight module. Then profile broad entrypoints and preserve package architecture boundaries when introducing narrow ones.
2. Profile and narrow expensive fixture work. Cache/reuse immutable fixture material only where semantic isolation remains intact. Single-connection repository tests may use scoped transaction rollback; API, worker and concurrency tests use independent connections and cannot be covered by a blanket outer transaction. Do not replace the safe full reset with an unchecked handwritten table list.
3. A bounded two-worker experiment inside a DB shard may overlap waits and module work. It is not equivalent to adding paid runners or disabling isolation. Retain one database per acquisition and test cluster-global queries, locks, connection limits and cleanup repeatedly before adoption. CPU/DB contention may cancel the gain.
4. Separate synthetic benchmark latency from ordinary correctness tests. Small, concrete saving (15.1s in the known file), not the main lever.

Already done: migrated template clones, shared Postgres per run, disposable-DB durability tuning, dependency caching, duplicate host build removal. Do not present them as new opportunities.

Not priorities: more paid shards (primarily latency rather than aggregate cost), more pnpm-cache work (3–6s installs), globally disabling file isolation (previously caused order-dependent failures), moving further mandatory coverage to nightly solely to improve this metric.

A useful next implementation is a small import-graph change plus a targeted fixture profile, measured against the same revision/test selection/worker count. Require unchanged assertions and successful full regression gates before accepting a speed claim. No numerical saving is promised before that comparison.

Primary profiling reference: https://vitest.dev/guide/profiling-test-performance.html
Local evidence: implementation/cold-reset-profile.json and implementation/cold-reset-profile.log.
Hosted evidence: implementation/hosted-full.json and implementation/hosted-full.log.
