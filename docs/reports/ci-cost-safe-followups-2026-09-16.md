# CI cost follow-up: implementation and regression checks

Base: `cb4539d372ce7bce8fc67bff931c600cdec97149` (PR #224).
Decision: 361. Implementation branch: `codex/ci-cost-safe-followups`.

## Changes

- Fingerprints retain executable evidence, arbitrary data, symlinks and unknown paths; only reviewed regular Markdown is excluded. The original lint counterexample now changes the hash.
- A separate integration proof allows dashboard source/public edits to reuse the DB gate. All tests, helpers, manifests, configuration, shared packages and scripts remain integration inputs. A source-boundary regression test checks that backend/integration code does not consume the excluded frontend inputs.
- Draft PRs wait for Ready for review with a failing required gate. Title/base edits rerun admission; body-only edits use a separate concurrency group and a different check name, preserving any real gate already in progress.
- Proof lookup checks expiry, repository, workflow and completed success. API failures trigger checks. Both proof uploads can replace an earlier attempt, preserving rerun behavior.
- Direct Docker/full deploys typecheck by default. CI opts out only after its explicit check or an identical-tree proof. Host production build is removed; Docker builds once and retains both runtime smoke tests and image identity checks.
- Buildx uses the working checkout, loads linux/amd64 locally for checks, refreshes the base and saves GHA layer cache. Build/test jobs still have no registry-write token.
- Unit checks use two isolated workers on CI. Integration serialization and weekly full-suite/daily API coverage are unchanged.
- `pnpm ci:cost --days 7 --limit 100` reports runner estimates without creating a workflow. JSON is available through `node scripts/ci-cost-report.mjs --json`. Reruns deduplicate carried-over jobs using execution timestamps, not job IDs; partial samples are labelled.

## Independent review

A separate agent reviewed the implementation and the input dependency boundary. It found four additional issues during development, all corrected before publication:

1. Rerun responses copy successful jobs with new IDs, causing double-counted runner minutes. The corrected report was independently checked on actual run `34977747522`: 58 minutes = 48 initial + 10 rerun.
2. Proof artifact names collide on rerun-all or partial upload failures; both uploads now use `overwrite: true`.
3. A PR description edit could cancel an active full run; metadata-only edits now use a separate concurrency group and cannot create a check called `Quality Gate`.
4. Metadata-only events were incorrectly classified as proof reuse in the report; they now have their own classification.

Final code-review verdict: no remaining blocking findings, conditional on completing DB/Docker and hosted checks. The reviewer did not run competing Vitest suites or Docker builds while the primary agent tested.

## Local evidence

Node 22; isolated worktree; normal per-file Vitest isolation retained.

| Check | Result |
|---|---|
| Initial policy/deploy/fingerprint tests | 264 passed across 7 files |
| Updated policy/event/rerun/cost tests | 278 passed across 8 files |
| Full unit suite with no host `apps/dashboard/dist` or `apps/runtime/dist` | 353 files, 4222 passed, 9 existing skips |
| Single-worker unit measurement | 354 files, 4227 passed, 9 skipped; 194.63s Vitest wall time |
| Two-worker unit measurement | 354 files, 4233 passed, 9 skipped; 100.23s Vitest wall time |
| DB integration shards 1/2/3 | 235 files, 2531 passed; 247.51s / 270.65s / 221.85s wall |
| Full API file, including nightly cases | 104 passed; 42.77s wall |
| Squash defaults | Changed from COMMIT_OR_PR_TITLE + COMMIT_MESSAGES to PR_TITLE + BLANK; read back via API |
| Deliberate Docker backend type error | Default build fails with TS2322 in the injected file before producing artifacts |
| Typecheck | Existing per-file strictness budget satisfied; no new type errors |
| ESLint | Passed |
| Workflow/shell syntax | actionlint and bash syntax checks passed |
| Live proof API read | Existing successful run `35116418880` found correctly |

Six cheap policy cases were added between the worker measurements; the application test set and isolation were unchanged. These are local measurements, not an estimate of GitHub savings. The slowest application unit file is `fansly-binding-transport.test.ts`; its deliberately real network deadline accounts for about 15s. This change keeps that coverage and does not replace real transport evidence with fake timers.

Hosted admission checks confirmed Draft skips heavy jobs and fails the required gate (run `35124769984`). Ready started all checks (run `35124864973`). A description edit created only skipped jobs without a check named `Quality Gate` (run `35124939415`), and the existing full run continued.

That live response exposed a reporting edge: GitHub returns the unevaluated dynamic name for a skipped job. The cost classifier now recognizes the actual API name and requires a skipped run, with a regression case that distinguishes cancellation. The partial full run was then cancelled intentionally to avoid finishing a stale revision; final hosted validation runs on the corrected commit.

The remaining Docker and hosted validation results are recorded below when complete. Raw local logs live outside the implementation worktree under the owner's `investigations/ci-cost-2026-09-16/implementation/`; they are not runtime inputs or production changes.

## Interpretation and limits

The reduction from 43–46 runner-minutes to 2 for repeated PR trees and 7 for main builds was observed before this change. This PR addresses correctness gaps and remaining redundant work; it does not claim a measured new monthly saving before enough new runs exist.

The dependency ratchet recognizes imports and common composed filesystem paths. It cannot prove arbitrary dynamic JavaScript dependencies. New cross-boundary behavior must restore its inputs to the integration fingerprint. Unknown paths remain checked by default.

No production deployment is part of this change. GitHub orchestration and GHA cache behavior require hosted evidence in addition to local policy tests.
