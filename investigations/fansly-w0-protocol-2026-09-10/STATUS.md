# Fansly W0 — offline protocol preparation

Branch `feat/fansly-w0-protocol`, based on main `f0a53aee` (Decision 285).
Decision 288 reserves the next slot after C1 draft PR166 / Decision 287; recheck
the numbering against main before merge. This is [W0 draft PR167](
https://github.com/goslingmanagment/core/pull/167), not B0 readiness.

| Gate | Evidence and state |
|---|---|
| Safe offline capture diagnostics | Synthetic double-JSON auth, mixed/nested batch and unknown/malformed fixtures; bounded metadata-only exporter. Final validation and independent review below. |
| Management Session and page binding | Unverified live; no session created or used. Type-1 label is not binding. |
| Fan-out | Unmeasured; no paired browser/receiver event corpus. |
| Presence | Unmeasured; no independent observer experiment. |
| Six-hour continuity and gaps | Not started; no live receiver or REST recovery receipts. |
| B0 readiness | Blocked by the preceding live gates. |

Only selected pseudonymized numeric business references appear in the report.
Unknown names are counts, arbitrary payload values never leave the parser, and
outbound/ambiguous or unrelated source records are excluded. This diagnostic
representation intentionally cannot replace a durable raw journal. The tool
does not assert current Fansly wire behavior or support for a business type.

Production reads/writes, provider requests and sockets for W0: zero. Savings,
delivery lag, session compatibility and live coverage are not measured.
The [runbook](../../docs/runbooks/fansly-ws-protocol-check.md) prepares local export
and the bounded, separately approved live evidence ladder.

Final validation:

- `pnpm check`: 3172 tests passed in 287 files, 9 existing skips; strictness
  remains 1908 known errors in 121 files, lint and dashboard build pass.
- The new offline suites contain 33 cases. They cover nested auth exclusion,
  known/unknown/malformed batch children, secret-bearing endpoints and headers,
  correspondence/arbitrary field names, stable keyed references, invalid times,
  parser limits, private files, exclusive output, FIFO and bounded-heap failures.
- Serial real Docker-Postgres: `observations.repository` and
  `erasure-page-owned-tables` integration suites pass 10 tests in two files,
  zero skips, 6.75 seconds. These verify existing journal/erasure behavior;
  this offline-only change has no new DB path or B0 durability claim.
- Independent static review found FIFO blocking, late expanded-report size
  validation, and excessive newline splitting. All three were fixed, with
  bounded child-process fixtures for each. Final re-review found no actionable
  issues. The reviewer did not run tests. `git diff --check` passes.

The [sample report](evidence/synthetic-report.json) was generated exclusively
from synthetic fixtures: four records, zero provider connections, unverified
binding. Its receipt times are fabricated fixture values; `generatedAt` is the
local export time. No real credential, message or identity was used.

Main PR168 took Decision 286. The branch now merges main `940ec69f`; W0
reserves 288 after C1 / 287. Only decision/runbook numbering changed; live
protocol evidence and every production gate remain pending.
