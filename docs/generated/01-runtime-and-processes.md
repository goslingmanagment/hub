> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Runtime and Processes

Scope: the single Docker image runs three roles — `api`, `worker`, and
`scheduler` — dispatched from one entrypoint. This document maps the process
model (role dispatch, thin entrypoints, the migration advisory lock), each
role's runtime, scheduler leader election, the `createAppContext` composition
root, the complete pg-boss surface (cron schedules and worker consumers, queue
policies/DLQs, the OFAPI-event singleton lock), startup cleanup and the worker
health file, the CLI command catalog, client-version observation, the error
taxonomy, and the health probes. Everything anchors to `apps/runtime/src/...`
unless otherwise noted.

## Process model and role dispatch

The real multi-role entry is `apps/runtime/src/startup.ts`.

- `resolveRole()` (`startup.ts:36-45`) computes the role as
  `process.argv[2] ?? process.env.AGENCY_HUB_ROLE ?? "worker"`. Valid values are
  `"api" | "worker" | "scheduler"`; any other value throws
  `Unsupported Agency Hub runtime role "<role>"` (`startup.ts:40-41`).
- `main()` (`startup.ts:47-61`) always runs `runStartupMigrations()` first, then
  dispatches: `api` → `runApiRuntime()`, `scheduler` → `runSchedulerRuntime()`,
  anything else → `runWorkerRuntime()`.
- The top-level catch calls `process.exit(1)` (not merely setting `exitCode`) so
  that lingering pg-boss handles cannot leave a zombie process that Docker never
  restarts (`startup.ts:63-69`).

### Thin entrypoints

`api.ts` and `worker.ts` are `pathToFileURL`-guarded main-module wrappers that
call `runApiRuntime()` / `runWorkerRuntime()` directly (`api.ts:1-18`,
`worker.ts:1-18`). On error they set `process.exitCode = 1` (they do not call
`process.exit`). `startup.ts` is the entry that performs role dispatch and runs
migrations first.

### Migration advisory lock

`runStartupMigrations()` (`startup.ts:9-10, 12-34`) runs before any role starts,
guarded by a session advisory lock so concurrent boots serialize their
migrations:

- Keys `MIGRATION_LOCK_KEY_1 = 31415`, `MIGRATION_LOCK_KEY_2 = 27182`.
- Sequence: `loadConfig()` → `createPool` → connect →
  `select pg_advisory_lock(31415, 27182)` → `runMigrations({databaseUrl, db: client})`
  (from `packages/db/src/migrate-runner.ts`) → in `finally`,
  `pg_advisory_unlock(31415, 27182)`, release the client, and end the pool.

## API runtime

`api-runtime.ts:5-40`:

- `createAppContext()` → `buildApiServer(appContext)` →
  `keepAlive = setInterval(() => {}, 60_000)` →
  `server.listen({ host: config.apiHost, port: config.apiPort })`.
- The heartbeat `startRuntimeHeartbeat(appContext, "api")` starts ONLY after
  `listen` succeeds (`api-runtime.ts:21`).
- SIGINT/SIGTERM `shutdown`: clear `keepAlive`, `heartbeat.stop`, `server.close`,
  `appContext.close`, then `process.exit(0)`.

## Worker runtime

`worker-runtime.ts:7-39`:

- `createAppContext()` →
  `new PgBoss({ connectionString: config.databaseUrl, schedule: false })`
  (`worker-runtime.ts:10-14` — workers do NOT fire cron).
- `boss.on("error", … process.exit(1))` (`worker-runtime.ts:18-21`) — fail-fast
  so Docker restarts the container.
- `startWorkerServices(app, boss, { processStartedAt })`; the heartbeat
  `"worker"` starts AFTER services are up (`worker-runtime.ts:26`).
- SIGINT/SIGTERM → `heartbeat.stop`, `runtime.shutdown`, `process.exit(0)`.

## Scheduler runtime and leader election

Per Stage 25, EXACTLY ONE active scheduler owns cron registration plus the
pg-boss timekeeper. Workers and the api run `schedule: false`; a losing
scheduler stalls only cron.

`scheduler-runtime.ts:17-70`:

