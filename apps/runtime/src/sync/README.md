# Fansly Sync Engine

One long-running process (`sync`) hosts one **actor per Fansly page**. The actor is the page's only sender: every
physical request of the page passes one pacer, one queue (`sync_work`), one journal row per attempt
(`sync_attempts`). Plan: `docs/plans/2026-10-01-sync-engine/plan.md`. OnlyFans is not here.

The engine lands in steps: step 2 runs it in **shadow** next to the legacy engine (it plans, paces and journals, but
never sends); step 3 switches pages one by one (`pnpm cli sync switch`, below); step 4 deletes the legacy code. A page
sends as the engine only after the switch made it `live`, handed it the step-1 guard row and imported the legacy
state; `sync page mode` moves pages only `off ↔ shadow` (I17).

## Map

```
sync/
  main.ts, context.ts        the `sync` runtime role: context, heartbeat, host, signals
  cli.ts, inspect.ts         the owner's CLI (`pnpm cli sync page …`, `sync why`, `sync work …`, `sync ownership …`) and its reads
  engine/
    ports.ts                 Clock, Rng, PauseSource, Wake, OwnershipSession, AlertSink, Metrics, Transport
    pacer.ts                 the ONLY admission authority: the pause rule, one request in flight, takeover floor
    route-policy.ts          the route budgets on top of it: clocks from the journal, route state, pick exclusion, look-ahead
    scheduler.ts             the 10-slot cycle U R U R U R U R U P over the three classes (+ the short look-ahead)
    errors.ts                outcome → error class → page hold / network pause / breakers / quarantine
    status.ts                "why waiting" and the page status
    resource.ts              the resource contract (plan / apply / shadow) and the rules every entry shares
    host.ts                  pages ↔ actors, ownership, LISTEN, mode changes, SIGTERM; LIVE_LOOP_ENABLED
    host-ports.ts            the lock session (advisory locks 58215) and the LISTEN wake
    actor.ts                 one page: recover → loop (steps without a request; plan → admit → send → capture → apply)
    commit.ts                the four transactions of a step, the no-HTTP outcomes and the local writes
    shadow.ts                the shadow transport (no socket, no credentials)
    alerts.ts                alerts 1–4: the incident sink, the 30 s evaluator, the pace backstop, the owner's ack
    metrics.ts               the golden signals (per page; the ops sampler's compact set every 5 min)
  fansly/
    registry.ts              ALL Fansly resources: trigger, period, class, coalescing, SLO, proof
    routes.ts                every route a request can take, its family and budget; the legacy send log's map
    transport.ts             the live page transport over the wire layer (packages/fansly/src/wire)
    resources/               one file per resource family
    ws/                      decode, router, the post-ack routing hook (live), the shadow WS feed and a live
                             page's socket (`source.ts`)
    lib/                     chain rules, walk helpers
  requests/                  history requests, ETA, enqueue-and-wait, the legacy hydration wrapper's mapping
  report/                    `sync shadow report`: part A (the live window), part B (the past journal)
  switch/                    step 3: `sync switch` (preconditions, legacy stop, import, phases A–H), `sync rollback`,
                             `sync switch check` (the acceptance checks); `cli/switch.ts` issues the switch capability
  excluded.ts                step 3, owner decision №8: `sync excluded probe | report | lift | unlift` (`cli/excluded.ts`)
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

Steps that need no request do not wait for the HTTP gate (step 3b, ruling 9; `stepBeforeGate` in `engine/actor.ts`).
On every lap, after the due applies and before the page hold and the pacer, the actor plans the due work of the keys
without HTTP (`dm-live.deletions`) and of the keys that plan before the gate by choice (`planBeforeGate`:
`dm-conversations.find`, which a list read may already have answered) — at most 10 rows a lap, the keys without HTTP
first, under the same fences: the owner generation and mode, the erasure fence the entry takes; the owner's pause of
the page and of a key still stops them. A `local` plan, a closure, a wait or a quarantine commits there; a plan that
asks for a request is left for its slot. Nothing is admitted or paced and the cycle does not move; "why waiting"
never shows a key without HTTP as held by the page or the pacer.

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
`local` step (a write without a request, in one generation-fenced transaction under the erasure fence, taken before
the HTTP gate on the actor's next lap — no page hold or pacer slot delays it — and admitting nothing): the page's hot
rows of the message are marked (sticky), one deliverable `message.deleted` is appended and the archive tombstoned
from it (tombstone-first, sticky against a later REST copy), and the stored window of every touched thread is
recomputed by `syncLegacyThreadSummaryAfterDeletion` — the head stays the conversation list's, the chain is untouched.

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

## Live-only resources (step 3)

These four keys never run in shadow (`liveOnly`, as the identity check `account.identity` and the excluded-chat probe
`probe.excluded-chat`, below): they need a page the engine owns.

- `ws.connect` — the socket's HTTP Upgrade (wire `ws.upgrade`) as an admitted request: the page's socket owner
  (the slot's `FanslyWsSource`, seen by the actor and the transport as a `LivePageSocket`) asks for it at start and
  after every close, the actor admits it through the pacer — never before the owner's reconnect ladder allows
  (`connectNotBefore`) — and the transport sends it through the owner's handshake with the admission's check. A 401/403 at the handshake holds the page `auth`, a 429 holds it `rate_limit`; any
  other failure closes the work `failed_handshake` for the owner's reconnect ladder — no page network streak.
- `repair.ws-gap` — after a socket gap: the conversation list from offset 0 down to the earliest gap of the
  unreconciled verified connections (60 s earlier; with none, the work's first demand), pages at the list route's budget,
  every moved chat read at once, the money head and the subscribers poll bumped; when what it asked for has
  served its demand (≤ 10 min), a `local` step stamps the connections (`state_reconciled_at`,
  `transient_unknown`). Demand during a pass starts a new pass on the same row.
- `dm-conversations.ws-down` — the list head every 30 s while no verified socket proves itself (a guard younger
  than 30 s: a row a killed process left open is not a socket).
- `media-download.fetch` — the AI describer's CDN download of a chat file (wire `cdn.media`): the signed URL is
  the work's secret (`sync_work.secret_params`, sealed with the page-credentials box, read only by the live
  transport, dropped at close), one admission per hop, Fansly media CDN hosts only, ≤ 5 MiB; a 401/403 is the
  signed URL's and closes the download (`subjectScopedAuthStatuses`), a 429 holds the page. The bytes cross to
  the worker through the transient handoff table `sync_media_handoff` (owner decision №17): not a captured fact,
  consumed by the describer's read, swept after 24 h.

The Upgrade and a CDN hop journal nothing (`capture` on their wire spec): no observation, no request line in
`sync_attempts.request` (a hop keeps its number and the sha256 of its path). Their answer is applied once, from
memory, right after the capture (`applyAnswer`); a crash before that, a busy erasure fence or a failed apply
skips the attempt and reads the hop again as a new admission. A `local` plan (`applyLocal`) is a write without
a request in one generation-fenced transaction (with the erasure fence when the entry takes it).

## Excluded chats (step 3, owner decision №8)

The legacy engine excluded chats from message sync (`page_dm_threads.metadata.messageSyncExcludedReason`:
`partner_missing_from_aggregation_accounts`, `partner_unresolvable_from_account_lookup`); the engine reads none of
them (`threadSkip`) and the socket shows their new messages. On a live page `pnpm cli sync excluded probe --page P
[--sample 20] [--reason R]` asks for one `probe.excluded-chat` per sampled chat (bound, visible, most recently active
first; audited `admin.sync_dm_exclusion_probe_request`): one head read of the chat, live only, an ordinary planned
admission. Its answer is journaled and stamped `NEVER_CANONICALIZED_PARSE_VERSION` (the integer maximum, above every
family version — a stamp at the DM family's own version would be replayed by its next bump), so no sweep ever
canonicalizes it and an excluded chat gets no events, messages or archive rows from a probe. A served page closes the
probe `served: true` (messages, newest/oldest time, ids the socket showed first); a 403 (`subjectScopedAuthStatuses`),
a declared 400/404/410/422, a `success: false` envelope or a refused body is the chat's answer: `served: false`,
nothing held, no breaker. A 401 and a 429 stay the page's (plan §9).

`sync excluded report --page P [--reason R] [--record]` prints the newest probe's verdicts (served / not served /
pending) with the evidence ids; `--record` keeps the summary as `admin.sync_dm_exclusion_probe`. `sync excluded lift
--page P --reason R --evidence-page L` needs a live page and L's newest recorded probe of R with ≥ 10 probed chats,
≥ 80 % served and no page-level error (E2): in one transaction the reason joins `sync_pages.lifted_dm_exclusions`
(0235) and the page's bound threads lose it (audited `admin.sync_dm_exclusion_lift`). The engine's conversation list
then never assigns a lifted reason to a thread it leaves bound, nor does the account probe re-exclude a lifted
unresolvable chat, so those chats sync like any other (new heads are read; history only by request). An unbound
thread keeps its reason. `sync excluded unlift --page P --reason R` takes the reason off the page's list; the next
list pass assigns it again. The lift is per page: a later page is lifted after its own acceptance, naming the
first page's recorded probe as evidence.

## Ownership

A page has one owner generation at a time (`sync_pages.owner_generation`, fenced in every write) and its owner holds
the session advisory lock `(58215, pageId)` on the host's one lock session. A new owner starts only when the previous
one is **confirmed stopped**: never owned; its own safe release (`owner_released_at` of its generation — written after
SIGTERM, a mode change or the loss of its lock session, once nothing is in flight); the step-1 OS proof
(`judgeFanslySendHolderTermination`: pid gone, pid reused, boot changed, or this container under a new pid namespace);
or a Docker-level confirmation (`pnpm cli sync ownership confirm-stopped --running-hosts …`, run by the deploy). A lost
lock session alone is never a confirmation. The first send after a takeover waits `1.2 × S` after every send the
database knows of (I5). A `live` page is acquired only once the switch imported its legacy state
(`legacy_imported_at`); without it the page waits (`legacy_not_imported`, alert after 2 min) and nothing is sent.
`sync page mode` moves pages only between `off` and `shadow`.

Credentials (step 3; step 3b ruling 5, A3): every live API request carries the digest of the stored session and
proxy (`credentialsGeneration`, journaled with the attempt). Unless it is the digest the engine trusts
(`sync_pages.credentials_generation`) only the identity checks go out (`account.verify`, `account.identity`) and the
actor raises one verify — checks-only is read from the database at every pick, never kept in memory. What a page hold
is, what it admits and what clears it is ONE pure core, `@agency_hub_core/shared` `fansly-page-holds.ts`, read by the
actor's gate and pick, the final check inside the admission transaction, the rollback's hand-back (SQL only locks the
rows and CAS-writes what the core decided), status/why and the alerts. A credentials hold (`auth`,
`identity_mismatch`) records its LATEST refusal in `hold_detail` (`failedAttemptId`, `failedAt`, the refused digest;
`hold_since` stays the episode's start) and is in force until the apply of an identity proof — an applied
`/account/me` of the page's own account — whose request was sent after that refusal; nothing else lifts it, a moved
trusted digest included. The proof (identity, trusted digest, `identity_checked_at` = its send instant, never
overwritten by an older one) and the clearing are written in the apply's own transaction, which takes the page row
FOR NO KEY UPDATE from its start; a failed write leaves the attempt captured/deferred and its stored answer is applied
again, without a request. Under the hold only an `account.identity` check of a candidate session/proxy (the owner's
change, sealed in the work's secret, over the stored base its caller read) and — once per digest — the
`account.verify` of stored credentials other than the refused ones pass: a candidate that matches is stored and
trusted in one transaction that is a CAS on the exact pair it proved (`saveVerifiedFanslyCredentials`; a changed base
stores nothing, 409), and the verify of what is stored then lifts the hold; a refusal of that verify makes its digest
the latest and closes the exception. One verify per digest, under a hold or in checks-only: a verify quarantined for
credentials no longer stored (its `identity_mismatch`, a contract violation) is closed as `superseded` in the
transaction that raises the verify of the stored ones (audit `sync.credentials_verify_superseded`); one quarantined
for the stored digest stays, for the owner's requeue. A candidate proxy comes from the egress resolver
(`page_candidate` scope). The socket's Upgrade (`ws.connect`) is checked like an API request, and the socket opens
only with the digest its admission checked. A credentials hold and a 429/network hold can both be in force (`hold_detail.timedHold`, the
core's `combineFanslyPageHold`): a credentials hold taken over a 429 hold carries it (the switch's import of a legacy
429 and a legacy auth block), and a candidate check's 429 or network failure under it is carried beside it — the
credentials hold is never replaced or lifted by it. Nothing goes out, not even a candidate check, before the carried
hold ends; the proof lifts only the credentials hold. The egress follows the digest (a changed proxy is resolved
again before the next request).

## Legacy fences (step 3)

While the engine owns a page (`handover` or `live`) no legacy component even tries to send for it (step-3 design
§3.1); the step-1 guard row (`owner_engine`, 0229) stays the catch-all at the wire. One predicate,
`legacyOwnsFanslyPageSql` (`repositories/sync/pages.ts`), gates the legacy planner and leases
(`listRunnablePageSync`, `markPageSyncEnqueued`, `acquirePageSyncLease`, `acquireTargetedPageSyncLease`), the
`sync_silent` deadman, the AI fast lane (`page_held`), hydration dispatch and auto-approval, and the deletion
reconcile's window drift pass. The legacy processes ask `isFanslyPageEngineOwned` / `listEngineOwnedFanslyPages`: the WS
supervisor drops the page within one poll (graceful `disabled`, lock 58213 released), the ws-hints projector files
its receipts under no policy (hints `disabled`, no `fansly_ws_dm` write, no DM stream wake; a deletion keeps its
`mutation_debt` receipt whatever the frame's receive time, so a frame captured before the switch is still marked, and so
is one whose `dm-live.deletions` work a phase-B revert or a rollback cancelled before the engine applied it), the AI
describer downloads nothing itself (a `live` page's CDN hops are its actor's `media-download.fetch`) and wakes no DM stream, and the deletion reconcile writes the marks but no thread window. The owner's `/account/me` routes and CLIs, the probes, the alias backfill and the
`scripts/fansly-ws` probes answer 409 `fansly_page_on_sync_engine` (`services/sync-engine-guard.ts`) with the engine
command to use instead — except the `/account/me` levers (page verify, credentials, proxy, `fansly:ws-policy`), which
on a `live` page go through the engine (`services/sync-engine-account.ts`: `account.verify` / `account.identity`,
≤ 30 s, else 409 `fansly_sync_work_queued` with the work's status link) and answer 409 `fansly_page_switching` in
`handover`. Hydration rows the engine serves (`execution_lane = 'fansly_sync_engine'`) are never expired,
reconciled or swept by the legacy cycle. `shadow` fences nothing, and every check is per query, so leaving to `off`
restores the legacy engine with no other action.

## Switch and rollback (step 3)

`pnpm cli sync switch --page P --shadow-report <path> [--dry-run]` moves one page to the live engine; it is resumable
(where it stands is read from the mode, the guard owner, `legacy_imported_at`, `requests_enabled_at` and the page's
newest `admin.sync_switch` / `admin.sync_rollback` audit row) and refuses a page a rollback left half done (J4).
Phases: **A** mode `handover` (the legacy engine is fenced, the shadow actor releases, the host keeps the page's
lock) and the guard row handed to the engine once no legacy request is in flight; **B** the legacy stop confirmed
(`switch/legacy-stop.ts`: no running lease, open run, open HTTP attempt, open guarded send, socket lock holder or
active thread backfill; the guard handed); **R** the final incremental chain rebuild; **I** the legacy import
(`switch/import.ts`: shadow work superseded, every module's `importLegacy` — cursors, carried DM breakers (merged
into the key's open work, else a closed carrier the next work inherits; a `handover` receipt waits for the import's
fence), head-debt catch-ups —, one urgent head read per chat with an unconfirmed overlay row, a legacy 429 hold or
auth block carried, the 0231 marking, the takeover `account.verify`, `legacy_imported_at` last); **C** mode `live`, a
new owner generation within 2 min, history requests open (+1 h on the first page ever switched); **H** once they are
open, the page's hydration requests become history requests (`switch_migration`). A or B timing out reverts to
`shadow` (exit 2); no live owner after C is exit 4. `sync switch --open-requests` runs H on the first page; `sync
switch check --page P --since T0` prints the acceptance checks (pace over both journals, the handover boundary, vendor
refusals, nothing stuck, the SLOs, volume, restarts, open incidents).

`pnpm cli sync rollback --page P [--with-auth-hold]` gives the page back: `handover` (the live actor and its socket
stop and release), the release (or `sync ownership confirm-stopped`, exit 3 otherwise), the guard back to the legacy
engine with its floor past the engine's last send and the end of an engine 429/list/network hold (also one an auth
hold carries), live work
cancelled but the history works (their requests pause, `rolled_back`), the wrapper's hydration rows settled (the
state their ended request mirrors, else `expired`), `off` and `requestPageSync(all, recovery)`. An engine
auth/identity hold in force by the page-hold core (whatever digest the engine trusts) refuses (exit 5) unless
`--with-auth-hold`: on a live page before anything moves — the page stays live, where the owner's credentials renewal
runs its identity check and then the verify of the new stored credentials under the hold, whose proof lifts it; a hold that came in
while the actor stopped puts a page the rollback took from live back to live; a page in `handover` before the
rollback stays there (no identity check runs in `handover`). The legacy engine continues from its own marks: nothing of step 3 writes its state
(J5). Runbook: step-3 design §6.

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
| I17 | No live sender without the step-3 switch: `LIVE_LOOP_ENABLED`, mode `live` (only the switch CLI's capability reaches it), the legacy guard row handed to the engine, and the legacy import — independent gates. | `engine/host.ts` + `lockOwnedPage` + `cli/switch.ts` |
| I18 | Every WS receipt of a `handover`/`live` page routes its demand exactly once, in the transaction that acks it. | `fansly/ws/route-receipt.ts` |
| I19 | Between two actual sends of one page on one route (or one family): ≥ the interval of its effective rate, counted from the actual send in the journal the page runs (the legacy send log too on a live page; an unknown outcome at its upper bound); no burst, no borrowing. | `engine/route-policy.ts` (`RouteClocks`) + `engine/actor.ts` (pick exclusion, final check) |
| I20 | One page-hold rule: a credentials hold clears only by an identity proof sent after its latest refusal, written with the apply; under it only a candidate check and one verify per changed stored digest pass (step 3b ruling 5, A3). | `packages/shared/src/fansly-page-holds.ts` (gate, final admission, rollback, status, alerts) + `engine/commit.ts` (`recordIdentityProof`) |

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
| `page_hold` | 429 (until `Retry-After`, else 2 → 4 → 8 → 30 min), 401/403 or identity mismatch (until an identity proof sent after the latest refusal), network (after 3 failures: 10 s → 5 min) | the hold's end; the verify of renewed credentials |
| `quarantined` | the answer broke its contract or the cursor stuck; the raw answer is kept | the owner re-applying it from the journal |
| `blocked_by_vendor` | the subject failed 5 times; probed once a day while demand exists | a successful probe |
| `subject_breaker` | the subject failed: 1 min → 10 min → 1 h → 6 h → 24 h | the breaker's end, then a success |
| `resource_hold` | ≥ 5 subjects of the resource failed within 10 min: 30 min → 2 h → 6 h (never `dm-messages.head`); or the conversation list answered 429: only the keys that can only read the list wait, 5 s → 10 s → … → 300 s | the hold's end |
| `dependency` | the resource waits for other work or data | that work |
| `not_due` | its time has not come (poll period, coalescing window) | the due time |
| `pacer` | runnable; the page's next slot has not opened yet, or every route of the key is closed by its budget or a route hold (`detail.routes`; a request its planned route put off is due when that route opens) | the pause; the route's opening |
| `class_share` | runnable; the slot belongs to another class or to earlier work of its class | its turn |

## Errors

`engine/errors.ts` classifies every outcome and decides every consequence in one place (`onOutcome`); the commit
transactions only write what it decided. The engine never changes `S`: a 429 holds the page and alerts the owner —
except a 429 on an endpoint group with a quota of its own (`ENDPOINT_RATE_GROUPS`): the conversation list (owner
decision №14) and the media statistics (owner decision №20), which holds only that group's keys. How often a route
is read is its budget's (below), never a group's.
A retry after an error is always a new attempt through the same admission.

| Answer | Class | Consequence |
|---|---|---|
| 2xx, success envelope, contract accepts | `ok` | streak reset, subject breaker reset, expired holds cleared |
| 2xx, contract refuses (or the cursor stuck) | `contract` / `cursor_stuck` | quarantine the work and the attempt, alert 2 |
| 2xx without a success envelope | `envelope_unsuccessful` | as `subject_failure` |
| 429 on the conversation list (`messaging.groups`) | `rate_limit_list` | the list only (`resource_holds['dm-conversations']`): until `Retry-After`, else 5 s → 10 s → 20 s → 40 s → 80 s → 160 s → 300 s by consecutive list 429s, reset after 10 min without one; `.find` goes straight to `group.detail`; alert 1 only at the 300 s step |
| 429 on the media statistics (`media.offer_stats`) | `rate_limit_media_stats` | `media-stats.walk` only (`resource_holds['media-stats']`): the list's rule and ladder — until `Retry-After`, else 5 s → … → 300 s, reset after 10 min without one; alert 1 only at the 300 s step |
| any other 429, or a 5xx naming its own `Retry-After` | `rate_limit` | page hold, alert 1 |
| 401 / 403 the resource declares about its subject (`subjectScopedAuthStatuses`: a CDN hop's signed URL) | `subject_terminal` | the subject closes with its receipt, no hold |
| 401 / 403 | `auth` | page hold until an identity proof sent after this refusal (recorded as the latest), alert 1 |
| any other non-2xx | `subject_failure` | subject breaker; ≥ 5 subjects of a file in 10 min ⇒ resource hold |
| a status the resource declares terminal | `subject_terminal` | the subject closes with a receipt, no breaker |
| transport error, timeout, 408 | `network` | streak; at 3 ⇒ page hold; alert 1 after 10 min |
| refused before sending | `not_sent` | nothing learned: the work is admitted again |

An apply that fails (`engine/commit.ts`, `classifyApplyError`) never stops the actor. A deferral (erasure fence busy,
journal body unreadable) and a transient database error retry without counting; an unexpected error is counted and
quarantined at the third try; a deterministic one (SQLSTATE class 22/23, contract) is quarantined at once, alert 2.
Two deterministic errors stop more than their work: an identity error (`PlatformAccountIdentity*Error`) goes through
`onOutcome` as `identity_mismatch` (page hold until an identity proof after it, alerts 1 and 2), and a wrong transactions writer
holds the resource file (30 min → 2 h → 6 h).

## Route budgets (step 3b)

Fansly's quota is a bucket per page and endpoint (≈ 20 a minute; `impl/research-astra-quota-model.md`), so on top of
the pause S every route of a page has a strict budget of its own (owner decisions №21–№26, plan PR 1-1).

- **Routes** (`fansly/routes.ts`): one canonical route per GET endpoint — every wire spec (the socket's Upgrade
  `ws.upgrade` and the media CDN `cdn.media` included) under its wire id, plus the endpoints only the legacy engine
  reads. Parameters never make another route. `FANSLY_LEGACY_OPERATION_ROUTES` maps every
  `fansly_send_log.operation` onto them (pinned complete by `tests/sync-route-policy.test.ts`).
- **Budgets**: `ceiling` (the code maximum) and `current` (what every page runs at) per route — 15/min by
  default, the list 12, the media statistics 5 under a 12 ceiling — and per family on top: messaging (the list, a
  group's detail, `/message`) 15/min, earnings (`/account/wallets/earnings/*`) 17/min. `current` moves only by a
  calibration PR, +1/min a step, on evidence. `ROUTE_POLICY_HASH` names the table.
- **Strict admission** (`engine/route-policy.ts`): a route (and its family) admits its next send no sooner than one
  interval of its effective rate after its previous ACTUAL send — no burst, an idle hour earns nothing. The clocks
  are read from the journal at every slot (`readRouteJournal`): the page's own journal (a shadow page its shadow
  one, so the shadow report sees the budgets live pages keep), and on a live page the legacy send log too (what the
  legacy engine sent before the switch). A send whose instant is unknown counts at its upper bound (admission +
  the send window; a guard capture's completion or lease end); an operation nobody can place counts on every route.
- **At the pick** a key all of whose routes are closed is left out (`routeExclusions`, in SQL like every
  exclusion): a spent route never takes a slot. **The short look-ahead**: when the class whose turn it is has
  nothing admissible now but a candidate that opens within 1.2 × S, the slot waits for it rather than serve a
  later class (a planned read squeezed in would push it a whole pause later); nothing is reserved, the pointer
  moves only on an admission. **After the plan** the planned request's own route is checked for every key (a walk
  over several routes, `probe.manual`, the CDN, the Upgrade): closed, the work is put off until it opens
  (`waiting_reason = 'pacer'`), nothing admitted, the slot open for other work.
- **Route state**: a page's holds and slowdowns after a 429 live in one versioned namespace of its row
  (`resource_holds['route:state']`, `SYNC_ROUTE_STATE_KEY`; the page row hands it out apart as `routeState`). It may
  only make a route slower: the effective rate is the lower of `current` and the stored one, a stored hold closes
  its route to its end. A namespace this build cannot read closes the page's admission (`page_hold` with
  `detail.routeState` in "why", alert 1 `route_state_unreadable`, metric `sync_route_state_unreadable`).
- **Status and why** (owner CLI): `sync page status` lists each route the page used recently and each family —
  ceiling, current, effective rate, interval, newest send, hold, when it opens — with the policy hash; `sync why`
  names the closed routes of a key waiting on `pacer`.

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
from 10 min before the start: a window begun before the deploy or a page's switch to shadow is never accepted), demand against a computed expectation (polls
judged in runs against their schedule, the reads the hour's socket frames imply after coalescing; keys on a period
longer than the hour counted at their rate; one-time backlog walks listed apart), the legacy engine's volume per
stream and sender with the reason it differs (the hour, or 7-day rates for streams slower than the hour; live-only
senders listed apart; legacy's scheduled purchase poll listed apart once every order it read in the hour is one the
engine hears of — a PPV ledger row or a socket order frame — since `purchases.targets` runs on demand only and its
live demand, the transactions apply's new sales, names no target in shadow), the live-path decisions (a fan message or a new ledger
row on the socket → the shadow admission vs the legacy arrival; an offline replay of the previous day's routing when
the hour is too quiet), the pacer's self-check; part B over the past journal — every resource's replay of its legacy
observations (≥ 99.9 %, every mismatch listed), the chain rebuild and end-of-history check since 05.07 (the 16.09
counterexamples listed, no empty-page soundness hit) and the ETA backtest. `--out <path>` keeps the report for the
step-3 switch. Where the design's wording needed a rule to be measurable (`SHADOW_WINDOW_RULES` in
`report/shadow-window.ts`: A1.rate, A1.rate-assumed, A1.ceiling, A1.ceiling-demand, A1.floor, A1.floor-scheduled,
A1.floor-queue, A1.floor-idle, A1.poll-schedule, A2.rate, A2.legacy-regime, A2.live-only, A2.demand-replaced), every
report prints the rule it applied.
Three of them ask the resource modules read-only questions (`ResourceModule`), each in its own savepoint:
`estimateRunSteps` sizes a key on a period longer than the hour before its first shadow run, while its row keeps that
run on schedule (its `shadow()` estimate, A1.rate-assumed; a key that ran before stays unknown until it runs again),
`queueNextDueAt` says when a queue walk without a standing row is next asked for, or that its queue changed after the
window end (`fan-earnings.roster`, A1.floor-queue), and `dueAtLook` re-runs a standing walk's look over the subjects
nobody changed since and probes its due rule 5 years on (A1.floor-idle: the look was on time and the rule reads at all
— which subjects it takes is not verified while legacy reads the same queue first); the registry test pins that every
such key implements its question. The checks read the live settings as the engine host does (the report requires a
`SettingsSource`; the CLI builds it from the env config and the database's overrides): `post-replies.walk`'s pick reads
`fanslyRepliesRewalkCycleDays` live (prod 30 d, registry 14 d), so its look check fails without them rather than re-run
another pick.

## Recipes

| Change | Where |
|---|---|
| The pause | the owner's console ("Пауза между запросами Fansly"); 0 files |
| The jitter rule | one line in `engine/pacer.ts` + the invariant tests (`tests/sync-pacer*.test.ts`) |
| How fresh a resource is | one line in `fansly/registry.ts` |
| A route's budget (a calibration step) | one entry in `fansly/routes.ts` (`ROUTE_BUDGETS` / `FAMILY_BUDGETS`) + the pinned table in `tests/sync-route-policy.test.ts` |
| How fresh a resource is on one page, without a deploy | `pnpm cli sync page override --page <label> --resource <key>` with `--period-ms` (a poll), `--period-ms`/`--full-period-ms` (`catalog.vault`) or `--tiers '<json>'` (`media-stats.walk`); owner decision №6 keys need `--owner-approved` |
| Class order or shares | `engine/scheduler.ts` + `tests/sync-scheduler-cycle.test.ts` |
| The reaction to 429 / 5xx / network | `engine/errors.ts` + `tests/sync-engine-errors.test.ts` |
| A new Fansly endpoint in a known domain | the spec in `packages/fansly/src/wire/specs.ts`, the resource, a registry row, a test |
| Where the describer's downloads of a live page stand | `sync_work` of `media-download.fetch` (subject `desc:<id>`), `sync_media_handoff` (bytes awaiting the worker) |
| A new kind of data | the same + schema, repository, migration |
| A new depth or rule of a history request | `requests/history-rules.ts` (satisfaction, anchors) + `requests/history.ts` + the contract |
| A new WebSocket event | `fansly/ws/decode.ts`, `fansly/ws/router.ts` + a test |
| "Why is chat X still partial?" | `hub sync-why`; the code is one resource file |
| One read of a route for a page, now | `pnpm cli sync probe --page <label> --operation <wire id> --params '<json>'` (shadow: simulated) |
| Do the excluded chats of a live page load? Lift the exclusion | `pnpm cli sync excluded probe --page <label>`; `… report --page <label> --record`; `… lift --page <label> --reason <reason> --evidence-page <label>` |
| Quarantined work, after the fix | `pnpm cli sync work list --page <label> --state quarantined`; `pnpm cli sync work requeue --page <label> --quarantined [--resource <key>]` |
| A backfill / fresh walk on a live page | `pnpm cli sync work enqueue --page <label> --resource <key>` (keys with the `owner` trigger) |
| What alerts hold on a page; close a pace violation | `pnpm cli sync alerts status [--page <label>]`; `pnpm cli sync alerts ack --page <label> --note '…'` |
| An alert's threshold or condition | one constant or rule in `engine/alerts.ts` + `tests/sync-alerts.test.ts` |
| The shadow acceptance | `pnpm cli sync shadow report --window <start>/<end> --out <path>` (part B alone: `--part b`, outside 00:00–05:00 UTC) |
