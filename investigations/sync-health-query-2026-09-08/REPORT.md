# Sync monitor activity query

The monitor now reads activity for the selected running run through existing indexes. It previously aggregated the entire retained attempt/event history before choosing the current run. No health result is omitted or converted to success.

## Incident boundary

The owner-approved deployment of PR159 (`b213c32e70f8`) on 2026-09-08 failed six 150-second `/api/v1/health/sync` reads. The standard script automatically rolled back to `b47f552abb97`; production roles and `/health` were healthy at 16:59 UTC, with catch-up still `none`. The failed attempt is documented in https://github.com/goslingmanagment/core/pull/159.

Production was read-only during diagnosis: `read_only`, `BEGIN READ ONLY`, statement timeouts, container logs/stats and authenticated configuration viewing. At 17:08 UTC catalog estimates were 166280 runs, 689580 HTTP attempts and 1073960 events. At 17:10 UTC estimates were 47840 DM threads and 131773 page-fan links; the earlier message estimate was 566860. Catalog estimates informed synthetic fixture scale; they are not exact row counts or a copy of production data. The DB role cannot see other-role query text. Postgres CPU was high during deployment, and one archive projection tick took 242 seconds. None of this proves which production query caused the timeout.

## Reproduction and change

Postgres 16 in Docker, normal integration migrations. Synthetic six-page fixture: all 17 Fansly streams, 166286 runs, 665120 attempts, 1163960 events, 132000 fans/page links, 48000 partial-window DM threads and 576000 messages. Historical runs are completed; six current runs have no activity. The separate correctness suite exercises real current activity and selection conflicts.

| Measurement | Before | After |
|---|---:|---:|
| Repository call, ms | 3137.6 | 987.8 |
| EXPLAIN ANALYZE execution, ms | 4323.7 | 1112.7 |
| Historical event scan loops | 6 | 0 |
| Temp blocks written | 37988 | 4657 |
| Returned monitor rows | 102 | 102, identical |

The old event subplan scanned 1163960 rows six times. The new activity subplans make six indexed run-ID probes. Attempts' all-history physical-health calculation remains present deliberately: old failed or stale attempts after the last success must remain visible even outside the recent reporting window. This single before/after benchmark is not a production latency distribution and does not reproduce the 150-second deployment timeout. It measures a removable query cost, not a certified incident root cause or platform HTTP savings.

Implementation: retain the running row-number selector and ID tie-break; move the two activity aggregates below it as lateral lookups. `greatest` retains the run-start floor and ignores absent activity. The completed and physical-health calculations, page/stream scope, API contract and deploy script do not change. No new flag or migration.

Full SQL, bound parameters, normalized output and plans are retained in `baseline-with-dms.json` and `bounded-activity.json` (synthetic metadata only). To repeat from repository root, copy `benchmark.ts` to `tests/sync-monitor-benchmark.integration.test.ts`, run `BENCHMARK_TAG=repeat BENCHMARK_COMPARE=investigations/sync-health-query-2026-09-08/baseline-with-dms.json pnpm exec vitest run --no-file-parallelism tests/sync-monitor-benchmark.integration.test.ts`, then remove the copied fixture. Do not overlap other Vitest suites. To recreate the old plan, use this fixture in a worktree at b213c32e70f84cc17a03526b4920e2de5988f7a5. The comparison asserts every normalized output field; timing is evidence, not a flaky test threshold.

## Validation and release

Docker-Postgres validation passed: 15 tests in `sync-monitor.integration.test.ts` and `sync.integration.test.ts`, zero skips. Full `pnpm check` passed: strictness budget unchanged (1908 existing errors / 121 files), ESLint, 280 unit files / 3110 passed tests / 9 existing skips, dashboard production build. `pnpm build:production` also passed. Independent review of e12620c6b5412b3dcfd7e3ac6a0b0fc01a26f87d found no blockers; see REVIEW.md. The focused integration tests cover selection ties, older/completed activity isolation, finish-time maximum, in-flight attempts, event progress, absent activity, page/stream scope and historical physical-failure debt with no active run.

Production has not received this change. Next deployment must include the retained v6 replay/fresh-capture ordering from PR159 and leave catch-up `none`, after an explicit owner yes. The ordinary gate remains authoritative; a failure must not be bypassed. There is no claim that this change alone guarantees the gate will pass. A0/T0 remain unstarted, lilly-2 recovery remains separately gated, and no new live socket/A1/B2 permission is implied.
