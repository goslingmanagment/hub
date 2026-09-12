# Fansly C1 — follower reconciliation diagnostics

Latest: [first full receipts after restoration](OBSERVATION-20260912T155000Z.md).
Lora-1 actually retired one row; Lilly-2 protected two absent rows under
generation grace and retired none. The 65-run report pairs both clean-queue
requests with exact-generation completion; 299 physical attempts all succeeded.
Trigger suppression and savings remain unproven. The
[presence inventory](PRESENCE-CONSUMERS-20260912.md) identifies Workboard urgency
and other consumers that a policy change must preserve.

At 15:52 UTC all three roles were healthy on `31b73a96`, which preserves the
[restored diagnostics](RESTORED-MEMBERSHIP-20260912.md) from `64149b95`.
The new worker started after the measured cutoff. The three earlier terminal
runs without actual-retirement receipts remain unknown. No C1 policy changed.

Historical 12:30 state: [first natural membership receipt](NATURAL-MEMBERSHIP-20260912.md),
following the [membership refinement](MEMBERSHIP-DIAGNOSTICS-20260912.md).
The reviewed change is deployed in release `7aaa3185`, preserving production
`02ff` and all 180 old migrations. The release passed 3258 unit tests (nine
existing skips), 176 serial Docker-Postgres tests and both independent reviews.
The standard deployment exited 0 with an executed protected-health HTTP 200;
all three roles, compiled hashes, restricted reader and pinned CLI were verified.
The later post-start report through 12:30 UTC has nine follower runs and one
valid Lilly-1 receipt: one candidate and one actual retirement in generation
687. The next incremental comparison is pending; active-after was not measured.
All 41 requests in the earlier cumulative window completed; redundancy remains
unproven. The older observations below retain their original cutoffs and gates.

