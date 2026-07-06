> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Territory 06 — Sync Engine

**Scope.** This document covers the ingest pipeline that pulls platform data into Postgres. It reads every file in `apps/runtime/src/services/sync/*.ts` (`planner.ts`, `sync-queue.ts` is one level up, `executor.ts`, `executor-handlers.ts`, `cursor-state.ts`, `dependencies.ts`, `chunk-budget.ts`, `locking.ts`, `rate-limiter.ts`, `errors.ts`, `observability.ts`, `shared.ts`, `onlyfans-identities.ts`, `onlyfans-transactions.ts`, `onlyfans-top-spenders.ts`, `onlyfans-dm-polling.ts`, `ofapi-dm-sync.ts`, `ofapi-audience-sync.ts`, `transactions.ts`, `transaction-backfill.ts`, `fan-hydration.ts`, `view.ts`) plus the sync services in `apps/runtime/src/services/`: `sync.ts`, `sync-queue.ts`, `sync-control.ts`, `sync-status.ts`, `sync-summary.ts`, `sync-blocks.ts`, `sync-monitor.ts`, `sync-monitor-view.ts`, `sync-ux.ts`. Because the entire state machine lives in the DB layer, it also reads `packages/db/src/repositories/page-sync.ts` and the sync tables in `packages/db/src/schema.ts`. Wiring into the worker (`apps/runtime/src/worker-services.ts`), HTTP routes (`apps/runtime/src/api/server.ts`), and CLI (`apps/runtime/src/cli.ts`) is traced where it bounds the territory. Adapter internals (Fansly / OnlyMonster / OFAPI transport) are cross-referenced to territories 07 and 08; the transactions/spend projection tables are cross-referenced to territory 09.

---

## 1. Shape of the pipeline

Sync runs in the **worker** process (`apps/runtime/src/worker-services.ts`), not the API. Three moving parts:

1. **Planner** (`sync/planner.ts` → `runSyncPlannerCycle`) runs once a minute on a pg-boss cron. It advances the per-page/per-stream state machine (`page_sync_states`) and enqueues one "wakeup" job per runnable page.
2. **pg-boss queues** (`sync-queue.ts`) carry two message types: `sync.planner` (cron trigger) and `sync.page.execute` (per-page wakeup, one job payload = `{ platformAccountId }`).
3. **Executor** (`sync/executor.ts` → `startSyncPageExecutor` / `processSyncPageExecuteJob`) fetches `sync.page.execute` jobs, leases the highest-priority runnable stream for that page, and runs one bounded **chunk** of that stream's handler (`sync/executor-handlers.ts` → `executeStreamChunk`). A chunk either completes the stream, yields (budget exhausted, resume later), or fails (retry / block).

The unit of work is a **(page, stream) task**. A page has one row in `page_sync_states` per applicable stream. The planner never picks streams; it enqueues a page, and the executor's DB lease query (`acquirePageSyncLease`) picks the single highest-priority runnable stream for that page each chunk.

Data flows **out** to three provider surfaces (Fansly HTTP via `app.adapter`, OnlyFans-via-OnlyMonster via `app.onlyFansAdapter`, OnlyFans-via-OFAPI via `app.ofapi`) and **in** to Postgres (fans, subscriptions, follows, transactions, DM conversations/messages, top-spender rankings, plus raw-payload capture and full run/attempt/event observability).

---

## 2. Sync streams, domains, work classes

Streams are the enum `syncStreamEnum` (`packages/db/src/schema.ts:50`) and the `SYNC_STREAMS` const (`page-sync.ts:16`). Policy per stream is `SYNC_STREAM_POLICY` (`page-sync.ts:78`).

| Stream | Domain | Cadence | Base priority | streamIndex | Default work class | Freshness SLA |
|---|---|---|---|---|---|---|
| `light` | connection | 3600 s | 60 | 1 | live | 3 h |
| `transactions` | financials | 3600 s | 50 | 2 | live | 3 h |
| `fan_identities` | financials | 6 h | 49 | 3 | maintenance | none |
| `top_spenders` | financials | 3600 s | 45 | 4 | maintenance | none |
| `subscribers` | audience | 3600 s | 40 | 5 | live | 3 h |
| `followers` | audience | 3600 s | 35 | 6 | live | 3 h |
| `followers_reconcile` | audience | 172800 s | 34 | 7 | maintenance | none |
| `dm_conversations` | messages_live | 1800 s | 30 | 8 | live | 1 h |
| `dm_messages` | messages_history | 86400 s | 25 | 9 | history | none |

Domains (`SYNC_DOMAINS`, `page-sync.ts:30`; `SYNC_DOMAIN_POLICY`, `page-sync.ts:180`) group streams into the five UI "blocks": `connection`, `financials`, `audience`, `messages_live`, `messages_history`. Each domain has primary vs supporting streams (e.g. financials primary = `transactions`, supporting = `fan_identities`, `top_spenders`).

**Which streams exist per platform** — `getSyncStreamsForPlatform` (`page-sync.ts:533`):
- **Fansly**: all streams except `fan_identities`.
- **OnlyFans**: `light`, `transactions`, `fan_identities`, `top_spenders`, `subscribers`, `dm_conversations`, `dm_messages` — **no `followers` / `followers_reconcile`**. For OnlyFans, `subscribers` is the OFAPI audience sweep and `top_spenders` is DB-computed; the planner force-pauses both for pages that are not flag-eligible (see §9).

**Work classes** (`SyncWorkClass`, `page-sync.ts:47`): `live | history | maintenance`. The executor recomputes the current class per chunk from the handler's `stats.currentMode` (`resolveCurrentWorkClass`, `executor.ts:298`): `backfill`/`deep_backfill` → `history`, `incremental` → `live`; otherwise falls back to the lease's stored class or a per-stream default.

**Priority by request source** — `SYNC_STREAM_PRIORITY_BY_SOURCE` (`page-sync.ts:227`). Six sources: `scheduled`, `recovery`, `anomaly`, `manual`, `onboarding`, `reset`. `scheduled` = base priority; `recovery`/`anomaly` add ~10; `manual`/`onboarding`/`reset` are 100/90/… (highest). A page's queue priority is the **max** priority over its runnable streams (`listRunnablePageSync`, `page-sync.ts:1255`).

