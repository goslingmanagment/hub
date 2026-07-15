> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# OFAPI Webhook, Readthrough, and Sync Projections

OFAPI material is exposed through several read models with different
freshness and retention roles. Webhook settlement is the durable source
boundary; post-settle projectors update hot UI state and a cold archive,
readthrough observations close webhook gaps, and the corrections lane turns a
merged material head into superseding domain events.

## 1. Projection execution model

`apps/runtime/src/services/ofapi-events.ts` calls projectors only after an
OFAPI journal row has settled. Each projector is feature-gated, idempotent,
records its own status/error, and catches failures so it cannot roll back
settlement or legacy SSE fanout. The minutely `ofapi.events.sweep` retries
pending/failed rows, generally in batches of 200 and with a five-attempt cap.

The same minutely worker also monitors account health and credit burn. Event
cleanup at 02:30 UTC applies configured journal retention and cold-archive
retention; both defaults are currently 36,500 days, an effectively-forever
stand-down rather than a short business-fact window.

`apps/runtime/src/worker-services.ts` attaches a second sequence to
`canonicalize.sweep`: canonicalize observations, reconcile readthrough
observations into cold material, then reconcile changed cold material into the
domain-event ledger. This order lets the corrections pass see merges from the
same minute.

## 2. Hot DM projection

`apps/runtime/src/services/ofapi-dm-projection.ts` consumes
`messages.received`, `messages.sent`, `messages.deleted`,
`messages.ppv.unlocked`, and `tips.received` when
`ofapiDmProjectionEnabled` is true.

Received/sent payloads require a platform message id, the fan object
(`fromUser` for received, `toUser` for sent), and a valid timestamp. The fan id
is also the OnlyFans chat/conversation id. The projector writes shared
`page_dm_threads` and `page_dm_messages`, creates/updates fan identity, advances
the conversation head only by timestamp and deterministic message-id order,
and applies a lightweight unread heuristic. A new fan head increments unread;
a new model head clears it. Later REST sync is authoritative for reconciliation.

The write transaction takes the DM erasure-writer fence and checks material
time/refs before recreating visible rows. It locks an existing conversation
through read-compute-upsert and uses forward-only head semantics for the
insert-race case. Retention pruning is permitted only through
`page-dm-retention.ts`, where both the feature gate and proven archive coverage
must allow it.

A delete removes the hot message and recomputes the thread window/head. A PPV
unlock marks a stored message purchased; a tip raises its stored tip amount.
Notifications that refer to material outside the hot window are skipped here
but remain represented in journal/domain-event/cold paths.

## 3. Cold DM archive and candidate reducer

`apps/runtime/src/services/ofapi-dm-archive.ts` consumes received, sent, and
deleted messages when `ofapiDmColdArchiveEnabled` is true. It normalizes text,
price, tip, reply, and media metadata into `dm_message_archive`; media content
itself is not downloaded. Deletes may create a tombstone stub even when message
material is absent. Archive status and retry attempts stay on the OFAPI journal
row.

All material upserts converge in
`packages/db/src/repositories/dm-message-candidate.ts`. Its sources are
`webhook`, `rest_reconcile`, and `command`. The reducer runs under a row lock,
honors the same erasure fence, tracks source observation/platform edit times,
and applies source/field precedence rather than blind last-write-wins. It
maintains a material fingerprint and preserves source lineage needed for later
event emission. `packages/db/src/repositories/dm-message-archive.ts` adapts the
webhook and REST input shapes to that reducer; confirmed direct sends call it
from `ofapi-command-executor.ts`.

The archive's uniqueness key is platform plus OFAPI account plus platform
message id. Conversation ref remains nullable because a delete can arrive
without chat scope. This is why cross-store tombstone lookups use message
identity rather than assuming every tombstone belongs to a populated thread.

## 4. Readthrough reconcile

When `ofapiDmReadthroughReconcileEnabled` is true, successful chat-message
gateway reads are captured as `ofapi_gateway_chat_messages_v2` observations.
`apps/runtime/src/services/ofapi-dm-readthrough.ts` is a dedicated projector,
not a canonicalizer family.

The API drainer attempts immediate best-effort projection after capture. The
scheduled retry reads observations below its own parse floor and follows
project-then-stamp semantics:

- 100 observations per page, at most ten pages per run;
- at most 5,000 message items per run;
- a malformed item is skipped/countable while other items continue;
- a database/upsert error leaves the observation unstamped;
- budget exhaustion mid-observation leaves it unstamped, and idempotent replay
  repeats any already-written items;
- erasure-lock deferral leaves it unstamped; a definite erasure fence hit
  drops that item and allows the observation to stamp.

The runner measures non-sentinel conflicts in text, price, direction,
timestamp, reply, and media. Those counters are telemetry; final merge
arbitration belongs to the central candidate reducer.

## 5. Corrections and superseding events

`apps/runtime/src/services/dm-corrections-reconciler.ts` is gated by
`ofapiDmCorrectionsReconcileEnabled`. It scans at most five pages of 100 rows
and resumes through an in-memory keyset cursor, wrapping at the end. Its signal
is `material_fingerprint != emitted_fingerprint`.

For a row with no emitted fingerprint, it appends the first canonical
`message.received` or `message.sent` event using
`msg:<direction>:<messageId>`. A late webhook canonicalizer therefore dedups
against the same claim. For already-emitted material that changed, it appends
a schema-v2 event with a fingerprint-specific dedup key and data containing
`supersedesEventId`, the fingerprint, and the complete merged `head`.

