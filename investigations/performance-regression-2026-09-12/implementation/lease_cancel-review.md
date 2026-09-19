# Independent lease-cancellation review

Verdict: **APPROVE code/architecture**, subject to the coordinator's serialized runtime gates and the same-commit documentation update below. No reachable new correctness or regression blocker found in the reviewed diff. This is not a claim that tests passed: the reviewer ran no Vitest, database, production, deployment or commit command.

Reviewed worktree: `/Users/dmitriy/code/goose/.worktrees/hub-perf-lease_cancel-20260912`.
Base: `31b73a9691f32f8c33c3fe479bca68533c7048d6`.
Complete binary diff SHA-256: `8f195af9badf67baa1e83728671daac8d5271b701c25b4e8c40e4e2c1451ea50`.
Independent reviewer: `/root/review_lease_cancel_fix`; author: `/root/fix_lease_cancel`.

## Correctness and regression reasoning

1. **New physical attempts stop at the correct boundaries.** A false/failed lease heartbeat sets the pre-existing `leaseFenced` flag and aborts one controller for that chunk. Admission checks run before and after the rate waiter and after awaited started telemetry. Fansly has no await between the final shared check and dispatch. Legacy OFAPI has additional awaits inside execute, and both account and collection hooks are followed by checks before fetch. An abort during response classification or terminal telemetry cannot open the next retry: the retry timer checks cancellation before scheduling, and the next iteration checks again.
2. **The request scope is isolated.** Only executeStreamChunk is wrapped. AsyncLocalStorage.run restores the caller scope; overlapping page executions receive their own signal. The shared module has no DB/runtime dependency. Existing page execution context uses the same async-chain boundary for capture identity and transaction fencing. In this codebase ALS avoids omission from the independently built lane, adapter and hydration contexts without putting mutable ownership on a process-wide client. It is an appropriate narrowly scoped cross-cutting mechanism here.
3. **Response receipt remains live.** No cancellation signal is passed to fetch or response.text; existing transport deadlines stay unchanged. Successful responses still run onResponse and return raw material to the handler. Reviewed handlers capture response material before lease-fenced projection/checkpoint application. The visible Promise.all call sites inside executor handlers are local payload reads, not concurrent provider dispatches whose early rejection would orphan another response. No new raw-capture deletion or state reset exists.
4. **Failure semantics retain their owning boundary.** Only the exact abort reason before dispatch takes the new local policy terminal path; it bypasses transport classification/retry. A real in-flight transport/HTTP failure remains classified by its adapter, with no retries left once cancellation is observed. Executor PageSyncLeaseLostError/leaseFenced handling returns the existing skipped/idle lease-loss result before retry, block, failed-payload or incident writes. Existing DB lease predicates still guard business completion; cancellation is an optimization, not replacement authority.
5. **Pacing cannot be bypassed.** Aborted Fansly nodes release their own gate but keep the chain in the map until its predecessor and node settle. A successor therefore still follows the occupied predecessor. Both category and global queues retain this rule. Their predecessor chains are constructed only from resolving gates, so the detached cleanup continuation is not a new rejection source. Reserved DB/global slots are not rewound or reclaimed.
6. **Admission resources are handled conservatively.** Promise.race installs a rejection handler for the abandoned waiter and removes the abort listener in finally. Native timer cancellation preserves the typed reason. The DB waiter checks again after profile initialization and reservation; a completed initialization cannot begin a new reservation after it sees cancellation. Legacy OFAPI releases precisely the successful unused collection admission when cancellation follows that hook. Failure before account admission makes no collection release. This branch throws immediately, so no second release or response settlement follows it. Production collection release is idempotent and its hook already reports/swallow-settles cleanup failures.
7. **Command discipline is preserved.** Only observedListRequest changes in OFAPI. Governed raw dispatch, outbox command execution and one-attempt retry laws are unchanged. Neither the common client pacing function nor an outbox callback is newly scoped by this patch. Unscoped observed requests retain their existing retry behavior.

## Architectural limits, not blockers

- Cancellation begins when heartbeat loss/error is observed, not at the exact database revocation instant. The unchanged 30-second heartbeat window remains.
- Already-started custom admission work can finish after the caller exits. In particular the existing OFAPI pacer/legacy slot waiter can drain a reserved wait; the shared wrapper prevents its completion from issuing HTTP. The patch should not be advertised as cancellation of every outstanding DB operation or timer.
- A started event/durable Fansly attempt reservation may already have committed before a later heartbeat abort. That conservative reservation is not refunded. The newly emitted local policy terminal is evidence that no dispatch followed; it does not claim provider failure.
- Failed HTTP responses already had different capture behavior from successful response material. This patch preserves existing failure/capture policy and does not establish a new full-body error journal guarantee.

## Required coordinator gates

