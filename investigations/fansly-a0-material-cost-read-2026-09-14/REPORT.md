# A0 material-query cost read plane

The bounded cost probe is implemented and locally validated. Migration 0192
exposes one fixed current-head EXPLAIN to the existing `read_only` role, without
table SELECT grants or changes to polling, scheduling, capture or readers.
Decision 332 and the shadow runbook document execution and rollback.

The function selects at most 100 visible nonempty stored heads for one Fansly
page. It uses the runtime material query's typed VALUES, non-deleted hot-message
predicate and exact head-debt join. A source-fidelity test pins that query to
the runtime template. Caller READ ONLY, REPEATABLE READ, statement timeout
1–5,000 ms and lock timeout 1–100 ms are required before execution. PUBLIC cannot
execute it. The deployment compatibility list permits an older application to
leave this additive, unused function installed on rollback.

## Validation

Base: `4e18d130ea6ca4b834141789265cce8442f8fcae`.
The six changed source/document paths and the unchanged runtime query are
pinned in `source-manifest.json`; commands, UTC bounds and original/compressed
log hashes are in `evidence/*.json`. Logs are losslessly retained as gzip.
Independent source and receipt review is clean; see `REVIEW.md` for the exact
reviewed hashes, boundaries and test coverage.

| Check | Result | What it proves |
| --- | --- | --- |
| `pnpm check` | PASS: 325 files, 3,753 tests; 9 existing skips | Typecheck ratchet, lint, unit query fidelity/rollback pins and dashboard build |
| Five serial Docker-Postgres suites | PASS: 45 tests, no skips | Real probe, existing shadow/report behavior and forward migration history |
| New probe suite | 17 of those 45 tests | Bounded/empty samples, page scope/order, no table access or PUBLIC EXECUTE, safe ID quoting, caller guards, snapshot consistency and actual statement cancellation |

The PostgreSQL command was:

```sh
pnpm exec vitest run --no-file-parallelism \
  tests/fansly-dm-material-probe.integration.test.ts \
  tests/fansly-dm-shadow.integration.test.ts \
  tests/fansly-events-measurement.integration.test.ts \
  tests/production-migration-history.integration.test.ts \
  tests/migrate-runner.integration.test.ts
```

Both commands used `ALLOW_MISSING_TEST_PREREQUISITES=0` and caller
`NODE_OPTIONS=--max-old-space-size=4096`; the existing `test:unit` package script
sets its own 8 GiB limit. There were no failing attempts or source changes after
validation. The typecheck ratchet reports 1,897 existing errors within its
budget; this is not a claim that all repository type debt was removed.

## Production and remaining gates

This worktree made no production calls and measured no production cost. The
next action after review/merge/deployment is the runbook's bounded, serial
six-page read, retaining role/transaction/timeout receipts and raw plans.
Stop on timeout/failure; unmeasured pages remain unknown.

Current stored heads can bias and warm the sample. EXPLAIN instruments SQL
execution and does not return the material predicate results. The report does
not prove hot/archive/reader completeness, event-to-reader latency, 50% savings
or A0 acceptance. Existing discrepancy evidence and the original seven-day
clock remain authoritative. There is no new flag to flip.