### Dependency model

`SYNC_STREAM_DEPENDENCIES` (`page-sync.ts:213`):
- `top_spenders` → `transactions`
- `followers_reconcile` → `followers`
- `dm_conversations` → `light, top_spenders, transactions, subscribers, followers`
- `dm_messages` → `light, top_spenders, transactions, subscribers, followers, dm_conversations`

A dependency is "met" when the dependency stream has `succeededAt != null` OR `appliedSeq > 0` (`dependencyMet`, `page-sync.ts:996`). Unmet dependencies **block** the dependent stream with `blockerKind='dependency'`, `blockerCode='unmet_dependency'` (`refreshLockedPageSyncDependencies`, `page-sync.ts:1021`). When deps become met, the block clears back to `pending`/`idle`.

For OFAPI-fed OnlyFans DM streams the legacy ordering deps are stripped: when a page is OnlyFans + has an `ofapiAccountId` + `OFAPI_DM_SYNC_ENABLED`, `dm_conversations`/`dm_messages` drop the `light/transactions/subscribers/followers/top_spenders` prerequisites (`ONLYFANS_OFAPI_DM_EXCLUDED_DEPENDENCIES`, `page-sync.ts:916`; gated by `pageSyncDependencyInput`, `sync/dependencies.ts:17`, which only turns on when `app.config.ofapiDmSyncEnabled === true`).

---

## 3. Planner — `sync/planner.ts`

`runSyncPlannerCycle(app, boss, now)` (`planner.ts:20`), called from the `sync.planner` pg-boss worker every minute (`worker-services.ts:150`) and once at worker boot (`worker-services.ts:212`). Steps:

1. `closeInactiveSyncRuns` — auto-closes `sync_runs` rows with no heartbeat for 90 s (`INACTIVE_SYNC_RUN_THRESHOLD_MS`, `planner.ts:17`), marking them failed/partial with summary `"Sync run auto-closed after inactivity"`.
2. `ensurePageSyncStates` — seeds any missing `(page, stream)` rows for all pages (see §8), and reconciles cadence/slot offsets.
3. **Force-pause disabled OnlyFans streams** for all pages: `pauseDisabledOnlyFansDmPollingForAllPages`, `pauseDisabledOnlyFansAudienceForAllPages`, `pauseDisabledOnlyFansTopSpendersForAllPages` (`planner.ts:42-59`). Each sets `status='paused'` on the relevant streams unless the page is flag-eligible.
4. `scheduleDuePageSync` — bumps `request_seq` on streams whose cadence slot has advanced (`page-sync.ts:1160`), then refreshes dependency blocks.
5. `listRunnablePageSync` (`page-sync.ts:1255`) returns pages with any stream where `request_seq > applied_seq`, not paused, no blocker, not leased, and past its `retry_at`. For each such page, `sendSyncPageWakeup` enqueues a `sync.page.execute` job and `markPageSyncEnqueued` stamps `enqueued_at`.

The planner emits **no** external calls; it is pure DB + queue enqueue.

---

## 4. Queues — `services/sync-queue.ts`

pg-boss queue names and options (`ensureSyncQueues`, `sync-queue.ts:58`):

| Queue const | Name | Policy | Notes |
|---|---|---|---|
| `SYNC_PLANNER_QUEUE` | `sync.planner` | exclusive | expireIn 120 s, heartbeat 30 s, retryLimit 2, backoff, DLQ `sync.planner.dlq`. Cron `* * * * *` (`ensurePlannerSchedule`, `sync-queue.ts:104`). |
| `SYNC_PAGE_EXECUTE_QUEUE` | `sync.page.execute` | exclusive | expireIn 180 s, heartbeat 30 s, retryLimit 2, backoff, DLQ `sync.page.execute.dlq`. **Not** registered via `boss.work`; the executor calls `boss.fetch` directly (§5). |
| `RAW_PAYLOAD_CLEANUP_QUEUE` | `fansly.raw-payload-cleanup` | standard | Cron `0 2 * * *`; deletes expired raw payloads + observability (`worker-services.ts:157`). |
| `TELEGRAM_DAILY_REPORT_QUEUE` | `telegram.daily-report` | standard | Hourly; out of scope. |
| `WORKBOARD_*` | — | standard | Out of scope. |

`sendSyncPageWakeup` (`sync-queue.ts:161`) sends the payload `{ platformAccountId }` with:
- `singletonKey` = `String(platformAccountId)` by default (dedupe: only one queued wakeup per page). Delayed continuations pass an explicit key like `${pageId}:dm-messages-deep-continuation` and `dedupe=false`.
- `priority` from the runnable-page priority.
- `group.id` = `buildSyncPageExecuteGroupId(provider, egressKey)` (from `@agency_hub_core/shared`) — pg-boss **group concurrency** keys sync work by provider+egress (proxy) so one proxy/egress endpoint isn't hammered by concurrent pages.
- `startAfter` for delayed retries.

`SyncTriggerScope` (`sync-queue.ts:13`) is the manual-trigger scope enum: `light | followers | all | data | messages`.

---

## 5. Executor — `sync/executor.ts`

`startSyncPageExecutor(app, boss)` (`executor.ts:760`) spins `app.config.syncPageExecutorConcurrency` worker loops sharing one `ExecutorCoordinator` (`fetchLock` mutex + `localActiveGroups` set). Each loop (`runSyncPageExecutorWorker`, `executor.ts:686`):
- Serializes `boss.fetch(SYNC_PAGE_EXECUTE_QUEUE, { batchSize:1, groupConcurrency:1, ignoreGroups: activeGroupIds, priority:true, orderByCreatedOn:true })` behind `fetchLock`, so two local workers never take jobs from the same provider+egress group at once.
- Heartbeats the pg-boss job every 15 s (`boss.touch`).
- Runs `processSyncPageExecuteJob`, then `boss.complete`; on throw, `boss.fail` with the error message (feeds the DLQ after retries).