- Boot: `createAppContext()` →
  `acquireSchedulerLeadership({ pool, retryMs: SCHEDULER_STANDBY_RETRY_MS, onStandby, isStopped })`
  (`scheduler-runtime.ts:23-28`). If it returns `null` (stopped during
  contention) → `process.exit(0)` (`scheduler-runtime.ts:29-31`).
- After acquiring the lock: `new PgBoss({ schedule: true })`
  (`scheduler-runtime.ts:34-38`) — the single instance that fires cron.
  `boss.start()` → `registerAllSchedules(boss)` → heartbeat `"scheduler"`.
- `leadership.lost.then(...)`: if the lock session dies while not stopped →
  `process.exit(1)` to avoid double-firing cron (`scheduler-runtime.ts:51-56`).
- Shutdown: set `stopped = true`, `heartbeat.stop`,
  `boss.stop({ close: true, timeout: 15_000 })`, `leadership.release()`,
  `process.exit(0)` (`scheduler-runtime.ts:58-66`).

### Leader election internals

`services/scheduler-leader.ts`:

- Constants: `SCHEDULER_LEADER_LOCK_NS = 58212`, `SCHEDULER_LEADER_LOCK_KEY = 1`,
  `SCHEDULER_STANDBY_RETRY_MS = 10_000` (`scheduler-leader.ts:9-11`). A comment
  (`scheduler-leader.ts:6-7`) notes namespace `58211` was the old OFAPI
  event-worker singleton.
- `acquireSchedulerLeadership()` (`scheduler-leader.ts:35-115`) loops: check out
  a client, `select pg_try_advisory_lock(58212, 1) as locked`; if not acquired,
  release the client, call `onStandby()`, sleep `retryMs`, and retry. On
  acquire, the session-scoped lock pins the client; it wires
  `client.on("error", onDeath)` and the underlying `connection.on("end", onDeath)`
  (`scheduler-leader.ts:89-92`) so connection death resolves `lost`. `release()`
  runs `pg_advisory_unlock(58212, 1)`, destroys the client via
  `client.release(true)`, and resolves `lost`.

## Composition root — `createAppContext` (bootstrap.ts)

`createAppContext` in `bootstrap.ts` is the shared composition root all three
roles call at boot. It assembles the `AppContext`, wiring the Fansly adapter, the
OFAPI client, and the two AI-gateway providers, and applies boot overrides
before returning.

- Boot-override application: it reads DB overrides via `getConfigOverrides(db)`
  and calls `applyBootOverrides(rawConfig, overrides)` (`bootstrap.ts:167-181`).
  A DB read failure falls back to `applyBootOverrides(rawConfig, new Map())`,
  which still normalizes the requires graph.
- The resulting `AppContext` carries `config` (boot-applied), `rawConfig` (the
  pre-boot env config), and `bootSkipped` (keys the boot-apply forced off)
  (`bootstrap.ts:96-128`). See `docs/generated/15-auth-config-and-access.md` for
  the boot-apply semantics.

## pg-boss surface

### Who fires cron

Cron registration is scheduler-only. `services/schedules.ts:30-62`
(`registerAllSchedules()`) creates all queues (idempotent) and then registers
all crons. Workers only create queues and consume
(`worker-services.ts:160-172`); the api-side pg-boss also runs `schedule: false`
and merely enqueues.

### Cron schedules