Only after append/dedup returns an event id does the reconciler compare-and-set
the emitted fingerprint. A concurrent material advance remains signaled for
the next pass. Null-ref stubs and rows whose source observation cannot be
resolved are counted and left pending; the code does not invent observation
lineage. `dm-corrections-backfill.ts` and
`dm-corrections-lineage-intake.ts` are the staged preparation/repair tools for
historical rows.

The ordinary domain-event message archive in
`apps/runtime/src/services/projections/message-archive.ts` understands these
schema-v2 complete heads. `projections/message-archive-rebuild.ts` can rebuild
that archive into the migration-0083 shadow table, verify coverage/material
differences, and switch tables under its advisory lock.

## 6. Audience and presence projections

`apps/runtime/src/services/ofapi-subscription-projection.ts` consumes
`subscriptions.new` and `subscriptions.renewed` behind the OFAPI audience-sync
gate. Subscriber identity is `payload.user.id`; a top-level `user_id` is not
trusted because other notification shapes use it for the creator. The
projection creates/updates the fan, active subscription, fan-page subscriber
state, and optional last-seen presence. A row lock preserves fresher
renew/expiry/generation fields owned by the REST audience sweep, and source
timestamps move only forward.

`apps/runtime/src/services/ofapi-presence-projection.ts` consumes online and
offline events when `ofapiPresenceProjectionEnabled` is true. It updates only
fans already known to core; it does not spend an OFAPI credit looking up every
unknown presence id. The presence store's greatest/observation-time rules keep
out-of-order webhooks from regressing a fresher last-seen value. DM and
subscription payloads can also fold their embedded fan `lastSeen` into the
same store.

## 7. DM analytics and projection debt

`apps/runtime/src/services/ofapi-dm-analytics.ts` rebuilds the rolling 32-day
DM analytics window hourly at minute 10. It derives summaries from stored
facts rather than making provider calls.

The DM history sync records a durable projection-debt row if its vendor facts
and raw payload are committed but thread-summary finalization fails.
`apps/runtime/src/services/projection-debt-sweep.ts` scans 20 unresolved rows
every five minutes, recomputes the current thread summary with the same prune
gate as sync, and resolves the debt. A missing conversation resolves as
nothing left to repair. This repair path never contacts a platform.

## 8. AI transcript union

`packages/db/src/repositories/ai-transcript-union.ts` gives OnlyFans fast reply
a single-statement MVCC view over the domain-event `message_archive` and the
fresher post-settle `dm_message_archive`. It is deliberately OnlyFans-only;
Fansly has no parallel webhook/cold lane.

The query scopes both arms to page and conversation, applies tombstone
dominance across both archives and hot `page_dm_messages`, prefers the cold DM
row when the same message exists in both, and lets a hot purchased marker only
upgrade `isOpened` to true. Stub rows are excluded. Deduplication/deletion
happens before the tail limit, and ordering is deterministic by event time,
guarded numeric message id, then lexical id. The hard maximum is 1,500 rows.
The repository also exposes `EXPLAIN` over the exact production statement for
its performance gate.

## 9. OFAPI sync snapshot

`apps/runtime/src/services/ofapi-sync-snapshot.ts` reconstructs one assigned
OFAPI account from page identity/auth state, hot threads/messages, cold archive
deltas, and unresolved tombstones. Presence and typing are explicitly omitted
as ephemeral. `resumeAllowed` is true only when both hot DM projection and cold
archive are enabled.

The legacy response uses numeric `pageCursor` over threads. Its first page also
returns unresolved tombstones after the requested sequence; per-thread output
combines hot rows with archive messages/tombstones, with archive material
overwriting a hot twin when both stores contain the same message id.

`pageMode=bounded_v1` is the state-safe walk. The initial request captures a
sticky `snapshotCursor` plus maximum thread, archive, and hot-message row ids.
One response page advances exactly one of three phases:

1. unresolved tombstones;
2. archive rows for a thread;
3. hot rows for that thread.

`apps/runtime/src/services/ofapi-sync-snapshot-cursor.ts` HMAC-signs the full
scope and phase as `stateCursor`, including account, `afterSeq`, snapshot
cursor, state time, message limit, high waters, thread id, and row position.
The MAC is domain-separated, key-versioned, canonical base64url, and verified
with the configured key ring. Continuations cannot change request scope or
choose arbitrary keyset positions. A thread hard-deleted by erasure is safely
skipped because signed thread ids are monotonic positions. If retention moves
the replay floor above the sticky cursor, the client must restart the snapshot.

## 10. Page identity support

`apps/runtime/src/services/onlyfans-page-metadata-backfill.ts` refreshes
OnlyFans page username, display name, and avatar from the mapped OFAPI account.
It is OFAPI-only; the retired OnlyMonster credential path is not a fallback.
Pages without mappings or accounts absent from `/accounts` fail individually,
with redacted error text.

`apps/runtime/src/services/onlyfans-public-profiles.ts` is a separate fan-id
resolution support path. A headless, cookie-free Playwright context visits
`onlyfans.com/u<id>`, waits for the matching public user API response, verifies
the returned id, and extracts username/display name. It blocks heavy resource
types, applies request spacing and optional proxy, classifies 404/429/401/403,
and exposes an explicit close operation. This public-profile resolver is not
the OFAPI account metadata source and does not share the OFAPI credit ledger.

## 11. Projection invariants

- Settled webhook truth does not depend on any projection succeeding.
- Every writer that can recreate DM material participates in the erasure
  fence; a held lock defers rather than burning an attempt.
- Hot storage optimizes current UI state, cold storage retains richer material,
  and the domain-event archive is append-only history. They are related but
  not interchangeable.
- A correction replaces material through an explicit superseding event; it
  never silently edits a prior event.
- Snapshot recovery is only safe when the declared hot and tombstone coverage
  gates are active and its sticky cursor remains above the replay floor.
