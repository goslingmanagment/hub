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

- `pnpm check`: 3,210 tests passed in 292 files, nine existing skips; strictness
  remains 1,908 known errors in 121 files. Lint and dashboard build passed.
- Serial real Docker-Postgres: 70 tests in five files, zero skips, 21.53 seconds.
  Suites: followers-timeline, followers-diagnostics, generation-high-water,
  page-sync-lease-fencing and sync (all `.integration.test.ts`).
- The timeline checks real handler receipts; partial, failed, skipped and
  non-destructive completion; pinned pagination; exclusive boundaries; late,
  duplicate and malformed receipts; restricted-role permissions; private-data
  exclusion and invalid query bounds. Existing queue, lease, generation and
  presence tests passed.
- Independent review identified an absent queue-validity marker. It was added
  with seven malformed-queue fixtures. Final review is recorded in REVIEW.md.
- A separate code-quality review found two test defects: dependent guard
  combinations and a calendar-sensitive window. Both are fixed, along with
  typed fixture inputs and explicit handler/reader coverage boundaries. The
  final re-review has no actionable findings. The five added cases independently
  protect the original predicates; all eight OR combinations remain covered.

No new runtime module or flag is needed for this addition. Local test logs are retained
as evidence; they do not establish production latency or query-plan performance.
The quality follow-up changes tests and review documentation only. Production
code and applied migrations are unchanged. Its validation receipt is retained
in [quality evidence](evidence/quality-20260911/validation.json).

## Production evidence and next gate

The owner approved diagnostic source `d47dc9b09f87988a53bd80435f0d11534beba15c`
on 11 September. Its worker started at 01:05:57.089214971 UTC. The production
base was already `32478124`, including C2a/C2b code; their replay/repair and
shadow acceptance remain unverified. No parser bump or flag change was added.

The standard deploy exited 1 at 01:33:29 UTC. Five protected sync-health
attempts exceeded 150 seconds; the last owned SSH read stalled for over ten
minutes and was terminated locally after a fresh status read succeeded.
Automatic rollback was skipped by the existing schema-change guard. This is
an open deployment gate; its cause and pre-deploy latency are unmeasured.

At 01:34–01:35 UTC all three roles still ran source `d47dc9b09f87`, image
`c8a5567e229b…`, healthy with zero restarts and 25 GiB free. API/database
health was OK. The local CLI was pinned to that source and its capabilities
contract verified. A separate loopback read verified dashboard HTML; both
deploy locks were absent. These checks do not override the failed sync gate.

Both C1 functions execute as `read_only` in READ ONLY; the underlying telemetry
and queue tables remain inaccessible. Migrations **0182–0183 are applied**:
do not edit or renumber them when main advances. Further SQL changes require
a new forward migration.

The cumulative report for 01:05:57.089215–01:21:45.993638 UTC contains one
completed lora-3 incremental run and one valid no-request receipt. Active and
source counts both equal 7,551, with zero processed rows before the known
checkpoint; all three OR predicates are false. Its two follower-stream HTTP
attempts succeeded. The other five pages and full reconciliations have no run
in this short interval. Queue state and request/completion pairing are not
established by a no-request receipt. The verified report SHA-256 is
`d278bb130be2b6ba6831a5fd22eabe209a43ea0cb2266b92423d5c01a4c3f1f4`.
The initial report and its interpretation were independently reviewed.

The verified T0 export for 1–6 September contains 20,881 follower-reconcile
physical attempts: 19,420 anomaly-source and 1,461 scheduled-source. Ordinary
followers added 3,079 attempts. These retained counts include retries and are
not complete telemetry; neither the anomaly label nor its frequency establishes
redundancy. [Per-page/source totals](evidence/t0-followers.json) retain the
baseline hash. Branch frequencies across the fleet and completed-generation
consolidation remain unmeasured.

Next: diagnose the protected health summary read-only and retain natural C1
activity through the existing six-hour observation. Establish the headline,
deletion or pagination cause, then add the narrow policy fix to this same PR.
The drift/blast-radius guards and presence consumers remain exit criteria.
A0 keeps its original seven-day window with this runtime boundary recorded.
Further production changes, A1, live sockets and C2b enablement remain gated.
Operational logs, raw reports and manifests are retained locally under
`investigations/fansly-c1-deploy-2026-09-11/` in the main checkout.
