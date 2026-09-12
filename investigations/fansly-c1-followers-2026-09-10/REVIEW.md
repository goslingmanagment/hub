# C1 timeline independent review

Numbering note: earlier reviews refer to the original C1 Decision 291. It is
Decision 294 after the 11 September merge of main; applied migrations are unchanged.

For the [12 September main integration](MAIN-SYNC-20260912.md), `review_pr162`
reviewed exact tree `af6102b5`, including the five documentation conflicts and
preservation of 181 production-reference and 180 main migrations. `quality_c1`
verified the final documentation and PR body against all three log hashes,
3,258/9 unit and 86/0 Postgres results, and all 39 restored diagnostic files.
Both reviews closed without actionable findings; neither reviewer ran tests
or accessed production. Changes after the tested tree only record these results.

For the [first full receipts after restoration](OBSERVATION-20260912T155000Z.md),
`review_pr162` independently verified the atomic 65-row report, both clean-queue
request/completion chains, 20/38-chunk continuity, one actual Lora-1 retirement,
two grace-protected Lilly-2 rows and 299 successful physical attempts. There
were no actionable findings. The source/runtime comparison preserves the
post-cutoff worker boundary and the earlier missing actual counts. The separate
quality review verified all 14 source entries and found one wording defect:
35/20 is a presence-driver value, not a direct addition to final urgency. The
inventory now preserves the existing aggregation. Final re-review closed that
finding and found no new issues in the documentation or prepared PR body.

For the [17:07 observation](OBSERVATION-20260911T170708Z.md), `review_pr162`
verified 430 rows, withheld-finalization retries, full-revision versus final-
generation durations, source-separated costs and all 429 retained summaries.
`quality_c1` checked A0's fresh cohort, late updates, new Lora-1 discrepancy,
lost receipts and warning categories. Both used local evidence only.
The reports preserve unknown failed decisions, late boundary rows and incomplete
log reads; low line counts do not prove complete exports. No runtime or test
change was made. The final C1 review found one P3 in the PR body: warning counts
lacked an explicit interval and could be read as including earlier log segments.
The body now scopes them to 11:08:56–17:07:08 UTC. Final re-review confirmed the correction; no actionable findings remain.

Earlier evidence review: `review_pr162` independently checked the 296-row export,
all 295 finished-run summaries, source attribution and reconcile durations in
the [11:08 observation](OBSERVATION-20260911T110856Z.md). No cost or suppression
findings remain. `quality_c1` verified A0 totals and corrected the interpretation
before publication: the fresh cohort differs from cumulative deltas, the
non-atomic read includes a completion after the requested end, and generation
6759 has a flags difference while generation 6753's subtype stays unknown.
Both reviewers used local evidence only; neither ran tests or accessed production.
Both final documentation reviews found no actionable issues. Code and tests
remain unchanged from the verified source; production gates remain open.

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

## First-repeat RCA and grace regression

`review_pr162` independently verified the 02:53:01 UTC production export:
its hash and 75 rows agree, all 11 incremental decisions are valid, and the two
Lilly-2 requests arrived at clean queues. The reviewer confirmed that generation
780's exact count and zero candidates do not make the next traversal redundant:
the immediately preceding generation and live-touch rules can protect an extra
active row. The second traversal is still partial in this snapshot. Exact row
identity and the protection reason remain unknown.

The review found no equivalent test of one absent row surviving G and being
retired after G+1. The existing generation-high-water case now covers that
transition, including the intermediate active/generation count mismatch and
empty candidate set. Final review found no actionable issues or unnecessary
abstractions. This is a repository regression, not a handler/executor proof.
The reviewer did not run tests or access production.

The parent ran `pnpm check` (3,210 passed, nine existing skips, 292 files) and
the same five serial Docker-Postgres suites (70 passed, zero skips, 19.77s).
Strictness debt, lint and dashboard build remain as reported above.

`quality_c1` separately reviewed the unchanged protected-health path and a
locally prepared planner-only operation. It identified full-history aggregates
and window scans as candidates, without claiming a measured cause. The prepared
SQL uses READ ONLY, 10-second statement and 2-second lock limits, and explicit
`EXPLAIN (ANALYZE FALSE)`; it has not run. A wording finding about its time bound
was fixed: recent predicates retain the runtime's lower-bound-only semantics.
The new one-use role exception still needs explicit owner approval.

The final evidence review independently matched all 75 run summaries to the
timeline, reconciled 206/88 full-walk attempts and 22 incremental attempts with
persisted aggregates, and recalculated both elapsed intervals. Report, summary,
worker-log, test-source and validation-log hashes match the receipt. The actual
logs confirm the test results above. No actionable findings remain; row identity,
generation 781 completion, redundancy, savings and health attribution stay open.

The separate PR/operational-report review found two factual wording issues:
the 500-run response cap applies only to the timeline reader, and the A0 report
still called the 00:33 runtime read the latest. The PR now distinguishes the
reader limits, and the operational report names the 00:33 boundary and latest
02:52 runtime separately. Neither correction changes code or measured results.
The reviewer rechecked both actual edits and confirmed the findings closed,
with no new issues in those sections.

## Observation follow-up through 05:07 UTC

`review_pr162` independently verified the new report hash, 136 unique ordered
run IDs, exhausted pagination and unchanged 75-row prior cohort. Lilly-2's
second generation completed, followed by two matching no-request decisions;
Ari-1 has a similar candidate transition but a later changed headline. Lora-2
is still partial. No redundant traversal or justified suppression fix is
established. Candidate count remains pre-UPDATE evidence, not retired-row
identity. The review preserves the running run's unknown loss counters.

