# CI cost follow-up: implementation and regression checks

Initial base: `cb4539d372ce7bce8fc67bff931c600cdec97149` (PR #224).
Decision: 361. Implementation branch: `codex/ci-cost-safe-followups`.

The later test-infrastructure follow-up merged main `91ecd2c0` before its
comparison. See [Decision 374's measurements and regression checks](ci-cold-run-followups-2026-09-16.md)
for that revision. The hosted runs below document the earlier CI reuse/build
implementation; their exact-tree proof does not cover the later helper changes.

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

Code-review verdict: no remaining blocking findings. The independent reviewer also reconciled the successful full hosted run, cache evidence and historical cost calculations against the saved logs/API data. The reviewer did not run competing Vitest suites or Docker builds while the primary agent tested.

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
| Default production Docker build | Passed: linux/amd64 runtime image, backend typecheck and dashboard compilation included |
| Local runtime startup smoke | Passed: capability output is a valid string array |
| Deliberate Docker backend type error | Default build fails with TS2322 in the injected file before producing artifacts |
| Typecheck | Existing per-file strictness budget satisfied; no new type errors |
| ESLint | Passed |
| Workflow/shell syntax | actionlint and bash syntax checks passed |
| Live proof API read | Existing successful run `35116418880` found correctly |

Six cheap policy cases were added between the worker measurements; the application test set and isolation were unchanged. These are local measurements, not an estimate of GitHub savings. The slowest application unit file is `fansly-binding-transport.test.ts`; its deliberately real network deadline accounts for about 15s. This change keeps that coverage and does not replace real transport evidence with fake timers.

Hosted admission checks confirmed Draft skips heavy jobs and fails the required gate (run `35124769984`). Ready started all checks (run `35124864973`). A description edit created only skipped jobs without a check named `Quality Gate` (run `35124939415`), and the existing full run continued.

That live response exposed a reporting edge: GitHub returns the unevaluated dynamic name for a skipped job. The cost classifier now recognizes the actual API name and requires a skipped run, with a regression case that distinguishes cancellation. The partial full run was then cancelled intentionally to avoid finishing a stale revision; final hosted validation runs on the corrected commit.

The local amd64 Chromium smoke failed under the ARM Mac's QEMU emulation (`qemu: uncaught target signal 5`, unusable GPU process). This is not recorded as a passing local test. On the native amd64 GitHub runner, both the unchanged Chromium smoke and startup capability smoke passed (run `35125171131`, 2026-09-16 17:03 UTC). No browser flags or checks were weakened.

### Successful full hosted gate

[Run 35125171131](https://github.com/goslingmanagment/core/actions/runs/35125171131) passed on commit `c026a6bf`: 354 unit files / 4237 tests passed / 9 existing skips; DB shards 736 + 962 + 833 passed; the PR API subset passed 27 cases (the other 77 were covered by the local full API run). Typecheck, lint, contract regeneration, exact-checkout metadata, image-ID recording and both runtime smokes passed. The main-only identity/label verification and registry publication steps are not executed on this PR event. Both gate and integration proof artifacts were published.

The full cold run consumed an estimated **47 rounded runner-minutes**: fingerprint 1, static 12, DB 12 + 10 + 11, quality 1. Static wall time was 696s: unit tests 376s (prior observed run 469s), Docker build 194s including ~88s preparing/sending the first cache export. The prior observed full run was 43 minutes; this first cold run does **not** demonstrate lower total full-run cost. Runner and shard timing vary, and the unit suite now includes additional policy tests. The frontend-only run below measures DB evidence reuse and warm Docker layers separately from a fresh full gate.

GitHub's cache API confirmed 38 entries / about 486 MiB for this PR after the build. Cache export succeeded rather than merely being tolerated by `ignore-error`.

### Frontend-only hosted probe

Probe commit `f5cc0745` added one nonfunctional comment to `apps/dashboard/src/main.tsx`. The full fingerprint changes while the integration fingerprint remains identical. Both the real workflow and an independent live lookup selected integration proof `35125171131` with no full proof; static/image checks run and DB shards are skipped. [Run 35126578483](https://github.com/goslingmanagment/core/actions/runs/35126578483) completed successfully: all 4237 unit cases (9 existing skips), types, lint, contracts and both native image smokes passed. Its Quality Gate log names producer `35125171131`. The run used **13 rounded runner-minutes** (fingerprint 1, static 11, gate 1) versus 47 in the fresh full run. Static took 647s, unit 412s and Docker 92s. Docker logs explicitly show GHA manifest import and cached dependency/browser layers.

This is a controlled source-only frontend probe, not evidence that arbitrary dashboard configuration, dependencies or shared-code changes can skip DB checks. The temporary comment is reverted in the final branch; the application source matches the successful full gate. Final full/integration fingerprints return to those of `c026a6bf`, with only excluded Markdown evidence updated. The final PR check verifies reuse of that exact full-tree proof.

Raw local logs live outside the implementation worktree under the owner's `investigations/ci-cost-2026-09-16/implementation/`; they are not runtime inputs or production changes.

## Historical runner accounting

The read-only CLI also completed an untruncated seven-day sample: 202/202 completed runs created after `2026-09-09T17:01:34Z`, 6821 estimated rounded runner-minutes. Full CI accounted for 6607 minutes across 164 runs (96.9%); nightly accounted for 188 minutes across 6 runs. This retrospective window mostly predates the optimizations. It includes rerun attempts and intentionally cancelled validation work, and is not a new savings estimate or an invoice. Raw data is `week-cost-report-complete.json` in the external evidence directory.

## Interpretation and limits

The reduction from 43–46 runner-minutes to 2 for repeated PR trees and 7 for main builds was observed before this change. This PR addresses correctness gaps and remaining redundant work; it does not claim a measured new monthly saving before enough new runs exist.

The dependency ratchet recognizes imports and common composed filesystem paths. It cannot prove arbitrary dynamic JavaScript dependencies. New cross-boundary behavior must restore its inputs to the integration fingerprint. Unknown paths remain checked by default.

GHA cache access remains scoped by GitHub: this PR can warm its own merge-ref cache, while main needs its first post-merge build to seed a cache available to other PRs. A successful PR cache test does not prove a warm main cache. See [GitHub cache restrictions](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache) and [Docker GHA cache](https://docs.docker.com/build/cache/backends/gha/).

No production deployment is part of this change. Hosted validation covers PR events, checks and cache behavior. Main-only image handoff/publication remains covered by policy tests but needs its actual post-merge run; it has not been executed for this revision.
