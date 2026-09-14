Hub can reuse its existing encrypted Fansly REST session for a bounded W0 socket
probe, following the owner's session-choice amendment. This PR retains the safe
offline diagnostic exporter and adds the reviewed operator probe, page-proxied
transport, consistent read-only credential snapshots, isolated launcher and
a local paired-reference comparison tool.

The probe opens one fixed endpoint for at most 120 seconds, without reconnects,
REST requests, pacing writes or business writers. The token stays inside the
trusted runtime credential path. Reports retain bounded received metadata,
without credentials or correspondence. The disposable container has explicit
memory/CPU/PID limits and a host-side deadline with owned-container cleanup.

For paired observation, an optional private experiment-key file is used by both
export paths; each report contains its derived fingerprint. The launcher mounts
only a validated private copy and removes it after cleanup. The offline comparator
requires matching key fingerprints and overlapping declared windows. It reports
candidate entity matches, repeats, unmatched references, unknown/truncated frames,
and dropped or interrupted probe receipts. It never treats group IDs, entity
matches or empty input as proof of event identity, independent receivers or fan-out.

Decision 325 amends the historical Management-only choice in Decision 288.
The earlier unmerged D321 number was reconciled with current main D321–322;
D323–324 belong to the separate dashboard and CI-fixture follow-ups. The runbook records
execution, rollback and remaining gates. No runtime flag or migration is added.

Earlier validation of the paired-probe implementation (13 September UTC):

- pnpm check: PASS — 3462 tests in 308 files, 9 existing skips; lint and build pass.
  Strictness remains 1901 inherited errors in 121 files, within the existing budget.
- Serial Docker-Postgres: PASS — 37 tests across five suites, zero skips.
  Suites: fansly-probe-context, fansly-proxy-missing, egress-resolver,
  observations.repository and erasure-page-owned-tables (all integration tests).
  They verify credential decoding/generation snapshots, missing grants and proxies,
  and PostgreSQL rejecting a write even through the runtime/admin connection.
- Local real HTTP CONNECT/SOCKS5 and TLS fixtures verify proxy success/refusal,
  certificate rejection and no direct fallback. They never contact Fansly.
- Python launcher: PASS — ten mocked cases for limits, private inputs,
  cancellation, deadline and cleanup failures.
- Bundle build, sanitized invalid-argument execution and a synthetic comparison
  sample pass. The first live probe used its separately retained earlier bundle;
  the new paired-key option has not been run against the provider.
- Independent correctness/readability reviews have no unresolved findings.
  Reviewer scope and hashes are in REVIEW-SAME-TOKEN.md and the paired evidence
  packet's REVIEW-PAIRED.md. The comparator's omitted dropped-frame finding was
  fixed with a realistic retained-plus-dropped-frame regression. The implementing agent
  executed tests; reviewers independently inspected source and live artifacts.

The approved Lilly-1 probe ran 13 September 22:28:13–22:30:13 UTC using the existing
REST session and page proxy. One connection lasted 120.065 seconds, received one
type-1 response, five pongs and three service frames, then stopped at its deadline.
Before/after credential-route fingerprints match; zero REST requests were made.
Exit zero, container removal and temporary configuration removal are confirmed.
API, worker and scheduler stayed healthy on the unchanged production image.

The diagnostic implementation is ready for review. W0 stage acceptance remains
open: the short server/proxy connection received a type-1 frame.
Account binding, browser fan-out, presence, six-hour continuity and gap recovery
remain unverified.
B0/B1, business-event delivery, request savings and reader latency remain unproven.
No polling policy, credential, database privilege or application deployment changed.

Reproducible receipts and compressed original test logs are under
investigations/fansly-w0-protocol-2026-09-10/evidence/: the first live probe is in
same-token-20260913T220004Z; latest code validation and synthetic paired examples
are in paired-20260913T224848Z. Current status is in STATUS.md; the next bounded
live scope is prepared in NEXT-PAIRED-PROBE.md, with no paired live result claimed.

GitHub CI for the preceding short-probe commit ea0d6405 passed:
https://github.com/goslingmanagment/core/actions/runs/34787244295.
The new paired-preparation head has its own CI run.

Final audit follow-up, 14 September UTC: standard ESLint rules now reject bare,
aliased, property-based, dynamic and re-exported WebSocket constructors outside
the page-scoped egress service. Seventy-two real-parser cases cover prohibited
forms, the approved constructor, HTTP-only exceptions and preserved money/AI/
module restrictions. This is a source policy, not a JavaScript security sandbox.

The final composition integrates main `b78752d0` and has passed `pnpm check`:
3,588 unit tests in 313 files, nine existing skips; strictness, lint and build
passed. Five serial Docker-Postgres suites passed all 37 tests with no skips.
Tracked source hashes remained stable. `REVIEW-SOCKET-BOUNDARY.md` and
`REVIEW-FINAL-MAIN-MERGE.md` independently record no outstanding findings.
Exact commands, compressed logs and fingerprints are retained in
`evidence/final-main-validation-20260914/`.

This follow-up ran no new live probe or production operation. The paired live
scope, binding, fan-out, presence and six-hour continuity remain unverified;
merging diagnostic code does not pass W0 or permit B0/B1.

Current-main follow-up integrates `a9794e60`. The prior local validation
certifies the unchanged topic source (`1aa0d862`); the sole incoming executable/test
change is main's verified UTC fixture. Independent `REVIEW-MAIN-A979.md`
confirms source, decision and evidence preservation. Local suites were not
repeated for this composition; fresh PR CI validates the full merge.
