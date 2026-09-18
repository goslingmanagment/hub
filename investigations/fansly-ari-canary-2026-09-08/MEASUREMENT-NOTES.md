# Canary measurement notes

The current production revision is b47f552abb97. These notes prepare the final
canary report; they do not declare acceptance or replace the fixed rollback.

## HTTP attempt counts

Use one complete worker-log export covering the activation through rollback,
rather than summing overlapping exports from each heartbeat. Filter
`component == sync_http_summary` and `pageLabel == ari-1`, retaining each
`runId` once; detect inconsistent duplicates instead of silently adding them.
Split by `stream` and `byOperation`, and report HTTP retries/failures separately
from completed unconfirmed head-search attempts.

At this revision `RequestSummaryCollector.onRequestEvent` increments attempts
on every `started` event (`observability.ts:244`). A retry therefore adds another
physical attempt. `createChunkTelemetry` creates a new run and collector per
chunk (`executor.ts:159`), and `finish` emits its summary once. The summary is
per completed chunk, not a cumulative total for the entire long-lived stream.
A `partial` run status is not itself an HTTP error; inspect failedAttempts and
429 telemetry. Count `sync_dm_messages_chunk.rateLimit429s` separately.

Check interval boundaries: derive the run start as summary timestamp minus
`totalSyncDurationMs`. A completed summary can include requests begun before
activation, and a run ending after rollback can include an allowed in-flight
request. Itemize those boundary cases rather than presenting a falsely exact
window count. A run without a completion summary is a coverage limitation.

These scoped canary counters do not deliver the planned fleet-wide T0 aggregate
or measure polling savings. The canary also captures ordinary new heads, so
its entire DM request count is not attributable to recovery of the two original
targets.

## Reply replay versus head recovery

A debt `captured` receipt confirms the exact hot writer ID, not archive parity.
Re-read each original target through Hub and preserve capture/delivery caveats.
The background sync-pull v6 replay remains independent; use the existing
reply-repair runbook for that prerequisite. An unchanged source observation at
parse_version 0 means its canonicalization is still pending; it does not erase
a positive hot-table read.

The owner-check backlog at 13:03:31 UTC was 48,408 v6 observations and 318,487
pending across the sync-pull family. The DM subset was 16,087 parsed and 52,688
pending. Database bytes were 32,261,626,903. These are family-wide workload
measurements, not canary-only costs or delivery-latency percentiles.