[PR166](https://github.com/goslingmanagment/core/pull/166) remains the single C1
draft. It now includes a bounded run timeline needed to establish the cause
before a narrow policy fix. Branch `feat/fansly-c1-followers` now includes main `c0cd21c3` (PR172).
C1 is Decision 294; the original draft used 291. Applied migrations 0182–0183
retain their original names and contents.
No follower predicate, cadence, presence writer or provider request changed.

## What is ready

The original report counts all three OR predicates, including no request, and
atomically captured prior queue sequences. The new timeline exposes the
individual receipts and both follower streams, with all run outcomes. It keeps
claimed revisions separate from membership generations and successful
non-destructive close separate from membership certification. Decision and
queue validity are independent; malformed or missing evidence stays unknown.

The reader accepts at most eight days and 500 runs per page. A pinned upper ID
excludes later inserts, but does not freeze mutable run outcomes. Only selected
scalars, bounded timestamps and named membership proofs are exported; fan IDs,
message bodies, headers, arbitrary errors and lease tokens remain private.
See the [runbook](../../docs/runbooks/fansly-followers-diagnostics.md).

## Historical C1 validation on `13537b6b`

- `pnpm check`: 3,210 tests passed in 292 files, nine existing skips; strictness
  was 1,908 known errors in 121 files. Lint and dashboard build passed.
- Serial real Docker-Postgres: 70 tests in five files, zero skips, 19.77 seconds.
  Suites: followers-timeline, followers-diagnostics, generation-high-water,
  page-sync-lease-fencing and sync (all `.integration.test.ts`).
- The timeline checks real handler receipts; partial, failed, skipped and
  non-destructive completion; pinned pagination; exclusive boundaries; late,
  duplicate and malformed receipts; restricted-role permissions; private-data
  exclusion and invalid query bounds. Existing queue, lease, generation and
  presence tests passed.
- Independent review identified an absent queue-validity marker. It was added
  with seven malformed-queue fixtures. Final review is recorded in REVIEW.md.
- A separate code-quality review found two test defects: dependent guard
  combinations and a calendar-sensitive window. Both are fixed, along with
  typed fixture inputs and explicit handler/reader coverage boundaries. The
  final re-review has no actionable findings. The five added cases independently
  protect the original predicates; all eight OR combinations remain covered.

No new runtime module or flag is needed for this addition. Local test logs are retained
as evidence; they do not establish production latency or query-plan performance.
The quality follow-up changes tests and review documentation only. Production
code and applied migrations are unchanged. Its validation receipt is retained
in [quality evidence](evidence/quality-20260911/validation.json).
The subsequent [grace regression](evidence/grace-20260911/validation.json)
confirms that one absent row survives the first repository finalization and
is retired after the next generation also misses it. Independent review found
no actionable issues; handler certification and future trigger suppression
remain separate test obligations.

## Production evidence and next gate

The owner approved diagnostic source `d47dc9b09f87988a53bd80435f0d11534beba15c`
on 11 September. Its worker started at 01:05:57.089214971 UTC. The production
base was already `32478124`, including C2a/C2b code; their replay/repair and
shadow acceptance remain unverified. No parser bump or flag change was added.

The standard deploy exited 1 at 01:33:29 UTC. Five protected sync-health
attempts exceeded 150 seconds; the last owned SSH read stalled for over ten
minutes and was terminated locally after a fresh status read succeeded.
Automatic rollback was skipped by the existing schema-change guard. This is
an open deployment gate; its cause and pre-deploy latency are unmeasured.

At 01:34–01:35 UTC all three roles still ran source `d47dc9b09f87`, image
`c8a5567e229b…`, healthy with zero restarts and 25 GiB free. API/database
health was OK. The local CLI was pinned to that source and its capabilities
contract verified. A separate loopback read verified dashboard HTML; both
deploy locks were absent. These checks do not override the failed sync gate.

Both C1 functions execute as `read_only` in READ ONLY; the underlying telemetry
and queue tables remain inaccessible. Migrations **0182–0183 are applied**:
do not edit or renumber them when main advances. Further SQL changes require
a new forward migration.

The cumulative report for 01:05:57.089215–01:21:45.993638 UTC contains one
completed lora-3 incremental run and one valid no-request receipt. Active and
source counts both equal 7,551, with zero processed rows before the known
checkpoint; all three OR predicates are false. Its two follower-stream HTTP
attempts succeeded. The other five pages and full reconciliations have no run
in this short interval. Queue state and request/completion pairing are not
established by a no-request receipt. The verified report SHA-256 is
`d278bb130be2b6ba6831a5fd22eabe209a43ea0cb2266b92423d5c01a4c3f1f4`.
The initial report and its interpretation were independently reviewed.

The verified T0 export for 1–6 September contains 20,881 follower-reconcile
physical attempts: 19,420 anomaly-source and 1,461 scheduled-source. Ordinary
followers added 3,079 attempts. These retained counts include retries and are
not complete telemetry; neither the anomaly label nor its frequency establishes
redundancy. [Per-page/source totals](evidence/t0-followers.json) retain the
baseline hash. Branch frequencies across the fleet and completed-generation
consolidation remain unmeasured.

The later [RCA snapshot](RCA-2026-09-11.md), ending 02:53:01 UTC, contains 11
valid decisions across all six pages: nine no-request and two Lilly-2 count
mismatches. Both requested a new revision from a clean queue. Revision 2530 /
generation 780 completed 184 pages in 54m43s using 206 physical attempts;
2531 / 781 remains partial in that snapshot. The existing absence grace can
make the second traversal necessary. Suppression is not justified by these
receipts, and physical savings remain unmeasured.

The follow-up through 05:07:39 UTC records generation 781's completion with
one deactivation candidate and two later 18,324/18,324 no-request decisions.
The second walk used 193 attempts in 35m41.620s; its actual retired row is not
exported. Across six pages there are now 25 valid decisions, five count-mismatch
requests and four completed generations. None establishes redundant work.
Lora-2 revision 1614/generation 1576 remains partial in this snapshot.

The same worker restarted once at 03:08 after a pg-boss pool checkout timeout;
the underlying reason is unknown. At 05:06 it was healthy on the same image.
A0 coverage remains degraded: 49 of 69 sweeps incomplete and 85,915 unknown
material observations. The separate planner-only exception is still pending;
this heartbeat did not execute EXPLAIN or change production.

The [11:08 follow-up](OBSERVATION-20260911T110856Z.md) now contains 61 valid
decisions: 50 no-request and 11 clean-queue count mismatches. Lora-2's two
generations completed with zero then one candidate, followed by matching counts
and no request. Lora-3 has another such pair and a later mismatch while its
provider headline changes. Lilly-2's new revision 2532 is scheduled work,
separate from those 11 requests. Suppression remains unjustified.

The [17:07 follow-up](OBSERVATION-20260911T170708Z.md) records Lora-3/1520's
completion in generation 771 after generation 770 failed membership proof.
The whole revision used 156 attempts in 50m27.337s, then six decisions matched
without another request. There are now 97 valid decisions and 13 clean-queue
requests; one failed incremental run has an unknown decision. Lora-1/1250 has
also retried after a changing provider headline and remains partial.

The owner-approved [17:35 EXPLAIN](HEALTH-PLAN-20260911T173528Z.md) completed.
The selected plan includes historical attempt and completed-run sorts; estimated
costs do not establish runtime attribution. The one-use exception is consumed.
Physical-attempt rewrites were rejected on local failure-heavy regressions.
The separate [health PR172](https://github.com/goslingmanagment/core/pull/172)
selects completed IDs before loading payload: local four-scenario medians improve
19.6–23.2%, with identical output. Both independent reviews and local checks pass;
PR172 merged as `c0cd21c3` after all five GitHub CI checks passed. The combined C1
tree passed `pnpm check` (3251 tests, nine existing skips), 81 serial
Docker-Postgres tests across seven suites, production build and contract
regeneration without drift. The [release candidate](HEALTH-RELEASE-CANDIDATE.md)
also includes main's PR171 Overview/API changes. It preserves all 179 deployed
migration files. Both independent integration reviews passed after the release
status and historical validation labels were corrected. C1 follower policy and
the production gate remain unchanged; deployment requires separate approval.

Next: follow Lora-1 revision 1250/generation 1206 and subsequent counts. Retain
the other OR branches as unobserved and diagnose protected health within current
read-only privileges. No new worker restart was observed at 17:06. A0's new
66-sweep cohort has zero complete sweeps, 63 incomplete and three running.
The seven-day date alone cannot pass acceptance.
The drift/blast-radius guards and presence consumers remain exit criteria.
A0 keeps its original seven-day window with this runtime boundary recorded.
Further production changes, A1, live sockets and C2b enablement remain gated.
Operational logs, raw reports and manifests are retained locally under
`investigations/fansly-c1-deploy-2026-09-11/` in the main checkout.
