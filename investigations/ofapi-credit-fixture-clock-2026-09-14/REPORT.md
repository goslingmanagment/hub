# OFAPI credits fixture: UTC-midnight CI failure

The ordinary ledger fixture created facts at 00:01–00:06 UTC even when the report ran before those instants. C1 CI observed the forecast before 00:03: it correctly counted 90 + 2 credits, while the fixture expected the additional 40-credit webhook fact. The focused correction keeps ordinary fixture facts within the captured UTC day and no later than the captured instant. Production report windows and the separate intentional future-entry test are unchanged.

This is a separate test-only change from main `478fca4220d3d07d61a9200d1860316e770cb4fe`, on branch `fix/ofapi-credit-fixture-clock`. Only `tests/ofapi-credits-api.integration.test.ts` changes. Decision 324 records the test-only clock correction; PR publication remains coordinated by the parent task; no commit, push or production operation was performed here.

## Source evidence

The original failure is [C1 run 34791202547, Integration 2/3](https://github.com/goslingmanagment/core/actions/runs/34791202547/job/103815684206), at PR head `37033f41d665da496d7d17a0de5f9f55ac688619`. Its failure log, exact excerpt, job/run metadata and original diagnosis are retained under [evidence/c1-ci-failure](evidence/c1-ci-failure/REPORT.md). `provenance.json` identifies the original local files, source and retained hashes. The complete original log is retained as gzip; decompressed SHA-256 is `dd1b9c9e198c72c7c9bd8d89d85e884f4953d5753fb6201b09eb736d25c64206`.

The failure was an existing clock-dependent test fixture defect. The fixture and relevant application report/repository code were unchanged between that CI merge base and C1 head. A forecast window ending at the observation must continue to exclude future facts.

## Regression and validation

The five explicit observations exercise the real summary service and PostgreSQL at the first millisecond of a UTC day, 00:02:30, 00:06, the last millisecond of a day and the first millisecond of a month. They assert the 137-credit daily total, 23,950 balance, 132-credit recorded-activity forecast and absence of ledger facts at or after the observation. The test passes an explicit report instant rather than mocking process or database clocks.

All commands ran serially. Each validation JSON records the exact command, directory, UTC start/end, duration and exit code; complete logs are adjacent under [validation-20260914T001945Z](validation-20260914T001945Z/).

| Receipt | Result | Meaning |
| --- | --- | --- |
| `regression-before.json` | Expected failure, exit 1; 5.467s | The new 00:02:30 case with the original uncapped fixture reproduced both forecast values as 92 instead of 132. One selected case failed; 25 cases were filtered out. |
| `postgres.json` | Pass, exit 0; 26/26, no skips; 11.071s | `ALLOW_MISSING_TEST_PREREQUISITES=0 pnpm exec vitest run --no-file-parallelism tests/ofapi-credits-api.integration.test.ts`: all 21 existing cases and five new boundary cases pass against Docker PostgreSQL. |
| `check-reviewed.json` | Pass, exit 0; 45.025s | Final reviewed source passes `pnpm check`: 304 unit-test files, 3,414 tests passed and nine existing skips, plus strictness baseline, lint and build checks. |

Final fixture SHA-256: `eff98afad7b6f0e87563a831c33d0b27bb2581f109f4166900d60e82f28be86b`, also recorded in `candidate-source.sha256`. The final PostgreSQL run completed at 2026-09-14T00:23:27.310188Z; the final full check completed at 00:24:27.277806Z.

Earlier attempts are retained: `check.json` failed because the newly added `it.each` callback did not receive Vitest's test context; `it.for` corrected it. `check-final.json` passed an intermediate fixture variant and is superseded by `check-reviewed.json`, which validates the final simple cap. Offline frozen installation succeeded; its complete log is retained as `install.log`.

[Independent review](REVIEW.md) found no outstanding actionable findings against the final source fingerprint. It explicitly corrects an earlier, disproved concern about equal timestamps: the existing balance-series query already includes an ID tiebreaker. No production ordering change is required or included.

The C1 failed-job rerun is a separate validation of its existing head at a later real time. A green rerun alone does not fix the fixture; the deterministic negative control and corrected boundary tests establish the defect and correction here.
