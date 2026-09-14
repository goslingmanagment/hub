# Voice service test settlement boundary

Base main `1fe9dbe74daa8a4fbfd452ac352f7f290a60b1e4`; branch
`fix/voice-service-settlement-fixture-20260914`. Decision 330 is reserved by the
coordinator after pending Decisions 325–329.

The preceding normal `end_turn` admission case ended after the detached
`dispatched` response. The next test reset could truncate tables while the
voice completion and budget transaction was still running. Main run34794319085
failed in that reset with PostgreSQL 40P01; the retained failure and exact source
trace are in [VOICE-RESET.md](VOICE-RESET.md).

The three-line test correction awaits persisted `completed` using the suite's
existing bounded wait. That state becomes visible only after the completion
and budget transaction commits. The remaining success-path dispatcher cleanup
has no database write for this case. Existing admission assertions, runtime
behavior and reset semantics remain unchanged; no sleeps, reset retries or new
production flags are added.

The original CI failure is retained as the observed negative case. A new
artificial lock harness or repeated flaky run would not add meaningful coverage
for this bounded lifecycle correction. The actual voice service suite exercises
the predecessor and failed successor together; the repository suite checks its
settlement and budget contracts. Its validation receipts are retained below.

Validation completed on the exact reviewed test and Decision 330 hashes:

- `pnpm check`: 3,580 passed and nine existing skips in 315 files; strictness,
  lint and build passed. The unchanged strictness budget permits 1,897 known
  errors in 120 files. Total duration 48.911 seconds.
- `pnpm exec vitest run --no-file-parallelism tests/voice-notes-service.integration.test.ts tests/voice-notes.repository.integration.test.ts`:
  43 passed in two Docker-Postgres suites, zero skips; 11.553 seconds.
- Both used `ALLOW_MISSING_TEST_PREREQUISITES=0` and a 4096 MiB host Node budget.
  The existing unit script retains its own explicit memory setting. Every source
  hash was unchanged before/after validation; exact commands and compressed logs
  are in `check.json`, `postgres.json` and the matching `.log.gz` files.
- Independent root-agent [review](REVIEW.md) found no actionable findings.
  `git diff --check` and offline frozen installation passed.

The service suite runs the repaired predecessor and formerly failing successor
against real PostgreSQL; the persisted terminal state verifies its transaction
finished before reset. This passing run plus the deterministic transaction
boundary closes the identified leak, without claiming that all possible
asynchronous test lifecycle defects have been eliminated. Fresh PR CI remains
required before merge. No production actions or measured production effect.
