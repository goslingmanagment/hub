# Fansly Sync Engine

One long-running process (`sync`) hosts one **actor per Fansly page**. The actor is the page's only sender: every
physical request of the page passes one pacer, one queue (`sync_work`), one journal row per attempt
(`sync_attempts`). Plan: `docs/plans/2026-10-01-sync-engine/plan.md`. OnlyFans is not here.

The engine lands in steps: step 2 runs it in **shadow** next to the legacy engine (it plans, paces and journals, but
never sends); step 3 switches pages one by one; step 4 deletes the legacy code. Until the switch PR no build can send
as the engine (`LIVE_LOOP_ENABLED = false`, `sync page mode` moves only `off ↔ shadow`, I17).

## Map

```
sync/
  main.ts, context.ts        the `sync` runtime role: context, heartbeat, host, signals
  cli.ts, inspect.ts         the owner's CLI (`pnpm cli sync page …`, `sync why`, `sync work …`, `sync ownership …`) and its reads
  engine/
    ports.ts                 Clock, Rng, PauseSource, Wake, OwnershipSession, AlertSink, Metrics, Transport
    pacer.ts                 the ONLY admission authority: the pause rule, one request in flight, takeover floor
    scheduler.ts             the 10-slot cycle U R U R U R U R U P over the three classes
    errors.ts                outcome → error class → page hold / network pause / breakers / quarantine
    status.ts                "why waiting" and the page status
    resource.ts              the resource contract (plan / apply / shadow) and the rules every entry shares
    host.ts                  pages ↔ actors, ownership, LISTEN, mode changes, SIGTERM; LIVE_LOOP_ENABLED
    host-ports.ts            the lock session (advisory locks 58215) and the LISTEN wake
    actor.ts                 one page: recover → loop (plan → admit → send → capture → apply)
    commit.ts                the four transactions of a step, the no-HTTP outcomes and the local writes
    shadow.ts                the shadow transport (no socket, no credentials)
    alerts.ts                alerts 1–4: the incident sink, the 30 s evaluator, the pace backstop, the owner's ack
    metrics.ts               the golden signals (per page; the ops sampler's compact set every 5 min)
  fansly/
    registry.ts              ALL Fansly resources: trigger, period, class, coalescing, SLO, proof
    transport.ts             the live page transport over the wire layer (packages/fansly/src/wire)
    resources/               one file per resource family
    ws/                      decode, router, the post-ack routing hook (live), the shadow WS feed and a live
                             page's socket (`source.ts`)
    lib/                     chain rules, walk helpers
  requests/                  history requests, ETA, enqueue-and-wait
  report/                    `sync shadow report`: part A (the live window), part B (the past journal)
```

Files appear PR by PR during step 2; a file in this map that is not in the tree is not merged yet. The registry
lists every resource from the start: an entry whose code has not landed has no `module`, so its work waits on
`dependency` and counts `sync_not_implemented`.

A resource never sends a second request inside its apply. When an apply learns it needs more (the profiles of new
subscribers, a fresh `/account/me` counter, a follower reconcile), it returns that as demand: a follow-up work row,
or a plan that waits on `dependency` and makes the other work due. Fan profiles are one batch walk per page
(`fan-profiles.lookup`): the asking apply merges the fan ids into the walk row's `params.ids`, and each step reads up
to 100 of them not looked up through the page within the day.

A DM thread has three writers, each with its own columns: the conversation list (`dm-conversations.*`, through
`upsertPageDmConversationListFields`: partner and fan, flags, unread count, the `last_message_*` head, visibility, the
membership generation and the list's two metadata keys — never an unbinding), the chain (`writeThreadChain`) and, on
pages the engine owns, the legacy coverage columns (`syncLegacyThreadSummary` after a read,
`syncLegacyThreadSummaryAfterDeletion` after a socket deletion). A list head newer than what the message
reads reached becomes one `dm-messages.catchup` (planned; `dm-messages.head` when the list is the live signal).

A message read (`dm-messages.head`, `.catchup`, `.history`) is one `/message` page per step. Its apply folds the page
into the chain before it writes anything (an anomaly the design sends to review quarantines the step whole), then
writes the page's rows minus any an executed erasure fences, the chain, the legacy coverage columns (engine-owned
pages only), the overlay confirmation, and — last — the inline canonicalization and the `message_archive` rows of
the page's message events. When the chat was deleted, unbound or excluded between the plan and the apply, only that
last part runs, under the same fence, so the minutely sweep never appends the page unfenced. A `.head` walk reads down (`before`) while its staged head page has not met the confirmed
head; a demanded id the vendor's head does not show yet is read again after 15 s and 60 s, then settled `not_found`.

