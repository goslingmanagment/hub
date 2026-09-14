# Restore the deployed performance layer to main

The candidate restores twelve deployed fixes and the original 0185/0186
migration files. It preserves newer main changes. C1 membership diagnostics
and dashboard feature controls remain separate differences to reconcile before
deploying main as a replacement for production.

Base: `0a08365fbefa545397f4e91a2eae3fca7c36c444`.
Production source: `380326368fe39a6a9d22eb73b0b955f8ecd7c3cc`.
Branch: `fix/production-perf-parity-20260914`.

## Scope and source

The patches were applied in their original dependency order, with three-way
merge against main. The original performance branch and the owner's dirty
checkout were left untouched. [Transfer receipt](transfer-steps.json) records
every imported path and result.

| Original commit | Restored behavior |
| --- | --- |
| `77f1fed0` | PostgreSQL parameter logging limits |
| `62e87c61` | Stable alias lock order |
| `f33946aa` | Bounded recent metric reads and migration 0186 |
| `2ea98edf` | Omit follower seed counts where unused |
| `cfa4c602` | Preserve terminal worker results during concurrent cleanup |
| `c1e0b15e` | Stop new HTTP attempts after observed lease loss |
| `a86ac13e` | Parse each earnings observation once |
| `ce4fb415` | Keep preview reads out of the unrelated sync monitor scope |
| `4ff73c55` | Correct the A0 material-query timeout explanation |
| `bdbb981c` | Bound batching of unmapped webhook pointer bodies |
| `96a86c1f` | Separate capture and replay without losing shared capacity |
| `14219b68` | Avoid journal scans for an empty replay head |

Historical decisions 301–311 and 315 are restored verbatim; decision 321
records reconciliation. Decisions 296–300 belong to the separate dashboard
topic. Main's decisions 314, 316, 318 and 320 are preserved. The deployment
script changes only its existing additive rollback allowlist for 0186.
No new flag is introduced.

Migration 0185 restores the already applied read function and historical
identity. Its C1 writer remains in PR166. SHA-256 pins match the production
source bytes:

- 0185: `bd9c2ee7987815ef6fd0f517a0783ead45954a2eb6ad7b5553c0075859940cb0`.
- 0186: `8fde039eb9e8f0d211ab419f0cd7264e5186aa79d9e223c6a4a42a083d571b7e`.

## Validation

- `pnpm check`: exit 0; 304 unit files, 3,414 passed, nine existing skips;
  typecheck, lint and dashboard build passed.
- Serial Docker-Postgres/transport selection: exit 0; 16 files, 144 passed.
  Exact commands, times and logs are retained in `validation/`.
- Migration continuity uses the real runner and a database built through 0186,
  advances through 0187–0191, and verifies unchanged historical ledger rows.
- Regression suites cover real cleanup/finalizer contention, lease fencing,
  alias concurrency, replay partitions and empty-head query work, payload
  batching, metric parity, seed counts, preview scope and A0.
- [Correctness review](REVIEW-CORRECTNESS.md) and
  [quality review](REVIEW-QUALITY.md): no open actionable findings.

The initial integration run passed 143 tests and exposed a missing environment
dependency in the new migration test's connection path. The test now uses a
checked-out client with guaranteed release, like the existing test helper.
The complete selected suite and `pnpm check` were rerun successfully. Runtime
code did not change in response to that test setup failure. Both runs are kept.

## Production evidence and limits

Bounded read-only preflight on 13 September, 23:30 UTC: all three roles healthy,
zero restarts, source `380326368fe3`, image
`sha256:c443947a356972cd2833c10a4e728fe1890e92e76a77fc2328f00ebca0af5c85`.
The `read_only` role in a repeatable-read, read-only transaction confirmed 0185
applied on 12 September at 12:10:58 UTC, 0186 at 20:04:33 UTC, and 0187–0191
subsequently. [SQL and receipts](preflight/) retain bounds, identity and hashes.
The ledger proves names and dates, not migration content; Git supplies the bytes.

No production mutation, provider request, socket probe, cleanup or deployment
was performed. No new savings or event-to-reader latency measurement is claimed.
A0/A1, C1 policy/presence, C2b/C2c and W0 acceptance remain their own gates.

Before deployment, reconcile C1 and dashboard changes, verify the resulting
complete release, and follow the existing owner-approved deployment procedure.
See [the reconciliation runbook](../../docs/runbooks/production-perf-reconciliation.md).