- Run the author's targeted cancellation/executor/rate-limiter/Fansly-pacing suites serially, including both heartbeat false and heartbeat error.
- Run existing Fansly HTTP/transport retry, OFAPI collection refusal, governed transport and command executor suites. A broad unit check must also verify the added shared Node AsyncLocalStorage export under normal build/module mocks.
- Retain the existing page-sync lease-fencing integration gate on the combined release; code review does not substitute for its business-write/capture checks.
- Update **docs/error-handling.md** in the same problem commit: its header explicitly requires same-change updates to recorded retry behavior. Add a sync lease-loss row describing observed-heartbeat cancellation, local policy before dispatch, allowed in-flight capture and the existing skipped/idle disposition without new durable retry/incident state. Add the author's decision entry and quick-reference row as planned.
- Recheck the reviewed source hash or review any changes made to these functions during integration. `git diff --check` passed in this review.

## Reviewed source SHA-256

```
f10f19da9abc9c91200a9179695373603d5a8692203f98e682bc15f770c6006e  apps/runtime/src/services/ofapi.ts
7d1cd2847c03865aa5c02b755ec8daaf9e67c55a964998cf75af97f34e4c55a5  apps/runtime/src/services/sync/executor.ts
0b5ff0216677b272f920ea81c311ffc84019876e0db66b39a92fef0c0eddf8db  apps/runtime/src/services/sync/rate-limiter.ts
ba0c6ded1ba3bc17ee3ab6bd1d31ecfa1210ace0ea9e882efbc670063e72653a  packages/fansly/src/adapter.ts
0f9ad10ff57b7416cef11a805dc2e52cbd48c014551cd8bf1464414d7096089f  packages/shared/src/http-request-scope.ts
db18a89420db1d8b2e76ea3fc7214406ce11df7cfe2573e13941bfc55e29de18  packages/shared/src/http-request.ts
94731077cdf7cd7a57da9b21b2b2a716b54f628b6c11867793582155b3c1813c  packages/shared/src/index.ts
```

Read authority: CLAUDE.md; error-handling canon retry/boundary sections; decisions #100, #212 and #259 plus the relevant quick-reference entries; stage 25 and 26 historical specs. The deployed code remains the arbiter where historical spec details differ.


## Final release recheck

**Final verdict: APPROVE for a separate problem commit.** Reviewed the release worktree at HEAD `9d73205765fc5f06554590f1df2eaa9801248f54` with the lease patch applied. All seven runtime/shared files above are byte-identical to the originally approved versions; their SHA-256 values still match. This recheck adds no runtime code, test execution, database access or production action.

The fixture correction is genuine test isolation, not a runtime workaround. The harness installs a spy on the external CommonJS undici export before importing the adapter. Restoring/replacing that spy between cases while the adapter's named-export binding remains cached can leave later cases calling the old mock and its already-consumed Response. Keeping one installed spy identity across the Fansly describe block and resetting its calls/implementation between cases removes that stale binding. Each case still constructs its own adapter and AbortController, and each assigns its own response behavior. The pacing test still creates a fresh Response per fetch. The original dispatch-count, exact abort reason, in-flight body, un-aborted transport signal, and predecessor/successor timing assertions are retained. No runtime condition is mocked away or weaker success criterion substituted. OFAPI remains separately isolated and restores its global fetch stub. The explicit import-type alias is erased by TypeScript and changes no test behavior.

I read the preserved failed run (`lease-cancel-tests.log`: reused-body error), the unchanged in-flight case in isolation (`lease-response-isolated.log`: 1 passed), the corrected full fixture (`lease-adapter-corrected.log`: 5 passed), the coordinator's combined run (`sync-wave-tests.log`: 172 passed in 15 files), and the final sync race/lease checks (`sync-finalize-final-tests.log`: 14 passed in 2 files). These are coordinator-produced runtime results inspected by the reviewer, not tests independently rerun here. The coordinator identifies the combined coverage as retry, collection refusal, governed/outbox, executor and lease fencing.

The new error-canon row at docs/error-handling.md:56 resolves the documentation requirement: it confines cancellation to observed page-sync heartbeat loss, preserves in-flight receipt/capture and DB ownership fencing, records pre-dispatch policy telemetry, and does not grant durable retry or incident authority to the fenced chunk. The unchanged heartbeat detection interval is explicit.

Final reviewed artifact SHA-256:

```
5d100699792b083df8573188832b0e9e909b02ef4f226cc928ef3bae0a13f1a4  tests/adapter-request-cancellation.test.ts
4a95d2c169878da4a110ca1f1c390ac744593fd8886f7e7f4143b5d83a88a1d4  docs/error-handling.md
```

No review blocker remains. The release-wide check/build/deployment verification remains the coordinator's gate; the report's architectural limits still apply.
