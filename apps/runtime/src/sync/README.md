# Fansly Sync Engine

One long-running process (`sync`) hosts one **actor per Fansly page**. The actor is the page's only sender: every
physical request of the page passes one pacer, one queue (`sync_work`), one journal row per attempt
(`sync_attempts`). Plan: `docs/plans/2026-10-01-sync-engine/plan.md`. OnlyFans is not here.

Operating it — a page's status and "why", the owner's levers, the alerts, onboarding, restarts, calibration — is the
runbook `docs/runbooks/sync.md`; this file is how the engine works.

The engine landed in steps: step 2 ran it in **shadow** next to the legacy engine (it planned, paced and journaled,
but never sent); step 3 switched the six pages one by one (`sync switch`, gone since step 4 S4-21); step 4 deletes the
legacy code — and shadow mode with it (S4-23): an actor runs a `live` page and nothing else, nothing puts a page in
`shadow`, and no code path plans, paces or journals without sending. The value `shadow` stays what the CHECKs of
`sync_pages.mode`, `sync_attempts.outcome` and `send_mark` admit, and the rows shadow mode left (`shadow = true` in
`sync_work` and `sync_attempts`) stay until the telemetry retention prunes them: nothing writes one, and every read
of a page's queue or journal leaves them out (`not shadow`). A page sends as the engine only on a `live` row with
the engine's step-1 guard row and its import mark; `sync page mode` only takes a page left in `shadow` to `off`, and
no lever takes a page to `live` or out of it (I17). Since step 4 a new Fansly page is born `live`:
onboarding checks its session through its own proxy without a page (one journaled `/account/me`, `fansly_send_log`
with `page_id` null — owner decision №4) and creates the page, its credentials, the proven identity, the trusted
credentials digest, its `live` row and its engine-owned guard row in one transaction (`createLiveSyncPage`); the host
adopts it on its next pass and its first request goes ≥ 1.2 × S later (I5). The legacy engine never runs it. The same
transaction queues the page's five history walks, once — the registry's `new_page` trigger, whose one producer the
birth is (`fanslyNewPageWork`): `notifications.backfill`, `posts.backfill`, `stats.backfill`, `subscribers.history`,
`transactions.backfill`, planned goals in the planned class's turn; the top-spenders bootstrap stays the owner's
demand, old chat history a request (I12).
Since step 4 S4-10 the legacy page-sync executor serves no Fansly page at all (I21): Fansly declares no legacy stream,
so the legacy planner and executor seed, schedule, wake and lease OnlyFans pages only, the app-level `requestPageSync`
(`services/sync-control.ts`, behind the API, the CLI and the levers) refuses a Fansly page with 409
`legacy_sync_retired`, the owner's trigger scopes of a Fansly page resolve straight to the registry keys
(`services/sync-engine-levers.ts` `FANSLY_ENGINE_SCOPE_STREAMS`). Nothing writes a Fansly page's legacy rows
(`page_sync_states`) any more.
Since S4-19 the executor holds nothing of Fansly either: `services/sync/` has no Fansly handler, error class, page
provider hold (R04) or import of the Fansly HTTP package, and the owner's `/account/me` levers (page verify, a
credentials or proxy change) have no legacy sender behind them. `onlyfans/boundary.ts` is where that executor's
platform set is read from; the planner and the executor scope every page-sync query with it and assert it before they
wake or run a page (tests/sync-onlyfans-boundary.test.ts is the ratchet).
Since S4-20 no legacy sender of a Fansly page is left at all (I13): the Fansly adapter's HTTP, the endpoint and replay
probe CLIs (`sync probe` is the engine's), the alias backfill CLI (`sync work enqueue --resource
fan-profiles.alias-backfill`) and the describer's guarded CDN hop are deleted, and the app context builds no Fansly
client. The describer's page-egress download serves the pages without a `live` row (OnlyFans) and refuses a Fansly
CDN host before anything is sent. The guard row and its journal stay (`lockOwnedPage`, the takeover floor, the
no-page identity check's `fansly_send_log` row).
Since S4-21 there is no way back to the legacy engine, in code or in data (the point of no return, stage 2): the
step-3 switch, its rollback, the legacy import (every resource's import hook, the import's readers) and the switch
capability are deleted; migration 0239 parks every Fansly `page_sync_states` row for good (`paused`, blocker
`retired`, code `fansly_sync_engine_owned` — a blocker no image clears); and the `sync_pages` mode predicate the legacy
pickers carried through step 3 is replaced by the executor's platform set (Legacy fences, below).
Since S4-24 no status surface describes a Fansly page by a legacy stream: `/health/sync`, the Settings blocks, the page
summary and its connection status speak for the engine or say that nothing reads the page; the legacy monitor and the
`sync_streams` dataset list the legacy executor's pages (OnlyFans) only; the executor's stream policy
(`SYNC_STREAM_POLICY`) has a row for each OnlyFans stream and none for a Fansly lane; and the stream names the owner's
levers address a Fansly page by are the registry's own lever map (A Fansly page on the status surfaces, below).

## Map

```
sync/
  main.ts, context.ts        the `sync` runtime role: context (pool timeouts), watchdog, heartbeat, host, signals
  cli.ts, inspect.ts         the owner's CLI (`pnpm cli sync page …`, `sync why`, `sync work …`, `sync ownership …`) and its reads
  engine/
    ports.ts                 Clock, Rng, PauseSource, Wake, OwnershipSession, AlertSink, Metrics, Transport
    pacer.ts                 the ONLY admission authority: the pause rule, one request in flight, takeover floor
    route-policy.ts          the route budgets on top of it: clocks from the journal, route state, pick exclusion, look-ahead
    admission.ts             the hold evaluator: ONE answer to "what holds this request?" over the page's hold set
    scheduler.ts             the 10-slot cycle U R U R U R U R U P over the three classes (+ the short look-ahead)
    errors.ts                outcome → error class → page hold / network pause / breakers / quarantine
    status.ts                "why waiting" and the page status
    resource.ts              the resource contract (plan / apply) and the rules every entry shares
    host.ts                  pages ↔ actors, ownership, LISTEN, mode changes, SIGTERM; LIVE_LOOP_ENABLED
    host-ports.ts            the lock session (advisory locks 58215) and the LISTEN wake
    actor.ts                 one page: recover → loop (steps without a request; plan → admit → send → capture → apply)
    commit.ts                the four transactions of a step, the no-HTTP outcomes and the local writes
    alerts.ts                alerts 1–4: the incident sink, the 30 s evaluator, the pace backstop, the owner's ack
                             (`sync alerts status | ack`, `cli/alerts.ts`)
    send-audit.ts            the send audit (I1, I19): the one checker of the evaluator and `sync check live-hour`
    watchdog.ts              the stall watchdog: a step, pass or beat stuck for 120 s ends the process (exit 70)
    metrics.ts               the golden signals (per page; the ops sampler's compact set every 5 min)
  fansly/
    registry.ts              ALL Fansly resources: trigger, period, class, coalescing, SLO, proof
    routes.ts                every route a request can take, its family and budget; the legacy send log's map
    transport.ts             the live page transport over the wire layer (packages/fansly/src/wire)
    identity-without-page.ts the no-page `/account/me` of onboarding and the create-page check (unpaced, journaled)
    public-lookup.ts         the session-less public account reader (arena R5): its own egress, budget and stop
    resources/               one file per resource family
    ws/                      decode, router, the post-ack routing hook and a live page's socket (`source.ts`)
    lib/                     chain rules, walk helpers; the money, audience, fan-hydration, purchase-history, stats,
                             media-stats, notifications, payouts, post-replies, catalog, posts and lane rules the
                             resources use (step 4 moved them here; what is left of the legacy executor takes only
                             pure rules from them: the OnlyFans top spenders the window rules, the OnlyFans posts
                             stream the posts cursor, the legacy capture seam the journal's body rules)
  requests/                  history requests, ETA, enqueue-and-wait, the legacy hydration wrapper's mapping
  checks/                    read-only checks of live pages: `sync check live-hour` (`cli/checks.ts`) — a page's
                             first hour on the engine and the combined pace audit of both journals
  excluded.ts                step 3, owner decision №8: `sync excluded probe | report | lift | unlift` (`cli/excluded.ts`)
  chats.ts                   the chats Fansly does not serve: `sync chats unavailable | note` (`cli/chats.ts`), no request
  public-lookup.ts           the public account reader's levers: `sync public-lookup status | queue | enable | disable |
                             resume | recheck-marks | proxy` (`cli/public-lookup.ts`), no request
  parity/                    step 4, owner decision №11: `sync dm-reader-parity` (`cli/dm-reader-parity.ts`), the
                             read-only DM reader parity of page_dm_messages and message_archive (the readers
                             serve live pages from the archive: "DM readers on the archive")
  onlyfans/boundary.ts       step 4: where the engine ends — the platform set of the legacy page-sync executor
                             (`services/sync/`, OnlyFans only) and its assertion in the planner and the executor
```

Files appear PR by PR during step 2; a file in this map that is not in the tree is not merged yet. The registry
lists every resource from the start: an entry whose code has not landed has no `module`, so its work waits on
`dependency` and counts `sync_not_implemented`.

A resource never sends a second request inside its apply. When an apply learns it needs more (the profiles of new
subscribers, a fresh `/account/me` counter, a follower reconcile), it returns that as demand: a follow-up work row,
or a plan that waits on `dependency` and makes the other work due. Fan profiles are one batch walk per page
(`fan-profiles.lookup`): the asking apply merges the fan ids into the walk row's `params.ids`, and each step reads up
to 100 of them not looked up through the page within the day. Every asked id gets the page's own answer
(`page_fans.account_probe_*`); an id the answer omits marks nothing on the shared fan row, since a fan who blocked the
page is omitted too.

A DM thread has three writers, each with its own columns: the conversation list (`dm-conversations.*`, through
`upsertPageDmConversationListFields`: partner and fan, flags, unread count, the `last_message_*` head, visibility, the
membership generation and the list's two metadata keys — never an unbinding), the chain (`writeThreadChain`) and, on
pages the engine owns, the legacy coverage columns (`writeThreadSummary` after a read, from the messages it stored in
`message_archive`; `writeThreadSummaryAfterDeletion` after a socket deletion, a recount of the thread's archive
messages). A list head newer than what the message reads reached becomes one `dm-messages.catchup` (planned;
`dm-messages.head` when the list is the live signal).

A socket event in a chat the page does not know raises `dm-conversations.find` (urgent, 12 s). A burst of new chats
shares one read of the list head (step 3b ruling 1, plan PR 1-3): the first read of offset 0 by any key of the list
route (`DM_LIST_READ_KEYS`: the head and full walks, `.find`, `.ws-down`, `repair.ws-gap`) admitted since a find's
first demand and applied answers it — a read admitted earlier may have been served before the chat existed. A chat
a read wrote since the demand is found with no request, before the HTTP gate: a `local` step closes the find
`found_by_shared_read` and asks the chat's urgent `dm-messages.head` unless one is open (a list or detail apply asks
it already for every chat a `.find` is open for, never a planned catch-up). A chat such a head read did not show
goes to its group detail, which creates the thread (D5), as does every chat while a 429 holds the list's route; with
neither, the find reads the list head itself.

A message read (`dm-messages.head`, `.catchup`, `.history`) is one `/message` page per step. Its apply folds the page
into the chain before it writes anything (an anomaly the design sends to review quarantines the step whole), then
writes the page's rows minus any an executed erasure fences, the chain, the legacy coverage columns (engine-owned
pages only), the overlay confirmation, and — last — the inline canonicalization and the `message_archive` rows of
the page's message events. When the chat was deleted, unbound or excluded between the plan and the apply, only that
last part runs, under the same fence, so the minutely sweep never appends the page unfenced. A `.head` walk reads down (`before`) while its staged head page has not met the confirmed
head; a demanded id the vendor's head does not show yet is read again after 15 s and 60 s, then settled `not_found`.

A plan is read-only, so a decision it takes that the apply must fold into — a media visit's windows, an album walk's
proof header, the floors a history walk crossed without a request — travels with the request (`RequestPlan.step`,
stored as `sync_attempts.request.step`) and comes back to the apply and a re-apply from the journal. A media visit is a pure procedure replayed over the answers it has (`fansly/resources/media-stats.ts`), so
one visit becomes one window per step, its windows in the order the visit asks for them. A visit in flight
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
always gives a lower bound and an estimate; `pnpm cli sync history eta-backtest` measures it on the journal. Its time
(step 3b ruling 11) is the reads at the tightest budget a history read draws on — the page's slots, the `/message`
route (lower after a 429's slowdown) and the messaging family — each shared by the cycle's turns (U 5, R 4, P 1), the
urgent and planned classes wanting what they sent on it over the last 15 minutes and a class that wants less leaving
the rest (`requestsCapacity`); no share is raised to a floor. A page or route hold in force is shown beside it (`eta.hold`), not in it; `estimate_at_submit`
is written once with the request and never again.

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
breaker and last attempt) are read by `inspect.ts` from the page's queue and journal (never the rows shadow mode
left). Three clients share those functions and one wire (`requests/wire.ts`): the owner CLI
(`pnpm cli sync page status`, `sync why`), the owner routes (`syncPages`, `syncPageWork`, `syncPageWorkGet`) and the
agent plane (`agentSyncStatus`, `agentSyncWhy`, `hub sync-status`, `hub sync-why`; `read:datasets`, and
`read:messages` too for a key whose subjects are chats or fans).

"Sync now" (`syncPageRefresh`, `refreshSyncPage`) makes the page's poll rows due now and wakes its actor; it sends
nothing itself, and a page no actor runs (`off`, or one left in `shadow`) answers 409 `sync_page_off`.

### A Fansly page on the status surfaces and the owner's levers (step 3 S3-02, step 4 S4-24)

The surfaces that describe a page block by block, and the owner's levers behind them, serve two engines. A page of a
platform the legacy executor serves (OnlyFans) is described by its legacy stream rows. A Fansly page is described by
the Fansly Sync Engine, and by nothing else: no surface reads its `page_sync_states` rows (parked records).

The lever map is the registry's (`fansly/registry.ts`, `FANSLY_LEVER_STREAMS`): each line names a stream — a
`sync_stream` value, because the API contracts carry these names — and the registry keys that answer to it. A key in no
line (`FANSLY_KEYS_WITHOUT_LEVER`: the identity checks, the socket and its repair, live deletions, the alias backfill,
the probes, media download) is addressed by its own name. `services/sync-status-engine.ts` says which lever streams
each Settings block shows and moves (`ENGINE_BLOCK_STREAMS`), `services/sync-engine-levers.ts` which ones a "sync now"
scope names (`FANSLY_ENGINE_SCOPE_STREAMS`). tests/sync-lever-map.test.ts pins the three and that every registry key is
placed. The streams of two blocks share no key (`engineBlockKeys`; S4-35): a block's buttons move its own keys, so a
pause of one block is never half undone by a resume of another. The chat list (`dm-conversations.*`, with
`fan-profiles.probe`) and the chat messages (`dm-messages.*`, `.catchup` among them) are such two sets.

**What stops a key** (S4-35). The surfaces that describe a page stream by stream say whether a stream is being read from
one verdict, `engineStops` (`services/sync-status-engine.ts`): for each registry key, the owner's pause (the page, the
requests class, the key) and what the hold evaluator says of a request of the key (`engine/admission.ts` `heldByScope`,
the rule the actor admits by) — the page's own hold (`auth`, `identity_mismatch`, `network`, or rows this build cannot
read), the breaker of the key's resource file, a 429's hold of its routes. Every cause is listed, not the first: ending
one leaves the others. A 429's hold stops a key in the two ways the actor meets it: every route the key reads is held
(the pick leaves the key out), or one of them is and the request its work planned took it — the final check put the work
off until the route opens (`deferForRoute`: the row stores `pacer`, due then). A key that reads several routes
(`followers.reconcile`, `posts.refresh`, `posts.backfill`, the catalogue and statistics reads, `fan-earnings.roster`,
`payouts.daily`) is picked while one of them is open, so such a hold shows only on its row: the verdict asks the
evaluator about that row as "why" does (`routePutOffUntil`, `engine/status.ts`), and the stop ends when the row is due
again, or with the hold if that is sooner. The row is read for the keys that work per page (one row a key, already among
the status facts); a key that works per subject is judged by its routes alone — `dm-conversations.find` is the only one
that reads several, and each of its routes is the one route of another key of its stream (pinned in
tests/sync-engine-stream-state.test.ts). A route's own pace is no stop (work it puts off is queued). The route holds are
read from the page's hold set alone — no read of the attempt journal — so the verdict costs the status reads nothing. A
stream or a block is `stopped` `none` / `some` / `all` of its keys, and `nextDueAt` is the earliest due time of open
work of a key nothing stops: a paused or held key has no next read while its stop stands. "Reading" is said only of keys
a host runs and nothing stops.

