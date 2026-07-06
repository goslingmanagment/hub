> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Territory 01 — Runtime, Processes & Composition

**Scope.** This document covers how the `core` backend boots and wires itself together across its three OS processes (API, worker, CLI), and the complete background-job surface. Files read in full: `apps/runtime/src/api.ts`, `apps/runtime/src/worker.ts`, `apps/runtime/src/cli.ts`, `apps/runtime/src/startup.ts`, `apps/runtime/src/bootstrap.ts`, `apps/runtime/src/api-runtime.ts`, `apps/runtime/src/worker-runtime.ts`, `apps/runtime/src/worker-services.ts`, `apps/runtime/src/services/runtime-heartbeat.ts`, `apps/runtime/src/services/provider.ts`, `apps/runtime/src/services/health.ts`, `apps/runtime/src/services/effective-config.ts`, `packages/db/src/repositories/runtime-instances.ts`, and `package.json`. To trace the job surface and boundaries it also reads `apps/runtime/src/services/sync-queue.ts`, the queue-registration/worker functions in `apps/runtime/src/services/ofapi-events.ts`, `ofapi-credits.ts`, `ofapi-command-executor.ts`, `ofapi-dm-analytics.ts`, the executor loop in `apps/runtime/src/services/sync/executor.ts`, the server composition in `apps/runtime/src/api/server.ts` (queue wiring + dashboard static serving only — routes are Territory 02), `packages/shared/src/config.ts` (env → `AppConfig`), `packages/db/src/schema-guard.ts`, the `runtime_instances` table in `packages/db/src/schema.ts`, `Dockerfile`, and `docker-compose.production.yml`. HTTP route bodies and sync internals are deliberately out of scope (Territories 02 and 06).

---

## 1. Process entrypoints

There are three logical roles — **api**, **worker**, **cli** — reachable through four entry files. In production a single dispatcher (`startup.ts`) selects api vs worker; in local dev the `pnpm api` / `pnpm worker` scripts run `api.ts` / `worker.ts` directly (which skip the migration step).

| Entry file | pnpm script | Production invocation | What it does |
|---|---|---|---|
| `apps/runtime/src/startup.ts` | — | `node apps/runtime/dist/startup.js {api\|worker}` (Docker `CMD`) | Runs migrations under an advisory lock, then dispatches to api or worker runtime by role. |
| `apps/runtime/src/api.ts` | `api`, `api:watch` | (via startup) | `main()` → `runApiRuntime()`. |
| `apps/runtime/src/worker.ts` | `worker`, `worker:watch` | (via startup) | `main()` → `runWorkerRuntime()`. |
| `apps/runtime/src/cli.ts` | `cli` | ad hoc / admin | commander program; each subcommand builds its own `AppContext` and closes it. |

`api.ts` and `worker.ts` are thin: they call `runApiRuntime()` / `runWorkerRuntime()` and only self-invoke `main()` when run as the process main module (`import.meta.url === pathToFileURL(process.argv[1]).href`). They are also imported by `startup.ts` and by tests.

### 1.1 `startup.ts` — production dispatcher + migrations

`startup.ts:44 main()` runs unconditionally at module load (`startup.ts:56`). Sequence:

1. `resolveRole()` (`startup.ts:35`): role = `process.argv[2] ?? process.env.AGENCY_HUB_ROLE ?? "worker"`. Any value other than `"api"` / `"worker"` throws. The Docker `CMD`s pass the role positionally (`"api"` / `"worker"`), so `AGENCY_HUB_ROLE` is only a fallback.
2. `runStartupMigrations()` (`startup.ts:11`): `loadConfig()`, `createPool(config.databaseUrl)`, take a **Postgres session advisory lock** `pg_advisory_lock(31415, 27182)` (keys `MIGRATION_LOCK_KEY_1/2` at `startup.ts:8-9`), run `runMigrations({ databaseUrl, db: client })` (imported from `packages/db/src/migrate-runner.ts`), then `pg_advisory_unlock`, release the client, and end the pool. The lock serializes concurrent api+worker container starts so only one applies migrations at a time.
3. Dispatch: role `"api"` → `runApiRuntime()`; otherwise → `runWorkerRuntime()`.

Top-level `main().catch` (`startup.ts:56`) logs and calls `process.exit(1)` (not just `exitCode`), deliberately, because after `boss.start()` pg-boss keeps the event loop alive and a bare `exitCode` would leave a zombie that Docker's restart-on-exit policy never recovers (comment cites "audit B8").

### 1.2 The CLI

`cli.ts` builds a commander `Command` tree (`buildProgram()` at `cli.ts:560`) and runs it when it is the process main module (`cli.ts:1485`). Every action calls `createAppContext()` and closes it in `finally`. Command groups: `model`, `page`/`page add`, `sync`, `queue`, `telegram`, `user`, `apikey`, plus top-level backfills and reports. CLI actions that need to enqueue jobs spin up **their own ephemeral `PgBoss`** on `app.config.databaseUrl`, attach an error logger (`attachCliPgBossErrorLogger`, `cli.ts:421` — a listener is required because an unlistened pg-boss `error` event would throw and kill the CLI mid-operation), `boss.start()`, `ensureSyncQueues(boss)`, do the work, then `boss.stop()`. Concretely:
- `page add fansly` / `page add onlyfans` → `queueInitialFullSyncAfterPageCreate` (`cli.ts:427`) enqueues an initial `all`-scope sync via `requestPageSync`.
- `sync` (default action, `cli.ts:976`) → `requestPageSync` then optionally `waitForRequestedSyncRequests`.
- `queue planner-recover` (`cli.ts:1058`) → `sendSyncPlannerWakeup(boss)`.

