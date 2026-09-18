# Earnings single-pass fix — independent review

Verdict: **APPROVE** the reviewed code and architecture, subject to the coordinator's serialized runtime gates. No actionable correctness, regression, or code-quality blocker found. This is a code-review approval, not a claim that unexecuted tests passed or that production CPU improved by a measured percentage.

Reviewer: `/root/review_earnings_parse_fix`; author: `/root/fix_earnings_parse`.
Candidate: `/Users/dmitriy/code/goose/.worktrees/hub-perf-earnings_parse-20260912`.
Base: `31b73a9691f32f8c33c3fe479bca68533c7048d6`.

## Scope and evidence

Read the complete five-file candidate diff, full earnings parser, the driver's body-resolution/gate/context/append/stamp/error path, the family registry and direct parser/canonicalizer callers, all 17 new test cases, existing earnings identity tests, and relevant legacy-gate coverage. Contract references: `CLAUDE.md`, decisions 73/78/97/285, Stage 8 canonicalization/replay, Stage 27 money units, and the error-handling boundary canon.

No source edits, Vitest/Testcontainers/DB execution, provider calls, production access, commits, push or deployment were performed by this reviewer. Read-only `git diff --check` passed. The only reviewer write is this report. Author-reported typecheck/lint are not represented here as independently rerun checks.

## Findings

1. **The change removes the demonstrated repeated work at its cause.** Previously the registered earnings `canParse` wrapper fully aggregated/sorted/hashed the body and then either `canonicalize` or `parseRejection` parsed it again. `canonicalize-driver.ts:521-560` retains one observation-local result and uses it for acceptance, diagnostics and drafts. The actual parser's executable implementation is unchanged; its only changes are a type import and return annotation.

2. **Whole-observation refusal remains intact.** A non-null `parsed.rejection` reaches `continue` before context reads, account resolution, dry-run accounting, partition validation, event append or version stamping. This correctly discards any valid drafts returned alongside malformed data. The distinction matters because the pure parser can return a sound fan's draft with a refusal caused by another fan. A poisoned breakdown for the same fan/window is also refused. There is no partial money snapshot introduced by this optimization.

3. **The new seam has an appropriate narrow boundary.** Only earnings opts into `parse`. The family union makes this strategy mutually exclusive with a separate shape gate, rejection callback and `accepted_posts` replay context. It therefore does not silently bypass an acceptance-ledger lookup for a context-dependent family. Legacy families retain their gate-before-context/canonicalize ordering, including the same `unclassified` fallback when a rejecting gate has no diagnostic. The existing required `canonicalize` function preserves direct callers; keeping it does not cause a second call in the driver's parse branch because a valid `events: []` is retained by `??`.

4. **Identity, money and replay semantics are preserved.** No arithmetic, unit conversion, amount/window validation, breakdown order, SHA-256 input, event schema, observation/fan/window dedup key, family version 7 or projection-only classification changes. Decision 285's A–B–A identity remains in the unchanged parser and existing identity fixtures. Empty arrays still yield no invented fan/window zero, explicit safe zero still yields an event, and successful empty consumption remains unchanged. No schema or configuration changes are needed.

5. **The surrounding safety path remains shared.** The parser receives the body resolved by the existing payload seam. Drafts still pass through the same timestamp clamp, current account mapping, partition gate, checkpoint creation, append and then stamp. Unmapped non-empty earnings stay unstamped; a later run rebuilds mapping and reparses fresh. Dry-run still appends/stamps nothing. Exceptions remain in the same per-row catch. The result has no lifetime beyond one visit and cannot become a stale binding/body cache.

6. **Diagnostics remain bounded and content-free.** Earnings only returns code-owned literal refusal codes. The driver's retained sample cap is 20, with one fixed-code diagnostics record per refusal. No provider body, amount, fan identifier or error prose was added to those samples by the patch.

## Test review

The new file contains **17 expanded cases**: two positive lifetime/monthly work-count cases; one malformed-money read-count case; nine malformed/partial refusal cases; two empty/zero cases; unmapped repair; dry-run; and sample bounding.

