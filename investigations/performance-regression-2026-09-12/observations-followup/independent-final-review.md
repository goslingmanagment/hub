# Independent final review: observation replay heads

**Verdict: approve. No actionable correctness, regression, code-quality or architecture findings remain in the reviewed candidate.** The coordinator still owns the ordinary full release checks and deployment measurements; this review does not claim those have already passed.

Reviewer `/root/review_observation_strategy` did not author the fix, run a production probe, edit source, or start a DB suite. Review target is the release worktree based on `96a86c1fcdde`, with exactly three fix files: `packages/db/src/repositories/domain-events.ts`, `tests/observations-replay-head.integration.test.ts`, and Decision 312 in `docs/decisions.md`. The source adds 47 lines and changes no driver or migration.

## Correctness and regressions

The guard is limited to source-defined first pages without exact id, account set/account id, time window or continuation cursor. All excluded calls retain the original SQL and parameter list. In particular, a zero continuation id is not mistaken for an absent cursor; an empty explicit account set retains its empty result; null account id remains unrestricted.

Actual stored parse versions are discovered under the original lower/upper comparisons using strict greater-than successors. This includes negative and sparse versions and terminates without arithmetic increments or a generated integer range. Equality-bound source/kind probes use the existing parse-leading 0144 index. Repeated kinds are deduplicated; missing/empty kinds retain unrestricted semantics.

The existence check and original SELECT execute in one statement. Every eligible row implies a successful prefix probe, so the guard cannot manufacture an empty page. The original full projection, predicates, numeric `o.id` order and LIMIT remain intact. There is no cache, new stamp, binding state, cursor identity change, altered wrap, budget change, provider read or widening of the catalog-payload read boundary.

The first draft also optimized time-window calls. Review identified that unrestricted kinds leave a key unbound before the time range; the author narrowed those calls to the original path. Final source, tests and Decision 312 agree on that scope.

## Code quality and architecture

The additional SQL remains parameterized and every ordering column is qualified. The small repository-local change documents the measured planner failure, existing index dependency and why actual-version recursion is necessary. Reusing the deployed index avoids storage/write cost and collateral plans from another observations index. No abstraction or persistent state is introduced for a local physical-access problem.

A recursive existence guard is more complex than plain EXISTS, but the simpler range/IN guard was measured and rejected because it regressed the populated webhook case. The retained complexity has a specific purpose and preserves the selector contract.

## Independently checked evidence

- Read the final source, full new integration test, Decisions 276/311/312 and the relevant existing replay/readthrough/materializer call sites.
- `git diff --check` passes on the reviewed final candidate.
- `author-focused-final.log` reports 8 test files / 82 tests passed in 17.84 seconds.
- `author-negative-control.log` demonstrates that restoring the exact old repository source makes the new actual-plan gate fail: 240,000 heap visits against a requirement below 200. The candidate was restored afterward and the passing focused suite ran on it.
- The integration test compares full results with the old SELECT, including numeric id order across months, payload references, negative/sparse version bounds, duplicate/empty kinds, null/empty/intersecting account scopes, half-open time bounds, deep/exact/source-free fallback and capture appearing after an empty result. It asserts a single SQL call and preserves the cheap dense webhook page in a 240,000-row correlated fixture.
- Compared all 15 captured first-page registry plans with their matching old plans. After excluding the new CTE/InitPlan, every family/pass retains the same observation relation/index access paths.
- Inspected the raw prototype ANALYZE evidence: empty stats 12.779 ms / 730 shared buffers, engagement 2.617 ms / 85, command result 2.336 ms / 82; populated webhook 3.489 ms / 118 buffers for 200 rows. The old empty probes took 1211.588–1507.167 ms and approximately 999,000 shared buffers each. The old populated webhook query took 1.085 ms / 46 buffers.

## Measurement claims and residual limits

Decision 312 and the investigation report correctly identify those figures as individual read-only query probes, not whole-service CPU savings. The populated case has measured added overhead (about 2.4 ms in these samples), which is disclosed. The guard prevents demonstrated completely empty head walks; a genuinely populated sparse selector can still use a broad original scan. The separate before/after service windows and exact final-SQL paired comparison belong to the coordinator's release verification.

The report's scope paragraph should explicitly include time-window calls among unchanged paths, as the source and Decision 312 already do. This is a minor report clarification, not a source blocker.

## Reviewed file digests (SHA-256)

- `packages/db/src/repositories/domain-events.ts`: `66840f0208b377716f30ffc9905498b55daa18737c393fe56f53843ca59c1957`
- `tests/observations-replay-head.integration.test.ts`: `5869509faacc2e417d4b42d610db0d2a4b0639d2a495bde64d0b5eb9f4197199`
- `docs/decisions.md`: `0d7eb74f5d669942657995d7f79db34998485b372e727e063736c789c3b08909`