| Queue const | Cron | Timezone | Implementing file |
|---|---|---|---|
| `sync.planner` (`SYNC_PLANNER_QUEUE`) | `* * * * *` | — | `sync-queue.ts:113` (`ensurePlannerSchedule`) |
| `fansly.raw-payload-cleanup` (`RAW_PAYLOAD_CLEANUP_QUEUE`) | `0 2 * * *` | — | registered inline `schedules.ts:47` |
| `telegram.daily-report` | `0 * * * *` | UTC | `sync-queue.ts:123` (`ensureTelegramDailyReportSchedule`) |
| `workboard.classify-closing` | `0 1 * * *` | UTC | `sync-queue.ts:158` |
| `workboard.recompute` | `0 3 * * *` | UTC | `sync-queue.ts:159` |
| `ops.metrics.sample` (`OPS_METRICS_SAMPLE_QUEUE`) | `* * * * *` | UTC | `golden-signals.ts:60` |
| `retention-tiering` (`TIERING_QUEUE`) | `40 4 * * *` | — | `tiering/index.ts:581` |
| `db.disk-usage.check` (`DB_DISK_USAGE_CHECK_QUEUE`) | `15 * * * *` | UTC | `db-disk-alert.ts:64` |
| `observations.partitions.ensure` | `10 3 * * *` | UTC | `observations-partitions.ts:42` |
| `canonicalize.sweep` | `* * * * *` | UTC | `canonicalize-driver.ts:42` |
| `projections.message-archive.sweep` | `* * * * *` | UTC | `projections/message-archive.ts:43` |
| `ofapi.events.sweep` (`OFAPI_EVENT_SWEEP_QUEUE`) | `* * * * *` | UTC | `ofapi-events.ts:253` |
| `ofapi.events.cleanup` | `30 2 * * *` | UTC | `ofapi-events.ts:254` |
| `ofapi.credits.balance-ping` | `5 0 * * *` | UTC | `ofapi-credits.ts:432` |
| `ofapi.credits.accrual` | `40 0 * * *` | UTC | `ofapi-credits.ts:433` |
| `ofapi.credits.reconcile` | `5 * * * *` | UTC | `ofapi-credits.ts:434` |
| `ofapi.chargebacks.reconcile` | `10 3 * * *` | UTC | `ofapi-chargebacks-sync.ts:454` |
| `ofapi.commands.sweep` (`OFAPI_COMMAND_SWEEP_QUEUE`) | `* * * * *` | UTC | `ofapi-command-executor.ts:162` |
| `ofapi.dm-analytics.rebuild` | `10 * * * *` | UTC | `ofapi-dm-analytics.ts:49` |

### Worker consumers

`startWorkerServices` (`worker-services.ts:133-344`) registers the `boss.work`
consumers:

| Queue | Handler | Notes / anchor |
|---|---|---|
| `sync.planner` | `runSyncPlannerCycle(app, boss)` | batchSize 1, includeMetadata (`worker-services.ts:176-181`) |
| `fansly.raw-payload-cleanup` | `deleteExpiredRawPayloads` + `deleteExpiredSyncObservability` | retention = `config.syncObservabilityRetentionDays` (`:183-189`) |
| `workboard.recompute` | `recomputeAllWorkboardPages` | nightly reconciler, drift counter (`:191-201`) |
| `workboard.fan-recompute` | `runWorkboardFanRecompute` | batchSize 5, event-driven (`:203-210`) |
| `db.disk-usage.check` | `runDbDiskUsageCheck` | (`:212-217`) |
| `observations.partitions.ensure` | `runObservationsPartitionCheck` | (`:219-222`) |
| `canonicalize.sweep` | `runCanonicalization` | (`:224-229`) |
| `projections.message-archive.sweep` | `runMessageArchiveProjection` + `runFanEarningsProjection` + `runAiAcceptanceProjection` | (`:231-244`) |
| `workboard.classify-closing` | `runClosingClassificationAllPages` | gated on `config.anthropicApiKey` (`:246-254`) |
| `telegram.daily-report` | `sendDailyRevenueTelegramReport` | reads `getTelegramSettings`, backfills missed dates (`:271-296`) |

Non-cron consumers and services started in the same function:
`startDomainEventsSmokeConsumer(app)` (`:258`),
`startWorkboardEventRecompute(app, boss)` (`:260`), `startGoldenSignalWorker`
(`:261`, consumes `ops.metrics.sample`), `ensureTieringQueue` +
`startTieringWorker` (`:262-263`, consumes `retention-tiering`),
`startOfapiEventWorker` (returns a lock-release function) (`:265`),
`startOfapiCreditWorker` (`:266`), `startOfapiChargebacksWorker` (`:267`),
`startOfapiCommandWorker` (`:268`), `startOfapiDmAnalyticsWorker` (`:269`). The
worker also runs `runSyncPlannerCycle` once at boot (`:298`) and
`startSyncPageExecutor(app, boss, { signal })` (`:299-301`) consuming
`sync.page.execute`.

### Queue policies and DLQs

