# Independent PR193 release and material-cost evidence review

Reviewer: `/root/review_w0_runner`. This review used retained local Git objects,
release receipts, SQL and raw outputs. It ran no tests, production commands or
provider requests. **No actionable mismatch in release or measurement claims.**

## Release identity and operating state

The reviewed PR head `3446cbd3b8a228b01a6395123a74ba37c201894f` and merged main
`e73513737e19b01bd74a4bfbfc6eeed1ffe56d69` have the identical tree
`6a6620d2187a195b07fc04ec98d2eb3e003b0aa0`. Exact-head CI run 34860432177 passed
Static, all three Integration shards and Quality Gate. Its publication job was
skipped on the PR; it is not presented as the deployed image.

Deployment execution and log hashes verify: the standard dist-only/apps/no-GC
command exited zero at 15:27:40.927 UTC. The log verifies the pinned clean full
base/dependency checksum, service and protected sync health, same-origin dashboard
and the locally updated production-pinned CLI. Runtime raw rows match runtime.json:
all three application roles use `e73513737e19` and image
`sha256:349c03e7a7e73c603564f6e22cc86d38dcab598d47081dd95505cbebfc92268f`,
healthy with zero restarts. PostgreSQL's pre/post runtime receipt is unchanged.

All 187 previous migration records, including timestamps, are unchanged.
The only new record is 0192 at `2026-09-14T15:27:01.755208+00:00`.
The post-read identity is read_only / READ ONLY, function EXECUTE is true and
page_dm_messages SELECT remains false. The retained SQL requests REPEATABLE READ
and the stated timeouts; this is an additive read operation, not a table grant.
Disk receipt: 17,512,036 KiB available, 79% used. Ordinary DB health's 1 ms is a
separate health probe and is not treated as material-query or reader latency.

The authenticated configuration receipt generated at 15:29:13.657 UTC reports
the expected three values on all three new active instances: A0 six-page v1,
earnings shadow Lilly-1 v1 and catch-up none v4. It explicitly leaves per-role
applied versions and historical continuity unproved. No flag save is recorded.

## Measurement checks

Verified 28 pre/post/measurement stdout/stderr hashes, every per-page execution
receipt against the summary, and all six raw identity/sample/plan pairs. Each
call uses read_only, READ ONLY / REPEATABLE READ, 5 s statement and 100 ms lock
timeouts set before its one fixed function call. There are six distinct page
calls with no failure/retry, 100 distinct nonempty stored-head samples each,
and no unmeasured page. Total local elapsed time is 11,199.434 ms.

| Page | Heads | Planning ms | Execution ms | Root hit/read blocks |
| --- | ---: | ---: | ---: | ---: |
| ari-1 | 100 | 1.214 | 30.766 | 557 / 13 |
| lilly-1 | 100 | 1.243 | 49.562 | 514 / 58 |
| lilly-2 | 100 | 1.299 | 33.891 | 563 / 9 |
| lora-1 | 100 | 1.544 | 48.968 | 506 / 66 |
| lora-2 | 100 | 1.231 | 8.618 | 569 / 2 |
| lora-3 | 100 | 1.698 | 53.857 | 524 / 47 |

The timing and block numbers exactly match the top-level EXPLAIN result/root
Plan. All six plans use indexed page_dm_messages lookups and one sequential
scan of fansly_dm_head_debt; the retained plans show 13,519 debt rows and 100
message lookup loops. This describes the observed data size and access path,
not a scaling guarantee or a reason to change indexes after one snapshot.
Per-node Actual Rows is averaged/rounded across loops and cannot establish
that all 100 message heads were present.

The report correctly limits 8.618–53.857 ms to six current-stored-head SQL
observations. Sample selection can warm buffers; EXPLAIN adds instrumentation;
runtime pool/queue waits, report writes and reader publication are excluded.
No percentile, historical timeout explanation, hot/archive/reader completeness,
50% HTTP savings or event-to-reader latency is established. The 600 selected
head IDs are sample membership, not 600 confirmed accessible messages.

## Local runtime aliases

At the coordinator's request, this agent also updated only the four active local
A0/C1/C2b state files to the new runtime/config evidence. Exact pre-edit bytes
are retained as `state-before-release-193-0.json` through `-3.json`.
`state-alias-changes.json` records their hashes, after hashes and changed fields.
Every unlisted top-level value is identical; previous runtime-boundary arrays
remain exact prefixes, with one new release boundary appended. Observation
clocks, snapshot pointers, counts, pending gates and historical activation
revisions were not changed. The completed Ari/Lilly-2 canary states were not
edited. This paragraph records author verification of those local alias edits;
it does not represent a second independent review of this agent's own edits.

`review-data.json` retains the mechanical raw-hash, migration, runtime and plan
comparison results. REPORT.md and summary.json accurately preserve the remaining
measurement and acceptance limits; their pending review status may now be closed.
