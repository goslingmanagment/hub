> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Territory 14 — Events & SSE Streaming

**Scope.** This document covers the live outbound streaming surfaces of `core`: the OFAPI sync-event Server-Sent-Events (SSE) pipeline and its supporting in-process fanout hub, the AI-gateway SSE response, and the workboard-presence report. Files read in full: `apps/runtime/src/services/events-stream.ts` (the in-process SSE fanout hub), `apps/runtime/src/services/ofapi-events.ts` (worker-side journal processing, `NOTIFY`, and frame derivation), `apps/runtime/src/services/workboard-presence.ts`, and the three `text/event-stream` / streaming route handlers in `apps/runtime/src/api/server.ts` (`/api/v1/ai/gateway/stream`, `/api/v1/events/stream`, `/api/v1/events/snapshot`, plus `/api/v1/pages/:pageLabel/workboard/presence`). Supporting reads: `apps/runtime/src/services/ofapi-sync-snapshot.ts`, `apps/runtime/src/services/ai-gateway.ts` (frame serializer only), `apps/runtime/src/services/ofapi-webhooks.ts` (receiver enqueue), `packages/db/src/repositories/ofapi.ts` (settle / replay / fanout-seq DB functions), `packages/db/src/schema.ts` (`ofapi_webhook_events`), and `packages/contracts/src/routes.ts` (`syncEventSchema`, `aiGatewayStreamFrameSchema`, snapshot and presence schemas, route declarations). Cross-references: territory 02 (route list), 07/07b (OFAPI webhook ingestion & post-settle projections), 10 (AI gateway), 11 (workboard).

---

## 1. Overview: three independent streaming surfaces

`core` exposes three unrelated live-response surfaces. They share no code and no ordering domain:

| Surface | Route | Transport | SSE event name | Scope of a stream | Lifetime |
|---|---|---|---|---|---|
| OFAPI sync events | `GET /api/v1/events/stream` | SSE (hijacked reply) | `sync` | one chatter's assigned pages; multiplexed from a shared DB `LISTEN` | up to 15 min, then client reconnects |
| AI gateway | `POST /api/v1/ai/gateway/stream` | SSE (hijacked reply) | `ai` | one AI request | one request; no reconnect/replay |
| Workboard presence | `GET /api/v1/pages/:pageLabel/workboard/presence` | ordinary JSON (NOT a stream) | — | one page | single request/response |

The workboard-presence file is in this territory's scope as a "stream side," but the code is a synchronous request/response report (a poll-refresh + DB read), not a stream — see §6. The only true event stream in `core` is the OFAPI sync-event SSE (§2–§5). The AI-gateway SSE (§7) is a request-scoped byte relay from the AI provider and is documented in depth in territory 10; here only its transport relationship to the sync-event stream is described.

---

## 2. OFAPI sync-event pipeline (end to end)

The sync-event stream carries real-time OnlyFans chat/account activity (derived from OFAPI webhooks) to the ChatMuse/ChatGoose desktop client. The full path spans two processes (worker and API) joined by Postgres:

```
OFAPI webhook  ─HTTP POST─►  POST /api/v1/ofapi/webhook (API)
   (territory 07)               │ HMAC-verify, journal row (status='pending'), enqueue pg-boss job
                                ▼
                        pg-boss queue "ofapi.events.process.v2"
                                │
                                ▼  (worker process, single replica)
  processOfapiWebhookEvent()  ── derive SyncEvent frame, settle row status='processed',
   (ofapi-events.ts)             assign fanout_seq = nextval(sequence), pg_notify('ofapi_sync_events', <rowId>)
                                │  (all inside one DB transaction)
                                ▼
                        Postgres NOTIFY channel "ofapi_sync_events"
                                │
                                ▼  (API process)
  createSyncEventHub()        ── single shared LISTEN connection; on wake-up, drain journal
   (events-stream.ts)           forward in fanout_seq order, broadcast to matching subscribers
                                │
                                ▼
  GET /api/v1/events/stream   ── per-connection SSE writer: replay from Last-Event-ID,
   (server.ts)                  then live frames, with a monotonic seq guard
                                │
                                ▼
                        Desktop client EventSource (event: sync)
```

Producer side (worker) and consumer side (API) never call each other directly. The only coupling is (a) the `ofapi_webhook_events` journal table, (b) the `ofapi_sync_events` `NOTIFY` channel name, and (c) the `fanout_seq` sequence. The channel name constant is `OFAPI_SYNC_EVENT_CHANNEL = "ofapi_sync_events"`, declared in `ofapi-events.ts:66` and imported by the hub at `events-stream.ts:8`.

