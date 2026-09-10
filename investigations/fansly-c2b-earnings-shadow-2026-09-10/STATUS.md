# Fansly C2b — semantic earnings shadow

Branch `feat/fansly-c2b-dirty`, based on current main `940ec69f`.
Decision 289 follows main 286 and open C1/W0 reservations 287/288.
Migrations 0180/0181 follow C1's reserved 0179; recheck before merge.

Implementation is ready for a separately approved deployment and one-page
shadow enablement. `fanslyFanEarningsShadowPageAllowlist` defaults to `none`.
No production operation, retained replay, dirty selection or cadence change
has been performed as part of this stage.

## Delivered behavior

- The owned Fansly transaction writer commits semantic dirty intent atomically
  with the persisted transaction, including same-ID changes and old/new fan
  binding. Bookkeeping-only/identical upserts do not add another revision.
- Lifetime and monthly have independent revisions, claims, receipts and
  check/change provenance. R+1 survives settlement of R. Unknown/inconsistent
  binding remains explicit transaction-scoped debt, including missing-roster
  and zero/negative-spend targets.
- The existing daily spender rotation makes the same requests. Each response
  is journaled before parse, settlement or the next endpoint. Receipt-storage
  failure cannot replace the original HTTP 404/429 or lose its Retry-After.
- A baseline or unchanged response after a signal stays unconfirmed. Empty,
  malformed, mismatched-fan and missing receipts are not valid checks.
- Fan erasure reaches the new state, preserves bystanders on the same/other
  pages and rejects a late old claim. Legacy refresh planes are unchanged.
- A restricted metadata report shows endpoint ages, unknown attribution,
  pending targets outside the daily roster, missing/in-flight receipts and
  changes without a signal at claim time. Partial walks retain the previous
  completed independent spender-sweep timestamp.

The former earnings handler is extracted from the large executor module into
small modules. The largest new production module is 184 lines. No new provider
transport, scheduler lane or monetary parser was added; receipts reuse C2a's
provider-derived parser and SHA-256 content identity.

## Validation

- `pnpm check`: 3190 unit tests passed in 291 files, 9 existing skips. The
  strictness ratchet remains 1908 known errors in 121 existing files; no budget
  was increased. Lint and dashboard build passed. The existing bundle-size
  warning remains; it is not a failed build.
- Serial real Docker-Postgres: 57 tests in 10 files, zero skips, 23.01 seconds.
  Suites: `fan-earnings-dirty`, `fan-earnings-receipts`, `fan-earnings-capture`,
  `fan-earnings-erasure`, `fansly-fan-earnings-cursor`, `fan-earnings-identity`,
  `transactions-writer-gate`, `fansly-engagement-projection`,
  `erasure-fan-ref-columns`, `erasure-page-owned-tables` (all integration tests).
- Independent static review found a masked provider error, ambiguous successful
  receipt provenance and a page-uncorrelated attribution erasure predicate.
  All were fixed with regression coverage. Final re-review found no actionable
  findings; the reviewer did not run tests or use production.
- `git diff --check` passes. Full local test output is summarized in
  [evidence/validation.txt](evidence/validation.txt).

## Production and remaining scope

Production measurements for C2b: none. No report has been executed at production
cardinality. No request savings, fresh-event latency, end-to-end correction
coverage or C2a production repair is claimed. A0's seven-day clock is not started.

Tracked state is a partial scope; no signal can reveal every correction outside
lookback or a missing fan roster. Pending signals can overlap quiet corrections.
Local receipt time is not the provider's undisclosed change time. Empty snapshots,
delayed recalculation, never-checked targets, losses and deterministically rejected
fans remain debt. Current rotation can still stall on a rejected head fan.

Next gate: the [runbook](../../docs/runbooks/fansly-earnings-shadow.md) prepares
the exact source/image, inherited C2a reader/reparse compatibility, one-page
audited enablement, retained reports and flag rollback. Production deployment,
flag flips and C2a replay/repair need explicit approval. C2c selection/rotation
changes remain gated by measured quiet-correction freshness or a separate
owner max-age decision. W0 live/B0/B1, A1 and B2 keep their separate gates.