A plan is read-only, so a decision it takes that the apply must fold into — a media visit's windows, an album walk's
proof header, the floors a history walk crossed without a request — travels with the request (`RequestPlan.step`,
stored as `sync_attempts.request.step`) and comes back to the apply, the shadow estimate and a re-apply from the
journal. A media visit is a pure procedure replayed over the answers it has (`fansly/resources/media-stats.ts`), so
one visit of the legacy lane becomes one window per step with the same windows in the same order. A visit in flight
across a deploy that changed a visit rule no longer replays: it is abandoned (the next due item starts afresh, the
item it served backs off on its queue-row ladder), never a failed plan or a quarantined walk.

One step of a page is four short transactions: **admit** (the attempt is journaled and counted before the send) →
**HTTP** (no transaction open) → **capture** (the raw answer is committed to `observations` before anything parses
it) → **apply** (erasure fence, parse through the wire contract, domain writes, events, cursor and proof, `applied`).
A crash between capture and apply re-applies from the journal without a request; a crash before capture leaves the
attempt `unknown` and the read is repeated as a new, counted attempt.

## History requests

An agent or the owner asks for the history of up to 1 000 fans' chats on one page, to a depth (`all`: proven to the
first message by an empty page, owner decision №3; `latest N`; the legacy wrapper's boundary). The intake
(`requests/history.ts`, database only) resolves every fan to a visible chat or refuses it (`not_found`, `excluded`,
`page_erased`, `duplicate`) without failing the request; a fan already satisfied is `ready` without a read. The fans of
one chat ride on the chat's ONE `dm-messages.history` work row (class `requests`), so a read serves every request on
the chat and is counted once, on the fan whose turn it was. The requests class serves round robin between a page's
open requests, then between a request's fans. The first read of a fan without an anchor is the chat's head (its
"latest N" counts from there; messages that arrive later come live); then `before = contiguous_oldest_id` down. Every
history read runs the request hook (`onHistoryThreadChainChanged`): anchors, satisfied fans `ready`, the request
`done`, the chat's work closed when no fan rides on it. A history work that closes for a reason of its own (the chat
was deleted or excluded since) ends its fans through `onHistoryWorkClosed`. No history read happens without an open
fan (I12): the plan closes such a work, and the actor's idle wait does not count it. Requests are accepted only on a
`live` page whose `requests_enabled_at` has passed — every other page answers 409
`history_requests_unavailable_on_page`, so in step 2 the class is empty. Intake, cancel, the admission and the apply
take `sync_work` rows before `history_requests` before `history_request_items`; intake takes the chats its fans
reference (`page_dm_threads`) before any work row, as the DM apply holds the chat it writes before its works, and the
hook takes the chat's history work itself before any request (a `.head` or `.catchup` read does not hold it)
(`tests/sync-history-lock-order.integration.test.ts`). A fan erasure settles the requests whose fans it removed. The ETA (`requests/eta.ts`) reads thread columns only and
always gives a lower bound and an estimate; `pnpm cli sync history eta-backtest` measures it on the journal.

Three clients share these service functions and nothing else: the agent plane (`agentHistoryRequestCreate|Get|Cancel|
List` under `/api/v1/agent/`, `modules/agent-read/handlers-history.ts`, the `hub history-*` commands), the owner routes
(`/api/v1/sync/history-requests…`, `modules/sync-engine/index.ts`, contracts in `routes-sync.ts`) and the owner CLI
(`pnpm cli sync history …`). The wire shape is one (`requests/wire.ts`) for agents and the owner. An agent key sees and
may cancel every requester's requests on its granted pages (design D10); filing and cancelling need
`request:hydration`, everything that returns chat refs `read:messages` too (D9). A refused page answers the 409 above;
the agent docs keep the hydration route as the remedy there.

