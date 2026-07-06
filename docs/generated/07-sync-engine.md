> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Sync Engine

This document maps the pull-ingest pipeline that fetches platform data on a
schedule: the planner that decides which pages are due, the `page_sync_states`
FSM, the executor coordinator that serializes fetches and leases chunks of work,
the chunk budget and failure classification (including the auth-pause behavior),
the 11 sync streams, the registry-dispatched `executeStreamChunk` that routes to
per-platform handler halves (Stage 18), how each stream's results dual-write into
`raw_payloads` and `observations`, the cursor/checkpoint shapes, the rate
limiter, telemetry, and failed-fetch journaling. Every fetched page feeds the
capture spine documented in `06-capture-and-canonicalization.md`. Sources are
anchored to `file:line`.

## 1. Scheduling and dispatch model

The sync queues live in `services/sync-queue.ts`:

- **Planner queue** `sync.planner`, cron `* * * * *` (`sync-queue.ts:113`).
- **Page-executor queue** `sync.page.execute`, with DLQs
  (`sync-queue.ts:5-8`).
- **Per-page scheduling:** `sendSyncPageWakeup` uses
  `singletonKey = platformAccountId` so at most one job per page is in flight
  (`sync-queue.ts:184`), plus a numeric `priority`.

## 2. Planner

`runSyncPlannerCycle` (`sync/planner.ts:20`) runs the scheduling cycle:

- Closes inactive runs (older than 90s, `planner.ts:17`, `:25`).
- `ensurePageSyncStates` provisions FSM rows.
- Pauses disabled OnlyFans DM / audience / top-spender streams by config
  (`planner.ts:42-59`).
- `scheduleDuePageSync`, then `listRunnablePageSync` → per page
  `sendSyncPageWakeup` + `markPageSyncEnqueued` (`planner.ts:62-74`).
- Dependency flags are computed via `pageSyncDependencyInput` (gated on
  `ofapiDmSyncEnabled`; `sync/dependencies.ts`).

## 3. Executor coordinator

`startSyncPageExecutor` (`sync/executor.ts:779`) spawns
`syncPageExecutorConcurrency` workers over one shared `ExecutorCoordinator`,
which combines a serialized fetch lock with a `localActiveGroups` set that
enforces group-concurrency 1 per page (`executor.ts:705-777`).

`executeNextSyncPageChunk` (`executor.ts:324`) is the unit of work:

1. `acquirePageSyncLease` (TTL 120s, `executor.ts:47`/`:332`).
2. Starts a sync run and a `SyncRunTelemetry`, a `SyncChunkBudget`, and lease
   plus run heartbeats (`executor.ts:353-378`).
3. Calls `executeStreamChunk` inside `runWithPageSyncExecutionContext`
   (`executor.ts:382`).
4. Result handling: `satisfied` → `completePageSync`; otherwise `yieldPageSync`
   (a continuation); a lease-fenced result goes idle.

`processSyncPageExecuteJob` (`executor.ts:659`) loops continuations locally up to
`MAX_LOCAL_EXECUTOR_CHUNKS = 500` (`executor.ts:48`), and re-wakes for delayed
continuations using `singletonKey <pageId>:dm-messages-deep-continuation`.

Supporting locking primitives: `withPageSyncLock` (`sync/locking.ts`).

## 4. Chunk budget

`SyncChunkBudget` (`sync/chunk-budget.ts`) is constructed with
`maxRequests = 5` and `maxWallClockMs = 45000`, and implements
`HttpRequestObserver`. `shouldYield` fires on either the request budget or the
wall clock, with yield reason `request_budget` or `wall_clock`.

## 5. Failure classification and the auth pause

`classifyTaskFailure` (`sync/executor.ts:182`) maps errors to a retry/block
decision:

| Condition | Decision | Reason |
|---|---|---|
| `FanslyApiError` 429 | retry | `rate_limit` |
| status ≥ 500 | retry | `provider_5xx` |
| status ≥ 400 | blocked | `provider_bad_data` |
| cursor errors | blocked | `invalid_cursor` |
| `http_5xx` / timeout | retry | (transient) |
| "manual action" / "shared rate limit" | blocked | `manual_action_required` |
| default | retry | `transient_network` |

Retry vs block routes to the `retryPageSync` / `blockPageSync` DB functions.
**Auth errors (401/403, `executor.ts:67`)** call `blockPageSync` and then
`pausePageSyncForAuth`, which **parks every stream for the page** (Stage 26,
`executor.ts:543`), and fire `notifyAuthFailedIncident`.

Error normalization: `normalizeSyncError` and `SyncPayloadPersistenceError`
(`sync/errors.ts`).

## 6. The sync streams and per-platform dispatch

The stream set `SYNC_STREAMS` (`packages/db/.../page-sync.ts:15`) has 11 entries:
`light`, `fan_identities`, `transactions`, `top_spenders`, `subscribers`,
`followers`, `followers_reconcile`, `dm_conversations`, `dm_messages`,
`fan_earnings`, `purchase_history`. They fall into domains `connection`,
`financials`, `audience`, `messages_live`, `messages_history`
(`page-sync.ts:31`).