### 2.1 `fanout_seq` — the SSE event id and ordering key

`fanout_seq` is a bigint column on `ofapi_webhook_events` (`schema.ts:2130`), backed by the Postgres sequence `ofapi_webhook_events_fanout_seq` (created in `packages/db/migrations/0027_ofapi_webhook_receiver.sql:26`). It is assigned exactly once, in `settleOfapiWebhookEvent` (`packages/db/src/repositories/ofapi.ts:96-98`), only when a row transitions `pending → processed`: `fanoutSeq = nextval('ofapi_webhook_events_fanout_seq')`. Rows settled as `skipped`/`failed` get `fanout_seq = null` and never fan out.

Key facts:

- **It is the SSE `id:` field / `Last-Event-ID` cursor** (`schema.ts:2113-2114`, `events-stream.ts:17-18`, `server.ts:1436`). Chosen over the row's receive-time `id` so that late settles (pg-boss retries, the minutely sweep) remain visible to clients whose cursor has already advanced past their receive-time id.
- **Ordering guarantee = settle order, not receive order.** The worker runs as a single replica (enforced, see §3.4) and settles rows sequentially, so `nextval` is called in a serialized order. A batch of jobs is re-sorted by receive-time `eventId` before settling (`sortOfapiEventJobs`, `ofapi-events.ts:80-84`, applied at `ofapi-events.ts:448`) so that settle order approximates receive order. The hub's forward-only drain (`events-stream.ts:70`) documents that "seq-order delivery assumes settles commit in fanout_seq order, which the single serialized event worker guarantees."
- **Uniqueness / replay index.** `ofapi_webhook_events_fanout_seq_uniq` (partial unique on non-null `fanout_seq`) and `ofapi_webhook_events_replay_idx` on `(platform_account_id, fanout_seq)` back the replay queries (`schema.ts:2160-2165`).
- **High-water survives pruning.** Journal rows are deleted after retention (~7 days, §3.3), but the sequence's `last_value` persists. `getOfapiFanoutReplayWindow` (`ofapi.ts:952-975`) reads `latestSeq` from the sequence's `last_value` (via `is_called`/`last_value`), and `oldestRetainedSeq` as `min(fanout_seq)` of surviving rows — the two together define the replayable window.

---

## 3. Worker side — `ofapi-events.ts`

This file runs in the worker process (registered by `startOfapiEventWorker`, called from `apps/runtime/src/worker-services.ts:180`). It owns everything up to and including the `NOTIFY`.

### 3.1 `mapOfapiEventToSyncEvent` — the frame-derivation catalog (`ofapi-events.ts:117-220`)

Maps a validated OFAPI webhook envelope to a `SyncEvent` (or `null` to journal-without-fanout). `null` means the row settles `skipped` and never reaches the stream. `accountId` on every frame is the OFAPI account id string (`"acct_…"`); `chatId`/`messageId` are raw OnlyFans numeric ids serialized as strings (`routes.ts:2815-2820`).

| OFAPI `event` | Emitted `SyncEvent.type` | Payload fields set | Notes |
|---|---|---|---|
| `messages.received` | `messageReceived` | `accountId, chatId (fromUser.id), messageId (id), message?` | `message` = normalized DM (see `normalizedSyncMessageSchema`), omitted if chatId missing; frame null if chatId or messageId missing |
| `messages.sent` | `messageSent` | `accountId, chatId (toUser.id), messageId, message?` | mirror of above, `isSentByMe: true` |
| `messages.deleted` | `messageDeleted` | `accountId, messageId` | core extension over the desktop union; upstream carries no chatId (`routes.ts:2876-2882`) |
| `messages.ppv.unlocked` | `ppvUnlocked` | `accountId, chatId, messageId?` | notification-shaped; messageId only sometimes recoverable |
| `tips.received` | `tipReceived` | `accountId, chatId, messageId?, amountUsd?` | `amountUsd` from `payload.amountGross` when a non-negative number |
| `subscriptions.new`, `subscriptions.renewed` | `chatListUpdated` | `accountId` only | coarse "refetch chat list" hint |
| `users.online` / `users.offline` | `presence` | `accountId, chatId (fan.id), online, lastSeenAt?` | `online` = which event; `lastSeenAt` = epoch ms from `last_seen_online_at` |
| `users.typing` | `typing` | `accountId, chatId (id)` | ephemeral |
| `accounts.connected`, `accounts.reconnected`, `accounts.session_expired` | `accountAuthChanged` | `accountId, authenticated: true` | `session_expired` treated as still-authenticated (OFAPI recovered silently) |
| `accounts.authentication_failed`, `accounts.otp_code_required`, `accounts.face_otp_required` | `accountAuthChanged` | `accountId, authenticated: false` | operator-action states |
| **anything else** (`transactions.new`, `chat_queue`, posts, data exports, fan summaries, unknown) | **`null`** | — | journaled but never fanned out; `transactions.new` is deliberately excluded to avoid credit-charged refetches (`ofapi-events.ts:111-116`) |

