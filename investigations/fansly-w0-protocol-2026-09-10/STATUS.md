# Fansly W0 — offline protocol preparation

Branch `feat/fansly-w0-protocol` now integrates main `c76c6db0` on 12 September.
W0 retains its reserved Decision 288; current main has no competing entry.
The synchronization changes the decision and execution documentation while
preserving the offline implementation. Local checks and serial PostgreSQL
integration tests pass on the combined tree. This remains [W0 draft PR167](
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

Validation on 12 September, tested tree
`e5c713d33c6fb485bed81036237c383e71b0f7fe`:

- `pnpm check`: 3291 tests passed in 298 files, 9 existing skips; strictness
  remains 1901 known errors in 121 files, lint and dashboard build pass.
- The new offline suites contain 33 cases. They cover nested auth exclusion,
  known/unknown/malformed batch children, secret-bearing endpoints and headers,
  correspondence/arbitrary field names, stable keyed references, invalid times,
  parser limits, private files, exclusive output, FIFO and bounded-heap failures.
- Serial real Docker-Postgres: `observations.repository` and
  `erasure-page-owned-tables` integration suites pass 10 tests in two files,
  zero skips, 5.03 seconds. These verify existing journal/erasure behavior;
  this offline-only change has no new DB path or B0 durability claim.
- Independent static review found FIFO blocking, late expanded-report size
  validation, and excessive newline splitting. All three were fixed, with
  bounded child-process fixtures for each. Final re-review found no actionable
  issues. The reviewers did not run tests. Independent quality and merge
  reviews are recorded in [REVIEW.md](REVIEW.md).
- All six W0 source/test files match `d80c91d2`; all 180 main migrations are
  unchanged. Conflict resolution preserves main's decisions and other stage
  rows. The W0 diff against main passes the whitespace check; a whitespace
  warning in an inherited C1 SQL artifact remains outside this stage.

Execution receipts and log hashes are in
[validation.json](evidence/main-sync-20260912T190433Z/validation.json).
Later changes in this merge are documentation and evidence only. This offline
tool needs no deployment. The branch is not a production release candidate:
main does not include all membership changes in the observed `31b73a96` release.

The [sample report](evidence/synthetic-report.json) was generated exclusively
from synthetic fixtures: four records, zero provider connections, unverified
binding. Its receipt times are fabricated fixture values; `generatedAt` is the
local export time. No real credential, message or identity was used.

The earlier main synchronization used `940ec69f` after PR168 took Decision 286.
Its numbering-only follow-up is retained in history. Live protocol evidence and
every production gate remain pending.
