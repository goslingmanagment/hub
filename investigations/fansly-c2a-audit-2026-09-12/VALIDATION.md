# C2a audit validation — original 12 September candidate

Historical results on `9ddf153c`, before the later main synchronization and
renumbering. See [MAIN-SYNC-20260912.md](MAIN-SYNC-20260912.md) for current checks.

All tests ran locally and serially. No production call, deployment, flag change,
provider request, replay or rebuild was part of this validation.

The original C2a worktree was synchronized with current main
`c0cd21c3e9c85a795c71e05e4a887aaf252f3270` by merge `c36c41ab`.
Main was fetched again after the final code change. Its latest decision is 293;
C1 and the separate Ping release reserve 294 and 295. This change uses 296.
Migrations 0186–0188 are additive; applied production 0182–0185 remain immutable.

## Required checks

`pnpm check` exited 0 after all review fixes:

- 296 unit files, 3,241 tests passed; nine existing skips.
- Typecheck/strictness ratchet, lint and dashboard build passed.
- Existing strictness debt: 1,901 known errors in 121 files, within budget.
- Unit duration 18.98 seconds; dashboard build 2.06 seconds. The existing
  large-chunk build warning remains visible in the retained log.

The following Docker-Postgres command exited 0 after that check:

```sh
pnpm exec vitest run --no-file-parallelism \
  tests/fan-earnings-audit*.integration.test.ts \
  tests/fan-earnings-identity.integration.test.ts \
  tests/fan-earnings-projection.integration.test.ts \
  tests/capture-payloads.repository.integration.test.ts \
  tests/erasure-page-owned-tables.integration.test.ts
```

Eight integration suites passed: 44 tests, zero skips, 31.52 seconds.
They exercise the real parser/projector and restricted SQL readers, including:

- A-B-A, stale arrival and equal-time ordering, checked at each intermediate
  state; legacy source IDs, pending projections and exact source mismatches.
- Zero-valued and absent fans, empty and partially invalid bodies, scoped CAS
  authorization, detached data, payload limits and nested-field redaction.
- Stable pagination under concurrent writes in one repeatable READ ONLY
  snapshot, restricted grants, exact corpus counts and full projection scope.
- Real-PG export evidence, hashes, private files, wrong-role rejection and
  collection/cleanup failure. Separate unit tests exercise actual child
  processes for spawn failure, clean EOF and ignored SIGTERM.

## Local scale measurements

A separate two-test Docker-Postgres run passed in 21.23 seconds. Measurements
were retained by the fixtures in `evidence/corpus.json` and `projection.json`.
The final regression run above repeats both fixtures without replacing those
measurements.

| Fixture | Measured local read and comparison time | What it proves |
|---|---:|---|
| 120,000 captures, 1,000 fan/window keys | 13,155 ms | Batches exhaust the retained corpus; absent events/projection remain unverified. |
| 1,000 real captures and projected source receipts | 129 ms | The real canonicalizer/projector produces 1,000 matching rows with resolvable receipts. |

Each fixture's captures use a single month. These are local PG-client timings;
they exclude SSH, export file I/O, production query load and provider latency.
They prove neither HTTP savings nor production projection correctness.

## Retained evidence and remaining gate

`evidence/check.log`, `integration.log` and `scale.log` retain the successful
outputs. `evidence/manifest.json` hashes the implementation, tests, documentation
and retained outputs; the manifest itself is excluded from its hash inventory.
Both independent reviews are recorded in REVIEW.md.

Production parity remains unmeasured. Compressed or otherwise unavailable
captures prevent verification even if every available row matches. Delivery
must preserve the current production release and applied migrations before the
bounded report can run. Explicit repair and flag activation remain separate.
