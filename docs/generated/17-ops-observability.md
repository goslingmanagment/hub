> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Operations, health, metrics, and runtime liveness

Operational state is assembled from public health services, detailed sync
status, minutely metric sampling, persistent incidents, process heartbeats,
queue state, database statistics, and owner-only admin routes. The principal
entry points are `apps/runtime/src/services/health.ts`, `golden-signals.ts`,
`runtime-heartbeat.ts`, `ops-watchdog.ts`, `sync-status.ts`, and
`apps/runtime/src/modules/ops/index.ts`.

## Health endpoints

`GET /api/v1/health` is public. `getSystemHealth` probes the database and
reports overall status, public runtime capabilities, and the normalized OpenAPI
`contractHash`. The capability manifest comes from
`apps/runtime/src/services/public-capabilities.ts`; it is also inspected by
deployment gates before a candidate stack replacement.

`GET /api/v1/health/sync` is the reduced monitoring surface. It accepts the
configured monitoring token and returns page/stream freshness without exposing
owner admin data. `getPublicSyncHealth` combines stream checkpoints, failure
counts, freshness thresholds, and wedged retry states.

Detailed owner/team-lead sync routes expose global status, recent requests,
overview, per-page blocks, message-block diagnostics, and administrative run
history/control. Their implementation spans `apps/runtime/src/modules/ops/index.ts`,
`apps/runtime/src/services/sync-status.ts`, and the sync repositories.

## Golden signals

`apps/runtime/src/services/golden-signals.ts` schedules
`ops.metrics.sample` every minute. It computes p50/p95 over a trailing ten-minute
window for capture, canonicalization, projection backlog, command settlement,
and SSE smoke-checkpoint staleness. It also emits always-present age gauges for
waiting capture rows and queued commands, restricted AI content row/byte
volume, acceptance events per hour, and registered AI transcript health-floor
backlogs.

Thresholds are explicit in `GOLDEN_SIGNAL_THRESHOLDS_MS`. A breach opens a
metric-specific `golden_signal_lag` incident; recovery resolves that same latch.
A missing SSE checkpoint or failed health-floor probe is recorded as a blind
probe, not a healthy zero. Samples are stored in `ops_metric_samples` through
`packages/db/src/repositories/ops-metrics.ts` and retained for 90 days.

`GET /api/v1/ops/metrics` accepts the monitoring token or a dashboard session
and returns recent series plus thresholds. `tests/golden-signals.integration.test.ts` covers SQL
inputs, latch behavior, pruning, and failed probes.

## Runtime heartbeats and deadmen

API, worker, and active scheduler roles call
`startRuntimeHeartbeat` in `apps/runtime/src/services/runtime-heartbeat.ts`.
Each successful database upsert publishes role, instance identity, sanitized
running config snapshot, skipped boot overrides, image tag, and timestamps.
Heartbeats refresh every 60 seconds; repository readers
apply a staleness TTL so stopped instances disappear from current state.

Worker and scheduler Docker healthchecks read role-specific health files. The
file is written only after the heartbeat database write succeeds, coupling file
freshness to event-loop and database progress. Scheduler leadership is guarded
by a session advisory lock in `scheduler-leader.ts`; a hot standby that does not
hold the lock does not publish the active scheduler heartbeat.

`apps/runtime/src/services/ops-watchdog.ts` runs in the API process every
minute, with boot grace. It reads the scheduler heartbeat and latest
`ops.metrics.sample` job success. Silence beyond three minutes opens
`scheduler_silent` or `ops_sampler_silent`; fresh evidence resolves the
corresponding incident.

## Disk and partition guards

`apps/runtime/src/services/db-disk-alert.ts` schedules an hourly
`db.disk-usage.check` job. It reads database/volume usage, compares it with the
configured percentage, and opens/resolves `db_disk_usage`.

`apps/runtime/src/services/observations-partitions.ts` schedules a daily
partition check. It creates monthly `observations` and `domain_events`
partitions three months ahead and requires at least two full future months of lead. Creation/check failure or
insufficient lead opens `observations_partitions`; restored lead resolves it.
Missing partitions remain an insert failure so webhook/sync capture does not
fall into a default partition silently.

## Ops admin module

`apps/runtime/src/modules/ops/index.ts` groups these owner-facing surfaces:

- OFAPI credit summary, daily data, ledger/CSV, spend comparison, and DM archive
  status;
- sync status, blocks, runs, trigger/pause/resume/reset controls, and active
  connection inventory;
- structured log tail, pg-boss queue jobs, database table/index statistics, and
  incident listing;
- configuration read/update/staged/delete operations; and
- Telegram notification settings, discovery, testing, incident resolution, and
  report operations.

The public credit summary has a narrower contract than owner credit detail.
Raw SQL used by logs, queue, and DB-stat routes is fixed in the handler; caller
input is constrained by route schemas.

## Reporting and dashboard consumers

`apps/runtime/src/services/reporting.ts` is the read-model layer for revenue,
growth, followers/subscribers, fan detail, and summaries. Operational report
history is separate in the notifications repositories. Dashboard pages under
`apps/dashboard/src/pages/dev/`, `OfapiCreditsPage.tsx`,
`NotificationsPage.tsx`, and Settings consume the corresponding generated SDK
operations.

Health, watchdog, heartbeat, sync-status, disk, partition, queue, credit, and
dashboard presentation behavior have dedicated tests under `tests/health.test.ts`,
`tests/ops-watchdog.integration.test.ts`, `tests/runtime-heartbeat.test.ts`,
`tests/sync-status.test.ts`, `tests/db-disk-alert.test.ts`, and related ops
integration suites.
