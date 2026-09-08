# Bound Agent transcript material to window candidates

A narrow Agent transcript request can load an entire long conversation before
its time filter applies. Select candidate message refs in the requested window
first, then load every source version of those refs and retain the existing
source preference, tombstone dominance, purchase upgrade and final predicates.
This changes 34 lines of the repository query and adds no flag or migration.
Decision 281 and the reply-repair runbook document the operational gate.

The production trigger occurred during an owner-approved pre-A0 reply replay.
Lora-3 passed 54/54 targets; lora-2 passed 63/63. Lora-1's 170 observations are
v6 and 140/143 targets pass parent/root, normalized text and attachment material.
Three targets in conversation 790634843078664193 remain unaccepted because the
same exact transcript read failed at both a two-second and a two-millisecond
window. The inventory reports 10298 stored messages, the largest lora-1 thread.
The API recorded HTTP 503 in 10.502 seconds at 20:27:41 UTC on 8 September.
Both Lilly replays remain unstarted under the per-page acceptance gate.

The narrow query's whole-conversation material work is proven locally. The
production log does not identify the failing subquery, and read_only has no
SELECT grant on the message base tables, so no production EXPLAIN was attempted.
A separate coverage read also timed out; its additional evidence queries are not
changed here. Catalog reads show the relevant indexes are valid. This is not a
certified complete RCA for either timeout or the separate slow sync-health read.

## Local reproduction

Postgres 16, the production migrations, one conversation with 10298 archive rows
and 10298 hot rows, 2048-byte text fields, a two-millisecond window, one result:

| Measurement | Main 18649bd9 | This query |
|---|---:|---:|
| Wide material candidates | 20596 | 2 |
| Repository list call | 29.311 ms | 3.338 ms |
| Count probe | 24.561 ms | 1.773 ms |
| EXPLAIN ANALYZE | 28.126 ms | 0.440 ms |

The returned row, all material fields, witnesses and count match. The bounded
plan uses the existing time/ref indexes; no new index is introduced. A separate
wide-window comparison returned the same 200 rows: 47.624 ms before and 43.596 ms
after. These are individual local measurements, not production predictions or
percentiles. `baseline.json`, `bounded.json` and `wide.json` contain the evidence.

To reproduce, copy `benchmark.ts` into
`tests/agent-transcript-benchmark.integration.test.ts`, run it against the
baseline revision, then use `BENCHMARK_TAG=bounded` and
`BENCHMARK_COMPARE=investigations/agent-transcript-window-2026-09-08/baseline.json`
against this query. Use `pnpm exec vitest run --no-file-parallelism` and remove
the temporary test afterward. It is kept outside the default suite because it
is a measurement fixture, not a timing-threshold regression test. The initial
fixture run failed only while serializing a BigInt; the corrected artifact
serialization preserves it as a decimal string. Both measured runs passed.

## Semantics and validation

Directly filtering each material arm by time would be incorrect: a preferred
source outside the window must still suppress an older in-window copy. The
candidate phase therefore reads only refs; the material phase retrieves all
versions of each selected ref in the original page/conversation scope. Null-time
rows remain candidates. Cross-conversation OFAPI delete stubs and out-of-window
hot purchase receipts still apply to selected refs. The independent unbounded
archive floor, keyset semantics, row/count budgets, audit and error contract are
unchanged.

Docker-Postgres validation passed, 4 files / 120 tests / zero skips:

```text
pnpm exec vitest run --no-file-parallelism \
  tests/agent-transcript-window.integration.test.ts \
  tests/agent-read-operations.integration.test.ts \
  tests/agent-read-isolation.integration.test.ts \
  tests/agent-read-gates.integration.test.ts
```

The three new cases cover source timestamp movement across both window edges,
null timestamps, exact boundaries, an unbounded capture floor, out-of-window
hot tombstones/purchases, account-wide null-conversation delete stubs, other
page/thread isolation, dedup, both keyset directions and count stability. The
existing API suites validate route evidence, authentication, grants and budgets.

`pnpm check` passed: strictness ratchet retains the existing 1908-error /
121-file baseline without a budget change; lint passed; 280 unit files passed,
3110 tests passed and 9 existing tests skipped; dashboard build passed.
`pnpm build:production` and `git diff --check` also passed. Full command logs
are retained beside this report. Independent review of immutable implementation
`d77d6aaf8855354aee0edca39d878d9e91ceeeb9` found no blockers; see `REVIEW.md`. No
production deployment, flag change, additional replay or restricted SQL access
was performed for this code change. The production replay evidence remains in
the operator workspace at
`investigations/fansly-five-page-reply-replay-2026-09-08/`.

## Release and rollback

Deploy only after independent review, required checks and a separate owner yes
for the concrete revision. Keep head catch-up `none`. After deployment, retry
the three blocked lora-1 targets and complete its original 143-target cohort;
only then resume the previously approved Lilly reply scopes, with fresh previews
and per-page serving checks. A successful deploy is not itself acceptance of
read latency. Rollback is the prior code on identical schema and data. This
change does not authorize lilly-2 head recovery, A0, A1 or B2, and makes no HTTP
savings claim.