The CLI never registers `boss.work` handlers; it only enqueues. It performs outbound platform HTTP directly for verification/IP probes (`page verify`, `page proxy-ip`, `resolvePageEgressSummary` → `https://api.ipify.org`). These are CLI-only boundaries.

---

## 2. Composition: `bootstrap.ts` and the `AppContext`

`createAppContext()` (`bootstrap.ts:109`) is the single composition root shared by all three roles. It returns an `AppContext` (`bootstrap.ts:77`) — the "runtime" object threaded through every service. Construction order:

1. `rawConfig = loadConfig()` — parse env into `AppConfig` (see §8). `loadConfig` runs its own boot invariants on env values.
2. `logger = createLogger(rawConfig.logLevel)` — pino logger.
3. Deprecated-alias warning for `FANSLY_*_DELAY_MS` (`bootstrap.ts:115`).
4. `checkSyncConcurrencyInvariant({ pageExecutorConcurrency, sharedRateLimitEnabled })` (`bootstrap.ts:126`) — throws if `SYNC_PAGE_EXECUTOR_CONCURRENCY > 1` without `SYNC_SHARED_RATE_LIMIT_ENABLED=true`.
5. `pool = createPool(rawConfig.databaseUrl)` (node-postgres `Pool`).
6. `await assertRuntimeSchemaReady(pool)` (`bootstrap.ts:136`) — **schema drift gate**, see §6.1. Throws before any service is built if migrations are behind.
7. `db = createDb(pool)` — Drizzle client.
8. **Boot-override merge** (`bootstrap.ts:144-160`): read `getConfigOverrides(db)`, apply the staged/`boot` overrides onto `rawConfig` via `applyBootOverrides` → `{ config, bootSkipped }`. A DB read failure is non-fatal: it logs and re-runs `applyBootOverrides(rawConfig, new Map())` (pure, no I/O) so the requires-graph is still normalized. `config` is the boot-applied config; `rawConfig` is the raw env baseline; `bootSkipped` is the list of rejected overrides.
9. Build platform adapters and clients from `config` (the boot-applied config):
   - `adapter = new FanslyAdapter({ baseUrl: config.fanslyBaseUrl, globalDelayMs: config.fanslyDefaultDelayMs })`.
   - `onlyFansAdapter = new OnlyFansAdapter({ baseUrl: config.onlyMonsterBaseUrl, defaultDelayMs: config.onlyFansDefaultDelayMs })`.
   - `ofapi` = `createOfapiClient({ baseUrl: config.ofapiBaseUrl, apiKey: config.ofapiApiKey, restDelayMs, onCreditSpend: createOfapiCreditSpendSink({ db, logger, config }) })` **only when `config.ofapiApiKey` is set**, else `undefined` (admin webhook registration then 503s).
   - `aiGatewayProvider` = `createAnthropicAiGatewayProvider(...)` **only when `config.chatMuseAiGatewayEnabled && config.anthropicApiKey`**, else `undefined`.
10. Return the `AppContext` with a `close()` that closes the Fansly adapter (optional), the OnlyFans adapter, and ends the pool. On any error during construction the pool is ended and the error rethrown (`bootstrap.ts:202`).

### `AppContext` fields (the "runtime" object)

| Field | Type / source | Notes |
|---|---|---|
| `config` | `AppConfig` | Boot-override-applied env config; what services read at boot. |
| `rawConfig?` | `AppConfig` | Pre-boot-apply env baseline; used by the staged-config validator. |
| `bootSkipped?` | `SkippedOverride[]` | Overrides rejected at boot; published by the heartbeat. |
| `logger` | pino logger | |
| `pool` | node-postgres `Pool` | Raw SQL / advisory locks / `LISTEN`. |
| `db` | Drizzle `Database` | ORM queries. |
| `adapter` | `AdapterLike` (Fansly) | `ProviderAdapter` + Fansly DM/earnings extensions (`bootstrap.ts:35`). |
| `onlyFansAdapter` | `OnlyFansAdapter` | |
| `ofapi?` | `OfapiClient` | Present only if `OFAPI_API_KEY` set. |
| `aiGatewayProvider?` | `AiGatewayProvider` | Present only if ChatMuse gateway enabled AND `ANTHROPIC_API_KEY` set. Comment notes provider execution is otherwise absent; tests may inject a fake. |
| `close()` | `() => Promise<void>` | Closes adapters + pool. |

---

## 3. API runtime (`api-runtime.ts`)

`runApiRuntime()`:
1. `appContext = await createAppContext()`.
2. `server = await buildApiServer(appContext)` (Fastify — see §7).
3. `keepAlive = setInterval(() => {}, 60_000)` to hold the event loop.
4. `server.listen({ host: config.apiHost, port: config.apiPort })`.
5. **Only after** listen succeeds: `heartbeat = startRuntimeHeartbeat(appContext, "api")` — advertises liveness once the socket is accepting connections (`api-runtime.ts:20-21`).
6. `SIGINT`/`SIGTERM` → `shutdown()`: clear keep-alive, `heartbeat.stop()`, `server.close()`, `appContext.close()`, `process.exit(0)`.

