> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Events and Streaming

This document maps the two independent Server-Sent-Events (SSE) stacks the
kernel exposes to clients. **v1** streams OFAPI sync events from the
`ofapi_sync_events` journal in settle-ordered `fanout_seq`. **v2** streams
domain events (see `06-capture-and-canonicalization.md`) per account, using
opaque per-account watermark cursors over the gapless `domain_events` table. It
covers each hub (LISTEN/NOTIFY, serialized journal drain, monotonic-seq guard),
each SSE endpoint (frame shape, resume, the 409 snapshot handshake, heartbeat /
auth-revalidate / lifetime limits), the snapshot endpoints, the v2 cursor
contract, the enrichment builder, the domain-events smoke conformance consumer,
and the `modules/ingest` and `modules/events` route surfaces. Sources are
anchored to `file:line`.

## 1. v1 — OFAPI sync events

### Journal and fanout

The journal is `ofapi_sync_events`, populated by the OFAPI event worker in
`services/ofapi-events.ts`. Channel `ofapi_sync_events`
(`ofapi-events.ts:66`). The worker settles rows sequentially — a single worker
preserves `fanout_seq` settle order (`ofapi-events.ts:443`/`:449`) — assigns the
settle-order `fanout_seq`, then `pg_notify(OFAPI_SYNC_EVENT_CHANNEL, <rowId>)`
on commit (`ofapi-events.ts:343`). Queues: `ofapi.events.process.v2`, `sweep`
(cron `* * * * *`), and `cleanup` (cron `30 2 * * *`) (`ofapi-events.ts:59-61`,
`:253-254`).

### Hub

`createSyncEventHub` (`services/events-stream.ts:72`):

- A single shared LISTEN connection; a NOTIFY is a wake-up only — frames are
  never built from the notification payload (`events-stream.ts:207-214`).
- One serialized `drainJournal` reads forward from `deliveredSeq` in
  fanout-seq order via `listOfapiSyncEventsForReplay` (batch 500,
  `events-stream.ts:14`/`:133`), advancing the watermark only after a
  successful broadcast.
- `requestDrain` coalesces overlapping wake-ups (`drainAgain`,
  `events-stream.ts:102`).
- Reconnect backoff 1s→30s; drain-retry backoff 1s→30s.
- `createMonotonicSeqGuard` (`events-stream.ts:43`) enforces strictly increasing
  wire ids, so a `fanout_seq > Last-Event-ID` resume cannot skip.

### Endpoint `GET /api/v1/events/stream`

Registered at `modules/events/index.ts:86`.

- **Frame:** `id: <fanout_seq>\nevent: sync\ndata: <syncEvent JSON>`
  (`modules/events/index.ts:176`).
- **Resume:** via the `Last-Event-ID` header or `?lastEventId`
  (`modules/events/index.ts:98-104`).
- **Snapshot handshake:** if the cursor is ahead of `latestSeq` or below the
  retained window → HTTP 409 `sync_snapshot_required` (v1) with
  `snapshotPath /api/v1/events/snapshot` (`modules/events/index.ts:106-136`).
- **Subscribe-before-replay:** live frames buffer until the per-page replay
  flushes (`modules/events/index.ts:181-192`, `:275-279`).
- **Limits:** heartbeat `: keep-alive` every 25s
  (`SSE_HEARTBEAT_INTERVAL_MS`, `modules/events/index.ts:65`); auth revalidate
  every 60s (a revoked key or changed page assignment → `raw.end()`); max
  lifetime 15min (`:70`); drop if buffered > 1 MB (`:72`).

### Snapshot `GET /api/v1/events/snapshot`

Serves `getOfapiSyncSnapshot` (`services/ofapi-sync-snapshot.ts`), which reads
the hot/archive message tables plus the replay window. This is a serve-time
snapshot, not sync orchestration.

## 2. v2 — domain events, per account

### Hub

`createDomainEventHub` (`services/domain-events-stream.ts:60`) generalizes the
v1 discipline to **per-account watermarks** over the gapless `domain_events`
table:

- LISTEN channel `domain_events_appended` (`domain-events.ts:125`). The notify
  payload `<accountId>:<seq>` is parsed to mark `dirtyAccounts`; an invalid or
  non-positive payload triggers `rebaselineAll`
  (`domain-events-stream.ts:230-245`).
- The first LISTEN baselines `delivered` at `listDomainEventHighWaters`
  (`domain-events-stream.ts:256`). A reconnect after a gap sets `rebaselineAll`
  and re-lists high-waters (`:115-139`).
- The drain per dirty account reads `listEventsSince` (batch 500,
  `domain-events-stream.ts:21`), broadcasts, and advances that account's
  watermark.
- `createAccountSeqGuards` (`domain-events-stream.ts:42`):
  `advance(accountId, seq)` returns `{deliver, gap}` — `gap` is true when
  `seq > last+1` (a bug signal), and `deliver` is false when `seq <= last`.

### Endpoint `GET /api/v1/events/v2/stream`

Registered at `modules/events/index.ts:305`. The **cursor is the opaque
per-account watermark map, not a scalar.**

- **Cursor resolution:** from `Last-Event-ID` / `?cursor` via
  `decodeDomainEventCursor` (`modules/events/index.ts:331`). Granted-scope is
  enforced (a cursor account outside the grant → 403, `:337`). Accounts absent
  from the cursor start at their current "now" high-water (`:344`); with no
  cursor, all granted accounts start at now (`:349`).
