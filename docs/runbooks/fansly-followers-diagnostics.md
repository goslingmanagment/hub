# Fansly C1 diagnostic runbook

Authority: the accepted events plan §4/§6 and Decision 286. This is the
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

Deploy only an explicitly approved reviewed revision. This branch follows C2a;
starting its worker also activates earnings v7 replay. A proposal must include
that scope and compatible readers. PR164's earlier merge is the A0-only target.
Merging or preparing this draft does not authorize production activation.

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
