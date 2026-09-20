> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Runtime and processes

The production image contains three long-lived roles selected by
`apps/runtime/src/startup.ts`: `api`, `worker`, and `scheduler`. The API and
workers configure pg-boss with `schedule:false`; the leader-elected scheduler
is the only process that registers and fires cron.

## Startup and utility modes

`startup.ts` recognizes three non-runtime commands before role resolution:

- `print-public-capabilities` emits the build's public capability list.
- `print-desktop-lifecycle-v2-evidence` validates and emits the embedded
  preservation evidence manifest.
- `verify-desktop-lifecycle-v2-inventory` reads the database and emits a
  machine-readable inventory verification result.

Normal startup resolves `argv[2]`, then `AGENCY_HUB_ROLE`, then defaults to
`worker`. It rejects any value outside the three roles. Before dispatch it
serializes migrations with advisory lock `(31415,27182)` and calls the shared
migration runner. The top-level failure handler calls `process.exit(1)` so
pg-boss handles cannot keep a failed process alive.

`apps/runtime/src/api.ts`, `worker.ts`, and `scheduler-runtime.ts` are thin role
entrypoints. `apps/runtime/src/cli.ts` is an independent Commander process and
does not pass through role resolution.

## Composition root

`createAppContext()` in `apps/runtime/src/bootstrap.ts` performs this sequence:

1. Load and validate environment config and sync-concurrency invariants.
2. Create the Postgres pool and require the latest schema through
   `assertRuntimeSchemaReady()`.
3. Read boot-class DB overrides. The read is retried three times and then
   rethrown; the process does not silently fall back to flags-off env config.
4. Build the Drizzle DB, shared egress pacer, Fansly adapter, optional OFAPI
   client/credit sink, and available AI providers.
5. Return `config`, `rawConfig`, `bootSkipped`, logger, pool, DB, adapters and a
   single `close()` that releases provider/adapter/pool resources.

The Anthropic provider can resolve a per-page proxy client. OpenRouter is wired
only when keyed. OFAPI is absent when `OFAPI_API_KEY` is absent.

## API role

`runApiRuntime()` builds the AppContext and Fastify server, listens, then starts
the API runtime heartbeat and `startOpsWatchdog()`. The watchdog is independent
of the scheduler and ops sampler and opens/resolves `scheduler_silent` and
`ops_sampler_silent` incidents when their heartbeats disappear. Shutdown stops
the watchdog and heartbeat, closes Fastify/AppContext, and exits.

The API's pg-boss instance is enqueue-only. It ensures sync, OFAPI-event and
OFAPI-command queues but does not consume or register schedules. Its pg-boss
error event is logged rather than terminating the HTTP process.

## Worker role

`runWorkerRuntime()` creates a `schedule:false` pg-boss instance, fails the
process on its error event, and delegates to `startWorkerServices()`.
Worker startup closes orphaned sync runs from older process starts, starts
pg-boss, creates/reconciles queues, registers consumers, starts the
domain-event smoke listener and writes the worker health file every 30 seconds.

Consumer families at this revision include:

- sync planner and per-page executor;
- OFAPI event, credits, chargebacks, pending-transaction reconcile, command,
  and DM-analytics workers;
- observation partition, canonicalization, DM readthrough and DM correction
  reconciliation;
- message archive, fan earnings, AI acceptance and projection-debt sweeps;
- golden-signal sampling, disk checks, tiering and Telegram daily reporting.

The nightly raw-payload job also deletes expired pending device-token
reservations and configured sync observability. Pending reservations are
short-lived credentials, not business-fact records.

The canonicalization consumer keeps a per-family in-memory sweep cursor; CLI
and explicit replay runs remain cursor-free. Readthrough and DM-correction
reconcilers run after that sweep so newly merged material can produce explicit
correction lineage. Projection debt is retained until its repair succeeds.

## Scheduler role

`runSchedulerRuntime()` acquires session advisory lock `(58212,1)` through
`services/scheduler-leader.ts`. A standby retries every ten seconds. Only the
lock holder starts pg-boss with `schedule:true`, calls
`registerAllSchedules()`, and begins its heartbeat. Lock-session loss exits the
process to avoid two cron owners.

`services/schedules.ts` is the single cron composition point. It creates every
queue first, then registers component schedules for:

- minutely sync planning and canonicalization;
- raw cleanup and Telegram catch-up;
- OFAPI event/credit/chargeback/pending/command/analytics work;
- disk, partition, archive, projection-debt, metrics and tiering maintenance.

The scheduler heartbeat can touch `SCHEDULER_HEALTH_FILE`; a standby does not
write that file because it has not acquired leadership.

## Queue semantics worth preserving in the map

`sync.page.execute` is an exclusive wakeup queue. Durable retry/ownership lives
in `page_sync_states`; pg-boss retry is zero, expiry is 15 minutes, heartbeat is
30 seconds, and queue options are actively reconciled because `createQueue`
does not update an existing queue. Per-page jobs carry grouped provider/egress
identity and the executor uses guarded handoff rather than treating a wakeup as
the durable task.

The worker records startup cleanup and uses explicit shutdown handles for
listeners, health writers and pg-boss. Fatal worker or scheduler pg-boss errors
exit for container restart.

## Health and running-build identity

`services/runtime-heartbeat.ts` publishes sanitized running config snapshots in
`runtime_instances` and optionally health-file mtimes. `/health` probes the DB
and returns the generated `KERNEL_CONTRACT_HASH` plus
`PUBLIC_RUNTIME_CAPABILITIES`; at this revision the capability list contains
`desktop-lifecycle-v2`.

`getPublicSyncHealth()` additionally folds connection status, stream state,
retry wedges, projection debt, and per-conversation DM coverage failures into
page health. The API watchdog covers the separate failure mode where scheduler
or sampler execution stops producing those signals.

## Administrative CLI

`apps/runtime/src/cli.ts` exposes catalog/page/user/API-key administration,
sync queue/status/reporting, grants, proxy verification, replay and repair,
erasure/tiering, archive rebuild, transaction backfill, persona seed/smoke,
harvest reconcile, pending-transaction reconcile, correction lineage, Fansly
1970 repair, observation re-journal, and money-negation repair commands. Each
command constructs only the dependencies it needs and closes them before exit.