`processSyncPageExecuteJob` (`executor.ts:640`) loops `executeNextSyncPageChunk` while the previous chunk requests continuation, up to `MAX_LOCAL_EXECUTOR_CHUNKS = 500` (`executor.ts:47`). When a chunk yields with a delayed retry it re-enqueues a fresh wakeup (`sendSyncPageWakeup`) instead of looping locally.

`executeNextSyncPageChunk` (`executor.ts:323`) is the core:
1. `ensurePageSyncStates` for the page; `pauseDisabledOnlyFansDmPollingForPage`.
2. `acquirePageSyncLease` (`page-sync.ts:1318`): atomic `UPDATE` that picks the highest-priority runnable stream, sets `status='running'`, `leased_seq=request_seq`, `lease_owner`, `lease_token` (a `randomUUID`), and `lease_expires_at = now + 120 s` (`SYNC_TASK_LEASE_TTL_MS`, `executor.ts:46`). Returns the full lease row incl. `platform`, `proxyUrl`, `egressKey`. If no runnable stream: returns `kind:"idle"`.
3. Creates a `sync_runs` row (`startSyncRun`) and a `SyncRunTelemetry` (§11); starts a 30 s run heartbeat and a 30 s **lease heartbeat** (`heartbeatPageSyncLease`). If a lease heartbeat reports the lease is no longer owned (`owned=false`), a `leaseFenced` flag aborts the chunk as `idle` ("lease lost").
4. Resolves the page context (`resolveExecutorPageContext`, `executor-handlers.ts:4066` — OFAPI-owned streams get a stub `auth.token=""`) and runs `executeStreamChunk` inside `runWithPageSyncExecutionContext` (AsyncLocalStorage carrying `{ pageId, stream, requestSeq, leaseToken }`, used by `assertOwnedPageSyncLease` inside handlers to fence writes).
5. On the `StreamChunkResult`:
   - `satisfied:true` → `completePageSync` (`page-sync.ts:1500`): `applied_seq=max(applied_seq, requestSeq)`, `succeeded_at=now`, clears lease/blocker, refreshes deps. Telemetry `finish("success")`, resolves any open failure incidents, returns a continuation if the page still has runnable streams.
   - `satisfied:false` → `yieldPageSync` (`page-sync.ts:1562`): back to `status='pending'`, sets optional `retry_at` (for delayed continuations). Telemetry `finish("partial")` with `yieldReason`.
   - throw → failure path (below).

**Failure classification** — `classifyTaskFailure` (`executor.ts:181`):
- `FanslyApiError`/`OnlyMonsterApiError` with status 429 → retry class `rate_limit`; ≥500 → `provider_5xx`; ≥400 → **block** `provider_bad_data`.
- Auth errors (401/403, `isAuthError`) → `blockPageSync` with `blockerKind='auth'`, `blockerCode='credentials_invalid'`, and fires `notifyAuthFailedIncident`.
- Summary/code containing "cursor" → block `invalid_cursor`; `http_429`/"429" → retry `rate_limit`; `http_5*`/"timeout" → retry `provider_5xx`/`transient_network`; "manual action"/"shared rate limit" → block `manual_action_required`; else retry `transient_network`.

Retry (`retryPageSync`, `page-sync.ts:1615`) sets `status='retrying'` and `retry_at = now + min(60·2^(failures-1), 1800) s` exponential backoff. Block (`blockPageSync`, `page-sync.ts:1678`) sets `status='blocked'`. Every failure persists a `failed`-kind raw payload (`persistFailedSyncPayload`) and fires `notifySyncChunkFailureIncident`. `PageSyncLeaseLostError` and stale-seq updates are treated as idle/no-op ("lease lost").

`runSyncPageExecutorUntilIdle` (`executor.ts:780`) is a synchronous drain used by the CLI and tests.

---

## 6. `page_sync_states` state machine — `repositories/page-sync.ts`

Table `page_sync_states` (`schema.ts:415`), PK `(page_id, stream)`. Status enum (`PageSyncStatus`): `idle | pending | running | retrying | blocked | paused`. Progress is tracked by three monotonic counters:
- `request_seq` — bumped when work is requested (cadence tick or manual/anomaly request).
- `leased_seq` — set to `request_seq` when a chunk leases the task.
- `applied_seq` — bumped to `request_seq` on successful completion.

A stream is **runnable** iff `request_seq > applied_seq` AND not paused AND `blocker_kind IS NULL` AND `leased_seq IS NULL` AND `retry_at` elapsed (`listRunnablePageSync`, `page-sync.ts:1271`).

Scheduling uses a hash-distributed slot: `computePageSyncSlotOffsetSeconds(pageId, stream)` (`page-sync.ts:555`) spreads pages across each stream's cadence window; `scheduleDuePageSync` bumps `request_seq` only when the current slot exceeds `last_scheduled_slot` (`page-sync.ts:1219`).

Leasing/heartbeat/reclaim:
- `acquirePageSyncLease` sets `lease_expires_at = now + ttl`.
- `heartbeatPageSyncLease` (`page-sync.ts:1414`) extends it; returns false if the token no longer matches (fencing).
- `reclaimExpiredPageSync` (`page-sync.ts:1116`) resets rows whose `lease_expires_at` has passed back to blocked/retrying/pending/idle. Called inside `scheduleDuePageSync`.

Lifecycle mutators (all fence on `lease_token` + `leased_seq` to avoid a stale worker clobbering a re-leased task): `completePageSync`, `yieldPageSync`, `retryPageSync`, `blockPageSync`, `clearPageSyncLease`, `recordRunningPageSyncProgress`, plus operator actions `pausePageSync`, `resumePageSync`, `resetPageSync` (keeps auth blocks), `requestPageSync` (bumps `request_seq`, sets source + optional per-stream `request_payload`), and auth helpers `markPageSyncAuthBlocked` / `clearPageSyncAuthBlock`.

Seeding (`buildSeedPageSyncState`, `page-sync.ts:598`): new rows are `idle` with `succeeded_at`/`finished_at` set from the page's trusted `last_light_sync_at`/`last_follower_sync_at` when present; otherwise `pending` with source `recovery` (or `onboarding`). `followers_reconcile` seeds pending only when Fansly follower counts diverge.

---

