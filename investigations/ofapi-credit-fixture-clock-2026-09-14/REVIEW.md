# Independent CI fixture review

Reviewed 2026-09-14T00:24:20.779052+00:00 against main `478fca4220d3d07d61a9200d1860316e770cb4fe`. Scope: the test-only UTC fixture correction in `tests/ofapi-credits-api.integration.test.ts`; no tests, production calls or application edits were performed by this reviewer.

## Verdict

No outstanding actionable findings. The final simple cap fixes future-dated ordinary fixture facts without changing production forecast semantics. Publication still requires the author's completed checks and PostgreSQL receipts for this exact candidate; this review is an independent source assessment.

## Confirmed behavior

- The retained CI diagnosis correctly explains the failed 132-versus-92 assertion. At 00:02:30 UTC the old fixture's 90-credit and 2-credit REST facts precede the report, while its 40-credit webhook fact at 00:03 does not. The report's `to: now` is intentional, and `summarizeOfapiSpendWindowBetween` applies the exclusive `occurred_at < to` bound. A full-day display total can still be 137 while this recorded-activity forecast is 92. This is a fixture defect, not a reason to broaden the production forecast window.
- `seedLedgerFixture(now = new Date())` captures one instant and caps each existing UTC-day offset at that instant. Positive offsets cannot move before day start or into the next day. The default HTTP tests await all seed writes before requesting the report; the new deterministic cases pass seed time one millisecond before an explicit report observation, including at the first millisecond after midnight and month start.
- The five `it.for` PostgreSQL regressions exercise the real summary service with explicit observations, asserting business outcomes (137 total, 23,950 balance and 132 recorded-activity daily/month totals) plus absence of ledger facts at or after the observation. The 00:02:30 case targets the observed CI failure; the other cases cover boundary positions. Per-case database reset prevents row leakage. No global Date, timers or PostgreSQL clock is mocked; `it.for` correctly supplies Vitest's context as the second callback argument.
- Existing fixture credits, sources, operation identities, writes and cursor sequence are unchanged. The previously named `minutes` helper is now `ledgerTime`, reflecting that a requested minute may be capped. The existing HTTP summary assertions remain, and the separate intentional future-entry test is byte-identical to main. Application report and database repository files also remain byte-identical to main.
- At very early instants several capped timestamps can tie. This does not introduce a balance-order defect: `listOfapiBalanceSeriesBetween` orders by timestamp and ledger ID, then reverses; the current credit state is updated by the existing sequential awaited writes. No artificial timestamp spacing or runtime ordering change is required.

## Review correction and limits

During the initial review I misidentified the adjacent refill query's timestamp-only order as the balance query and raised a possible tie concern. Reading the complete balance function disproved it; this was explicitly corrected to the author and coordinator before the final candidate. The final patch retains the simpler cap, and this concern is not an outstanding finding.

The explicit-time regressions establish the seeded-history and report-boundary contract. They do not claim to virtualize all wall-clock behavior across the entire HTTP integration suite or to prove production monetary outcomes. The author reports that an old-offset negative control reproduced 132 versus 92; that runtime receipt is separate from this review, whose checks were local static comparisons only.

## Reviewed fingerprints

| File | SHA-256 |
| --- | --- |
| `tests/ofapi-credits-api.integration.test.ts` | `eff98afad7b6f0e87563a831c33d0b27bb2581f109f4166900d60e82f28be86b` |
| `apps/runtime/src/services/ofapi-credit-report.ts` | `b42bd954bd2d7fbe3180f1a8bde6c876c2aa69240984089eede0db55eec57630` |
| `packages/db/src/repositories/ofapi.ts` | `b5e9b53b1b9279aabc1cd96bbcd85c9378994094f54dbdcfb27972b4f332b3ba` |

Unchanged intentional future-entry case SHA-256: `1bd074401b4500327ea927a264e2e18d191729ad0502304853c92a25c3e7db78`.