`executeStreamChunk` (`sync/executor-handlers.ts:3786`) is **registry-dispatched**
(Stage 18): it looks up `appPlatformRegistry.get(platform).pull[stream]`
(`executor-handlers.ts:3817`); an undeclared stream throws loudly. The registry
lives at `apps/runtime/src/platforms/registry.ts`, where `FANSLY_PULL`
(`registry.ts:97`) and `ONLYFANS_PULL` (`registry.ts:110`) map streams to
handler halves:

- **Fansly:** `fanslyLightChunk`, `fanslyTransactionsChunk`,
  `fanslyTopSpendersChunk`, `fanslySubscribersChunk`, `executeFollowersChunk`,
  `executeFollowersReconcileChunk`, `fanslyDmConversationsChunk`,
  `fanslyDmMessagesChunk`, `executeFanEarningsChunk`,
  `executePurchaseHistoryChunk`.
- **OnlyFans:** `onlyfansLightChunk`, `onlyfansTransactionsChunk`,
  `executeFanIdentitiesChunk`, `onlyfansTopSpendersChunk`,
  `onlyfansSubscribersChunk`, `onlyfansDmConversationsChunk`,
  `onlyfansDmMessagesChunk`.

Handler bodies live in `sync/executor-handlers.ts` (exports at `:852-3785`).

## 7. How each stream's results enter observations

Every fetched page goes through `persistRawPayload` (`sync/shared.ts:79`), which
(a) inserts a `raw_payloads` row and (b) **dual-writes an observation** with
`source = pull`, `kind = <endpoint>`, `producer = sync:<platform>:<stream>`
(`shared.ts:98-133`). The observations then canonicalize as described in
`06-capture-and-canonicalization.md` §4.

Endpoints observed and their downstream canonical events:

- **transactions** — `syncTransactions` (`sync/transactions.ts:1436`), a
  backfill/incremental state machine with a single-writer gate
  (`assertPageTransactionsWriter`), persists endpoint `earnings_transactions`
  (`transactions.ts:733`/`:1248`) → `transaction.posted`.
- **OFAPI OnlyFans DM** (`sync/ofapi-dm-sync.ts`):
  `executeOfapiDmConversationsChunk` (`:500`, persists endpoint
  `dm_conversations`, `:562`) and `executeOfapiDmMessagesChunk` (`:828`,
  persists `dm_messages`, `:931`); `dm_messages` canonicalizes to `message.*`.
  A credit/request budget guard `createOfapiRestGuard` (`ofapi-dm-sync.ts:168`)
  can block with reasons `ofapi_request_budget`, `ofapi_daily_credit_budget`, or
  `ofapi_credit_floor` (`:118`).
- **OFAPI OnlyFans audience** (`sync/ofapi-audience-sync.ts`):
  `executeOfapiAudienceChunk` (`:269`, endpoint `fans_active`, `:439`); the
  stream list `ONLYFANS_AUDIENCE_STREAMS` (`:64`); generation-based
  end-of-sweep expiry.
- **fan-earnings / purchase-history** (Fansly bulk;
  `executor-handlers.ts:3494` / `:3655`) → `fan.earnings_observed` /
  `message.ppv_unlocked`.
- **fan identities** — `syncOfapiFanIdentities`
  (`sync/ofapi-fan-identities.ts:114`); **top spenders**
  (`sync/onlyfans-top-spenders.ts`); **followers / subscribers**
  (`executor-handlers.ts`). Fan hydration lives in `sync/fan-hydration.ts`.

## 8. Cursor and checkpoint shapes

Cursor/checkpoint state for the streams is defined in `sync/cursor-state.ts`,
covering `subscribers`, `followers`, `followers_reconcile`, `dm_conversations`
(`full_scan` + ofapi), `ofapi_audience`, `dm_messages`
(`backfill` / `deep_backfill` / `incremental`), and `top_spenders`. The
transaction backfill state is in `sync/transaction-backfill.ts`.

## 9. Rate limiting, observability, and failed-fetch journaling

- **Rate limiter:** `createSyncRateLimitWaiter` (`sync/rate-limiter.ts`).
- **Telemetry:** `SyncRunTelemetry` (`sync/observability.ts:368`), the telemetry
  class with anomaly and checkpoint summaries. CLI status/watch rendering lives
  in `sync/view.ts`.
- **Failed-fetch journaling:** `persistFailedSyncPayload` (`sync/shared.ts:368`)
  writes a `raw_payloads` row (kind failed) plus an observation with kind
  `<endpoint>:failed` — so even failed fetches are captured
  (see `06-capture-and-canonicalization.md` §2, producer #3).

A note on retention: the raw-payload cleanup schedule exists but is a no-op —
retention was stood down (`sync/shared.ts:29-33`).