If `listen` throws, it tears everything down and rethrows. The API process therefore holds: one Fastify server, one heartbeat, and (built inside `buildApiServer`) its own enqueue-only `PgBoss` instance (§7.2).

---

## 4. Worker runtime (`worker-runtime.ts` + `worker-services.ts`)

### 4.1 `runWorkerRuntime()`

1. `processStartedAt = new Date()`.
2. `app = await createAppContext()`.
3. `boss = new PgBoss({ connectionString: app.config.databaseUrl })`.
4. `boss.on("error", …)` → **logs and `process.exit(1)`** ("the worker is nothing without its queue, so fail fast and let Docker restart it"; audit B8). This differs from the API's boss error handler, which only logs.
5. `runtime = await startWorkerServices(app, boss, { processStartedAt })`.
6. **After** services start: `heartbeat = startRuntimeHeartbeat(app, "worker", { startedAt: processStartedAt })` — ordering is deliberate so the worker never advertises `active` before its queues consume.
7. `SIGINT`/`SIGTERM` → `shutdown()`: `heartbeat.stop()`, `runtime.shutdown()`, `process.exit(0)`.

### 4.2 `startWorkerServices()` boot sequence

`worker-services.ts:105`. Given `app`, a `WorkerBoss` (the pg-boss subset at `worker-services.ts:56`), and `processStartedAt`:

1. Read `WORKER_HEALTH_FILE` env into `healthFilePath` (nullable).
2. `closeOrphanedSyncRuns(app.db, { startedBefore: processStartedAt, finishedAt: now, errorSummary: "Worker restarted" })` — reap sync runs left open by a prior crash; logs orphan counts.
3. `boss.start()`.
4. Create all queues (idempotent; a shared `createdQueues: Set<string>` dedupes): `ensureSyncQueues`, `ensureWorkboardQueues`, `ensureOfapiQueues`, `ensureOfapiCreditQueues`, `ensureOfapiCommandQueues`, `ensureOfapiDmAnalyticsQueues`.
5. Register all cron schedules in parallel (`worker-services.ts:139-148`): `ensurePlannerSchedule`, `boss.schedule(RAW_PAYLOAD_CLEANUP_QUEUE, "0 2 * * *")`, `ensureTelegramDailyReportSchedule`, `ensureWorkboardRecomputeSchedule`, `ensureOfapiSchedules`, `ensureOfapiCreditSchedules`, `ensureOfapiCommandSchedules`, `ensureOfapiDmAnalyticsSchedules`.
6. Register `boss.work` handlers for planner, raw-payload cleanup, workboard recompute, workboard classify, then `startOfapiEventWorker` / `startOfapiCreditWorker` / `startOfapiCommandWorker` / `startOfapiDmAnalyticsWorker`, then the telegram daily-report worker (see §5 table).
7. Run one **immediate** planner cycle: `await runSyncPlannerCycle(app, boss)` (`worker-services.ts:212`).
8. `executorPromise = startSyncPageExecutor(app, boss, { signal: abortController.signal })` — the long-lived fetch-loop pool (§5.2). It is not awaited (runs for the process lifetime).
9. If `healthFilePath`: write it `"ready"` now and every `WORKER_HEALTH_WRITE_INTERVAL_MS = 30_000` ms via `setInterval` (`worker-services.ts:216-225`).
10. Return `{ shutdown() }`: clears the health timer, writes the health file `"stopping"`, `abortController.abort()` (stops the executor loop), awaits `executorPromise`, releases the OFAPI event-worker advisory lock (§5.3), `boss.stop()`, `app.close()`.

The worker process therefore holds: one `PgBoss` (consuming all worker queues), N executor loop workers, the heartbeat, and the health-file timer.

---

## 5. Background-job surface (complete)

All queue names are module constants. Queues are pg-boss v12 queues created with `ensureQueueCreated` (`sync-queue.ts:44`), which no-ops when the name is already in `createdQueues`. **Only the worker process registers consumers**; the API and CLI create a subset of queues purely to enqueue.

### 5.1 pg-boss queues, schedules, and handlers