## Status, "why waiting", sync now, enqueue and wait

The page status (`engine/status.ts`: owner, pause record, sends by class, the queue by waiting reason, holds,
breakers, request progress) and "why waiting" (one reason from a closed list per work row, plus its revisions,
breaker and last attempt) are read by `inspect.ts` from the journal the page runs — the shadow journal while the page
is `off` or `shadow`. Three clients share those functions and one wire (`requests/wire.ts`): the owner CLI
(`pnpm cli sync page status`, `sync why`), the owner routes (`syncPages`, `syncPageWork`, `syncPageWorkGet`) and the
agent plane (`agentSyncStatus`, `agentSyncWhy`, `hub sync-status`, `hub sync-why`; `read:datasets`, and
`read:messages` too for a key whose subjects are chats or fans).

"Sync now" (`syncPageRefresh`, `refreshSyncPage`) makes the page's poll rows due now and wakes its actor; it sends
nothing itself, and an `off` page (no actor) answers 409 `sync_page_off`.

### Engine-owned pages on the legacy surfaces (step 3, S3-02)

A page in `handover`/`live` has frozen legacy streams, so the surfaces that speak in legacy streams speak for the
engine instead; `fansly/legacy-streams.ts` maps a legacy stream to the registry keys that took it over (generated
from the registry's `legacy` refs; `@agency_hub_core/db`'s `FANSLY_ENGINE_LEGACY_STREAMS` is its SQL copy, pinned
equal by `tests/sync-legacy-streams.test.ts`). `off`/`shadow` pages are untouched.

| Surface | On an engine page |
|---|---|
| `/api/v1/health/sync` | legacy checks skipped; an `engine` block (mode, owner heartbeat age, hold, oldest due urgent work, socket, quarantine, open alerts); unhealthy on an owner silent > 90 s, an `auth`/`identity_mismatch` hold, or `handover` > 10 min |
| Settings blocks (`syncOverview`, `pageSyncBlocks`) | every block `state: "engine"` + `engineMode`; each legacy stream from its keys' live work (last applied, next due, why the earliest waits, quarantine / vendor block); a refused credential reads `credentials_invalid` on the connection block |
| Block buttons, `/admin/sync/trigger(-all)` | trigger ⇒ the keys' polls due now (`refreshSyncPage`); pause / resume ⇒ the keys in / out of `paused_resources` (the rest kept); reset ⇒ the keys' quarantined work requeued — `page_sync_states` never touched; `handover` ⇒ 409 `fansly_page_switching` for a lever that would read |
| Follower reconcile reset / blast-radius override | the quarantined `followers.reconcile` row: reset cancels it and files owner demand (a fresh walk); the override reads the walk from the row's cursor and `result.quarantine`, deactivates as on a legacy page and closes the row done |
| Dataset `sync_streams` | rows from the live work per legacy stream: `failed` (quarantined / vendor-blocked) > `paused` > `running` > `ok`; success = the newest applied read (a page-level key's at any age, a thread / target / fan key's within 24 h); failure = a standing one (an active row whose last outcome failed); every lookup bounded per key, never by the journal's length |

