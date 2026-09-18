# Independent review: sync-finalization fixture strictness correction

**Verdict: APPROVE. No blocking findings.**

Reviewer: `/root/fix_binding_wait`, independent of the original sync-finalization fix and this fixture correction. Reviewed the working-tree diff against release HEAD `1739053fcf3a334b8081ee0c5aa8e19a7f944a55` in `/Users/dmitriy/code/goose/.worktrees/hub-performance-fixes-20260912`. This approval covers the fixture changes below, not an independent rerun of the runtime integration gate.

## Sync-finalization fixture

Reviewed `tests/sync-finalization-race.integration.test.ts`, file SHA-256 `09dc325b0eec45448adbb53694c6229812d200efa923da264e2a374f11bca882`. The nine additions and six deletions are limited to explicit fixture-result guards and correction of the test callbacks.

- The model, page and run guards immediately follow their respective creation calls, before the returned object is dereferenced. Missing fixtures fail with a specific error. No cast, non-null assertion, suppression or fallback object hides a failed setup.
- The scalar `it.each` callback now takes only the status supplied by the table. All three test bodies explicitly fail when the database is unavailable, so the correction removes silent skip paths. The optional reset/cleanup hooks cannot turn a missing database into a passing case: every body and `seedRun` fails before attempting the race.
- All twelve expanded cases remain: both cleanup implementations, each with four terminal statuses, finalizer rollback, and cleanup acquiring the row lock first. The terminal status `skipped` remains a tested result; there is no test `.skip`, `.only` or `.todo`.
- Both contenders still use separate single-connection pools. The unchanged `waitForBlocker` queries `pg_blocking_pids` and throws on its deadline, proving the contested statement reached the other transaction's lock before commit or rollback. Transaction order, statement timeouts and immediately attached promise rejection handling are unchanged.
- The assertions retain cleanup counters, final status, stats, error summary, finish time, and the retained checkpoint event. The rollback and cleanup-first scenarios still exercise their original outcomes. `finally` still releases the transaction, settles pending work and closes both pools.

This is a direct correction of fixture preconditions and callback typing. It preserves the concurrency evidence and introduces no production or architectural change.

## Separate independent check: logging fixture lint correction

Also reviewed the root-authored one-line diff in `tests/compose-config.test.ts:143`, file SHA-256 `462e8c1202d276ed65054fd9276679d45937240d0c2a918636c13e38c21480b8`.

The regular expression's four literal ASCII spaces become a literal ASCII space repeated exactly four times (` {4}`). The line anchor, `command:` text, array capture, newline exclusion, end anchor and multiline flag are unchanged. It therefore matches the same command lines with the same capture. The subsequent JSON parse and exact expected Postgres argument array are unchanged. This resolves `no-regex-spaces` without weakening the logging assertion; no production logging configuration changes in this correction.

**Logging fixture verdict: APPROVE.** Fold this line into the logging problem commit separately from the sync fixture correction.

## Validation boundary

The reviewer inspected the exact diffs and surrounding test/control paths and independently verified both file hashes. No suites, database processes, production access or source edits were performed for this review. The sync fixture author reports targeted ESLint, diff checking and the existing TypeScript debt ratchet passing (1,897 known errors in 120 debt files); this is not a clean-TypeScript claim. The coordinator retains responsibility for the combined check and serial integration gate after folding the corrections into their respective problem commits.
