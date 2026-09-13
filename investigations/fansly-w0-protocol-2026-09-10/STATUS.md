# Fansly W0 — existing-session probe preparation

Current update, 13 September: Decision 321 records the owner's choice to reuse
Hub's existing encrypted Fansly REST session, with `lilly-1` as the first limited
probe candidate. It replaces the Management-only choice; historical Decision
288 and its offline implementation remain. [Exact approval and limits](OWNER-CHOICE-20260913.md).

Branch `feat/fansly-w0-protocol` integrates main `0a08365f` at `e250ebc8`.
A bounded probe and resource-limited launcher now reuse the existing REST
session through Hub's trusted runtime configuration and verified READ ONLY
snapshots. The initial exact-role restriction was an implementation mistake:
the owner's read_only rule concerns ordinary psql diagnostics, not every approved
runtime credential lookup. No privilege grant, role fallback or provider-token
export is introduced. The first bounded live probe completed below; no full
W0 gate is claimed. This remains
[W0 draft PR167](https://github.com/goslingmanagment/core/pull/167), not B0 readiness.

| Gate | Evidence and state |
|---|---|
| Safe offline capture diagnostics | Synthetic double-JSON auth, mixed/nested batch and unknown/malformed fixtures; bounded metadata-only exporter. Final validation and independent review below. |
| Existing REST session and page binding | Lilly-1: one 120-second connection with the existing REST session, type-1 received and generation unchanged. Account binding remains unverified; type-1 alone is not binding. |
| Fan-out | Unmeasured; no paired browser/receiver event corpus. |
| Presence | Unmeasured; no independent observer experiment. |
| Six-hour continuity and gaps | Not started; no live receiver or REST recovery receipts. |
| B0 readiness | Blocked by the preceding live gates. |

Only selected pseudonymized numeric business references appear in the report.
Unknown names are counts, arbitrary payload values never leave the parser, and
outbound/ambiguous or unrelated source records are excluded. This diagnostic
representation intentionally cannot replace a durable raw journal. The tool
does not assert current Fansly wire behavior or support for a business type.

Production activity for this update: one bounded permission read and one
authorized socket probe; no database writes or application deployment. Savings, delivery lag, session
compatibility and live coverage are not established by this W0 preparation.
The [runbook](../../docs/runbooks/fansly-ws-protocol-check.md) prepares local export
and the bounded, separately approved live evidence ladder.

## Validation completed 14 September, Moscow

- `pnpm check` passed: 3429 tests in 305 files, 9 existing skips; lint and build
  passed. Strictness remains at the inherited 1901 errors in 121 files, within
  the existing budget. This is not a zero-type-error claim.
- Serial Docker-Postgres passed 37 tests in five suites, with no skips. These
  cover credential decoding, consistent snapshots during rotation, actual
  runtime/read_only access and missing grants, page proxy failures, resolver behavior,
  and existing observation/erasure contracts. An attempted UPDATE fails with
  PostgreSQL 25006 even through the runtime/admin connection; snapshots remain unchanged.
- The transport cases use real local HTTP CONNECT and SOCKS5 proxies with TLS
  verification; success, refused proxy and untrusted certificates are covered.
  They do not connect to Fansly or prove production proxy compatibility.
- The separate Python launcher suite passed six mocked cases for resource limits,
  private input handling, deadline/cancellation and owned-container cleanup.
  The separate live run below also exercised the production image and launcher.
- Bundling passed. Running the bundle with invalid arguments exits 1 with empty
  stdout and a fixed sanitized error; it does not load a real credential.
- Independent static correctness and quality [review](REVIEW-SAME-TOKEN.md)
  has no unresolved code findings. The implementing agent ran the tests;
  the reviewer did not. Source hashes and completed execution receipts are in
  [validation.json](evidence/same-token-20260913T220004Z/validation.json).

The retained production permission read established that the diagnostic role
cannot select credentials/proxies. The corrected executable uses the existing
trusted runtime credential path with read-only transactions; that permission
read is historical evidence of the removed guard, not a current access blocker.

## First live probe: 13 September, 22:28–22:30 UTC

The [sanitized receipt](evidence/same-token-20260913T220004Z/live-receipt.json)
records Lilly-1 using the existing encrypted REST session and its page proxy:

- One connection, 120.065 seconds, stopped at the deadline; process exit 0.
- Type-1 received; nine frames retained, no metadata truncation or stderr.
- Credential/route generation matches before and after. That does not prove
  uninterrupted generation stability or actor/page binding.
- Zero REST requests, no reconnect and no business writer.
- Disposable container removal and temporary environment-file removal confirmed.
  API, worker and scheduler remained healthy on the same image after the run.

The image was `sha256:c443947a356972cd2833c10a4e728fe1890e92e76a77fc2328f00ebca0af5c85`.
The launcher used only the existing runtime DB/encryption configuration inside
its trusted host; no provider token entered CLI arguments, an environment export,
SSH output or retained diagnostic artifacts. No grants or credentials changed.

This establishes a short server/proxy connection receiving the expected type-1
shape with the selected existing session. Binding, paired fan-out, independent
presence, six-hour continuity and gap recovery still need evidence. B0/B1,
savings and event-to-reader latency are not established by these nine frames.

## Historical validation

Historical validation on 12 September, tested tree
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
Later changes in that merge were documentation and evidence only. That offline
tool needed no deployment. At that date the branch was not a production release
candidate: its main base did not include all membership changes in the observed
`31b73a96` release. This historical comparison does not describe today's runtime.

The [sample report](evidence/synthetic-report.json) was generated exclusively
from synthetic fixtures: four records, zero provider connections, unverified
binding. Its receipt times are fabricated fixture values; `generatedAt` is the
local export time. No real credential, message or identity was used.

The earlier main synchronization used `940ec69f` after PR168 took Decision 286.
Its numbering-only follow-up is retained in history. Live protocol evidence and
every production gate remain pending.