A quarantine records why in `sync_work.result.quarantine` (`{reason, detail, attemptId, at}`: an `ApplyQuarantine`
detail or a contract violation's field). `pnpm cli sync work list --page P [--state quarantined] [--resource R]`
shows it; `pnpm cli sync work requeue --page P --work <id> | --quarantined [--resource R]` takes rows out of
quarantine — a live row whose last attempt holds a captured answer goes back to `running` with that attempt
`deferred`, so the actor re-applies it from the journal before any new read (no request); other rows, and a row
whose captured body can no longer be read (`apply_error` `payload_unavailable:…`), open due now (audited
`admin.sync_work_requeue`). It touches only the journal the page runs (live on `handover`/`live`, shadow otherwise),
and `--work` ids are all-or-nothing. `pnpm cli sync work enqueue --page P --resource <key> [--subject S]
[--params <json>]` files the owner's own demand for a key with the `owner` trigger on a live page; `--subject` only
for a key that runs per subject (audited `admin.sync_work_enqueue`).

`requests/urgent.ts` is how the API and the CLIs ask the actor for a read instead of calling Fansly: `enqueueAndWait`
upserts the work of a registry key with the `api` trigger and waits up to 15–30 s for `applied_revision` to reach the
revision it raised (woken by `fansly_sync_work_done`, which `settleWork` sends for live rows, and re-reading every
250 ms), then answers `done`, or `queued` with the work's status link. A page that is not `live` answers `not_live`
before anything is written, so in step 2 every call does; its step-3 callers (`page verify`, credentials and proxy
changes, AI describe) fall back to the legacy path on it. A work carrying secret parameters (a candidate identity) is
created fresh or refused, never merged into another candidate's open row.

## WebSocket demand

The socket is the live signal of a page (plan §7). The legacy receiver (worker) owns the socket until a page is
switched; it captures each frame (observation + pending receipt) and the step-1 drivers apply the overlay and ack the
receipt. The engine turns receipts into work in two ways, with one decoder (`fansly/ws/decode.ts`: the step-1 message
decoder plus new chats, money, subscriptions and payouts) and one routing table (`fansly/ws/router.ts`):

- **Live pages (`handover`/`live`, step 3)**: every driver passes the post-ack hook `routeFanslyWsReceiptDemand`
  (`fansly/ws/route-receipt.ts`), which upserts the receipt's demand in the transaction that acks it — once per
  receipt, whichever driver wins it (I18). On `off`/`shadow` pages the hook only reads the page's mode.
- **Shadow pages**: the actor reads the receipts past `sync_pages.ws_router_cursor` once per lap and routes them into
  shadow work; it never acks a receipt and never writes the overlay. A router that never ran starts 15 minutes back;
  receipts older than that are passed over (history, not live demand). The receipts have no `page_id` index, so a
  lap that finds nothing of the page moves its cursor up to that 15-minute watermark (at most once a minute): a
  silent page's read covers the horizon, not everything captured since its last receipt.

Own mass broadcasts make no work (decision №9): they are `message.type = 2` with one shared correlation id (measured
on the production journal), and as a fallback more than 20 own messages in distinct chats within 60 s are a
broadcast. A deletion becomes `dm-live.deletions` (no request): in shadow it closes at once; on a live page it is a
`local` step (a write without a request, in one generation-fenced transaction under the erasure fence, picked at a
slot like any work but admitting nothing): the page's hot rows of the message are marked (sticky), one deliverable
`message.deleted` is appended and the archive tombstoned from it (tombstone-first, sticky against a later REST copy),
and the stored window of every touched thread is recomputed by `syncLegacyThreadSummaryAfterDeletion` — the head stays
the conversation list's, the chain is untouched.

**A live page's socket** lives in the `sync` process (`fansly/ws/source.ts`, one per live slot of the host; a shadow
page has none — the legacy receiver owns it). The source holds the page's socket lock `(58213, page)` on its own
session for as long as it runs, the lock the legacy receiver takes, so the two never both own a page's socket. It never
connects by itself: it raises `ws.connect` demand (at start, after each end on the step-1 reconnect ladder, after a
credentials change), and the actor admits that step like any request; the transport runs `handshake()` inside it, whose
Upgrade rides an engine lease over the pacer's one-shot check (the last check before the headers; one admission, one
Upgrade). Frames are captured on the owning session, applied and acked by the connection's applier with the post-ack
hook (what it leaves, the worker timer acks — and routes). A verified connection raises `repair.ws-gap`; a socket down
for two minutes raises `dm-conversations.ws-down` once; the auth frame's refusal blocks the credentials generation
(as in step 1), raises `account.verify` and alert 2, with no reconnect until the credentials change. Demand the
database refused is written again: `ws.connect` (same due time) every 10 s while the source holds the lock and has no
connection, `account.verify` while the generation stays refused, `repair.ws-gap` on the next guard, `.ws-down` on the
next down check. The source stops
before the page's safe release: a graceful stop (shutdown, mode change) captures what the socket already delivered
(≤ 20 s) and applies it (≤ 10 s), then closes the connection row at the instant intake stopped — the next connection's
`gap_since` — and the lock session; a lost ownership does not drain.