The full union type is `syncEventSchema`, a Zod discriminated union on `type` (`routes.ts:2924-2934`) exported as `SyncEvent`. Consumers are expected to skip unknown frame types, so the union can grow without breaking them (`routes.ts:2819-2820`).

Discrepancy to flag: `presence` and `typing` frames **are** assigned `fanout_seq` and **are** replayable through the SSE journal-replay path (they settle as `processed`). They are only excluded from the *snapshot* endpoint (marked `ephemeral_not_snapshotted`, §5). The name "ephemeral" applies to snapshot coverage, not to SSE replay.

### 3.2 `processOfapiWebhookEvent` — settle + NOTIFY (`ofapi-events.ts:276-344`)

Per journaled row:
1. Load row; skip if missing or `status != 'pending'` (`276-280`).
2. Re-parse the journaled `payload` with `ofapiWebhookEnvelopeSchema`; on failure settle `failed` (`283-293`).
3. Resolve the page via `pages.ofapi_account_id → findPageByOfapiAccountId`; if no page, settle `skipped` (`295-309`).
4. Derive the frame; if null or it fails `syncEventSchema` validation, settle `skipped` (`311-325`).
5. **Otherwise, in one DB transaction** (`327-342`): `settleOfapiWebhookEvent(... status='processed', platformAccountId, syncEvent, ...)` which assigns `fanout_seq`, then `select pg_notify('ofapi_sync_events', <rowId>::text)`. The `NOTIFY` fires on commit, after the row is visible. If another worker settled the row first (`settled === false`), it skips the notify (the winner owns it).

The `NOTIFY` **payload is the journal row id** as a string, but the hub deliberately ignores it (see §4). Post-settle projections (DM/subscription/presence/spend/account-health) run strictly *after* the settle commit as best-effort steps (`runPostSettleOfapiProjections`, `ofapi-events.ts:94-109`) and can never block, fail, or reorder the settle/fanout path — cross-ref 07b.

### 3.3 Queues, sweep, cleanup

Defined in `ofapi-events.ts`:

| Queue const | Name | pg-boss policy | Purpose |
|---|---|---|---|
| `OFAPI_EVENT_PROCESS_QUEUE` | `ofapi.events.process.v2` | `exclusive`, `retryLimit: 2`, `retryDelay: 30`, `retryBackoff` | per-event processing; every job has `singletonKey = String(eventId)` (`sendOfapiEventProcessJob`, `ofapi-events.ts:255-264`) |
| `OFAPI_EVENT_SWEEP_QUEUE` | `ofapi.events.sweep` | `exclusive` | minutely (`* * * * *` UTC); re-enqueues rows still `pending` after 30 s grace (`SWEEP_PENDING_GRACE_MS`), then runs DM/subscription/presence/spend projection sweeps + account-health + credit-burn monitors |
| `OFAPI_EVENT_CLEANUP_QUEUE` | `ofapi.events.cleanup` | `standard` | daily 02:30 UTC; deletes journal rows older than retention and purges the DM cold-archive |

Retention window: `resolveOfapiEventRetentionDays` = `config.ofapiEventRetentionDays ?? 7` days (`ofapi-events.ts:362-364`); `cleanupExpiredOfapiEvents` deletes rows with `receivedAt` older than that (`366-372`). This retention is what bounds the SSE replay window to ~7 days (advertised in the route description, `routes.ts:3817`).

The process worker uses `batchSize: OFAPI_EVENT_PROCESS_BATCH_SIZE = 100` (`ofapi-events.ts:62`, `444`) — a batch is fetched to avoid pg-boss idle-poll latency, but the handler still settles the batch sequentially after `sortOfapiEventJobs`, preserving fanout order (`443-451`).

### 3.4 Single-worker invariant

`assertOfapiEventWorkerSingleton` throws unless `config.ofapiEventWorkerReplicas ?? 1 === 1` (`ofapi-events.ts:376-383`). Additionally, `startOfapiEventWorker` acquires a Postgres advisory lock `pg_try_advisory_lock(58211, 1)` (`acquireOfapiEventWorkerLock`, `ofapi-events.ts:392-431`) and throws `OfapiEventWorkerLockError` if held. This is the mechanism that guarantees serialized settle order (§2.1) even across accidental multi-process starts.