| Queue name | Constant / file | Create policy & options | Cron (tz) | Consumer (worker) | Handler → service |
|---|---|---|---|---|---|
| `sync.planner` | `SYNC_PLANNER_QUEUE` · sync-queue.ts:4 | exclusive; expireIn 120s, heartbeat 30s, retryLimit 2, retryDelay 30, backoff; DLQ `sync.planner.dlq` | `* * * * *` (no tz) | `boss.work` batchSize 1, includeMetadata | `runSyncPlannerCycle(app, boss)` (`sync/planner.ts`) — also run once at boot |
| `sync.planner.dlq` | `SYNC_PLANNER_DLQ_QUEUE` | standard; retention 1_209_600s (14d) | — | none | dead-letter sink |
| `sync.page.execute` | `SYNC_PAGE_EXECUTE_QUEUE` · sync-queue.ts:6 | exclusive; expireIn 180s, heartbeat 30s, retryLimit 2, retryDelay 30, backoff; DLQ `sync.page.execute.dlq` | — (enqueued by planner) | **custom `boss.fetch` loop** (§5.2), not `boss.work` | `processSyncPageExecuteJob` (Territory 06) |
| `sync.page.execute.dlq` | `SYNC_PAGE_EXECUTE_DLQ_QUEUE` | standard; retention 14d | — | none | dead-letter sink |
| `fansly.raw-payload-cleanup` | `RAW_PAYLOAD_CLEANUP_QUEUE` · sync-queue.ts:8 | standard | `0 2 * * *` (no tz) | `boss.work` batchSize 1 | `deleteExpiredRawPayloads(now)` + `deleteExpiredSyncObservability(now − retentionDays)` |
| `telegram.daily-report` | `TELEGRAM_DAILY_REPORT_QUEUE` · sync-queue.ts:9 | standard; retryLimit 2, retryDelay 60, backoff | `0 * * * *` (UTC) | `boss.work` batchSize 1 | resolve due date, backfill missing dates via `sendDailyRevenueTelegramReport` (throws on delivery `failed`) |
| `workboard.recompute` | `WORKBOARD_RECOMPUTE_QUEUE` · sync-queue.ts:10 | standard; retryLimit 1, retryDelay 60 | `0 3 * * *` (UTC) | `boss.work` batchSize 1 | `recomputeAllWorkboardPages(db, { now })` |
| `workboard.classify-closing` | `WORKBOARD_CLASSIFY_QUEUE` · sync-queue.ts:11 | standard; retryLimit 1, retryDelay 120 | `0 1 * * *` (UTC) | `boss.work` batchSize 1 | `runClosingClassificationAllPages(db, { config, now })` — **no-op unless `ANTHROPIC_API_KEY` set** |
| `ofapi.events.process.v2` | `OFAPI_EVENT_PROCESS_QUEUE` · ofapi-events.ts:59 | exclusive; retryLimit 2, retryDelay 30, backoff | — (enqueued on webhook receipt + by sweep) | `boss.work` batchSize **100** (`OFAPI_EVENT_PROCESS_BATCH_SIZE`) | sort jobs to receive order, then `processOfapiWebhookEvent(app, eventId)` each (settles row + `pg_notify`) |
| `ofapi.events.sweep` | `OFAPI_EVENT_SWEEP_QUEUE` · ofapi-events.ts:60 | exclusive | `* * * * *` (UTC) | `boss.work` batchSize 1 | `sweepPendingOfapiEvents` + DM/subscription/presence/spend projection sweeps + `runOfapiAccountHealthMonitor` + `runOfapiCreditBurnMonitor` |
| `ofapi.events.cleanup` | `OFAPI_EVENT_CLEANUP_QUEUE` · ofapi-events.ts:61 | standard | `30 2 * * *` (UTC) | `boss.work` batchSize 1 | `cleanupExpiredOfapiEvents` + `cleanupExpiredDmMessageArchive` |
| `ofapi.credits.accrual` | `OFAPI_CREDIT_ACCRUAL_QUEUE` · ofapi-credits.ts:34 | exclusive | `40 0 * * *` (UTC) | `boss.work` batchSize 1 | `runOfapiWebhookAccrual(app)` |
| `ofapi.credits.reconcile` | `OFAPI_CREDIT_RECONCILE_QUEUE` · ofapi-credits.ts:35 | exclusive | `5 * * * *` (UTC) | `boss.work` batchSize 1 | `runOfapiCreditReconciliation(app)` |
| `ofapi.credits.balance-ping` | `OFAPI_CREDIT_BALANCE_PING_QUEUE` · ofapi-credits.ts:36 | exclusive | `5 0 * * *` (UTC) | `boss.work` batchSize 1 | `runOfapiBalancePing(app)` |
| `ofapi.commands.execute` | `OFAPI_COMMAND_EXECUTE_QUEUE` · ofapi-command-executor.ts:23 | standard; **retryLimit 0** | — (enqueued via `sendOfapiCommandExecuteJob`, singletonKey=commandId) | `boss.work` batchSize 1 | `executeOfapiCommand(app, commandId)` per job |
| `ofapi.commands.sweep` | `OFAPI_COMMAND_SWEEP_QUEUE` · ofapi-command-executor.ts:24 | exclusive | `* * * * *` (UTC) | `boss.work` batchSize 1 | `sweepOfapiCommands(app, boss)` |
| `ofapi.dm-analytics.rebuild` | `OFAPI_DM_ANALYTICS_REBUILD_QUEUE` · ofapi-dm-analytics.ts:7 | exclusive | `10 * * * *` (UTC) | `boss.work` batchSize 1 | `rebuildRecentDmAnalytics(app)` |

Notes:
- The two `* * * * *` schedules registered without `tz` (`sync.planner`, `fansly.raw-payload-cleanup`) inherit pg-boss's default timezone; every other schedule pins `tz: "UTC"`.
- `sync.planner` is exclusive and singleton-scheduled; `queue planner-recover` (CLI) and `sendSyncPlannerWakeup` re-enqueue it manually (returns `null` if already queued/active).
- `sendSyncPageWakeup` (`sync-queue.ts:161`) enqueues `sync.page.execute` with `singletonKey` (defaults to `platformAccountId`), `priority`, `startAfter`, and a `group.id = buildSyncPageExecuteGroupId(provider, egressKey)` — the group id is how the executor enforces per-egress serialization.

