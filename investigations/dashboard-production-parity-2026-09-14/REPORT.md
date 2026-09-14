# Dashboard production parity — local draft, 14 September 2026

The dashboard source restores production reference
`380326368fe39a6a9d22eb73b0b955f8ecd7c3cc`, with one verified formatting-only
exception in `OfapiMarketing.tsx`. The candidate started
from main `0a08365f` and now incorporates main `478fca42` through local merge
`8d9606ca`, after source import commit `ec12875b`, in the separate branch
`fix/dashboard-production-parity-20260914`. Only the append-only decisions file
conflicted; every main section and exact historical D296–300 were retained.

The five original topic commits were applied sequentially without conflicts or
manual behavior changes:

| Commit | Restored behavior |
| --- | --- |
| 2f55b035 | Feature explanations and focused configuration |
| d08d969c | Page context, daily navigation and reviewed actions |
| c011b61d | Reviewed mutation targets, drafts and uncertain replies |
| 273469e6 | Explicit webhook reconciliation after apply |
| c14bf90b | Configuration scope truth and fresh export recovery |

These changes entered the production release through merge `31b73a96`.
The original import covered 103 paths: 74 dashboard files, 15 tests, one
strictness-ratchet file and 13 historical investigation files. After the review
fix, 102 remain byte-identical to production. The single exception formats the
analytics and history JSX blocks in `OfapiMarketing.tsx` (original lines 166–167,
2,502 and 2,030 characters). No other added/touched source line in the import
against its pinned main base exceeds 2,000 characters. No behavior, labels or JSX whitespace semantics changed.
Historical decision rows and sections D296–300 are restored exactly. New
Decision 323 is reserved after the separately prepared provider-cooldown D322;
the coordinator must verify current-main numbering before publication.

Main's runtime, database/migrations, contracts, SDK, AI backend and deployment
changes are retained. In particular, D316 delivery, D318 earnings export and
D320 A0 tests are unchanged. Main performance restoration is inherited without adaptation. The candidate
introduces no runtime/database/contract/SDK/AI/deployment changes against
`478fca42`; C1 membership and provider cooldown remain separate PR topics.
No new flag is introduced.

[Transfer steps](transfer-steps.json) retain exact commit IDs, paths, patch hashes
and clean-application receipts. [Source manifest](source-manifest.json) retains
base/candidate/production hashes and preservation checks; its SHA-256 is
`819f99e75c995aeb75291cd042de1481b6e54023462880f2dc6be1353fb4f784`.
The combined diff passes `git diff --check origin/main`.

[Formatting verification](formatting-verification.json) retains TypeScript 6.0.3
offline transpilation receipts. Canonical emitted JavaScript ASTs match exactly
(node kinds and leaf text, with positions/trivia ignored), including the rendered
JSX text. [The comparison script](verify-marketing-format.mjs) reproduces this
check using an already installed compiler; no dependency changes were made.

Offline frozen dependency installation passed in 2.32 seconds with no dependency
changes. Source import and main merge are local commits only; no push, PR,
provider request or production action was performed. Historical reviews remain
dated source evidence and do not validate this new combination. The independent
formatting follow-up closed R1. [Candidate validation](validation-20260914T001500Z/REPORT.md)
passed: `pnpm check` with 3,574 unit tests and nine existing skips, then 153 tests
in 12 serial Docker-Postgres suites with no skips. Source hashes remained stable.
The remaining publication steps are coordinator verification of D323 numbering
and final review context. Deployment remains gated on the other production/main
differences and the owner's approval.

Final main composition `83471e2c` incorporates main `b78752d0` (merged C1 and
cooldown). The only merge resolution preserves both decision entries. Final
`pnpm check`: 3,580 passed, nine existing skips, 315 files; twelve serial Docker
PostgreSQL suites: 153 passed, no skips. All pinned source hashes remained stable.
See `final-main-validation/` for exact commands and compressed logs, and
`REVIEW-FINAL-MAIN-MERGE.md` for the independent composition review.

The publication composition `7e88384e` includes merged main `a9794e60` and
its UTC fixture. Full check passed at the actual CI 4 GiB limit (3,580 unit
tests, nine existing skips); thirteen serial PostgreSQL suites passed all 179
cases. Source fingerprints were stable; `final-main-a979-validation/` retains
exact commands and compressed logs. Independent composition review remains
clean and preserves D323 before D324.