- **Gap rule** (`modules/events/index.ts:359-374`) via
  `listDomainEventAccountBounds`: a watermark greater than `currentSeq` (never
  existed) or below `oldestRetainedSeq - 1` (pruned) → HTTP 409
  `sync_snapshot_required` (v2) with a per-account `accounts[]` list and
  `snapshotPath /api/v1/events/v2/snapshot`.
- **Frame:**
  `id: <encodeDomainEventCursor(guards.watermarks())>\nevent: domain\ndata: <frame JSON>`
  — the id line carries the **full re-encoded cursor**, not a scalar seq
  (`modules/events/index.ts:442`). Frame fields: `accountId`, `accountSeq`,
  `type`, `occurredAt`, `data`, `fanRef`, `conversationRef`, `messageRef`,
  `accountRef` (the OFAPI ref via `listPageOfapiAccountRefs`,
  `modules/events/index.ts:392`), and optional `payload` (enrichment).
- **Ordering:** per-account batched replay (`modules/events/index.ts:552-581`);
  subscribe-before-replay with a `liveChain` promise that preserves per-account
  order across async enrichment (`:461-473`).
- **Ephemeral lane** (Stage 24): typing indicators are forwarded from the v1
  `syncEventHub` as `event: ephemeral` frames — no id line, never advancing the
  cursor, live-only (`modules/events/index.ts:475-490`).
- **Limits:** the same heartbeat, auth-revalidate (bearer **or** session
  cookie), lifetime, and buffered-drop limits as v1.

### Snapshot `GET /api/v1/events/v2/snapshot`

Registered at `modules/events/index.ts:597`. Returns
`{cursor: encodeDomainEventCursor(watermarks), accounts: [{accountId,
currentSeq}]}` at the current high-waters.

## 3. The v2 cursor contract

`packages/contracts/src/domain-event-cursor.ts` defines an opaque base64url JSON
value `{v: 2, w: {<accountId>: <highSeq>}}` (`:44-51`), with sorted keys for a
deterministic encoding. It is isomorphic (uses `btoa`/`atob`, no `Buffer`) so
the same code runs in the browser SDK and in node. `decodeDomainEventCursor`
validates `version == 2`, positive-integer account ids, and non-negative-integer
watermarks; a round-trip guard rejects non-canonical base64 (`:35`). The module
is shared by the server (`modules/events`, `domain-events-smoke`) and the SDK.

## 4. Enrichment

`buildMessagePayloadEnrichments` (`services/domain-events-enrich.ts:35`)
augments frames for `message.received | sent` only, when `observationId > 0`,
`conversationRef` is non-null, the source is `webhook`, and the observation kind
is `messages.received | sent` (`domain-events-enrich.ts:18-19`, `:39-54`). It
fetches the source observation envelopes (`findObservationEnvelopesByIds`) and
builds a normalized message via `normalizeOfapiSyncMessage`, returning
`event.id → message`. A failure degrades to the thin frame and never drops the
connection (`domain-events-enrich.ts:448-456`).

## 5. Conformance instrument

`startDomainEventsSmokeConsumer` (`services/domain-events-smoke.ts:72`,
Stage 21) is a permanent worker-side subscriber over the **same hub**
(`accountIds: undefined` = every account). It counts gaps and duplicates (both
must stay 0), checkpoints its cursor to `domain_events_smoke_checkpoint` every
30s (`domain-events-smoke.ts:26`), and logs a summary every 10min. It resumes
from the stored cursor or "now", and its live-buffer-then-replay ordering
mirrors the endpoint (`domain-events-smoke.ts:158-200`).

## 6. Route surfaces

### `modules/ingest/index.ts:32` `registerIngestRoutes`

The observation front doors:

- `POST /api/v1/ingest/observations` — client-capture lane (see
  `06-capture-and-canonicalization.md` §3).
- `POST /api/v1/ofapi/webhook` — own plugin scope, buffer-mode body parser,
  HMAC over raw bytes → `receiveOfapiWebhook` (`modules/ingest/index.ts:91-110`).
- `GET` / `POST /api/v1/admin/ofapi/webhook` — owner-only status / register
  (`:113`, `:122`).
- `GET /api/v1/ofapi/read/*` — read gateway
  `executeOfapiReadGatewayRequest` (capture-through; `:131`).
- `POST /api/v1/ofapi/commands`, `GET /api/v1/ofapi/commands/:id`,
  `POST /api/v1/ofapi/commands/:id/cancel` — command outbox (`:153`, `:178`,
  `:186`).

### `modules/events/index.ts:47` `registerEventsRoutes`

The stream + snapshot pairs:

- `GET /api/v1/events/stream` (v1 SSE), `GET /api/v1/events/snapshot`.
- `GET /api/v1/events/v2/stream` (v2 SSE), `GET /api/v1/events/v2/snapshot`.
- An `onClose` hook destroys hijacked SSE streams and closes both hubs
  (`modules/events/index.ts:54-62`). The hubs (`syncEventHub` /
  `domainEventHub`) are created lazily per module (`:51-52`).

## 7. Notable invariants

- The v1 stack builds frames only from the serialized journal drain, never from
  the NOTIFY payload; the monotonic-seq guard prevents a resume from skipping.
- The v2 stream id line carries the whole per-account cursor (not a scalar seq),
  so resume is per-account and the gap rule can detect a pruned or
  never-existed watermark independently for each account.