---

## 4. The in-process fanout hub — `events-stream.ts`

`createSyncEventHub(app)` (`events-stream.ts:72-283`) is a single object created lazily in the API process on the first `/events/stream` connection (`server.ts:1402`, `syncEventHub ??= createSyncEventHub(appContext)`) and closed on server shutdown (`server.ts:1321`). It converts the one-shot `NOTIFY` wake-ups into an ordered, in-memory broadcast to all SSE connections. It contains **no HTTP** — it only reads the journal and calls `subscriber.deliver`.

### 4.1 Public shape

`SyncEventHub` (`events-stream.ts:28-33`) exposes:
- `subscribe(subscriber) → unsubscribe` — registers a `SyncEventSubscriber { pageIds: ReadonlySet<number>; deliver(frame) }` (`23-26`) and triggers `ensureListening()`.
- `ready(): Promise<void>` — resolves once the current `LISTEN` attempt finishes (success or scheduled retry).
- `close(): Promise<void>` — tears everything down.

`SyncEventFrame` (`16-21`): `{ id: number /* fanout_seq */, platformAccountId: number, syncEvent: Record<string, unknown> }`. Note the frame's `syncEvent` is typed loosely as `Record<string, unknown>` here; it was already validated against `syncEventSchema` at settle time, so the hub does not re-validate.

### 4.2 Transport: shared `LISTEN` + serialized drain (not per-notification frames)

- One `LISTEN ofapi_sync_events` connection is checked out from the pool for the entire API process (`ensureListening`, `196-253`), shared by all subscribers.
- A `NOTIFY` is treated as a **wake-up only**; the payload row id is explicitly discarded (`207-214`, comment: "building the frame here would reintroduce unordered per-notification fetches").
- On wake-up, `requestDrain()` (`102-120`) runs one serialized `drainJournal()` (`122-152`) that reads forward from `deliveredSeq` in `fanout_seq` order via `listOfapiSyncEventsForReplay({ afterSeq: deliveredSeq, limit: 500 })` (no `pageIds` filter — the hub delivers everything and lets each subscriber filter), broadcasting each row and advancing `deliveredSeq` only **after** a successful broadcast.
- Concurrent wake-ups coalesce: if a drain is in flight, `drainAgain = true` schedules exactly one follow-up pass, so two drains never interleave and never reorder (`106-119`).
- `CATCH_UP_BATCH_SIZE = 500` (`events-stream.ts:14`); a short batch ends the drain.

### 4.3 Watermark, catch-up, and failure handling

- `deliveredSeq` starts `null`; the **first** successful `LISTEN` baselines it at the journal high-water via `getMaxOfapiFanoutSeq` (`225-227`). A baseline failure fails the whole connect and is retried with backoff, rather than leaving it null (which would silently disable delivery).
- Because the baseline is the current max, the hub only live-delivers frames settled **after** it connected. **Per-connection historical replay from a client's `Last-Event-ID` is done by the SSE route itself (§5.2), not the hub.** The hub's own drain catch-up only covers frames that settled during a `LISTEN` gap (reconnect) — those are re-broadcast to all current subscribers, who de-dup via their per-connection seq guard.
- Journal read failure during drain leaves the watermark untouched and schedules a retry with exponential backoff (`DRAIN_RETRY_MIN_MS=1s … MAX=30s`, `scheduleDrainRetry`, `154-164`) — frames are retried from the same position, never skipped (safe because `NOTIFY` is one-shot).
- `LISTEN` connection errors drop the client and reconnect with backoff (`LISTEN_RECONNECT_MIN_MS=1s … MAX=30s`, `scheduleReconnect`, `183-194`); reconnect is only scheduled while `subscribers.size > 0`. The `LISTEN` client is `release(true)`-destroyed rather than pooled, since it carries `LISTEN` state (`174-181`).

### 4.4 Broadcast + per-connection filtering

`broadcast(frame)` (`87-98`) iterates all subscribers and calls `deliver` only when `subscriber.pageIds.has(frame.platformAccountId)` — i.e. page-scoping happens here, not in the drain query. A throwing `deliver` is caught and logged (`SSE subscriber delivery failed`) and does not abort the broadcast to other subscribers.

### 4.5 Monotonic seq guard (`createMonotonicSeqGuard`, `events-stream.ts:43-55`)