| Surface | A Fansly page the engine owns (`handover`/`live`) |
|---|---|
| `/api/v1/health/sync` | an `engine` block (mode, owner heartbeat age, hold, oldest due urgent work, socket, quarantine, open alerts); unhealthy on an owner silent > 90 s, an `auth`/`identity_mismatch` hold, or `handover` > 10 min. No legacy stream is judged, and a chat Fansly does not serve to the page is not reflected |
| Settings blocks (`syncOverview`, `pageSyncBlocks`) | every block `state: "engine"` + `engineMode` + `engine`: whether a host runs the page (`ownerRunning`), the block's own keys (`keys`), its polls (`pollKeys`: what "sync now" makes due — a block without one has nothing to move), the keys the owner paused (`pausedKeys`, `pausedAll`), what stops its keys (`stopped`, `stops`, `paused`), its quarantined rows and the rows Fansly refuses, by key; each lever stream of the block from its keys' live work (last applied, next due, why the earliest waits, quarantine / vendor block, what stops it); a refused credential reads `credentials_invalid` on the connection block. Last applied of a key that works per subject (`dm-messages.head` per chat, `purchases.targets` per target) is its newest applied attempt over all its subjects (`lastLiveAppliedAtOverSubjects`: a bounded number of the key's rows, never a read per subject). Work that needs the owner names the command that lists it: `sync work list --state quarantined` for quarantined rows, `--state open --resource <key>` for rows Fansly refuses (they stay open, waiting `blocked_by_vendor`) |
| Block buttons, `/admin/sync/trigger(-all)` | trigger ⇒ the keys' polls due now (`refreshSyncPage`); pause / resume ⇒ the keys in / out of `paused_resources` (the rest kept); reset ⇒ the keys' quarantined work requeued — `page_sync_states` never touched; `handover` ⇒ 409 `fansly_page_switching` for a lever that would read. The answer's `engine.affected` is what moved (polls made due, keys paused or resumed, rows requeued): 0 is a lever that did nothing, and the dashboard says so instead of "done" |
| Page summary (`syncUx` of the overview, the sidebar's connections, the credentials tab) | `buildEnginePageSyncUx`, from the page's row and the counts of its active work: new credentials needed (an `auth`/`identity_mismatch` hold), work of a Settings block quarantined or refused by Fansly, a switch in progress, or managed by the engine — and, beside the last three, `Chats Fansly does not serve: N` (a chat's unavailability episode is no attention: its work is out of the vendor-block count) |
| Connection status (`/admin/connections`, the health page item) | `expired` while the engine holds the page for its credentials, else by the age of the account read the engine stamps on the page (`account.poll`); no legacy run is consulted |
| Follower reconcile reset / blast-radius override | the quarantined `followers.reconcile` row: reset cancels it and files owner demand (a fresh walk); the override reads the walk from the row's cursor and `result.quarantine`, deactivates exactly the previewed set and closes the row done |
| Insights coverage (`/api/v1/pages/:pageLabel/stats/coverage`) | an `engine` block: mode, whether a host runs the page (`ownerRunning`), and per lever stream its keys, last applied, next due, its open work (`activeWork`), paused, what stops its keys (`stopped`, `stops`), why the earliest waits (`waiting`: key, reason, until — as data; `reason`: one line), quarantine / vendor block, largest failure count |
| Top spenders `source` (`/api/v1/pages/:pageLabel/top-spenders`) | `fan_earnings` from `fan-earnings.roster`'s live work: `ramped` unless the owner paused it (`flag_off`), its last applied read, its largest failure count |

A Fansly page the engine does not own (no engine row, or one in `off` / `shadow`) is read by nothing. `/health/sync`
reports it unhealthy with the one issue `engine:not_live` and no `engine` block; its Settings blocks are `not_available`
with the reason `fansly_sync_engine_off`; its summary reads "Not syncing"; a block lever, a trigger scope and the
follower reconcile levers answer 409 `legacy_sync_retired`; the insights `engine` block is `null` and the top-spenders
source `flag_off`.

In the dashboard each engine has its Settings tab (S4-28). «Синк» (`?tab=engine`, `pages/settings/engine/`) lists the
Fansly pages as the engine reads them — owner, holds, socket, the pause and how it was kept, the queue by class with
the hour's requests, from `/api/v1/sync/pages`; the open history requests with their fans, reads and the ETA's two
numbers, from `/api/v1/sync/history-requests` — and a page's detail there carries the five Settings blocks with their
buttons. «Синхронизация» (`?tab=sync`) lists the legacy executor's pages only. `syncSettingsTab` (`lib/navigation.ts`)
names a page's tab from its platform, and every link to a page's sync goes through it; a page opened on the other tab
is pointed to its own. The engine's words live in one table, `engine/engineDisplay.ts`: a waiting reason
(`engineWaitWords`), a stop (`engineStopText`) and the one thing that is true of a stream or a block
(`engineReadingState`: not running without an owner, paused, page held, held, needs attention, partly paused or held,
reading, idle) — Russian for the «Синк» tab, English for the analytics Coverage panel, which reads the insights
`engine` block. "Reading" takes a host that runs the page, open work and keys nothing stops; everything else is named.

The «Синк» tab is in one language and has its own block cards (`engine/EngineBlocks.tsx`, worded by
`engine/engineBlockDisplay.ts`; S4-35): the cards «Синхронизация» keeps know nothing of the engine. A block card says
what stops the block's keys and until when, omits "next" while nothing of it is due, and shows a partial pause as
partial (each button says how many keys it moves). "Sync now" is offered for a block with a poll the owner has not
paused; the requeue only for quarantined rows of the block, which it names; refused credentials point to the
credentials form. A toast is built from the lever's answer (`engineLeverNotice`): what moved, "nothing moved" when
nothing did, and a warning when nothing of the block will be sent anyway (no owner, a hold of every key). A page
without a running owner does not look live: its mode chip reads `live · нет владельца` in the warning colour. After a
lever the tab refreshes the engine's status and requests with the blocks.

Not for a Fansly page at all: the legacy monitor (`/api/v1/sync/status`, `pnpm cli sync status` — the rows are the
legacy executor's pages and streams, the events and `/api/v1/sync/requests` its journal as it stands; `sync page
status` and `/api/v1/sync/pages` are the engine's) and the agent dataset `sync_streams` (the legacy executor's stream
rows; the engine's state is `agentSyncStatus` / `agentSyncWhy`).

A quarantine records why in `sync_work.result.quarantine` (`{reason, detail, attemptId, at}`: an `ApplyQuarantine`
detail or a contract violation's field). `pnpm cli sync work list --page P [--state quarantined] [--resource R]`
shows it; `pnpm cli sync work requeue --page P --work <id> | --quarantined [--resource R]` takes rows out of
quarantine — a live row whose last attempt holds a captured answer goes back to `running` with that attempt
`deferred`, so the actor re-applies it from the journal before any new read (no request); other rows, and a row
whose captured body can no longer be read (`apply_error` `payload_unavailable:…`), open due now (audited
`admin.sync_work_requeue`). It never touches a row shadow mode left, and `--work` ids are all-or-nothing.
`pnpm cli sync work enqueue --page P --resource <key> [--subject S] [--params <json>]` files the owner's own demand
for a key with the `owner` trigger on a live page; `--subject` only for a key that runs per subject (audited
`admin.sync_work_enqueue`).

`requests/urgent.ts` is how the API and the CLIs ask the actor for a read instead of calling Fansly: `enqueueAndWait`
upserts the work of a registry key with the `api` trigger and waits up to 15–30 s for `applied_revision` to reach the
revision it raised (woken by `fansly_sync_work_done`, which `settleWork` sends for live rows, and re-reading every
250 ms), then answers `done`, or `queued` with the work's status link. A page that is not `live` answers `not_live`
before anything is written, so in step 2 every call does; its step-3 callers (`page verify`, credentials and proxy
changes, AI describe) fall back to the legacy path on it. A work carrying secret parameters (a candidate identity) is
created fresh or refused, never merged into another candidate's open row.

## WebSocket demand

The socket is the live signal of a page (plan §7). Since step 4 (S4-12) only a live page has one, in `sync` (below):
the legacy receiver of the worker process is gone. Each frame is captured (observation + pending receipt) and the
step-1 drivers apply the overlay and ack the receipt. The engine turns receipts into work with one decoder
(`fansly/ws/decode.ts`: the step-1 message decoder plus new chats, money, subscriptions and payouts) and one routing
table (`fansly/ws/router.ts`): on a `handover`/`live` page every driver passes the post-ack hook
`routeFanslyWsReceiptDemand` (`fansly/ws/route-receipt.ts`), which upserts the receipt's demand in the transaction
that acks it — once per receipt, whichever driver wins it (I18). On an `off` page, or one left in `shadow`, the hook
only reads the page's mode. (`sync_pages.ws_router_cursor`, the cursor of the shadow feed that read receipts without
acking them, is a column nothing reads or writes any more.)

Own mass broadcasts make no work (decision №9): they are `message.type = 2` with one shared correlation id (measured
on the production journal), and as a fallback more than 20 own messages in distinct chats within 60 s are a
broadcast. A deletion becomes `dm-live.deletions` (no request): a
`local` step (a write without a request, in one generation-fenced transaction under the erasure fence, taken before
the HTTP gate on the actor's next lap — no page hold or pacer slot delays it — and admitting nothing): the page's hot
rows of the message are marked (sticky), one deliverable `message.deleted` is appended and the archive tombstoned
from it (tombstone-first, sticky against a later REST copy: a message the archive does not hold yet gets a stub with
the chat, the side and the send time the socket showed and no text, which the later REST copy fills), and then the
stored window of every thread whose archive holds one of the messages is recounted from the archive by
`writeThreadSummaryAfterDeletion` — the head stays the conversation list's, the chain is untouched.
Since step 4 S4-11 this is the only path from a socket deletion to the stores: the legacy receipt reconcile is gone, and
the receipts it applied stay as records that the archive shadow rebuild re-applies.

**A live page's socket** lives in the `sync` process (`fansly/ws/source.ts`, one per live slot of the host; a page
that is not live has none). The source holds the page's socket lock `(58213, page)` on its own session for as long as
it runs, so no two sources ever both own a page's socket. It never
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

## The socket, the media downloads and the repair (step 3)

These four keys landed with the switch (as the identity check `account.identity` and the excluded-chat probe
`probe.excluded-chat`, below): they need a page the engine owns — which every page an actor runs is.

- `ws.connect` — the socket's HTTP Upgrade (wire `ws.upgrade`) as an admitted request: the page's socket owner
  (the slot's `FanslyWsSource`, seen by the actor and the transport as a `LivePageSocket`) asks for it at start and
  after every close, the actor admits it through the pacer — never before the owner's reconnect ladder allows
  (`connectNotBefore`) — and the transport sends it through the owner's handshake with the admission's check. A 401/403 at the handshake holds the page `auth`, a 429 (or a 5xx naming its `Retry-After`) holds only the Upgrade's route `ws.upgrade`; any
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
  signed URL's and closes the download (`subjectScopedAuthStatuses`), a 429 holds the `cdn.media` route. The bytes cross to
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
a declared 400/404/410/422, a `success: false` envelope, a refused body, and any other non-2xx that carries Fansly's own
error envelope (`isFanslyErrorEnvelope`: `success: false`, a numeric `error.code`, a non-empty `error.details` — e.g.
lilly-1's `500 error getting group messages`; the commit passes the outcome hook `OutcomeStep.fanslyErrorEnvelope`) is
the chat's answer: `served: false`, `not_served:<status>`, nothing held, no breaker. A 5xx without that envelope (a
proxy's HTML page, an empty 502/503/504) and a transport error are the wire's: the probe stays on the subject's ladder.
A 401 stays the page's (plan §9); a 429 holds the probe's route. Failures of `probe.excluded-chat` and `probe.manual`
never count toward the `probe` file's resource breaker (`RESOURCE_BREAKER_UNCOUNTED_KEYS`), so failing probes never
hold `probe.manual`; a hold already in force still stops both until it ends. The probes the old rule left open (a 500
with the envelope was a `subject_failure`) were closed by the migration `*_sync_excluded_probe_not_served.sql` from
their recorded answers, the attempt ids kept in the result.

`sync excluded report --page P [--reason R] [--record]` prints the newest probe's verdicts (served / not served /
pending) with the evidence ids; `--record` keeps the summary as `admin.sync_dm_exclusion_probe`. `sync excluded lift
--page P --reason R --evidence-page L` needs a live page and L's newest recorded probe of R with ≥ 10 probed chats,
≥ 80 % served and no page-level error (E2): in one transaction the reason joins `sync_pages.lifted_dm_exclusions`
(0235) and the page's bound threads lose it (audited `admin.sync_dm_exclusion_lift`). The engine's conversation list
then never assigns a lifted reason to a thread it leaves bound, so those chats sync like any other (new heads are
read; history only by request). An unbound thread keeps its reason. `sync excluded unlift --page P --reason R` takes
the reason off the page's list; the next list pass assigns it again. The lift is per page: a later page is lifted
after its own acceptance, naming the first page's recorded probe as evidence.

`partner_unresolvable_from_account_lookup` is retired (arena "vanished chat", R4): a lookup that resolves no partner
is the page's own evidence (the fan blocked the page, or a transient miss), so `fan-profiles.probe` excludes nothing
(no apply asks for it any more), the conversation list neither assigns nor keeps the reason (its next write of a
chat, a group detail's too, takes it off). `*_retire_dm_unresolvable_exclusion.sql`, in one transaction, takes the
erasure execution lock (an erasure locks a fan's threads only under it), locks every `sync_pages` row in page order
(each actor transaction starts with the generation fence on its page row, so an apply of the previous image — whose
`sync` runs on while the api migrates — never writes back a reason it read before), lifts the reason on every page
(that image's list keeps no lifted reason on a bound chat and its probe assigns none; this one reads the lift for
nothing), and locks the carrying threads in id order and takes the reason off them, without asking for any work. A chat Fansly stops
serving is the chat-unavailability episode's (next section). The owner's levers still accept the reason, for rows and
recorded probes written before.

## A chat Fansly stopped serving (arena "vanished chat", R2)

A chat whose every read Fansly answers `500 {"success":false,"error":{"code":500,"details":"error getting group
messages"}}` (lora-1, 04.10: the fan blocked the page) is not an excluded chat: the engine keeps reading what the
socket shows, but it keeps a **chat-unavailability episode** of the page × chat
(`page_dm_thread_unavailability`, 0251; `repositories/sync/chat-unavailability.ts`) — "Fansly does not serve this
chat's history to this page since T", with the attempt and observation ids that prove it and, apart, the owner's note.
The page's actor is its one writer:

- **Opened, counted** — in the capture transaction of a refusal (`ResourceModule.outcomeInCapture` of the three
  `dm-messages.*` keys, under a savepoint the commit opens): a `messages.page` read **without `before`** of
  `dm-messages.head`, `.catchup` or `.history` (all three read the head), class `subject_failure` or
  `envelope_unsuccessful`, **with Fansly's own error envelope** (`OutcomeStep.fanslyErrorEnvelope`). A proxy's HTML
  page, an empty 5xx, a 429, a 401/403 or a wire failure is the wire's, not the chat's: it neither opens an episode
  nor counts. `refusals` counts one per attempt since the last applied head read. The insert is a `… select … from
  page_dm_threads` fenced by the owner generation; a chat without a thread row gets none. The erasure fence is not
  taken (the episode has no fan identity; nothing here writes archive material): a thread an erasure deletes under
  the refusal makes the savepoint fail and the capture is kept without its episode.
- **Established** at the episode's own 5th refusal — never the work row's `blocked_by_vendor`, which counts the
  wire's answers too. It takes `retry_not_before` — the later of the refused attempt's breaker and the daily step
  (24 h), only ever later — and `handled_list_head_id`, the answered head: the newest of the chat's list head and the
  ids of the demand the read was **admitted** with (read under the admission's row lock — the pick's snapshot may be
  older) that was **created before the read was sent** (a message created during the flight is a new demand).
- **Only a work row settles itself.** A failed head read of an established chat settles its own work, in its
  capture transaction (lock order: the episode → the overlay rows → the work row → the history rows after the
  settle): the chat's unconfirmed socket messages are deferred `chat_unavailable` (still shown); a `.head` or
  `.catchup` work closes `chat_unavailable` with its demand unserved (`satisfiesRevision: false`, the breaker kept
  on the closed row) through `settleWork`'s compare-and-set on the revision it was admitted at — a demand that
  arrived during the flight keeps it open; a `.history` walk is never closed by its refused read: the history
  requests refuse its open fans that need the head (`CommitDeps.onChatUnavailable`; `refusal: excluded`,
  `excludedReason: chat_unavailable`), an anchored fan of a partial chain keeps reading below the chain under the
  key's own breaker, and the walk closes when no fan is left. No other row of the chat is touched by that capture:
  each `.head` / `.catchup` row decides in its own plan. A row whose next read is the head and whose demand the
  episode answered (`demandAnswered`: every id at or below `handled_list_head_id`, no overflow, and every reason one
  that names its messages by id — `ws:message_created`, `ws:message_created:own`, `list_head:*`,
  `takeover_unconfirmed`; a broken frame's `ws:message_invalid_known_chat` names none, so it is never answered)
  closes itself without a request — a `local` step, re-judged under the commit's transaction and settled
  at the revision its plan read, deferring the socket messages too; a row with a newer demand waits for
  `retry_not_before` (the plan's `not_due`, no second timer) and then reads once. A row that continues a staged walk
  below its head read (`before`) finishes it under its own breaker. A `.history` walk whose next read is the head of
  an established chat never reads it either: its own `local` step has the history requests refuse its fans that need
  the head (`ApplyResult.chatUnavailable` → `CommitDeps.onChatUnavailable`, after the settle), the walk closes when no
  fan is left, and a fan anchored below the chain keeps reading `before` — so a request filed before the episode was
  established (by the migration, say) costs no read. So no demand that lands during a read is lost, by construction.
- **No background read** (owner decision Р5): one demand is one read. Any head read of an established chat that
  went out and does not end the episode — a refusal, a timeout, the wire, a 5xx without the envelope, a 429 or a 401
  that reached the send — moves the boundary by the same rule and the answered head (`postponeChatUnavailabilityRetry`
  for the ones that are not Fansly's refusal: no refusal counted, the page's and the route's holds as ever) and
  settles its own work as above. A request that never left (a proxy tunnel that never came up: `sent: false`) is no
  read and touches nothing. Nothing reads the chat again without a new message or a new list head (a list head the
  episode answered opens no work). A silent established chat costs no request.
- **Ended** by an applied head read of the chat by any of the three keys (`read_served`, in the DM apply, which
  holds the erasure fence; the read confirms what it shows), or when the chat is excluded or unbound since
  (`thread_excluded` / `thread_unbound`: the plan asks for a `local` step that ends the episode and closes the work;
  the apply of a read that finds it so ends it too). A deeper page's read (`before`) neither counts nor ends it.

The history intake decides by the episode, never by the latest work of a DM read (a deeper page's refusal says
nothing of the head a new fan needs first): a chat with an established episode is refused at intake (`excluded`,
`chat_unavailable`); any other chat is queued. The intake reads the episodes again in its transaction, `for share`
after the threads and before any work row (`lockOpenChatUnavailability`): an establishment in flight is waited for
and its fans are refused with no work; one that comes after the intake finds the fans it filed. The passive parity pass defers a message the 24-hour window passed
`chat_unavailable` while its chat has an open episode (`openChatUnavailabilitySql`), else `age_without_rest`.
The episodes are erased with their threads (the foreign key cascades): a fan or page erasure needs no target of its
own.

What reads the episode beside the actor (R2 PR5; plan §4) — one module of predicates in
`repositories/sync/observability.ts` and `chat-unavailability.ts`, shared by the online alert and `sync check
live-hour`:

- **Alert 3** `message_unconfirmed` counts a socket message only by `dmLiveUnconfirmedSql`: still awaited
  (`dmLiveAwaitingConfirmSql`), of a chat the page has a thread for (`dmLiveChatKnownSql`), with no open episode,
  refusing or established (`dmLiveChatUnavailableSql`). A message of a chat with no thread is counted apart
  (`SyncLivePathFacts.unconfirmedWithoutThread`, shown by `sync alerts status`), never paged: a broken find pages
  through its quarantine or its wait. `chats_refused` (alert 3, `readSyncChatAlertFacts`) opens when 5 or more chats
  of the page opened an episode within 10 minutes — the resource hold's threshold (`RESOURCE_BREAKER_SUBJECTS`,
  `RESOURCE_BREAKER_WINDOW_MS`): `dm-messages.head` is out of the resource hold, so a lone chat never pages and Fansly
  refusing the page's chats still does. `sync check live-hour` takes `dmLiveUnconfirmedSql` for
  `unconfirmed_over_15m` and the confirmation SLO (a message with no thread shown as `withoutThread`), and does not
  count a chat with an open episode among `fanThreadsBehind`.
- **The counts**: a `dm-messages.*` work row of a chat with an established episode is the chat's, not the vendor's
  block (`syncWorkOfUnavailableChatSql`) — a new row inherits the closed one's `blocked_by_vendor_at`, and it must not
  make the page need attention again. `countActiveLiveWorkByResource` (the page summary, the Settings blocks),
  `buildPageStatus` (`sync page status`) and `readSyncJournalMetrics` (`sync_blocked_by_vendor`) leave it out, and
  count the established chats instead (`countUnavailableChats`): the summary's `Chats Fansly does not serve: N`, the
  `messages_history` block's `engine.chatsUnavailable` (the «Синк» tab), `PageStatus.chatsUnavailable` (owner CLI
  only: the agent wire is strict) and the gauge `sync_chats_unavailable`. `/health/sync` does not reflect them.
- **The owner's CLI** (`sync/chats.ts`, `cli/chats.ts`): `sync chats unavailable --page P [--ended] [--json]` lists
  the episodes with their evidence, read-only; `sync chats note --page P --chat G --note … [--at]` writes the
  episode's `owner_note` / `owner_note_at` only (nothing the actor writes, not even `updated_at`) and an audit row in
  the same transaction. Neither sends a request to Fansly.
- **The agent plane** (R3 PR7; plan §5): the agent answers are strict and a released `hub` validates every one, so
  no existing answer carries the episode. Its own read-only route does — `agentThreadAvailability`
  (`GET /api/v1/agent/pages/:pageLabel/threads/:conversationRef/availability`,
  `modules/agent-read/handlers-thread-availability.ts`, `hub thread-availability`; `read:messages`): the chat's open
  episode (`readOpenChatUnavailability`) without its evidence ids, with the cause the partner's public account check
  gives (below: found → `probably_blocked`, not found → `probably_deleted`, none → `unchecked`), or null — no open
  episode recorded, never proof that Fansly serves the chat. A page outside the
  grant or a ref the page holds no thread for is the plane's static 404; on a hub without the route `hub` says the
  state is unknown.

## The public account reader (arena "vanished chat" R5)

`fansly/public-lookup.ts`: one reader per host, in this process beside the actors and never one of them. It asks
Fansly whether a fan's account exists **without any session** — `GET /account?ids=` built by the session-less builder
(`buildFanslyPublicWireRequest`, a `credentials: none` spec; a session-bearing spec is refused before anything is
built) and sent through its own egress (`fansly_public`: its own proxy, never a page's, Fansly's API host only). A fan
who blocked a page is still returned; a deleted account is not.

- **When**: the owner's live switch `fanslyPublicLookupEnabled` (off by default) and its proxy (`sync public-lookup
  proxy set`); one pass at a time across processes (session advisory lock `(58216, 1)` on a connection of its own),
  one request a pass; at least S × (1 + u) after its own previous completion (S the owner's Fansly pause, u ∈ [0, 0.2)
  drawn after each send), at most 1 request a minute and 50 in 24 hours, counted from its own `fansly_send_log` rows
  (`page_id` null, source `public_lookup`) at each request's SEND instant (`sent_at`; an attempt never marked sent at
  its completion, one with neither at capture + its budget — never at the earlier journal instant). No page's
  budget, clock or hold is touched.
- **Admission and the lock**: the lock's connection is watched (`error`, `end`); the checks that admit a request
  (the lock still held per `pg_locks`, not stopped, no attempt pending, the budget and the pace) and the write that
  admits it (the `fansly_send_log` row and `fansly_public_lookup_state.pending_token`) are one transaction on that
  connection, so a lost lock fails the admission; once the connection is gone the send check refuses and the send's
  signal aborts — nothing goes out.
- **Settlement**: an admitted attempt stays pending until the transaction that writes its result — the applied
  answer, or the stop — clears it (only if it is still the pending one). While one is pending no reader sends: every
  pass first settles it from its journals alone (the raw answer, else the send-log row), without a request — after a
  failed write, a restart or a lost lock alike. One with no recorded outcome past its bound may have been sent: the
  reader stops (`indeterminate`) instead of sending again. The outcome — the answer applied, or the stop and its
  incident — is written before the transport is cleaned up, and that cleanup is bounded (a proxy that never answered
  CONNECT keeps undici's close waiting for minutes; the public egress destroys its dispatcher after 2 s, the pass
  waits 5 s at most). An answer is dated when it arrived (its journal instant), however late it is applied: it is
  never fresher than it is, closes only the owner's requests queued before it, and never replaces a newer check.
- **Whom** (`pickFanslyPublicLookupBatch`): the owner's queue first (`sync public-lookup recheck-marks`, owner decision
  Р2 (а): the fans carrying the legacy deleted mark), then the partners of established unavailability episodes, then
  the fans a page's lookup missed (`page_fans.account_probe_resolved = false`) — those two only when never checked or
  checked over 7 days ago. One id once however many pages and reasons name it, up to `fanslyPublicLookupBatchSize`
  (≤ 100) ids a request.
- **Journal before parse**: the `fansly_send_log` row before the send, completed after it; the raw answer committed
  to `observations` (`account_id` null, kind `account_lookup_public` — `:failed` for a body that is not a successful
  envelope; every asked id in `requestedIds`: the fan erasure's page-less contract, `PAGELESS_FAN_OBSERVATION_KINDS`)
  before the contract reads it. Then every asked fan gets `fans.public_checked_at` / `public_found`; a found account
  loses the legacy deleted mark; a missing one keeps it, and the reader never sets one.
- **Stop**: the first 429, 401/403, network failure (sent or not), answer off the contract (another status, a body
  without a successful envelope, an account without an id or one not asked for) or attempt of unknown outcome stops
  it: the state row keeps the reason and a Retry-After (`fansly_public_lookup_state`), the owner gets a global
  incident (`fansly_sync_engine` / `public_lookup`; on the very first batch it says so) — retried on every pass until
  its open is confirmed (`stop_incident_at`) — no fan changes, no session or other egress is tried. Only `sync
  public-lookup resume` resumes it, and a Retry-After still ahead is waited for.
- **Cause**: the chatters' `chatAccess.cause` and `agentThreadAvailability.cause` read the partner's check
  (`readChatPartnerPublicChecks`): found → `probably_blocked`, not found → `probably_deleted`, none → `unchecked`.

## Ownership

A page has one owner generation at a time (`sync_pages.owner_generation`, fenced in every write) and its owner holds
the session advisory lock `(58215, pageId)` on the host's one lock session. A new owner starts only when the previous
one is **confirmed stopped**: never owned; its own safe release (`owner_released_at` of its generation — written after
SIGTERM, a mode change or the loss of its lock session, once nothing is in flight); the step-1 OS proof
(`judgeFanslySendHolderTermination`: pid gone, pid reused, boot changed, or this container under a new pid namespace);
or a Docker-level confirmation (`pnpm cli sync ownership confirm-stopped --running-hosts …`, run by the deploy). A lost
lock session alone is never a confirmation. The first send after a takeover waits `1.2 × S` after every send the
database knows of (I5). A `live` page is acquired only with its import mark (`legacy_imported_at`: stamped at a
page's birth, and by the step-3 switch for the pages it took over); without it the page waits
(`legacy_not_imported`, alert after 2 min) and nothing is sent.
`sync page mode` only takes a page left in `shadow` to `off`.

Credentials (step 3; step 3b ruling 5, A3): every live API request carries the digest of the stored session and
proxy (`credentialsGeneration`, journaled with the attempt). Unless it is the digest the engine trusts
(`sync_pages.credentials_generation`) only the identity checks go out (`account.verify`, `account.identity`) and the
actor raises one verify — checks-only is read from the database at every pick, never kept in memory. What a page hold
is, what it admits and what clears it is ONE pure core, `@agency_hub_core/shared` `fansly-page-holds.ts`, over the
page-scope rows of the page's hold set (below); the hold evaluator composes it with the route and resource holds for
the actor's gate and pick, the final check inside the admission transaction (SQL only locks the rows and writes what
the core decided), status/why and the alerts. A credentials hold (`auth`,
`identity_mismatch`) records its LATEST refusal in its row's `detail` (`failedAttemptId`, `failedAt`, the refused
digest; `since` stays the episode's start) and is in force until the apply of an identity proof — an applied
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
(`page_candidate` scope); the check of a session that belongs to no page yet rides `fansly_candidate`
(`fansly/identity-without-page.ts`). The socket's Upgrade (`ws.connect`) is checked like an API request, and the
socket opens only with the digest its admission checked. A credentials hold and a network hold can both be in force,
each a row of its own: a candidate check's network failures under a credentials hold take the page's network hold
beside it (its 429 holds only its route) — the credentials hold is never replaced or lifted by it. Nothing goes out,
not even a candidate check, before the network hold ends; the proof lifts only the credentials hold. The egress
follows the digest (a changed proxy is resolved again before the next request).

## The hold set and the hold evaluator (step 4, owner decision №26)

What holds a page, a route of it or a resource file is a row of `sync_holds` (0240), one row per hold:

| scope, key | kind | what it stops, until |
|---|---|---|
| `page`, `''` | `auth` / `identity_mismatch` | every request but the identity checks the credentials hold admits; `until` = `infinity` (an identity proof sent after its latest refusal clears it). One a page: a refusal of the other kind replaces the row and keeps the episode's start |
| `page`, `''` | `network` | every request, until its end; a row of its own beside a credentials hold |
| `route`, the route id | `route_hold` | sends on that route until `until` (a 429's hold, a 5xx's `Retry-After`) |
| `route`, the route id | `route_budget` | nothing by itself: the route's durable state — the ladder step of its next 429 (`ladder_step`), its slowdown and newest 429 (`detail`), the revision a raise compares against (`revision`); no end |
| `resource`, the file | `resource_breaker` | every key of the file but the exempt one (`dm-messages.head`), until its end, on ladder step `ladder_step` |

The page row hands a page's rows out with every read (`SyncPageRow.holds`), and ONE function answers "what holds this
request now?": `engine/admission.ts` `whyHeld(holds, routes, query, now)` (and `heldByScope`, the same answer scope by
scope) — the page (rows this build cannot read, the network hold, the credentials hold with the exceptions of A3), then
the subject's breaker, the file's breaker, the route (`route_hold` when a 429 holds one of the routes that keep the
request closed, `route_budget` when only their budgets' intervals do). It composes the page-hold core, `activeResourceHold`
and the route admission (`routeAdmissionView` over the route clocks) and re-states none of them. The actor's gate, its
pick and its final check, the admission transaction, `explainWork` and the page status, the alerts, the history
requests' view, the Settings blocks and the metrics ask it; none of them reads a hold row or a hold column itself.
A row of a scope or kind this build does not know (a later build's, after a rollback) keeps the page closed until its
end — for good when it names none — and route rows of a known route it cannot parse close it with no end: `page_hold`
with `detail.holdSet` in "why", alert 1 (`hold_set_unreadable`, `route_state_unreadable`), metric
`sync_route_state_unreadable`.

Writers: the four hold writers of `repositories/sync/pages.ts` — `setPageHold`, `clearPageHold`, `setResourceHold`,
`writeSyncRouteState` (a compare-and-set on the route's `route_budget` revision) — each in one transaction that takes
the page row FOR NO KEY UPDATE (the lock of every actor transaction) and fences the generation.

**The page row holds nothing, and it has no hold column** (step 4, S4-33, the last of the three releases below). The
hold writers write the rows and lock the page row without writing it, and no statement of this build names the old
hold columns of `sync_pages`: the hold slot of 0228 (its kind, end, start and detail) and the resource-hold map beside
it, where the route state lived too. `tests/sync-old-hold-columns.test.ts` pins it over `apps`, `packages` and
`scripts`: the one line there that names any of them is the deploy's search for them in the running images (below).
`0245_sync_pages_drop_old_hold_columns.sql` dropped those five columns and the slot's two CHECKs: one catalog-only
`ALTER TABLE`, its lock wait bounded to 5 s. **Read a page's holds from `sync_holds` or `sync page status`**: a query
that selects one of the old columns fails. The page row keeps its counter of consecutive network failures, which is no
hold.

**Rollback targets from this release on.**

- **The release before this one** (S4-32) is a safe rollback target, and the only one. No statement of it reads the
  dropped columns, its drizzle table does not map them, and it reads and writes the page row by named columns, never
  by `*`. It writes one of them, in one statement: whenever it acquires a page it leaves a marker in the resource-hold
  map (a route-state version the hold-set release cannot read, so that release refuses the page rather than open it
  by stale columns). That statement is made on its own inside the acquisition and goes on where the column is gone:
  the page is taken all the same, and there is nothing left to mark. So the migration is in
  `ROLLBACK_COMPATIBLE_MIGRATIONS`. `tests/sync-hold-set.integration.test.ts` runs that acquisition as that image
  makes it, every statement that writes a page row, the hold writes and the readers on a Postgres whose pages went
  through the drop with holds in the old columns.
- **Every image older than that is NOT a rollback target any more.** S4-31 ends every hold write by rewriting the
  dropped columns from the rows, in the write's transaction: each hold write fails there, so a page can neither take
  a hold nor lift one, **and it keeps sending meanwhile** (the actor's commit fails, the host restarts it, and a 200
  needs no hold, so every health gate stays green). The hold-set release (S4-30, the one that brought `sync_holds`)
  selects them whenever it acquires a page, and an older image knows a page's holds from them alone: neither runs at
  all.
- So this release is deployed onto the previous one, once that one has been deployed and has run its hour, **never in
  the deploy that brings S4-32, and never over an older image** (after a rollback to S4-31, say). S4-32 has no
  migration of its own, so `ROLLBACK_COMPATIBLE_MIGRATIONS` cannot tell those deploys apart: with the drop its only
  pending migration the automatic rollback would be armed and would return to S4-31, and the S4-31 `sync`, which
  keeps working while the new api applies the migration, would be on the migrated table at once. **The deploy checks
  it itself.** While the drop is still to be applied, `verify_running_images_run_without_old_hold_columns`
  (`scripts/deploy-production.sh`) searches the built code of the image of every running `api`, `worker`, `scheduler`
  and `sync` container for the columns of the hold slot, and stops, before anything is quiesced or migrated, if one
  names them or cannot be searched (`tests/deploy-old-hold-columns-gate.test.ts`). The way past a refusal is to
  deploy S4-32 first, from a checkout of its commit, and to let it run its hour.
- `0240_sync_holds.sql` and `0243_sync_pages_drop_hold_step.sql` stay out of `ROLLBACK_COMPATIBLE_MIGRATIONS`, which
  keeps the automatic rollback off in a deploy that still has one of them to apply (the image such a deploy would
  roll back to reads the columns).

**A hold changed by hand is changed in the rows**, and only there.

**The columns went in three releases, each a safe rollback target of the next.**

1. S4-31: the two read-backs went (`acquireSyncPageOwnership`, a hold write under no generation); the hold writers
   still rewrote the columns from the rows, so a rollback to the hold-set release found the two sides equal. The
   ladder-step column of the slot, which that release neither read nor wrote, was dropped (0243).
2. S4-32: the rewrite, the repository file that held it and the drizzle fields of the columns went; the one write
   left was the marker of an acquisition. A rollback to (1) read no old column. The columns were stale from that
   deploy on.
3. This release drops the five columns and the two CHECKs, and has no marker to leave. A rollback to (2) reads none
   of them, and its acquisition goes on without its marker. Read-only SQL kept outside the repository (the
   post-deploy check, the production watch) reads `sync_holds`: a query of the old columns read history since (2),
   and fails from here on.

## The process: pool timeouts, stall watchdog, shutdown (step 4, 4-3)

The `sync` process's pool runs with `SYNC_POOL_TIMEOUTS` (`context.ts`): a checkout waits at most 30 s, a statement
runs at most 60 s, a lock wait 30 s, an idle transaction 60 s; the boot log line `Sync pool timeouts in force` shows
what Postgres reports. A hung database call is therefore an error the engine handles: a lap that failed before an
admission backs off 1 s; a commit after a send is retried 3 times, then the actor fails and the host restarts it 5 s
later. The CLI's contexts run without them; the lock session and the LISTEN client keep their own 5 s bounds.

What is left is a promise that never settles. The stall watchdog (`engine/watchdog.ts`, a look every 5 s) watches
every actor (each phase of a lap, its recovery, its commit retries, its exit), the host's start and every pass of its
mode loop, every heartbeat beat and every alert pass. One that has not moved for 120 s — the longest legitimate phase
is ≈ 72 s: a slot wait of 1.2 × S at the largest S, a 20 s request, a 60 s statement — ends the process: one JSON
line on stderr (`component`, `pageId`, `generation`, `phase`, `ageMs`), a best-effort `process` incident (`stalled`,
alert 5's latch) through a client of its own within 2 s, then `process.exit(70)`. Never a SIGKILL to itself (node is
PID 1 in its container, where that is a no-op) and never a graceful stop. A beat or a pass that fails (the database
down) is not a stall. Docker restarts the container (`restart: unless-stopped`, no `init:`), and nothing changes in
ownership: the locks go with the process and no safe release is written; the restarted container takes its pages
back by `pid_namespace_replaced`, its first send waits ≥ 1.2 × S after every send the database knows (I5), the
attempt left in flight is closed `unknown`, and the socket's repair reads from 60 s before its gap. A block of the
event loop itself is not covered.

The watchdog stops when `runtime.stop()` begins. SIGTERM ends the process 40 s after the signal at the latest
(`SYNC_SHUTDOWN_CAP_MS`, inside the 45 s stop grace); a page whose release did not finish by then waits for the OS
proof of the next start.

## Legacy fences

The legacy page-sync executor (`services/sync/`) serves the platforms whose adapter declares a stream — OnlyFans — and
nothing else (I21). Through step 3 a predicate over `sync_pages` kept it off a page in `handover` or `live`; since step
4 S4-21 that predicate is gone and two things hold it off a Fansly page, each alone:

- **the platform set.** `legacyExecutorPlatforms()` (`onlyfans/boundary.ts`) is a required argument of every query that
  picks work — `listRunnablePageSync`, `markPageSyncEnqueued`, `acquirePageSyncLease` (`PageSyncPlatformScope`; an
  empty set matches nothing) — and the planner and the executor assert it on what those return before they wake or run
  a page. A pending Fansly row with no blocker is neither listed, marked nor leased;
- **the parked rows.** Migration 0239 made every Fansly `page_sync_states` row `paused` with the `retired` blocker
  (code `fansly_sync_engine_owned`). No image clears that blocker: the runnable listing and the lease need a row that is
  not paused and has no blocker, a resume skips the kind, a reset keeps it paused, a request leaves a paused row paused.

A Fansly page's engine mode is no part of this: no mode change gives a page back to the legacy engine. The step-1
guard row (`owner_engine`, 0229) stays the catch-all at the wire — every Fansly page's row is the engine's, and nothing
flips a row (the switch's hand-over and the rollback's hand-back are deleted). The lease by stream name
(`acquireTargetedPageSyncLease`) went with its last caller, and so did the ops watchdog's legacy sync deadman (E-2: no
Fansly chunk started while a stream is due — its subject is gone, and its 15-minute bound was Fansly's; the legacy
executor has no deadman of its own).

What else stands between the legacy code and a Fansly page: the AI describer downloads nothing itself (a `live` page's
CDN hops are its actor's `media-download.fetch`) and wakes no DM stream; since step 4 S4-20 its page-egress download
sends no Fansly request for any page (a Fansly CDN host there answers `send_guard`, nothing sent, and the row looks
again later). The ws-hints projector and its minutely deletion reconcile are gone since step 4 S4-11 (after the A5 drain
check over the captured frames): a socket deletion reaches the stores only through `dm-live.deletions`, and the receipts
the projector filed stay as records. The probes and the alias backfill are deleted (S4-20). The owner's `/account/me`
levers (page verify, credentials, proxy) on a `live` page go through the engine (`services/sync-engine-account.ts`:
`account.verify` / `account.identity`, ≤ 30 s, else 409 `fansly_sync_work_queued` with the work's status link). Since
step 4 S4-19 they have no legacy path: on a Fansly page the engine does not run (`off`, `shadow` or no engine row) they
answer 409 `legacy_sync_retired` before anything is resolved, sent or stored, and a verified change resolves the page's
verification incidents without touching its legacy rows. Hydration rows the engine serves (`execution_lane =
'fansly_sync_engine'`) are never expired, reconciled or swept by the legacy cycle. Since step 4 S4-15 that cycle has no
Fansly lane at all (the targeted thread backfill with its owner CLI, the auto-approve policy and the projection-debt
sweep are deleted): its dispatcher's lane table serves OnlyFans approvals only, a Fansly approval is refused at the
decision, and old Fansly history is read only through history requests. Since S4-12 the legacy WS receiver, the AI
media fast lane, the WS policy repair (`fansly:ws-policy`) and the W0 operator scripts are deleted, so no legacy
component opens a Fansly socket on any page.

`handover` is a mode nothing reaches since S4-21 (no lever, I17). The CHECK still admits the value, and a row that says
it is still read as "neither engine sends": the host runs no actor for it and keeps the page's lock, the levers and the
hydration route answer 409 `fansly_page_switching`, alert 1 reports `handover_stuck` after 10 min.

A legacy stream's incident (`stream_failed_threshold:<page>:<stream>`) resolves only through the legacy executor's own
chunk recovery, which never comes on an engine page. Every live takeover of the host closes the page's open ones
(`resolveLegacyStreamIncidentsOfEnginePage`, `services/notification-incidents.ts`): the ordinary resolve with its
recovery tombstone, `metadata.resolution = 'engine_owned'`, and the paging sweep's resolve message naming that reason;
idempotent, so a page switched before it has its own closed on its next takeover. Only a `live` page. While the engine
owns the page a legacy chunk failure opens no legacy incident. The engine's own incidents (`fansly_sync_engine`) and
OnlyFans pages are not touched.

## The live-hour check (`sync check live-hour`)

`pnpm cli sync check live-hour --page P [--page Q …] --since <iso>` judges the first hour of pages on the engine (step
3b ruling 13, A6; `checks/live-hour.ts`, read-only). It was the acceptance of the step-3 switch (`sync switch check`)
and judges an onboarded page the same way: each page over [T_i, T* + 1 h), T_i = the later of `--since` and its live
instant, T* = the last one. The rules (`checks/live-hour-rules.ts`): the send audit's pace over both journals — the
combined pace audit — (every pair of adjacent sends ≥ the later one's own pause), the takeover boundary (the engine's
first send ≥ 1.2 × S after the guard row's last completion, no legacy capture after the row became the engine's), the
send audit's route budgets (every pair of adjacent sends of a route and of a family ≥ the interval the later one was
admitted under, no recorded interval below its ceiling's; Alerts, below) and, after a 429 of a page+route, every later
admission on it recording at least the slowed interval (A2 on the recorded numbers: twice the interval the 429'd
attempt recorded, never beyond ⅛ of the ceiling's rate — a route that kept its full rate fails, and so does a `sync
route raise` inside the hour), per (page, canonical route) at most one 429 with its hold kept and its recovery seen, no
401/403 and no page hold (from the journal, the page row, or an alert 1 `page_stopped` episode seen in the window,
resolved ones included — a 429 that held the whole page shows there after its hold is cleared), the first media request
≤ 60 s after live, nothing stuck, the SLOs over the whole window (route holds and the unfinished tail included; fewer
than 10 samples: count and max), no open incident but a route's own (D5 `route_limited:<route>`, told by its key
whatever its code). A page is `fail`, `inconclusive` (the window still open, a 429's recovery unproven, a small sample,
a pair the send audit could not judge), `owner_review` (429s on two or more routes), `accepted_with_route_429` or
`pass`; exit 0 every page accepted, 1 a page failed, 2 otherwise. The report is JSON on stdout (`--out` keeps a copy):
the runbook reads it there. Its fixtures: tests/sync-live-hour.integration.test.ts.

The switch itself is history. Step 3 took the six pages over with `sync switch` (handover, guard hand-over, legacy stop
confirmed, final chain rebuild, legacy import, live) and could give one back with its rollback until step 4 S4-10; both
are deleted with their audit trail's writers (the `admin.sync_switch*` rows stay as records). What they left on a page —
the import mark, imported cursors, `legacy_import` breaker carriers, converted hydration requests — is ordinary engine
state.

## DM readers on the archive (step 4, owner decision №11)

The DM readers serve a page from the store its sync mode names (`dmReaderStoreOf` / `readDmReaderStore` in
`repositories/sync/live-messages.ts`): `message_archive` on a page the engine runs `live`, `page_dm_messages` on every
other page (OnlyFans writes it; a Fansly page off the engine is legacy's). It is the page's data, never a platform
branch. On a live page:
- the chat messages and the preview (`services/conversations.ts`) read the archive, the live overlay dedups against
  it, tips go mills→cents through the shared codec;
- the agent transcript drops its `page_dm_messages` arm (`hotArm: false`): PPV state is `message_archive.is_opened`,
  and the response reports `page_dm_messages` as not queried;
- the engine's own reads use the archive: the fold's stored facts (`readThreadStoredFacts`), `sync chain
  check-end-rule` (`countStoredMessagesOlderThan`), `sync chain check-window` (`getPageDmMessageWindowSummary`), the
  ETA backtest, and the `dm-live.deletions` overflow picker;
- the DM apply confirms the overlay against the archive rows it just fed (`confirm_source = 'message_archive'`): it
  locks the overlay rows before its event appends (`claimDmLiveMessagesForConfirm`, lock order) and judges them after
  the archive feed (`confirmDmLiveMessagesInTransaction`); the passive pass judges a live page's rows by the archive
  too. The DM apply is the one writer of `not_found` (a read covered the message's place without it). A row the
  passive pass's 24-hour window passes without a copy gets no verdict: it is deferred (`confirm_wait_reason =
  'age_without_rest'`, `confirm_due_at` null), stays visible and is no longer awaited — alert 3 and `sync check
  live-hour` share that predicate (`dmLiveAwaitingConfirmSql`, `repositories/sync/observability.ts`, narrowed by
  `dmLiveUnconfirmedSql` to the chats that page) — and a later
  read still claims it by `confirmed_at is null`, settles it and clears the reason. A chat Fansly stopped serving to
  the page keeps its socket messages so: while its chat-unavailability episode is open the window defers them
  `chat_unavailable`, and an established episode defers them at once (above). The image before the column leaves a deferred row alone (no next look, no
  alert, shown) but closes new rows `not_found` on its timer while it runs (docs/runbooks/sync.md);
- the thread summary columns (`stored_message_count`, newest/oldest stored ids, last fan/model times) count the
  thread's archive messages [E4]: `writeThreadSummary` adds the messages the apply's archive feed stored (the thread
  is locked and the archive's copies of the page noted before the feed, `openThreadSummary`), and
  `writeThreadSummaryAfterDeletion` recounts the thread from the archive after a socket deletion's tombstones.
  Migration 0236 recomputed the count and the newest/oldest ids from the archive once, on the live pages. Their
  readers (coverage, Top Supporters, agent datasets, ETA, chain checks) did not change.

**The hot table is frozen for Fansly (step 4 S4-13, I23).** The engine's DM apply writes no `page_dm_messages` row:
the messages a read shows reach the readers through `message_archive` only. The rows legacy stored before a page went
live stay as they were, and `dm-live.deletions` keeps marking them (`markFanslyWsHotDeletion`, sticky), so the frozen
snapshot never shows a deleted message as live. OnlyFans keeps writing the table (`services/ofapi-dm-projection.ts`,
the OnlyFans PPV backfill). `tests/page-dm-messages-boundary.test.ts` pins every file that names the table, every
write statement on it and every caller of its writers; inside `sync/` the deletion mark is the only one. A revert of
S4-13 brings the inserts back; the gap since is not refilled, and a live page's readers read the archive anyway.

**Parity.** `pnpm cli sync dm-reader-parity --window 1h --rounds 12 --interval 5m [--page P] [--full] --out <json>`
compares the two stores reader by reader, read-only (every statement in a READ ONLY transaction, each thread in one
repeatable-read snapshot; it runs in the worker container on the app connection, which can read these tables). It
calls the real readers both ways (their `page_dm_messages` default and the archive variant, whatever the page's
mode): the chat messages (25 and 100) and the preview with the live overlay, the page's coverage, the agent
transcript with and without its hot arm, the summary columns against the archive, the fold's stored facts and the
window summary. Each round samples per page the threads active since
the last round, 50 stratified by stored count, the threads with a pending overlay row and those whose live rows
differ between the stores; the threads with a deletion, tip, PPV, reply ref or exclusion are spread over the rounds
(each checked once). Classes (`parity/classify.ts`): `missing_in_archive` fails only when a recheck of both stores
≥ 2 min later still finds it missing, `field_mismatch` fails, `extra_in_archive` (the archive knows more: the
September sidecar rows, a deletion first) and `tie_order` are reported. `--full` also judges every Fansly hot row
against its archive row. The JSON report goes to `--out`; stdout carries the verdict and the archive-only list for
the owner; exit 1 on a fail. It ran for an hour before the readers moved (S4-08) and again before the Fansly hot
writes stopped (S4-13); since then every message newer than the freeze is `extra_in_archive`.

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
| I9 | The chain columns of a thread have one writer (`writeThreadChain`); the legacy coverage columns are written by the engine only on pages in `handover`/`live` (`writeThreadSummary`, `writeThreadSummaryAfterDeletion`), from `message_archive`. | `repositories/sync/thread-chain.ts` |
| I10 | `history_complete` only by an accepted empty page at `before = contiguous_oldest_id`; a short page is not the end; overlap is not proof. | `fansly/lib/chain.ts` |
| I11 | A new event during a read raises `demand_revision`; an older answer never closes newer demand. | `engine/commit.ts` |
| I12 | No history walk without a request. | `fansly/registry.ts` (`dm-messages.history` triggers only on a request) |
| I13 | A Fansly HTTP request leaves the process only through the wire layer's single-request send, under the caller's send check; its callers are the page transport in `sync/` (the pacer's admission), the identity check of a session without a page (journaled, owner decision №4) and — the third — the session-less public account reader (arena "vanished chat" R5, `fansly/public-lookup.ts`): a `credentials: none` spec built by `buildFanslyPublicWireRequest` alone (no session, no cookie; a session-bearing spec is refused before anything is built, and the page's builder refuses a session-less one), sent only through the `fansly_public` egress — its own proxy, never a page's, Fansly's API host only — journaled in `fansly_send_log` with `page_id` null, source `public_lookup`. The legacy adapter and every legacy sender are deleted (step 4 S4-20); nothing in the runtime captures a page's legacy guard. | `packages/fansly/src/wire/send.ts` + `fansly/transport.ts` + `fansly/identity-without-page.ts` + `fansly/public-lookup.ts` + `packages/fansly/src/wire/public.ts` + `services/egress/fansly-public.ts`; lint rule (no undici HTTP import in `packages/fansly`) + tests/fansly-send-guard-boundary.test.ts, tests/fansly-public-wire.test.ts |
| I14 | Shadow mode is gone (step 4 S4-23): an actor runs a `live` page only, nothing writes a row with `shadow = true` or the outcome `shadow`, and no reader of a page's queue or journal sees the rows it left. (Until S4-23: shadow never sent and never wrote observations, domain tables, receipts or the overlay.) | `engine/host.ts` (`#runs`) + `engine/actor.ts` (`#ownershipExit`) + `repositories/sync/work.ts`, `attempts.ts` (`not shadow`); tests/sync-registry-coverage.test.ts, tests/sync-engine-core.integration.test.ts |
| I15 | The erasure fence is taken in every apply that writes fan material. | `engine/commit.ts` |
| I16 | The command outbox semantics are untouched (Fansly has no sends). | — |
| I17 | No live sender by accident: `LIVE_LOOP_ENABLED`, mode `live` (a page is born live by onboarding's `createLiveSyncPage`, refused for any page with a legacy footprint; no lever moves an existing page to `shadow`, `handover` or `live`, or out of `handover`/`live` — `setSyncPageMode` knows `shadow → off` alone since step 4 S4-23), the guard row owned by the engine, and the import mark (stamped at birth) — independent gates. | `engine/host.ts` + `lockOwnedPage` + `repositories/sync/pages.ts` (`setSyncPageMode`, `createLiveSyncPage`); tests/sync-engine-repositories.test.ts |
| I18 | Every WS receipt of a `handover`/`live` page routes its demand exactly once, in the transaction that acks it. | `fansly/ws/route-receipt.ts` |
| I19 | Between two actual sends of one page on one route (or one family): ≥ the interval of its effective rate, counted from the actual send in the journal the page runs (the legacy send log too on a live page; an unknown outcome at its upper bound); no burst, no borrowing. | `engine/route-policy.ts` (`RouteClocks`) + `engine/actor.ts` (pick exclusion, final check) |
| I20 | One page-hold rule: a credentials hold clears only by an identity proof sent after its latest refusal, written with the apply; under it only a candidate check and one verify per changed stored digest pass (step 3b ruling 5, A3). | `packages/shared/src/fansly-page-holds.ts` (gate, final admission, status, alerts) + `engine/commit.ts` (`recordIdentityProof`) |
| I21 | The legacy page-sync executor serves only the platforms whose adapter declares streams (OnlyFans since step 4 S4-10): no Fansly page's legacy state is seeded, scheduled, woken, leased or requested, and nothing gives a page back to it. The platform set is a required argument of every query that picks work — the one fence in them since S4-21, with the Fansly rows parked `retired` (0239) beside it — and the planner and the executor assert it before a wake-up or a run; `services/sync/` holds no Fansly handler, error class or Fansly HTTP import (S4-19). | `onlyfans/boundary.ts` (`legacyExecutorPlatforms`, `assertLegacyExecutorPage`) over `platforms/registry.ts` + `repositories/page-sync.ts` (`PageSyncPlatformScope`) + `services/sync/planner.ts` + `services/sync/executor.ts` + `services/sync-control.ts` (`assertLegacyExecutorServes`); tests/sync-onlyfans-boundary.test.ts, tests/sync-legacy-fence.test.ts |
| I22 | Only a live page's socket source in `sync` opens a Fansly WebSocket (step 4 S4-12): the receiver helper is the one place that constructs a socket, its Upgrade on a send lease (the engine's, over the pacer's one-shot check); no worker, lane or script opens one. | `fansly/ws/source.ts` + `services/egress/fansly-receiver-socket.ts`; tests/fansly-send-guard-boundary.test.ts |
| I23 | The Sync Engine writes no `page_dm_messages` row: a live page's messages go to `message_archive`; the engine only marks the deletion of rows legacy stored (`markFanslyWsHotDeletion`, sticky). | `fansly/resources/dm-messages.ts` + `fansly/resources/dm-live.ts`, pinned by `tests/page-dm-messages-boundary.test.ts` |
| I24 | One hold evaluator over one hold set: what holds a request — the page, its subject, its resource file, its route — is `whyHeld`'s answer over the page's `sync_holds` rows; rows it cannot read keep the page closed. The rows are a page's whole hold state: the page row has no hold column — the old ones were dropped, so the one rollback target is the release before the drop, and the deploy refuses the drop under an image older than it (step 4, owner decision №26; S4-33). | `engine/admission.ts` + `repositories/sync/pages.ts` (the four hold writers) + `scripts/deploy-production.sh` (`verify_running_images_run_without_old_hold_columns`); tests/sync-hold-evaluator.test.ts, tests/sync-hold-set.integration.test.ts, tests/sync-old-hold-columns.test.ts, tests/deploy-old-hold-columns-gate.test.ts |
| I25 | A chat's unavailability episode has one writer, the page's actor: only a head read (no `before`) of `dm-messages.head`/`.catchup`/`.history` that Fansly refuses with its own error envelope counts; it is established at its own 5th refusal, never by the work's breaker; while it is established no key reads the chat's head before `retry_not_before`, every head read that went out and does not end it moves that boundary and settles its own work (one demand, one read; only a work row settles itself — another row decides in its own plan), and no background read is planned; an applied head read ends it. The capture is never lost to it (savepoint). | `fansly/resources/dm-messages.ts` (`outcomeInCapture`, the plan's wait, the apply's end) + `repositories/sync/chat-unavailability.ts`; tests/sync-chat-unavailability.integration.test.ts |

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

Every open `sync_work` row has one reason from this closed list (`engine/status.ts`), first match wins; what holds
the row is the hold evaluator's answer (`engine/admission.ts`):

| Reason | Meaning | Lifted by |
|---|---|---|
| `running` | admitted; its request or apply is in progress | the step's completion |
| `ownership_unconfirmed` | no actor runs the page: no fresh owner heartbeat, mode `off`/`handover`, or the previous owner's stop is not confirmed | the host acquiring the page (safe release, OS proof, container restart, `sync ownership confirm-stopped`) |
| `paused` | the owner paused the page, its requests, or this resource | the owner |
| `page_hold` | 401/403 or identity mismatch (until an identity proof sent after the latest refusal), network (after 3 failures: 10 s → 5 min); rows of the hold set this build cannot read (`detail.holdSet`) | the hold's end; the verify of renewed credentials; the operator repairing the rows |
| `quarantined` | the answer broke its contract or the cursor stuck; the raw answer is kept | the owner re-applying it from the journal |
| `blocked_by_vendor` | the subject failed 5 times; probed once a day while demand exists. A DM read of a chat whose unavailability episode is established is not probed: its work closes `chat_unavailable` (above) | a successful probe |
| `subject_breaker` | the subject failed: 1 min → 10 min → 1 h → 6 h → 24 h | the breaker's end, then a success |
| `resource_hold` | ≥ 5 subjects of the resource failed within 10 min: 30 min → 2 h → 6 h (never `dm-messages.head`) | the hold's end |
| `dependency` | the resource waits for other work or data | that work |
| `not_due` | its time has not come (poll period, coalescing window; a head read of a chat Fansly refuses to the page waits for its episode's `retry_not_before`) | the due time |
| `route_hold` | a 429 (or a 5xx's `Retry-After`) holds a route among those that keep the row closed: every route of its key, or the route its planned request was put off for (`detail.routes`, `detail.held`) | the hold's end (`until`), then the route's pace |
| `route_budget` | runnable; every route of the key is closed by its budget's interval only, or its planned route put the request off for it (`detail.routes`; the row stores `pacer`) | the route's opening |
| `pacer` | runnable; the page's next slot has not opened yet | the pause |
| `class_share` | runnable; the slot belongs to another class or to earlier work of its class | its turn |

## Errors

`engine/errors.ts` classifies every outcome and decides every consequence in one place (`onOutcome`); the commit
transactions only write what it decided. The engine never changes `S`: a 429 holds ONLY the route that answered
it — never the page, a resource file or the route's family — slows that route down and opens the route's own
incident (route holds, below). How often a route is read is its budget's (below).
A retry after an error is always a new attempt through the same admission.

| Answer | Class | Consequence |
|---|---|---|
| 2xx, success envelope, contract accepts | `ok` | streak reset, subject breaker reset, expired holds cleared |
| 2xx, contract refuses (or the cursor stuck) | `contract` / `cursor_stuck` | quarantine the work and the attempt, alert 2 |
| 2xx without a success envelope | `envelope_unsuccessful` | as `subject_failure` |
| 429 (any route: REST, probe, CDN, the socket's Upgrade) | `rate_limit` | a hold of that route only: until `Retry-After` (never shortened), else 5 s → 10 s → 20 s → 40 s → 80 s → 160 s → 300 s + 0–20 % jitter; the page+route's rate halved (≥ ⅛ ceiling) until a raise; the route's incident (`route_limited:<route>`); while the list's route is held `.find` goes straight to `group.detail` |
| a 5xx naming its own `Retry-After` | `rate_limit` | a hold of that route until `Retry-After`, no slowdown, no ladder step; the route's incident |
| 401 / 403 the resource declares about its subject (`subjectScopedAuthStatuses`: a CDN hop's signed URL) | `subject_terminal` | the subject closes with its receipt, no hold |
| 401 / 403 | `auth` | page hold until an identity proof sent after this refusal (recorded as the latest), alert 1 |
| any other non-2xx | `subject_failure` | subject breaker; ≥ 5 subjects of a file in 10 min ⇒ resource hold (failures of `dm-messages.head` and of the owner's probes `probe.*` are not counted); a DM head read Fansly refuses with its own error envelope also counts toward the chat's unavailability episode (above) |
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
  `fansly_send_log.operation` onto them (pinned complete by `tests/sync-route-policy.test.ts`). A route no
  legacy sender ever read has `legacyOperation: null`: the statistics pages of 2026-10 (`stats.*` and
  `earnings.transactions_account`, `reference/fansly-creator-stats`), which only the owner's probe sends so far.
- **Budgets**: `ceiling` (the code maximum) and `current` (what every page runs at) per route — 15/min by
  default, the list 12, the media statistics 5 under a 12 ceiling — and per family on top: messaging (the list, a
  group's detail, `/message`) 15/min, earnings (`/account/wallets/earnings/*`) 17/min, the 2026-10 statistics
  (`/account/stats/*`) 5/min under a 12 ceiling until their quota is measured. `current` moves only by a
  calibration PR, +1/min a step, on evidence. `ROUTE_POLICY_HASH` names the table.
- **Strict admission** (`engine/route-policy.ts`): a route (and its family) admits its next send no sooner than one
  interval of its effective rate after its previous ACTUAL send — no burst, an idle hour earns nothing. The admission
  records the two intervals it applied on the attempt (`route_interval_ms`, `family_interval_ms`, 0237), as it
  records its pause: the send audit judges by them (Alerts, below). The clocks
  are read from the journal at every slot (`readRouteJournal`): the page's own journal and the legacy send log
  (what the legacy engine sent before the switch). A send whose
  instant is unknown counts at its upper bound (admission + the send window; a guard capture's completion or lease
  end); an operation nobody can place counts on every route.
- **At the pick** a key all of whose routes are closed is left out (`routeExclusions`, in SQL like every
  exclusion): a spent route never takes a slot. **The short look-ahead**: when the class whose turn it is has
  nothing admissible now but a candidate that opens within 1.2 × S, the slot waits for it rather than serve a
  later class (a planned read squeezed in would push it a whole pause later); nothing is reserved, the pointer
  moves only on an admission. **After the plan** the planned request's own route is checked for every key (a walk
  over several routes, `probe.manual`, the CDN, the Upgrade): closed, the work is put off until it opens
  (`waiting_reason = 'pacer'` on the row; "why" names it `route_hold` or `route_budget`), nothing admitted, the slot
  open for other work.
- **Route state**: a page's holds and slowdowns after a 429 are the route-scope rows of its hold set (`sync_holds`:
  `route_hold`, `route_budget`; `routeStateOfHolds` reads them). It may only make a route slower: the effective rate
  is the lower of `current` and the stored one, a stored hold closes its route to its end. Rows of a known route this
  build cannot read close the page's admission (`page_hold` with `detail.holdSet` in "why", alert 1
  `route_state_unreadable`, metric `sync_route_state_unreadable`).
- **Route holds** (`engine/route-holds.ts`, owner decisions №22, D3, plan PR 1-2): a 429 holds only the route that
  answered it — a valid `Retry-After` (delta-seconds, or an HTTP-date measured against the answer's own `Date` too)
  to the letter and never shortened, else owner decision №14's ladder 5 → 10 → 20 → 40 → 80 → 160 → 300 s plus
  0–20 % jitter (the ladder climbs by the 429s of one slowdown). Each 429 halves the page+route's effective rate,
  never below ⅛ of the route's ceiling, durably: a restart, new demand, new credentials or a success never lift it.
  A 5xx naming its `Retry-After` holds its route the same way, without a slowdown. The state is written only by
  `writeSyncRouteState`, a compare-and-set on the route's revision.
- **Raise** (A2): the only way up is one step of at most +1/min, never above the route's `current` — the owner's
  audited `pnpm cli sync route raise --page P --route R --to <rate> --revision <n> --evidence <report>` (a
  compare-and-set on the revision the evidence was read at, so a 429 after it refuses the stale step; a hold in
  force stays; reaching `current` ends the slowdown), or a calibration PR moving `current` for every page. The
  evidence is `budgets-calibration.sql` (next to this file; read-only): per live page and route/family the hours on
  the step, 429s of the route and its family, saturated 2-hour stretches, `low_exposure`, and the step's command.
- **Incident** (D5, owner decision №23): one latch per page+route (`route_limited:<route>`), opened by the capture on
  the route's first 429, refreshed — never repeated — by the next ones and by the evaluator while the route is held,
  resolved 10 clean minutes after; urgent work behind a route hold is no alert 3.
- **Rollback** (A4, D6; the command is retired at step 4 S4-10): the hand-back waits for the page's route holds to end (≤ 6.5 min; a longer `Retry-After`
  exits 6, run it again), while the engine keeps serving the page's other routes; the shared send-guard floor carries
  only the sender boundary, the real page holds and 1.2 × S. After the hand-back the legacy engine runs its own
  semantics (S, its page hold on a 429); the engine's route slowdowns are not carried over.
- **Status and why** (owner CLI): `sync page status` lists each route the page used recently and each family —
  ceiling, current, effective rate, interval, newest send, hold, ladder step, newest 429, revision, when it opens —
  with the policy hash; `sync why` names a key its routes keep closed `route_hold` (with the hold's deadline and the
  held routes) or `route_budget` (with the closed routes).

## Alerts and metrics

Plan §10's five alerts are one incident kind, `fansly_sync_engine`, one latch per page and alert (`page_stopped`,
`live_degraded`, `freshness`, `stuck`) plus the global `process`. Alert 3 (`freshness`) never pages for a lone chat
Fansly does not serve (`message_unconfirmed` leaves it out); `chats_refused` pages five chats refused within ten
minutes (above, "A chat Fansly stopped serving"). The actor opens alert 1 at once from its capture
transaction (a refused credential, another identity, a pace violation; a 429 opens its route's own latch,
`route_limited:<route>`); `engine/alerts.ts` re-derives every
condition from the database every 30 s and is the only path that resolves one, so a latch never flips on a partial
view. Alerts 1–3 resolve after their condition has stayed false for 10 minutes since the latch last saw it (alert 4 as
soon as progress resumes), so a condition that comes and goes keeps one standing page. A pace violation has its own
latch that only the owner closes (`pnpm cli sync alerts ack --page <label>`); the evaluator also re-reads the
journal's new live sends, so a violation the capture path could not report still opens it. That re-read is the
**send audit** (`engine/send-audit.ts`), the one checker `sync check live-hour` runs too. It judges
the recorded sends by what each admission recorded it applied, never by a copy of the policy:
- I1: every pair of adjacent sends of the page (both journals) ≥ the later one's own pause `S × (1 + u)`
  (`pause_ms`), by two tests. The recorded instants (`sent_at`) with a 2 ms tolerance: closer than the setting itself
  they fail whatever the pacer measured. And, when both sends are one owner's, its pacer's monotonic gap
  (`gap_prev_ms`), exactly — the pacer refuses a send on that same number, so alone it proves nothing about a pacer
  that remembers the wrong previous send. Where the monotonic gap keeps the pause and the recorded instants do not,
  the pair is `inconclusive` (`clocks_disagree`). The capture's own alert judges its send by the same rule;
- I19: every engine admission against the newest send its route's clock, and its family's, counted before it — the
  adjacent pair of a route and of a family — ≥ the interval that admission recorded. A send provably never made does
  not count, as at the admission;
- a send whose instant was never recorded (in flight, or left by a killed process): as the earlier send of a pair it
  counts at its upper bound (admission + 15 s), as the admission and the takeover floor count it; as the later one it
  is judged at its admission, the earliest it can have left — proven there it passes, else it is `inconclusive`
  (`send_not_recorded`), never judged at the upper bound and never dropped;
- independently, no recorded interval is below the interval of the route's (family's) ceiling.

A violation (`pace_violation`, `route_interval_violation`, `route_interval_below_ceiling`) opens the pace latch. A
pair it cannot judge (no recorded pause or interval — an attempt before 0237 —, a send never recorded that its
admission does not prove, two clocks that disagree) is `inconclusive`: it pages nobody and never passes an
acceptance. Only `handover`/`live` pages page the owner: an `off` page, or one left in `shadow`, runs no actor and
has no condition. Alert 5 — a page is in the engine and no `sync` process beats — is the api watchdog's, since a
process cannot report its own death; a stalled process opens it itself (`stalled`) right before it exits for a
restart. `pnpm cli sync alerts status` shows what holds per page.

**One failure never silences the evaluator** (bug hunt Д11). Each page alert is a rule of its own
(`SYNC_PAGE_ALERT_RULES`) that declares the parts of the facts it reads — `journal`, `live`, `chats` and the pass's one
`money` window. A part is read in its own boundary (`readPageAlertFactsSettled`): one that fails stands in with its
neutral value, which holds no reason. Unknown is no health: a condition that holds on the parts that were read opens
(its summary lists the parts it could not see, `blind`), but a rule that could not read a part it declares, whose
evaluation threw, or whose open or resolve did not land (`resolveSyncEngineIncident` tells `failed` from `unchanged`)
never resolves its latch. The route incidents and the pace backstop have boundaries of their own; the backstop's cursor
moves only once every open landed, so the next pass reads the same sends again. A page's boundary catches the
unforeseen; the next pages go on. Each pass then records, per `handover`/`live` page and rule of
`SYNC_ALERT_EVALUATION_RULES` (the four alerts, `route_limited`, `pace_audit`), whether it judged the rule in full
(`sync_alert_evaluations`: `evaluated_at` on the database clock, else the failure and since when — a part or step, a
SQLSTATE, never SQL); a pass that cannot read its frame marks the rows failing. A failure is logged when it starts or
changes and its end once, never every pass. The api watchdog's leg beside alert 5 reads the rows while `sync` beats:
a pair not judged for 5 min — from its last judgement or the page's mode change, whichever is later; a restart resets
nothing — opens the global latch `evaluator` (`failing`, `unrecorded` or `late`), which resolves once every pair is
judged again. The `sync` process never writes that latch.

The golden signals (`engine/metrics.ts`) come from the database: `computeSyncMetrics` per page (smallest send gap
vs the setting, violations, sends by class and resource, holds, breakers, quarantine) and the global families
(confirmation lag, REST mismatches by field, the DM apply's `not_found` verdicts, money lag from a socket frame to the
ledger, history requests and the ETA's fact over forecast), and the chats Fansly does not serve to a page
(`sync_chats_unavailable`; their work is not in `sync_blocked_by_vendor`). The ops sampler records a compact set every 5 minutes: aggregates over the pages the
engine owns (`sync_*`) — per-page series would double the sample table for figures the page status already shows.

The shadow acceptance report (`sync shadow report`, design §3.12) judged the switch candidates of step 3 against the
legacy engine: demand against its expectation, the legacy volume, the journal replay of every resource, the chain and
ETA checks, the build's fingerprint. Step 4 (S4-22) deleted it, with the questions it asked the resource modules (a
run's size, a standing walk's look, a queue's next due instant, the replay of a legacy observation) and the readers
only it used: every page is `live`, a new page is born `live`, and there is no legacy engine to compare with. A live
page is judged by `sync check live-hour` (above) and, continuously, by the alerts and the send audit.

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
| One read of a route for a page, now | `pnpm cli sync probe --page <label> --operation <wire id> --params '<json>'` (a live page) |
| Do the excluded chats of a live page load? Lift the exclusion | `pnpm cli sync excluded probe --page <label>`; `… report --page <label> --record`; `… lift --page <label> --reason <reason> --evidence-page <label>` |
| Quarantined work, after the fix | `pnpm cli sync work list --page <label> --state quarantined`; `pnpm cli sync work requeue --page <label> --quarantined [--resource <key>]` |
| A backfill / fresh walk on a live page | `pnpm cli sync work enqueue --page <label> --resource <key>` (keys with the `owner` trigger) |
| What alerts hold on a page; close a pace violation | `pnpm cli sync alerts status [--page <label>]`; `pnpm cli sync alerts ack --page <label> --note '…'` |
| An alert's threshold or condition | one constant or rule in `engine/alerts.ts` + `tests/sync-alerts.test.ts` |
| A page's first hour on the engine, and the pace audit of both journals | `pnpm cli sync check live-hour --page <label> [--page <label> …] --since <iso> [--out <path>]` (read-only; exit 0 accepted, 1 failed, 2 open) |