`sync-queue.ts:60-147`:

- DLQs `sync.planner.dlq` / `sync.page.execute.dlq`: policy `standard`,
  `retentionSeconds: 1_209_600` (14 days).
- `sync.planner` and `sync.page.execute`: policy `exclusive`, `expireInSeconds`
  120 / 180, `heartbeatSeconds` 30, `retryLimit` 2, `retryDelay` 30,
  `retryBackoff`, dead-letter into the corresponding DLQ.
- Workboard queues: `fan-recompute` `retryLimit` 3, `recompute` `retryLimit` 1,
  `classify` `retryLimit` 1 (`sync-queue.ts:128-147`).

### OFAPI event-worker singleton lock

`ofapi-events.ts:75-76`: `OFAPI_EVENT_WORKER_LOCK_NAMESPACE = 58211`,
`OFAPI_EVENT_WORKER_LOCK_KEY = 1`, acquired via
`pg_try_advisory_lock(58211, 1)` (`ofapi-events.ts:400-401`). The config guard
`ofapiEventWorkerReplicas` must equal 1.

## Startup cleanup and worker health file

- At worker boot, `closeOrphanedSyncRuns` runs
  (`worker-services.ts:146-158`, errorSummary `"Worker restarted"`).
- An optional worker health file at `process.env.WORKER_HEALTH_FILE` is written
  `ready` on the interval `WORKER_HEALTH_WRITE_INTERVAL_MS = 30_000`
  (`worker-services.ts:82, 302-311`) and `stopping` on shutdown.

## CLI — `apps/runtime/src/cli.ts`

`buildProgram` (`cli.ts:585-1931`); program name `pnpm cli`. Command catalog:

| Command | Anchor | Purpose |
|---|---|---|
| `model add` | `cli.ts:592` | create a model (slug, name) |
| `model list` | `cli.ts:609` | list models + page counts |
| `model revenue` | `cli.ts:624` | model revenue report by period/custom |
| `tiering:run` | `cli.ts:668` | Stage 28 export→verify→detach aged ledger partitions (`--execute`, default dry-run) |
| `ai:personas-seed` | `cli.ts:686` | upsert bundled personas into `ai_personas` |
| `ai:feature-smoke` | `cli.ts:707` | exercise one AI feature end-to-end (spends provider budget); `--feature/--page/--conversation/--as` |
| `erasure:run` | `cli.ts:786` | audited break-glass erasure (fan\|page\|model scope), dry-run default, `--execute --confirm <scopeRef>` |
| `tiering:restore-drill` | `cli.ts:860` | rebuild a tiered partition from Parquet + re-attach |
| `page add fansly` | `cli.ts:887` | onboard Fansly page from session file + proxy; queues initial full sync |
| `page add onlyfans` | `cli.ts:917` | onboard OF page by username (OFAPI mapping); queues initial full sync |
| `page list` | `cli.ts:941` | list pages (proxy masked) |
| `page set-proxy` | `cli.ts:981` | set page proxy |
| `page remove-proxy` | `cli.ts:999` | remove page proxy |
| `page verify` | `cli.ts:1012` | verify Fansly page (light refresh, recovery); OF pages throw (verify via OFAPI mapping) |
| `page proxy-ip` | `cli.ts:1051` | compare proxy vs direct exit IP |
| `fansly:replay-probe` | `cli.ts:1078` | Stage 6 gate: probe Fansly earnings/order-history replay |
| `events:replay` | `cli.ts:1115` | Stage 8 re-run canonicalizers over observations (idempotent) |
| `fansly:backscroll-report` | `cli.ts:1149` | Stage 17 per-conversation hot vs archive coverage |
| `grants:parity` | `cli.ts:1167` | Stage 22 diff access-grants projection vs user_page_assignments (must be zero pre-flip) |
| `harvest:reconcile` | `cli.ts:1200` | Stage 12 reconcile a machine's harvest manifest vs kernel counts |
| `projection:rebuild` | `cli.ts:1265` | rebuild `message_archive` or `fan_earnings_stats` from the ledger |
| `archive:backfill` | `cli.ts:1286` | Stage 10 idempotent archive backfills |
| `onlyfans-page-metadata-backfill` | `cli.ts:1300` | backfill OF page metadata |
| `fansly-page-alias-backfill` | `cli.ts:1338` | backfill Fansly page aliases |
| `ofapi-transactions-backfill` | `cli.ts:1396` | dry-run/apply OFAPI REST transaction backfill (`--write`) |
| `sync` (root) | `cli.ts:1424` | queue a page sync (`--page`, `--scope light\|followers\|all`, `--transactions-start`, `--no-wait`) |
| `sync status` | `cli.ts:1475` | sync monitor snapshot / `--watch` |
| `queue planner-recover` | `cli.ts:1506` | enqueue a `sync.planner` wakeup |
| `telegram test` | `cli.ts:1523` | test Telegram delivery |
| `telegram report` | `cli.ts:1545` | send Telegram report |
| `status` | `cli.ts:1567` | sync run status table / `--run <id>` detail / `--watch` |
| `fans` | `cli.ts:1620` | fans report |
| `revenue` | `cli.ts:1653` | revenue report |
| `followers` | `cli.ts:1687` | followers report |
| `subscribers` | `cli.ts:1703` | subscribers report |
| `fan-spend` | `cli.ts:1723` | fan-spend report |
| `user add` | `cli.ts:1745` | create a user |
| `user list` | `cli.ts:1774` | list users |
| `user set-password` | `cli.ts:1793` | set a user password |
| `user assign-page` | `cli.ts:1816` | assign a page to a user |
| `user unassign-page` | `cli.ts:1833` | unassign a page from a user |
| `apikey create` | `cli.ts:1850` | create a chatter API key |
| `apikey revoke` | `cli.ts:1870` | revoke an API key |
| `apikey list` | `cli.ts:1885` | list API keys |
| `apikey show` | `cli.ts:1907` | show an API key |

