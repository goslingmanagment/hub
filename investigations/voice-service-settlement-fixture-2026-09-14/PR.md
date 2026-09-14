The successful `end_turn` voice admission test returned while its detached completion transaction could still update the voice row and character budget. The next test's database reset then deadlocked in main CI (run34794319085, PostgreSQL 40P01 in `beforeEach`). Wait for the persisted `completed` state using the suite's existing bounded helper before ending that case. Runtime dispatch, admission assertions and reset behavior are unchanged.

The committed completion state also proves budget reconciliation committed; only dispatcher cleanup remains afterward in this fixture. Decision 330 and the investigation retain the original failure, source trace, independent review and exact validation receipts.

Validation on the reviewed candidate:

- `pnpm check` — 3,580 passed, nine existing skips; strictness, lint and build passed (48.911 s).
- `pnpm exec vitest run --no-file-parallelism tests/voice-notes-service.integration.test.ts tests/voice-notes.repository.integration.test.ts` — 43/43 Docker-Postgres tests, zero skips (11.553 s).
- Both ran with `ALLOW_MISSING_TEST_PREREQUISITES=0`, `NODE_OPTIONS=--max-old-space-size=4096`; before/after source hashes match. Offline frozen install and `git diff --check` passed.
- Independent review: no actionable findings. Fresh PR CI remains the merge gate.

Evidence: `investigations/voice-service-settlement-fixture-2026-09-14/`. No production behavior, flag or migration changes.

Composition: local validation above was on main `1fe9dbe74daa8a4fbfd452ac352f7f290a60b1e4` plus topic `81fb0a31aa69dbbbe259e983854948c6a9b9ceca`. Before publication the branch incorporates main `ce0a44b0d6778f8bd371c105f26d31f9abe8b8bd` (merged metadata PR187). The voice test blob is unchanged; the only conflict is append-only decisions, preserving main and placing D330 after D327. No new local run is claimed for this composition; independent composition review and fresh PR CI remain required.
