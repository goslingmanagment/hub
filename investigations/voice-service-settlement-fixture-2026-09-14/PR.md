The successful `end_turn` voice admission test returned while its detached completion transaction could still update the voice row and character budget. The next test's database reset then deadlocked in main CI (run34794319085, PostgreSQL 40P01 in `beforeEach`). Wait for the persisted `completed` state using the suite's existing bounded helper before ending that case. Runtime dispatch, admission assertions and reset behavior are unchanged.

The committed completion state also proves budget reconciliation committed; only dispatcher cleanup remains afterward in this fixture. Decision 330 and the investigation retain the original failure, source trace, independent review and exact validation receipts.

Validation on the reviewed candidate:

- `pnpm check` — 3,580 passed, nine existing skips; strictness, lint and build passed (48.911 s).
- `pnpm exec vitest run --no-file-parallelism tests/voice-notes-service.integration.test.ts tests/voice-notes.repository.integration.test.ts` — 43/43 Docker-Postgres tests, zero skips (11.553 s).
- Both ran with `ALLOW_MISSING_TEST_PREREQUISITES=0`, `NODE_OPTIONS=--max-old-space-size=4096`; before/after source hashes match. Offline frozen install and `git diff --check` passed.
- Independent review: no actionable findings. Fresh PR CI remains the merge gate.

Evidence: `investigations/voice-service-settlement-fixture-2026-09-14/`. No production behavior, flag or migration changes.
