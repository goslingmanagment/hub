# Fansly B0 — current continuation pointer

2026-09-15. Stage: default-off capture receiver, Decision 343 / migration 0196.
Base includes #202 and #204 (origin/main 22a529589cf1). Live B0 remains off.

## Implementation / acceptance

- Dedicated page advisory-lock session; generation fences at open, guard and raw commit.
- Page resolver HTTP CONNECT/SOCKS5 only, independent dispatcher, bounded wire/queue,
  forced upgraded-socket teardown and live kill within 60 seconds.
- Atomic raw + pending decode receipts, UUID/ordinal dedup, offline metadata repair,
  unknown children/debt and explicit unknown gaps. No B0 business apply or hints.
- Source/contracts/SDK/registries and nested JSON erasure codec are aligned.
  Fan-scoped unknown-exclusive WS envelopes remain counted residuals; page/model
  erasure reaches raw, receipts and connection journal. See the runbook.
- Independent reviewer /root/b0_review approved final code after corrections for
  lake shared exclusion, group fences, transport assembly/upgrade-head bounds and
  isolation of startup/periodic decode replay. Reviewer did not run tests.

## Verification receipts (original attempts preserved alongside this file)

- check-3.log: pnpm check PASS, 3872 tests + 9 existing skips; lint/build pass;
  strictness ratchet unchanged at 1897 known errors / 120 debt files.
- pg-final.log: 54 PostgreSQL tests across six relevant suites PASS, including
  ownership death, generation change, raw atomicity, nested fan/group erasure,
  lake actual execution and existing erasure regressions.
- unit-final.log: 23 focused connection/transport tests PASS, including real TLS
  through both proxy transports, stalled peer close, no direct fallback,
  compression rejection, frame/fragment bounds, auth deadline and retry reset.
- pg-replay-isolation.log: 12 B0 PostgreSQL tests PASS after replay isolation; the actual worker retains
  two raw frames and pending debt through a failing receipt UPDATE, then observes live off.
- Earlier unsuccessful attempts remain in check-1.log and hub-b0-*.log: fixture
  grant assumptions, SQL array serialization, test assertions and registry/census
  omissions were corrected. They are not counted as passing checks. check-2.log
  passed before the final reviewer-requested replay-isolation correction.

## Production / live gates

Pre-deploy verified source 22a529589cf1, image
sha256:fad1c0385b36a352ceb0d4e5df9b27bc30b26b7919d3d38ccf65a345fe4d10b6.
All three roles healthy, restart count 0, 17 GiB free / 80% used. This closes the
handoff's old #202-not-deployed remainder; no rollback to the previous snapshot.

Deployment, PR/CI result and approved bounded W0 follow-up will be appended here.
W0 paired fan-out/presence and 6h/gap recovery remain unaccepted. Original binding
receipt is authoritative only for matching current generation; no invented TTL.
B1 requires seven accepted durable B0 days/event diversity after live activation.
A0 earliest seven-day read remains Sept 17 22:58:33.610 UTC. Existing monitor only.
Savings >=50% and event-to-reader p95/p99 have not been measured.