## Ownership

A page has one owner generation at a time (`sync_pages.owner_generation`, fenced in every write) and its owner holds
the session advisory lock `(58215, pageId)` on the host's one lock session. A new owner starts only when the previous
one is **confirmed stopped**: never owned; its own safe release (`owner_released_at` of its generation — written after
SIGTERM, a mode change or the loss of its lock session, once nothing is in flight); the step-1 OS proof
(`judgeFanslySendHolderTermination`: pid gone, pid reused, boot changed, or this container under a new pid namespace);
or a Docker-level confirmation (`pnpm cli sync ownership confirm-stopped --running-hosts …`, run by the deploy). A lost
lock session alone is never a confirmation. The first send after a takeover waits `1.2 × S` after every send the
database knows of (I5). Until the switch PR no build runs a live loop (`LIVE_LOOP_ENABLED = false`): a page written
`live` is reported and never acquired; `sync page mode` moves pages only between `off` and `shadow`.

## Legacy fences (step 3)

While the engine owns a page (`handover` or `live`) no legacy component even tries to send for it (step-3 design
§3.1); the step-1 guard row (`owner_engine`, 0229) stays the catch-all at the wire. One predicate,
`legacyOwnsFanslyPageSql` (`repositories/sync/pages.ts`), gates the legacy planner and leases
(`listRunnablePageSync`, `markPageSyncEnqueued`, `acquirePageSyncLease`, `acquireTargetedPageSyncLease`), the
`sync_silent` deadman, the AI fast lane (`page_held`), hydration dispatch and auto-approval, and the deletion
reconcile's window drift pass. The legacy processes ask `isFanslyPageEngineOwned` / `listEngineOwnedFanslyPages`: the WS
supervisor drops the page within one poll (graceful `disabled`, lock 58213 released), the ws-hints projector files
its receipts under no policy (hints `disabled`, no `fansly_ws_dm` write, no DM stream wake; a deletion keeps its
`mutation_debt` receipt, so a frame captured before the switch is still marked), the AI describer neither downloads nor
wakes the DM stream, and the deletion reconcile writes the marks but no thread window. The owner's `/account/me` routes and CLIs, the probes, the alias backfill and the
`scripts/fansly-ws` probes answer 409 `fansly_page_on_sync_engine` (`services/sync-engine-guard.ts`) with the engine
command to use instead. Hydration rows the engine serves (`execution_lane = 'fansly_sync_engine'`) are never expired,
reconciled or swept by the legacy cycle. `shadow` fences nothing, and every check is per query, so leaving to `off`
restores the legacy engine with no other action.

## Invariants

Each is enforced in exactly one place and pinned by a test (design §1). The first is the owner's rule.

