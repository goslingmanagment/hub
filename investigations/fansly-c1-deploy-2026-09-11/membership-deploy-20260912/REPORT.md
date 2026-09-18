# C1 membership diagnostics deployed — 12 September 2026

Release `7aaa3185757e6a89d1b7427b0d54aa8720c74da4` preserves production 02ff
and adds PR166's reviewed C1 delta, `97fcbd03`. The owner authorized deployments.
The standard dist-only deployment ran 12:08:55–12:11:44 UTC and exited 0.
Protected sync-health actually returned HTTP 200: one logged request took
4714.768 ms. This is one endpoint request, not SQL latency, a percentile,
event-to-reader latency or an attributed C1 performance improvement.

API, worker and scheduler were independently verified healthy with zero
restarts on image `sha256:24ae357d7a5a9efbee3b04ecc895669ac293438166a1403950418a37b0b62805`.
The worker started at 12:11:06.271182593 UTC. Six compiled hashes and migration
0185's file hash match the local validated build. The restricted function has
its new membership fields and executes as read_only in a READ ONLY transaction.
The production-pinned CLI source, installed link and capabilities passed.
Dashboard delivery and standard health gates passed. No flag, recovery, replay,
socket, A1 action or image GC was performed.

## What was verified

- C1 source: 3251 unit tests passed, nine existing skips; 84 real Postgres tests
  passed with zero skips. Both independent code reviews closed all findings.
- Exact combined release: 3258 unit tests passed, nine existing skips; 176 real
  Postgres tests across 11 serial suites passed with zero skips. Production
  build passed. Both independent union/release reviews closed their findings.
- All 180 previously deployed migrations are byte-identical, including 0182–0184.
  Forward 0185 only updates the restricted diagnostic reader. No destructive
  policy or provider request was added. Tests prove disjoint protection,
  timestamp boundaries, receipt loss/validation and actual guarded UPDATE counts.
- PR166 CI on 97fcbd03 passed all five jobs. Those jobs cover the C1 PR head;
  combined 7aaa validation is the separately recorded local validation above.

## First observation and remaining work

The separate repeatable READ ONLY export covers
12:11:06.271182593–12:14:16.851636 UTC. It contains zero follower runs and no
membership receipt yet; pagination is exhausted. This successful empty read
proves reader availability, not a production reconciliation or no missing work.
Do not add this interval to the older cumulative snapshots.

Observe the first natural full-walk completion and subsequent incremental
comparison. C1 still needs evidence before changing its trigger policy. The
last cumulative observation had 41 clean-queue requests, all completed, and no
proven redundancy. Physical savings and fresh-event latency are unmeasured.
A0 retains its original clock and this new runtime boundary; its completed
counterexamples and coverage limits remain unresolved. The earliest seven-day
point is 18 September 01:58:33.610 Moscow, not automatic acceptance.

Rollback retains the previous 02ff image and applied 0185. The standard script's
schema-change guard would skip automatic rollback after this migration; no
rollback was needed. Raw evidence and the old release remain available.
