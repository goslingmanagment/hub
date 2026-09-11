# Fansly C1 diagnostic runbook

Authority: the accepted events plan §4/§6 and Decision 291. This is the
diagnostic portion of one C1 draft PR. Production cause counts and the narrow
policy fix remain pending. There is no new flag, cooldown or cadence change.

## What is recorded

One note follows each settled incremental followers decision. It names the
three existing OR branches: active/headline count mismatch, provider exhaustion
without the known checkpoint, and an unchanged newest checkpoint with processed
rows. Counts and boundary booleans retain context without fan IDs or raw bodies.
The no-request case is recorded too. Telemetry failure leaves the walk and
queue unchanged; its missing receipt is unknown in the report.

An opt-in queue receipt carries the previous request/applied sequence from the
same locked row that increments the request. No extra DB read is needed.
`requests_with_pending_work` means the prior request sequence exceeded the
applied sequence at that instant. Divide by known queue receipts only, show
unknown receipts alongside it, and label this **pending at request time**.
It does not prove how many eventual reconcile generations absorbed those
requests. Pair it with the completed-run timeline before claiming coalescing
savings or choosing a cooldown.

Initial state seeding is a different path: missing/old lastFollowerSyncAt or a
headline/active mismatch can seed recovery. These notes cover the incremental
trigger only. Seed/recovery, manual and scheduled reconcile costs must remain
separate in the timeline and T0 report. Headline/active semantics, deleted
accounts and pagination still need a measured RCA.

## Read and retain

Deploy only an explicitly approved reviewed revision. Verify the running source
before choosing its rollback. At 11 September 00:33 UTC, all three production
roles already ran main `32478124`, which includes C2a/C2b and the v2 readers.
The C1 delta adds diagnostics only; it does not bump the earnings parser again.
This observation does not establish that C2a replay or projection repair finished.
A deployment from an older pre-C2a base must still follow the reader-before-worker
and compatible rollback procedure in the C2a runbook.

After the read operation is deployed, use psql as read_only inside READ ONLY.
Choose an actual bounded interval (at most eight days) and retain the output:

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '20s';
SELECT fansly_followers_diagnostic_report(:'window_start', :'window_end');
SELECT fansly_events_measurement_report(:'window_start', :'window_end');
COMMIT;
```

The cohort is runs started within the interval. Only notes emitted within the
interval are included. `coverage` retains current run outcomes and identifies
unfinished/boundary runs, missing, duplicate and invalid decisions. `decisions`
contains the complete OR combinations, including no-request; adding the three
branch counts double-counts overlaps. `queue` has its own known/unknown bounds.
A missing or empty report is not evidence of zero triggers. T0 counts physical
attempts separately; diagnostic notes are neither provider attempts nor full
reconcile completions. Keep manifests and raw report files outside telemetry
retention, with exact intervals, revision and capture time.

## Reconcile timeline

The companion read operation exposes bounded existing run/decision scalars:

```sql
SELECT fansly_followers_diagnostic_timeline(
  :'window_start', :'window_end', 0, NULL, 500
);
```

Keep `throughRunId` from the first response and pass `nextRunId` as the next
`after_run_id`; stop when `nextRunId` is null. The upper ID fixes new run
inserts only. Outcomes and stats can still change. Use one REPEATABLE READ,
READ ONLY transaction for an atomic export, or retain each page's `asOf` and
repeat unfinished runs. Exhausted pagination does not prove complete telemetry.

The timeline contains both followers streams and every outcome. Its
`decision_valid` checks the schema and OR combination; `queue_valid` separately
checks integral, ordered request/applied sequences. Do not attribute malformed,
missing or duplicate receipts. `counts` and checkpoint scalars are contextual
observations, not independently certified provider totals. Free text, bodies,
fan IDs and lease tokens are excluded.

`request_seq` and `leased_seq` both describe the claimed revision, not separate
queue snapshots. A `succeeded` run follows successful completion CAS and is
positive evidence of closing that revision; the exact historical post-CAS
`applied_seq` is not stored. Membership `generation` is different: restarts can
produce several generations under one revision. `nonDestructiveClose` closes
work without certified membership; preserve `finalizationWithheld`, terminal
proof and skip/quality-hold markers in every comparison.

Pair each known incremental request with a later confirmed completion and its
membership result. Unknown requests, window boundaries, expired telemetry and
crashes between completion CAS and the run receipt remain uncovered. Sequence
differences and pending-at-request counts alone do not prove consolidation or
HTTP savings. Initial seed, manual, scheduled and anomaly sources remain distinct.

## Finish C1 and rollback

Obtain enough completed incremental and full-reconcile activity to measure all
three branches and explain unseen combinations. Correlate request/applied
progress with completed generations; distinguish pending-work observations
from confirmed consolidation. Establish which headline, deletion or pagination
condition causes redundant generations before adding the narrow fix to this
same PR. Test legitimate repair, snapshot drift, blast-radius limits and
presence freshness. Daily/48-hour policy values alone are not the RCA.

An approved code rollback may remove the new note and restore the unnamed
predicates while retaining captured diagnostics and the read operation. This
slice changes no follower business state to repair. A whole-image rollback
must also preserve any C2a v2 readers already in use. No direct SQL repair or
production reset belongs to this diagnostic procedure.
