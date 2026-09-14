# C1 CI failure diagnosis

**The failing assertion is a time-dependent test fixture defect, not runner
infrastructure or a C1 implementation regression.** Source and the retained
CI timing explain the exact difference. No local reproduction, test rerun,
code change, or production operation was performed during this diagnosis.

- PR head: `37033f41d665da496d7d17a0de5f9f55ac688619`.
- CI checkout: `981312887824678c461caaf6c12a59cf718b7ffd`, the merge with
  base `0a08365fbefa545397f4e91a2eae3fca7c36c444` (raw log lines 128–131).
- [Run 34791202547](https://github.com/goslingmanagment/core/actions/runs/34791202547),
  [Integration 2/3, job 103815684206](https://github.com/goslingmanagment/core/actions/runs/34791202547/job/103815684206).
- Node 22.23.2, pnpm 10.33.1, Vitest 4.1.10.
- Command: `pnpm test:sync-critical:db --shard=2/3`.
- Shard outcome: 66 passed files / 1 failed file; 814 passed tests / 1 failed
  test, 575.52s. Static checks and the other two integration shards passed.
  Quality Gate failed because this shard failed; image publication was skipped.

## Failure and cause

`tests/ofapi-credits-api.integration.test.ts:409`, case
`returns the summary with balance, spend by source, budgets, and forecast`,
expected `forecast.avgDailySpend7d === 132`, received `92`.
The assertion and stack are in raw log lines 1138–1173.

The suite completed at **2026-09-14T00:02:51.8836582Z**, after 16.584 seconds
(raw log lines 609–634). The failed case therefore ran before 00:03 UTC.
`seedLedgerFixture` uses the current UTC day but places facts at fixed minutes:

| Fact | Fixture instant | Recorded-activity forecast contribution before 00:03 |
|---|---|---:|
| REST chats | 00:01 | 90 |
| REST messages | 00:02 | 2 |
| Webhook accrual | 00:03 | 0; it is still future-dated |
| External residual | 00:04 | 0; excluded from this forecast basis |
| Refill | 00:05 | 0; excluded from spend |

`getOfapiCreditsSummary` deliberately passes `to: now` for the forecast
(`apps/runtime/src/services/ofapi-credit-report.ts:257`); the repository uses
`occurred_at < to` (`packages/db/src/repositories/ofapi.ts:1938`). Thus the
correct result for these fixture timestamps is **90 + 2 = 92**. The test's
expected 132 prematurely includes the future webhook accrual of 40 credits.

The preceding `today.total === 137` assertion passes because the today view
uses the full UTC calendar day, ending at the next midnight. The separate
case `bounds summary forecast and burn windows at the current observation
time` passed and explicitly requires future entries to remain excluded.
Changing production query boundaries would break that contract.

The fixture, report service, and repository have no changes between the CI
base and C1 head. The fixture/report also match the currently fetched
`origin/main` (`478fca4220d3d07d61a9200d1860316e770cb4fe`). This is an existing
UTC-window defect exposed by this run's execution time.

## Next safe action

Make a focused fixture-only correction so its ordinary historical facts are
never later than the captured seed time, while retaining UTC-day membership
and deterministic ledger ordering. Keep the separate intentional future-entry
regression unchanged. Reproduce the old 00:02 UTC result and verify the corrected
fixture around midnight with the focused Docker-Postgres suite when the serial
test lane is free; then run the required checks and affected CI shard on the
reviewed fix. A blind rerun later in the day could pass without fixing the bug.

## Evidence

`job-103815684206.log` preserves the complete downloaded job log, including
ANSI bytes; `job-103815684206.json` and `run-34791202547.json` preserve metadata.
`failure-excerpt.txt` removes ANSI formatting from selected raw lines and
keeps their original line numbers. `SHA256SUMS` fingerprints these artifacts
and the source files inspected at the C1 head.

The first log download was refused by gh's terminal-escape guard; the same
read-only endpoint was downloaded using `--allow-escape-sequences` into the
retained file. This was not a CI rerun.
