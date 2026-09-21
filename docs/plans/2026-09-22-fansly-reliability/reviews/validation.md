# Validation and delivery

Application revision: ffe804bcb5f05c3148f0a9c680a9783788564844. Base: ecc864da (origin/main, verified before PR creation).
Draft PR: https://github.com/goslingmanagment/core/pull/254

## Checks

- Final pnpm check: pass. Strictness ratchet has no new errors (existing baseline:
  1,736 errors across 114 files); ESLint passes; 356 unit files pass, 4,356 tests
  pass and 9 existing tests skip; dashboard production build passes.
- Final targeted PostgreSQL/schema run: 9 files, 133 tests pass. This includes
  all Fable follow-up changes: A0 first-page failure, B1 rotation versus lease
  loss, historical materialization, live-plus-delete, walk limit and no-op preview.
- Additional B0 integration suite: 15 tests pass. It ran after the shared provider
  guard refactor; no B0 implementation changed in the Fable follow-up.
- bash -n scripts/deploy-production.sh and git diff --check pass.
- Platform-branch ratchet reduced from 164 to 163 through a shared provider guard.
- Plan review, implementation review and focused follow-up used actual
  claude-fable-5-1. Final follow-up: all findings addressed, no remaining blockers.
- Exact-delete lookup index checked on disposable PostgreSQL 16 with 20,000
  synthetic same-group receipts; EXPLAIN is committed next to the reviews.

## Practical limits

These are local code and PostgreSQL regression proofs, not a production dataset
completeness certificate. No deployment, flag change, production policy repin,
watermark reset or backfill was performed. The six Ari targets have a read-only
manifest; no WS-to-archive B2 projector was introduced and no recovery is claimed.
The main working checkout and its pre-existing edits were preserved.

## Merge preparation (2026-09-22)

Merged main 5d4cf1b120488951c03746a14fdd6ee734c3fb92. Conflict resolution
preserved both decision entries and rollback allowlist entries; the unreleased
Fansly migration moved from 0205 to 0206 without SQL changes. No runtime source
conflicts occurred. The combined tree passed 138 tests across six files:
Fansly B1 repository/runtime, schema guard, migration invariants, production
migration history, and deploy behavior. Shell syntax and whitespace checks pass.
Full CI is required before merging PR #254.
