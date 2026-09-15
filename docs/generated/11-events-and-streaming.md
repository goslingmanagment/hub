> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.
>
> **STALE (Decision 353, 2026-09-15):** the API-key lane no longer exists. The
> `apiKey` contract kind keeps its historical NAME but admits only a device
> token; `authMethod` is `session | device_token`; the `api_keys` routes,
> service, repository functions and CLI group are gone, as are the cookie
> issuance routes and the HTTP create-user/set-password. A bearer matching no
> lane prefix is refused with no lookup. `must_change_password` is retired (no
> gate, no 403 `password_change_required`, `mustChangePassword` a deprecated
> wire constant `false`) and `content_manager` left the wire role enum. The
> `api_keys` table, the column and the PG enum value all stay as facts.

# Events and Streaming

The runtime serves two Server-Sent Events protocols side by side. v1 streams
settled OFAPI webhook fanout with one global sequence. v2 streams canonical
domain events with a gapless sequence per account and an opaque multi-account
cursor. Both subscribe to a shared PostgreSQL LISTEN hub before capturing a
replay boundary, buffer live overlap, and close rather than advance across a
continuity loss.

## 1. Shared SSE mechanics

`apps/runtime/src/services/sse-replay-buffer.ts` provides three safety tools:

- `subscribeBeforeReplayBoundary` attaches the live subscriber before reading
  the committed replay ceiling. A commit before subscribe is in the ceiling;
  one after subscribe is buffered; overlap is harmlessly deduplicated.
- `createBoundedSseReplayBuffer` retains live objects during durable replay.
  Both HTTP streams use a 1,000,000-byte pre-replay cap. Overflow releases the
  retained array and destroys the connection so the unchanged client cursor
  can replay everything.
- `validateGaplessReplayBatch` requires exact `afterSeq + 1` progression
  through a captured ceiling. A short batch before the ceiling is itself a
  gap, not end-of-data.

Both routes send `retry: 3000`, heartbeat comments every 25 seconds, revalidate
credentials/assignments every 60 seconds, and end after 15 minutes so clients
reauthenticate. A socket with more than 1,000,000 buffered bytes is dropped as
a non-consuming client. There is no event-route rate limiter.

The LISTEN connections treat `NOTIFY` as a wakeup, never as the event payload.
Each hub serially rereads its durable journal, advances its delivery watermark
only after broadcast, catches up after LISTEN reconnect, and destroys rather
than pools a connection that has LISTEN state.

## 2. v1 OFAPI sync events

`apps/runtime/src/services/events-stream.ts` fans settled rows from the OFAPI
event journal. The event worker assigns a global `fanout_seq` in receive/settle
order and notifies `OFAPI_SYNC_EVENT_CHANNEL` in the settle transaction. The
single event worker/advisory lock described in
`docs/generated/09-ofapi-boundary.md` is what makes that global committed order
meaningful.

The hub drains retained deliverable rows in batches of 500 up to a captured
high-water. It also reads `getOfapiSyncReplayFloor`. If cleanup has advanced the
floor beyond a subscriber's cursor, `continuityLost(replayFloor)` closes that
connection; the hub itself rebases after notifying affected consumers so later
traffic can continue after snapshot recovery. Processed rows with no desktop
frame and cleaned tail rows may occupy sequence positions, so the hub advances
to the maximum of retained head and continuity floor after all deliverable
rows are read.

### `GET /api/v1/events/stream`

The route requires an API-key user and scopes frames to currently assigned page
ids. `Last-Event-ID` wins over the query fallback. A requested id ahead of the
current sequence, older than the retained replay window, or below the durable
continuity floor returns 409 `sync_snapshot_required` pointing to
`/api/v1/events/snapshot`.

The connection uses a monotonic global guard seeded from the requested id.
Replay is bounded by the committed high-water captured after live subscribe;
the replay floor is rechecked after boundary capture, during each replay page,
and immediately before flushing buffered live frames. A floor movement closes
at the last safe id.

Frame ids are decimal `fanout_seq` values. Event data is the validated legacy
`SyncEvent` union: message receive/send/delete, PPV unlock, tip, chat-list
refresh, presence, typing, and account auth. Duplicate replay/live overlap is
discarded by the monotonic guard.

### `GET /api/v1/events/snapshot`

