# Fansly C1 — follower reconciliation diagnostics

[PR166](https://github.com/goslingmanagment/core/pull/166) remains the single C1
draft. It now includes a bounded run timeline needed to establish the cause
before a narrow policy fix. Branch `feat/fansly-c1-followers` is based on main
`32478124`; Decision 291 and migrations 0182–0183 follow its latest numbers.
No follower predicate, cadence, presence writer or provider request changed.

## What is ready

The original report counts all three OR predicates, including no request, and
atomically captured prior queue sequences. The new timeline exposes the
individual receipts and both follower streams, with all run outcomes. It keeps
claimed revisions separate from membership generations and successful
non-destructive close separate from membership certification. Decision and
queue validity are independent; malformed or missing evidence stays unknown.

The reader accepts at most eight days and 500 runs per page. A pinned upper ID
excludes later inserts, but does not freeze mutable run outcomes. Only selected
scalars, bounded timestamps and named membership proofs are exported; fan IDs,
message bodies, headers, arbitrary errors and lease tokens remain private.
See the [runbook](../../docs/runbooks/fansly-followers-diagnostics.md).

## Validation

- `pnpm check`: 3,205 tests passed in 292 files, nine existing skips; strictness
  remains 1,908 known errors in 121 files. Lint and dashboard build passed.
- Serial real Docker-Postgres: 70 tests in five files, zero skips, 27.03 seconds.
  Suites: followers-timeline, followers-diagnostics, generation-high-water,
  page-sync-lease-fencing and sync (all `.integration.test.ts`).
- The timeline checks real handler receipts; partial, failed, skipped and
  non-destructive completion; pinned pagination; exclusive boundaries; late,
  duplicate and malformed receipts; restricted-role permissions; private-data
  exclusion and invalid query bounds. Existing queue, lease, generation and
  presence tests passed.
- Independent review identified an absent queue-validity marker. It was added
  with seven malformed-queue fixtures. Final review is recorded in REVIEW.md.

The SQL reader is 126 lines and its integration suite is 143 lines. No new
runtime module or flag is needed for this addition. Local test logs are retained
as evidence; they do not establish production latency or query-plan performance.

## Production evidence and next gate

The 11 September 00:24 UTC catalog read again confirmed read_only / READ ONLY
and no deployed follower diagnostic reader. At 00:33 UTC, all three roles were
healthy with zero restarts and 25 GiB free on image `f742e86eca4c...`, source
`32478124`. That release was already present; this turn did not deploy it.
It includes C2a/C2b code. Replay completion, projection repair and C2b enablement
were not checked. The C1 delta does not bump their parser or select extra work.

The verified T0 export for 1–6 September contains 20,881 follower-reconcile
physical attempts: 19,420 anomaly-source and 1,461 scheduled-source. Ordinary
followers added 3,079 attempts. These retained counts include retries and are
not complete telemetry; neither the anomaly label nor its frequency establishes
redundancy. [Per-page/source totals](evidence/t0-followers.json) retain the
baseline hash. Branch frequencies and completed-generation consolidation remain
unmeasured because their reader is not deployed.

Next: explicitly approve the reviewed C1 diagnostic revision, deploy against
the current compatible main, and retain bounded reports. Then establish the
headline/deletion/pagination cause and add the narrow policy fix to this same
PR. The existing drift/blast-radius guards and presence consumers remain exit
criteria. A0 continues separately; A1, live sockets and C2b enablement are gated.