## 7. Per-stream handlers — `sync/executor-handlers.ts` + per-stream files

`executeStreamChunk` (`executor-handlers.ts:4093`) first short-circuits OnlyFans DM streams when polling is disabled and the page is not OFAPI-eligible (`shouldSkipOnlyFansDmPolling`, `:152` — returns `satisfied:true, stats.disabledByConfig`), then `switch`es on `streamState.stream`. Every handler returns `StreamChunkResult { satisfied, yieldReason, continuationRetryAt?, continuationRequestSource?, stats? }` and reads the request budget (`SyncChunkBudget`, §10) between provider calls, yielding when `budget.shouldYield()`.

### Outbound provider calls (the ingest boundary)

| Adapter | Method | Used by |
|---|---|---|
| `app.adapter` (Fansly) | `getAccountMe` | `light`, `followers` bootstrap (`shared.ts:298`) |
| | `getAccountsByIdsPage` | fan hydration (`fan-hydration.ts:62`), follower/partner probes |
| | `getSubscribersPage` | Fansly `subscribers` (`:1644`) |
| | `getFollowersPage` | Fansly `followers` / `followers_reconcile` (`:1889`, `:2158`) |
| | `getTransactionsPage` | Fansly `transactions` (`transactions.ts`) |
| | `getEarningsAccountsPage` | Fansly `top_spenders` (`:1056`, `:1222`) |
| | `getMessagingGroupsPage`, `getGroupDetail`, `getMessagesPage` | Fansly `dm_conversations` / `dm_messages` (`:2760`, `:2859`, `:2917`, `:3724`) |
| `app.onlyFansAdapter` (OnlyMonster) | `getAccount` | OnlyFans `light` (`shared.ts:320`) |
| | `getTrackingLinkUsersPage`, `getTrialLinkUsersPage` | OnlyFans `fan_identities` (`onlyfans-identities.ts:475/480`) |
| | `getTransactionsPage`, `getChargebacksPage` | OnlyFans `transactions` (`onlyfans-transactions.ts`) |
| | `getRecentChatFanIds`, `getChatMessagesPage` | legacy OnlyFans DM polling (`:2440`, `:2487`, `:3287`) |
| `app.ofapi` (OFAPI REST) | `listChats` | OFAPI `dm_conversations` (`ofapi-dm-sync.ts:547`) |
| | `listChatMessages` | OFAPI `dm_messages` (`ofapi-dm-sync.ts:897`) |
| | `listActiveFans` | OFAPI `subscribers` audience sweep (`ofapi-audience-sync.ts:428`) |

Every provider call is wrapped with a `requestObserver` composed from telemetry + the chunk budget (`composeRequestObservers`, `chunk-budget.ts:53`) and an optional `rateLimitWaiter` (§10).

### Handler details

**`light`** (`executor-handlers.ts:949`) — `refreshPageMetadata` (`shared.ts:275`) calls Fansly `getAccountMe` or OnlyFans `getAccount`, then `updatePageMetadata` writes username/displayName/follower+subscriber counts/earnings balance + `metadata`, and `updatePageSyncTimestampCache(syncType:"light")` stamps `pages.last_light_sync_at`. No cursor.

**`fan_identities`** (OnlyFans only, `:1476` → `syncOnlyFansIdentities`, `onlyfans-identities.ts:526`) — paginates the OnlyMonster **tracking-link** then **trial-link** user feeds by `(collectedFrom, collectedTo, cursor)`; upserts `fans` + `fan_pages` (`upsertOnlyFansLinkUsersPage`, `:216`); optional public-profile fallback resolution (`upsertOnlyFansPublicProfileResolution`). Cursor: `page_sync_cursors` state carries phase/cursor/collectedTo/newestCollectedAt.

**`transactions`** (`:1509`) — resolves live window scalars from `loadEffectiveConfig` (`transactionLookbackDays`, `transactionRescanCapDays`), then dispatches:
- Fansly → `syncTransactions` (`transactions.ts:1431`): `getTransactionsPage`, hydrates fans (`upsertHydratedFansForPage`), `upsertTransaction`, then `rebuildSpenderProjections` + `rebuildRevenueRollups` from a `dirtyFrom` watermark. Incremental + backfill modes (`transaction-backfill.ts` cursor shapes).
- OnlyFans → `syncOnlyFansTransactions` (`onlyfans-transactions.ts:1996`): `getTransactionsPage` + `getChargebacksPage`, `upsertFans`/`upsertFanPages`/`upsertTransaction`, same rebuilds. Honors a `requestPayload.onlyFansTransactionsStart` rescan start.
- Both persist raw payloads (`persistRawPayload`). **See territory 09** for the transaction/spend projection tables.

**`top_spenders`** (`:990`) — Fansly: month-window bootstrap + trailing-7-day steady state via `getEarningsAccountsPage`, splitting windows month→week→day when the provider caps the response (`splitTopSpendersWindow`), writing `upsertPageTopSpenders`. Cursor: `TopSpendersCursorState` (mode bootstrap/steady_state, pendingWindows). **OnlyFans** (`executeOnlyFansTopSpendersChunk`, `:1319`): **zero external requests** — rankings are computed from the `transactions` table via `aggregateTransactionTopSpenders` + `getEarliestSpenderTransactionAt`, then `upsertTopSpendersWindow(platform:"onlyfans")`. Gated by `ONLYFANS_TOP_SPENDERS_ENABLED`; if off it returns `satisfied:true, stats.skipped` (planner already force-pauses it).

**`subscribers`** (`:1586`) — Fansly: `getSubscribersPage(status:"3,4", limit 100)` offset sweep with a **generation**; hydrates fans, `upsertPageSubscriptions` + `upsertFanPages`, and on the final page `deactivatePageSubscriptionsByGeneration` retires subscriptions missing from the sweep, then `refreshFanPageSubscriberState` + `rebuildSubscriberRollups`. Two destructive-write guards: empty-first-page (`subscribers_empty_first_page_guard`) and provider-total mismatch (`subscribers_partial_page_guard`) both **throw** to refuse finalization. OnlyFans eligible → `executeOfapiAudienceChunk` (below); OnlyFans ineligible → `satisfied:true, stats.skipped`.

