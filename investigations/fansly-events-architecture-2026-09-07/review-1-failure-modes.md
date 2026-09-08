# Review 1 — failure modes, data loss, hidden dependencies

Adversarial review of `ARCHITECTURE.md` (2026-09-07) §5–§9. The brief was to
refute, not to praise: every finding below is an attempt to construct a concrete
scenario in which the design loses a fact, shows wrong data behind a green
dashboard, hides a thread, double-writes, breaks a Hub law, or simply cannot be
built the way the document says it can.

Method: every claim was checked against the code at `582ef1cf`. No production
access, no Fansly connection, nothing modified. `evidence/` A–D were read; the
parallel Codex investigation was **not** read.

Severity: **P1** = blocks the design as written · **P2** = must fix before live
· **P3** = note.

---

## P1 — blocking

### P1-1. The Fansly sweep is deliberately NOT head-forward-only, and the doc adds the second writer that exemption assumed away

**Scenario.** WS delivers `M2` at 12:00:03; the inline projection writes
`last_message_id=M2`, `last_message_at=12:00:03`, preview, `unread+1`. The
`dm_conversations` sweep for `lilly-2` started at 11:58 and takes **12 m 27 s**
of wall time (evidence C §4). It read the group page containing this thread at
11:59 (head `M1`) and commits it at 12:06. The upsert writes
`last_message_id=M1`, `last_message_at=T(M1)`, the old preview, and
`unread_count = <provider snapshot>` — which is the value from before `M2`.
Result: the chatter's list shows the old message, `unread_count` drops back to 0,
`last_fan_message_at` regresses, the workboard SLA driver
(`engine.ts:276`, `:739`) loses the fan message, and the candidate selector will
NOT re-read the thread because its second conjunct
(`last_message_sync_at < last_message_at`) is now false against the regressed
timestamp. The row self-heals only at the *next* full sweep — i.e. up to
**6 hours** in the target state. Nothing is journal-lost, but the fan is hidden
from every live surface for hours.

**Evidence.**
- `packages/db/src/repositories/page-dm.ts:136-141` — the exemption, stated
  verbatim: *"the OFAPI writers set this — Fansly's REST sync stays
  authoritative for its heads (**it has no concurrent second writer** and must
  be able to move a head back when the platform deleted the head message)"*.
- `packages/db/src/repositories/page-dm.ts:147-162` (`headAdvanceCondition`),
  `:222-230` (`headGuardedSet`) — the guard exists but is opt-in.
- `apps/runtime/src/services/sync/executor-handlers.ts:3302` (`unreadCount:
  conversation.unreadCount`), `:3304` (`lastMessageId`), `:3235-3240`
  (`preservedLastFanMessageAt`) — the Fansly sweep passes no
  `headForwardOnly`, so all of these are unconditional `excluded` assignments.
- `apps/runtime/src/services/ofapi-dm-projection.ts:325` — the precedent the doc
  cites *does* pass `headForwardOnly: true`. The doc copies the projection but
  not the guard, and the guard belongs on the *other* writer.
- Sweep wall time: `evidence/C-prod-volume.md` §4 (lilly-2 12 m 27 s, 142 pages).

