A0's hot-table counter cannot distinguish a readable archived head from a preferred pending or deleted archive copy. This change classifies each advertised head before applying its provider page, using Agent-reader precedence and scoped tombstones. Seven nullable counters preserve legacy and resumed evidence as unknown. The original hot counter remains separate; flag `none` adds no reads.

Both diagnostic queries share one read-only repeatable-read snapshot and a decreasing query allowance. Migration 0194 adds a fixed EXECUTE-only cost probe for `read_only`; applied 0192 is unchanged. Decision 335 and the runbook describe scope and rollback. Full polling and business writes retain their existing behavior.

## Validation and review

- `pnpm check`: **3,779 unit tests passed, 9 existing skips, 329 files**; typecheck, ratchets, lint and build passed.
- Docker PostgreSQL: **84/84 tests passed in 8 serial suites**, with `ALLOW_MISSING_TEST_PREREQUISITES=0` and `--no-file-parallelism`.
- Tests cover real reader precedence, pending/deleted/archive-only states, page/group fences, pre-apply state, immutable query snapshots, decreasing timeouts, legacy unknowns, flag-off zero reads, unchanged business outcomes and migration privileges.
- Combined validation ran on `d09920e77773e164ab7402120b61382f08f34376`; the publication adds evidence only. All five required checks passed on published head `9aac9988e6998ee8c16e7e313d733fb62d731a7c`: [CI run](https://github.com/goslingmanagment/core/actions/runs/34867166921).
- Independent correctness and readability review closed before merge. [Validation evidence](investigations/fansly-a0-reader-head-state-2026-09-14/REPORT.md) and [source review](investigations/fansly-a0-reader-head-state-2026-09-14/REVIEW.md) retain commands, logs and resolved findings.

## Production result — 14 September 2026

Merged and deployed as `ac92197ba9760833ae035c3f5e8a90d084010fe6`, tree-identical to the published head. The standard dist-only deployment completed successfully at **16:29 UTC**. API, worker and scheduler were healthy with zero restarts immediately afterwards and at the 17:42 follow-up. Only migration 0194 was added; all 189 prior migration IDs/timestamps were preserved. No flag was changed.

Six serial read-only cost samples at **16:31 UTC**, each using 100 current stored heads:

| Page | SQL execution ms |
| --- | ---: |
| ari-1 | 128.655 |
| lilly-1 | 4.818 |
| lilly-2 | 70.977 |
| lora-1 | 122.460 |
| lora-2 | 96.664 |
| lora-3 | 143.473 |

All six calls completed without retry or provider traffic. These are inner-query costs under mixed cache states, excluding planning, head sampling, pool checkout and the old hot query. They are not p95/p99 or an end-to-end five-second bound. Pool checkout is not cancellable by this helper.

The 17:42 cumulative A0 export contains **15 complete reader sweeps and 47,482 advertised-head checks**, with **two missing-head occurrences** below candidate stops in Lilly-2 generations 6917 and 6918. A running sweep is separate; 1,072 old rows lack the fields and one transition row retains nulls. The export is non-atomic. Aggregate counters do not establish unique missing objects or their cause. Independent post-release and numerical reviews verified these results.

**A0/A1 remains NO-GO.** Exact-ID checks do not certify full transcript parity, reclassify the old observation window, satisfy the coverage gate, or prove HTTP savings or event-to-reader latency. Local raw release and review evidence is retained under `investigations/fansly-a0-reader-head-state-2026-09-14/release/` in the operator checkout.