A per-connection guard seeded with the connection's `Last-Event-ID`. `advance(seq)` returns `true` only when `seq` strictly exceeds the last written seq; otherwise `false`. This exists because a single frame can legitimately reach one connection twice (journal replay + a live broadcast that landed after replay flushed). The guard guarantees ids on the wire are strictly increasing — which the strict `fanout_seq > Last-Event-ID` resume relies on after a reconnect (`36-42`).

---

## 5. SSE route `GET /api/v1/events/stream` (`server.ts:1346-1540`)

Contract: `routeSchemas.eventsStream` (`routes.ts:3811-3834`). Auth: `bearerOnlySecurity` — chatter API key only. The handler `requirePrincipal` + `requireApiKeyUser` (`server.ts:1349-1350`); the stream is scoped to `principal.assignedPageIds` (`1351`).

### 5.1 Cursor input and 409 gap handling

`Last-Event-ID` is taken from the HTTP header first, falling back to the `?lastEventId` query param (`1358-1364`; header parse at `1358-1362`, query schema `routes.ts:3819-3821`). If a cursor is supplied (`1366-1397`), the handler reads `getOfapiFanoutReplayWindow` and returns **HTTP 409 `sync_snapshot_required`** (`syncSnapshotRequiredResponseSchema`, `routes.ts:2936-2945`) in two cases:
- **cursor ahead** — `lastEventId > latestSeq` (`1368`);
- **cursor too old** — `latestSeq > lastEventId` and the cursor predates the retained window (`oldestRetainedSeq === null || lastEventId < oldestRetainedSeq - 1`) (`1380-1396`).

The 409 body carries `{ requestedSeq, oldestAvailableSeq, currentSeq, snapshotPath: "/api/v1/events/snapshot", version: 1 }`, telling the client to snapshot then resume.

### 5.2 Establishing the stream

1. `syncEventHub.ready()` is awaited (best-effort) **before** the replay query so no frame settles between journal catch-up and live delivery (`1399-1403`).
2. `reply.hijack()` — bypasses Fastify's serializer; the handler writes raw bytes (`1406-1413`). Response headers: `content-type: text/event-stream`, `cache-control: no-cache, no-transform`, `connection: keep-alive`, `x-accel-buffering: no`. Then `retry: 3000\n\n` (reconnect hint, `1414`). The raw socket is tracked in `activeSseStreams` (`1415`) so `server.onClose` can destroy hijacked streams (`server.ts:1315-1320`).
3. A `createMonotonicSeqGuard(lastEventId)` (`1422`) gates all writes through `writeFrame` (`1424-1437`): drops if socket ended, drops if `!seqGuard.advance(frame.id)`, drops the connection if `raw.writableLength > SSE_MAX_BUFFERED_BYTES` (backpressure), else writes the SSE frame `id: <seq>\nevent: sync\ndata: <JSON syncEvent>\n\n`.
4. It subscribes to the hub **before** running its own replay; live frames arriving during replay are buffered in `bufferedLive[]` and flushed (through the same seq guard) once `replayDone` (`1439-1452`, `1535-1539`).
5. Per-connection replay (`1507-1533`): only if a cursor was supplied and `pageIds.size > 0`, it pages `listOfapiSyncEventsForReplay({ afterSeq: replayCursor, pageIds, limit: 500 })` until a short batch, writing each row. A replay failure closes the stream.

### 5.3 Keepalive, re-auth, and bounded lifetime

- **Heartbeat**: `: keep-alive\n\n` every `SSE_HEARTBEAT_INTERVAL_MS = 25_000` (`1454-1459`).
- **Backpressure**: `SSE_MAX_BUFFERED_BYTES = 1_000_000` — a client this far behind is dropped (`1332`, enforced in `writeFrame`).
- **Auth revalidation**: every `SSE_AUTH_REVALIDATE_INTERVAL_MS = 60_000`, re-authenticate the bearer token via `authenticateApiKeyToken`; if the key no longer authenticates, or the set of assigned page ids changed (`sameNumberSet`, `1334-1344`), `raw.end()` the stream so the client reconnects and re-authorizes (`1460-1483`).
- **Max lifetime**: `SSE_MAX_LIFETIME_MS = 15 * 60 * 1000` — the stream is force-ended so revoked keys / reassignments take effect; the client transparently reconnects (`retry: 3000`) and resumes from `Last-Event-ID` (`1327-1330`, `1484-1489`).
- **Cleanup** on socket `close` clears all timers, unsubscribes from the hub, and removes the socket from `activeSseStreams` (`1491-1505`). If the client already disconnected before the listener registered, it cleans up immediately.

