# Sync-finalization regression fixture — strictness correction

Author: `/root/review_earnings_parse_fix`.
Independent reviewer: `/root/fix_binding_wait`.
Worktree: `/Users/dmitriy/code/goose/.worktrees/hub-performance-fixes-20260912`.
Only edited source/test file: `tests/sync-finalization-race.integration.test.ts`.

## Problem and correction

The combined check stopped on six new TypeScript errors in the committed race fixture (`implementation/final-check.log`): nullable returns from `createModel`, `createFanslyPage` and `startSyncRun` were dereferenced without checks, and the scalar `it.each` callback incorrectly treated its second argument as Vitest's test context.

The correction adds an explicit failure immediately after each fixture creation when its expected result is missing. It does not use a non-null assertion or cast to suppress these errors. The scalar table callback now receives only `status`. Its missing-DB path, and the same paths in the two other cases, throw the existing clear prerequisite error instead of skipping a mandatory PostgreSQL regression test.

The file changes by nine insertions and six deletions. All twelve expanded concurrency cases remain: four terminal statuses plus rollback and cleanup-first ordering, for each of the two cleanup implementations. Assertions, SQL, backend-blocker verification, transaction ordering, immediate promise rejection handling, rollback and connection cleanup are untouched. No production code or runtime behavior changes.

## Validation and handoff

- Targeted ESLint: passed.
- `pnpm typecheck`: passed unchanged strictness ratchet, **1,897 known errors / 120 debt files**. This is not a clean-tsc claim.
- `git diff --check -- tests/sync-finalization-race.integration.test.ts`: passed.
- No Vitest, database/Testcontainers, provider/production access or commit was run by the author. The coordinator owns the full check and integration run.
- Source is frozen for independent review. The coordinator plans to fold this correction into the existing sync-finalization problem commit (`7b8343d9` before history rewrite), preserving one problem per commit.

File SHA-256: `09dc325b0eec45448adbb53694c6229812d200efa923da264e2a374f11bca882`.

Exact file diff SHA-256 (`git diff --binary -- tests/sync-finalization-race.integration.test.ts`): `89694266c1ea93064d6d3f1a90e79f563962fc9d44a427a8c0beb720af8177bf`.