### 5.2 Sync page executor — custom fetch loop (not `boss.work`)

`startSyncPageExecutor` (`sync/executor.ts:760`) spawns `app.config.syncPageExecutorConcurrency` copies of `runSyncPageExecutorWorker` and `Promise.all`s them. Each worker loops until `signal.aborted`:
- Serializes the `boss.fetch` step across workers via a shared `coordinator.fetchLock` (a chained promise).
- `boss.fetch(SYNC_PAGE_EXECUTE_QUEUE, { batchSize: 1, includeMetadata: true, priority: true, orderByCreatedOn: true, groupConcurrency: 1, ignoreGroups: <locally active groups> })` — pg-boss enforces one active job per group; `ignoreGroups` additionally excludes groups already running in this process.
- Tracks the job's `groupId` in `coordinator.localActiveGroups`, heartbeats via `boss.touch` every `PAGE_EXECUTOR_HEARTBEAT_MS`, runs `processSyncPageExecuteJob`, and on throw calls `boss.fail(...)`. Idle → `delay(PAGE_EXECUTOR_IDLE_POLL_MS)`.

This is the one queue consumed by hand rather than through `boss.work`, so it can implement in-process group affinity and cross-worker fetch coordination.

### 5.3 OFAPI event-worker singleton lock

`startOfapiEventWorker` (`ofapi-events.ts:434`) enforces exactly one consumer of the OFAPI event queues cluster:
- `assertOfapiEventWorkerSingleton` throws unless `OFAPI_EVENT_WORKER_REPLICAS === 1`.
- `acquireOfapiEventWorkerLock` takes a **session advisory lock** `pg_try_advisory_lock(58211, 1)` on a dedicated pool client; failure → `OfapiEventWorkerLockError`. Returns a release closure (`pg_advisory_unlock(58211, 1)`) that the worker `shutdown()` calls.

---

## 6. Health & liveness

Two independent liveness mechanisms plus a schema gate.

### 6.1 Schema-drift gate — `assertRuntimeSchemaReady`

Called by `createAppContext` before building services (`bootstrap.ts:136`). `packages/db/src/schema-guard.ts:63` reads the on-disk migration file list, asserts unique numeric prefixes, checks `schema_migrations` exists and contains the **latest** migration id, and asserts required tables (`pages`, `page_sync_states`, `page_sync_cursors`) exist while legacy tables (`platform_accounts`, `sync_state`, `raw_payloads`, …) are absent. On any mismatch it throws a `driftError` instructing `pnpm db:migrate`. This runs for **every** process/CLI invocation, so a schema-behind DB fails boot fast.

### 6.2 Runtime heartbeat — `runtime-heartbeat.ts` + `runtime_instances`

`startRuntimeHeartbeat(app, role, { startedAt?, stopTimeoutMs? })` (`runtime-heartbeat.ts:57`) publishes a per-process row so the dashboard Configuration view can show each api/worker instance and detect config drift. Mechanics:
- `instanceId = randomUUID()`; `imageTag = process.env.IMAGE_TAG ?? process.env.GIT_SHA ?? null`.
- `HEARTBEAT_INTERVAL_MS = 60_000`. Publishes immediately, then on an **unref'd** interval (never keeps the loop alive alone).
- Each beat: `effectiveConfig = await loadEffectiveConfig(app.db, app.config)` (§7.3/§9), then `upsertInstanceHeartbeat(db, { role, instanceId, startedAt, imageTag, running: buildRunningSnapshot(effectiveConfig, app.bootSkipped) })`, then best-effort `reapStaleInstances(db)`.
- Overlap/zombie guards: `inFlight` serializes beats; `stopped` flips on shutdown so an in-flight read does not upsert after `removeInstance`.
- `stop()` (`HEARTBEAT_STOP_TIMEOUT_MS = 5_000`): sets `stopped`, clears the timer, awaits any in-flight beat (bounded), then `removeInstance(db, role, instanceId)` (bounded). On timeout it logs and leaves the row for TTL cleanup.

`packages/db/src/repositories/runtime-instances.ts` backs this on the `runtime_instances` table (`schema.ts:2178`), PK `(role, instance_id)`, columns `started_at`, `last_seen_at`, `image_tag`, `running jsonb ($type<RunningSnapshot>)`, index on `last_seen_at`:

| Function | Behavior |
|---|---|
| `upsertInstanceHeartbeat` | Insert or `onConflictDoUpdate` on `(role, instanceId)`, setting `lastSeenAt = now`, `imageTag`, `running`. |
| `listActiveInstances(ttl = INSTANCE_STALE_TTL_MS = 3·60_000)` | Rows with `last_seen_at ≥ now − 3min`. |
| `listAllInstances` | All rows (view classifies stale by `last_seen_at`). |
| `removeInstance(role, instanceId)` | Hard-delete one row (graceful shutdown). |
| `reapStaleInstances(ttl = INSTANCE_REAP_TTL_MS = 30·60_000)` | Delete rows older than 30min; returns count. |