This route calls `apps/runtime/src/services/ofapi-sync-snapshot.ts` for one
assigned OFAPI account. It returns page/auth state, hot threads/messages, cold
archive deltas, and unresolved tombstones plus a safe `snapshotCursor`.
Legacy thread pagination and the HMAC-signed `pageMode=bounded_v1`
`stateCursor` protocol are mapped in
`docs/generated/10-ofapi-projections.md`. A sticky cursor below the new replay
floor returns `sync_snapshot_restart_required`; that snapshot walk must restart
without its old snapshot/state cursor.

## 3. v2 domain-event hub

`apps/runtime/src/services/domain-events-stream.ts` generalizes the hub to one
watermark per account over `domain_events`. The append repository notifies
`DOMAIN_EVENTS_APPENDED_CHANNEL` with the account id as a hint. A reconnect
re-lists every account head because a LISTEN gap can hide activity on any
account.

For each dirty account, the hub captures `currentSeq`, reads batches of 500,
and validates exact continuity. If a retained interval is no longer gapless,
it calls each matching subscriber's
`continuityLost(accountId, afterSeq, throughSeq)` at the safe cursor. It then
rebases the shared hub watermark to the captured head so a client that has
completed snapshot recovery can receive future appends rather than leaving the
whole account lane wedged.

Per-connection guards reject duplicates and refuse a jump larger than one.
`advanceAfterSnapshot` is a separate narrow operation used only while a valid
snapshot-recovery cursor authorizes crossing erased sequence positions; live
delivery never uses it.

## 4. v2 cursor contract

`packages/contracts/src/domain-event-cursor.ts` defines canonical base64url
JSON. Clients must treat it as opaque.

| Version | Shape | Meaning |
|---|---|---|
| v2 | `{v:2,w}` | legacy/subset watermarks; absent granted accounts may be additively baselined at their current heads |
| v3 | `{v:3,w,s:"granted"}` | exact current grant universe; a newly granted account requires another state snapshot |
| v4 | v3/v2 watermarks plus `{r:"snapshot",e,b,t,c}` | temporary authorization to replay retained behavior across erased ledger holes after durable state recovery |

Here `w` is account-to-safe-sequence, `e` is the highest non-dry-run erasure id
observed at mint, `b` is immutable recovery base, `t` is immutable account
target, and `c` is the retained row count in each `(base,target]` interval.

These v2/v3/v4 cursors are not MAC-signed. The decoder enforces canonical
encoding, integer/account topology, version-specific fields, and
`base <= watermark <= target`; the route checks grant scope, current heads,
retained counts, and the server-side erasure epoch before trusting recovery.
This cursor must not be confused with the separately HMAC-signed OFAPI
snapshot `stateCursor`.

## 5. `GET /api/v1/events/v2/stream`

The route accepts a human session, user API key, or active device token and
derives the granted numeric account set. `Last-Event-ID` wins over `cursor`.
With no cursor it begins at the current heads and emits exact-grant cursors. A
supplied cursor may not name an account outside the grant.

Before opening SSE, the route loads per-account bounds and each contiguous
replay end. It returns 409 `sync_snapshot_required` when a watermark is ahead,
the next required event is already below the retained floor, an immediate hole
exists, a v4 recovery marker is invalid, or an exact-grant cursor is missing a
newly granted account.

If an ordinary cursor has a valid retained prefix followed by an internal
hole, the route does not discard that prefix. It replays the contiguous prefix,
then closes. The next reconnect is now positioned at the immediate hole and
receives the 409 snapshot instruction. This preserves behavioral events that a
state snapshot may not materialize.

Accounts are independent streams multiplexed on one connection; ordering is
guaranteed per account, not globally. Every `event: domain` frame contains:

- account id and account sequence;
- canonical type, occurrence time, and event data;
- fan, conversation, and message refs when present;
- the page's OFAPI account ref when mapped;
- optional normalized message payload enrichment.

The `id` line is the entire updated opaque multi-account cursor. Typing is not
ledgered; v2 forwards v1 typing as live-only `event: ephemeral` frames with no
id, so it never changes replay state.

### Temporary PPV frame suppression

At this commit `SUPPRESSED_V2_FRAME_TYPES` contains
`message.ppv_unlocked`. This is a serve-time incident tourniquet for desktop
versions that reject historically wrong conversation references and reconnect
in a paid-read loop. The event remains in the ledger. The connection guard
advances across it, but no frame is written; the next delivered domain frame's
cursor carries the advanced watermark. The code comment requires removal once
the desktop fleet tolerates/correctly handles the type.