### 5.4 Replay-gap recovery: `GET /api/v1/events/snapshot` (`server.ts:1542-1555`, `ofapi-sync-snapshot.ts`)

Contract `routeSchemas.eventsSnapshot` (`routes.ts:3835-3851`); bearer chatter-key only; query `syncSnapshotQuerySchema` (`routes.ts:2947-2953`): `{ accountId, afterSeq, snapshotCursor?, pageCursor=0, limit=25 (max 50) }`. `getOfapiSyncSnapshot` (`ofapi-sync-snapshot.ts:67-283`) returns the current durable chat state (from DM/cold-archive projections, cross-ref 07b) for one assigned OFAPI account, paginated by thread. It performs **no OFAPI calls and no historical DM backfill** (`routes.ts:3841`). Response `syncSnapshotResponseSchema` (`routes.ts:2985-3016`) includes:
- `snapshotCursor` — captured from `getOfapiFanoutReplayWindow().latestSeq` before state reads; the client persists it only after the final page, then resumes SSE from it (`ofapi-sync-snapshot.ts:79-90`).
- `page` (auth status/flags), `coverage.durableDomains` (`chat_heads`, `hot_messages`, `message_tombstones`, `account_auth`, gated by `ofapiDmProjectionEnabled` / `ofapiDmColdArchiveEnabled`) and `coverage.omittedDomains` (`presence`/`typing` marked `ephemeral_not_snapshotted`, `ofapi-sync-snapshot.ts:215-224`).
- `threads[]` (chat heads + hot/archive messages), `unresolvedTombstones[]` (deleted-message tombstones carrying `sourceFanoutSeq`), `nextPageCursor`.

`snapshotCursor` and `afterSeq` are validated against the replay window: `snapshotCursor > latestSeq` or `afterSeq > snapshotCursor` throws `BadRequestError` (`ofapi-sync-snapshot.ts:81-90`).

---

## 6. Workboard presence — `workboard-presence.ts` (NOT a stream)

Despite being in this territory's scope, `getWorkboardPresenceReport` (`workboard-presence.ts:140-204`) serves the ordinary JSON route `GET /api/v1/pages/:pageLabel/workboard/presence` (`server.ts:1096-1101`, contract `routes.ts:4423-4435`, cookie/dashboard-user auth). There is no SSE, no `NOTIFY`, no streaming — it is a synchronous refresh-then-read. Presence reaches the workboard through **two** paths, only one of which touches the event stream:

1. **Fansly pages**: on request, if the per-page 60 s TTL (`PRESENCE_REFRESH_TTL_MS`) has elapsed, it live-pulls Fansly followers via `app.adapter.getFollowersPage` (paginated, capped at `PRESENCE_REFRESH_MAX_PAGES = 1000`), builds presence signals, and upserts them into `fan_pages.external_presence_*` via `upsertFanPageExternalPresences` (`67-138`). Concurrent refreshes for the same page coalesce onto one in-flight pass (`presenceRefreshInFlightByPageId`, `179-201`). This is an **outbound Fansly HTTP boundary** — see the boundaries table.
2. **OnlyFans pages**: DB-read-only. It requires the OFAPI presence projection to be enabled and the page mapped to an OFAPI account (`isOfapiPresenceProjectionEnabled` + `ofapiAccountId`, `154-167`); otherwise it 400s ("Workboard presence is only supported for Fansly pages"). The store is kept fresh **out of band** by the OFAPI presence projection (`runOfapiPresenceProjectionForSettledRow` in `ofapi-presence-projection.ts`, a post-settle step of the same worker pipeline in §3.2), which writes the same `fan_pages.external_presence_*` columns with source `ofapi_last_seen` (`ofapi-presence-projection.ts:134-139`). So a `users.online`/`users.offline` webhook fans out live over SSE **and** (separately) updates the presence store that this GET reads.

Both paths converge on `readStoredPresence` (`206-232`), which returns two buckets (`activeNow`, `recentlyActive`, 20 each) from `listWorkboardPresence`. Response `workboardPresenceResponseSchema` (`routes.ts:1224-1229`): `{ updatedAt, bestEffort: true, activeNow, recentlyActive }`, each bucket `{ total, items[] }` with per-fan `{ fanId, fan{platformUserId,pageAlias,username,displayName}, presence{lastSeenAt,observedAt,source: "fansly_followers_last_seen"|"ofapi_last_seen"}, ltv{creatorNetAmountMills}, isSubscriber, platformConversationId, lastTransactionAt }` (`routes.ts:1119-1144`). Cross-ref 11.