The `running` jsonb payload is a `RunningSnapshot` (`packages/shared/src/config-registry.ts:252`): `{ schemaVersion, values: Record<string, RunningValue>, skippedOverrides: SkippedOverride[] }` — the sanitized effective-config values this process consumes plus any boot-rejected overrides. TTLs: an instance shows as **stale** past 3 min and is **reaped** past 30 min.

### 6.3 Worker health file — `WORKER_HEALTH_FILE`

Only the worker writes it. When `process.env.WORKER_HEALTH_FILE` is set, `startWorkerServices` writes JSON `{ status, timestamp, pid }` (`writeWorkerHealthFile`, `worker-services.ts:96`): `"ready"` once services start and every 30s thereafter, `"stopping"` on shutdown. `docker-compose.production.yml` sets it to `/tmp/agency-hub-worker-health.json` and the worker container healthcheck fails if the file's mtime is older than 90s AND additionally probes Postgres (`select 1`). The API container has no health file; its healthcheck fetches `GET /api/v1/health` (§6.4). API vs worker liveness therefore advertise differently: **api** = accepting HTTP + `/api/v1/health` DB probe + heartbeat row (role `api`); **worker** = fresh health file + DB probe + heartbeat row (role `worker`).

### 6.4 HTTP health — `services/health.ts`

Two functions, both consumed by Territory-02 routes:
- `getSystemHealth(app)` (`health.ts:73`): runs `app.pool.query("select 1")`; returns `{ statusCode: 200, body: { status:"ok", checks:{ api:{status:"ok"}, database:{status:"ok", latencyMs, error:null} } } }`, or on failure `503` with `status:"degraded"` and a redacted `"Database check failed"`. Backs `GET /api/v1/health` (used by the Docker api healthcheck).
- `getPublicSyncHealth(app, { now?, pageIds? })` (`health.ts:122`): joins `listConnectionStatuses`, `getSyncStatusSnapshot`, and `loadEffectiveConfig` (one snapshot each, in parallel). Per page it computes issues (`connection:*`, `light_sync_missing/stale`, `follower_sync_missing/stale`, `failed_streams`, `stalled_streams`) using live thresholds `healthSyncLightMaxAgeMinutes` / `healthSyncFollowerMaxAgeMinutes` from the effective config, with special handling for OFAPI-mapped connections (`isOfapiMappedConnectionUsable`) and deep-backfill-only delays (`isDeepBackfillOnlyDelay`, which are excluded from health blocks). Returns `statusCode` 200/503 plus an `overall` summary and per-page array. Backs `GET /api/v1/health/sync`.

---

## 7. API server instantiation & static serving (`api/server.ts`)

Territory 02 owns the individual routes. Here only the composition seams.

### 7.1 Server construction

`buildApiServer(appContext)` (`api/server.ts:423`) creates a Fastify instance with `loggerInstance: appContext.logger`, `trustProxy: appContext.config.trustProxy`, and the Zod type provider. It sets the Zod validator/serializer compilers, decorates `request.auth`, and registers plugins: `@fastify/cookie`, `@fastify/rate-limit` (global off; per-route caps, e.g. login 20/60s), `@fastify/swagger` (OpenAPI 3.1 with cookie/bearer/`x-monitoring-token` security schemes), and `@fastify/swagger-ui` at `/documentation` gated to owner principals. A single `setErrorHandler` maps Zod validation errors, serialization errors, `AppError` subclasses, and Fastify-shaped errors to JSON envelopes. Routes are registered against `routeSchemas` from `packages/contracts/src/routes.ts`.

### 7.2 Enqueue-only pg-boss in the API process

`api/server.ts:1259-1276`: when `appContext.config.databaseUrl` is set, the API builds its **own** `PgBoss`, attaches a log-only error listener ("this instance merely enqueues jobs, and `/health` covers API liveness"), `boss.start()`, then `ensureSyncQueues`, `ensureOfapiQueues`, `ensureOfapiCommandQueues` (a subset — no schedules, no `boss.work`). An `onClose` hook stops it. This boss is used by inbound routes that trigger work: the OFAPI webhook receiver (`api/server.ts:1291`, its own buffer-body plugin scope) calls `receiveOfapiWebhook(appContext, boss, …)` which enqueues `ofapi.events.process.v2`; sync-trigger routes call `requestPageSync` / `requestAllPagesSync`; command routes call `sendOfapiCommandExecuteJob`. The API never consumes any queue.

### 7.3 Config reads at request time

Routes and health reads that need live-tunable values call `loadEffectiveConfig(app.db, app.config)` (§9), and `LIVE_CONFIG_KEYS` is imported for the staged-config surface. This is the same overlay the heartbeat uses, so reported and consumed values match.

### 7.4 Dashboard static serving (production only)

`api/server.ts:3569-3580`: `resolveDashboardDistPath()` (`api/server.ts:329`) walks ancestor dirs of `process.cwd()` and of the module dir looking for `apps/dashboard/dist/index.html`; returns the dir or `null`. When found, it dynamically imports `@fastify/static` and registers it at `prefix:"/"`, `wildcard:false`, and installs a `setNotFoundHandler` that returns `index.html` for any non-`/api/`, non-`/documentation` URL (SPA fallback) and a JSON 404 otherwise. When `dist` is absent (dev / contract generation) no static serving is registered — the dashboard is served by Vite separately (`pnpm dev:dashboard`).