## 6. Message enrichment

`apps/runtime/src/services/domain-events-enrich.ts` enriches
`message.received` and `message.sent` frames without changing the ledger. For a
normal OFAPI webhook event it loads the source observation envelope and applies
`normalizeOfapiSyncMessage`. Fansly/non-webhook/malformed sources remain thin.

A schema-v2 superseding message event instead builds its payload directly from
the complete `data.head`, including text, created time, direction, price,
opened/tip state, and media. Reading the old observation would reproduce the
material being corrected. Enrichment failure logs and serves a thin frame; it
does not drop the connection. Live enrichments are promise-chained so async
lookups cannot reorder an account's frames.

## 7. v4 snapshot recovery

Erasure can legitimately remove domain-event rows and leave sequence holes. A
v4 cursor says the client has already durably replaced materialized state and
may now receive retained behavioral events across those known holes.

During a v4 replay the route:

1. Verifies no erasure is incomplete, the erasure epoch matches, every target
   is still at or below the current head, and retained counts match the
   cursor-declared topology.
2. Replays every retained row from base through each immutable target using
   snapshot-only guard advancement.
3. Rechecks erasure epoch/incomplete state and retained counts after replay.
4. Removes the recovery marker and emits a normal-cursor
   `stream.snapshot_replay_completed` domain checkpoint.
5. Replays events committed after the snapshot targets through the ordinary
   strict gapless validator, then enters the live lane.

A failure before the completion checkpoint leaves the client's persisted v4
cursor in recovery mode. A topology/erasure change closes before publishing a
normal cursor, forcing a fresh snapshot.

## 8. `GET /api/v1/events/v2/snapshot`

The route accepts an optional account subset and optional opaque
`sourceCursor`. Requested accounts must be granted. It captures account heads,
computes a recovery floor per account, and asks the OFAPI state-coverage query
for the highest sequence safely represented by a subsequent state snapshot.
The response contains the recovery cursor and account id/native OFAPI ref/head;
the actual account state is fetched through the v1 snapshot endpoint.

With `sourceCursor`, the floor starts from the client's durably applied
watermark. An account absent from an exact-grant cursor is newly granted and
baselines at the captured head; absence from a legacy/subset cursor proves
nothing and starts at zero. An ahead-of-head source watermark also falls back
to zero.

Legacy clients that omit `sourceCursor` can still receive a v4 cursor when the
safe state sequence is behind the account head. The route refuses recovery
with 503 while an erasure is incomplete. Full-grant snapshots emit exact-grant
scope; explicitly requested subsets do not.

## 9. Conformance consumer and SDK

`apps/runtime/src/services/domain-events-smoke.ts` tails every account through
the same domain-event hub, replays from a persisted cursor, and records frames,
gaps, and duplicates. It checkpoints every 30 seconds and logs a summary every
ten minutes. On hub continuity loss it increments the gap counter and rebases
its local guard to the hub's captured head so later events do not become a
cascade of false gaps.

The smoke consumer's pre-replay array is not the HTTP route's bounded 1 MB
buffer; it is an internal conformance instrument. Expected replay/live overlap
is removed before duplicate accounting.

`packages/contracts/src/sdk-runtime.ts` exposes `subscribeDomainEvents`. It
persists/returns opaque frame ids, validates domain frames, surfaces a 409
through `onSnapshotRequired`, and deliberately leaves reconnect and snapshot
orchestration to the caller.

## 10. Route surface and invariants

`apps/runtime/src/modules/events/index.ts` registers all four event endpoints:

- `GET /api/v1/events/stream`
- `GET /api/v1/events/snapshot`
- `GET /api/v1/events/v2/stream`
- `GET /api/v1/events/v2/snapshot`

Key invariants are:

- subscribe precedes replay-boundary capture;
- a notification is only a signal to reread durable state;
- no ordinary connection advances its persisted cursor across a missing
  sequence;
- replay is bounded by captured committed heads rather than moving targets;
- grant changes close/recover rather than silently widening an exact cursor;
- ephemeral frames have no id and no replay promise;
- cleanup/erasure continuity floors are checked both before and during replay,
  because validation can become stale while a connection is opening.
