# Fansly C2a — earnings correctness

Historical preparation record for the original PR165. Its statements below
refer to that original preparation, including the then-pending deployments.
For the current retained projection audit, see the
[12 September status](../fansly-c2a-audit-2026-09-12/STATUS.md).

Branch `fix/fansly-c2a-earnings`, based on main `a3caa0e9` (A0 PR164).
[PR165](https://github.com/goslingmanagment/core/pull/165) merged as `f0a53aee`
after all five CI checks passed. Decision 285; no production deployment, replay,
repair or new flag is implied.

The two earnings kinds now use observation identity and a separate SHA-256
content fingerprint. A later A after B applies, while replay of one observation
is idempotent. Provider-derived mills and daily spender rotation remain intact.
Only new v2 earnings are hidden behind atomic projection checkpoints; historical
v1 keeps its original SSE edges. DM/purchase parse versions stay at v6.

Projection ordering uses observation time and observation ID. Migrated legacy
rows resolve equal-time receipt order from their exact source event; a missing
receipt refuses the equal-time overwrite. Newer snapshots can still apply.
Malformed/partial observations retain parse debt with bounded rejection codes.
An empty array supplies no monetary identity or per-fan refresh receipt; an
explicit valid zero is preserved. Source ordering beyond provider timestamps
or local receipt order remains unknown.

Validation on the final code:

- `pnpm check`: 3139 passed, 9 existing skips, 285 unit files. Strictness ratchet
  remains 1908 known errors in 121 existing files; lint and dashboard build pass.
- Serial real Docker-Postgres: 46 tests in six files, zero skips, 24.12 seconds.
  The suites are `fan-earnings-identity`, `fan-earnings-projection`,
  `fansly-fan-earnings-cursor`, `domain-events-mixed-append`, `domain-events-v2`
  and `domain-events.repository` (all `.integration.test.ts`).
- Evidence includes lifetime/monthly A-B-A, retry/rebuild, stale-after-fresh,
  legacy same-time ordering from a migrated zero column, missing source receipt,
  partial/invalid debt versus empty capture, unchanged DM parse debt, SQL replay
  continuity and the existing real listening SSE suite. A live-hub unit fixture
  covers legacy v1 + hidden v2 + checkpoint + normal event delivery.

Independent review found the migrated-zero ordering issue and silent parse
stamping for malformed snapshots. Both were fixed with real driver/DB fixtures;
final independent re-review found no actionable issues. The review was static;
no tests were delegated to the reviewer.

Production measurements for C2a: none. The original A-B-A proof was an offline
counterexample, not an established production incident. No request savings,
fresh-event latency or repaired production totals are claimed. Two-endpoint
check/change receipts, same-ID transaction dirty signals and quiet-correction
freshness belong to C2b/C2c and remain uncovered by this slice.

The [runbook](../../docs/runbooks/fansly-earnings-correctness.md) prepares
reader-before-writer deployment, compatible rollback, full retained replay and
page-scoped repair. Each production operation still requires explicit approval.
The seven-day A0 shadow has not started; PR164 is merged and not deployed.