---

## 8. Config resolution (`packages/shared/src/config.ts`)

`loadConfig(env = process.env, { loadDotEnv? })` (`config.ts:311`) optionally merges `.env`, parses `env` with a Zod `envSchema` into `AppConfig` (`config.ts:167`), derives encryption keys/ring, resolves Fansly delay aliases, checks the public-profile-resolution invariant, and folds Telegram/OFAPI/AI/workboard flags into typed fields. It throws on invalid encryption keys, an invalid public-profile config, or (via `checkSyncConcurrencyInvariant` in `bootstrap.ts`) an unsafe executor concurrency. The returned `AppConfig` is the boot baseline; the DB override overlay (`applyBootOverrides` at boot, `applyEffectiveOverrides` at runtime) sits on top.

Env vars most relevant to this territory (defaults from `envSchema`):

| Env var | AppConfig field | Default | Used by |
|---|---|---|---|
| `DATABASE_URL` | `databaseUrl` | (required) | pool creation, every PgBoss `connectionString`, migrations |
| `API_HOST` | `apiHost` | `0.0.0.0` | `server.listen` |
| `API_PORT` | `apiPort` | `3000` | `server.listen`, Docker healthcheck |
| `NODE_ENV` | `isProduction` | — (`=== "production"`) | cookie `secure` flag |
| `TRUST_PROXY` | `trustProxy` | (schema) | Fastify `trustProxy` |
| `LOG_LEVEL` | `logLevel` | (schema) | pino logger |
| `SYNC_PAGE_EXECUTOR_CONCURRENCY` | `syncPageExecutorConcurrency` | `4` | executor worker count; invariant with shared rate limit |
| `SYNC_SHARED_RATE_LIMIT_ENABLED` | `syncSharedRateLimitEnabled` | (schema) | concurrency invariant |
| `SYNC_OBSERVABILITY_RETENTION_DAYS` | `syncObservabilityRetentionDays` | (schema) | raw-payload-cleanup job |
| `OFAPI_API_KEY` | `ofapiApiKey` | `null` | gates `ofapi` client construction |
| `OFAPI_BASE_URL` | `ofapiBaseUrl` | `https://app.onlyfansapi.com/api` | OFAPI client |
| `OFAPI_EVENT_WORKER_REPLICAS` | `ofapiEventWorkerReplicas` | `1` | singleton assertion |
| `OFAPI_EVENT_RETENTION_DAYS` | `ofapiEventRetentionDays` | (schema) | event cleanup job |
| `ANTHROPIC_API_KEY` | `anthropicApiKey` | `null` | gates AI gateway + workboard classify |
| `CHATMUSE_AI_GATEWAY_ENABLED` | `chatMuseAiGatewayEnabled` | (schema) | gates `aiGatewayProvider` |
| `FANSLY_BASE_URL` | `fanslyBaseUrl` | `https://apiv3.fansly.com/api/v1` | Fansly adapter |
| `ONLYMONSTER_BASE_URL` | `onlyMonsterBaseUrl` | `https://omapi.onlymonster.ai` | OnlyFans adapter |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | `telegramBotToken/ChatId/Enabled` | `null`/`null`/false | Telegram delivery |
| `HEALTH_SYNC_MONITORING_TOKEN` | `healthSyncMonitoringToken` | `null` | `/api/v1/health/sync` token auth |

Env vars read **directly from `process.env`** (not via `AppConfig`), all within this territory: `AGENCY_HUB_ROLE` (role fallback, `startup.ts:36`), `WORKER_HEALTH_FILE` (`worker-services.ts:116`), `IMAGE_TAG` / `GIT_SHA` (heartbeat `imageTag`, `runtime-heartbeat.ts:64`), `DOTENV_CONFIG_QUIET` (`config.ts:320`).

---

## 9. Platform adapters & effective config

### 9.1 `provider.ts` — the adapter contract

`services/provider.ts` defines `ProviderAdapter<TContext, TAccountMe, TAccount, TTransaction, TSubscriber, TFollower>` — the interface both `FanslyAdapter` and `OnlyFansAdapter` satisfy: `getAccountMe`, `verifySession`, `getAccountsByIdsPage`, `getTransactionsPage`, `getSubscribersPage`, `getFollowersPage`, plus the paging response shapes (`ProviderPageResponse`, `ProviderFollowersPageResponse`). `bootstrap.ts:35` widens this to `AdapterLike` for Fansly with DM/earnings extensions (`getMessagingGroupsPage`, `getGroupDetail`, `getMessagesPage`, `getEarningsAccountsPage`, optional `close`). Adapters are constructed once per `AppContext` from the boot config's base URLs and delay knobs; there is **no runtime adapter registry** — the concrete adapter is chosen at each call site by page platform (`app.adapter` for Fansly, `app.onlyFansAdapter` for OnlyFans). Sync internals (how these are driven) are Territory 06.

### 9.2 `effective-config.ts` — live override overlay