- It imports the actual family registry, driver, parser and payload seam. Only DB boundaries and crypto observation are mocked. The crypto wrapper returns actual `Hash` instances; both SHA-256 and fingerprint serialization execute. Hash accounting inspects the real `update` input to exclude the driver's unrelated cursor-scope hash.
- Positive cases assert one fingerprint per emitted aggregate, the exact standalone draft output delivered through the projection-only append/checkpoint, and the version stamp. This is meaningful work-count evidence, rather than a timing threshold that depends on host load.
- The invalid-money getter exercises the real amount validator and proves a refusal with no fingerprints still reads that money field once. It cannot be satisfied by simply skipping parsing, because the test also requires the exact refusal diagnostics and unstamped outcome.
- Partial cases deliberately include both a valid other fan and a poisoned same-fan/window breakdown. They assert no projection append or stamp. A swallowed exception would produce `errored: 1` and fail these checks rather than masquerading as a refusal.
- Repeated unmapped visits and mapping repair assert fresh processing and no terminal stamp. Samples exercise 25 refusals with 20 stored samples and 25 diagnostics records.
- The existing earnings tests independently pin A–B–A dedup separation, fingerprint invariance to input order, empty/zero output and lane/version routing. `canonicalize-budget.test.ts` already exercises the legacy refusal branch and fixed-code diagnostics; `content-media.integration.test.ts` includes the actual OF accepted-post replay path.

The new positive expected output is derived through the unchanged standalone parser, so it is a driver-path parity oracle, not a new independent oracle for all money arithmetic. That is appropriate for this change because the executable parser is unchanged and existing parser/projection identity fixtures cover those contracts.

## Coordinator gates

Run the candidate's 17 cases and existing earnings/budget/clamp suites serially. For a valid negative control, run the same new fixture against the complete base driver **and** base registry; reverting only one gives an invalid mixed-strategy program. Expected old work is two fingerprints for one lifetime draft and four for two monthly drafts; the candidate should produce one and two respectively. The malformed-money read counter and repeated unmapped work checks should distinguish the old path as well.

Before release, include the shared driver's existing sweep/dedup integration tests, earnings identity/projection integration tests and the accepted-post case in `content-media.integration.test.ts`, alongside the coordinator's combined validation. The forthcoming payload-catalog batching and disjoint replay-pass patches are outside this candidate: inspect their combined driver result and rerun these cases after integration. No approval of those future changes is implied by this review.

## Reviewed SHA-256

The uncommitted candidate is identified by these content hashes, not just its unchanged base HEAD. Complete `git diff --binary` hash: `f43bb2073bedce6fdcf347e8996c87168ed86d528c3d8d6a8363cbf22b6f3cf0`.

| File | SHA-256 |
|---|---|
| `apps/runtime/src/services/canonicalize-driver.ts` | `e954978f6bb41d51266cc001eba13c05eddac1d8d25e305262cc8ec675dec432` |
| `apps/runtime/src/services/canonicalize/fansly-earnings.ts` | `a1c593768edcd2f7d810b933aac349e91aefdaf4f06ae972666207b1442f0f59` |
| `apps/runtime/src/services/canonicalize/index.ts` | `e5fce8283a7c6f02eb63142fc4b56b52502f1f1ded56adfd1b67d4875afbbccd` |
| `apps/runtime/src/services/canonicalize/types.ts` | `b8d2467b6d26c7702b7c8a7a223e1f6efa82649044b4bda218817e22b41f4245` |
| `tests/canonicalize-earnings-single-pass.test.ts` | `0df76f4af956d969ef3369332d18438f6dd2a030039208be71b6331919d1efea` |

Rollback is a complete code-commit revert covering the driver and registry together. It restores repeated parsing without changing persisted contracts. A production-wide percentage or absolute latency claim needs separate measurement; the static control path and fixture design prove removal of duplicated parser work only.