---

## 7. AI-gateway SSE `POST /api/v1/ai/gateway/stream` (`server.ts:701-803`)

A completely separate SSE surface (territory 10). Relationship to the sync-event stream: **shares only the SSE transport pattern (hijacked reply, `text/event-stream`), nothing else** — no hub, no journal, no `Last-Event-ID`/replay, no heartbeat, and a different event name (`ai` vs `sync`). It is one request → one provider stream → one response, aborted if the client disconnects.

- Auth: bearer chatter-key (`requireApiKeyUser`, `705`). Body `aiGatewayStreamBodySchema` (`routes.ts:1788-1804`).
- `prepareAiGatewayStream` (`ai-gateway.ts`) reserves quota and returns `{ requestId, meta, stream(signal), recordTerminal }`. The handler `reply.hijack()`s, writes headers (`content-type: text/event-stream`, `cache-control: no-cache, no-transform`, `connection: keep-alive`, `x-accel-buffering: no`, `717-722`), then relays frames.
- Frames are serialized by `serializeAiGatewaySseFrame` (`ai-gateway.ts:271-273`) as `event: ai\ndata: <JSON frame>\n\n`. Frame union `aiGatewayStreamFrameSchema` (`routes.ts:1821-1857`): `meta` (requestId, feature, pageLabel, model, provider ∈ {anthropic, openrouter}, providerResponseId, quota), `content_delta {text}`, `reasoning_delta {text}`, `usage {usage, providerResponseId, cacheHit}`, `error {code, message, retryAfterMs}`, `done {stopReason}`.
- Client disconnect (`raw.on("close", …)`) aborts the provider via an `AbortController` (`724-734`); on finish it always writes a terminal usage/ledger record via `recordTerminal` (`782-802`). This is an **outbound AI-provider boundary + a DB ledger write** — detailed in territory 10.

(Not a stream, listed for completeness: `GET /api/v1/admin/ofapi/credits/ledger.csv` at `server.ts:1676-1705` also `reply.hijack()`s and writes raw bytes, but it emits a single `text/csv` attachment built fully before hijacking — no incremental streaming.)

---

## 8. Boundaries (data crossing into/out of `core` within this territory)

| # | Boundary | Direction | Counterpart | What crosses (shape) |
|---|---|---|---|---|
| B1 | `GET /api/v1/events/stream` | outbound (SSE) | ChatMuse/ChatGoose desktop client (`EventSource`) | Continuous `event: sync` frames; each `id: <fanout_seq>` + `data:` = one JSON `SyncEvent` (union of `messageReceived`/`messageSent`/`messageDeleted`/`ppvUnlocked`/`tipReceived`/`chatListUpdated`/`presence`/`typing`/`accountAuthChanged`). Plus `: keep-alive` comments and one `retry: 3000`. Filtered to the chatter's assigned page ids. |
| B2 | `GET /api/v1/events/stream` (request) | inbound | same client | Bearer API key (Authorization header), optional `Last-Event-ID` header or `?lastEventId` cursor. |
| B3 | 409 `sync_snapshot_required` on `/events/stream` | outbound (JSON) | same client | `{ error, message, statusCode:409, version:1, requestedSeq, oldestAvailableSeq, currentSeq, snapshotPath:"/api/v1/events/snapshot" }` when the cursor is ahead of or older than the retained window. |
| B4 | `GET /api/v1/events/snapshot` | outbound (JSON) | same client | Durable chat snapshot for one OFAPI account: `{ version, snapshotCursor, stateAt, resumeAllowed, page, coverage{durableDomains,omittedDomains}, threads[], unresolvedTombstones[], nextPageCursor }`. Inbound: bearer key + `{ accountId, afterSeq, snapshotCursor?, pageCursor, limit }`. |
| B5 | Postgres `LISTEN ofapi_sync_events` | inbound (from DB) | Postgres (produced by the worker via `pg_notify`) | Wake-up notifications; channel `ofapi_sync_events`, payload = journal row id string (deliberately ignored). Consumed by `createSyncEventHub` in the API process. |
| B6 | Postgres `pg_notify('ofapi_sync_events', <rowId>)` | outbound (to DB) | Postgres | Fired inside the settle transaction on commit (`ofapi-events.ts:341`). |
| B7 | DB read: `listOfapiSyncEventsForReplay` / `getMaxOfapiFanoutSeq` / `getOfapiFanoutReplayWindow` | storage (read) | `ofapi_webhook_events` + `ofapi_webhook_events_fanout_seq` sequence | Processed frames after a `fanout_seq` cursor (`id, platformAccountId, syncEvent`), page-filtered for SSE replay, unfiltered for hub catch-up; plus high-water/oldest-retained seqs. |
| B8 | DB write: `settleOfapiWebhookEvent` | storage (write) | `ofapi_webhook_events` | Sets `status='processed'`, `platform_account_id`, `sync_event` (JSONB), `fanout_seq = nextval(...)`, `processed_at`; guarded on `status='pending'`. |
| B9 | pg-boss queue `ofapi.events.process.v2` | queue | pg-boss (Postgres) | Job payload `{ eventId: number }`, `singletonKey = String(eventId)`; produced by the webhook receiver (`sendOfapiEventProcessJob`) and the sweep, consumed by the worker. |
| B10 | pg-boss queues `ofapi.events.sweep` / `ofapi.events.cleanup` | queue (scheduled) | pg-boss | Cron triggers (minutely / daily 02:30 UTC), no payload. |
| B11 | `POST /api/v1/ai/gateway/stream` | outbound (SSE) | ChatMuse desktop client | `event: ai` frames (`meta`/`content_delta`/`reasoning_delta`/`usage`/`error`/`done`) relayed from the AI provider. Inbound: bearer key + prompt body. See territory 10. |
| B12 | Workboard-presence Fansly refresh (`app.adapter.getFollowersPage`) | outbound (HTTP) | Fansly API (via adapter/proxy egress) | Paginated follower fetch (offset/limit/lastSeenAfter); response upserted to `fan_pages.external_presence_*`. Only on the Fansly path of `GET .../workboard/presence`. |
| B13 | Workboard-presence DB reads/writes | storage | `fan_pages` (external presence cols), `page_fans`, workboard tables | `listWorkboardPresence` read; `upsertFanPageExternalPresences` / `upsertHydratedFansForPage` writes. |