**`followers`** / **`followers_reconcile`** (Fansly only, `:1841` / `:2107`) — `getFollowersPage` offset sweep. `followers` walks until it hits the known-follow-id boundary (incremental); `followers_reconcile` is a full generation sweep that expires stale follows. Writes `upsertPageFollows`, `upsertFanPages`, `upsertFanPageExternalPresences` (presence signals from `buildFanslyFollowerPresenceSignals`), `rebuildFollowerRollups`; on completion may fire a `followers_reconcile` anomaly request (`triggerFollowersReconcileAnomaly`, `:420`) when active-follow count diverges. Unmapped follower rows **throw** (`recordFollowerMappingBlockedAnomaly`). Cursor: `FollowersCursorState` / `FollowersReconcileCursorState`.

**`dm_conversations`** (`:2695`) dispatch: OnlyFans+OFAPI-eligible → `executeOfapiDmConversationsChunk`; OnlyFans legacy → `executeOnlyFansDmConversationsChunk` (`getRecentChatFanIds`); Fansly → `getMessagingGroupsPage`+`getGroupDetail` full-scan. Writes `upsertPageDmConversation`, `upsertFans`/`upsertFanPages`. When a conversation diverges it requests a `dm_messages` follow-up (`requestPageSync`). Cursors: `DmConversationCursorState` (Fansly `full_scan`) / `OfapiDmConversationCursorState` (`mode:"ofapi"`, bootstrap-then-reconcile).

**`dm_messages`** (`:3514`) dispatch: OFAPI → `executeOfapiDmMessagesChunk`; OnlyMonster → `getChatMessagesPage`; Fansly → `getMessagesPage`. Walks each conversation's history (backfill / deep_backfill / incremental modes) writing `upsertPageDmMessages` + `finalizePageDmConversationMessageSync` and updating `messageCoverageStatus`. Cursor: `DmMessagesCursorState` (current conversation + before-message-id + mode). DM retention: raw payloads kept 7 days (`dmRetentionDate`, `shared.ts:34`).

### OFAPI DM sync — `sync/ofapi-dm-sync.ts`

Eligibility `isOfapiDmSyncEligiblePage` (`:90`) = OnlyFans platform + non-empty `ofapiAccountId` + `OFAPI_DM_SYNC_ENABLED`. REST is used only for **bootstrap + periodic reconcile**; live messages arrive via the webhook projection (territory 07). `executeOfapiDmConversationsChunk` (`:495`): bootstrap walks `listChats` by offset once, then reconciles page-1 on an interval (`OFAPI_DM_RECONCILE_INTERVAL_MINUTES`, default 360). Heads only ever advance (`headForwardOnly:true`, `:665`) so a fresher webhook head is never regressed; conversation rows are `FOR UPDATE`-locked for the read-compute-upsert (`listPageDmConversationsByPlatformConversationIds(forUpdate:true)`). `executeOfapiDmMessagesChunk` (`:808`): per-conversation `listChatMessages` (order desc, `first_id` cursor) down to a retention tier (`getPageDmMessageRetentionLimit`, 200 regular / 1000 spender).

**Credit budget** — `createOfapiRestGuard` (`:165`): before every REST request it checks three limits and yields/parks:
- per-run request cap (`OFAPI_DM_BOOTSTRAP_MAX_REQUESTS_PER_RUN`, default 25) → yield;
- UTC-day credit ceiling via `reserveOfapiDayCredits` (reserve-before-request, `OfapiDayBudgetScope` `"global"`/`"audience"`) → park with `retry_at = now + 1 h`;
- credit floor (`OFAPI_CREDIT_FLOOR`, default 500) via `getOfapiCreditState`, only while the last-observed balance is fresh (`OFAPI_FLOOR_BALANCE_FRESHNESS_MS`).
Each response's `_meta` settles the reservation (`settleOfapiDayCreditReservation` / `guard.recordResponse`). **See territory 07** for the OFAPI transport/credit ledger.

### OFAPI audience sync — `sync/ofapi-audience-sync.ts`

`executeOfapiAudienceChunk` (`:267`) is the OnlyFans `subscribers` stream. `listActiveFans` offset sweep with its own generation and its own daily budget scope `"audience"`. Writes `upsertFans`, `upsertPageSubscriptions` (OnlyFans has one subscription per fan-page, `platformSubscriptionId = fanId`, no tiers), `upsertFanPages`, `upsertFanPageExternalPresences` (last-seen). On sweep completion `deactivatePageSubscriptionsByGeneration` retires missing subscriptions but **spares rows touched since the sweep started** (`lastSeenBefore`, guards against retiring a webhook-created subscriber mid-sweep, P-25). Same empty-first-page guard as Fansly, plus a contradictory-pagination guard (empty page + hasMore) that completes the sweep without the destructive expiry. Cursor: `OfapiAudienceCursorState`.

---

## 8. Cursors / checkpoints — `sync/cursor-state.ts` + `page_sync_cursors`

Checkpoints live in table `page_sync_cursors` (`schema.ts:478`), PK `(page_id, stream)`, columns `cursor_text`, `cursor_timestamp`, `cursor_seq`, `state jsonb`, `last_succeeded_run_id`, `last_succeeded_at`. Accessor functions are named `getCheckpoint` / `upsertCheckpoint` / `upsertCheckpointProgress` / `deleteCheckpoints` (⚠️ the function names say "checkpoint" but the table is `page_sync_cursors`). `upsertCheckpoint` stamps the successful run id; `upsertCheckpointProgress` writes only mid-sweep state.

`cursor-state.ts` holds the per-stream `state` JSON parsers/validators (each verifies a `revision`/`version` to reject a stale cursor of the wrong shape):
- `SubscribersCursorState`, `FollowersCursorState`, `FollowersReconcileCursorState` (revision = `request_seq`, generation, offset, observedCount, providerReportedTotal).
- `DmConversationCursorState` (`mode:"full_scan"`) vs `OfapiDmConversationCursorState` (`mode:"ofapi"`, bootstrap/reconcile timestamps).
- `OfapiAudienceCursorState` (`mode:"ofapi_audience"`, generation + sweep timestamps).
- `DmMessagesCursorState` (current conversation, before-message-id, mode, live-requests-since-deep-backfill quota).
- `TopSpendersCursorState` (mode, accountCreatedAt, totalMonths, pendingWindows[]).

