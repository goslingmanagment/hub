# Hub performance regression release — 2026-09-12

Status: all eleven implementations independently approved and pushed. Deployment completed at 20:05 UTC; independent health, migration, logging and performance observations completed. See PERFORMANCE.md for the measured outcome and limits.

The owner authorized one author per problem, a different reviewer, separate
commits, push and production deployment after verification. All release work is
isolated in `/Users/dmitriy/code/goose/.worktrees/hub-performance-fixes-20260912`
on `fix/performance-regressions-20260912`. The original checkout's pre-existing
changes are excluded.

## Preserved production base

The release starts from actual deployed revision
`31b73a9691f32f8c33c3fe479bca68533c7048d6`, preserving already deployed changes
absent from `origin/main` (`c76c6db06ce1c25e469ca07ec62762e248870f44`). The
final predeploy refresh reconfirmed that revision on API, worker and scheduler,
all healthy, migration 0185, and 21.55 GB free on the root filesystem. The
predeploy deadlock counter was 33 at 19:29:25 UTC. These are time-specific
baselines for the postdeployment comparison.

## Individual fixes

| Problem | Commit | Evidence and scope |
| --- | --- | --- |
| PostgreSQL bind values in logs | `77f1fed0` | Independent approval, 39 tests and real PostgreSQL positive/negative logging controls. Both parameter logging settings pinned to zero; slow SQL/durations retained. |
| Alias deadlock after conditional fan writes | `62e87c61` | Independent approval, concurrent PostgreSQL scenarios; old writer reproduces 40P01 in both lock-order cases. No-op suppression preserved. |
| Unbounded recent metric scans | `f33946aa` | Independent approval, 59 tests, populated migration/re-run. Synthetic 1M-row query: about 89–96 ms / 1M tuples to 0.48–0.61 ms / 620 tuples. Only new migration: 0186. |
| Follower count unused by seeded states | `2ea98edf` | Independent approval, 28 tests. Old writer fails five no-read cases while recovery behavior still passes. |
| Repeated earnings parsing | `a86ac13e` | Independent approval, 63 tests. Six repeated-work failures on the old implementation; money, diagnostic, replay and dedup behavior retained. |
| Concurrent cleanup overwrites worker finalization | `cfa4c602` | Independent approval, 12 real lock-order/rollback cases and existing suites. Old cleanup loses eight terminal results; final targeted gate 14/14. |
| New physical HTTP attempts after observed lease loss | `c1e0b15e` | Independent approval, combined sync/lease/retry/collection/outbox gate 172/172. Existing in-flight responses remain capturable; cancellation begins after heartbeat observation. |
| Excess catalog round trips for pending webhook payloads | `bdbb981c` | Final independent approval; 69 tests passed. Real governed-erasure counterexample fails on rejected broad prefetch and passes on baseline/final scope. Synthetic 4,000-row unmapped pointer corpus: 4,000 to 500 catalog reads, 1,379 ms to 467/414 ms; parser calls, outcomes and cursors identical. |
| Conversation preview queries unrelated monitor streams | `ce4fb415` | Independent approval; 38 tests passed; 17 to 2 requested streams across five SQL inputs. DM coverage, historical physical debt and global queue-sibling context preserved. Page totals remain. |
| Overlapping unparsed/replay passes | `96a86c1f` | Final independent approval; 52 tests and actual-driver throughput controls. Disjoint passes borrow unused quota once after reserved work, preserving four useful stamps and avoiding repeated poison visits. |
| Incorrect DM shadow timeout explanation | `4ff73c55` | Independent approval; Comment-only causal correction. Runtime behavior, 5 s material timeout and 500 ms report timeout remain unchanged. |

## Rejected designs, review blockers and limits

The initial persistent binding-wait hint cache is withdrawn. Independent review
found a deep-page prefix rescan and an unrealistic applicability assumption.
Its migration 0187 and all runtime cache code were removed before any commit.
Evidence is retained in `rejected-binding-wait/` and the original review. The
replacement uses fresh batches of at most eight pointer-only bodies, deferring
bodies above 512 KiB to the existing single-row path. No cache state or migration
remains. Decoded heap overhead is additional to the logical JSON byte bound.

Independent review additionally blocked the broad webhook batching candidate:
prefetching a mapped row extends its body-read-to-append race across intervening
erasure. The revised scope must prefetch only provably unmapped non-export rows
that cannot append facts in the current run; mapped rows keep ordinary reads.
The earlier 67-test run and broad-prefetch benchmark are retained only as
receipts for that superseded candidate. The final 69-test gate, actual
governed-erasure negative control and unmapped benchmark in the table above
close that blocker.