---

## 9. Config / env knobs affecting this territory

| Config key | Effect | Referenced at |
|---|---|---|
| `ofapiEventRetentionDays` (default 7) | journal prune horizon → bounds SSE replay & snapshot window | `ofapi-events.ts:362-371` |
| `ofapiEventWorkerReplicas` (default 1) | must be 1; enforces serialized `fanout_seq` / delivery order | `ofapi-events.ts:376-383` |
| `ofapiWebhookRateLimitMax` / `…WindowSeconds` (default 1000 / 60s) | rate-limits the inbound webhook feeding the pipeline | `server.ts:1295-1296` |
| `ofapiDmProjectionEnabled`, `ofapiDmColdArchiveEnabled` | gate which snapshot `durableDomains` are populated | `ofapi-sync-snapshot.ts:212-224` |
| `isOfapiPresenceProjectionEnabled` | gates OnlyFans workboard-presence eligibility + the presence projection that feeds it | `workboard-presence.ts:160`, `ofapi-presence-projection.ts` |
| `followerPageDelayMs` | throttle for the Fansly follower refresh pagination | `workboard-presence.ts:90` |

Hardcoded SSE tuning constants (not config): `SSE_REPLAY_BATCH_SIZE=500`, `SSE_HEARTBEAT_INTERVAL_MS=25_000`, `SSE_AUTH_REVALIDATE_INTERVAL_MS=60_000`, `SSE_MAX_LIFETIME_MS=900_000`, `SSE_MAX_BUFFERED_BYTES=1_000_000` (`server.ts:1324-1332`); hub `CATCH_UP_BATCH_SIZE=500`, reconnect/drain backoff 1s→30s (`events-stream.ts:10-14`).

---

## 10. Consumers (who reads these streams)

- **`/api/v1/events/stream` + `/api/v1/events/snapshot`**: the ChatMuse/ChatGoose **desktop chat client** (documented separately). It authenticates with a chatter API key, opens an `EventSource`, resumes via `Last-Event-ID`, and falls back to the snapshot on a 409. `SyncEvent` is core's copy of the desktop protocol union (`routes.ts:2815-2820`). The desktop-side behaviors mentioned in the task brief — hub polling suspension, page-1 debounce, `hydration.done` handshake — live **entirely in the desktop client, not in `core`**; a repo-wide grep finds no such handshake or polling-suspension logic here. `core` exposes only the stream, the replay cursor, and the snapshot.
- **`/api/v1/ai/gateway/stream`**: the same desktop client, for AI-assisted reply drafting (territory 10).
- **`/api/v1/pages/:pageLabel/workboard/presence`**: the React **dashboard** workboard (cookie-authenticated dashboard users; territory 11) — a polled JSON report, not a subscription.