`quality_c1` traced the restart event through the deployed worker and pinned
pg-boss/pg-pool code. The internal heartbeat's pool checkout timeout emitted
an error; the existing handler exited the process. The preceding sync-job
heartbeat warning was a separate caller. The reviewer rejected attribution
to TCP failure, a statement timeout or protected sync-health without evidence.
It also identified why startup orphan-cleanup count zero does not prove no
interrupted runs: valid matching leases are excluded. Successful post-restart
work is visible, while the protected deploy gate remains failed.

Both reviews used local evidence only. This follow-up changes documentation
and evidence receipts, with no production source, migration or test change.
The tests verified on `13537b6b` remain the applicable validation; they were
not rerun for this documentation-only observation.

Final evidence review matched all eight receipt hashes and independently
recalculated the 485/487 reconcile-cost difference, 52 incremental attempts,
generation 781's 193 attempts and elapsed time, and A0's 18/49/2 sweep counts.
The operational-document review found an undated allowlist claim in the A0
headline. It now dates activation and the last full configuration check, with
current exact configuration explicitly unverified after the restart.
The reviewer rechecked those edits and confirmed the finding closed.


## Approved plan read — 11 September 17:35 UTC

Both independent reviewers matched SQL/plan SHA256 against the execution receipt.
The source review also matched all 61 fixed SQL fragments and 125 parameters to
the unchanged deployed monitor reader. Planned physical-history and completed-run
work is confirmed; no actual-time RCA, production latency or traffic savings is
inferred. Active-page substitution, old fixed clock, estimated cardinality and
session differences remain explicit in the dated HEALTH-PLAN report. The one-use
privileged exception is consumed. Any candidate query change is validated and
reviewed in a separate health worktree, outside the C1 code diff.

## Combined release after PR172 — 11 September

`review_pr162` and `quality_c1` independently reviewed the integration of main
`c0cd21c3` into C1 parent `5e92fdd7`. Both verified the 12 source hashes and four
log hashes in `evidence/health-release-20260911/validation.json`, all 179 migration
files against deployed `d47dc9b0`, preserved C1 runtime and incoming health/API
contracts. Neither reviewer executed tests or touched production.

Local results are 3251 passed with nine existing skips across 296 unit files,
81 passed with zero skips across seven serial Postgres suites (24.34 seconds),
production build success and no regenerated-contract drift. Local Node 26.7.0
is recorded separately from CI Node 22. Runtime/test source did not change
after these checks.

The correctness review found no actionable issue. The quality review found
stale pending-PR172 wording and an old validation block that looked current.
The release packet now records the actual merge and Decision 294; the older
3210/70 results are labelled with their original `13537b6b` source. Both findings
were fixed and rereviewed; no findings remain.

The candidate explicitly includes PR171's Overview/revenue API in addition to
PR172. Protected health must actually execute, the CLI must follow the deployed
contract, and rollback retains the C1 image and schema. The PR remains a C1
diagnostic draft; no deployment or stage activation was performed.

## Membership refinement — 12 September

Both reviewers examined the final runtime, repository, migration, fixtures and
runbook. `review_pr162` required the receipt's own sweep-start timestamp and a
regression where UPDATE changes fewer rows than the candidate count. Both were
implemented and rereviewed. `quality_c1` requested the unambiguous
`membership_receipt_valid` name and a correctly placed count comment; both are
fixed. Neither reviewer reports remaining actionable findings.

The final source passed 3251 unit tests with nine existing skips and 84 serial
Docker-Postgres tests with zero skips. The exact source and log hashes are in
[evidence/membership-20260912/validation.json](evidence/membership-20260912/validation.json).
Reviewers did not run tests. The diagnostics preserve existing policy and do
not establish redundant generations, actual row identity or measured savings.

## Membership restoration — 12 September

`review_pr162` independently checked the 97-run production report, its hash,
ordering, completion pairing and source/compiled evidence of the missing
membership writer. `quality_c1` checked the observation text against those
receipts: candidates, actual retirements and later active counts remain distinct;
missing receipts stay unknown. Neither found an actionable issue.

Both reviewers then examined exact release `64149b95`, including its parents,
tree and migration preservation. The correctness review verified all 1,881
exported files. The quality review confirmed that the restored membership code
matches `7aaa3185`, while conditional writes and skipped-row readback retain
the current `1f89bcc2` implementation. Both reviews found no actionable issues.
Neither reviewer ran tests or accessed production.

The parent validated the exact release with 3,258 passing unit tests, nine
existing skips, 86 passing serial Postgres tests and a successful production
build. The owner-authorized standard deployment then passed its protected
health gate; source, compiled hashes and CLI pinning were checked separately.
The [restoration report](RESTORED-MEMBERSHIP-20260912.md) records these results
and the remaining requirement for a new natural membership receipt.

The final documentation and PR-body review by `quality_c1` found no actionable
issues after comparison with the local validation, deployment and observation
receipts. The runtime and tests were unchanged during this documentation follow-up.

## Captured pagination overlap — 12 September 16:50 UTC

`review_pr162` independently verified the 44-run cohort, six valid decisions,
38 generation-791 chunks, guarded restart and null actual-deactivation count.
The reviewer matched all 184 captures to those runs, checked per-run counts
against chunk statistics and reproduced the repeated relation at page 51/52.
All four evidence/source hashes and the 200-attempt accounting agree. No
correctness finding remains; the underlying provider action, omitted follower
identity and safe suppression remain unproven.

`quality_c1` reviewed the observation, presence inventory and PR body. One
wording finding was fixed: a processed relation is not evidence of an insertion.
The re-review confirms no open findings. Both reviews preserve the distinction
between later matching counts and immediate active-after, separate snapshots,
captured overlap and complete membership. Neither reviewer ran tests or accessed
production. This follow-up adds diagnostic SQL and evidence documentation only;
application source and the successful `6d3dd3f1` validation remain unchanged.