Independent review blocked the first disjoint replay patch because capture-only
useful throughput could halve when replay had no positive-version debt. It needs
bounded borrowing of unused quota without revisiting a wrapped poison prefix.
Its initial 24 passing tests did not cover that performance regression. Final bounded borrowing passes 52 targeted tests and restores useful capture-only capacity; an additional independent combined-driver review approves the integration.

The old DM shadow statement that a 500 ms timeout forced a full provider sweep
was causally wrong: the virtual stop is diagnostic and normal traversal already
continues. Raising that timeout does not establish provider request savings.

Local benchmarks establish query/work reductions for their documented fixtures,
not a production CPU forecast. Bounded production samples of pending canonical
webhooks show pointer-only rows at the oldest prefix and inline rows at the newest
tail; neither sample is a census. Unmapped visit counts are not unique-row counts.

## Validation and deployment receipts

Baseline `pnpm check`: 307 files; 3,418 passed, 9 skipped. The strictness ratchet
allows 1,897 pre-existing errors across 120 files; this is not a clean TypeScript
compilation. The combined typecheck keeps that same debt. Final-gate fixture corrections add explicit failure guards in the sync-race tests and replace four literal regex spaces with `{4}`; independent review confirms unchanged concurrency and logging assertions. These corrections were folded into their original problem commits; the final tree is identical before/after history cleanup. The exact two additional platform-comparison sites are documented and independently approved (155 to 157), without changing the counting rules or TypeScript allowance. Final `pnpm check` passes: 310 files, 3,464 tests passed, 9 baseline skips. Full prerequisites pass: 200 DB/schema/network files, 2,135 tests; 27 selected critical API tests passed (77 noncritical API cases excluded by the repository gate). Production build passes. The pushed release head is `96a86c1fcdde841b781c9bf9ea4218419900e8ff`. Deployment completed successfully at 20:05 UTC. API, worker and scheduler independently verified healthy on 96a86c1fcdde, with zero restarts; sync health 200 and production-pinned CLI rebuilt.

Target: `root@45.8.230.111`, `/opt/agency-hub`, normal deployment script. No
configuration flags are being changed. No image garbage collection is requested.
Production SQL diagnostics use the `read_only` role exclusively.

Detailed receipts live beside this report; `status.json` is the restartable board.


The narrow batching fix preserves the original individual mapped-read boundary.
It does not claim to fix the pre-existing per-row body-read-to-append erasure
window; no new mapped-row prefetch interval is introduced.


## Deployment transport recovery

The original upload was slow on the Mac VPN route (about 83 KB/s). Before any
service stop, the transfer was cancelled after independent review; the deploy
script released both locks, and API, worker and scheduler remained healthy on
the old revision. The unchanged script was restarted with a task-local SSH
ProxyJump through the owner's `winpc`; no repository or global SSH/VPN settings
changed, and agent forwarding is explicitly disabled. Runtime manifest, image
config, RootFS and labels match the original verified image exactly.

The cancelled VPN connection left its remote `docker load` alive. Its exact TCP
connection, sshd parent and CLI child were verified before terminating only that
old upload. The new upload resumed immediately; about 132 MB had arrived by
20:01:19 UTC. The remaining original SSH session was closed as cleanup, without
signalling the new uploader, Docker daemon or application containers.

Receipts: `transfer-review.md`, `transfer-route-probe.json`,
`transfer-cancel-receipt.json`, `orphaned-upload-cleanup.json`,
`orphaned-ssh-cleanup.json`, `retry-built-image-equivalence.json`.
The active deployment log is `deployment-via-winpc.log`.

## Final production verification

At 20:20 UTC, all three runtime services were healthy on `96a86c1fcdde`,
with zero restarts. Migration 0186 is applied and its 199,892,992-byte index
is ready/valid. Both PostgreSQL bind logging settings are zero from command-line
configuration; the synthetic slow read-only canary retains SQL duration/template
while suppressing its parameter. The new metrics API returned 2670 samples
across 89 series, each bounded to 30, with median 35.953 ms across five warm requests.
Direct EXPLAIN is unavailable to read_only for this table; it was not bypassed.
Disk free: 20,446,846,976 bytes. Deadlock counter remains 33. Runtime logs have
no error/fatal; the sole PostgreSQL error was the diagnostic permission denial.
The startup 8.824-second metrics record is the concurrent index DDL.

The full six-minute sampler completed. The previously selected clean five-minute
window used 0.534 CPU cores for the four services; the old start-inclusive
45-minute estimate is about 0.443 cores. Workload and timing differ, so overall
CPU savings are not established. Canonical mean duration is 12.762 seconds
versus the old 12.149 seconds, with more stamped observations and a large event
burst. See PERFORMANCE.md and performance-results-review.md.

Deploy locks and orphaned transfer processes are gone. The remote release branch
head matches the deployed commit, and the release worktree remains clean.
