# W0 transport diagnostics — reviewed and locally verified

Base: `b5900cfcf41a5a29d45a7c8c7c8ee0b2a76dce3e` (PR #198).
Decision 338 records this operator-only receipt change.

The motivating attempt is Lilly-1 at 2026-09-14 20:42:08.221–20:42:08.379 UTC,
run ID `7bb2c230cc024489bf8388393cc95084`: one socket attempt, zero REST requests,
no frames/type-1, `transport_error`, generation unchanged and cleanup confirmed.
Original evidence and the separately reviewed offline diagnosis remain at
`/Users/dmitriy/code/goose/hub/investigations/fansly-w0-continuity-2026-09-14/paired-preparation-20260914T202652Z/`.
Neither a failed HTTP upgrade nor a particular proxy/TLS/auth cause was proven.

The short wrapper now forwards its existing observed open timestamp. Both
receivers use the shared observer's fixed failure phase and a per-attempt
dispatcher interceptor that retains an allowlisted structured error code and
outer HTTP status before Undici discards them. It forwards the original handler
callbacks and freezes metadata before cleanup. Unknowns remain null; 101 alone
does not establish open, and internal CONNECT status is not reconstructed.

Focused regressions cover pre/post-open errors, type-1 independence, constructor
and send exceptions, first-error/snapshot preservation, getter/cycle/depth
boundaries, interim and rejected HTTP statuses, redaction, and both existing
local CONNECT/SOCKS transports. The latter retain their no-global-fallback,
no-REST-pacing and trusted-TLS checks and add outer HTTP rejection coverage.

A standalone check with real Undici and in-memory rejecting dispatchers passed:
`ECONNREFUSED`, `CERT_HAS_EXPIRED` and `UND_ERR_ABORTED` retained their allowed
codes; an unknown code became null. Every receipt retained `pre_open`, null
open/status/close, one dispatch and no secret. Global fallback calls were zero.

Root validation on the frozen source passed on 14 September UTC (15 September
Europe/Moscow), in one serial lane:

- `pnpm check`, 21:07:22–21:08:41 UTC: exit 0; **3,835 passed + 9 skipped in
  334 files**, lint and dashboard build passed. The typecheck ratchet retained
  1,897 existing errors within its prior budget; this change added no debt.
- `pnpm exec vitest run --no-file-parallelism tests/fansly-probe-context.integration.test.ts`,
  21:08:41–21:08:49 UTC: exit 0, **16 Docker-Postgres tests passed**.
- Short, continuity and binding operator bundles all built successfully.
- Source hashes before and after both suites matched. Private logs and execution
  receipts are retained alongside this file under `validation/`.
- Independent [transport review](REVIEW-TRANSPORT.md) and
  [quality review](REVIEW-QUALITY.md) have no unresolved findings. The changing
  code-getter redaction defect found during review was fixed before validation.

The change is ready for its PR/CI gate. No provider request or production action
was performed for this implementation. The earlier failed attempt is not
reclassified, W0 remains unverified, and this code does not create authority for
additional live scope.
