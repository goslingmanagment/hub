# C1 natural completion and A0 follow-up — 12 September 2026

Lilly-2 request 2541 completed after its guarded restart. Generation 792
records two actual retirements; the following two incremental comparisons
match and request no work. The evidence supports keeping this repair path.
No follower policy or production state changed in this observation.

## C1 cohort and completion

The cumulative window is 11 September 01:05:57.089215 through 12 September
18:37:41.859814 UTC. Three repeatable READ ONLY snapshots contain 500, 500 and
396 records, with asOf 18:37:52.668583, 18:37:57.757882 and 18:38:01.737784 UTC.
All 1,396 run IDs are unique and ordered, the upper ID is pinned at 735231,
and pagination is exhausted. This is not one globally atomic snapshot.
Each manifest, body hash and read_only receipt was verified. Repeated aggregate
sections are used once; earlier cumulative snapshots are not added.

There are 250 valid incremental decisions: 201 no-request, 46 count-mismatch
only and three count-mismatch plus exhausted-without-known. The unchanged-head
branch is unobserved. All 49 requested decisions have a valid clean prior queue
and one subsequent successful terminal with exact-generation proof. Four other
terminals are scheduled work. Twenty-one partial incremental runs have no
settled decision, and one failed incremental run has no valid receipt.

The 76 chunks of request 2541 preserve the transition from generation 791 to
792. The former withheld deactivation after the captured pagination overlap.
Generation 792 finishes at 17:21:46.370 UTC in run 734771: source and generation
counts are 18,322, pre-UPDATE active count is 18,324, two rows are candidates,
and the actual UPDATE count is two. All protection buckets are zero.
Later runs 734821 and 735194 both report 18,322/18,322 and no request, with
one and zero processed rows respectively. These are later comparisons, not an
immediate active-after read or proof of which relations changed.

Lora-3 request 1524 completes in run 735021/generation 775 at 18:06:54 UTC.
It certifies 7,565 generation members and protects one absent active row under
generation grace; candidates and actual retirements are both zero. Its following
incremental comparison is not in this report. Three earlier terminal runs from
the missing-writer period, 733622/733859/734003, still have no actual-count
receipt. Their missing evidence remains unknown.

Follower HTTP cost is 5,969 attempts: 613 incremental, 5,000 anomaly-source
reconciliation and 356 scheduled reconciliation. There are 25 retry ordinals,
zero terminal-failed attempts and zero HTTP 429 attempts. All 1,396 runs have
known, non-boundary attempt accounting; payload size is unknown for 389 attempts.
These counts do not establish redundancy, savings or fresh-event latency.

## A0 evidence

The separate A0 report contains 512 sweeps: 276 complete and 236 incomplete.
All 87 newly selected sweeps are complete with zero unknown material checks.
The previous running Lilly-2 generation 6804 also completed; no other old
sweep changed. Four new generic state-change observations occur below the
virtual stop. The historical coverage gaps remain.

The [A0 observation](../../fansly-a0-deploy-2026-09-11/OBSERVATION-20260912T183741Z.md)
retains the per-page totals, scope and uncovered cases. A separate
[retained-metadata comparison](a0-case-comparison/REPORT.md) explains why the
four new generic counters remain unresolved by raw-to-raw comparison.

## Runtime and validation

At 18:38:38–18:38:40 UTC all three roles run `31b73a9691f3`, image
`9919567ca576…`, healthy with zero restarts. The worker started at
15:50:46.228186025 UTC. Compiled membership fields are present and migration
0185 matches its retained hash. This source preserves the owned restoration
release `64149b95`, whose standard deployment previously exited zero. The
deployment procedure for the intervening external release is not certified here.

The loopback API/database health read succeeded at 18:41:49 UTC. Disk has
21,540,020,224 bytes available (about 20.1 GiB). The current-container log window
15:50:46–18:37:41 contains 1,762 parsed JSON lines and no matching material-check
or diagnostic-persistence warnings. This does not cover removed containers.
The effective A0 allowlist was not reread; recent activity is not a config receipt.

Independent numerical review verified both cumulative exports and the C1
completion chain. No application source changed. The applicable C1 checks are
3,258 passing unit tests, nine existing skips and 86 serial Docker-Postgres tests;
observation analysis is separate from those implementation tests. PR166 remains
the one C1 draft. Presence equivalence, safe suppression, savings and event
latency remain open, as do A0's calendar and freshness gates.