Transaction backfill cursor shapes are in `sync/transaction-backfill.ts` (`FanslyTransactionBackfillState` / `OnlyFansTransactionBackfillState`, discriminated by `provider`, with `snapshotEnd`, `dirtyFrom`, offsets/windows, `processedTransactions`/`processedChargebacks`).

---

## 9. Config gates / force-pausing OnlyFans streams

Three OnlyFans streams are flag-gated and force-paused by the planner unless eligible:

| Module | Flag | Streams | Eligibility |
|---|---|---|---|
| `sync/onlyfans-dm-polling.ts` | `ONLYFANS_DM_POLLING_ENABLED` (`onlyFansDmPollingEnabled`) | `dm_conversations`, `dm_messages` | OnlyFans page **not** OFAPI-DM-eligible (OFAPI-mapped pages keep DM streams via the REST handlers). |
| `sync/ofapi-audience-sync.ts` | `OFAPI_AUDIENCE_SYNC_ENABLED` | `subscribers` | OnlyFans + `ofapiAccountId` + flag (`isOfapiAudienceSyncEligiblePage`). |
| `sync/onlyfans-top-spenders.ts` | `ONLYFANS_TOP_SPENDERS_ENABLED` | `top_spenders` | OnlyFans + flag (DB-computed, no eligibility on mapping). |

Each exposes `filter…Streams` (strip disabled streams from a manual request), `pauseDisabled…ForPage`, and `pauseDisabled…ForAllPages` (`status='paused'`). The pause returns whether it changed anything so the planner logs counts. Handlers also skip gracefully (`stats.skipped`) if a manual resume races a run in before the next planner re-pause.

---

## 10. Locking, rate limiting, chunk budgets, errors

**Advisory page lock** — `sync/locking.ts` `withPageSyncLock` (`:38`): `pg_try_advisory_lock(43101, pageId)` on a dedicated pool connection; throws `PageSyncLockedError` if already held; releases with `pg_advisory_unlock` and surfaces `PageSyncLockReleaseError` if the session didn't release. (The lease system in `page_sync_states` is the primary concurrency guard; this advisory lock guards whole-page operations.)

**Rate limiter** — `sync/rate-limiter.ts` `createSyncRateLimitWaiter` (`:15`): only active when `SYNC_SHARED_RATE_LIMIT_ENABLED`. Ensures a per-provider/per-egress rate-limit profile (`ensureSyncProviderRateLimitProfile`) with scopes: Fansly `global`/`followers_page`/`dm_conversations`/`dm_messages` (min-spacing from config), OnlyFans `global`. `reserveSyncProviderRateLimit` returns the next-available timestamp (table `sync_rate_limits`, PK `(provider, scope, egress_key)`, `next_available_at`); the waiter `delay`s until then. Handlers pass the waiter into every provider call.

**Chunk budget** — `sync/chunk-budget.ts` `SyncChunkBudget` (`:5`): an `HttpRequestObserver` counting started requests. Yields when `requestCount >= maxRequests` (default **5**) or `elapsedMs >= maxWallClockMs` (default **45 s**). `resolveYieldReason` → `"request_budget"` | `"wall_clock"`. This is what makes chunks bounded and resumable.

**Error taxonomy** — `sync/errors.ts` `normalizeSyncError` (`:107`): redacts the message (`redactSensitiveText`), clamps to 1024 chars, extracts type/code (recursing into `cause`), and flags query-style Drizzle errors so their SQL text isn't persisted. `SyncPayloadPersistenceError` wraps raw-payload write failures with the offending `endpoint`/`action`. The executor's `classifyTaskFailure` (§5) consumes the normalized summary/code.

---

## 11. Observability — `sync/observability.ts`

Every chunk creates a `SyncRunTelemetry` (`:368`) bound to one `sync_runs` row. It fans events to four sinks (`createCompositeRequestObserver`, `:645`): the in-memory `RequestSummaryCollector`, a DB attempt writer, stdout JSON-lines, and (if `SYNC_HTTP_TRACE_FILE` set) a file writer. Recorded state:

- **`sync_runs`** (`schema.ts:305`): id, page_id, request/leased seq, source, lease_token, stream, `outcome` (`syncRunOutcomeEnum`: success/partial/failed/skipped/…), `error_summary`, `stats jsonb`, started/finished. `finish(status,…)` writes `outcome` + the full `stats` blob (health, requestTotals byOperation, anomalies, notes, checkpoint before/after/advanced, boundary/scan/hydration summaries, phases).
- **`sync_http_attempts`** (`schema.ts:337`) — ⚠️ written by functions named `insertSyncRequestAttempt` / `finishSyncRequestAttempt`, read by `listSyncRequestAttempts`. One row per HTTP **attempt** (retry-granular): operation, logical_request_id, attempt_number, state (`started`/`success`/`retry`/`failed`), failure_kind, http_status, retry_delay_ms, duration_ms, request/response shape, error message.
- **`sync_run_events`** (`schema.ts:383`): typed event stream per run — `run_started`, `phase_started`, `checkpoint_loaded`, `checkpoint_advanced`, `note`, `anomaly`, `worker_heartbeat`, `run_finished`, `telemetry_error`, `lock_skipped`. Severity from `syncEventSeverityEnum`.

Health resolution (`resolveHealth`, `:807`): `failed` status → `failed`; error-severity anomaly → `suspicious`; partial/skipped/any retries/warn anomaly → `degraded`; else `healthy`. Automatic anomaly `high_retry_volume` when retry attempts > 3. Telemetry writes are best-effort — a failed write is logged as a `telemetry_error` event and never fails the sync (`safeTelemetryOp`, `:849`).