`services/effective-config.ts` provides the runtime config overlay consumed by the heartbeat and live read-sites:
- `LIVE_CONFIG_KEYS` (`effective-config.ts:22`) = the set of `CONFIG_DESCRIPTORS` with `runtimeApply === "live"` — derived from the registry, the single source of truth.
- `applyEffectiveOverrides(config, overrides)` (pure): for each live key with a re-validated, clamped override, writes `validated.value` into the matching `descriptor.configField`; boot-mode and non-overridable keys are ignored; returns `config` unchanged if nothing applies.
- `loadEffectiveConfig(db, config)`: one `getConfigOverrides(db)` read layered over the boot config via the pure overlay. Called by the heartbeat (`runtime-heartbeat.ts:80`) and by health/route read-sites so `running` == what the process actually consumes. Non-live keys keep reporting the boot env value until a real restart.

---

## 10. Cross-process invariants summary

- **One migration writer at a time:** advisory lock `(31415, 27182)` in `startup.ts` around `runMigrations`.
- **One OFAPI event consumer:** advisory lock `(58211, 1)` in `startOfapiEventWorker`, plus `OFAPI_EVENT_WORKER_REPLICAS === 1` assertion. (Compose runs a single worker replica.)
- **API enqueues, worker consumes:** both connect PgBoss to the same `DATABASE_URL`; the API and CLI only call `ensure*Queues` + `send`/`fetch` helpers, never `boss.work`.
- **Liveness ordering:** heartbeat starts only after the api socket is listening / after worker queues are consuming; the worker also emits a filesystem health file.
- **Fail-fast on queue loss:** the worker's pg-boss `error` handler `process.exit(1)`; the API's only logs.

---

## 11. Boundaries in this territory

Data-crossing points touched by the composition/process layer (payload-level detail for routes/webhooks is expanded in Territories 02/OFAPI; here they are enumerated as composition seams):

- **Postgres (storage, bidirectional):** `createPool(databaseUrl)` and Drizzle `createDb(pool)` are built in `bootstrap.ts`. Writes: `runtime_instances` heartbeat rows (`upsertInstanceHeartbeat`), orphaned-run reaping, all queue tables (pg-boss schema), config-override reads. Reads: schema-guard probes, `getConfigOverrides`, health `select 1`. Advisory locks `(31415,27182)` and `(58211,1)`. `LISTEN/NOTIFY` channel `ofapi_sync_events` (worker `pg_notify`, API SSE hub listens).
- **pg-boss queue (internal, cross-process):** the API/CLI enqueue jobs consumed by the worker; full catalog in §5. Payloads: `{ platformAccountId }` (`sync.page.execute`), `{ eventId }` (`ofapi.events.process.v2`), `{ commandId }` (`ofapi.commands.execute`); planner/cleanup/report/rebuild jobs carry no data.
- **Inbound HTTP (API server):** `server.listen(apiHost:apiPort)` exposes the Fastify app; static SPA + `/documentation`. Enumerated in Territory 02.
- **Inbound webhook:** `POST /api/v1/ofapi/webhook` receiver wired into the API's enqueue-only boss (`receiveOfapiWebhook(appContext, boss, { rawBody, signatureHeader, idempotencyKeyHeader })`) — buffer-body plugin scope, HMAC-authenticated, journals + enqueues `ofapi.events.process.v2`.
- **Outbound HTTP — OFAPI (onlyfansapi.com):** `ofapi` client built when `OFAPI_API_KEY` set; `Bearer` auth to `OFAPI_BASE_URL` (default `https://app.onlyfansapi.com/api`); a `createOfapiCreditSpendSink({ db, logger, config })` callback records credit spend into Postgres on each billed call.
- **Outbound HTTP — Fansly & OnlyFans (via OnlyMonster):** `FanslyAdapter` → `FANSLY_BASE_URL` (default `https://apiv3.fansly.com/api/v1`); `OnlyFansAdapter` → `ONLYMONSTER_BASE_URL` (default `https://omapi.onlymonster.ai`). Driven by sync (Territory 06). CLI also probes `https://api.ipify.org` for egress-IP verification.
- **Outbound HTTP — Anthropic (AI provider):** `aiGatewayProvider` built via `createAnthropicAiGatewayProvider` when `CHATMUSE_AI_GATEWAY_ENABLED && ANTHROPIC_API_KEY`; the Anthropic SDK client is resolved per page and **routed through that page's configured proxy** (`createPageProxyAnthropicClientResolver`, throws if the page has no proxy). Consumed by the `/api/v1/ai/gateway/stream` SSE route and the workboard closing classifier.
- **Outbound — Telegram:** daily-report worker + CLI `telegram test/report` send messages via the Telegram Bot API using DB/env-resolved credentials (Territory covering notifications has detail).
- **SSE (outbound stream):** `/api/v1/events/stream` and `/api/v1/ai/gateway/stream` hijack the raw socket and stream `text/event-stream`; the sync-event hub bridges Postgres `NOTIFY ofapi_sync_events` to subscribers. Managed within `buildApiServer` (Territory 02 for frame shapes).
- **Secrets/credentials:** `APP_ENCRYPTION_KEY`(+ring/version) parsed in `loadConfig`; `OFAPI_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `HEALTH_SYNC_MONITORING_TOKEN` read from env; per-page platform tokens and proxy passwords stored encrypted in Postgres (resolved by page-context services).
