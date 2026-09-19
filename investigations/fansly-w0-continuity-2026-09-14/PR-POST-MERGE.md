The 120-second probe cannot collect the required six-hour continuity and receiver-gap evidence. Add an explicit operator-only Lilly-1 runner with one six-hour connection, then two bounded connections after 30-second and 240-second receiver-only gaps. The short probe keeps its CLI/duration/report shape; both launchers share page admission and verified container-ID cleanup.

A shared observer streams bounded sanitized metadata, checks credential/route generations without new dispatchers, and stops on cancellation, transport/auth failure, changed generation, output failure or lost cleanup proof. t=1 is an observed marker; binding, fan-out, independent presence and external REST recovery remain unverified. No additional REST requests, runtime flag, polling change, business writer or B0 acceptance is introduced. D334 and the operator runbook document scope and rollback.

Validation after rebasing onto main 4d9cac4a (PR194), with the W0 source patch unchanged:

- pnpm check: PASS — 3,776 tests, 9 existing skips; typecheck, lint and dashboard build passed.
- Python launcher suites on unchanged launcher code: PASS — 18 tests covering shared host ownership, immutable-ID cleanup, cancellation/gaps and incomplete receipts.
- Serial Docker-Postgres/real-proxy batch: PASS — 49 tests across fansly-probe-context.integration.test.ts, fansly-probe-transport.test.ts, fansly-dm-material-probe.integration.test.ts and incoming main's follower-outreach.integration.test.ts.
- Both operator bundles build for node22 and pass local syntax checks; no provider execution.
- Independent review: P1 Docker stdout fsync bug fixed. An actual piped-child regression passes and the old fsync behavior reproduces EINVAL. No findings remain in source review.

The initial stale Python test import failure and the earlier checks that missed the fsync defect are retained alongside final results. Commands, logs, source hashes and review are in investigations/fansly-w0-continuity-2026-09-14. Live binding/presence/gap recovery and savings/latency have not been measured by this PR.


Merged as `3baee9db69a479e470b9ed6da7af079b456af6c3`; its tree equals the reviewed head. All five required CI checks passed. The private continuity bundle built from the merged tree passes the Node syntax check. Read-only production preflight found Python 3.12.3 and no W0 receiver. No live experiment has started: the Lilly-1 working browser/proxy remains unverified and the Mac is locked. Binding, fan-out, presence, continuity and recovery remain pending; no savings or reader latency is claimed.