**Raw payload capture** — `sync/shared.ts` `persistRawPayload` (`:73`) → `insertRawPayload` into table `sync_raw_payloads` (`schema.ts:521`) — ⚠️ table is `sync_raw_payloads`, not `raw_payloads`. Fields: page_id, sync_run_id, stream, endpoint, request_params, response_payload (jsonb), mapper_version, payload_kind (`mapping_critical`/`failed`), error_message, `retain_until`. Mapping-critical payloads retained 180 days (`retentionDate`), DM 7 days (`dmRetentionDate`), failed payloads 180 days. Fansly follower/messaging payloads are trimmed before storage (`trimFanslyFollowerPayload`, `trimFanslyMessagingGroupsPayload`).

Retention cleanup runs daily (`fansly.raw-payload-cleanup`): `deleteExpiredRawPayloads` + `deleteExpiredSyncObservability` (window = `SYNC_OBSERVABILITY_RETENTION_DAYS`), `worker-services.ts:157`.

---

## 12. Health / freshness / degradation surface

Several read-only services aggregate `page_sync_states` + `sync_runs`/`sync_run_events` into UI/CLI views. None make external calls; all read the DB and are called from HTTP routes (§13) or the CLI.

**`services/sync.ts`** — thin read helpers over the DB for the admin API: `listStatus`/`getStatusDetail`/`getStatusWatchSnapshot` (recent/running runs + events + in-flight attempts), plus page-scoped fans/subscribers/followers/revenue reads.

**`services/sync-status.ts`** — `getSyncStatusSnapshot` (`:1474`) is the heavy aggregator. It ensures states, reads all task rows, optionally a 24 h monitor rollup (`listSyncMonitorStreamRows`), and for OFAPI-only OnlyFans pages folds in webhook DM-projection freshness (`getLatestSettledOfapiDmEventTimes`) and OFAPI financial truth (`getOfapiFinancialTruthSummaries`). It produces `SyncStatusPage` with one `SyncDomainBlockStatus` per domain (the five `SYNC_DOMAIN_BLOCKS`, `:37`). Block states: `not_started | scheduled | syncing | backfilling | up_to_date | retrying | delayed | failed | paused | not_available`. Status reasons carry codes such as `credentials_invalid`, `progress_stalled`, `queue_delayed`, and OFAPI-specific `webhook_silent|webhook_waiting|webhook_live`, `ofapi_financials_live|ofapi_financials_waiting`, `ofapi_auth|ofapi_auth_connected`. Freshness is judged against each stream's `freshnessSlaSeconds` from `SYNC_STREAM_POLICY`; queue-delay/progress-stall against the policy's `queueDelayThresholdMs`/`progressStallThresholdMs`.

**`services/sync-ux.ts`** — pure functions turning stream/page rows into a UI `SyncUxSummary` (`buildStreamSyncUx`/`buildPageSyncUx`/`buildOverallSyncUx`/`buildConversationHistorySyncUx`). No DB access.

**`services/sync-summary.ts`** — `getSyncStatusSummarySnapshot` (`:194`): the compact per-page summary used on the dashboard overview.

**`services/sync-monitor.ts`** — `getSyncMonitorSnapshot` (`:808`) and `getSyncMonitorRecentRequests` (`:1019`): the operator "sync monitor" — per-page/per-stream progress, rate health (`healthy|warning|limited`), recent runs/errors, active run, deep-backfill status, and recent HTTP requests. `services/sync-monitor-view.ts` `renderSyncMonitor` (`:132`) renders that snapshot as a text table for the CLI (`cli.ts` `sync-monitor`).

**`services/sync-blocks.ts`** — the block-oriented view + operator actions. `getSyncBlocksOverview` / `getPageSyncBlocks` / `getPageMessagesSyncBlock` reshape the status snapshot into `SyncBlocksPageItem` (five blocks). `diagnosisForPage` (`:218`) derives a single `SyncDiagnosis` (`auth_blocked` / `stalled_run` / `worker_offline`) with an action kind. `BLOCK_TASKS` (`:144`) maps each block to its streams (connection→light, financials→transactions/fan_identities/top_spenders, audience→subscribers/followers/followers_reconcile, messages_live→dm_conversations, messages_history→dm_messages), filtered to platform-supported streams.

**Blocking / unblocking a page** happens along three axes:
1. **Automatic blocks** (executor): `auth`/`provider_bad_data`/`invalid_cursor`/`manual_action_required` set `blocker_kind` (§5).
2. **Dependency blocks** (`blocker_kind='dependency'`): computed by `refreshLockedPageSyncDependencies`, cleared when deps are met.
3. **Manual / config**: `pauseSyncBlock`/`resumeSyncBlock`/`resetSyncBlock`/`triggerSyncBlock` (`sync-blocks.ts:384-559`) and the config force-pause (§9). `resetSyncBlock` also `deleteCheckpoints` and (for `messages_history`) `resetPageDmSyncState`, wiping cursor state.

---

## 13. HTTP endpoints (inbound boundary)

Registered in `apps/runtime/src/api/server.ts` with contracts in `packages/contracts/src/routes.ts`. All require auth (cookie or bearer); admin endpoints are cookie-gated.

| Method + path | Handler | Purpose |
|---|---|---|
| `GET /api/v1/health/sync` | `getPublicSyncHealth` (`services/health.ts`, out of territory) | Public liveness (200/503) over `page_sync_states`. |
| `GET /api/v1/sync/status` | `getSyncMonitorSnapshot` (`server.ts:1963`) | Aggregated monitor for visible pages. |
| `GET /api/v1/sync/requests` | `getSyncMonitorRecentRequests` (`:1985`) | Recent sync HTTP attempts. |
| `GET /api/v1/sync/overview` | `getSyncStatusSummarySnapshot` (via `syncOverview` / `:1998`) | 6-block overview. |
| `GET /api/v1/pages/:pageLabel/sync/blocks` | `getPageSyncBlocks` (`:2009`) | All blocks for one page. |
| `GET /api/v1/pages/:pageLabel/sync/blocks/messages` | `getPageMessagesSyncBlock` (`:2024`) | Combined Messages block. |
| `GET /api/v1/admin/sync/runs` | `listStatus` (`:2496`) | Recent runs. |
| `GET /api/v1/admin/sync/runs/:runId` | `getStatusDetail` (`:2514`) | Run + events + attempts. |
| `POST /api/v1/admin/sync/trigger` | `requestPageSync` (`sync-control.ts`, `:2545`) | Manual per-page request (scope). |
| `POST /api/v1/admin/sync/trigger-all` | `requestAllPagesSync` (`:2562`) | Manual all-pages request. |
| `POST /api/v1/admin/sync/blocks/trigger` | `triggerSyncBlock` (`:2576`) | Manual block sync. |
| `POST /api/v1/admin/sync/blocks/pause` | `pauseSyncBlock` (`:2587`) | Pause a block. |
| `POST /api/v1/admin/sync/blocks/resume` | `resumeSyncBlock` (`:2595`) | Resume a block. |
| `POST /api/v1/admin/sync/blocks/reset` | `resetSyncBlock` (`:2606`) | Reset block + wipe cursors. |