The main guard (`cli.ts:1933-1943`) runs `program.parseAsync(process.argv)`,
redacts errors, and sets `exitCode 1`.

## Client-version observation

`services/client-versions.ts` implements the Stage 4 fleet-verify observer. It
observes the desktop's `x-client-version` header (recorded by the server.ts
`onRequest` hook, `api/server.ts:162-168`). It tracks/logs; it does NOT enforce.

- `recordClientVersionObservation({ version, remoteAddress, logger })`
  (`client-versions.ts:21-53`): ignores non-strings; trims; rejects empty or
  `> 64` chars; keys `"<version>|<remoteAddress>"` (remoteAddress `?? "unknown"`);
  increments `requests` on repeat; caps distinct keys at `MAX_TRACKED_KEYS = 1000`
  (`client-versions.ts:17`); logs one line `"Desktop client version observed"`
  with `{ clientVersion, remoteAddress }` per new (version, address) per process
  lifetime (the exit check greps this line, counting distinct addresses per
  version).
- `snapshotClientVersionObservations()` (`client-versions.ts:55-57`) and
  `resetClientVersionObservationsForTests()` (`client-versions.ts:59-61`). State
  is an in-memory `Map`, with no persistence and no version gating/blocking.

## Error taxonomy

`services/errors.ts`: base `AppError(message, statusCode, code)`; subclasses
`BadRequestError` (400 `bad_request`), `UnauthorizedError` (401 `unauthorized`),
`ForbiddenError` (403 `forbidden`), `NotFoundError` (404 `not_found`),
`ConflictError` (409 `conflict`), `TooManyRequestsError` (429
`rate_limit_exceeded`), `ServiceUnavailableError` (503), `QuotaDeniedError` (429
`quota_denied`). These are mapped by the server.ts error handler
(`api/server.ts:417-424`).

## Health probes

`services/health.ts`:

- `getSystemHealth` (`health.ts:73-120`) probes `select 1` → 200
  `{ status: "ok" }` or 503 `{ status: "degraded" }` (public error string
  `"Database check failed"`).
- `getPublicSyncHealth` (`health.ts:122-281`) merges connections + the sync
  snapshot + `loadEffectiveConfig` (live thresholds
  `healthSyncLightMaxAgeMinutes` / `healthSyncFollowerMaxAgeMinutes`); it emits
  per-page degraded/ok issues and an overall 200 or 503.