| # | Invariant | Enforced in |
|---|---|---|
| I1 | Between the actual sends of any two requests of one page: gap ≥ `S × (1 + u)`, `S` = the owner's setting read at the admission of the later request, `u ∈ [0, 0.2)`. A strict minimum, never an average. "Actual send" = undici `onRequestStart`, on the monotonic clock; without that mark, the completion instant. | `engine/pacer.ts` (`waitForSlot`, the synchronous `check`) |
| I2 | At most one request of a page in flight; the next admission only after the previous completion. | `engine/actor.ts` (sequential loop) + `engine/pacer.ts` (`inFlight`) |
| I3 | One physical request per admission; no transport retry; no redirect follow (a 3xx is an answer). | `packages/fansly/src/wire/send.ts` |
| I4 | `S` is re-read before every admission; `S < 2000 ms` is impossible (the test-only `minSettingMs` is never passed by the host). | `engine/ports.ts` `PauseSource` + `engine/pacer.ts` |
| I5 | First send after a takeover ≥ `1.2 × S` after the latest of: the takeover, the last send recorded in the database, unfinished attempts of the last 10 min + the send window, the legacy guard's last completion. | `engine/host.ts` + `pacer.initTakeover` |
| I6 | No automatic takeover from a live old process: an unconfirmed stop leaves the page `ownership_unconfirmed`; a lost lock session is never a confirmation, the owner's own safe release is. | `engine/host.ts` |
| I7 | Every write of an actor is fenced by `owner_generation`. | `repositories/sync/pages.ts` `lockOwnedPage` |
| I8 | The raw answer is committed before it is parsed; apply is replayable from the observation without HTTP. | `engine/commit.ts` |
| I9 | The chain columns of a thread have one writer (`writeThreadChain`); the legacy coverage columns are written by the engine only on pages in `handover`/`live` (`syncLegacyThreadSummary`, `syncLegacyThreadSummaryAfterDeletion`). | `repositories/sync/thread-chain.ts` |
| I10 | `history_complete` only by an accepted empty page at `before = contiguous_oldest_id`; a short page is not the end; overlap is not proof. | `fansly/lib/chain.ts` |
| I11 | A new event during a read raises `demand_revision`; an older answer never closes newer demand. | `engine/commit.ts` |
| I12 | No history walk without a request. | `fansly/registry.ts` (`dm-messages.history` triggers only on a request) |
| I13 | The Fansly HTTP client exists only inside `sync/` (plus the sanctioned legacy list until step 4). | lint rule + boundary test |
| I14 | Shadow never sends and never writes observations, domain tables, receipts or the overlay; it never owns a socket. | `engine/actor.ts` + `engine/commit.ts` |
| I15 | The erasure fence is taken in every apply that writes fan material. | `engine/commit.ts` |
| I16 | The command outbox semantics are untouched (Fansly has no sends). | — |
| I17 | No live sender before the step-3 switch: `LIVE_LOOP_ENABLED`, mode `live`, and the legacy guard row handed to the engine — three independent gates. | `engine/host.ts` + `lockOwnedPage` + CLI |
| I18 | Every WS receipt of a `handover`/`live` page routes its demand exactly once, in the transaction that acks it. | `fansly/ws/route-receipt.ts` |

What the pacer guarantees, concretely: the slot opens at `max(last send + ceil(S × (1 + u)), last completion,
takeover floor)`; `u` is drawn once per send and kept across re-waits; a waiting pacer re-reads `S` at least every
second, so raising `S` lengthens a wait in progress. The send check refuses — and nothing is written — a second
dispatch of one admission (`lease_used`), a dispatch after ownership was lost or the process began stopping
(`lease_inactive`), after the 15 s send window measured from before the admission commit (`send_deadline_passed`),
before the takeover floor (`takeover_floor`), or closer than the pause (`pace`, a belt that fires only on a bug).
Any doubt — an unreadable setting, a pacer without a takeover floor — throws, and nothing is admitted.

## Classes

| Class | What | Order inside |
|---|---|---|
| urgent | everything a live event caused: chat confirmation, money head, a new chat, repair after a socket gap, the list head while the socket is down, the socket connect, identity checks, "refresh now" | deadline, then age |
| requests | history requests of agents and the owner | round robin between requests, then between their fans |
| planned | registry polls and long walks | due polls by due time first, then round robin by resource key |

The cycle `U R U R U R U R U P` gives 50 / 40 / 10 % under full contention, 80 / 20 % without urgent work, everything
to a single class; an empty or blocked class is skipped without waiting and earns no credit. The urgent class waits at
most two slots. The pointer (`sync_pages.cycle_pos`) survives restarts.

## Why waiting

Every open `sync_work` row has one reason from this closed list (`engine/status.ts`), first match wins:

