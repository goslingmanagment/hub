# Validation: DM exclusion preserves newer material

The final source passes independent review, `pnpm check` and four serial Docker
PostgreSQL suites. The regression also fails against the original handler for
the intended reason: its stale upsert replaces the newer head, preview, stored
cursors/count, coverage, flags, unread count and nested metadata.

The candidate composes main `b78752d0d1144a8457638ffb3ae0bda33455fde1` with
the narrow metadata exclusion change. The final handler captures the probed
partner in an immutable local value so the non-null guarantee survives the
transaction callback. No provider requests or production reads/writes were run.

| Receipt under `evidence/` | Result | Duration |
| --- | --- | --- |
| `install.json` | Offline frozen install passed | 2.221s |
| `original-handler-negative-control.json` | Expected failure: one selected regression fails on stale material; four cases filtered out | 6.282s |
| `check.json` | Initial failure: one new nullable-partner type error; fixed without changing the strictness budget | 12.781s |
| `check-final.json` | `pnpm check` passed: 304 unit files, 3,420 passed, nine existing skips; strictness/lint/build passed | 46.218s |
| `postgres.json` | Four suites passed, 48/48 tests and zero skips | 12.485s |

The final PostgreSQL command was:

```sh
ALLOW_MISSING_TEST_PREREQUISITES=0 pnpm exec vitest run --no-file-parallelism \
  tests/fansly-dm-exclusion.integration.test.ts \
  tests/page-dm.repository.integration.test.ts \
  tests/page-sync-lease-fencing.integration.test.ts \
  tests/fansly-dm-conversations-sweep.integration.test.ts
```

The five new cases exercise preserved material during a lookup interleaving,
removed/rebound rows without checkpoint advance, a replaced lease and a wrong
page. Failure history, account-lookup capture, repositories and transactions are
real; transport and telemetry are stubs. The three adjacent suites retain
repository, lease and conversation-sweep behavior. These tests do not establish
a past production overwrite, deployed repair or provider completeness.

Each command receipt records its UTC start/end, exact arguments, exit and source
hashes. Final checks completed at 2026-09-14T00:45:11.459084Z and PostgreSQL at
00:45:37.933303Z. Source hashes were unchanged across both final commands.
Final handler SHA-256: `18d6882d4c9e04843fd77fe75790113b74984032041956a70126676719e88f9c`.

The negative control substituted only main's original handler while retaining
the new regression; `negative-control-restore.json` records the exact original,
candidate and restored hashes. Restoration occurred in `finally`, before the
later immutable-partner type correction and final validation. Complete logs are
retained as deterministic gzip without trimming; `compressed-logs.json` records
both compressed and original-byte hashes. `validation.json` binds the final
checks, source hashes and [independent review](REVIEW.md). Earlier composition
fingerprints remain historical evidence, not the final source fingerprint.