`services/sync-control.ts` `resolveStreamsForScope` (`:40`) maps the `SyncTriggerScope` to streams per platform, then applies the three config filters before `requestPageSync` (DB) + `sendSyncPageWakeup` (queue). `waitForRequestedSyncRequests` (`:208`) polls `page_sync_states` until `applied_seq >= requestedSeq` (used by onboarding flows), throwing on auth/paused/blocked.

---

## 14. DB tables owned/written by this territory

| Table | Written by | Read by |
|---|---|---|
| `page_sync_states` (`schema.ts:415`) | planner, executor, control/blocks, config pausers | everything |
| `page_sync_cursors` (`schema.ts:478`) | handlers (`upsertCheckpoint*`), reset (`deleteCheckpoints`) | handlers |
| `sync_runs` (`schema.ts:305`) | executor `startSyncRun`/telemetry `finishSyncRun`; planner auto-close | status/monitor services |
| `sync_http_attempts` (`schema.ts:337`) | telemetry DB observer | monitor/requests |
| `sync_run_events` (`schema.ts:383`) | telemetry `insertSyncRunEvent` | status watch/monitor |
| `sync_rate_limits` (`schema.ts:503`) | `rate-limiter.ts` | rate-limiter |
| `sync_raw_payloads` (`schema.ts:521`) | `persistRawPayload`; cleanup deletes | audits/backfills |
| `pages` (metadata cache: `last_light_sync_at`, `last_follower_sync_at`, counts, balance, metadata) | `light`, `followers` handlers | seeding/freshness |
| `fans`, `fan_pages`, `fan_page_external_presences`, `page_fan_identities` | hydration + audience/DM/identity handlers | dashboard/fans |
| `page_subscriptions` | `subscribers` + OFAPI audience | audience |
| `page_follows` | `followers`/`followers_reconcile` | audience |
| `page_dm_conversations`, `page_dm_messages` (`schema.ts:910`) | DM handlers | messages/workboard |
| `page_top_spenders` | `top_spenders` handlers; reset `deletePageTopSpenders` | financials |
| `transactions` + spend/revenue rollups | transactions handlers (`rebuildSpenderProjections`, `rebuildRevenueRollups`) | **territory 09** |
| `ofapi_credit_state`, OFAPI day-credit counters | OFAPI guard reserve/settle | **territory 07** |

---

## 15. Boundary summary (data in / out)

**Outbound (egress, the ingest reads):**
- **Fansly HTTP** (`app.adapter`): account, accounts-by-ids, subscribers, followers, transactions, earnings-accounts (top spenders), messaging groups/group detail/messages. Auth = a session; routed through the page's proxy/egress endpoint. → territory 08.
- **OnlyFans via OnlyMonster** (`app.onlyFansAdapter`): account, tracking/trial link users (identities), transactions/chargebacks, recent chat fan ids + chat messages. Auth = OnlyMonster token. → territory 08.
- **OnlyFans via OFAPI** (`app.ofapi`): `listChats`, `listChatMessages`, `listActiveFans`. Auth = `OFAPI_API_KEY`; every response's `_meta` settles a credit reservation. → territory 07.

**Inbound (this territory's HTTP surface):** the sync-status/monitor/blocks/admin endpoints in §13 (cookie/bearer auth), all read-only except the `POST /admin/sync/*` mutation endpoints which enqueue work.

**Queue (internal):** `sync.planner` (cron), `sync.page.execute` (per-page wakeup, grouped by provider+egress), both pg-boss on the same Postgres. `fansly.raw-payload-cleanup` daily.

**Storage:** all reads/writes go to the single application Postgres; see §14.

**Secrets/credentials touched:** page session/token/proxy resolved per chunk via `resolvePageContextById` / `resolveExecutorPageContext` (territory 08); `OFAPI_API_KEY` via `app.ofapi`. Error summaries are redacted (`redactSensitiveText`) before persisting to `sync_runs`/`sync_raw_payloads`.

**Notifications:** auth-failure and chunk-failure incidents fire through `services/notification-incidents.ts` (`notifyAuthFailedIncident`, `notifySyncChunkFailureIncident`, `resolveSyncChunkRecoveryIncidents`) — Telegram/incident surface, out of territory.

---

## 16. Naming discrepancies flagged

- **`page_sync_cursors`** table is accessed by functions named `getCheckpoint` / `upsertCheckpoint` / `deleteCheckpoints` — "checkpoint" is the code vocabulary, "cursor" is the table.
- **`sync_http_attempts`** table is written/read by functions named `insertSyncRequestAttempt` / `finishSyncRequestAttempt` / `listSyncRequestAttempts` — "request attempt" in code, `sync_http_attempts` on disk.
- **`sync_raw_payloads`** table is written by `insertRawPayload` / `persistRawPayload`; the cleanup queue is named `fansly.raw-payload-cleanup` even though it stores both Fansly and OnlyFans payloads.
- **`SyncPageChunkResult.needsContinuation`** is derived purely from `continuationPriority !== null` (`executor.ts:99`), i.e. "the page still has runnable streams," not "this stream is unfinished."
- **`subscribers` stream on OnlyFans** does not fetch subscribers per se — it runs the OFAPI `fans/active` audience sweep; the stream name is Fansly-legacy.
- **`top_spenders` on OnlyFans** makes **zero** external requests (DB aggregate over `transactions`), despite living in the same handler family as the Fansly earnings-API version.
