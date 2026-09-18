# Earnings parser single-pass fix — author handoff

Author: `/root/fix_earnings_parse`.
Candidate: `/Users/dmitriy/code/goose/.worktrees/hub-perf-earnings_parse-20260912`.
Base: `31b73a9691f32f8c33c3fe479bca68533c7048d6`.
Status: implementation and static checks complete; independent review and all runtime tests belong to the coordinator and are still pending.

## Problem and change

The active `pull:earnings:v7` family used the complete earnings parser as its `canParse` gate, then discarded its drafts and ran the same parser again through `canonicalize`. A refused observation was parsed again through `parseRejection` to obtain its fixed reason code. Valid monthly observations therefore repeated aggregation, sorting, JSON serialization and every SHA-256 fingerprint.

The driver now supports a typed, context-free `parse` strategy returning `{ events, rejection }`. For that strategy one observation-local result supplies acceptance, bounded rejection diagnostics and drafts. Only earnings opts in. The parser algorithm, wrappers and version remain unchanged.

The family type makes `parse` mutually exclusive with `canParse`, `parseRejection` and `replayContext`. Context-dependent families continue through the existing gate, acceptance-ledger load and canonicalizer. `canonicalize` remains required and exported for existing direct callers, including the cross-producer dedup fixture. There is no payload cache or state shared between observations/runs.

## Files

- `apps/runtime/src/services/canonicalize/types.ts`: `CanonicalParseResult`, `CanonicalParseRejection`, `CanonicalParser`.
- `apps/runtime/src/services/canonicalize/fansly-earnings.ts`: names the shared return type; no executable parser change.
- `apps/runtime/src/services/canonicalize/index.ts`: mutually exclusive strategies; earnings uses `parseFanslyEarningsObservation`.
- `apps/runtime/src/services/canonicalize-driver.ts`: narrow change at the gate and draft creation, approximately lines 518–560.
- `tests/canonicalize-earnings-single-pass.test.ts`: 17 focused tests using the real driver, registry, parser and inline payload seam; DB calls are mocked.

New test is added with `git add -N` so `git diff --binary` includes it. There is no commit.

## Preserved behavior and regression risks addressed

- Any non-null rejection rejects the WHOLE observation and leaves it unstamped. This includes a valid fan alongside a malformed fan and a poisoned breakdown row of the same fan/window. Partial drafts returned by the pure parser are never appended by the driver.
- Missing, null, fractional and unsafe/overflowing amounts remain invalid. Invalid monthly windows and malformed/missing-fan rows preserve reason codes.
- An empty array remains accepted with no invented zero event. Explicit zero remains a valid event.
- SHA-256 input, per-observation dedup keys, v2 event shape, projection-only append/checkpoint identity and v7 stamp are unchanged.
- Timestamp clamp, partition gate, account resolution, binding repair, append/stamp ordering, dry-run and row fault isolation remain in the existing driver path.
- Rejection sample count remains bounded at 20; the diagnostics sink still receives each fixed-code refusal.
- Each subsequent visit parses fresh body/context state. No terminal pending classification or payload memoization was added.
- Shape-gated legacy families still call `canParse` before context loading/canonicalization and obtain `parseRejection` only after a refusal. Families without a shape gate still canonicalize directly.

The new tests count actual earnings fingerprint work separately from the driver's cursor-scope SHA-256. The crypto spy wraps real `Hash` objects and their real `update`/`digest`; it does not substitute fake fingerprints. A malformed-money getter verifies one semantic amount read even when no valid aggregate reaches hashing.

## Author validation

- `pnpm install --offline --frozen-lockfile`: passed, no lockfile changes.
- Targeted ESLint across all five changed files: passed.
- `pnpm typecheck`: passed strictness ratchet, **1897 known errors / 120 files**, unchanged baseline debt. This does not claim clean `tsc`.
- `git diff --check`: passed.
- No Vitest, Testcontainers, database, provider network, production, commit, push or deploy was run by this author.

## Coordinator validation to run serially

```sh
pnpm exec vitest run tests/canonicalize-earnings-single-pass.test.ts tests/canonicalize-fansly-earnings.test.ts tests/canonicalize-budget.test.ts tests/canonicalize-clamp.test.ts --maxWorkers=1 --no-file-parallelism
```

The negative control is the SAME new test file against the complete base source (at least restore the driver and registry together). Baseline should fail the positive lifetime/monthly hash counts, malformed-money read count and repeated unmapped visits: expected fingerprint work changes from 2 to 1 for one lifetime draft, 4 to 2 for two monthly drafts. Restoring only the old driver alongside the new registry is an invalid control because old driver code does not understand the new family strategy.

Existing integration coverage worth including in the combined serialized verification: `canonicalize-sweep.integration.test.ts`, `canonicalize-dedup.integration.test.ts`, `fan-earnings-identity.integration.test.ts`, `fan-earnings-projection.integration.test.ts` and the applicable OF accepted-post replay coverage. No integration result is claimed in this report.

## Integration notes

The binding author notified me that his revised change batches fresh catalog reads through the existing payload seam, touching row resolution before this gate. There is no pending-cache API to coordinate. His driver block and this gate should combine without semantic dependency; inspect the combined diff and run the new fixture after integration.

The replay-pass optimization is likewise independent of parser strategy. These fixtures use a single family pass so parser work assertions do not depend on whether a zero-version row remains eligible for the second pass.

## Proposed decision note for the coordinator's same-problem commit

Title: **Reuse the earnings parse result within one observation**.

The `pull:earnings:v7` driver path had fully parsed each body once for shape acceptance and again for drafts or rejection detail. Context-free canonicalizer families may now provide one pure `{ events, rejection }` result; the driver uses it for all three purposes. A non-null rejection refuses the whole observation, including any partial drafts, and keeps its parse debt. The registry type prevents combining this path with separate shape gates or a replay acceptance context. Earnings is the only adopted family; direct canonicalizer helpers remain available, and amount validation, fingerprints, event keys, checkpoints and parser versions do not change. The result lives only during this observation's visit, so future body or binding repair is still read and parsed afresh. Tests count one fingerprint per emitted aggregate and preserve malformed/partial, empty/zero, unmapped-repair and dry-run behavior. No production CPU-share or absolute speedup is inferred from these work-count tests.

Quick-reference summary: **Earnings validates, diagnoses and builds drafts from one observation-local parse result; whole-observation refusal and replay semantics remain unchanged.**

## Rollback

Code-only and no migration or config change. Revert the complete problem commit (driver + registry + shared type) together. The old implementation repeats CPU work but reads/writes the same event and observation contracts.
