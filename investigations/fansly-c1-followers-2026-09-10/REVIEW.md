# C1 timeline independent review

Reviewer: existing independent agent `review_pr162` (Boole), 11 September 2026.
Scope: the current C1 PR, followed by the new restricted timeline, fixtures,
Decision 291 and runbook. The reviewer read the code without changing it,
running tests or accessing production.

The reviewer confirmed that existing run receipts are sufficient for positive
request/completion attribution. A new runtime recorder is unnecessary. Claimed
revisions, membership generations, terminal proof and unknown completion gaps
must stay distinct.

Finding: a valid OR decision did not certify that its queue numbers were valid.
The timeline initially lacked a separate validity marker for those numbers.
Fix: `queue_valid` uses the existing aggregate's integer, nonnegative and ordering
rules; seven malformed-queue fixtures pass on real PostgreSQL. Missing/duplicate
or malformed receipts stay outside attribution.

Final re-review: P2 closed; no actionable findings remain. The reviewer checked
the final SQL, fixtures, runbook, Decision 291 and status record, and read the
local logs confirming 3,205 passing checks and 70 passing PostgreSQL tests.
The reviewer did not rerun tests. SQL performance on production-sized data
has not been established by this review.

## Code quality review, 11 September

The owner requested an explicit review of readability, design, repository
patterns and test quality in addition to correctness. Two independent reviewers
read C1 at `a0d9274d` against base `32478124`, without editing files, running tests
or accessing production.

`quality_c1` reviewed the changed production TypeScript and SQL in context.
It found no actionable quality issues: the small decision function preserves
the original predicates, telemetry uses the existing fail-open boundary, and
queue context comes from the existing locked row without changing ordinary
callers. The two SQL readers validate receipts consistently. Their duplicated
validation is a future maintenance consideration, not a reason to rewrite
applied migrations or introduce a shared abstraction now.

`review_pr162` reviewed the tests and fixture contracts. Findings and fixes:

| Finding | Fix |
|---|---|
| P2: combined OR fixtures could miss removal of individual guards | Added five named negative cases isolating walk exhaustion, checkpoint detection, processed rows and both known-checkpoint guards; retained all eight OR combinations. |
| P2: the fixed 2027 end date eventually stops exceeding eight days | Both readers now test a window ending exactly eight days plus one millisecond after the start. |
| P3: whole-input `as never` assertions hide fixture contract mistakes | Typed the provider stub and handler input, reused the seeded stream state and checked the queue row explicitly. The provider stub now supplies its required offset. |
| P3: fixture names could imply worker completion proof | Renamed the helpers to `runHandlerAndFinishTelemetry` and `insertReconcileRun`; documented that they do not exercise executor lease/CAS completion. |

Malformed decision, queue and cursor cases now have individual names; compact
fixture setup and cleanup have been expanded where that makes the steps clearer.
No production code, applied migration, reconciliation policy or flag changed in
this quality follow-up. The review criteria for later stages are recorded in
the [execution record](../fansly-events-execution-2026-09-08.md).

Final test-quality re-review found all findings closed and no new actionable
issues. The reviewer checked the final diff, including the explicit queue-row
invariant, without rerunning tests.

The parent then completed `pnpm check`: 3,210 tests passed in 292 files, nine
existing skips, unchanged strictness debt (1,908 errors in 121 files), lint and
dashboard build passed. The five serial Docker-Postgres suites passed all 70
tests with no skips in 21.53 seconds. The first typecheck had caught the newly
typed queue row's missing undefined check; the explicit invariant above fixed
it before this successful rerun. Logs and hashes are recorded in
[validation.json](evidence/quality-20260911/validation.json).

The production-code reviewer also checked the review process and scope record;
no actionable issues remain. The existing observation follow-up now carries
the same quality criteria, with its cadence, notification rules and production
gates preserved.
