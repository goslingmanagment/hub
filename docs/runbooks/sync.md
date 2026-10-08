# Fansly sync runbook

The operator's guide to the Fansly Sync Engine: how to read a page's state, what each lever does, what an alert asks
for. One long-running process, `sync`, hosts one actor per Fansly page; the actor is the page's only sender. How the
engine works inside (the pacer, the classes, the invariants) is `apps/runtime/src/sync/README.md`; the API's error
codes are `docs/error-handling.md`. OnlyFans is not on the engine: its pages run on the legacy page-sync queue
([below](#onlyfans-the-legacy-page-sync-queue)).

This file replaces the seventeen Fansly runbooks of this directory (`fansly-*.md`;
[what became of each](#what-the-legacy-runbooks-became)).

## How to use this runbook

- **Commands** are written `pnpm cli …` (a checkout with the app's environment). On production the same command runs
  in the `api` container: `docker compose --env-file .env.production -f docker-compose.production.yml exec -T api
  node apps/runtime/dist/cli.js sync page status`. Every `pnpm cli` line in a code block of this file is parsed
  against the real CLI by `tests/sync-runbook.test.ts`.
- **Reading is free.** `sync page status`, `sync why`, `sync work list`, `sync alerts status`, `sync ownership
  status`, `sync history status | list`, `sync check live-hour` and `sync excluded report` (without `--record`)
  change nothing.
- **A lever is the owner's decision.** Pause and resume, an override, a requeue, owner work, a route raise, an
  exclusion lift, an alert acknowledgement, a history request, a probe. Say why with `--note` (or `--reason`,
  `--evidence`) where the command takes one. `sync probe`, `sync excluded probe`, `sync work enqueue`, `sync history
  request`, "sync now" and `page verify` make the engine send requests; the actor sends them in the page's own pace,
  never the command.
- **Never by hand.** No `update` of `sync_pages`, `sync_work`, the guard row, a hold or a route's state, and no
  restart "to clear" a hold or a slowdown: both are durable on purpose. The only speed setting is the pause S
  ([Pauses](#pauses-and-frequency)); route budgets are code.
- **SQL** blocks are read-only: run each in a `READ ONLY` transaction. In production the `read_only` role reads the
  engine's journal (`sync_pages`, `sync_attempts`, `pages`, `history_requests`, `history_request_items`,
  `fansly_ws_connections`, `fansly_ws_decode_receipts`, `dm_live_messages`, `fansly_send_log`,
  `fansly_page_send_guards`, `observations`; checked 2026-10-04). It does not read `sync_work`, chats, money or
  incidents: a block marked *owner's session* needs a connection that can, still inside a `READ ONLY` transaction;
  never change a role's grants to run one. `tests/sync-runbook-sql.integration.test.ts` runs every SQL block of this
  file in a `READ ONLY` transaction on the migrated schema.

## Status and why

```sh
pnpm cli sync page status
pnpm cli sync page status --page lora-1
pnpm cli sync alerts status
pnpm cli sync ownership status
```

`sync page status` prints a JSON array, one entry per page:

| Field | Reads as |
|---|---|
| `mode` | `live` for every page the engine runs. A new page is born `live`; no lever takes a page there or out of it |
| `owner` | the `sync` container that runs the page, its heartbeat (every 10 s) and `running` (a heartbeat younger than 30 s). `sync ownership status` concludes the same in its `runs` column: `yes`, or `no:` and why (the heartbeat's age, a release, never taken, a mode no actor runs) |
| `pause` | S (`settingMs`), the last send, the smallest gap of the last hour, `violationsLastDay` (must be 0) |
| `sendsLastHour` | sends by class (`urgent`, `requests`, `planned`) and by resource |
| `queue` | per class: `runnable`, and the open work by waiting reason |
| `holds` | the page hold (`until` is `"infinity"` for a credentials hold) and the resource-file breakers |
| `breakers`, `quarantined` | subject breakers open, subjects blocked by the vendor, quarantined rows |
| `requests` | open history requests: fans ready of total, reads done, the reads left at least, the ETA |
| `ws` | the socket: `connected`, `since`, `gapSince`, `decodeDebt` |
| `routes` | each route the page used recently and each family: ceiling, current, effective rate, interval, newest send, hold, ladder step, newest 429, revision, when it opens; the budget table's hash |

A healthy page: `mode: "live"`, `owner.running: true`, `holds.page: null`, `ws.connected: true`, `quarantined: 0`,
`pause.minGapLastHourMs` at or above `pause.settingMs`.

When a page looks wrong, read it in this order: `owner.running` false is
[Watchdog restarts](#watchdog-restarts-shutdown-and-deploys); a `holds.page` is
[Holds](#holds-breakers-and-quarantine); `ws.connected` false is [The socket](#the-socket-and-its-repair);
`quarantined` above 0 is [Quarantine](#quarantine); a route with `holdUntil` or a lowered `effectivePerMin` is
[Route holds](#route-holds-and-sync-route-raise). Otherwise ask "why" for the key that is late.

The same state elsewhere: the dashboard's «Синк» tab in Settings (each Fansly page as the engine reads it; a page's
detail there adds its history requests and its five blocks), the owner routes `GET /api/v1/sync/pages` and
`GET /api/v1/sync/pages/:pageLabel/work`, agents through `hub sync-status` and `hub sync-why`
(`docs/agent-read-skill.md`), and `GET /api/v1/health/sync`. Health gives a Fansly page an `engine` block and calls it
unhealthy on `engine:owner_stale` (no heartbeat for 90 s), `engine:auth_hold`, `engine:identity_mismatch_hold` or
`engine:handover_stuck`; a Fansly page no engine runs is `engine:not_live`. `pnpm cli sync status` (no `page` in it)
is the legacy monitor, and «Синхронизация» the legacy executor's Settings tab: both list OnlyFans pages only.

### Why is this work waiting

```sh
pnpm cli sync why --page lora-1 --resource transactions.head
pnpm cli sync why --page lora-1 --resource dm-messages.head --subject 810272281019305984
pnpm cli sync work list --page lora-1 --resource media-stats.walk --limit 20
pnpm cli sync work list --page lora-1 --state quarantined
```

`--resource` is a registry key (`apps/runtime/src/sync/fansly/registry.ts`); `--subject` is the chat's Fansly group
id, a fan's account id or a media id for the keys that run per subject. `sync why` prints every open row of the key
(with `--subject`, the newest closed row when none is open; else `[]`) with its revisions, its last attempt and
`waiting`: one reason from a closed list, first match wins in the order of `apps/runtime/src/sync/engine/status.ts`.
`waiting.until` is an instant, or `"infinity"` for a wait no clock ends (a credentials hold), as in `sync page status`.

| Reason | Meaning | What to do |
|---|---|---|
| `running` | admitted; its request or its apply is in progress | nothing |
| `ownership_unconfirmed` | no actor runs the page: no fresh owner heartbeat, or the previous owner's stop is not confirmed | [Watchdog restarts](#watchdog-restarts-shutdown-and-deploys) |
| `paused` | the owner paused the page, its history requests or this resource (`detail.scope`) | `sync page resume`, when the reason for the pause is gone |
| `page_hold` | a credentials hold (`auth`, `identity_mismatch`), a network hold, or rows of the page's hold set this build cannot read (`detail.holdSet`) | [Holds](#holds-breakers-and-quarantine) |
| `quarantined` | the answer broke its contract or the cursor stuck; the raw answer is kept | fix the cause, then requeue ([Quarantine](#quarantine)) |
| `blocked_by_vendor` | the subject failed 5 times; probed once a day while demand exists | nothing: a successful probe lifts it |
| `subject_breaker` | the subject failed: 1 min → 10 min → 1 h → 6 h → 24 h | wait; read `lastAttempt` for the answer that failed |
| `resource_hold` | 5 or more subjects of the resource's file failed within 10 minutes: 30 min → 2 h → 6 h (never `dm-messages.head`) | wait; the cause is in the failing subjects' last attempts |
| `dependency` | the work waits for other work or data | look at the work it waits for (a chat's `dm-conversations.find` before its head read) |
| `not_due` | its time has not come: a poll's period, a coalescing window | nothing; "sync now" makes the page's polls due |
| `route_hold` | a 429 (or a 5xx naming its `Retry-After`) holds a route among those that keep the row closed: every route of its key, or the route its planned request was put off for (`detail.routes`; `detail.held` names the held ones); `until` is the hold's end | [Route holds](#route-holds-and-sync-route-raise) |
| `route_budget` | runnable; every route of the key is closed by its budget's interval only, or its planned route put the request off for it (`detail.routes`) | nothing: the route's own pace |
| `pacer` | runnable; the page's next slot has not opened | nothing |
| `class_share` | runnable; the slot belongs to another class or to earlier work of its class | nothing |

A key without requests (`dm-live.deletions`) never waits on a page hold, a route or the pacer. "Sync now" (the block buttons,
`POST /api/v1/sync/pages/:pageLabel/refresh`) makes the page's poll rows due and wakes its actor; it sends nothing
itself.

The last hour of every page, from the journal:

```sql
select p.label, sp.mode, max(a.sent_at) as last_send, count(a.id) as sends,
       count(*) filter (where a.http_status = 429) as r429,
       count(*) filter (where a.http_status in (401, 403)) as r40x,
       bool_and(a.gap_prev_ms is null or a.gap_prev_ms >= a.setting_ms) as pace_ok
  from sync_pages sp
  join pages p on p.id = sp.page_id
  left join sync_attempts a
    on a.page_id = sp.page_id and not a.shadow and a.sent_at > now() - interval '1 hour'
 group by p.label, sp.mode
 order by p.label;
```

Every live page sends, `r40x` is 0 and `pace_ok` is true. A 429 is judged per route
([Route holds](#route-holds-and-sync-route-raise)).

## Pauses and frequency

**The pause S.** The owner's console setting «Пауза между запросами Fansly» (`fanslyDefaultDelayMs`, 2000–60000 ms)
is the smallest gap between two requests of one page. The actor reads it before every admission, so a change applies
from the next request, without a restart; a value outside the range is refused, never clamped. Between two sends
of a page the pacer keeps at least S × (1 + u), u drawn between 0 and 0.2. It is the only speed setting: the engine
never changes S, and nothing else makes a page faster.

**The legacy engine's settings are gone.** Its lane switches, page allowlists, daily call budgets and endpoint
pauses left the console and the env schema at step 4. Their stored overrides were removed by a migration, one
`config_audit_log` row each (the note starts `step 4: retired with the legacy Fansly engine`). An env var that
still names one is ignored: the `api`, `worker` and `scheduler` processes each log one warning at boot, `Retired
Fansly env vars are set and ignored`, with the names they found (`RETIRED_FANSLY_ENV_KEYS` in
`packages/shared/src/config.ts`); remove those lines from `.env.production` with the next deploy. One case stops
the boot of every process instead: `FANSLY_GLOBAL_DELAY_MS` or `FANSLY_ACCOUNT_LOOKUP_DELAY_MS` set while
`FANSLY_DEFAULT_DELAY_MS` is not — those aliases used to carry S, so set the pause under its own name.

**Pausing work.** Three scopes, each kept until its `resume`:

```sh
pnpm cli sync page pause --page lora-1 --all --note 'credentials rotation'
pnpm cli sync page resume --page lora-1 --all
pnpm cli sync page pause --page lora-1 --requests --note 'history paused for the launch day'
pnpm cli sync page resume --page lora-1 --requests
pnpm cli sync page pause --page lora-1 --resource media-stats.walk --resource post-replies.walk
pnpm cli sync page resume --page lora-1 --resource media-stats.walk
```

- `--all`: the actor admits no request and plans no step, the steps without a request included. An open socket
  stays open and keeps capturing; it cannot reconnect until the resume, because the connect is a request. A page
  paused as a whole is a degraded page: what the socket shows is not confirmed, so alert 3 (`message_unconfirmed`,
  `money_not_in_ledger`) still opens after its 15 or 5 minutes.
- `--requests`: the history requests class. Urgent and planned work goes on.
- `--resource <key>` (repeatable): those keys only.

Paused work shows `paused` in "why"; its wait opens no `urgent_waiting`, `planned_stale` or `request_stalled`.

The Settings blocks pause and resume the keys of their streams the same way (the lever map is
`FANSLY_LEVER_STREAMS` in the registry); a block's reset requeues the keys' quarantined work. No key belongs to two
blocks: pausing the chat list («Список чатов»: `dm-conversations.*`, `fan-profiles.probe`) leaves the chat messages
(«Сообщения чатов»: `dm-messages.head`, `.catchup`, `.history`) alone, and the other way round. A key paused by its own
name shows on its block as a partial pause; the block's buttons then say how many keys each would move.

**How often a key runs on one page**, without a deploy:

```sh
pnpm cli sync page override --page lora-1 --resource stats.daily --period-ms 172800000
pnpm cli sync page override --page lora-1 --resource catalog.vault --period-ms 172800000 --full-period-ms 1209600000 --owner-approved
pnpm cli sync page override --page lora-1 --resource post-replies.walk --disable
pnpm cli sync page override --page lora-1 --resource stats.daily --clear
```

A poll takes `--period-ms`; `catalog.vault` takes `--period-ms` and `--full-period-ms`; `media-stats.walk` takes
`--tiers '<json>'` as the registry writes its tiers. `--disable` stops the key on the page, `--clear` returns to the
registry. The economical keys of owner decision №6 (`catalog.fixed`, `catalog.vault`, `media-stats.walk`) refuse a
change without `--owner-approved`: their frequency is the owner's alone.

## Holds, breakers and quarantine

`sync page status` shows a page hold under `holds.page`, a file's breaker under `holds.resources`, and a route's
state under `routes`.

**A page hold** stops every request of the page.

| Kind | Cause | What lifts it |
|---|---|---|
| `auth` | Fansly answered 401 or 403 to the page's session | an identity proof sent after the latest refusal: store a new session (the dashboard's credentials tab, `PATCH /api/v1/admin/pages/:pageLabel/credentials`). The engine checks the candidate against the page before anything is stored (`account.identity`), stores and trusts it, then verifies what is stored (`account.verify`); that proof clears the hold. A page verify of the refused session is not admitted: one verify per stored digest |
| `identity_mismatch` | the session answers as another account | the same: the right account's session. Never edit the stored identity |
| `network` | 3 transport failures or timeouts in a row; the page waits 10 s → 30 s → 1 min → 2 min → 5 min between tries | the first success. Alert 1 only after 10 minutes of it: then check the page's proxy and Fansly's reachability |
| unreadable hold rows | a row of the page's hold set is of a scope or kind this build does not know, or a route's rows do not parse (`detail.holdSet`): a later build wrote them | deploy the build that reads them. Admission stays closed until the row's end, for good when it names none |

A change of credentials or proxy that the engine could not answer within 30 s returns 409 `fansly_sync_work_queued`
with the work's status link: the check is queued, not lost. Under a credentials hold only the candidate check and
one verify per changed digest go out; a network hold beside it stops those too until it ends.

Every hold is a row of `sync_holds` (the page's hold set: its own holds, each route's hold and slowdown, each
file's breaker), and one evaluator reads it for the actor, status, "why" and the alerts.

**Rollback targets and the old hold columns.** A page's holds are its rows of `sync_holds` (`sync page status`
shows them). The old hold columns of `sync_pages` are dropped (step 4, S4-33): a query that selects one fails, so
never read a hold from the page row. The release before the drop (S4-32) is a safe rollback target, and the only one:
it reads none of them, and the marker its acquisition used to leave in the row is skipped where the column is gone.
Every image older than it is NOT a rollback target any more: S4-31 rewrites the dropped columns at every hold write,
so every hold write fails there and a page can neither take a hold nor lift one while it keeps sending; the hold-set
release (the one that brought `sync_holds`) and the images before it read them. The deploy refuses to apply the drop
while a running image is older than S4-32 (`verify_running_images_run_without_old_hold_columns`); deploy S4-32
first, from a checkout of its commit. Details: `apps/runtime/src/sync/README.md`, "Rollback targets from this
release on".

**Breakers** stop one subject or one file, never the page:

- a subject (a chat, a fan, a post) that fails climbs 1 min → 10 min → 1 h → 6 h → 24 h; after 5 failures it is
  `blocked_by_vendor` and probed once a day while demand exists. A success resets it. A history request's fan on such
  a chat reads `blocked`.
- 5 or more failing subjects of one resource file within 10 minutes hold the file: 30 min → 2 h → 6 h.
  `dm-messages.head` is exempt.

Neither has a lever: they end by time or by a success. The answer that failed is in `sync why` (`lastAttempt`,
`lastErrorClass`).

### Quarantine

A quarantined row broke its contract (Fansly changed a shape), stuck its cursor or failed its apply three times. The
raw answer is in the journal, and why is in the row (`result.quarantine`: `reason`, `detail`, `attemptId`, `at`).
Alert 2 (`quarantined`) stays open while any row is quarantined.

```sh
pnpm cli sync work list --page lora-1 --state quarantined
pnpm cli sync work requeue --page lora-1 --work 12345 --note 'the parser accepts the new field'
pnpm cli sync work requeue --page lora-1 --quarantined --resource dm-messages.head
```

Requeue only after the cause is fixed and deployed; requeueing unchanged code quarantines the row again. A row whose
last attempt holds a captured answer is applied again from the journal, without a request; other rows run again.
`--work` ids are all-or-nothing. A quarantined `followers.reconcile` is the blast-radius guard: its reset and its
override are the Settings levers (the README's status-surfaces table), not a requeue.

## Route holds and sync route raise

Fansly's quota is per page and endpoint, so every route has its own strict budget on top of S: `ceiling` (the code
maximum) and `current` (what every page runs at), with two families on top (messaging, earnings). A route admits its
next send no sooner than one interval of its effective rate after its previous actual send: no burst, no borrowing.

**A 429** holds only the route that answered it, never the page, a file or the route's family:

- the hold lasts the answer's `Retry-After` to the letter, else 5 → 10 → 20 → 40 → 80 → 160 → 300 s plus up to 20 %
  jitter (the ladder climbs by the 429s of one slowdown);
- the page's rate on that route is halved, never below ⅛ of the route's ceiling, and stays halved across restarts,
  new credentials and successes;
- the route's own incident opens (`route_limited:<route>`), is refreshed, never repeated, by the next 429s, and
  resolves 10 clean minutes after the hold;
- a 5xx that names its own `Retry-After` holds its route the same way, without the slowdown.

The page's other routes keep running. Nothing is asked of the operator at once: read `routes` in `sync page status`
(`effectivePerMin` below `currentPerMin`, `holdUntil`, `ladderStep`, `last429At`, `revision`) and the `routes` of
`sync alerts status`. Work behind the route shows `route_hold` in "why", with the hold's end in `until` and the
held routes in `detail.held`.

```sql
select p.label, a.operation as route, count(*) as r429, max(a.sent_at) as newest,
       max(a.retry_after_ms) as max_retry_after_ms
  from sync_attempts a
  join pages p on p.id = a.page_id
 where not a.shadow and a.http_status = 429 and a.sent_at > now() - interval '24 hours'
 group by p.label, a.operation
 order by p.label, r429 desc;
```

**Raising a slowed route** is the only way back up, one step at a time:

1. Read the evidence: `apps/runtime/src/sync/budgets-calibration.sql`, read-only, with the psql variable `since`
   set to the start of the evidence window ([Calibration](#calibration) has the invocation). The route's row must
   read `eligible`: 24 hours or more on its step, no 429 on the route or its family on the step, and two
   non-overlapping 2-hour stretches in different UTC hours at 90 % or more of the rate it runs at.
2. Its `step` column is the command, pinned to the route state's revision the report read:

   ```sh
   pnpm cli sync route raise --page lora-1 --route media.offer_stats --to 3.5 --revision 4 --evidence 'budgets-calibration since 2026-10-04T00:00:00Z'
   ```

3. The answer is JSON: `fromPerMin`, `toPerMin`, the new `revision`, `slowdownEnded` (the raise reached `current`),
   `holdUntil` (a hold in force stays).

One step is at most +1/min and never above the route's `current`. A refusal says why: `not_slowed` (nothing to
raise; `current` moves by a calibration PR), `stale_revision` (a 429 or another raise came after the evidence: read
it again), `not_a_raise`, `above_current`, `step_too_large`. A raise inside a page's first hour fails `sync check
live-hour`. The next step waits another 24 hours of evidence.

## History requests

Old chat history is read only by request: no walk goes back without one. A request names up to 1 000 fans of one
page and a depth: `--all` (proven to the first message by an empty page) or `--latest <n>`.

```sh
pnpm cli sync history request --page lora-1 --fan 438766025723355136 --all --reason 'whale review'
pnpm cli sync history request --page lora-1 --chat-url https://fansly.com/messages/810272281019305984 --latest 200 --reason 'support ticket'
pnpm cli sync history list --page lora-1 --state open
pnpm cli sync history status --request 7f9d3c2e-1b4a-4c8e-9f20-3a5b6c7d8e9f
pnpm cli sync history status --request 7f9d3c2e-1b4a-4c8e-9f20-3a5b6c7d8e9f --state blocked
pnpm cli sync history cancel --request 7f9d3c2e-1b4a-4c8e-9f20-3a5b6c7d8e9f --reason 'superseded'
```

- A fan is given as `--fan <account id>`, `--conversation <group id>`, `--chat-url`, or one per line in `--file`.
  The intake resolves each to a visible chat or refuses it (`not_found`, `excluded`, `page_erased`, `duplicate`)
  without failing the request. A fan already satisfied is `ready` without a read.
- Fan states: `queued`, `loading`, `ready`, `blocked` (the chat's work is blocked by the vendor: probed daily),
  `refused`, `cancelled`. Request states: `open`, `done`, `cancelled`.
- The requests class gets 40 % of the slots under full contention and serves round robin between a page's open
  requests, then between a request's fans. The ETA is a lower bound and an estimate; a hold in force is shown beside
  it (`eta.hold`), not in it.
- A page that is not `live`, or whose `requests_enabled_at` has not passed, answers 409
  `history_requests_unavailable_on_page`.
- `sync page pause --requests` stops the class; a cancel stops the request's fans and keeps what was loaded.
- Agents file the same requests with `hub history-request` (scope `request:hydration`; `docs/agent-read-skill.md`),
  the owner routes are `/api/v1/sync/history-requests…`. The old Fansly hydration route still answers: it files a
  one-fan history request, and an owner decision on such a row answers 409 `engine_managed`.

A request that does not move: `sync history status` for its counts, then `sync why --resource dm-messages.history
--subject <group id>` for the chat. Alert 4 (`request_stalled`) opens when a request has runnable work and no read
for 30 minutes.

## Alerts

One incident kind, `fansly_sync_engine`, one latch per page and alert, plus one global latch for the process. Only
a page the engine owns pages the owner. The actor opens alert 1 at once from the answer that caused it; the
evaluator re-derives every condition from the database every 30 seconds and resolves a latch once its condition has
stayed false for 10 minutes (alerts 1–3) or as soon as progress resumes (alert 4).

```sh
pnpm cli sync alerts status --page lora-1
```

It prints, per page, the conditions that hold now (`conditions`, each with every reason), the routes held or inside
their clean window (`routes`) and the open latches (`openLatches`), and the global latches.

| Latch | Detail | Opens when | First step |
|---|---|---|---|
| 1 `page_stopped` | `auth`, `identity_mismatch` | Fansly refused the session, or it is another account's | new credentials ([Holds](#holds-breakers-and-quarantine)) |
| | `network` | the network hold has lasted 10 minutes | the page's proxy, Fansly's reachability |
| | `route_state_unreadable`, `hold_set_unreadable` | this build cannot read rows of the page's hold set: a route's state, or a row of a kind it does not know | deploy the build that wrote them |
| | `ownership_unconfirmed` | no owner heartbeat for 2 minutes | [Watchdog restarts](#watchdog-restarts-shutdown-and-deploys) |
| | `handover_stuck` | a row has said `handover` for 10 minutes; nothing reaches that mode any more | the owner: a row was edited by hand |
| `page_stopped:pace_violation` | | two sends of a page closer than the later one's pause, or two sends of a route or family closer than the interval the later one was admitted under | below |
| `route_limited:<route>` | `rate_limit`, `unavailable`, `route_held` | a 429 on that route, a 5xx naming its `Retry-After`, the hold while it lasts | nothing at once ([Route holds](#route-holds-and-sync-route-raise)) |
| 2 `live_degraded` | `socket_down` | the page's socket down for 5 minutes | [The socket](#the-socket-and-its-repair) |
| | `ws_auth_refused` | the socket's auth frame was refused | new credentials; the socket reconnects when they change |
| | `protocol_changed` | decode debt above 1 % of the last 10 minutes' receipts | the decoder needs a code change; the raw frames are kept |
| | `quarantined` | any quarantined work | [Quarantine](#quarantine) |
| 3 `freshness` | `message_unconfirmed` | a fan message the socket showed, not confirmed by REST for 15 minutes and not deferred ([The live overlay](#the-socket-and-its-repair)) | `sync why --resource dm-messages.head --subject <group id>` |
| | `money_not_in_ledger` | a money frame not in the ledger for 5 minutes | `sync why --resource transactions.head` |
| | `urgent_waiting` | urgent work waiting 2 minutes past its due time, or past the end of its own subject breaker when that is later, with no pause, hold, file breaker or route hold to explain it | `sync work list`, `sync why` |
| 4 `stuck` | `request_stalled` | a history request with runnable work and no read for 30 minutes | [History requests](#history-requests) |
| | `planned_stale` | a poll not served within its SLO (else 3 periods) | `sync why` on the key |
| | `transactions_ledger_incomplete` | the newest finished rescan proved the ledger short of Fansly's lifetime total | the owner's backfill: `sync work enqueue --resource transactions.backfill` |
| 5 `process` (global) | `heartbeat_silent`, `stalled` | no `sync` heartbeat for 2 minutes while a page is in the engine; or the stall watchdog ended the process | [Watchdog restarts](#watchdog-restarts-shutdown-and-deploys) |

Alert 1 stays 10 minutes after its hold ends ("hold cleared and 10 minutes clean"). A pause of the whole page and a
page hold explain waiting work: no `urgent_waiting` and no `planned_stale` for it, and no `request_stalled` under a
pause of the page or of its requests. `message_unconfirmed` and `money_not_in_ledger` open regardless. A work row
under its own subject breaker — `subject_breaker` or `blocked_by_vendor` in `sync why` — is no `urgent_waiting`
until 2 minutes after the breaker ends, and its `since` is that end; `sync check live-hour` counts `urgentWaiting` by
the same rule. A new signal never makes such a row due before its breaker ends.

**A pace violation must never happen**: it means two requests of a page left closer than the owner's rule. Its
latch does not resolve by itself. Read its summary in `sync alerts status`, find the two sends in the journal (the
`pace_ok` query above, narrowed to the page), find the cause, and only then close it:

```sh
pnpm cli sync alerts ack --page lora-1 --note 'two sends 1.9 s apart at 14:02 UTC: a clock step on the host'
```

A violation sent before the acknowledgement never reopens the latch; a new one does.

## The socket and its repair

Each live page has one WebSocket, owned by the `sync` process; no other process opens one. It is the page's live
signal: every frame is captured (an observation and a pending receipt), applied to the live overlay
(`dm_live_messages`) and routed into work in the transaction that acks it.

- **Connecting is a request.** The socket's owner asks for `ws.connect`; the actor admits it like any request, so
  the page's pause, a page hold and the `ws.upgrade` route's budget apply to it. A 401 or 403 at the handshake is an
  `auth` page hold; a 429 holds only the `ws.upgrade` route. After a failed or ended connection the next one is due
  1.5 s × 2^failures later, at most 60 s (± 20 %); after 10 failures in a row, 30 minutes. A connection that stayed
  up a minute resets the count.
- **Limits.** A message is at most 1 MiB and 4 096 fragments; the queue holds 128 frames or 4 MiB; the auth frame
  has 10 seconds; a ping goes every 20 seconds and a missing pong ends the connection after 30. An overflow, a
  capture failure, a transport error, an invalid frame or a changed credentials generation ends the attempt.
- **The auth frame's refusal** blocks that credentials generation: no reconnect until the credentials change. It
  raises an `account.verify` and alert 2 (`ws_auth_refused`).
- **After a gap.** A verified connection raises `repair.ws-gap`: the conversation list from the top down to 60
  seconds before the gap, every moved chat read, the money head and the subscribers poll bumped. A socket down for 2
  minutes raises `dm-conversations.ws-down`: the list head every 30 seconds until a socket proves itself. The
  repair restores state (chats, money, subscribers), not the frames of the gap: a connection row's `gap_state` is
  always `unknown`.

```sh
pnpm cli sync why --page lora-1 --resource ws.connect
pnpm cli sync why --page lora-1 --resource repair.ws-gap
```

```sql
select id, page_id, started_at, verified_at, last_guard_at, last_capture_at, last_ordinal,
       closed_at, stop_reason, gap_since, gap_state
  from fansly_ws_connections
 order by started_at desc
 limit 20;

select page_id, state, live_state, count(*), min(received_at) as oldest
  from fansly_ws_decode_receipts
 where received_at > now() - interval '1 day'
 group by page_id, state, live_state
 order by 1, 2, 3;
```

One open row per page (`closed_at` null) with a `last_guard_at` a few seconds old is a healthy socket. An open row
with a stale guard means its owner died and no later owner has started yet. `stop_reason`: `disabled` (a graceful
stop: a shutdown, a deploy), `closed`, `transport_error`, `pong_timeout`, `auth_timeout`, `auth_refused`,
`provider_error`, `invalid_frame`, `overflow`, `capture_unavailable`, `generation_changed`, `guard_unavailable`,
`ownership_lost`, and `abandoned` (the next owner closed a row its owner could not). `ownership_lost`,
`generation_changed`, `guard_unavailable` and `capture_unavailable` drop the queued frames; every other stop first
captures what the socket already delivered (20 s at most) and applies it (10 s at most).

Receipts: `state` is the metadata decode (`pending`, `retained`, `debt`), `live_state` the overlay (`pending`,
`applied`, `skipped`, `debt`, and `legacy` for frames from before the overlay). What a connection's applier leaves
`pending` the worker's 5-second timer applies. Offline, without any request to Fansly:

```sh
pnpm cli fansly:decode-ws --page lilly-1 --max-batches 50
```

It settles pending decode receipts and applies pending overlay receipts of the page from the stored frames (a
database write: the owner's). Unknown or over-limit frames stay `debt` until the decoder changes; alert 2
`protocol_changed` is that debt above 1 %.

**The live overlay.** A socket message is visible in Hub seconds after it arrives, before REST confirms it. The
overlay carries text, sender, chat, time, reply-to and the attachment fact; money, PPV and media access stay
REST-only. Which pages show overlay rows to chatters and the AI context is the live key `fanslyLiveOverlayReadPages`
(«Живые сообщения в чатах»): exact page labels, `all`, or `none` (the default, and the kill switch). Agent Read,
the archive routes, search and timelines read REST-confirmed stores only.

```sql
select page_id, confirm_outcome, count(*)
  from dm_live_messages
 where confirmed_at > now() - interval '1 day'
 group by 1, 2
 order by 1, 2;

select page_id,
       percentile_cont(0.95) within group (order by first_visible_at - created_at) as p95_visible
  from dm_live_messages
 where first_visible_at > now() - interval '1 day'
 group by 1;

select page_id, mismatch_fields, count(*)
  from dm_live_messages
 where confirm_outcome = 'mismatch' and confirmed_at > now() - interval '7 days'
 group by 1, 2
 order by 3 desc;
```

`confirm_outcome`: `match`, `mismatch` (with `mismatch_fields`: `text`, `sender`, `time`, `group`, `reply`),
`not_found` (a REST read covered the message's place without it: REST wins and the row is hidden; only the DM apply
writes it), `excluded` (the chat is excluded from message sync). **24 hours without a REST copy is no verdict.** The
parity pass defers the row instead: `confirm_wait_reason = 'age_without_rest'`, `confirmed_at` and `confirm_outcome`
stay null, `confirm_due_at` becomes null (no next look). A deferred row stays visible to the chatters and the AI
context, alert 3 does not count it, and a later REST read of the chat still settles it (a copy confirms it, a read
that covers its place without it gives `not_found`) and clears the reason. A chat Fansly stopped serving to the page
(every read an error) keeps its socket messages this way. `chat_unavailable` is the same deferral for a chat whose
unavailability the engine has established (a later release). A reason on a row with `confirmed_at` means nothing.

```sql
select page_id, confirm_wait_reason, count(*), min(first_visible_at)
  from dm_live_messages
 where confirmed_at is null and confirm_wait_reason is not null and deleted_at is null
 group by 1, 2
 order by 1, 2;
```

The golden signals of `GET /api/v1/ops/metrics`: `dm_visible_lag` (acceptance p95 at most 5 s), `ws_live_pending_age`,
`dm_live_parity_bp` (acceptance 9 900 or more), `ws_decode_debt`, and the engine's `dm_live_not_found` (the DM apply's
`not_found` verdicts of the hour).

**Rollback across the deferral** (migration `*_dm_live_confirm_wait_reason.sql`). The image before it never names
`confirm_wait_reason`: its parity pass takes only rows with a next look and its alert 3 needs one, so it never looks
at a deferred row nor counts it, and its readers show it (they hide `not_found` only). Its DM apply still confirms a
deferred row and leaves the reason behind, which is harmless. But it gives its own 24-hour `not_found` to the
messages that arrive while it runs, and those rows stay hidden after the forward deploy: the migration's backfill ran
once. To list them after a rollback window (`\set from '…'` and `\set to '…'`: when the previous image ran):

```sql
select page_id, platform_message_id, platform_conversation_id, first_visible_at, confirmed_at
  from dm_live_messages
 where confirm_outcome = 'not_found' and confirm_source is null
   and confirmed_at >= first_visible_at + interval '24 hours'
   and confirmed_at between :'from' and :'to';
```

Deferring them again is a write: the owner's decision.

**Deletions.** A Fansly deletion frame marks the copies Hub already holds (`deleted_at` on `message_archive` and on
the page's hot rows); text, attachments and tips stay, nothing is inserted, and no later REST read clears a mark.
The engine is the only writer: the page's `dm-live.deletions` work, a step without a request, so no page hold,
pacer slot or route hold delays it (the owner's pause of the page does). Marks have no unmark lever; a code rollback
does not undo them. Stale deletion work (owner's session):

```sql
select p.label,
       count(*) filter (where w.state in ('open', 'running', 'quarantined')
                          and w.created_at < now() - interval '5 minutes') as stale_deletion_work
  from sync_work w
  join pages p on p.id = w.page_id
 where w.resource = 'dm-live.deletions' and not w.shadow
 group by p.label;
```

**Erasure.** Page or model erasure removes the raw frames, the socket's tables and the overlay. Fan erasure removes
the fan's overlay rows, but keeps a socket observation it cannot attribute to that fan alone (a batched envelope) and
counts it as a shared residual: an incomplete fan erasure by the existing residual rule, not a claim that the frame
is multi-fan.

## Excluded chats

A chat can carry `page_dm_threads.metadata.messageSyncExcludedReason`: `partner_missing_from_aggregation_accounts`
(the conversation list assigns it) or `partner_unresolvable_from_account_lookup` (`fan-profiles.probe` assigns it
when the account lookup resolves no partner). The engine reads no messages of an excluded chat; the socket still
shows its new messages, and a history request for its fan is refused `excluded`. Whether such chats load at all is
asked on a live page:

```sh
pnpm cli sync excluded probe --page lora-1 --sample 20
pnpm cli sync excluded report --page lora-1 --record
pnpm cli sync excluded lift --page lora-1 --reason partner_missing_from_aggregation_accounts --evidence-page lilly-1
pnpm cli sync excluded unlift --page lora-1 --reason partner_missing_from_aggregation_accounts
```

- `probe` asks for one head read per sampled chat (bound, visible, most recently active first): ordinary planned
  requests of the page. A probe's answer is journaled and never canonicalized, so an excluded chat gets no messages
  from it. A 403, a declared 400/404/410/422 or an unsuccessful envelope is the chat's answer (`served: false`),
  nothing is held.
- `report` prints the newest probe's verdicts; `--record` keeps the summary as evidence.
- `lift` needs a live page and the evidence page's newest recorded probe of that reason with 10 or more probed
  chats, 80 % or more served and no page-level error. The page's bound chats lose the reason and sync like any chat:
  new heads are read, history only by request. The lift is per page.
- `unlift` applies the reason again; the next conversation-list pass marks the chats.

## Onboarding a page

A new Fansly page is born `live` on the engine; there is no shadow period and no switch.

1. **Have** the model, the page's Fansly session bundle and the page's own proxy. A Fansly page has no direct egress:
   onboarding refuses a page without a proxy.
2. **Create it** in the dashboard (the create-page dialog checks the credentials first, then creates) or:

   ```sh
   pnpm cli page add fansly --model lora --label lora-4 --session-file ./lora-4.session.json --proxy-url http://proxy.example:8080 --proxy-username user --proxy-password-env LORA4_PROXY_PASSWORD
   ```

   The session is checked through that proxy with one `/account/me` that belongs to no page yet: unpaced, journaled
   (`fansly_send_log` with `page_id` null). Only then are the page, its credentials, its proxy, the proven identity,
   its `live` engine row and its engine-owned guard row created, in one transaction.
3. **What happens next, by itself.** The `sync` host adopts the page within seconds; its first request goes at
   least 1.2 × S later. The polls start, the socket connects, and the hourly transactions rescan asks for the
   transactions backfill while nothing is stored. History requests are open at once.
4. **Check** `sync page status --page <label>` (a running owner, a connected socket, no hold) and
   `sync ownership status`. The row itself:

   ```sql
   select p.label, sp.mode, sp.mode_changed_by, sp.requests_enabled_at, sp.legacy_imported_at,
          sp.identity_checked_at, g.owner_engine
     from pages p
     join sync_pages sp on sp.page_id = p.id
     join fansly_page_send_guards g on g.page_id = p.id
    where p.label = :'page_label';
   ```

   `mode` is `live`, `mode_changed_by` starts with `onboarding:`, `owner_engine` is `fansly_sync_engine`.
5. **Judge the first hour** once it has passed (read-only; JSON on stdout; exit 0 accepted, 1 failed, 2 open):

   ```sh
   pnpm cli sync check live-hour --page lora-4 --since 2026-10-05T10:00:00Z --out ./lora-4-live-hour.json
   ```

   It checks the pace of every pair of sends, the takeover boundary, the route budgets, at most one 429 per route
   with its hold kept, no 401 or 403, no page hold, the first media request within 60 seconds, nothing stuck and the
   SLOs. Verdicts: `pass`, `accepted_with_route_429`, `owner_review` (429s on two or more routes), `inconclusive`,
   `fail`.
6. **One-time walks are the owner's demand**, each on a live page and audited:

   ```sh
   pnpm cli sync work enqueue --page lora-4 --resource top-spenders.bootstrap --note 'new page'
   ```

   The keys it takes: `fan-profiles.alias-backfill`, `followers.reconcile`, `notifications.backfill`,
   `posts.backfill`, `stats.backfill`, `subscribers.history`, `top-spenders.bootstrap`, `transactions.backfill`.
   Old chat history is a [history request](#history-requests), never a walk.

Creation is refused, with nothing written, for a page that is not new to Hub's sync: `no_fansly_page`,
`sync_page_exists`, `send_guard_exists`, `legacy_sync_states`, `legacy_sync_cursors`, `legacy_send_log`.

Later checks of the same page: `pnpm cli page verify --page <label>` asks the actor for an `account.verify` (30
seconds at most, else 409 `fansly_sync_work_queued`); one read of any route, now, is

```sh
pnpm cli sync probe --page lora-1 --operation account.me
pnpm cli sync why --page lora-1 --resource probe.manual --subject ''
```

## Watchdog restarts, shutdown and deploys

**The stall watchdog.** A hung database call is an error the engine handles (the `sync` pool's timeouts: 30 s to
check out, 60 s a statement, 30 s a lock wait, 60 s idle in a transaction). What is left is a promise that never
settles. Every actor phase, every pass of the host, every heartbeat and every alert pass reports progress; one that
has not moved for 120 s ends the process:

- one JSON line on stderr: `{"msg":"Fansly sync: stalled; exiting for a restart","component":…,"pageId":…,
  "generation":…,"phase":…,"ageMs":…,"stale":…}` (`component`: `actor`, `host`, `heartbeat` or `alerts`);
- a best-effort `process` incident with the detail `stalled`;
- `process.exit(70)`. Docker restarts the container (`restart: unless-stopped`).

Nothing has to be done for one restart. The restarted container takes its pages back by itself (the previous owner
is provably gone with its pid namespace), each page's first send waits at least 1.2 × S after every send the
database knows, the attempt left in flight is closed `unknown`, the sockets reconnect and their repair reads from 60
seconds before the gap. The `process` latch resolves when the heartbeat is back.

```sh
pnpm cli sync ownership status
pnpm cli sync alerts status
```

Check that every page has a fresh `heartbeat_at` and the new container's host. Repeated stalls are a defect: keep
the stderr lines (the `phase` says where it hung) and fix forward. A block of the event loop itself is not covered
by the watchdog: the heartbeat stops with it, and alert 5 `heartbeat_silent` opens.

**Alert 5 `heartbeat_silent`**: no `sync` heartbeat for 2 minutes while a page is in the engine. Is the container
up (`docker compose ps sync`), and what do its logs end with? Nothing else sends for a Fansly page, so a stopped
`sync` is a stopped Fansly sync.

**Shutdown and deploys.** On SIGTERM each actor finishes the step in flight and writes its page's safe release; the
process ends 40 s after the signal at the latest, inside the container's 45 s stop grace. A page whose release did
not finish waits for a stop confirmation. The deploy recreates `sync` and then confirms the owners of the stopped
containers itself. If that step failed, or a page stays `ownership_unconfirmed` (alert 1 after 2 minutes), confirm
by hand with the hostnames of the `sync` containers that are running:

```sh
pnpm cli sync ownership confirm-stopped --running-hosts 3f2a9c1d7b44 --dry-run
pnpm cli sync ownership confirm-stopped --running-hosts 3f2a9c1d7b44 --acquired-before 2026-10-05T10:00:00Z
pnpm cli fansly-send-guard status
```

Take the hostnames from Docker (`docker compose ps -q sync | xargs docker inspect -f '{{.Config.Hostname}}'`), and
the `--acquired-before` instant before listing them, so a container that starts after the listing is never taken for
a gone one. Never confirm an owner whose container may still be running: a lost database session is not a
confirmation, and two senders on one page is the one thing the engine exists to prevent. `fansly-send-guard status`
shows each page's guard row; its `owner` is `fansly_sync_engine` for every Fansly page.

## Calibration

`current` is what every page runs a route at; it moves only by a calibration PR, one step of +1/min, on evidence. A
route can be calibrated only while its `current` is below its `ceiling` (`sync page status` shows both); raising a
ceiling is a new owner decision. A page slowed by a 429 comes back through `sync route raise`, never through a
calibration PR: the reader takes the lower of the two rates.

**Evidence.** Run the report read-only, `since` = the deploy that set the value under review:

```sh
{ echo "begin read only;"; cat apps/runtime/src/sync/budgets-calibration.sql; echo "rollback;"; } \
  | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v since="'2026-10-04T00:00:00Z'" -P pager=off
```

One row per live page and route (and family): hours on the step, sends, 429s on the step, saturated 10-minute
buckets, 2-hour stretches, `verdict`, and `step` (the raise command, or the calibration step).

| Verdict | Meaning |
|---|---|
| `eligible` | 24 hours or more on the step, no 429 on the route or its family, two non-overlapping 2-hour stretches in different UTC hours at 90 % or more of the rate |
| `not_yet` | exposure exists, but the hours or the second stretch are missing |
| `low_exposure` | the route never ran saturated for 2 hours: nothing is proven. The usual, correct outcome once a page's first passes are over |
| `had_429` | a 429 on the route or its family since the step began: the step's clock restarts |
| `route_state_unreadable` | the page's route state is not one the report reads |

**A calibration PR** moves one route by +1/min for all pages. It needs `eligible` on two or more live pages for the
route and its family, `had_429` on none and no `route_state_unreadable`. Its diff is one `ROUTE_BUDGETS` (or
`FAMILY_BUDGETS`) entry in `apps/runtime/src/sync/fansly/routes.ts`, the table inside `budgets-calibration.sql` and
the pinned tables of `tests/sync-route-policy.test.ts` and `tests/sync-route-holds.test.ts`; its body is the
report's output. The next step waits 24 hours or more after the previous one's deploy.

Demand is organic only: no history request, backfill or probe is filed to create load. Any 429 during a step halves
the route on that page, restarts its clock, and calibration of the route waits for a fresh `eligible`.

## Read-only data checks

What the acceptance runbooks of the legacy lanes left that still holds. The engine journals every answer in
`observations` under the same kinds the legacy lanes used and writes no `sync_raw_payloads` row for Fansly, so a
check that joins `sync_raw_payloads` sees only rows from before a page's switch. All amounts are Fansly mills
(1 000 = $1). Each block below needs the owner's session.

**No legacy sender, legacy runs on OnlyFans only, the Fansly legacy rows parked.** After any deploy:

```sql
select count(*) as legacy_sends
  from fansly_send_log
 where page_id is not null and captured_at > now() - interval '1 hour';

select p.platform, count(*) as legacy_runs
  from sync_runs r
  join pages p on p.id = r.page_id
 where r.started_at > now() - interval '1 hour'
 group by p.platform;

select count(*) as unparked_legacy_rows
  from page_sync_states s
  join pages p on p.id = s.page_id
 where p.platform = 'fansly' and not (s.status = 'paused' and s.blocker_kind = 'retired');
```

`legacy_sends` is 0 (a row with `page_id` null is the onboarding identity check), `legacy_runs` lists `onlyfans`
alone, `unparked_legacy_rows` is 0.

**Tip contexts.** A Fansly ledger tip is bridged to its optional note and conversation by the tip id the `/message`
answer carries, never by time or amount. The engine's rows carry observation lineage (`source_observation_id`);
rows from before the switch carry raw lineage. Gaps are reported, not synthesized; OnlyFans tips have no context
lane.

```sql
select p.label, count(*) as active_tip_transactions, count(ttc.id) as exact_contexts,
       count(*) filter (where ttc.id is null) as context_gaps,
       count(ttc.id) filter (where ttc.source_observation_id is not null) as observation_lineage,
       max(ttc.captured_at) as last_context_capture
  from transactions tr
  join pages p on p.id = tr.platform_account_id
  left join transaction_tip_contexts ttc
    on ttc.account_id = tr.platform_account_id and ttc.platform_tip_id = tr.correlation_id
 where tr.is_active is true and tr.canonical_type = 'tip'
 group by p.label
 order by p.label;
```

**Post tips.** `/tips?targetIds=…` is undocumented: a captured row is evidence for that read, not a completeness
guarantee. A positive `snapshot_minus_rows_mills` can be legitimate (the snapshot includes attachment tips the
endpoint does not return): report it, never force equality. A tip row's `tip_goal_ref` is exact when set; null is
unattributed, not "direct".

```sql
select p.label, cp.platform_post_id, cp.post_tip_total_mills,
       count(cpt.id) as captured_tip_rows,
       coalesce(sum(cpt.post_tip_amount_mills), 0) as captured_tip_mills,
       cp.post_tip_total_mills - coalesce(sum(cpt.post_tip_amount_mills), 0) as snapshot_minus_rows_mills
  from creator_posts cp
  join pages p on p.id = cp.account_id
  left join creator_post_tips cpt
    on cpt.account_id = cp.account_id and cpt.platform_post_id = cp.platform_post_id
 where p.platform = 'fansly'
   and cp.published_at > now() - interval '30 days'
   and cp.post_tip_total_mills > 0
 group by p.label, cp.id
 order by p.label, cp.published_at desc;
```

**Per-fan earnings.** `fan-earnings.roster` keeps the receipt model: a claim at admission, a receipt at the apply,
provider totals in mills, never computed from local transactions. A valid empty answer is no zero, and malformed
money never becomes one. One fan's revisions, signal and baseline times and receipt provenance:

```sql
select fansly_earnings_refresh_status(:'page_label', :'fan_ref');
```

The retained-snapshot audit (`scripts/fansly-events/export-earnings-audit.ts`: SSH and `psql` as `read_only`, one
page and one explicit past range per run, a fresh output directory) compares each fan's last valid provider snapshot
with the projection. Check `manifest.json` first: `completed` must be true and the SHA-256 of `snapshot.jsonl` must
match. `verified` also needs a matched fan and window, current parser stamps, projector catch-up and no unavailable
or rejected capture; an incomplete export is evidence to keep, never a pass.

**Replay and rebuild** are the owner's, approved for an exact scope, dry run first:

```sh
pnpm cli events:replay --kind dm_messages --account 4 --from 2026-09-01T00:00:00Z --to 2026-09-02T00:00:00Z --dry-run
pnpm cli events:replay --kind fan_earnings_stats --kind fan_earnings_monthly --account 4 --from 2026-09-01T00:00:00Z --to 2026-09-02T00:00:00Z --dry-run
pnpm cli projection:rebuild fan_earnings_stats --account 4
pnpm cli tip-contexts:backfill --account 4
```

`events:replay` re-runs the canonicalizers over retained observations and is idempotent; it sends nothing to Fansly
and refuses a window whose `domain_events` partition is detached (`docs/runbooks/domain-event-partitions.md`). Never
replay with an inflated `--parse-version`, reset parse stamps or re-fetch history as a shortcut. `projection:rebuild`
resets only rebuildable rows; readers can see an incomplete projection while it replays. `tip-contexts:backfill`
replays the retained legacy raw (`sync_raw_payloads`) only. `message_archive` is never rebuilt in place
(`docs/runbooks/message-archive-rebuild.md`).

## OnlyFans: the legacy page-sync queue

The legacy page-sync executor serves OnlyFans pages only; `pnpm cli sync status` and `/api/v1/sync/status` are its
monitor. A Fansly page's rows in `page_sync_states` are parked records (`paused`, blocker `retired`) that no image
clears.

**Provider cooldown.** `rate_limit` and `provider_5xx` streams keep a future `retry_at` when new work arrives:
`request_seq`, the latest request source and payload can advance while the stream stays `retrying`. That is queued
work waiting for its deadline, not a lost request; ordinary and targeted leases obey it. Manual requests still
supersede an ordinary transport or yield backoff and an expired cooldown, but queueing one does not bypass a
deadline in force. The deadline is the stream's own consecutive-failure ladder (60 s doubling, capped at 30
minutes): OFAPI names none of its own to the executor.

For a diagnosis keep the page and stream, `retry_at`, the retry kind, the request and applied sequences and the
normalized provider error, with read-only tools. Do not clear the row or dispatch it repeatedly to test recovery.

```sh
pnpm cli sync status --page lora-of
```

## What the legacy runbooks became

The legacy Fansly engine is deleted (step 4 of the sync engine plan). Its runbooks described flags, lanes and
acceptance gates that no longer exist; their texts stay in git history (`git log --diff-filter=D -- docs/runbooks/`).
Captured facts are never deleted: the tables below stay as records, with no writer.

| Legacy runbook | Its subject | Now |
|---|---|---|
| `fansly-dm-bounded.md` | A1 bounded dialog polling | deleted with the legacy DM handler. The engine reads heads on demand, history by request |
| `fansly-dm-head-catchup.md` | known-head debt and its recovery allowlist | deleted. `dm-messages.catchup` reads a list head newer than the stored one; `fansly_dm_head_debt` is a record |
| `fansly-events-shadow.md` | A0 shadow sweeps and T0 measurement | deleted. `fansly_dm_shadow_sweeps` is a record |
| `fansly-ws-continuity.md`, `fansly-ws-protocol-check.md` | the W0 operator scripts | deleted with `scripts/fansly-ws` |
| `fansly-ws-hints.md` | B1 addressed reads: the hint projector, its policy and canary | deleted. The engine routes the socket's demand itself. `fansly_ws_hint_receipts`, its attempts and `fansly_ws_hint_status` are records |
| `fansly-ws-capture.md` | the socket's capture, journal, overlay and readers | [The socket and its repair](#the-socket-and-its-repair). The capture flags are retired: the engine owns a live page's socket |
| `fansly-ws-reliability.md` | the B1 generation repair, settlement checks, six retained-only Ari messages, platform deletions | deletions: [the socket](#the-socket-and-its-repair). The repair CLI and the settlement lane are deleted. The six Ari messages stay unrecovered records (`pnpm cli fansly:ws-recovery-manifest` still inspects them, read-only) |
| `fansly-provider-cooldown.md` | the legacy queue's cooldown | [OnlyFans](#onlyfans-the-legacy-page-sync-queue). A Fansly 429 holds its route |
| `fansly-dm-exclusion.md` | the partner exclusion and the per-thread breaker | [Excluded chats](#excluded-chats); a failing chat is a subject breaker. `page_dm_message_sync_health` is a record |
| `fansly-dm-reply-repair.md` | the sync-pull v6 reply clocks and their scoped replay | v6 is the current parser; [replay](#read-only-data-checks) |
| `fansly-earnings-correctness.md` | C2a: the earnings snapshot identity (v7) and its audit | v7 is the current parser; [per-fan earnings](#read-only-data-checks) |
| `fansly-earnings-shadow.md` | C2b: the shadow receipts, crossing a rejected fan, the roster max age | the lane and its flags are deleted. The engine keeps the receipt model; its roster age is a registry constant. A fan Fansly rejects gets a `rejected` receipt and is read again on its next dirty mark or at the roster age; a failing one is that fan's breaker. The walk never stops on a fan |
| `fansly-earnings-targets.md` | C2c: addressed targets and isolated recovery | deleted with their flags. `fan_earnings_target_attempts` is a record |
| `fansly-followers-diagnostics.md` | C1: the follower reconcile's diagnostic notes | deleted with the legacy follower lanes. The engine's `followers.reconcile` quarantines a suspicious walk for the owner |
| `fansly-post-tips-acceptance.md` | the post tips acceptance | [post tips](#read-only-data-checks) |
| `fansly-tip-transaction-contexts-acceptance.md` | the tip context acceptance | [tip contexts](#read-only-data-checks) |