| Reason | Meaning | Lifted by |
|---|---|---|
| `running` | admitted; its request or apply is in progress | the step's completion |
| `ownership_unconfirmed` | no actor runs the page: no fresh owner heartbeat, mode `off`/`handover`, or the previous owner's stop is not confirmed | the host acquiring the page (safe release, OS proof, container restart, `sync ownership confirm-stopped`) |
| `paused` | the owner paused the page, its requests, or this resource | the owner |
| `page_hold` | 429 (until `Retry-After`, else 2 → 4 → 8 → 30 min), 401/403 or identity mismatch (until new credentials), network (after 3 failures: 10 s → 5 min) | the hold's end; new credentials |
| `quarantined` | the answer broke its contract or the cursor stuck; the raw answer is kept | the owner re-applying it from the journal |
| `blocked_by_vendor` | the subject failed 5 times; probed once a day while demand exists | a successful probe |
| `subject_breaker` | the subject failed: 1 min → 10 min → 1 h → 6 h → 24 h | the breaker's end, then a success |
| `resource_hold` | ≥ 5 subjects of the resource failed within 10 min: 30 min → 2 h → 6 h (never `dm-messages.head`); or the conversation list answered 429: only the keys that can only read the list wait, 5 s → 10 s → … → 300 s | the hold's end |
| `dependency` | the resource waits for other work or data | that work |
| `not_due` | its time has not come (poll period, coalescing window) | the due time |
| `pacer` | runnable; the page's next slot has not opened yet | the pause |
| `class_share` | runnable; the slot belongs to another class or to earlier work of its class | its turn |

## Errors

`engine/errors.ts` classifies every outcome and decides every consequence in one place (`onOutcome`); the commit
transactions only write what it decided. The engine never changes `S`: a 429 holds the page and alerts the owner —
except a 429 on the conversation list, which holds only the list (owner decision 2026-10-02).
A retry after an error is always a new attempt through the same admission.

| Answer | Class | Consequence |
|---|---|---|
| 2xx, success envelope, contract accepts | `ok` | streak reset, subject breaker reset, expired holds cleared |
| 2xx, contract refuses (or the cursor stuck) | `contract` / `cursor_stuck` | quarantine the work and the attempt, alert 2 |
| 2xx without a success envelope | `envelope_unsuccessful` | as `subject_failure` |
| 429 on the conversation list (`messaging.groups`) | `rate_limit_list` | the list only (`resource_holds['dm-conversations']`): until `Retry-After`, else 5 s → 10 s → 20 s → 40 s → 80 s → 160 s → 300 s by consecutive list 429s, reset after 10 min without one; `.find` goes straight to `group.detail`; alert 1 only at the 300 s step |
| any other 429, or a 5xx naming its own `Retry-After` | `rate_limit` | page hold, alert 1 |
| 401 / 403 | `auth` | page hold until new credentials, alert 1 |
| any other non-2xx | `subject_failure` | subject breaker; ≥ 5 subjects of a file in 10 min ⇒ resource hold |
| a status the resource declares terminal | `subject_terminal` | the subject closes with a receipt, no breaker |
| transport error, timeout, 408 | `network` | streak; at 3 ⇒ page hold; alert 1 after 10 min |
| refused before sending | `not_sent` | nothing learned: the work is admitted again |

An apply that fails (`engine/commit.ts`, `classifyApplyError`) never stops the actor. A deferral (erasure fence busy,
journal body unreadable) and a transient database error retry without counting; an unexpected error is counted and
quarantined at the third try; a deterministic one (SQLSTATE class 22/23, contract) is quarantined at once, alert 2.
Two deterministic errors stop more than their work: an identity error (`PlatformAccountIdentity*Error`) goes through
`onOutcome` as `identity_mismatch` (page hold until new credentials, alerts 1 and 2), and a wrong transactions writer
holds the resource file (30 min → 2 h → 6 h).

## Alerts, metrics and the shadow report

Plan §10's five alerts are one incident kind, `fansly_sync_engine`, one latch per page and alert (`page_stopped`,
`live_degraded`, `freshness`, `stuck`) plus the global `process`. The actor opens alert 1 at once from its capture
transaction (a 429, a refused credential, another identity, a pace violation); `engine/alerts.ts` re-derives every
condition from the database every 30 s and is the only path that resolves one, so a latch never flips on a partial
view. Alerts 1–3 resolve after their condition has stayed false for 10 minutes since the latch last saw it (alert 4 as
soon as progress resumes), so a condition that comes and goes keeps one standing page. A pace violation has its own
latch that only the owner closes (`pnpm cli sync alerts ack --page <label>`); the evaluator also re-reads the
journal's new live sends, so a violation the capture path could not report still opens it. Only `handover`/`live` pages page the owner: a `shadow` page's conditions are counted (`sync_shadow_alerts`),
never paged (D14). Alert 5 — a page is in the engine and no `sync` process beats — is the api watchdog's, since a
process cannot report its own death. `pnpm cli sync alerts status` shows what holds per page.