**Minimal fix / question to settle.** The head-regression problem cannot be
solved by flipping `headForwardOnly: true` on the Fansly sweep, because the
comment names the reason it is off: the sweep must be able to move a head
*backwards* after the platform deletes the head message. The design needs a
third state — e.g. the sweep may only regress a head when the group row's
`lastMessageId` is *absent or provably deleted*, never merely older — plus
`headForwardOnly` for the ordinary path. This is a real change to a load-bearing
invariant (#50) and must be specified before any WS write lands.

---

### P1-2. Stamping `last_seen_generation` from the socket breaks G3 membership certification — permanently

**Scenario.** §5.2 D.2 and §7.3 #1 say the inline projection sets
`last_seen_generation` = the current sweep generation for a **new** thread, so
the finalizer will not hide it. But the finalizer certifies membership by an
**exact** equality between the row-side generation set and the sweep's own
observed count. A WS-created thread stamped with the running generation adds 1 to
`generationSetCount` and 0 to `finalObservedCount`. Certification fails →
`destructiveFinalization = false` and `finalizationWithheld = true` → the sweep
does not hide vanished threads, does not advance `lastFullSweepCompletedAt`, and
the coverage UX never advances. On `lilly-2` (12.5-minute sweeps, 48/day,
constant inbound traffic) at least one new thread will land inside almost every
sweep window, so this is not a rare race — it is the steady state. The
architecture's own "единственное доказательство отсутствия" (§5.2 F) stops
existing.

**Evidence.**
- `apps/runtime/src/services/sync/executor-handlers.ts:3413` (count read inside
  the write txn), `:3454` (`membershipCertified = generationSetCount ===
  finalObservedCount`), `:3455-3465` (destructive finalization + comment: *"Any
  gap, in either direction and however plausible, means the membership record
  cannot be trusted"*).
- `packages/db/src/repositories/page-dm.ts:288-300`
  (`countPageDmThreadsByGeneration`), `:247-264`
  (`markPageDmConversationsInvisibleByGeneration`).
- The sweep already self-reports this divergence as an early warning at
  `executor-handlers.ts:3596-3600`.

**Minimal fix.** Do **not** stamp generations from the socket. `page_dm_threads`
already carries `created_at` (`packages/db/src/schema.ts:1225`), so the guard
the doc wants is the `lastSeenBefore` half alone: add
`and created_at < <fullSweepStartedAt>` to the invisibility predicate and leave
`last_seen_generation` NULL for WS-created rows. Then the certification count is
untouched. This must be written into the design, because the doc currently
prescribes both halves and the first one is the harmful one.

---

### P1-3. The journal idempotency key `page:generation:frameSeq` silently drops frames — a capture-first (DP 7) violation

**Scenario A (two connections).** §5.2 A's exactly-one-connection is enforced by
an advisory lock *plus* a 120 s lease. During any window where both can be held
(worker restart, lock-vs-lease disagreement — see P2-6), two sockets exist. Both
number their frames from a **per-connection** counter, and both carry the same
`generation` (which the doc defines as the *credential* generation, not the
connection). Frame #7 on socket B collides with frame #7 on socket A. The
observation writer treats the collision as a replay: it returns
`inserted: false` and **writes no row and no payload at all**. Frame #7 of
socket B is gone forever. That is exactly the fact-loss DP 7 exists to prevent,
and it is invisible — the code path is the normal dedup path.

**Scenario B (restart, single socket).** A worker restarts, reconnects with the
same credential generation, and starts `frameSeq` at 1 again. Every frame up to
the previous connection's high-water mark is silently discarded.

**Evidence.**
- `packages/db/src/repositories/observations.ts:149-171` — on a
  `(source, idempotency_key)` conflict the function returns the *existing*
  observation and never writes the new body.
- `packages/db/src/schema.ts:3397-3408` — `observation_keys` PK is
  `(source, idempotency_key)`.
- Doc §5.2 B: *"Идемпотентный ключ: `page:generation:frameSeq` (frameSeq —
  счётчик соединения)"*.

**Minimal fix.** The key must include a per-**connection** identity that is
unique across processes and restarts (a connection UUID minted at `open`), e.g.
`page:connectionUuid:frameSeq`. `generation` alone is not it. Also add a test
that two concurrent supervisors on one page write two distinct journal rows for
two distinct frames.

---

### P1-4. "Dedup by content hash" is not how the kernel dedups. The real mechanism is first-writer-wins on a key, and it makes the thin WS event permanently authoritative

The document asserts hash-based dedup three times (§2.2 diagram, §5.2 B, §7.1)
and builds a design requirement on it: §5.2 C says the WS canonicalizer must
produce a **byte-identical canonical body** so the later REST read "dedups by
hash". That is not the mechanism.

**What the code does.** `domain_events` dedups on an explicit, family-authored
string claimed in `domain_event_keys (account_id, dedup_key)`; the Fansly DM
family builds it as `` `msg:${direction}:${messageId}` `` and nothing hashes the
payload. `message_archive` then applies **first REAL writer wins** — the
conflict update is gated `where target.content_pending`, i.e. it hydrates only a
tombstone stub, never a content row.

**Why it matters (the failure this creates).**
1. Byte-identity is *irrelevant*: two structurally different events with the same
   key still collapse to one, and the **first** one (the WS one) is the one that
   survives. There is no detector — a field mismatch produces no anomaly, no
   incident, no metric.
2. Any field the WS frame carries differently from the REST body is frozen into
   the archive, the AI transcript and the Agent Read Plane for 100 years. Per
   evidence A §4.2 the WS message object *does* carry `totalTipAmount` and
   `content`, so the canonical subset `{text, tipAmountMills, isTip}` is
   *reachable* — but reachable is not proven, and the design gives no way to find
   out it was wrong.
3. `direction` is inside the dedup key. `sync-pull` resolves it as
   `senderId === ownRef`, where `ownRef` comes from a canonicalizer **context
   map** the driver supplies; when that map has no entry the family emits **zero
   events**. A WS family that resolves the page's own account ref from a
   different place (e.g. `fansly_ws_sessions`) can emit `msg:sent:X` where pull
   would have emitted `msg:received:X` — producing **two** domain events and two
   archive attempts for one message, with the second silently dropped.
4. `occurredAt` is likewise first-wins, and `domain_events` is partitioned by it.
   A WS canonicalizer that mishandles the seconds-vs-milliseconds ambiguity
   (evidence A §7.2 says the units differ per field) writes the message into the
   wrong partition, and the correct REST event can never repair it — the same
   class of damage as the 1970 incident the pull family carries a comment about.

**Evidence.**
- `packages/db/src/repositories/domain-events.ts:356-372` — key claim, dedup,
  and "surface the EXISTING claim's event id".
- `apps/runtime/src/services/canonicalize/sync-pull.ts:206`
  (`dedupKey: msg:${direction}:${messageId}`), `:183-186` (direction from
  `ownRef`), `:163-167` (zero events when `ownRef` is null), `:193-198`
  (`occurredAt: asFanslyTimestamp` and the 1970 comment).
- `packages/db/src/repositories/message-archive.ts:336-374` — *"First REAL
  writer wins: the conflict-update only hydrates tombstone-first stubs
  (`content_pending`), never a content row"*, and the literal
  `where ${target}.content_pending`.

**Minimal fix.** Rewrite §5.2 C's requirement: the contract is **identical
`dedupKey`, identical `occurredAt` derivation, identical `direction` resolution
(same `ownRef` source as `sync-pull`), and identical `data` field set** — not
byte identity, which is neither necessary nor sufficient. Add a shadow-stage
assertion that compares the WS-derived draft with the pull-derived draft for the
same `messageRef` on real traffic and raises an anomaly on any difference; the
current design has no way to notice divergence at all.

---

### P1-5. §5.2 D.3 ("write the message row but do not move `newest_stored_message_id`") is not implementable through the cited precedent, and skipping the refresh starves the surfaces that matter

**Scenario.** The doc's enrichment trick depends on leaving
`newest_stored_message_id` behind so the existing candidate selector fires. But
the OF precedent it cites calls `refreshPageDmConversationWindow`, whose entire
job is to **recompute `newest_stored_message_id`, `stored_message_count`,
`oldest_stored_message_id`, `last_fan_message_at` and `last_model_message_at`
from the rows on disk**. Using the precedent defeats the trick; skipping it
leaves those five columns stale — and four of them are read by live surfaces:

- `last_fan_message_at` / `last_model_message_at` → workboard needs-reply and the
  SLA driver (`modules/workboard/engine.ts:276`, `:342`, `:736-759`), plus
  `reporting.ts:777`, `spenders.ts:155`, `agent-read/handlers-threads.ts:630`.
- `stored_message_count` → the workboard's coverage branch
  (`engine.ts:473-475`) and the Agent Read Plane's
  `transcriptWillReturnRows: row.storedMessageCount > 0`
  (`handlers-threads.ts:644`, `handlers-core.ts:752`).

So a thread that has received 40 WS messages reports
`transcriptWillReturnRows: false` to the agent while 40 rows sit in
`page_dm_messages`, and the workboard's needs-reply timer never starts.

**Evidence.** `packages/db/src/repositories/page-dm.ts:753-793`
(`getPageDmMessageWindowSummary`), `:841-915`
(`refreshPageDmConversationWindow`); the call the doc points at is
`apps/runtime/src/services/ofapi-dm-projection.ts:340-345`.

**Minimal fix.** Split the refresh: recompute `stored_message_count`,
`oldest_stored_message_id`, `last_fan_message_at`, `last_model_message_at`
inline, and hold back **only** `newest_stored_message_id`. Or drop the trick
entirely and enqueue the enrichment explicitly (see the alternative in P1-6).
Either way the doc's one-line "не двигать newest_stored_message_id" hides four
columns of collateral damage and must be rewritten.

---

### P1-6. The cheapest alternative is never evaluated, and it is the same mechanism the design invents for catch-up

§4's option 5 ("keep polling, shrink the sweep") is scored at "−30…-50 % on
`dm_conversations`, freshness unchanged" — on the basis of `unchangedPageStreak`,
which is indeed computed and never read
(`services/sync/cursor-state.ts:59`, `executor-handlers.ts:3330`; no reader
exists anywhere in the tree). But §5.2 F simultaneously proposes a **bounded
newest-first walk** (`sortOrder=1`, stop at the first page whose heads are all
older than the window) as the gap catch-up, and claims it costs 1–3 pages
instead of 140.

If that mechanism works, it works in the steady state too: 48 sweeps/day ×
~3 pages × 6 pages ≈ 900 requests/day fleet-wide against today's 15 680 — the
**same ~49 % fleet reduction the socket buys through stage 3** (§6's own
arithmetic), with no new connection to Fansly, no second head writer, no session
custody question, and none of M1/M3/T1/S1 open. Freshness stays at 30 minutes,
which is the one thing it does not buy — and freshness, not request count, is
therefore the real justification for the socket. The document never says that,
and its option table never credits option 5 with the saving its own §5.2 F
claims for the identical walk.

The two claims are also mutually constraining: if `sortOrder=1` is not
newest-first, the bounded catch-up silently reads the wrong end of the list
(see P2-3); if it is, the cheap alternative exists.

**Minimal fix / question to settle.** Add the bounded newest-first sweep as an
explicitly costed option, and state the socket's justification in the terms the
evidence actually supports: **latency (30 min → seconds)**, not request volume.
If the owner's driver is request volume, the socket is the expensive way to buy
it.

---

## P2 — must fix before live

### P2-1. The health override generalization is weaker than the OF one it copies, and #191's own lesson repeats outside `/health/sync`

Two distinct problems.

**(a) The signal changes meaning.** `overrideMessagesLiveBlockWithOfapiIngest`
is fed by `getLatestSettledOfapiDmEventTimes` — the age of the last **settled
domain event**, i.e. proof that data actually flowed all the way through the
pipeline. §5.2 G proposes keying the Fansly variant off `fansly_ws_sessions`
(frame/pong age). A pong proves the pipe is alive, not that events arrive. The
M3 worst case in the doc's own §7.1 — the server load-balancing events to the
browser instead of us — produces a socket that is `connected`, ponging, and
receiving nothing: the override reports `ws_live`, `/health/sync` is green, and
reconcile is at 360 minutes. That is the "green dashboard, wrong data" case
verbatim. The 12-hour deadman is too coarse to be the answer.
*Fix:* key the Fansly override on the age of the last **settled `message.*`
domain event for that page**, exactly as OF does; keep `fansly_ws_sessions` for
the connection-state gauge only.

**(b) `succeeded_at` is stamped, and `/health/sync` is not the only reader.**
Item 5 of the brief resolves in the doc's favour on the narrow point: #191 is
explicitly scoped to `gatedSkip`, and the `StreamChunkResult` comment names
sweep-not-due as deliberately **excluded** from it, so the OF `reconcile_not_due`
path stamps `succeeded_at` on purpose and there is no conflict. But #191's
*lesson* is that a chunk with zero egress generated every green signal in the
system for 13 days. With reconcile at 360 min, `dm_conversations.succeeded_at`
is refreshed every 30 minutes by a no-op skip, and the doc fixes exactly one
consumer. `buildStreamSyncUx` ("Up to date"), the top-spenders route's
`source.lastSyncedAt`, the monitor page rollup and
`resolveSyncChunkRecoveryIncidents` all keep reading the same stamp.
*Fix:* either make the skip carry an honest marker those readers understand, or
state in the design which surfaces are knowingly left reporting a 30-minute
freshness for data that is 6 hours old.

**Evidence.** `apps/runtime/src/services/sync-status.ts:1386-1440`,
`:1578-1590`; `apps/runtime/src/services/sync/executor-handlers.ts:393-401`
(the comment that settles item 5); `apps/runtime/src/services/sync/ofapi-dm-sync.ts:556-573`;
`docs/decisions.md:5732-5790` (#191).

### P2-2. The snowflake epoch is fitted for follow-relation ids and is not proven for message ids — and it is not needed

`packages/shared/src/snowflake.ts` is eight lines: one constant,
`FOLLOW_RELATION_EPOCH_MS = 1561494359900`, and one function
`fanslyFollowIdToDate`. The constant is not a round number, which is the
signature of a value fitted from an observed follow id, and both call sites feed
it follower ids (`executor-handlers.ts:1997`, `:2641`; also
`canonicalize/fansly-replay.ts:184`, whose comment says *"The follow relation id
IS the follow moment"*). No test and no evidence in A–D establishes that Fansly
uses the same epoch and bit layout for message ids.

§5.2 F makes this constant the **stop condition** of the bounded catch-up. If the
epoch is off, the walk either terminates on page 1 (threads with new messages
never re-read — silent loss) or never terminates (a full 142-page sweep at every
reconnect — the avalanche §7.2 promises cannot happen).

*Fix:* do not use snowflake decoding here. The group row already carries the
full last message object with its own `createdAt`
(`packages/fansly/src/types.ts:250`, `:284`), which is what the sweep already
reads for `lastMessageAt`. Note also that `lastMessageId` is **nullable** in the
same type (`types.ts:261`), so the doc's "все `lastMessageId` старше начала
окна" has an undefined answer on rows where it is null — the stop condition must
say what a null does (it must **not** count as "old").

### P2-3. `sortOrder=1` = "newest first" is an assumption, not a fact

The sweep passes `sortOrder: 1` (`executor-handlers.ts:2906-2911`;
`packages/fansly/src/adapter.ts:1157` makes it the default) but nothing in the
repo, in evidence A, or in the bundle reverse states what the value *means*. The
current sweep does not care — it walks every page. The bounded catch-up depends
entirely on it. The circumstantial support is real (evidence C §5: 149 of 289
failures are the duplicate/overlapping-group-id guard, i.e. the list demonstrably
reorders under an offset walk, which is what a recency sort does) but it is
circumstantial. *Fix:* add "confirm `sortOrder` semantics" to the stage-0
checklist; it is a one-request test and it gates both P1-6 and P2-2.

### P2-4. The overlap-exclusion fix (§7.3 #5) needs a column the design does not add, and its cure is an avalanche

Two problems with "не засчитывать WS-строки, записанные после начала последнего
gap".

*Implementability:* the overlap proof is `getExistingPageDmMessageIds`, which
selects only `platform_message_id` and has no notion of source or write time
(`packages/db/src/repositories/page-dm.ts:1002-1023`). §5.3 adds only
`material_source` to `page_dm_messages`; `material_source='ws'` alone cannot say
*when* the row was written, and every WS row will be `ws` forever, so excluding
all of them makes every incremental walk page back to the beginning of time. The
column that would work already exists — `page_dm_messages.synced_at`
(`packages/db/src/schema.ts:1295`) — provided the upsert does not refresh it on
conflict. The design must say so.

*Consequence:* once WS rows stop counting as overlap, a post-gap incremental walk
must page back until it meets a `pull` row. After a 6-hour reconcile interval
with a busy thread that can be 10+ pages of 25, per thread, and it fires **at
reconnect** — precisely when the socket is unhealthy and the reconcile is also
firing. §7.2's ceiling ("`fanslyWsFollowupCallsPerHour` + 1 `dm_messages` request
per page per minute") does not bound this, because the walk depth per candidate
is unbounded and is charged to the executor's chunk budget, not to the followup
budget.

### P2-5. `bounded_catchup` must not share the `dm_conversations` checkpoint

§5.2 F puts the catch-up on the existing `dm_conversations` stream. That stream's
state carries `generation`, `offset`, `observedCount`, `providerTotalMode` and
`lastFullSweepCompletedAt`, and its finalization is gated on `page.done`
(`data.length < limit`). A partial walk that shares this state will clobber the
sweep's cursor, and if it ever hits a short page it reaches the finalization
branch with a two-page `observedCount` that its own generation set matches
exactly — `membershipCertified` is true, `providerTotalMode` is `present`, and
`markPageDmConversationsInvisibleByGeneration` hides every thread the bounded
walk did not touch. On `lilly-2` that is ~14 000 conversations disappearing from
every chatter's list. *Fix:* give `bounded_catchup` its own checkpoint key and a
hard assertion that it can never reach the finalization branch.

### P2-6. Two exactly-once mechanisms with incompatible expiry, and one dedicated pool connection per page

§5.2 A stacks a session-scoped `pg_try_advisory_lock(ns, pageId)` on a
120 s lease. The lock precedent (`services/ofapi-events.ts:407-446`) holds a
**checked-out pool client** for the lock's whole lifetime. Consequences:

- **Wedge.** A crashed worker's backend keeps the advisory lock until Postgres
  notices the dead TCP connection (`tcp_keepalives_idle` territory — minutes to
  tens of minutes), while the lease expires in 120 s. The replacement worker
  takes the lease, fails `pg_try_advisory_lock`, and the page has **no socket**
  for far longer than the doc's "лиза протухает за 120 с, новый worker
  переоткрывает". If the design instead gates only on the lease, two sockets
  coexist — and then P1-3 loses frames.
- **Pool pressure.** `packages/db/src/client.ts:73` is `new Pool({
  connectionString })` — no `max`, so node-postgres' default of 10. Six Fansly
  pages hold 6 of those 10 permanently, plus the OFAPI event-worker lock. That is
  a worker with 3 connections left for all its actual work.

*Fix:* pick one mechanism (the lease, which has an owner and a TTL you control),
verify it with a fencing token on every write, and drop the per-page advisory
lock; or size and configure the pool explicitly and prove the lock's release path
under `kill -9`.

### P2-7. Fail-closed egress for the WebSocket is not enforceable by the proposed ratchet

undici's `WebSocketInit` converter defaults `dispatcher` to
**`getGlobalDispatcher()`** — so `new WebSocket(url, { dispatcher: undefined })`
opens a **direct connection from the VPS IP** to `wss://wsv3.fansly.com`, which
CLAUDE.md calls a model-ban risk and #124 exists to prevent. The doc's §5.2 H
ratchet ("`new WebSocket(` with budget 0 outside `services/egress/`") cannot
catch this: `check-raw-fetch.mjs` is a grep that whitelists **all** of
`apps/runtime/src/services/egress/` and only looks for `fetch(`. Putting the WS
transport in `services/egress/` places it inside the blind spot by construction.

Good news from the same check: the transport *is* viable — undici rewrites
`wss:` to `https:` before dispatch, so `resolveSocksDestination` /
`defaultPortForProtocol` (which throws on anything but `http:`/`https:`) are
satisfied, and the SOCKS `connect` hook runs on the upgrade.

**Evidence.** `node_modules/.pnpm/undici@7.27.2/node_modules/undici/lib/web/websocket/websocket.js:715-719`
(`defaultValue: () => getGlobalDispatcher()`); `.../websocket/connection.js:31`
(`requestURL.protocol = 'https:'`), `:95` (`dispatcher: options.dispatcher`);
`packages/shared/src/http-client.ts:60-113`, `:118-127`;
`scripts/check-raw-fetch.mjs:17-36`.

*Fix:* the ratchet must be a **test**, not a grep — assert that the WS factory
throws `ProxyMissingError` when the page has no proxy, and that the object passed
to `new WebSocket` has an own `dispatcher` property that is not `undefined`.
Add the exit-IP assertion the REST path already has.

### P2-8. Journal-row volume is unestimated, and the one property that makes today's capture cheap does not carry over

§6 and §2.1 count **requests**. They never count **journal rows**, and the
architecture adds a row per frame to a 100-year-retention partitioned table.
Today's DM sweep is 15 680 requests/day but **86.6 % of its bodies are
byte-identical** and collapse to a single CAS object (evidence C §7.2) —
`observations_2026_09` is 140 MB against `_2026_08`'s 7 021 MB precisely because
pointer-only capture is live. WS frames each carry a distinct message/notification
id, so CAS dedup is ~0 %: every frame is one observation row plus one catalog
object. The design also does **not** exclude read/delivered receipts (5/2), which
per evidence A §4.2 come back for every recipient of every message; a mass DM to
14 000 fans on `lilly-2` produces a receipt storm plus the notification frames for
every purchase it triggers. §7.1's mitigation ("журнал пишет пачками") reduces
round trips, not rows.

*Fix:* make "frames/day/page by service and type" a stage-0 deliverable (it is
already C6) **with a row-count and storage projection**, and set the shadow gate
on rows/day, not only on coverage. Given the standing disk/backup risk on that
box, an unbounded new row source needs a number before it is switched on.

### P2-9. `ws_unknown` defeats the observation-kind ratchet it claims to satisfy

`WRITTEN_OBSERVATION_KINDS` + `tests/observation-kind-coverage.test.ts` exist so
that a *new* kind cannot be journalled without a family claiming it or a written
RAW_ONLY reason. A single catch-all `ws_unknown` registers once and then absorbs
every future Fansly service/type pair forever — including a new money event —
without ever tripping the ratchet. The doc's compensating control is a "доля
unknown" gauge, which measures volume, not novelty: one new low-frequency money
event stays under any threshold.

*Fix:* journal every frame under `ws_<serviceId>_<typeId>` (numeric, mechanical),
so a new pair is a new kind and the ratchet fires on the PR that first sees it.
Keep `ws_unknown` only for frames whose envelope cannot be parsed at all.
`representation='exact_bytes'` itself is fine — it is one of the two allowed
values (`packages/db/src/schema.ts:4541-4543`).

### P2-10. A WS-created stub thread with `fan_id IS NULL` is invisible to the enrichment path, and the dirty set that would fix it is in-memory only

§5.2 D.4 creates a stub with "partner unknown". The candidate selector requires
`c.fan_id is not null` (`page-dm.ts:1098`), and the executor's loop treats
`conversation.fanId === null` as "no candidate" and moves on
(`executor-handlers.ts:3823`). So the stub is never walked; its only escape is
the `group:<id>` followup. But §5.2 E keeps the dirty set "в памяти супервизора
страницы" — a worker restart, a lease loss, or a `fanslyWsFollowupCallsPerHour`
overflow drops it, and §5.2 E's own promise ("subject остаётся грязным") is false
across a restart. The fallback is the reconcile: **up to 6 hours** during which a
new fan's first message exists in `page_dm_messages` but the thread has no
partner, no fan, no workboard row and no transcript.

*Fix:* persist the dirty set (a table, or reuse `page_sync_states.request_payload`),
or make a WS-created stub set `message_coverage_status='pending_backfill'` **and**
give the selector a path that accepts a null `fan_id` for the group-detail
followup specifically.

### P2-11. The headline reduction is not what stages 1–3 deliver

The one-line recommendation and §0 point 3 present "≈29 400 → ≈5 000–7 000
(−75…-80 %)" as the outcome of the proposal. §6 says the socket work (stages
1–3) lands at **≈15 000 (−49 %)**, and the rest comes from stage 4 — the
`fan_earnings` and `followers_reconcile` packages, worth 9 193 calls/day, which
need transaction and follow signals and **not** the DM socket. The arithmetic
itself checks out against evidence C (I verified §2.1's seven rows sum to 29 422
against C's 29 422, and §6's target components sum to ~15 600), but the framing
credits the socket with a saving a cheaper change delivers.

*Fix:* state the split in §0: socket = −49 % and 30 min → seconds; stage 4 = a
further −29 pp and is independent of the socket.

---

## P3 — notes

- **P3-1. `capabilities.events` does not exist.** §5.3 writes
  `fanslyPlatformAdapter.capabilities.events = "fansly_ws"`, but
  `PlatformCapabilities` has only `webhooks: boolean` and
  `presenceSource: "webhook" | "poll" | "none"`
  (`packages/platform-core/src/index.ts:46-49`;
  `apps/runtime/src/platforms/registry.ts:157-161`). Adding a field is a
  shared-type change plus a registry-suite pin — small, but not the config-only
  edit the table implies.
- **P3-2. New `statusReason` codes are a contract change.** §5.3 says
  "Контракты/SDK: только чтение… auth-декларации не затрагиваются", which is
  true of routes; but `messagesLive.source: ws_live|ws_silent|ws_waiting` is new
  vocabulary on a served response and needs `pnpm contracts:generate` plus a
  re-vendor for any client that switches on the code.
- **P3-3. Read-acks are load-bearing but unregistered.** §5.2 D.2 resets
  `unread_count` from the 5/2 read-ack, yet §5.2 B's kind list has no ack kind —
  so acks land in `ws_unknown`, which §5.2 C says the family does not touch. One
  of the two sections is wrong.
- **P3-4. `unread_count` self-corrects, but it can also correct backwards.** The
  sweep overwrites it with the provider snapshot
  (`executor-handlers.ts:3302`), so the inline `+1` cannot drift indefinitely —
  but with reconcile at 360 min the correction window is six hours, and a
  snapshot taken before a WS message resets a genuine unread to 0 (this is the
  same write as P1-1 and is fixed by the same guard).
- **P3-5. Presence may never arrive.** §3.2 records that OnlineStatusService
  (8/1) is sent "only for accounts the client has already cached". A headless
  consumer caches nothing, so `fanslyWsJournalPresence` may capture zero frames.
  §7.3 #11 still lists it as the online-badge source. Settle in stage 0 (P4).
- **P3-6. "≤60 с" enrichment is optimistic.** The selector returns **one**
  candidate per call (`page-dm.ts:1132` `limit 1`), the chunk is capped at ~5
  requests, and the DM streams share a ~5 s pacer with the sweep. A burst of 50
  active threads takes minutes, not seconds, and competes with the reconcile.
- **P3-7. Candidate-queue starvation.** The selector orders
  `staleHeadMismatch` (0) ahead of `pending_backfill` (1)
  (`page-dm.ts:1114-1123`). Under a live socket, every active thread is
  permanently in class 0, so threads that have never been backfilled are served
  only by the deep-backfill quota. Worth measuring in shadow.
- **P3-8. Confirmed-correct claims** (checked, no finding): the `observations`
  source CHECK has exactly 7 values (`schema.ts:3390-3392`);
  `HEALTH_FLOOR_REGISTRY` is derived from `CANONICALIZER_FAMILIES`, so a new
  family does get its floor for free (`health-floors.ts:75-85`);
  `unchangedPageStreak` is computed and never read; `requestPageSync` preserves
  `paused`/`blocked` (`page-sync.ts:3063-3070`), so the dirty set cannot
  resurrect a parked page; cadence really is a code constant force-synced into
  `page_sync_states` (`page-sync.ts:1590-1611`); a 401 really does park all
  streams (`executor.ts:805-816`); §2.1 and §6 arithmetic reconciles with
  evidence C.

---

## Verdict

**The chosen option (Hub-side WS consumer) is defensible; the design as written
is not yet buildable, and its stated justification is the wrong one.**

Three things must change before any code:

1. **Second-writer discipline.** The document treats `page_dm_threads` as if the
   sweep and the socket can both write it. The codebase explicitly assumed the
   opposite and wrote that assumption into a comment
   (`page-dm.ts:136-141`). Head-forward-only semantics for the sweep, the
   generation-stamp removal (P1-2), the window-refresh split (P1-5) and a
   per-connection journal key (P1-3) are a single coherent work package, and none
   of them is optional. As specified today, the design loses journal frames,
   regresses live heads, and permanently disables the sweep's own absence proof.

2. **The dedup model.** Everything in §5.2 C is built on "content-hash dedup",
   which the kernel does not do. The real rule — first writer wins on an explicit
   key, in both `domain_events` and `message_archive` — means the *thin* WS event
   becomes permanently authoritative over the richer REST body, with no detector
   for divergence. The contract has to be restated as key/direction/timestamp/field
   parity plus a shadow-stage comparator.

3. **The justification.** §6's own arithmetic says the socket buys −49 %, and the
   remaining −29 pp comes from work that needs no socket. Meanwhile §5.2 F
   describes a bounded newest-first walk that would buy most of that −49 % with
   zero new exposure to Fansly. The honest case for the socket is **latency**:
   30 minutes → seconds, and the `lilly-2` duty-cycle ceiling (42 % today,
   saturating near 34 000 conversations, evidence C §4). Say that, and the
   M1/M3/T1/S1 risk budget becomes a decision the owner can actually weigh.

Two smaller gates: the health override must be fed by settled events, not by a
socket heartbeat (P2-1a), or the M3 worst case is invisible behind a green
`/health/sync`; and the fail-closed egress claim needs a test, because the
proposed ratchet cannot enforce it and undici's default is a direct connection
from the VPS IP (P2-7).

Stage 0 as written is right and should also settle three cheap items the document
does not list: the meaning of `sortOrder=1`, whether the follow-relation snowflake
epoch decodes message ids, and the frames-per-day **row** count.