The golden signals (`engine/metrics.ts`) come from the database: `computeSyncMetrics` per page (smallest send gap
vs the setting, violations, sends by class and resource, holds, breakers, quarantine) and the global families
(confirmation lag, REST mismatches by field, money lag from a socket frame to the ledger, history requests and the
ETA's fact over forecast). The ops sampler records a compact set every 5 minutes: aggregates per journal (`sync_*`
for switched pages, `sync_shadow_*` for shadow ones) — per-page series would double the sample table for figures the
page status already shows.

`pnpm cli sync shadow report --window <start>/<end>` is the shadow acceptance's evidence (design §3.12, read-only):
part A over the live hour in one repeatable-read transaction — the coverage (every page in shadow, its actor running,
from 10 min before the start: a window begun before the deploy or a page's switch to shadow is never accepted), demand against a computed expectation (poll periods
plus the reads the hour's socket frames imply after coalescing; walks listed apart), the legacy engine's volume of
the hour per stream and sender with the reason it differs, the live-path decisions (a fan message or a new ledger
row on the socket → the shadow admission vs the legacy arrival; an offline replay of the previous day's routing when
the hour is too quiet), the pacer's self-check; part B over the past journal — every resource's replay of its legacy
observations (≥ 99.9 %, every mismatch listed), the chain rebuild and end-of-history check since 05.07 (the 16.09
counterexamples listed, no empty-page soundness hit) and the ETA backtest. `--out <path>` keeps the report for the
step-3 switch.

## Recipes

| Change | Where |
|---|---|
| The pause | the owner's console ("Пауза между запросами Fansly"); 0 files |
| The jitter rule | one line in `engine/pacer.ts` + the invariant tests (`tests/sync-pacer*.test.ts`) |
| How fresh a resource is | one line in `fansly/registry.ts` |
| How fresh a resource is on one page, without a deploy | `pnpm cli sync page override --page <label> --resource <key>` with `--period-ms` (a poll), `--period-ms`/`--full-period-ms` (`catalog.vault`) or `--tiers '<json>'` (`media-stats.walk`); owner decision №6 keys need `--owner-approved` |
| Class order or shares | `engine/scheduler.ts` + `tests/sync-scheduler-cycle.test.ts` |
| The reaction to 429 / 5xx / network | `engine/errors.ts` + `tests/sync-engine-errors.test.ts` |
| A new Fansly endpoint in a known domain | the spec in `packages/fansly/src/wire/specs.ts`, the resource, a registry row, a test |
| A new kind of data | the same + schema, repository, migration |
| A new depth or rule of a history request | `requests/history-rules.ts` (satisfaction, anchors) + `requests/history.ts` + the contract |
| A new WebSocket event | `fansly/ws/decode.ts`, `fansly/ws/router.ts` + a test |
| "Why is chat X still partial?" | `hub sync-why`; the code is one resource file |
| One read of a route for a page, now | `pnpm cli sync probe --page <label> --operation <wire id> --params '<json>'` (shadow: simulated) |
| Quarantined work, after the fix | `pnpm cli sync work list --page <label> --state quarantined`; `pnpm cli sync work requeue --page <label> --quarantined [--resource <key>]` |
| A backfill / fresh walk on a live page | `pnpm cli sync work enqueue --page <label> --resource <key>` (keys with the `owner` trigger) |
| What alerts hold on a page; close a pace violation | `pnpm cli sync alerts status [--page <label>]`; `pnpm cli sync alerts ack --page <label> --note '…'` |
| An alert's threshold or condition | one constant or rule in `engine/alerts.ts` + `tests/sync-alerts.test.ts` |
| The shadow acceptance | `pnpm cli sync shadow report --window <start>/<end> --out <path>` (part B alone: `--part b`, outside 00:00–05:00 UTC) |
