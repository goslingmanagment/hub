# B — Hub Fansly ingestion map (code-derived)

Repo: `/Users/dmitriy/code/goose/hub`, clean checkout at `582ef1cf` (`main`).
Method: source reading only. **No production access, no app run, no writes.**
Every request-volume number below is **CODE-DERIVED** — it is what the constants
and loops in this repository imply, not a measurement. Someone else measures
production.

Paths are absolute. `EH.ts` = `/Users/dmitriy/code/goose/hub/apps/runtime/src/services/sync/executor-handlers.ts`
(5 036 lines; abbreviated only in the tables). Repo-relative paths elsewhere are
relative to `/Users/dmitriy/code/goose/hub`.

**Section index** (written in investigation order, not question order):

| § | topic |
|---|---|
| §1 | stream map: declarations, cadence table, endpoints/pagination/budgets/checkpoints, journal→canonicalizer→events→projections |
| §1.4 | code-derived HTTP requests/day for one page |
| §1.5 | who consumes each projection (+ latency sensitivity) |
| §1.6 | the measured production baseline already in `backlog.md`, and the existing FANSLY-001…008 plan |
| §2 | ingestion substrate: `observations`, `domain_events`, canonicalizers, ingest route, the OFAPI webhook pipeline, and the **reusability assessment** |
| §3 | scheduling & pacing, priorities, `source: recovery`, pause/resume, runtime-changeability, the staged-flag pattern |
| §4 | session bundle, credentials, auth death, egress resolver, **the WebSocket-through-proxy answer**, ratchets |
| §5 | health / observability surfaces a push source must join |
| §6 | hidden dependencies on polling cadence (incl. two landmines) |
| §7 | Playwright, connection libraries, roles, leader election, where a per-page connection lives |

---

## §1. STREAM MAP

### 1.0 Where the 17 streams are declared

`FANSLY_STREAMS` — `/Users/dmitriy/code/goose/hub/apps/runtime/src/platforms/registry.ts:80-98`
(17 entries; every canonical stream except `fan_identities`).
Adapter capabilities at `registry.ts:154-188`: **`webhooks: false`, `writes: []`,
`presenceSource: "poll"`, `billing: "session"`**, session kind
`browser_session` with lifecycle text that says capture/refresh mechanics are
"deliberately unspecified (owner-flagged custody area)".

Per-stream pull handlers: `registry.ts:113-142`. A stream present in
`SYNC_STREAMS` without a handler here is a **boot crash**, not a 500
(`checkAdapterConformance`, `registry.ts:231-237`).

Cadence/priority/SLA policy: `SYNC_STREAM_POLICY` —
`/Users/dmitriy/code/goose/hub/packages/db/src/repositories/page-sync.ts:175-447`.

Seven of the 17 seed **paused** on a new page (`SEED_PAUSED_SYNC_STREAMS`,
`page-sync.ts:127-135`): `posts, stats_snapshot, notifications, catalog,
post_replies, payouts, media_stats`. They only run once their own live config
flag *and* their own fail-closed page allowlist are opened
(`/Users/dmitriy/code/goose/hub/apps/runtime/src/services/sync/fansly-stream-scheduling.ts:54-138`).

### 1.1 Cadence, class, priority, freshness SLA

| stream | cadence s | class | basePriority (scheduled) | queueDelay threshold | freshness SLA | domain |
|---|---|---|---|---|---|---|
| light | 3600 | live | 60 | 10 m | 3 h | connection |
| transactions | 3600 | live | 50 | 15 m | 3 h | financials |
| top_spenders | 3600 | maintenance | 45 | 30 m | — | financials |
| subscribers | 3600 | live | 40 | 15 m | 3 h | audience |
| followers | 3600 | live | 35 | 15 m | 3 h | audience |
| followers_reconcile | 172800 (48 h) | maintenance | 34 | 90 m | — | audience |
| dm_conversations | **1800** | live | 30 | 15 m | **1 h** | messages_live |
| dm_messages | 86400 | history | 25 | 45 m | — | messages_history |
| fan_earnings | 86400 | maintenance | 20 | 90 m | — | financials |
| purchase_history | 14400 (4 h) | history | 15 | 90 m | — | messages_history |
| posts | 21600 (6 h) | history | 14 | 90 m | — | messages_history |
| stats_snapshot | 21600 | maintenance | 13 | 90 m | — | financials |
| notifications | **1800** | live | 12 | 30 m | — | audience |
| catalog | 86400 | maintenance | 11 | 6 h | — | financials |
| post_replies | 21600 | maintenance | 10 | 6 h | — | audience |
| payouts | 86400 | maintenance | 9 | 6 h | — | financials |
| media_stats | 21600 | maintenance | 8 | 6 h | — | audience |

Source: `page-sync.ts:176-446`. Domain SLAs at `page-sync.ts:449-480` — only
`connection/financials/audience` (3 h) and `messages_live` (1 h) have one; the
seven gated lanes are **deliberately absent** from `SYNC_DOMAIN_POLICY`'s
primary/supporting lists so a shut gate cannot degrade a page's block health
(comments at `page-sync.ts:275-278`, `315-320`, `332-342`, `354-366`).

### 1.2 Endpoints, pagination, budgets, checkpoints

Adapter: `/Users/dmitriy/code/goose/hub/packages/fansly/src/adapter.ts`
(all GET; `request()` hardcodes the method — comment at `adapter.ts:1391`).
Base URL default `https://apiv3.fansly.com/api/v1`
(`/Users/dmitriy/code/goose/hub/packages/shared/src/config-registry.ts:114`).

| stream | Fansly endpoint(s) (`endpointTemplate` in adapter.ts) | pagination / caps | continuation | checkpoint shape |
|---|---|---|---|---|
| **light** | `/account/me` (`adapter.ts:316`) | 1 call | none | none — writes `pages.*` metadata + `updatePageSyncTimestampCache` (`EH.ts:846-852`) |
| **transactions** | `/account/wallets/earnings/transactions` (`adapter.ts:922`) | `limit=100`, offset scan from 0, stops at the **local** lower bound (`transactions.ts:695-702`, comment 697-701: no `after` is ever sent to Fansly) | offset walk inside a chunk; deep backfill separate | `page_sync_cursors.state`: offset, providerReportedTotal, snapshotEnd, `olderThanBoundary*` (`transactions.ts:660-689`) |
| **top_spenders** | `/account/wallets/earnings/accounts` (`adapter.ts:976`) | windowed by time, month → week → day splitting when a window is truncated (`EH.ts:955-1010`); steady window 7 d (`EH.ts:225`) | `pendingWindows[]` queue in the cursor | `TopSpendersCursorState`: `accountCreatedAt`, `pendingWindows`, `completedMonths`, `lastWindow*` (`EH.ts:933-1000`) |
| **subscribers** | `/subscribers` (`adapter.ts:1015`) + `/account?ids=` hydration (`adapter.ts:737`) | `limit=100`, **full offset scan every run**, `status="3,4"` (active) then one-off `status="5"` (expired history). Reserves **2** budget slots per page (`EH.ts:1606-1614`) | offset paging | `SubscribersCursorState`: generation, mode(`active`/`expired`), offset, observedCount, pageCount, providerReportedTotal, historyBackfilledAt (`EH.ts:1587-1596`) |
| **followers** | `/account/{id}/followersnew` (`adapter.ts:1089`); bootstrap also calls `/account/me` (`EH.ts:1891`) | `limit=100`, **incremental** — stops at `knownFollowId` boundary or `page.done` (`EH.ts:1910-2037`) | offset paging until boundary | `FollowersCursorState`: knownFollowId, newestFollowId, offset, pageCount, sourceFollowerCount (`EH.ts:1892-1899`) |
| **followers_reconcile** | same `/account/{id}/followersnew` | page size 100 (`EH.ts:218`), **full snapshot walk**, max 2 snapshot restarts (`EH.ts:219`), retry delay 15 m (`EH.ts:220`) | offset paging to terminal short page (`EH.ts:227-231`) | snapshot cursor + `snapshotRestartCount`/`restartReason` (`EH.ts:2161-2182`) |
| **dm_conversations** | `/messaging/groups` (`adapter.ts:1143`) + `/group/{id}` on ambiguity (`adapter.ts:1194`) + `/message?limit=1` head repair (`adapter.ts:1218`) + `/account?ids=` probe | `limit=100, sortOrder=1, flags=0`, **full offset scan every sweep**; `unchangedPageStreak` is computed (`EH.ts:3330`) but **never read** — there is no early exit | offset += 100 (`EH.ts:3331`) until `page.done` | `DmConversationCursorState` v2: `{version, mode:"full_scan", generation, offset, observedCount, pageCount, providerTotalMode, providerReportedTotal, unchangedPageStreak, fullSweepStartedAt, lastFullSweepCompletedAt}` (`EH.ts:2830-2842`) |
| **dm_messages** | `/message` (`adapter.ts:1218`) | `FANSLY_DM_MESSAGE_PAGE_LIMIT = 25` (`fansly-dm-messages.ts:27`); live backfill cap 25 msgs/conversation (`packages/db/src/repositories/page-dm.ts:19`); retention 200 / 1000 for spenders (`page-dm.ts:20-22`) | per-conversation candidate loop; `selectNextPageDmMessageSyncCandidate` / `…DeepBackfillCandidate` (`EH.ts:3831,3852,3871`) | `DmMessagesCursorState`: currentConversationId + per-conversation walk state (`EH.ts:3758-3773`) |
| **fan_earnings** | `/account/wallets/earnings/stats/accounts` (`adapter.ts:1274`) + `/account/wallets/earnings/monthlystats/accounts` (`adapter.ts:1308`) | **2 calls per fan**, spenders only, reserves 2 budget slots (`EH.ts:4417-4419`); ~1 400 requests for a page the size of `lora-1` per full walk (`apps/runtime/src/modules/ops/index.ts:322-326`) | keyset `cursorFanId`; a fan-scoped rejection stops the walk (`EH.ts:4382-4390`) | `{cursorFanId}` |
| **purchase_history** | `/media/orderhistory` (`adapter.ts:1341`) | daily attempt cap **100** (`apps/runtime/src/services/sync/fansly-purchase-history.ts:62`); local scan batches 500 × 4/chunk (`EH.ts:221-224`) | `pendingTargets[]` + two local keysets | `FanslyPurchaseHistoryCursorStateV5`: `{transactionCursorId, rawPayloadCursorId, pendingTargets, utcDay, callsToday}` (`EH.ts:4563-4571`) |
| **posts** | `/timelinenew/{accountId}` (`adapter.ts:771`), `/post?ids=` (`adapter.ts:837`), `/tips?targetIds=` (`adapter.ts:877`) | timeline walk restarts each cadence; engagement seed batch 500 (`posts.ts:482`), post batch `POST_BATCH_SIZE` (`posts.ts:595,620`); engagement refresh has its own daily budget (default 40, `config-registry.ts:240`) | one batch per dispatch — "burst shape, not daily volume, is the ban-risk surface" (`posts.ts:475`) | timeline cursor + `subject_refresh_state` rows |
| **stats_snapshot** | 7 steps: `/it/amoie/stats` ×2 (`adapter.ts:425`), `/account/wallets/earnings/stats` `limit=100` (`adapter.ts:494`), `/account/wallets/earnings/monthlystats` (`adapter.ts:533`), `/trackinglinks` (`adapter.ts:359`), `/contentdiscovery/media/suggestionsnew` ×2 (`adapter.ts:567`), then `/message/broadcast/stats`(+`/deleted`), `/message/broadcast/scheduled`, `/polls`, `/recapstats` (`adapter.ts:1512,1539,1628,1643`) | **daily** sweep on a 6-hourly stream; cap `fanslyStatsSnapshotDailyCallBudget` default **25** (`config-registry.ts:185`) counted in HTTP *attempts* | month-walk backfill, `lastSweepDay` advances last (`fansly-stats.ts:1832`) | per-step cursor + `utcDay`/`callsToday` (`fansly-lane.ts:19-52`) |
| **notifications** | `/notifications` (`adapter.ts:615`) | 50 rows/page; forward poll usually **1 call** (~15 notifications/day observed, `fansly-notifications.ts:13-15`); `FORWARD_MAX_PAGES_PER_POLL = 20` (`fansly-notifications.ts:115`); daily cap `fanslyNotificationsDailyCallBudget` default **96** (`fansly-notifications.ts:477`, `config-registry.ts:191`) | cursor is a **notification id**, `before=<id>` (`fansly-notifications.ts:23-26`); repeat-request guard stops a loop | `{forward:{lastId,pages}, backfill:{…}, filterMode, utcDay, callsToday}` |
| **catalog** | 6 fixed steps + vault walk + batch hydrations: `/vault/albumsnew` (1665), `/uservault/albumsnew` (1687), `/subscriptions/tiers` (1706), `/subscriptions/giftcodes` (1720), `/message/automated` (1737), `/account/walls` (1783), `/media/vaultnew` (1835), `/account/media?ids=` (1751), `/account/media/bundle?ids=` (1767) | 100 ids per hydration call; `VAULT_ALBUM_MAX_PAGES = 400` (`fansly-catalog.ts:139`); daily cap `fanslyCatalogDailyCallBudget` default **60** (`config-registry.ts:198`) | per-album durable cursor; deferral to next UTC day at the cap | per-sublane cursor + `utcDay`/`callsToday` |
| **post_replies** | `/post/{postId}/replies` (`adapter.ts:1436`) + at most one `/account?ids=` per chunk | 1 call = 1 post; `MAX_PAGES_PER_POST = 20` (`fansly-post-replies.ts:142`); daily cap `fanslyRepliesDailyCallBudget` default **100** (`config-registry.ts:206`); re-walk cycle default 14 days (`config-registry.ts:207`) | queue is `subject_refresh_state` rows (`plane='post_replies'`), priority never-walked-newest-first → dirty → round-robin (`fansly-post-replies.ts:17-33`) | `paginationMode` (`single_page`/`before`) + `utcDay`/`callsToday` |
| **payouts** | `/payments/payoutmethods` (`adapter.ts:1894`), `/payments/payout/requests` (`adapter.ts:1933`) | offset-paged at **10**; `REQUEST_WALK_MAX_PAGES = 400` (`fansly-payouts.ts:147`); daily cap `fanslyPayoutsDailyCallBudget` default **20** (`config-registry.ts:216`); **steady state = exactly 2 calls/day** (`fansly-payouts.ts:4,22-37`) | offset walk + two repeat-request guards | walk offset, `walkPages`, `utcDay`/`callsToday` |
| **media_stats** | `/it/moie/statsnew` (`adapter.ts:460`) | 1 call = 1 media × 1 window; age-decayed round-robin (fresh ≤30 d daily, mid 31-180 d weekly, long tail every `fanslyMediaStatsLongTailCycleDays` default 30); daily cap `fanslyMediaStatsDailyCallBudget` default **300** (`config-registry.ts:230`); **designed to saturate its own cap** (`fansly-media-stats.ts:29-33`) | 31-day backfill windows, `windowWasHonoured` + repeat guard (`fansly-media-stats.ts:35-50`) | per-media `subject_refresh_state` + `utcDay`/`callsToday` |

The gated lanes share one durable budget mechanism:
`createDurableFanslyAttemptBudget` in
`/Users/dmitriy/code/goose/hub/apps/runtime/src/services/sync/fansly-lane.ts:195-226`
— the attempt is **persisted before the adapter is allowed to send**, counted in
HTTP *attempts* (retries included), reset on UTC-day roll (`fansly-lane.ts:44-52`),
and crossing it defers the lane to `nextFanslyUtcDayStart` (00:05 UTC,
`fansly-lane.ts:54-62`).

### 1.3 Journal → canonicalizer → domain events → projections

Every fetched Fansly response goes through
`persistRawPayload` (`apps/runtime/src/services/sync/shared.ts:83-228`), which
writes **two** rows:

1. `sync_raw_payloads` (verbatim body, `payloadKind`, `retainUntil`).
2. `observations` with **`source: "pull"`**, `producer: "sync:fansly:<stream>"`,
   **`kind` = the `endpoint` string the handler passed**, `payloadHash` = sha256
   of the observation payload, and an idempotency key
   `page:stream:runId:fetchSeq` (`shared.ts:177-193`).
   A *failed* fetch also journals, as `kind = "<endpoint>:failed"`, `source:
   "pull"` (`shared.ts:684-686`, dynamic-kind rule at
   `apps/runtime/src/services/observation-kinds.ts:366-378`).

The registry of every kind a writer in this tree may mint:
`WRITTEN_OBSERVATION_KINDS`, `observation-kinds.ts:41-351`, CI-pinned by
`tests/observation-kind-coverage.test.ts` (`observation-kinds.ts:10-14`).

Canonicalizer families: `apps/runtime/src/services/canonicalize/index.ts:120-245`.
**The important asymmetry:** the broad `sync-pull` family only claims five kinds —
`earnings_transactions, dm_messages, fan_earnings_stats, fan_earnings_monthly,
purchase_history` (`canonicalize/sync-pull.ts:52-62`, version 5 at
`sync-pull.ts:42`). Everything else the *core* Fansly streams journal
(`dm_conversations`, `subscribers`, `followers`, `account_me`, `group_detail`,
`earnings_accounts`, `fans_active`, `account_lookup`) is **not canonicalized in
the default configuration**: those handlers write their projections **directly**
inside the chunk transaction, and the observation is a witness only.
`account_lookup`, `earnings_accounts`, `fans_active`, `group_detail` are
explicitly listed in `RAW_ONLY_OBSERVATION_KINDS` with justifications
(`observation-kinds.ts:416-441`).

`followers`, `subscribers`, `dm_conversations`, `account_me` *do* have a
canonicalizer — the **`fansly-replay` family**
(`canonicalize/fansly-replay.ts:52-58`, version 1) minting
`fan.identity_observed`, `follow.observed`, `subscription.observed`,
`conversation.observed`, `page.identity_observed`
(`fansly-replay.ts:21-27`) — but it is behind the live config key
`fanslyReplayMode`, default `"off"` (`config-registry.ts:329`), and the
production capabilities snapshot in yesterday's research shows
`"fanslyReplayMode": "off"`
(`/Users/dmitriy/code/goose/hub/docs/research/fansly-connection-2026-09-06/live-capture-sample.json`).

| stream | observation kind(s) | canonicalizer family (version) | projection-only? | domain event types |
|---|---|---|---|---|
| light | `account_me` | `fansly-replay` v1 **(off by default)** | — | `page.identity_observed` |
| transactions | `earnings_transactions` | `sync-pull` v5, lane `sync` | mixed | transaction/message events |
| top_spenders | `earnings_accounts` | **none** (RAW_ONLY, `observation-kinds.ts:424-428`) | — | — (direct projection write) |
| subscribers | `subscribers`, `account_lookup` | `fansly-replay` v1 (off) / RAW_ONLY | — | `subscription.observed`, `fan.identity_observed` |
| followers | `followers` | `fansly-replay` v1 (off) | — | `follow.observed` |
| followers_reconcile | `followers` | idem | — | idem |
| dm_conversations | `dm_conversations`, `group_detail`, `dm_messages` (head repair), `account_lookup` | `fansly-replay` v1 (off) for the first; `sync-pull` v5 for the head-repair `dm_messages` body | mixed | `conversation.observed`, `message.*` |
| dm_messages | `dm_messages` | `sync-pull` v5, lane `sync`, **`mixed: true`** (`index.ts:147-156`) | mixed | deliverable `message.*` + projection-only media plane |
| fan_earnings | `fan_earnings_stats`, `fan_earnings_monthly` | `sync-pull` v5 | mixed | earnings events |
| purchase_history | `purchase_history` | `sync-pull` v5 | mixed | purchase events |
| posts | `posts` | `posts` v8, lane `posts` (`index.ts:134-146`) | **yes** | post/media projection events |
| stats_snapshot | `account_stats`, `earnings_stats_snapshot`, `earnings_monthlystats_snapshot`, `tracking_links`, `discovery_feed`, `broadcast_stats`, `broadcast_stats_deleted`, `broadcast_scheduled`, `polls`, `recapstats` | `fansly-stats` v2, lane `stats` (`index.ts:157-170`) | **yes** | traffic / revenue-mix / mass-DM projections |
| notifications | `notifications` | `fansly-engagement` v1, lane `engagement` (`index.ts:171-183`) | **yes** | verbatim notification events incl. codes it cannot name |
| catalog | `vault_albums`, `uservault_albums`, `subscription_tiers`, `gift_codes`, `automated_messages`, `account_walls`, `vault_media`, `vault_album_walk_completed`, `account_media_batch`, `account_media_bundle_batch` | `fansly-catalog` v3, lane `catalog` (`index.ts:184-197`) | **yes** | incl. `catalog.listing_observed` (an event about an ABSENCE) |
| post_replies | `post_replies` (payload is an ENVELOPE `{walk,response}`) | `fansly-comments` v1, lane `comments` (`index.ts:198-213`) | **yes** | comment events |
| payouts | `payout_methods`, `payout_requests` (both **restricted class**, off the agent allowlist — `observation-kinds.ts:114-122`) | `fansly-payouts` v1, lane `payouts` (`index.ts:214-228`) | **yes** | payout events |
| media_stats | `media_offer_stats` | `fansly-stats` v2 (same family as stats_snapshot, one health gauge) | **yes** | per-media traffic |

### 1.4 Code-derived HTTP requests per day, one typical page

**Assumptions, all stated:** one Fansly page; `C` = number of DM conversations,
`S` = active subscribers, `T` = transaction rows inside the 7-day lookback,
`M` = distinct media offers. Gated lanes are counted **as if ramped** — in the
default configuration all seven are flag-off and cost 0.
Sources: cadences from `page-sync.ts:176-446`, page sizes and caps as cited above.

| stream | runs/day | requests per run | requests/day |
|---|---|---|---|
| light | 24 | 1 (`/account/me`) | **24** |
| transactions | 24 | 1-2 pages (incremental to the local 7-day bound) | **24-48** |
| top_spenders | 24 | 1 window in steady state (7-day window, `EH.ts:225`) | **~24** |
| subscribers | 24 | `ceil(S/100)` pages × 2 (page + `/account?ids=`) | **48·ceil(S/100)** → 96/day at S≤100, 192/day at S≈300 |
| followers | 24 | 1 page (incremental, stops at boundary) | **~24** |
| followers_reconcile | 0.5 | `ceil(F/100)+1` full snapshot | **~(F/100)/2 per day** |
| **dm_conversations** | **48** | `ceil(C/100)` list pages **+** per-conversation `/group/{id}` on ambiguity **+** `/message?limit=1` head repairs for every thread whose head moved | **48·ceil(C/100) + 48·(new heads)** — see below |
| dm_messages | 1 scheduled **+ event-driven** (see §6) | one 25-msg page per conversation per candidate loop | driven by how many conversations changed head, not by cadence |
| fan_earnings | 1 | 2 × (spender fans), walked across chunks | ~1 400 per full walk on a large page (`ops/index.ts:322-326`) |
| purchase_history | 6 | ≤100 attempts/day (hard cap) | **≤100** |
| posts | 4 | timeline walk + `/post?ids=` + `/tips?targetIds=` batches | tens |
| stats_snapshot | 4 dispatches, 1 sweep | ~12 calls/sweep, capped 25 | **≤25** |
| notifications | **48** | usually 1 (`fansly-notifications.ts:13-15`), capped 96 | **~48, ≤96** |
| catalog | 1 sweep | 6 fixed + vault walk + hydrations, capped 60 | **≤60** |
| post_replies | 4 | capped 100 | **≤100** |
| payouts | 1 | 2 in steady state | **2** |
| media_stats | 4 | capped 300, designed to run at 100 % of cap when `M` is large | **≤300** |

**dm_conversations is the bulk, and here is why in code, not in folklore.**
The sweep is a *full offset scan of every conversation, twice an hour*:

- `while (input.budget.hasRequestCapacity() && …)` then
  `getMessagingGroupsPage({limit:100, offset: state.offset, sortOrder:1, flags:0})`
  — `EH.ts:2904-2911`.
- `offset: page.done ? state.offset : state.offset + 100` — `EH.ts:3331`.
- `unchangedPageStreak` is incremented (`EH.ts:3330`) and **read by nothing**
  (`grep` across `apps/`, `packages/`, `tests/` finds only writes and the
  cursor-state parser at `sync/cursor-state.ts:340-390`). There is **no
  "stop early, nothing changed" exit.**
- On completion the sweep runs a **destructive finalization** —
  `markPageDmConversationsInvisibleByGeneration` (`EH.ts:3462-3465`) — but only
  when the provider reported a total *and* the row-side generation count exactly
  reproduces `observedCount` (`EH.ts:3454-3460`).

So the list cost alone is `48 × ceil(C/100)` calls/day. Worked, code-derived:

| C (conversations) | list pages/sweep | list calls/day | + head repairs (1 per changed head) |
|---|---|---|---|
| 200 | 2 | 96 | + N |
| 1 000 | 10 | 480 | + N |
| 3 000 | 30 | 1 440 | + N |
| 5 000 | 50 | 2 400 | + N |

Head repair (`getMessagesPage(limit:1)`, `EH.ts:3189-3192`) fires when the head
is missing a timestamp/sender **and** `existing.lastMessageId !== conversation.lastMessageId`
(`EH.ts:3182-3186`) — i.e. roughly once per conversation whose last message
changed since the previous sweep, per sweep. `/group/{id}` fires only on
ambiguous/contradictory partner identity (`EH.ts:3113-3118`).

**Whole-page code-derived total**, all lanes ramped, `C = 1 000`, `S = 300`,
`M = 2 000`: `480 (dm_conv list) + ~100 (head repairs) + 192 (subscribers) +
24 (light) + 36 (transactions) + 24 (top_spenders) + 24 (followers) +
48 (notifications) + 100 (purchase_history) + 25 (stats) + 60 (catalog) +
100 (replies) + 2 (payouts) + 300 (media_stats) + posts/dm_messages/fan_earnings`
≈ **1 500-1 800 requests/day**, of which **~35-40 % is the dm_conversations
sweep** and another ~20 % is `media_stats` when that lane is open.
With the seven gated lanes **off** (the default), the total is
≈ **900 requests/day** and dm_conversations is **~60 %** of it.

A ceiling check from the pacer: the shared limiter reserves a `global` slot at
`fanslyDefaultDelayMs + 100` = **2 600 ms** per egress key
(`sync/rate-limiter.ts:70-80`, default 2500 at `config-registry.ts:115`), which
caps *all* Fansly traffic sharing that egress key at ~33 200 requests/day; the
`dm_conversations` scope adds a 5 000 ms floor (`config-registry.ts:119`,
clamped in code) capping that lane at ~17 280/day. Neither is binding at the
volumes above — **cadence and page count are the binding constraint, not the
limiter.**

### 1.5 Who consumes the projections

*(filled in from the consumer-map pass — see §1.5 table below)*

---

## §3. SCHEDULING & PACING

### 3.1 Dispatch path

```
scheduler (leader) ──cron "* * * * *"──► sync.planner queue
   sync-queue.ts:241                      runSyncPlannerCycle (planner.ts:29)
        │
        ├─ ensurePageSyncStates            (seeds rows, RESETS cadence_seconds to code)
        ├─ reconcileFanslyBulkStreamScheduling  (gate → pause/resume + recovery generation)
        ├─ scheduleDuePageSync             (slot arithmetic → status='pending')
        └─ listRunnablePageSync → one sendSyncPageWakeup PER PAGE
                                   singletonKey = pageId, group = provider:egressKey
                                              │
worker ──runSyncPageExecutorWorker──► fetch(batchSize 1, groupConcurrency 1,
   executor.ts:1141-1220                priority:false, orderByCreatedOn:true)
        └─ executeNextSyncPageChunk (executor.ts:509)
              acquirePageSyncLease → ONE stream, ONE chunk, budget(5 req / 45 s)
              → complete / yield / block / retry
              → tail-insert a successor wakeup in the SAME transaction that
                completes the job (executor.ts:1083-1114)
```

Key facts:

- **One wakeup lane per page.** `singletonKey: String(platformAccountId)`,
  `sync-queue.ts:313`. Delays live durably in `page_sync_states.retry_at`, never
  in the queue (`sync-queue.ts:310-312`).
- **Fairness quantum = one chunk.** `pg-boss` fetch uses `priority: false`,
  `orderByCreatedOn: true`, `groupConcurrency: 1`, `ignoreGroups: <locally active>`
  (`executor.ts:1163-1177`). The comment at `executor.ts:1165-1172` is explicit:
  strict numeric priority has no aging in pg-boss and would starve an older
  singleton, so cross-page fairness is the fixed page singleton + tail-inserted
  successor.
- **Group id = `provider:egressKey`** (`sync-queue.ts:317-319`,
  `buildSyncPageExecuteGroupId` in `packages/shared`), so two pages sharing one
  proxy serialize against each other.
- **Chunk budget: 5 requests, 45 s wall clock.** `new SyncChunkBudget()` at
  `executor.ts:562`, defaults at `sync/chunk-budget.ts:9-12`. Multi-call units
  reserve their full cost up front (`chunk-budget.ts:28-33`).
- `SYNC_PAGE_EXECUTE_RETRY_LIMIT = 0` (`sync-queue.ts:23`) — pg-boss never
  retries a job; `page_sync_states` is the durable retry authority.
- Executor concurrency `syncPageExecutorConcurrency`, default **4**
  (`config-registry.ts:138`); boot invariant: >1 requires the shared limiter on.
- Per-page exclusivity is doubled: pg-boss singleton + a Postgres advisory lock
  `pg_try_advisory_lock(43101, pageId)` in `sync/locking.ts:3,60-63`, plus a
  DB lease with TTL 120 s and 30 s heartbeat (`executor.ts:72,517-522,572-589`).

### 3.2 Priorities and `source`

`SYNC_STREAM_PRIORITY_BY_SOURCE` — `page-sync.ts:504-…`, six sources
(`scheduled, manual, onboarding, recovery, anomaly, reset`, `page-sync.ts:73-79`).
`recovery` is the `scheduled` table **+10** across the board (`page-sync.ts:505-544`).
SQL selection at `page-sync.ts:781-817`.

`source: "recovery"` is set in three places:

1. **A ramp gate opening.** `requestGatedStreamWakeup` in
   `apps/runtime/src/modules/ops/index.ts:328-356` — after a config write that
   moves a gate from not-ramped to ramped, the newly-allowed streams are queued
   with `source: "recovery"` so recovery starts within a minute instead of at
   the lane's next slot. The comment at `ops/index.ts:316-327` is the reasoning,
   including "an unwanted wake-up is ~1400 unscheduled requests".
2. **The gate reconciler's resume path** — `page-sync.ts:1408-1409` and
   `1462-1463` set both `request_source` and `dispatch_source` to `'recovery'`.
3. **Onboarding/recovery seeding** — `page-sync.ts:1073`
   (`onboarding ? "onboarding" : "recovery"`).

### 3.3 Rate limiting / egress pacing

`createSyncRateLimitWaiter` — `sync/rate-limiter.ts:15-61`. It is a **DB-backed**
limiter (`reserveSyncProviderRateLimit` against `sync_rate_limits`,
`schema.ts:723-730`), so spacing is shared **across processes**, not
process-local. Scopes per Fansly egress key (`rate-limiter.ts:70-81`):

| scope | min spacing | config key (default) |
|---|---|---|
| `global` | `fanslyDefaultDelayMs + 100` = **2 600 ms** | `FANSLY_DEFAULT_DELAY_MS` (2500) |
| `followers_page` | **5 000 ms** | `FOLLOWER_PAGE_DELAY_MS` (5000) |
| `dm_conversations` | **5 000 ms** | `FANSLY_DM_CONVERSATIONS_DELAY_MS` (5000, floored in code) |
| `dm_messages` | **5 000 ms** | `FANSLY_DM_MESSAGES_DELAY_MS` (5000, floored in code) |

Which scopes a call reserves is decided in the adapter from its `category`
(`packages/fansly/src/adapter.ts:2217-2232`): every call takes `global`, and
`followers` / `dm_conversations` / `dm_messages` additionally take their own.
If no `rateLimitWaiter` is supplied the adapter falls back to a
**process-local** chain (`adapter.ts:2234-2251`) — that is the "alias backfill
has no shared waiter" defect the prior research flagged.

Daily budgets are the *second* pacing layer and are **per lane, per page, per
UTC day, counted in HTTP attempts**, persisted in the cursor before the send
(`fansly-lane.ts:195-226`). Defaults: stats 25, notifications 96, catalog 60,
replies 100, payouts 20, media_stats 300, purchase_history 100 (code constant),
post engagement 40.

### 3.4 Pause / block / resume

`page_sync_states.status ∈ {idle, pending, running, retrying, blocked, paused}`
(`page-sync.ts:72`), plus `blocker_kind` / `blocker_code` / `blocker_message`
(`schema.ts:656-659`).

- **Auth death → whole page parked.** `isAuthError` → `blockPageSync(blockerKind:"auth",
  blockerCode:"credentials_invalid")` then
  `pausePageSyncForAuth(streams: getSyncStreamsForPlatform(provider))` —
  `executor.ts:768-822`. Comment at `executor.ts:805-808`: "a dead session is
  dead for the WHOLE page". Recovery is `clearPageSyncAuthBlock` via
  `handleSuccessfulPageVerificationRecovery`.
- **`manual_action_required`** — classified from a failure summary containing
  "manual action" or "shared rate limit" (`executor.ts:426-433`).
- Other blockers: `provider_404_exhausted`, `provider_bad_data`,
  `invalid_cursor` (`executor.ts:378-410`).
- Retry classes: `rate_limit` (HTTP 429), `provider_5xx`, `transient_network`
  (`executor.ts:412-438`). **Everything unrecognised falls through to
  `transient_network` retry** (`executor.ts:435-438`).
- **Feature-gate pause** is its own blocker kind,
  `FANSLY_BULK_STREAM_FEATURE_GATE_BLOCKER_KIND = "feature_gate"`
  (`page-sync.ts:114`), distinguishable from a paused-without-blocker seed row.

### 3.5 Is cadence runtime-changeable? **No.**

- `SYNC_STREAM_POLICY.cadenceSeconds` is a **code constant**
  (`page-sync.ts:176-446`).
- It is materialised into `page_sync_states.cadence_seconds` (`schema.ts:663`)
  and the next due time is pure slot arithmetic
  `((last_scheduled_slot + 1) * cadence_seconds + slot_offset_seconds)`
  (`packages/db/src/repositories/sync.ts:217`, `page-sync.ts:2419`).
- **`ensurePageSyncStates` rewrites `cadence_seconds` back to the code value on
  every planner cycle** — `page-sync.ts:1590-1611`. A hand-edited row is
  reverted within one minute.
- There is **no `config_registry` descriptor for any cadence**. Grep of
  `runtimeApply: "live"` in `config-registry.ts` returns 60 keys; none is a
  stream cadence. The closest live knobs are `transactionLookbackDays` (139),
  `transactionRescanCapDays` (140), the per-lane daily call budgets, the
  per-lane enable flags and page allowlists, and
  `ofapiDmReconcileIntervalMinutes` (251) — the OFAPI side does have a runtime
  interval key, Fansly does not.

**Therefore: changing a Fansly stream cadence requires a code change + deploy.**
What *is* runtime-changeable, live, per page: whether a gated lane runs at all
(`fansly<Lane>SyncEnabled` + `fansly<Lane>PageAllowlist`) and how many calls a
day it may spend (`fansly<Lane>DailyCallBudget`). Not the seven core streams —
`light, transactions, top_spenders, subscribers, followers,
followers_reconcile, dm_conversations, dm_messages` have **no** enable flag at
all; they run for every active Fansly page.

### 3.6 The staged-flag pattern

`CONFIG_DESCRIPTORS` (`packages/shared/src/config-registry.ts:100+`) carries two
orthogonal axes (`config-registry.ts:40-56`):

- `editability`: `never` (ops-only/secrets) | `staged` (gated rollout, prescribed
  order) | `editable` (safe operational knob).
- `runtimeApply`: `live` (re-read each work cycle via `loadEffectiveConfig`) |
  `boot` (applied once at process start by `applyBootOverrides`) | `none`
  (env-only).

The live overlay is derived, not hand-listed:
`LIVE_CONFIG_KEYS = CONFIG_DESCRIPTORS.filter(d => d.runtimeApply === "live")`
(`apps/runtime/src/services/effective-config.ts:22-24`), applied by
`applyEffectiveOverrides` (`effective-config.ts:30-57`) over the boot config on
each call to `loadEffectiveConfig` (`effective-config.ts:62-65`). The runtime
heartbeat reports the same merged view, so `running` is honest about which keys
actually reached a read-site (`effective-config.ts:1-10`;
`RUNNING_SCHEMA_VERSION = 2` at `config-registry.ts:17`).

Staged flags carry `stagedGroup` + `stagedOrder` + `requires`
(`config-registry.ts:89-93`). Worked example, the **off → shadow → enforce**
shape (`config-registry.ts:269-270`):

```
ofapiSpendProjectionShadowEnabled   staged, boot, group "#51", order 1,
                                    requires ofapiCreditLedgerEnabled
                                    note: "Shadow-only C3 comparison table;
                                           does not change revenue truth"
ofapiSpendTransactionIngestEnabled  staged, boot, group "#51", order 2,
                                    requires ofapiSpendProjectionShadowEnabled
                                    note: "C3 apply step: applies transactions.new
                                           projections into transactions and rollups"
```

The Fansly lanes use the *fail-closed allowlist* variant instead
(`fansly-stream-scheduling.ts:72-110`): the shared key
`fanslyNewStreamPageAllowlist` is **fail-open** (empty CSV = every page,
`sync/fansly-stream-gate.ts:6-16`), so every lane added after the first was
given its **own** allowlist key read through `isPageAllowlisted`, which is
fail-closed (empty = no pages). The comment at
`fansly-stream-scheduling.ts:105-110` names the cost of getting this wrong:
"reading it through the fail-OPEN shared key would start a 300-call-a-day
per-media walk on every Fansly page at once."

A gate flip materialises into durable stream state through
`reconcileFanslyBulkStreamGate` (`fansly-stream-scheduling.ts:114-129`) on the
planner's minutely tick, and opening a gate creates a **recovery generation**
(`FanslyBulkStreamGateReconcileResult.createdRecoveryGeneration`,
`page-sync.ts:109-112`).

### 1.6 Cross-check: the repo already holds a measured baseline

`/Users/dmitriy/code/goose/hub/backlog.md:447-466` records a production
`read_only` measurement (14 days to 2026-09-04, 6 Fansly pages) that the
architect should treat as the measured number my §1.4 only derives:

- 0×429, 2×401 (one-offs), 11×500, ~38 transport `fetch failed`.
- Requests/day per page: **lilly-2 ~12 000, lora-1 ~6 600, lora-2 ~4 400,
  lora-3 ~3 700, lilly-1 ~2 300, ari-1 ~440.**
- Peak 24 req/min (= the 2.5 s pacing); lilly-2 active in 70 % of the day's
  minutes.
- **60 % of ALL Fansly traffic is `dm_conversations`** (the `/group/:id` walk
  every 30 min); another ~25 % is `followers` + `fan_earnings` (2 calls/fan).
- `apiv3.fansly.com` sits behind CloudFront (not Cloudflare Bot Management).

My code-derived model (§1.4) predicts dm_conversations at 35-60 % depending on
which gated lanes are open — consistent with the measured 60 %. The measured
per-page volumes are 4-10× my worked example, which the code explains: those
pages have thousands of conversations and `fan_earnings` is ramped (2 calls per
spender fan per walk).

**There is already a written plan for exactly this migration** —
`backlog.md:447-570`, items FANSLY-001…008, ordered
**FANSLY-004 → FANSLY-005 → FANSLY-006**:

| id | substance | file references it names |
|---|---|---|
| FANSLY-001 | TLS/HTTP fingerprint ≠ the claimed Firefox UA; no challenge-page detector (a challenge lands in `provider_bad_data`, fail-closed but blind) | `request-headers.ts:7-20,60-88`, `adapter.ts:2006-2011` |
| FANSLY-002 | `fansly-client-check` is replayed, not computed (`cyrb53(check_key + path + device id)`); if Fansly starts verifying → 401/403 → every page paused | `request-headers.ts:28-57`, `shared/src/types.ts:166-174` |
| FANSLY-003 | one device id + token used from several IPs/geos (chatter browsers + the VPS proxy); no rule pinning chatter and hub to one proxy/geo | `page-context.ts saveProxy`, `egress/resolver.ts` |
| **FANSLY-004** | **Page browser** — a persistent headless Firefox per page (Playwright already in `apps/runtime` deps), logged in as the model, behind the page proxy; the adapter's requests execute from the page context so TLS/HTTP2/cookies/device-id/client-check are real. Kernel unchanged; only transport changes. Cost ~300-500 MB RAM per page | `adapter.ts:2006` (the single raw fetch), `egress/resolver.ts` (new `browser` egress class), `scripts/raw-fetch-budget.json` (−1), `registry.ts:183-187` |
| **FANSLY-005** | **WebSocket instead of the 30-minute `dm_conversations` walk.** The Fansly web client holds a WS for chat/notifications; subscribing from the page browser gives events at the moment they occur, and the full walks stay as a completeness pass every few hours. "Формат сокета в нашем коде не снят — сначала один HAR." | the `dm_conversations` handler in `services/sync/`, `SYNC_STREAM_POLICY` in `page-sync.ts`, **`observations_source_check` (a new `source` = a migration)** |
| FANSLY-006 | Chatters work behind the hub (workboard/desktop), nobody else holds the model session — requires a Fansly **outbox**, since the adapter is read-only by construction (test-pinned, `adapter.ts:1390-1405`) | `~/code/goose/workboard`, `docs/ofapi-command-outbox-contract.md` as the template |
| FANSLY-007 | proxy TYPE (residential/mobile/datacenter) is neither recorded nor validated | `shared/src/proxy-string.ts`, `page-context.ts saveProxy` |
| FANSLY-008 | third-party Fansly API only as plan B | — |


---

## §4. SESSION / CREDENTIALS / EGRESS

### 4.1 The bundle

`/Users/dmitriy/code/goose/hub/packages/shared/src/types.ts:155-174`:

```ts
export const FANSLY_CLIENT_CHECK_ROUTES = [
  "message","group","account","earnings","messagingGroups","subscribers","media",
] as const;                                                    // :155-163

export interface FanslySessionBundle {                         // :166
  authorization: string;                                       // :167
  fanslyClientId?: string;                                     // :168
  /** Legacy pasted value. Retained for credential compatibility,
   *  never reused across routes by the adapter. */
  fanslyClientCheck?: string;                                  // :171
  fanslySessionId?: string;                                    // :172
  routeChecks?: Partial<Record<FanslyClientCheckRoute, string>>; // :173
}
```

Stored wrapper `StoredPlatformCredentialBundle` at `types.ts:180-188`;
`ProxyConfig {url, username?, password?}` at `types.ts:190-194`.

Two validators: the Zod one at the HTTP boundary
(`packages/contracts/src/routes.ts:3166-3182`, and note `proxy` is
**non-optional** at `:3178-3181` — decision #124), and a hand-rolled normalizer
for the file/legacy path that accepts header-cased keys
(`apps/runtime/src/services/page-context.ts:44-78`).

**Header assembly** — `packages/fansly/src/request-headers.ts:58-86`,
insertion-ordered to match a 2026-08-21 Firefox HAR
(`CAPTURED_BROWSER_HEADERS`, `:7-19`):

| header | source | line |
|---|---|---|
| `fansly-client-id` | `session.fanslyClientId` | `:71` |
| **`fansly-client-ts`** | **`String(nowMs)` — the only truly per-request value** | `:72` |
| `fansly-session-id` | `session.fanslySessionId` | `:73` |
| **`fansly-client-check`** | `session.routeChecks[route]`, route derived from the pathname by `fanslyClientCheckRoute` (`:28-37`) / `resolveFanslyClientCheck` (`:39-51`); **absent ⇒ header omitted, no failure** | `:75-76` |
| `authorization` | `session.authorization` **verbatim, no `Bearer ` prefix** | `:84` |

Every request also appends `ngsw-bypass=true` (`adapter.ts:1982`) and uses
`AbortSignal.timeout(30_000)` (`adapter.ts:2006-2011`).

**Trap worth naming:** the flat legacy `session.fanslyClientCheck` is stored but
**never sent** — `buildFanslyRequestHeaders` reads only `routeChecks`. The
dashboard form exposes only the flat field
(`apps/dashboard/src/pages/settings/PlatformCredentialsFields.tsx:50-56,147-165`),
so a dashboard-pasted check is inert; `routeChecks` can only arrive via the CLI
`--session-file` path or a hand-built PATCH body.

### 4.2 How the bundle gets in — human paste or CLI file. **No extension push exists.**

All owner-gated (`requirePrincipal` + `requireOwner`, e.g.
`apps/runtime/src/modules/catalog/index.ts:414-415`):

| operation | route | handler |
|---|---|---|
| `adminCreatePage` | `POST /api/v1/admin/pages` | `catalog/index.ts:330-364` |
| `adminVerifyCredentials` | `POST /api/v1/admin/credentials/verify` (no persist) | `catalog/index.ts:411-462` |
| `adminUpdateCredentials` | `PATCH /api/v1/admin/pages/:pageLabel/credentials` | `catalog/index.ts:548-562` → `services/connections.ts:204-315` |
| `adminVerifyPage` | `POST /api/v1/admin/pages/:pageLabel/verify` | `catalog/index.ts:503-546` |
| `adminTestProxy` | `POST /api/v1/admin/proxy/test` | `catalog/index.ts:464-501` |

CLI: `page add fansly --session-file <file> --proxy-url <url> …`
(`apps/runtime/src/cli.ts:1429-1460`, proxy mandatory at `:1444-1446`) — the
**only** path that can supply `routeChecks`; `page set-proxy`/`remove-proxy`
(`:1526-1555`), `page verify` (`:1557-1594`), `page proxy-ip` (`:1596-1620`).
Credential updates are audited by **field name only, never value**
(`catalog/index.ts:555-560`).

### 4.3 Storage and encryption

`page_credentials` (`packages/db/src/schema.ts:348-357`): one row per page
(`platform_account_id` UNIQUE, `ON DELETE CASCADE`), `encrypted_session text`,
`key_version int`. The proxy is a **separate** table `egress_endpoints`
(`schema.ts:359-371`): credential-free normalized `url`, `encrypted_auth`,
`rate_limit_scope_key` (the egress key).

Crypto is **AES-256-GCM with a versioned key ring, no KMS/envelope**:
`EncryptedEnvelope {alg,keyVersion,iv,tag,ciphertext}`
(`packages/shared/src/crypto.ts:3-9`), `encryptJson` `:13-31`,
`decryptJsonWithKeyVersion` `:59-70`. Keys from
`APP_ENCRYPTION_KEY` / `APP_ENCRYPTION_KEY_RING` / `APP_ENCRYPTION_KEY_VERSION`
(`packages/shared/src/config.ts:84-86`, parsed `:695-699`, validated 32 raw
bytes base64 `:875-880`, ring format `version:base64` `:900-922`).

**Read-back is a per-request decrypt with no cache** —
`resolveStoredPageContext` decrypts the session and the proxy auth on every call
(`page-context.ts:197-307`, session `:238-250`, proxy `:157-178`). What *is*
cached is the undici **dispatcher**, keyed by sha256 of normalized proxy
url+user+pass (`adapter.ts:294,2168-2178`;
`buildProxyDispatcherCacheKey` in `packages/shared/src/proxy.ts:330-342`).
The adapter is a process singleton built at boot (`bootstrap.ts:380-383`).

### 4.4 Death signal, blast radius, recovery

Three layers:

1. **Adapter:** `if (response.status === 401 || response.status === 403)` →
   terminal `kind:"failed"`, **never retried**, wrapped in `FanslyApiError` with
   a redact-then-slice 400-char `responseSnippet`
   (`adapter.ts:2056-2070`, `:2046-2048`; class at `packages/fansly/src/errors.ts:1-11`).
   The auth check deliberately precedes the empty-body branch (`:2072-2075`) and
   the 429/5xx retry branch (`:2090`).
2. **Executor:** `isAuthError` is **Fansly-only by construction** —
   `executor.ts:93-99`. OFAPI 401/403 is classified separately and deliberately
   does **not** pause the page (`executor.ts:248-258`).
3. Everything else → `classifyTaskFailure` (`executor.ts:287-439`);
   `ProxyMissingError | FanslyProxyMissingError` → blocked
   `manual_action_required` / `proxy_missing` (`executor.ts:317-327`).

**Blast radius: the whole page, all 17 streams** — `executor.ts:768-839`:
`blockPageSync(blockerKind:"auth", blockerCode:"credentials_invalid")` on the
failing stream (`:769-783`), then `pausePageSyncForAuth` over
`getSyncStreamsForPlatform("fansly")` (`:809-822`; comment `:805-808` "a dead
session is dead for the WHOLE page"), then `notifyAuthFailedIncident`
(`:823-830`). SQL at `page-sync.ts:2875-2918`, with a guard at `:2914` that
refuses to steal an operator or feature-gate pause. End state: **1 stream
`blocked` + 16 `paused`, all `blocker_kind='auth'`.** No fleet-wide kill switch
exists (that absence is FANSLY-002's ask, `backlog.md:490-492`).
A second identical site: `sync/targeted-thread-backfill.ts:632-672`.

**Recovery: `clearPageSyncAuthBlock`** (`page-sync.ts:2740-2770`), called only
from `handleSuccessfulPageVerificationRecovery`
(`services/notification-incidents.ts:791-836`), reached from
`admin/pages/:label/verify`, `PATCH …/credentials`, CLI `page verify`, and a
successful sync chunk. **`POST /api/v1/admin/sync/blocks/resume` does NOT clear
an auth block** — `resumePageSync` (`page-sync.ts:2938-2950`) moves an
auth-paused stream `paused → blocked`, the same trap decision #249 fixed for
`manual_action_required`.

**Automatic renewal: none.** The custody descriptor says so —
`registry.ts:182-187`: "Capture/refresh mechanics deliberately unspecified
(owner-flagged custody area)."

**"Session dead" surfaces:** Telegram incident `auth_blocked` → "🚨 Auth failed"
(`notification-incidents.ts:80-81,123-142`); `GET /api/v1/health/sync` maps the
blocked stream to `failed` → `issues:["failed_streams"]` → page `degraded`
(`sync-status.ts:976-990`, `health.ts:251,291-293,322`); `connections.ts:83-97,115-126`
classifies the connection `expired` from an auth substring on the last failed
`light` run. **Caveat:** if *every* block ends up `paused`,
`allSupportedBlocksPaused` (`health.ts:246`) suppresses the connection/staleness
issues — only the one still-`blocked` stream keeps the page degraded. Dashboard
copy: `sync-ux.ts:180-189` ("Reconnect to resume sync", `requiresAction:true`).

### 4.5 Egress: Fansly is NOT on the Stage-26 resolver

`apps/runtime/src/services/egress/resolver.ts:54-120`. `vendor:"fansly"`
**throws by construction** (`:59-63`); `vendor:"ofapi"` is hub-direct
(`:83-89`); `page` scope resolves the stored proxy and **throws
`ProxyMissingError` when a Fansly page has none** (`:100-106`). Its only three
callers are `telegram.ts:151`, `voice-notes.ts:879`,
`service-egress-verify.ts:64` — **none of them Fansly**. Fansly platform traffic
goes down a parallel path: `resolvePageContext` → `{proxy, egressKey}` →
`FanslyRequestContext` (`packages/fansly/src/types.ts:8-20`) →
`FanslyAdapter.getDispatcher(context.proxy)`.

Fail-closed is belt-and-braces: page context opens a `proxy_missing` incident
*before* throwing (`page-context.ts:278-295`), the adapter throws
`FanslyProxyMissingError` deliberately **not** subclassing `FanslyApiError` so
the executor treats it as a blocker, never a provider retry
(`adapter.ts:2158-2166`, `packages/fansly/src/errors.ts:13-23`).

**Schemes:** `http:`, `https:`, `socks5:` only
(`packages/shared/src/proxy.ts:5,80-107`; `proxy-string.ts:5,36-40`). A bare
`host:port` silently becomes **`socks5://`** (`proxy-string.ts:4,27-33`). SSRF
guard rejects loopback/private/link-local/multicast/ambiguous-numeric
(`proxy.ts:297-315`, with octal/hex handling `:145-177` because `new URL` does
not canonicalize `socks5://` hosts). In practice socks5: the service proxy is
validated socks5-only, no inline creds, explicit port
(`proxy-string.ts:106-131`; `.env.production.example:132-135`), and the Fansly
page-proxy fixtures are `socks5://…:1080`. Proxy **type**
(residential/mobile/datacenter) is neither recorded nor validated — FANSLY-007.

**HTTP client:** npm `undici@7.27.2`, **no global dispatcher is ever set** —
every call passes `dispatcher:` explicitly
(`packages/shared/src/http-client.ts`). `buildDispatcherOptions()` sets
**`connections: 1`**, `pipelining: 1`, keep-alive 10 s/60 s (`:33-43`).
`createProxyRequestDispatcher` (`:129-140`): `socks5:` → a plain undici `Agent`
with a custom `connect()` that dials `SocksClient.createConnection({command:"connect",
type:5})` and TLS-wraps for `https:` (`:60-101`), bypassing undici 7's own
`Socks5ProxyAgent`; otherwise `new ProxyAgent({uri, token: Basic …})`.

### 4.6 **Could an outbound WebSocket use the same egress? Mechanically yes — verified in the installed undici.**

1. `ws` is **not** a dependency anywhere. `playwright@^1.60.0` **is** already in
   `apps/runtime/package.json:27`.
2. npm undici exports a `WebSocket` whose init dictionary takes **`dispatcher`**
   and **`headers`** —
   `node_modules/.pnpm/undici@7.27.2/node_modules/undici/lib/web/websocket/websocket.js:709-724`;
   the handshake is dispatched through it at
   `lib/web/websocket/connection.js:92-96`.
3. `wss:` is rewritten to `https:` before dispatch
   (`connection.js:31`); fetch sets `upgrade:'websocket'`
   (`lib/web/fetch/index.js:2162`) and takes the socket in `onUpgrade`
   (`:2373`).
4. `ProxyAgent` establishes a CONNECT tunnel for an `https:` target
   (`lib/dispatcher/proxy-agent.js:182-219`), so the 101 rides inside it.
5. The custom SOCKS5 agent works too — its only customization is the `connect`
   hook, which already TLS-wraps for `https:` (`http-client.ts:86-95`).
6. `buildFanslyRequestHeaders(session, pathname)` can be reused verbatim for the
   handshake headers.

**Three real caveats:**

- **`connections: 1`** (`http-client.ts:34`). One long-lived upgraded socket
  would consume the whole pool of the per-proxy **cached** dispatcher
  (`adapter.ts:294`) and starve every REST call on that proxy. A WS lane needs
  its **own** dispatcher instance built from the same `ProxyConfig`.
- **Two undici instances.** `globalThis.WebSocket` in Node is Node's *internal*
  undici copy with an independent global dispatcher. The WS lane must
  `import { WebSocket } from "undici"` — the same module that built the agent.
- **The fail-closed guard does not cover WS.** `adapter.ts:2158-2166` guards one
  method. A WS path with no explicit `if (!proxy) throw` would fall back to
  `getGlobalDispatcher()` = **direct from the VPS IP** — precisely the model-ban
  risk decision #124 exists to prevent — and **no static check would catch it**
  (see §4.7).

**What a WS lane would bypass** (all currently on the `fetch` path only):
`executeObservedRequest`'s attempt loop and telemetry
(`packages/shared/src/http-request.ts:43-103`); the daily physical-attempt clamp
`context.remainingAttempts` (`adapter.ts:1990-1991`, decision #235); pacing
`waitForRateLimit` (`adapter.ts:2004,2212-2231`); envelope/auth classification
(`adapter.ts:2042-2144`) — **so `isAuthError` would never fire for a WS auth
rejection and a new death signal is required**; `sync_http_attempts` rows and
`page_sync_states` progress; the 30 s abort timeout, meaningless for a
persistent socket.

Journaling WS frames as observations needs a **migration**:
`observations_source_check` currently allows only
`webhook | pull | client_capture | readthrough | command_result | operator | ofapi_capture`
(`packages/db/src/schema.ts:3391-3393`, last rewritten in
`packages/db/migrations/0098_ofapi_capture_correctness_plane.sql:470-471`).
`backlog.md:531-535` says the same.

### 4.7 Ratchets and lint walls a WS path trips (or evades)

| gate | mechanism | verdict for a WS lane |
|---|---|---|
| `scripts/check-raw-fetch.mjs` | `grep -rnE "(^\|[^.\w$])fetch\(" --include=*.ts apps/runtime/src packages` minus `services/egress/` lines (`:20-36`); fails if count > `scripts/raw-fetch-budget.json` `budget: 10` (`:43-47`) | **Does NOT police WebSocket construction** — the regex matches `fetch(` only. Replacing the adapter's fetch would *lower* the count and the script would ask you to ratchet the budget down. Also: it runs from `tests/egress-resolver.integration.test.ts:361-369`, i.e. **not in `pnpm test:unit`** |
| ESLint `no-restricted-syntax` undici wall | `eslint.config.mjs:90-97` bans value/dynamic `undici` imports; allowlist is a three-path block at `:157-161` (`services/egress/**`, `packages/shared/src/http-client.ts`, `packages/fansly/src/adapter.ts`) | `import { WebSocket } from "undici"` **fails lint** anywhere else; the WS lane must live in `services/egress/`, be re-exported from `shared/src/http-client.ts` (the existing `undiciRequest` pattern, `:9`), or add a fourth allowlist entry |
| `scripts/check-platform-branches.mjs` + `platform-branch-budget.json` | counts `platform ===` outside adapter packages; run from `tests/platform-registry.test.ts:83` | a Fansly-only WS lane branching on platform in shared code bumps it; budget may only decrease |
| auth-declaration gate | `tests/contracts-auth-declarations.test.ts` (a **unit test**, not lint — `eslint.config.mjs:11-12`) | any new mutation route must declare auth in `packages/contracts/src/routes.ts` |
| adapter conformance | `checkAdapterConformance` at `registry.ts:125-141,231-237` | a stream in `SYNC_STREAMS` with no handler is a **boot crash** |


---

## §1.5 WHO CONSUMES THE PROJECTIONS

Two write paths with very different blast radii:

- **Path A — direct-write streams** (`light, transactions, top_spenders,
  subscribers, followers, followers_reconcile, dm_conversations, dm_messages,
  fan_earnings, purchase_history`): the handler journals the raw payload and
  **writes the projection table inside the same chunk**. Latency floor = the
  stream cadence.
- **Path B — capture-only lanes** (`posts, stats_snapshot, notifications,
  catalog, post_replies, payouts, media_stats`): the handler journals
  observations only; the minutely `canonicalize.sweep`
  (`apps/runtime/src/services/canonicalize-driver.ts:124`) appends domain events
  and the minutely `MESSAGE_ARCHIVE_SWEEP_QUEUE` runs `runProjectionTick`
  (`apps/runtime/src/worker-services.ts:443-462`, budget
  `PROJECTION_TICK_BUDGET_MS = 600_000` at
  `apps/runtime/src/services/projections/registry.ts:551`, rotation at `:576-600`).
  Latency floor = cadence **+ ≥2 min** of sweep.

Authoritative projection→table list: `apps/runtime/src/services/projections/registry.ts:137-390`.
The DM thread table is named **`page_dm_threads`** (`packages/db/src/schema.ts:1185-1186`)
even though the repository functions say `…PageDmConversation…`.

Latency key: **HOT** = a human or an AI reads it within minutes of the fact;
**WARM** = an owner opens a panel ad hoc; **BATCH** = daily/periodic;
**DEAD** = no production reader found.

| projection | fed by (path) | consumers | latency |
|---|---|---|---|
| **`page_dm_threads`** | `dm_conversations` (A, 30 min) | Workboard signals `packages/db/src/repositories/workboard-v2.ts:130,148,406,537,746,809,836,849,1052`; closing classifier `:731,746`; dashboard chat preview `page-dm.ts:1473` → `services/conversations.ts:110` → `modules/conversations/index.ts:93` (`pageConversationPreview`, `contracts/src/routes.ts:6547`) → `apps/dashboard/src/components/page/workboard/v2/WorkboardV2Row.tsx:82`, `components/shared/ChatPreviewPanel.tsx:119`; Agent Read Plane `agent-read.ts:217,285,302,394,477,494,533`, dataset `dm_threads` `agent-dataset-map.ts:1042`; agent hydration `agent-hydration.ts:313,332,352` | **HOT** |
| **`page_dm_messages`** | `dm_messages` (A, **24 h**) | workboard quality signals `workboard-v2.ts:148`; closing candidates `:731`; preview/messages `page-dm.ts:1413-1530`; AI transcript union **(OnlyFans only)** `ai-transcript-union.ts:109-118`; agent transcript `agent-transcript.ts:240-272`; retention pruner `services/page-dm-retention.ts` | HOT surface, **BATCH freshness** |
| **`message_archive`** | `dm_messages` → `sync-pull` (B) → `registry.ts:139-152` | **AI generation context** `modules/ai/context/index.ts:286`; Agent Read Plane `agent-read.ts:286,1013`, `handlers-threads.ts:838,858,887,1436`; `archiveSearch`/`archiveConversationMessages` `modules/conversations/index.ts:125,139` (`routes.ts:7414,7429`) — **no dashboard consumer**; analytics `analytics/models/response_sla.sql:12,18` | **HOT** on the agent/AI lane |
| `dm_message_archive` | OFAPI only — **not Fansly** (`docs/generated/10-ofapi-projections.md` §8); `handlers-threads.ts:158` marks it `onlyfans_only` on Fansly scopes | — | n/a |
| `dm_message_daily_aggregates` | rebuilt hourly `services/ofapi-dm-analytics.ts:29` | only `tests/dm-analytics.integration.test.ts` | **DEAD** |
| `page_dm_message_sync_health` | `dm_messages` (A) | `/health/sync` Fansly-only branch `services/health.ts:313-320`; backfill targeting `sync/targeted-thread-backfill.ts` | **HOT** (ops) |
| **`fans` / `page_fans`** | `subscribers`, `followers`, `dm_conversations`, `transactions` (A) | workboard row set `workboard-v2.ts:209-210,243`; **AI prompt context** `modules/ai/context/index.ts:241,278,296`; dashboard `pageDeletedFans` → `DeletedFansPage.tsx:24`, `pageFanDetail` → `apps/dashboard/src/api/pages.ts:257`; spenders v2 `spenders.ts:418,552,878,1082`; agent `agent-read.ts:310,408-421,527,596,611`, datasets `agent-dataset-map.ts:1026,1071` | **HOT** |
| `fan_username_aliases` / `page_fan_aliases` | `subscribers`/`followers` (A) | agent resolve `agent-read.ts:372,379,584,587`; dataset `:1186`; spenders `spenders.ts:844` | **HOT** (id resolution) |
| **`transactions`** | `transactions` (A, 1 h) | dashboard revenue/tx `modules/finance/index.ts` → `apps/dashboard/src/api/overview.ts:17`, `api/pages.ts:61,152`, `OverviewPage.tsx:143`, `PageDetailPage.tsx:138`; workboard value/urgency `workboard-v2.ts:100,111`; **AI spending block** `modules/ai/context/index.ts:197-204`; Telegram daily report `services/telegram-report.ts:349-395` (deliberately not `revenue_daily`, comment `:360-362`); agent `agent-read.ts:401,535,703,712,1042`, datasets `:1096,1118`; analytics `net_revenue_daily.sql:19`, `fan_ltv.sql:14`; spender projections `spenders.ts:94` | **HOT** + BATCH |
| `transaction_tip_contexts` | `dm_messages` sidecar `sync/fansly-tip-contexts.ts` (A) | agent dataset `tip_transactions` `agent-dataset-map.ts:274,1121,1126` (declares an `internalCaptureGap` for Fansly) | **HOT** (the `hub` skill's "что написал фан к типу") |
| `revenue_daily`, `daily_subscribers`, `daily_followers` | rebuilt from transactions/audience `repositories/transactions.ts:372,403` | `modules/finance/index.ts:409,440`; `services/reporting.ts:728,805` → `PageDetailPage.tsx:106,113`; agent dataset `followers_daily` `:1170` | WARM |
| **`fan_spend_daily` / `fan_spend_lifetime`** | rebuilt from transactions `spenders.ts:53,104,212` | **workboard value tier** `workboard-v2.ts:90,211,402,481,533`; spenders v2 → `api/pages.ts:330,345,362,378` → `TopSupportersPage.tsx:540`, `PageDetailPage.tsx:145`; agent `:1146`, `handlers-threads.ts:554-595` | **HOT** |
| `page_subscriptions` | `subscribers` (A, 1 h) | workboard `workboard-v2.ts:120`; dashboard `SubscribersPage.tsx:42-50`, `PageDetailPage.tsx:113,124`; agent `agent-read.ts:815,837,1098`, dataset `:1058` | **HOT** (expiry urgency) |
| `page_follows` | `followers`/`followers_reconcile` (A) | dashboard `FollowersPage.tsx:49`; agent timeline `agent-read.ts:1123`, dataset `:1160` | WARM |
| **`fan_earnings_stats`** | `fan_earnings` (A, **24 h**) → `registry.ts:167-178` | `GET /api/v1/pages/:pageLabel/top-spenders` `modules/audience/index.ts:126-174` (`routes.ts:6307`) reading `message-archive.ts:1586,1600,1622`. **No dashboard caller.** The only live consumer is the **Fansly extension's spenders board** — `~/code/goose/fansly-ext/src/background/spenders-service.ts:1-21`, `src/shared/constants.ts:93-97` | **HOT read, 24 h freshness floor** |
| `creator_posts` / `creator_post_tips` | `posts` (B) → `registry.ts:180-190` | agent datasets `posts`, `post_monetization`, `tip_goals`, `post_attachments`, `post_tips` `agent-dataset-map.ts:1219,1281,1303,1253,1300`; `agent-read.ts:770,789,1068` + `modules/agent-read/post-tip-view.ts`; **feedback loop:** `sync/fansly-post-replies.ts:465-470` seeds its walk queue from this table. No dashboard route | **HOT** (agent) |
| `post_comments` | `post_replies` (B) → `registry.ts:322-337` | dashboard `contentComments` (`routes.ts:8014`) → `modules/insights/index.ts:784-823` → `api/insights.ts:96` → `AnalyticsPage.tsx:93`; agent dataset `:1485` | WARM |
| `post_likes` | `notifications` (B) → `registry.ts:288-303` | same route `insights/index.ts:816`; agent dataset `:1510`. **Ships EMPTY on Fansly by design** (`routes.ts:5339`, `handlers-core.ts:140`) | WARM/empty |
| `platform_notifications` | `notifications` (B) | holdings census `fansly-insights.ts:656` + agent dataset `:1560` | WARM |
| media plane: `creator_media`, `creator_raw_media`, `creator_media_bundles`, `media_orders`, `message_media_offers`, `media_offer_locations` | `dm_messages` + `catalog` + `posts` → `registry.ts:192-217` | `contentMedia` (`routes.ts:8000`) → `insights/index.ts:680-696` — hook exists (`api/insights.ts:80`) but **no page imports it**; agent datasets `:1232,1247,1391,1477,1553`; **feedback loop:** `sync/fansly-media-stats.ts:848-894` seeds its refresh queue from `creator_media`. `media_offer_locations` has **no reader** | WARM / one DEAD |
| `creator_vault_albums`(+`_members`,`_scans`) | `catalog` (B) → `registry.ts:339-358` | `insights/index.ts:691`, `fansly-insights.ts:709`; agent dataset `:1553`; **feedback loop:** `sync/fansly-catalog.ts:560,848,879,921` drives the vault walk from them | WARM |
| stats plane: `stats_traffic_buckets`, `stats_top_media`, `stats_top_tags`, `fansly_media_tag_stats`, `platform_tag_daily` | `stats_snapshot` + `media_stats` (B) → `registry.ts:219-286` | dashboard `statsTraffic/statsMedia/statsTags` (`routes.ts:7946,7960,7974`) → `insights/index.ts:368-585` → `api/insights.ts:22-67` → `AnalyticsPage.tsx:88-91`; agent datasets `:1362,1394,1416,1438` | BATCH |
| `revenue_mix_daily` / `revenue_month_totals` | `stats_snapshot` (B) | `moneyRevenueMix` (`routes.ts:8028`) → `insights/index.ts:881-943` → `AnalyticsPage.tsx:94`; agent dataset `:1456` | BATCH |
| `page_broadcasts`, `page_polls`, `page_poll_options`, `page_recap_stats` | `stats_snapshot` (B) → `registry.ts:245-259` | written by `repositories/fansly-stats.ts:760,832,865,912`; **no reader anywhere** | **DEAD** |
| `page_subscription_tiers`/`_tier_plans`, `page_walls`, `page_automated_messages` | `catalog` (B) | `insights/index.ts:692-695`, `fansly-insights.ts:762,790,831,874` (no dashboard page mounts it); agent dataset `:1601` | WARM (agent) |
| `page_payout_requests` / `page_payout_methods` | `payouts` (B) → `registry.ts:360-377` | `moneyPayouts` (`routes.ts:8042`) → `insights/index.ts:944-1000` — **no dashboard hook exists**; agent dataset `:1622` | WARM (agent) |
| `capture_coverage` (operational, not rebuildable — `registry.ts:626-637`) | every capture lane (`sync/shared.ts`, `fansly-stats.ts`, `fansly-lane.ts:295-316`) | `statsCoverage` (`routes.ts:7988`) → `insights/index.ts:586-679` → `AnalyticsPage.tsx:92`; **every insights response embeds it** (`insights/index.ts:394,443,549,696,823`); `agentCoverage` + dataset `:1625`, `handlers-core.ts:147` | WARM (honesty panel) |
| `subject_refresh_state` (operational — `registry.ts:638-657`) | `media_stats`, `post_replies`, `notifications` | read **by the capture lanes themselves** to schedule the next fetch: `fansly-media-stats.ts:894`, `fansly-post-replies.ts:489`, `projections/fansly-engagement.ts`, `projections/fansly-comments.ts` | internal, HOT for scheduling |

**Three consumer facts that change the design:**

1. **Fansly AI generation does NOT read hub DM projections.**
   `apps/runtime/src/modules/ai/features/index.ts:345-351` *requires* the
   `clientContext` path for Fansly and states the reason: "The Stage 32
   deviation is Fansly-motivated (no webhook lane; the kernel archive is
   pull-cadenced)"; the extension pushes transcript/spend/subscription itself
   (`:376-386`). The only hub read on the Fansly AI lane is the `fan_profiles`
   dossier (`:474`, `modules/ai/context/fan-profile.ts:1`).
   **Moving Fansly to push is the precondition for reversing that deviation.**
2. **No Fansly SSE consumer exists.** `/api/v1/events/v2/stream` is consumed only
   by the OnlyFans desktop (`~/code/goose/of-desktop/packages/shared/src/protocol/index.ts:438`);
   `~/code/goose/fansly-ext` calls only `login`, `logout`,
   `authIssueDeviceToken`, `ingestObservations`, `ai/features`, `top-spenders`.
3. **The capture-scheduling feedback loops are projections.** `creator_media` →
   the media_stats queue, `creator_posts` → the post_replies queue,
   `creator_vault_albums` → the vault walk. Any new ingestion source must keep
   filling those, or three lanes lose their work queue.


---

## §5. HEALTH / OBSERVABILITY — what a push source must plug into

### 5.1 Health routes

| route | registration | auth | handler |
|---|---|---|---|
| `GET /api/v1/health` | `apps/runtime/src/modules/ops/index.ts:405-407` | **public** (`contracts/src/routes.ts:5445-5452`) | `getSystemHealth`, `services/health.ts:127-182` |
| `GET /api/v1/health/sync` | `ops/index.ts:413-414` | `monitoring` token **or** dashboard session (`routes.ts:5464-5472`) | `getPublicSyncHealth`, `services/health.ts:184-395` |
| `GET /api/v1/ops/metrics` | `ops/index.ts:426-431` | `monitoring` (`routes.ts:5454-5462`) | `getGoldenSignalsReport`, `services/golden-signals.ts:367-395` |

`/health` (`routes.ts:242-253`) reports only `contractHash`, `capabilities`, and
a `select 1` DB probe — **it says nothing about ingestion** (`health.ts:135-181`).

`/health/sync` (`routes.ts:271-291`) returns thresholds + an `overall` block
(`runningStreams, failedStreams, stalledStreams, pendingStreams,
recentFailedRuns, recent429s, recent5xxs`) + per-page rows.
It **503s** on any degraded page or any failed/stalled stream globally
(`health.ts:322,367-376`). Per-page `issues` codes (`health.ts:265-320`):
`connection:<status>`, `connection:ofapi_auth`, `light_sync_missing|stale`,
`follower_sync_missing|stale` (Fansly only), `failed_streams`, `failed_tasks`,
`stalled_streams`, `<stream>:retry_wedged` (≥10 consecutive failures,
`health.ts:23,101-117`), `projection_debt`,
`dm_messages:coverage_degraded` (`health.ts:313-320`, Fansly-only, backed by
`page_dm_message_sync_health`).

**Deploy gates** (`scripts/deploy-production.sh`): `wait_for_api_health:930-945`
(HTTP 200 + `"checks"`, called `:1572`); capability match `:1465-1468,1573-1574`;
`wait_for_worker_health:950-970` / `wait_for_scheduler_health:976-996`
(60×3 s `docker inspect`); `wait_for_sync_health:998-1022` — accepts **200 or
503**, only requires `"pages"` in the body, 6 attempts, **150 s per attempt**
(the comment at `:1003-1009` records why a shorter cap rolled back a healthy
stack); skipped when `HEALTH_SYNC_MONITORING_TOKEN` is unset (`:1589`).
Container healthchecks: api → `/api/v1/health` (`docker-compose.production.yml:47-58`);
scheduler → health-file mtime < **150 s** (`:81-92`); worker → mtime < **90 s**
plus a live `select 1` (`:115-126`); the file is written **only after** a
successful heartbeat DB upsert (`services/runtime-heartbeat.ts:140-145`).

### 5.2 Incidents

The table is **`notification_incidents`**, not `sync_incidents`
(`packages/db/src/schema.ts:373-402`, DDL `migrations/0000_baseline.sql:242-257`).
`incident_key text UNIQUE` (`schema.ts:377`) is the only uniqueness — it is a
**latch**. Key shapes (`services/notification-incidents.ts:37-61`):
`${kind}:global`, `${kind}:global:${subKey}`, `${kind}:${pageId}`,
`${kind}:${pageId}:${stream}` (the last only for `stream_failed_threshold`).
`platform_account_id` is **nullable** (`schema.ts:380-381`).

**20 kinds** (`schema.ts:234-257`; TS union
`packages/db/src/repositories/notifications.ts:17-37`; zod `routes.ts:3011-3032`;
dashboard labels `apps/dashboard/src/pages/notifications/NotificationsIncidentsTab.tsx:12-32`):
`auth_blocked, proxy_failed, proxy_missing, stream_failed_threshold, ofapi_auth,
ofapi_low_credit, ofapi_webhook_silence, ofapi_burn_rate, db_disk_usage,
observations_partitions, wrong_transactions_writer, read_gateway_capture,
golden_signal_lag, scheduler_silent, ops_sampler_silent,
ofapi_chargebacks_reconcile_failed, ofapi_link_stats_reconcile_failed,
ai_provider_billing, ai_provider_failed, capture_payload_parity`.

Latch core `openNotificationIncidentInternal` (`notifications.ts:260-449`,
advisory xact lock `:92-99`, `FOR UPDATE` `:321-330`, transitions
`opened|reopened|existing|suppressed`). **Telegram sends on `opened`/`reopened`
only** (`notification-incidents.ts:340-351`, resolve `:493-501`), gated on
`settings.enabled && settings.syncFailureAlertsEnabled` (`:336-338`) — so **the
latch IS the cooldown**: a standing condition hits `existing` and sends nothing.
The dashboard tab is `/notifications` (`apps/dashboard/src/App.tsx:64`) via
`notificationsIncidents` (`routes.ts:7833-7842`) and
`notificationsResolveIncident` (`:7844-7855`), handlers `ops/index.ts:1711-1780`.
(Decoy: `/dev/incidents` → `adminIncidents` `routes.ts:7778-7787` aggregates
`sync_run_events`, not incidents.)

### 5.3 Golden signals (#96 → migration 0067, #130 → 0080)

`services/golden-signals.ts`: queue `ops.metrics.sample` (`:35`), cron
`* * * * *` registered by the **scheduler** (`:80-85`, `schedules.ts:87`),
consumed by the **worker** (`:397-407`, `worker-services.ts:551`), samples to
`ops_metric_samples` (`schema.ts:1568-1575`), 90-day retention (`:38`), pruned
hourly (`:282`).

| metric | source | line | threshold |
|---|---|---|---|
| `capture` | `ofapi_webhook_events` received→processed | `:127-133` | 60 s |
| `canonicalize` | `domain_events` ⋈ `observations` | `:136-143` | 180 s |
| `projection` | `projection_seq_watermarks` ⋈ `domain_events.account_seq > high_seq` | `:147-162` | 180 s |
| `command_settle` | `ofapi_commands` | `:165-171` | 300 s |
| `sse_delivery` | `domain_events_smoke_checkpoint.updated_at` staleness | `:178-190` | 600 s |
| `capture_pending_age` | unprocessed `ofapi_webhook_events` | `:195-200` | 600 s |
| `command_queued_age` | queued `ofapi_commands` | `:202-207` | 900 s |
| `notification_outbox_age` | `notification_delivery_outbox` | `:209-214` | 300 s |
| `acceptance_events_1h` | `ai_acceptance_events` | `:218-223` | gauge |
| `ai_content_rows/bytes` | `ai_generation_content` | `:228-234` | 5 GB |
| **`obs_backlog_<source>_<lane>_v<N>`** | `observations` below each family's parse floor | `:240-248` | **600 s each** |

Latch semantics `:290-359`: a breach **or a failed probe** opens
`golden_signal_lag:global:<metric>`; under-threshold resolves; **no sample
leaves the latch untouched** (absence is never health).

### 5.4 Freshness surfaces

- Page-level: `pages.last_light_sync_at` / `last_follower_sync_at`
  (`schema.ts:319-320`) via `listConnectionStatuses`
  (`services/connections.ts:146-200`), classified by `classifyConnectionStatus`
  (`:99-134`, `STALE_THRESHOLD_HOURS = 9` at `:35`).
- **Per-stream: `page_sync_states.succeeded_at`** (`schema.ts:652`, index
  `page_sync_states_freshness_idx (stream, succeeded_at)` `:681`), written only
  by `completePageSync` (`page-sync.ts:2387`). The `freshnessSlaSeconds` SLA is
  consumed **only** at `services/sync-status.ts:1029-1039` → state `delayed`,
  reason `stale`. **It pages nobody** — what pages is
  `stream_failed_threshold` at 3 consecutive failures
  (`notification-incidents.ts:18,617`).
- Cursors/watermarks: `page_sync_cursors` (`schema.ts:698-722`),
  `projection_seq_watermarks` (`:3852-3866`), `domain_event_seq` (`:3456-3462`),
  `ofapi_fanout_replay_state.replay_floor` (`:3227`), `subject_refresh_state`
  (`:5662-5693`), `capture_coverage.cursor/next_probe_at` (`:5486,5492`).
- `capture_coverage` (`migrations/0132_statistics_core.sql:708-763`,
  `schema.ts:5469-5501`): PK `(page_id, platform, plane, scope_ref)`,
  `plane` is **free text** with only `length > 0` (`0132:732`); written inline by
  the lanes (`sync/fansly-lane.ts:294-315`, upsert
  `repositories/fansly-stats.ts:987-1027`), **no recompute job**, explicitly
  excluded from projection rebuild as operational state
  (`projections/registry.ts:368-393`).
- **The only existing push-silence detector** is global, not per page:
  `ofapi_webhook_silence`, default **720 min**
  (`services/ofapi-account-health.ts:47,184-209`), run minutely from the OFAPI
  sweep (`services/ofapi-events.ts:503`, cron `:256`).

### 5.5 Gap / sequence-hole counting

`createAccountSeqGuards().advance` (`services/domain-events-stream.ts:47-62`,
`seq > last + 1` = gap; projection-checkpoint variant `:78-97`). The counter is
`recordGap` (`services/domain-events-smoke.ts:91-113`), persisted to
`domain_events_smoke_checkpoint.gap_count` / `duplicate_count` (`:59-70`) and
surfaced on `/api/v1/ops/metrics` (`golden-signals.ts:372-393`,
schema `routes.ts:4869`). Replay floor:
`ofapi_fanout_replay_state.replay_floor`
(`migrations/0094_event_replay_continuity.sql:15`), advanced at
`repositories/ofapi.ts:1275-1281`, enforced in the SSE route
`modules/events/index.ts:279-296,965`. `listDomainEventReplayContinuityGaps`
(`repositories/domain-events.ts:522`) is **dead code**.

### 5.6 What a Fansly push source has to plug into, ranked by cost

1. **`observations` (mandatory, DP 7).** `source` is `text` with a **CHECK
   constraint enumerating 7 values** (`schema.ts:3391-3393`, last widened in
   `migrations/0098_ofapi_capture_correctness_plane.sql:470-476`) → **a new
   source value is a migration** (next number **0150**; `0149` is the latest on
   disk — the CLAUDE.md line saying "next after 0117" is stale, take the number
   by listing the directory at PR time).
2. **Golden signals — free once (1) is done.** Add a `HealthFloorDescriptor` to
   `HEALTH_FLOOR_REGISTRY` (`services/health-floors.ts:75-85`) and the source
   automatically gets an `obs_backlog_<source>_<lane>_v<N>` gauge, a 600 s
   threshold (`:32`), an incident latch and an `/ops/metrics` series — **no
   schema change, no route change.** This is the best-designed extension point.
3. **Incidents — connection state and silence.** `platform_account_id` is
   nullable and 8 kinds are already page-less (`GlobalIncidentKind`,
   `notification-incidents.ts:736-748`); `subKey` gives unbounded free-text
   sub-latches inside a kind with **zero DDL**, so "connection down for page N"
   is expressible today. A **new kind** costs a migration
   (`ALTER TYPE notification_incident_kind ADD VALUE`, pattern
   `migrations/0124_capture_payload_refs.sql:107-108`) plus four hand-maintained
   mirrors and two exhaustive switches (`notification-incidents.ts:79-120,150-215`).
4. **`capture_coverage` — open by construction** (new `plane` string, no DDL),
   but its semantics are "how far back does this plane reach", not "when did it
   last succeed", and the writer helper hardcodes `platform: "fansly"`
   (`sync/fansly-lane.ts:312-314`).

**Does freshness key off `page_sync_states` only? Yes.** `/health/sync`'s
per-stream blocks, the insights coverage route and the agent-read `sync_streams`
dataset all read it directly (`sync-status.ts:7,1568`;
`modules/insights/index.ts:590-635`; contract comment "read straight off
`page_sync_states`" at `routes.ts:5134-5136`). **There is no generic
ingestion-source abstraction.** Non-poll sources are already handled by
*hardcoded per-block override functions* —
`overrideMessagesLiveBlockWithOfapiIngest` (`sync-status.ts:1386-1440`, which
swaps `succeededAt` for the age of the last settled `messages.*` journal event)
and `overrideFinancialsBlockWithOfapiTruth` (`:1443+`). **A Fansly WebSocket
source should follow that precedent** — a third override — rather than writing
a fake `page_sync_states` row: `stream` is a closed pg enum (`schema.ts:639,128-161`)
needing its own migration (`migrations/0142_sync_stream_media_stats.sql:17-31`),
`SYNC_STREAM_POLICY` is a **total** `Record<SyncStream, …>` (`page-sync.ts:175`)
so a new value is a type error without a policy entry, `cadence_seconds` /
`slot_offset_seconds` are NOT NULL with no default (`schema.ts:663-664`), and
the planner would keep scheduling a "stream" that has no cadence.

---

## §7. BROWSER / RUNTIME / WHERE A LONG-LIVED CONNECTION LIVES

### 7.1 Playwright: yes, `apps/runtime` only

`playwright: ^1.60.0` — `apps/runtime/package.json:27`. Not in the root
`package.json`, not in `apps/dashboard`, not in any `packages/*`.
Two importers, both a dynamic `await import("playwright")` behind a string
variable so nothing statically binds it:

1. `services/onlyfans-public-profiles.ts:115-123` →
   `PlaywrightOnlyFansPublicProfileResolver` `:125-267`: headless Chromium,
   cookie-free context, blocks image/media/font, **per-page proxy** via
   `buildPlaywrightProxy` `:102-113`, request spacing, 25 s timeout `:10`.
   Documented at `docs/generated/10-ofapi-projections.md:221-227` and
   `23-boundaries-catalog.md:79`. **Currently unwired** —
   `createOnlyFansPublicProfileResolver` (`:269-274`) has no call site outside
   its own file; its flags were removed in W8.2/A30/#133
   (`packages/shared/src/config-settings.ts:252-255`).
2. `services/telegram-report-image.ts:124-130`, `renderDailyRevenueReportImage`
   `:150-172` — launch-per-render PNG of the daily revenue card, called from
   `services/telegram-report.ts:18`.

Both run in the **worker**. Chromium is baked into the image for all three
roles: `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` (`Dockerfile:80`) and
`playwright/cli.js install --with-deps --only-shell chromium` (`:97`),
smoke-tested in CI (`.github/workflows/ci.yml:61`) and pinned by
`tests/compose-config.test.ts:96-101`.

> Note for FANSLY-004: the installed browser is **Chromium shell only**. The
> backlog's plan says *Firefox* (`backlog.md:508`), which is a second browser
> download and a bigger image.

### 7.2 Long-lived-connection libraries: none

**No `ws`, no `socket.io`, no `eventsource`, no `sockjs`** in any
`package.json` or in the lockfile importers block. A repo-wide grep for
`WebSocket|socket.io|EventSource` across `apps/`, `packages/`, `scripts/`,
`tests/` returns only comments (`services/events-stream.ts:42`,
`tests/audit-artifacts/sse-b3-sim.ts:59,89`).

What exists instead:

- **`undici ^7.27.2`** (`apps/runtime/package.json:29`,
  `packages/shared/package.json:12`, `packages/fansly/package.json:10`) — used
  only for HTTP dispatchers (`Agent`, `ProxyAgent`, `buildConnector` at
  `packages/shared/src/http-client.ts:1`). undici 7 **does** ship a `WebSocket`
  that takes a `dispatcher` (see §4.6); nothing uses it today.
- **`socks ^2.8.9`** (`apps/runtime/package.json:28`).
- **Hand-rolled server-side SSE**, three endpoints:
  `modules/events/index.ts:200` (sync frames), `:629` (domain-event frames), and
  the AI gateway pump `modules/ai/index.ts:361`. Fastify `reply.hijack()` + raw
  writes (`events/index.ts:197-232`), `retry: 3000`, backpressure drop at
  `SSE_MAX_BUFFERED_BYTES` (`:226-230`).
- **Long-lived Postgres LISTEN connections** — `createDomainEventHub`
  (`services/domain-events-stream.ts:104+`): one shared LISTEN client
  (`listen domain_events_appended` at `:345`; the notify is emitted inside the
  append transaction, `packages/db/src/repositories/domain-events.ts:450`),
  notify = wake-up only, serialized drain, watermark advanced only after
  broadcast, exponential reconnect 1 s → 30 s (`:20-24`). **This is the existing
  in-repo template for "one durable connection with reconnect + resume".**

### 7.3 Roles and single-instance guarantees (#96)

`apps/runtime/src/startup.ts`: `resolveRole()` `:42-51` reads `argv[2]` →
`AGENCY_HUB_ROLE` → default `worker`, rejecting anything outside
`api|worker|scheduler`; migrations run first (`:15-28`, serialized by advisory
lock `(31415,27182)`), then dispatch `:70-79`; top-level `process.exit(1)` `:87`.

| role | entry | pg-boss | registers |
|---|---|---|---|
| api | `api-runtime.ts:6-46` | enqueue-only, `schedule:false` | Fastify + routes, heartbeat `:23`, **`startOpsWatchdog` `:26`** |
| worker | `worker-runtime.ts:7-44` | `schedule:false` `:11` | `startWorkerServices` — sync planner + executor, OFAPI workers, sweeps, golden-signal sampler, **`startDomainEventsSmokeConsumer` `worker-services.ts:548`** |
| scheduler | `scheduler-runtime.ts:18-81` | `schedule:true` `:37` — the only timekeeper | `registerAllSchedules` `:53` (`services/schedules.ts:41-92`) |

**Leader election:** `acquireSchedulerLeadership`
(`services/scheduler-leader.ts:35-115`) — session-scoped
`pg_try_advisory_lock(58212, 1)` (`:8-9,54-57`), standby retries every **10 s**
(`:10`), the pg client stays pinned for the whole leadership. A second scheduler
simply never acquires and idles as a hot standby
(`scheduler-runtime.ts:26-32`); a leader that **loses** its lock session exits
with `process.exit(1)` rather than risk double-firing cron
(`scheduler-runtime.ts:64-70`). Corpse-client destruction at
`scheduler-leader.ts:73-90`.

**Deadman:** `startRuntimeHeartbeat` (`services/runtime-heartbeat.ts:81-198`),
60 s (`:24`), row in `runtime_instances`, health file only after a successful
upsert (`:140-145`); a standby never heartbeats (`scheduler-runtime.ts:55-58`).
`runOpsWatchdogCheck` (`services/ops-watchdog.ts:35-74`): 60 s interval, 3 min
silence tolerance, 5 min boot grace (`:21-27`) → `scheduler_silent` /
`ops_sampler_silent`.

**Production replicas: 1 api, 1 scheduler, 1 worker** —
`docker-compose.production.yml:28,65,98`. `worker-2` and `scheduler-standby`
exist only as comments (`:60-64,94-97`); no `--scale` anywhere in
`deploy-production.sh`. `OFAPI_EVENT_WORKER_REPLICAS` is hard-pinned to 1 with a
startup guard (`services/ofapi-events.ts:391-398`, registry note
`packages/shared/src/config-registry.ts:167`).

### 7.4 Where one connection per page belongs

**The worker role**, unambiguously: it already hosts every long-lived in-process
consumer (`startDomainEventsSmokeConsumer`, `worker-services.ts:548`), already
exercises Chromium, and is the one role whose replica count is meant to scale.
The api must stay free for HTTP (its only long-lived duty is SSE fan-out plus
the watchdog); the scheduler is deliberately a bare timekeeper that exits on
lock loss.

Three exactly-one mechanisms already exist — **no new primitive is needed**:

1. **Session advisory lock (process-global singleton).**
   `acquireSchedulerLeadership` (`services/scheduler-leader.ts:35`, ns `58212`)
   and `acquireOfapiEventWorkerLock` (`services/ofapi-events.ts:407-446`,
   released via `startOfapiEventWorker` `:449-451`,
   `worker-services.ts:555,627-629`). A fresh namespace keyed by page id gives
   "one connection per page across the fleet". (The sync path already uses
   `pg_try_advisory_lock(43101, pageId)` — `sync/locking.ts:3,60-63`.)
2. **pg-boss `policy:"exclusive"` + `singletonKey = pageId`** — the established
   per-page pattern (`sync-queue.ts:78-86,313`;
   `sync/targeted-thread-backfill.ts:175-188,213`, whose comment at `:176-183`
   states the invariant: pg-boss singletons are per QUEUE, so the cross-queue
   half is enforced at run time by the page-busy lease check). Job expiry is
   15 min with 30 s `heartbeatSeconds`/`boss.touch`
   (`sync-queue.ts:19,81`; `executor.ts:1193`) — usable for a long connection
   only with an explicit re-lease loop.
3. **DB row lease with TTL + token (per page × stream)** —
   `acquirePageSyncLease` (`page-sync.ts:2031`), `heartbeatPageSyncLease`
   (`:2269`), `clearPageSyncLease` (`:2330`), `assertOwnedPageSyncLease`
   (`repositories/sync-context.ts:51-78`), `PageSyncLeaseLostError` (`:33`).
   TTL **120 s**, owner `sync-page-executor:${pid}`, random token
   (`executor.ts:72,519-521,573-577`). Every write inside a lane re-asserts the
   lease before touching the DB — the right shape for a connection that must
   fail closed on takeover.


---

## §2. INGESTION SUBSTRATE

> `docs/generated/*` was generated 2026-07-15 at `7df9a45` and is **stale** on
> this topic — it says 4 canonicalizer families; there are now **11 registered +
> 1 deliberately off-registry**. Everything below is read from source.

### 2.1 `observations`

Schema `packages/db/src/schema.ts:3344-3396`. Notable columns:
`id` bigint `GENERATED ALWAYS AS IDENTITY` (`:3348`), `source` (`:3349`),
`producer` (`:3350`), `platform` **no FK** (`:3352`), `account_id` **no FK by
design** so unmapped facts are still captured (`:3353`), `native_account_ref`
(`:3354`), `kind` (`:3355`), `payload` jsonb **nullable since 0128** (`:3361`),
`payload_hash` bytea NOT NULL (`:3364`), `idempotency_key` (`:3365`),
`observed_at` (`:3366`), `received_at` NOT NULL DEFAULT now() — **the partition
key** (`:3367`), `parse_version` int DEFAULT 0 (`:3369`),
`payload_bucket_month`/`payload_object_id` = the CAS reference (`:3373-3374`),
`harvest_machine_id`/`harvest_tx_*` (`:3381-3384`). PK `(id, received_at)` (`:3387`).

Indexes: `(account_id, received_at)` `:3388`, `(kind, received_at)` `:3389`,
`(parse_version, received_at)` `:3390`, the two harvest lookup indexes
(`migrations/0096_observations_harvest_lookup_concurrently.sql:9-15`,
`0126_observations_harvest_machine_typed_index.sql:37-43`), the CAS erasure
probe `(payload_bucket_month, payload_object_id)`
(`0127_capture_payload_ref_erasure_indexes.sql:51-52`), and the health-floor
index `(parse_version, source, kind, received_at)`
(`0144_observations_health_floor_idx.sql:54-55`). All of these use the
partitioned-parent dance: `create index … on only`, then `CREATE INDEX
CONCURRENTLY` per leaf, then `ATTACH PARTITION`.

CHECKs: `observations_source_check` (`schema.ts:3391-3393`);
`observations_payload_ref_check` — both CAS columns null or both set, NOT VALID
(`0124_capture_payload_refs.sql:81-84`);
`observations_payload_presence_check` — `payload IS NOT NULL OR payload_object_id
IS NOT NULL`, NOT VALID (`0128_capture_pointer_only_bodies.sql:78-80`).

**The `source` CHECK — all 7 values, verbatim** (`schema.ts:3333-3341`
`OBSERVATION_SOURCES`, SQL mirror `:3391-3393`):

```
'webhook','pull','client_capture','readthrough','command_result','operator','ofapi_capture'
```

| value | added by |
|---|---|
| `webhook`, `pull`, `client_capture`, `readthrough`, `command_result`, `operator` | `packages/db/migrations/0054_observations.sql:11-12` |
| `ofapi_capture` | `packages/db/migrations/0098_ofapi_capture_correctness_plane.sql:470-475` (`drop constraint` + `add constraint … not valid`) |

**`0098:470-475` is the exact precedent for adding a `fansly_push` source.**

**Idempotency is NOT content-hash based.** Dedup is the unpartitioned companion
`observation_keys`, PK `(source, idempotency_key)` (`schema.ts:3397-3408`,
`0054:44-50`). Protocol — `packages/db/src/repositories/observations.ts:107-241`:
`nextval` the id outside the tx (`:113-116`) → `insert into observation_keys …
on conflict do nothing returning observation_id` (`:150-155`) → a lost claim
re-selects the existing `(observation_id, received_at)` and returns
`inserted:false`, **partition-exact** so an immediate projector can address the
right row (`:157-171`) → else insert with `OVERRIDING SYSTEM VALUE` (`:211-238`).
Claim + journal are **one transaction** (`:121-141`); the rationale at `:8-14` is
that split across autocommit a crash left the key claimed with no row and the
fact was lost permanently. `payload_hash` is a fingerprint, not a dedup key; the
webhook lane enforces it separately (`assertObservationHash`,
`services/ofapi-webhook-capture.ts:26-41`).

**Partitioning:** `PARTITION BY RANGE (received_at)`, monthly (`0054:36`),
2026-01…2026-12 seeded (`0054:49-60`), far-future catch-all
`observations_future` FROM `'2031-01-01'` (`0082_w8_future_catchall_partitions.sql:22`).
Manager `services/observations-partitions.ts`: queue
`"observations.partitions.ensure"` (`:22`), cron `"10 3 * * *"` UTC (`:42`),
lead 3 months / floor 2 (`:24-25`), also maintains `domain_events` partitions
(`:57-60`), incident kind `observations_partitions` on failure (`:77-84`).
**A missing partition fails the insert loudly — never a silent drop** (`:1-6`).

**CAS catalog (#215-#221) and pointer-only mode.** Tables created by
`0123_capture_payload_objects.sql`, all `PARTITION BY RANGE (bucket_month)`:
`capture_payload_objects` (`schema.ts:4500-4560`), `capture_json_hot_bodies`
(`:4562-4579`), `capture_byte_hot_bodies` (`:4581-4601`),
`capture_payload_locations` (`:4603-4635`). Identity tuple
(`capture_payload_objects_identity_uniq`, **NULLS NOT DISTINCT**, `:4525-4531`):
`(bucket_month, platform_account_id, access_class, erasure_domain,
representation, codec_version, content_sha256, logical_bytes,
collision_ordinal)`. `representation ∈ ('canonical_json','exact_bytes')`
(`:4541-4543`); month is part of identity **by law** (ref-closed cohorts,
`0123:43-48`); a hash is not proof of equality, a differing body takes the next
`collision_ordinal` (`0123:50-57`). Codec:
`packages/db/src/capture-payload-codec.ts`, `CAPTURE_JSON_CODEC_VERSION = 1`
(`:27`), `CAPTURE_EXACT_BYTES_CODEC_VERSION = 0` (identity codec, `:34`).

Three live flags (`packages/shared/src/config-registry.ts`):
`captureCasDualWritePages` (`:331`, default `""` = off),
`captureCasReadMode` (`:332`, default `"inline"`),
`captureCasPointerOnlyPages` (`:333`, default `""`, flagged `destructive: true`
with the costWarning "THE ONLY FLAG IN THIS PROJECT A ROLLBACK DOES NOT UNDO").
All `runtimeApply: "live"` — they reach a process on the 60 s heartbeat, no
restart. CSV of page ids or `*`, one parser
(`services/capture-cas-dual-write.ts:144-182`).

**Pointer-only, precisely:** the row's `payload` is SQL NULL and the body is
addressed by `(payload_bucket_month, payload_object_id)` → `capture_payload_objects`
→ `capture_json_hot_bodies` / `capture_byte_hot_bodies`, enforced by the 0128
CHECK. Writer accepts `payloadRef` (`observations.ts:76`) and
`omitInlinePayload` (`:90`, ignored unless the ref is live, `:210`); decision
#222's liveness lock `lockCapturePayloadRefAlive` under `FOR KEY SHARE` drops
the ref and writes the inline body if the object vanished (`:206-209`,
returning `payloadRefVanished`, `:104-105`).
**Only the pull lane is wired to CAS today** (`sync/shared.ts:111-116,133,139-140,172-174`);
webhook, ingest, read-gateway and command-result do not dual-write.
Read seam `services/payload-reader.ts` — modes `inline|shadow|serve` (`:187`),
fail-open to inline, `CapturePayloadUnavailableError` (`:221`) only for a
pointer-only row whose catalog copy is unreachable; a NULL inline body resolves
from the catalog **in every mode** (`:64-71`).
Historical rewrite (#221): `capture_rewrite_runs` (0129) + four owner-gated CLI
commands (`apps/runtime/src/cli.ts:940,994,1029,1098`).

### 2.2 `domain_events`

Schema `schema.ts:3414-3441` (`0057_domain_events.sql:12-32`; `post_ref` added by
`0120_creator_posts.sql:10`): `account_id`, `account_seq`, `type`, `occurred_at`,
`fan_identity_ref`, `conversation_ref`, `message_ref`, `transaction_ref`,
`post_ref`, `data` jsonb, `schema_version`, `observation_id` (**no FK**,
`0057:8-9`), `dedup_key`, `created_at`. PK `(id, occurred_at)`.
Indexes `(account_id, account_seq)` `:3438`, `(type, occurred_at)` `:3439`.
Companions: `domain_event_keys` PK `(account_id, dedup_key)` (`:3443-3454`),
`domain_event_seq` PK `account_id`, `next_seq` default 1 (`:3456-3462`).

**Gapless per-account sequence** —
`packages/db/src/repositories/domain-events.ts:267-455`:
upsert the seq row (`:273-276`) → **`select next_seq … FOR UPDATE`** (`:277-281`,
*this row lock is the serializer, held for the whole batch*) → per event
`nextval` id (`:350-353`), claim `domain_event_keys … on conflict do nothing`
(`:355-360`), insert with `nextSeq` (`:378-399`), `nextSeq += 1` (`:400`) →
update the seq row (`:442-445`) → `pg_notify('domain_events_appended',
'<accountId>:<highWater>')` **in the same transaction** (`:449-451`).
A lost claim never advances `nextSeq`, so the sequence is gapless under any
worker concurrency.

**Dedup semantics:** new ⇒ `{dedupKey, eventId, appended:true}` (`:376`);
existing ⇒ `deduped += 1` and the **existing** event id is re-selected and
returned with `appended:false` (`:361-374` — "a resolution, not a black hole").
One special case ahead of the claim: `resolveSubscriptionObservationReplay`
matches `(account_id, observation_id, type, occurred_at)` for
`subscription.started|renewed` only (`:305-326,339-348`).

Three append entry points: `appendDomainEvents` (`:179`),
`appendProjectionOnlyDomainEvents` (`:193`, throws on a deliverable type),
`appendMixedDomainEvents` (`:224`, throws when projection-only types arrive
without a checkpoint). Mixed batches are reordered deliverables → hidden →
checkpoint (`:408-439`); the checkpoint type is `stream.projection_checkpoint`
with `data.hiddenCount` (`:426-435`).

**There is no single enumeration of all event types.** Three partial registries:
(1) `PROJECTION_ONLY_DOMAIN_EVENT_TYPES` — `domain-events.ts:56-159`, 46 types,
the only hard-coded list, whose SQL twin is **derived** from the set (`:169-172`);
(2) deliverable types are deliberately open on the wire —
`type: z.string().min(1)` with "clients MUST tolerate unknown types"
(`packages/contracts/src/routes.ts:3462-3465`); (3) the consumer side,
`ProjectionDefinition.eventTypes` (`services/projections/registry.ts:107-131`).

**Partitioning:** `PARTITION BY RANGE (occurred_at)`, monthly, plus
`domain_events_pre_2024` FROM MINVALUE (`0057:29,57`) and a future catch-all
(0082). Because `occurred_at` is a **provider** timestamp, the driver runs a
partition gate before any write and clamps out-of-range dates (§2.3).

### 2.3 Canonicalizer registry and sweep

Registry `apps/runtime/src/services/canonicalize/index.ts:120-245` — a flat
readonly array; registration = appending an object literal; dispatch is a
**linear scan, first match wins** (`familyForObservation`, `:247-259`), so
**array order is semantics** for `source:"pull"` (comments `:135-137,161-163`).
Interface at `:68-118`; canonicalizer signature at `canonicalize/types.ts:48-51`
(pure, total over its declared kinds).

All 11 registered families, in order:

| # | source | lane | ver | kinds | flags | index.ts |
|---|---|---|---|---|---|---|
| 1 | `ofapi_capture` | `ofapi-posts` | 8 | `ofapi.posts_page.v1` | `minimumParseVersion:7`, `replayContext:"accepted_posts"`, `projectionOnly` | 121-126 |
| 2 | `webhook` | `ofapi` | 3 | 16 (`ofapi-webhook.ts:30-47`) | deliverable | 127-133 |
| 3 | `pull` | `posts` | 8 | `posts`,`post_tips` | `canParse`,`parseRejection`,`projectionOnly` | 134-146 |
| 4 | `pull` | `sync` | 5 | 5 (`sync-pull.ts:52-62`) | **`mixed:true`** | 147-156 |
| 5 | `pull` | `stats` | 2 | 11 | `canParse`,`parseRejection`,`projectionOnly` | 157-170 |
| 6 | `pull` | `engagement` | 1 | `notifications` | `canParse`,`projectionOnly` | 171-183 |
| 7 | `pull` | `catalog` | 3 | 10 | `canParse`,`projectionOnly` | 184-197 |
| 8 | `pull` | `comments` | 1 | `post_replies` | `canParse`,`projectionOnly` | 198-213 |
| 9 | `pull` | `payouts` | 1 | `payout_methods`,`payout_requests` | `canParse`,`projectionOnly` | 214-228 |
| 10 | `command_result` | `result` | 1 | **`null`** (prefix `command.`) | — | 229-235 |
| 11 | `client_capture` | `desktop` | 2 | 13 | zero events by design | 238-244 |

**Off-registry deliberately:** `FANSLY_REPLAY_FAMILY`
(`canonicalize/fansly-replay.ts:634-648`, v1, kinds `followers, subscribers,
dm_conversations, account_me`, `projectionOnly`) — kept off the array because
registration would put flag-gated backfill on the unflagged minutely sweep
(`:24-29`); passed explicitly at `services/fansly-replay.ts:418-419`.

`lane` is version-independent and **is** the ops metric series:
`healthFloorName = obs_backlog_${source}_${lane}_v${version}`
(`services/health-floors.ts:48-50`), and `HEALTH_FLOOR_REGISTRY` is **derived**
from `CANONICALIZER_FAMILIES` (`health-floors.ts:75-85`) — a new family gets its
gauge for free.

**The sweep** — `services/canonicalize-driver.ts`: queue `"canonicalize.sweep"`
(`:34`), policy `exclusive` (`:112-114`), cron `"* * * * *"` UTC (`:124`),
worker `batchSize:1` with `useSweepCursor:true` and `maxDurationMs: 600_000`
(`worker-services.ts:381-395`), `SWEEP_PAGE_SIZE = 200` (`:51`),
`SWEEP_MAX_PAGES_PER_FAMILY = 20` (`:52`).
Row selection `listObservationsForReplay` (`domain-events.ts:975-1055`):
`parse_version < $belowParseVersion` (`:999`), optional
`>= $atLeastParseVersion` (`:1000`), `source =` (`:1002`), `kind in` (`:1005`),
`order by o.id asc` (`:1035`, every column qualified — the CLAUDE.md alias trap),
returns `payloadRef` for the CAS seam (`:1050-1053`).
Per row (`:450-599`): resolve the body through the read seam **before** the shape
gate (`:467`) → `canParse` (`:472-492`) → `canonicalize()` +
`clampDraftOccurredAt` (`:504-507`) → resolve account (`:510-513`) → partition
gate (`:534-537`) → append, 3-way dispatch (`:555-559`) →
`markObservationParsed`, forward-only (`:563-567`, SQL at
`domain-events.ts:1061-1070`).
`occurredAt` clamp: min 2024-01-01 (`:70`), max now + 2 months (`:71,73-77`);
out of range ⇒ `occurredAt = receivedAt` plus `data.occurredAtClamped` and
`data.occurredAtRaw` (`:84-106`); **dedup keys are built before the clamp** so
replay identity is stable (`:82-83`).

**Sweep cursor (#130):** `sweepCursors: Map<string, number|null>`, module-level
and **in-memory** (`:268`), key `` `${source}:${kinds?.join(",") ?? "*"}:v${version}` ``
(`:275`), written with **wrap-to-head**
`sweepCursors.set(key, reachedEnd ? null : afterId)` (`:612`). A *second*
rotation cursor `sweepFamilyRotationKey` (`:301`, `rotateFamilies` `:309-319`,
updated `:710-716`) exists because the wall-clock budget made registry order a
priority order and the WP-F families at the tail never got a turn. Both are lost
on restart (one head pass, `:266-267`). Only the minutely sweep uses them; CLI
runs are cursor-free. Rotation is safe **only** because same-`source` families
claim disjoint kinds (`:295-299`).

**Is canonicalization a per-observation job or a sweep? Both — but never a
pg-boss job per observation.** Three non-sweep paths call the same
builders + clamp + append + stamp:
1. inline in the OF posts capture job (`services/ofapi-capture-jobs.ts:548-577`,
   which is why family #1 declares `minimumParseVersion: 7` — rows below v7
   belong to the inline path and the sweep only replays v7→v8);
2. inline message material (`ofapi-capture-jobs.ts:987-1001` →
   `services/ofapi-message-material.ts:141-168`);
3. off-sweep drainers on their own tick —
   `runOfapiCaptureMaterialization` (`services/ofapi-capture-materialization.ts:158-206`)
   and `runOfapiDmReadthroughReconcile` (`services/ofapi-dm-readthrough.ts:362+`),
   both registered as `OFF_SWEEP_OBSERVATION_CLAIMANTS`
   (`services/observation-kinds.ts:567-593`).

**Not inline:** the ingest route (`services/ingest-observations.ts:177-219`,
insert only) and the **webhook receiver** (`ofapi-webhook-capture.ts` never calls
`markObservationParsed`) — so the `webhook/ofapi` family is **sweep-only, up to
~60 s from ack to domain event**.

**Failure modes** — all leave the row **unstamped**, i.e. retried next sweep:
`canParse` false ⇒ `skippedUnparseable` + ≤20 diagnostic samples (`:472-492`);
drafts>0 with no account ⇒ `skippedUnmapped`, self-heals when the mapping lands
(`:520-525`); `DomainEventTargetMonthsUnattachedError` ⇒ `partitionBlocked` +
one anomaly per (family, month) (`:573-577,360-384`);
`CapturePayloadUnavailableError` ⇒ `skippedUnavailable` (`:586-593`); anything
else ⇒ `errored` (`:594-598`); a family-level throw isolates to that family
(`:702-708`). `afterId` advances before the row loop for fault isolation
(`:448,459-462`). A row yielding **zero** drafts is stamped even when unmapped —
which is why cross-platform kinds must scope `accountIds`
(`domain-events.ts:983-990`).

**`projection_debt` (#137) is NOT part of canonicalization.** Schema
`schema.ts:751-769` (partial unique `(kind, conversation_id) WHERE resolved_at
IS NULL` at `:765-767`; `0085_projection_debt.sql:16-32`); repo
`packages/db/src/repositories/projection-debt.ts` (kind constant
`"page_dm_thread_summary"` `:12`, `recordProjectionDebt` `:36-49`,
`listUnresolvedProjectionDebt` `:51-92`, `resolveProjectionDebt` `:96-107`).
Writers: `sync/executor-handlers.ts:4150-4177` (a dm_messages finalize/checkpoint
failure), `sync/targeted-thread-backfill.ts:544-556`, and the sweep itself
(`projection-debt-sweep.ts:86-96`). Drainer
`services/projection-debt-sweep.ts:47-101`, queue `"projections.debt.sweep"`
(`:21`), cron `"*/5 * * * *"` (`:39`), batch 20 (`:23`). Reader
`services/health.ts:205-208,310-312`.
**Canonicalization's own "debt" is just `observations.parse_version` plus the
in-memory sweep cursors — nothing durable.**

**Two different watermark tables, do not conflate:**
- `projection_watermarks` (`schema.ts:1914-1923`, `0000_baseline.sql:399-403`) is
  the **spender rebuild timestamp** table (PK `platform_account_id`,
  `last_rebuilt_at`), aliased `spenderProjectionWatermarks` (`schema.ts:2327`),
  written `spenders.ts:194-201`, read `:323-331`.
- `projection_seq_watermarks` (`schema.ts:3854-3866`,
  `0059_message_archive.sql:49-56`) is the real per-account event cursor:
  PK `(projection, account_id)`, `high_seq` = last consumed
  `domain_events.account_seq`. Helpers `getProjectionWatermark` /
  `setProjectionWatermark` (`repositories/message-archive.ts:410-434`); rebuild
  deletes the watermark in the same transaction as the truncate (`:444-466`).

Replay CLI: `events:replay` (`apps/runtime/src/cli.ts:1854-1928`, flags
`--kind --from --to --account --parse-version --dry-run`, pre-flight partition
refusal `:1876-1898`), `fansly:replay` (`:1798-1846`).
**A version bump alone triggers replay** on the next minutely tick — no CLI
needed (`canonicalize/index.ts:1-6`, `canonicalize-driver.ts:1-7`).

### 2.4 `POST /api/v1/ingest/observations`

Contract `packages/contracts/src/routes.ts:5521-5532`, **`auth: {kind: "apiKey"}`**
(`:5522`). Body `ingestObservationsBodySchema` (`:1833-1835`): `events` array,
**min 1, max 100**. Event schema (`:1825-1831`): `clientEventId` **uuid**,
`kind` string **1..120**, `observedAt` ISO, `payload` record,
`pageLabel?` 1..120. Response `{accepted, duplicates}` (`:1837-1841`).
Handler `apps/runtime/src/modules/ingest/index.ts:45-89`:
**`bodyLimit: 1_048_576` bytes** (`:47`),
**`rateLimit: {max: 120, timeWindow: "1 minute"}`** (`:48-53`),
`requireApiKeyUser` (`:56`), **`x-client-version` header required** else 400
`missing_client_version` (`:57-64`), a `harvest-*` version additionally requires
a device token (`requireHarvestDeviceToken`, `:66-68`), page scope = owner ⇒ null
(unrestricted) else `principal.assignedPageIds` (`:74`).
**Age caps: none** — `parseObservedAt` only rejects `NaN`
(`services/ingest-observations.ts:90-96`).

Accepted kinds (`services/ingest-observations.ts`):
`INGEST_KIND_ALLOWLIST` (`:26-33`) = `ai_acceptance, guard_audit, send_audit,
ai_spend, credit_spend, data_purge_notice` → journaled as `desktop.<kind>`;
`HARVEST_KIND_ALLOWLIST` (`:39-47`) = `harvest.messages, harvest.fan_transactions,
harvest.outbox, harvest.message_guard_events, harvest.usage_events,
harvest.ai_spend_log, harvest.credit_log` → journaled verbatim, producer-gated;
anything else → `desktop.unknown:<kind>`, **never dropped** (`ingestKindFor` `:70-78`).

`client_capture` identity: `source: "client_capture"` (`:199`), producer
`desktop@<ver>` or `desktop-harvest@<ver>` (`:56-60`), idempotency key
`` `${authorizedHarvestMachineId}:${clientEventId}` `` for trusted harvest else
`` `${principalUserId}:${clientEventId}` `` (`:206-208`).
**#145 machine binding:** the machine id is derived server-side from the
device-token row (`modules/ingest/index.ts:76`) and every trusted harvest
payload's `payload.machineId` must equal it, else 400 (`:132-141`).
Page label resolved once per batch; unknown/out-of-scope ⇒ **null account**
(`:146-158`); harvest resolves `payload.ofapiAccountId` against
`pages.ofapi_account_id` instead (`:167-176`). The whole batch is **one
transaction** (`:178`).

**Adding a NEW kind on this route — the exact checklist:**

1. `services/ingest-observations.ts:26` or `:39` (the allowlist). Without it the
   kind still journals, as `desktop.unknown:<kind>` (`:77`), invisible to every
   family.
2. `services/observation-kinds.ts:41+` — add
   `{kind, source: "client_capture", writer: …}` to `WRITTEN_OBSERVATION_KINDS`.
3. **Claim it**, one of: `canonicalize/client-capture.ts:32`
   (`CLIENT_CAPTURE_CANONICALIZED_KINDS`) **plus a bump of
   `CLIENT_CAPTURE_CANONICALIZER_VERSION` at `:27`** (the bump is what replays
   already-stamped history); or `observation-kinds.ts:416+`
   `RAW_ONLY_OBSERVATION_KINDS` with a justification **> 40 chars**; or a new
   `OFF_SWEEP_OBSERVATION_CLAIMANTS` entry (`observation-kinds.ts:567`).
4. If it emits events that must not reach SSE clients: add every type to
   `PROJECTION_ONLY_DOMAIN_EVENT_TYPES` (`domain-events.ts:56`) **and** set
   `projectionOnly`/`mixed` on the family — "ONE decision, never two"
   (`canonicalize/index.ts:101-117`). Add a `ProjectionDefinition` if a
   projection consumes it (`projections/registry.ts:138`).

Pins that fail if you skip a step — `tests/observation-kind-coverage.test.ts`:
"claims every written kind, and names WHO claims it" (`:114-124`); "every
allowlist entry is a written kind, justified, and not already family-claimed"
(`:126-149`, justification ≤40 chars fails); "every dynamic rule and off-sweep
claimant carries a written reason" (`:193-202`); the **census** "knows every
namespaced kind literal any direct insertObservation writer uses" (`:248-265`,
greps `DIRECT_WRITERS` at `:90-107`); the census "pins the set of files that
write observations.kind directly" (`:301-314`); "registers EVERY subscribed
OFAPI webhook event" (`:267-299`); "registers no kind twice" (`:110-112`).
The honest limit is stated at `observation-kinds.ts:10-21`: this is a
**CI-enforced registry, not a type system** — the typed write seam was deferred
(A28-7), so `tsc` cannot reject an unregistered literal.

**If a new `source` is needed** (not just a kind), add:
5. `schema.ts:3333` (`OBSERVATION_SOURCES`) + `:3391-3393` (the drizzle CHECK mirror);
6. a migration dropping and re-adding `observations_source_check` — copy
   `0098_ofapi_capture_correctness_plane.sql:470-475`;
7. `canonicalize/index.ts:69` — widen the `source` union;
8. contract changes ⇒ `pnpm contracts:generate` ⇒ `node scripts/vendor-sdk.mjs …`;
   `tests/contracts-auth-declarations.test.ts:22` requires a valid `auth` block.

Nothing else: the health-floor gauge, the partition manager, retention (DP 7)
and erasure reach are all automatic once the kind is registered and claimed.

### 2.5 The OFAPI webhook pipeline end-to-end (#48, #149)

**Receiver.** Path `"/api/v1/ofapi/webhook"` (`modules/ingest/index.ts:108`),
contract `routes.ts:5552-5567` with **`auth: {kind: "hmac"}`** (`:5553`;
`"hmac"` in the enum at `:4618`; the middleware short-circuits to ALLOW with no
principal — `apps/runtime/src/api/auth-policy.ts:90`).
**No rate limiter, on purpose** — `modules/ingest/index.ts:102-107`: "a 429 here
drops signed deliveries BEFORE the journal — OFAPI stops retrying after 5
attempts". It has its **own plugin scope with the repo's only buffer-mode body
parser** (`:93-100`); the raw `Buffer` reaches the handler at `:112`.
HMAC — `services/ofapi-webhooks.ts:83-95`: hex HMAC-SHA256 over the **raw bytes**
(`:92`), `/^[0-9a-f]{64}$/i` (`:69`), `timingSafeEqual` (`:94`); rotation across
current + `previous` + `pending` secrets (`:130-141`), decrypted via
`decryptJsonWithKeyVersion` (`:97-102`); no registration ⇒ 503 (`:122-125`).
Order (`:113-196`): config → HMAC → idempotency header (max 255 chars, `:70`;
missing/oversized ⇒ quarantine under `invalid-identity:<sha256hex>` and **ack
200**, `:153-161`) → `captureOfapiWebhookRaw` (`:166-176`) → best-effort
`boss.send` (`:179-193`) → `{received:true, duplicate}` (`:195`).
19 subscribed event strings at `ofapi-webhooks.ts:47-67`.

**Journal table** `ofapi_webhook_events` — `schema.ts:3151-3219`, created by
`migrations/0027_ofapi_webhook_receiver.sql:27-48`, i.e. it **predates** the
`observations` journal (0054). Columns include `idempotency_key`, `event_type`,
`ofapi_account_id`, `platform_account_id`, `payload`, `raw_body`, `payload_hash`,
`capture_headers`, `capture_state`, `sync_event`, `fanout_seq`, `status`,
`projection_status`/`archive_status` + attempts, `received_at`, `processed_at`.
Vocabularies: `status ∈ pending|processed|skipped|failed` (`:3149-3150`),
`capture_state ∈ raw_captured|accepted|quarantined_malformed` (`:3208-3210`),
`projection_status ∈ none|pending|projected|skipped|failed` (`:3172-3176`).
Dedupe index `ofapi_webhook_events_idempotency_uniq` UNIQUE(idempotency_key)
(`:3190`, `0027:40`); sequence `ofapi_webhook_events_fanout_seq` (`0027:25`);
companion `ofapi_fanout_replay_state` (`:3223-3240`,
`0094_event_replay_continuity.sql:13-31`).

**The observation written alongside** — `services/ofapi-webhook-capture.ts`, in
the **same transaction** as the journal state change:

| path | source | producer | kind | idempotency key | lines |
|---|---|---|---|---|---|
| accepted | `webhook` | `ofapi:webhook` | the raw vendor `event` string | the vendor key, verbatim | 160-169 |
| invalid identity | `webhook` | `ofapi:webhook-raw` | `ofapi.webhook.invalid_identity` | `<key>:quarantine` | 81-95 |
| malformed | `webhook` | `ofapi:webhook-raw` | `ofapi.webhook.malformed` | `<key>:malformed:<sha256hex>` | 126-139 |
| fact conflict | `webhook` | `ofapi:webhook-raw` | `ofapi.webhook.fact_conflict` | `<key>:fact-conflict:<sha256hex>` | 235-250 |

Envelope schema is three fields — `{event, account_id?, payload}`
(`services/ofapi-payloads.ts:11-15`).

**pg-boss fan-out** — `services/ofapi-events.ts`: queues
`ofapi.events.process.v2` (`:62`), `.sweep` (`:63`), `.cleanup` (`:64`);
process queue `policy:"exclusive"`, `retryLimit: 2`, `retryDelay: 30`,
`retryBackoff: true`, **no `expireIn`** (`:232-245`); send with
`singletonKey: String(eventId)` (`:260-269`); sweep cron `"* * * * *"`, cleanup
`"30 2 * * *"` (`:256-257`); worker `batchSize: 100`, **no teamSize**, jobs
re-sorted by eventId and processed **serially** (`:454-467`, `sortOfapiEventJobs`
`:85-89`). **Single replica asserted** — `assertOfapiEventWorkerSingleton`
throws unless `OFAPI_EVENT_WORKER_REPLICAS === 1` (`:391-398`; config marked
`editability: NEVER` at `config-registry.ts:167`) — plus an advisory lock
`pg_try_advisory_lock(58211, 1)` (`:78-79,407-446`) taken before any `boss.work`
(`:451`). Sweep recovery re-enqueues `pending` rows older than 30 s, cap 200
(`:76-77,357-371`). Retention default 36 500 days (`:71-73`).
Processing `processOfapiWebhookEvent` (`:281-355`): finalize `raw_captured`
first, early-return if not pending, invalid envelope ⇒ `failed` no retry,
unmapped account ⇒ `skipped`, else **settle + `pg_notify` in one transaction**
(`:336-353`). Only infrastructure errors reach pg-boss retry (`:271-279`).

**Canonicalizer family** `webhook`/`ofapi` — `canonicalize/ofapi-webhook.ts`,
version **3** (`:28`), 16 claimed kinds (`:30-47`; `users.typing` and
`chat_queue.*` are journaled but unclaimed ⇒ `default: return []`):

| kind | emitted type | dedupKey |
|---|---|---|
| messages.received/sent | `message.received` / `message.sent` | `msg:<direction>:<messageId>` |
| messages.deleted | `message.deleted` | `msg:deleted:<messageId>` |
| messages.ppv.unlocked | `message.ppv_unlocked` | `ppv:<notificationId>` |
| tips.received | `tip.received` | `tip:<notificationId>` |
| transactions.new | `transaction.posted` | `txn:<transactionId>` |
| subscriptions.new/renewed | `subscription.started` / `.renewed` | `sub:<phase>:<fanId>:<ISO>` |
| users.online/offline | `presence.online` / `.offline` | `presence:<state>:<fanId>:<ISO>` |
| accounts.* (6) | `account.auth_changed` | `auth:<status>:<ISO>` |

All `schemaVersion: 1`; deliverable family ⇒ plain `appendDomainEvents`
(`canonicalize-driver.ts:559`).

**pg_notify → SSE, two channels:**
- **`"ofapi_sync_events"`** (`repositories/ofapi.ts:22`) — NOTIFY inside the
  settle tx (`services/ofapi-events.ts:352`; also `replay-floor:<n>` from cleanup
  at `repositories/ofapi.ts:1290`). Listener `services/events-stream.ts` (`listen`
  `:267`, channel filter `:255-257`, **payload deliberately unused**, only
  `requestDrain()` `:258-262`). Route **v1 SSE** `GET /api/v1/events/stream`
  (`modules/events/index.ts:119`, `auth: apiKey`); SSE `id` = **`fanout_seq`**,
  assigned at **settle** time via `nextval` (`repositories/ofapi.ts:213-215`,
  rationale `:192-195`) so late settles land ahead of advanced cursors;
  `Last-Event-ID` replay with three 409 `sync_snapshot_required` conditions
  (`:140-179`).
- **`"domain_events_appended"`** (`repositories/domain-events.ts:458`) — one
  NOTIFY per (account, batch) on commit, payload `<accountId>:<highWater>`,
  advisory only. Listener `services/domain-events-stream.ts` (`listen` `:345`,
  filter `:324`); projection-only types advance the drain but never enter client
  buffers (`:121-126`). Route **v2 SSE** `GET /api/v1/events/v2/stream`
  (`modules/events/index.ts:456`; contract `routes.ts:5612-5639`,
  **`auth: {kind:"any"}`**, "Per-account gapless ordering; **all platforms**"
  `:5617`); `id` = an opaque per-account watermark cursor; lanes
  `event: domain` / `event: ephemeral` (no id) / `event: control`
  (`replay_completed`, #178).

**Dedupe / replay / ordering — three independent layers:** journal
`(idempotency_key)` → observation `(source, idempotency_key)` → domain event
`(account_id, dedup_key)`.
Duplicate delivery ⇒ `claimOfapiWebhookRaw` `on conflict do nothing`
(`repositories/ofapi.ts:85-131`) ⇒ **200 with `duplicate:true`**.
Same key, different bytes ⇒ an `ofapi.webhook.fact_conflict` observation +
`logger.error`, still a 200 (`ofapi-webhook-capture.ts:234-262`).
Duplicate processing ⇒ `settleOfapiWebhookEvent` is guarded on
`status='pending'` and the loser skips the NOTIFY (`ofapi-events.ts:346-350`).
Out-of-order ⇒ arrival order sets `id`, but the SSE cursor is `fanout_seq`
assigned at settle, so a retried/swept event lands *ahead* of advanced cursors
rather than becoming invisible (`0027:5-8`, `schema.ts:3144-3147`); that
determinism relies on the single replica + advisory lock + intra-batch sort.
**v2 has no such constraint** — `account_seq` is allocated at append under the
per-account row lock.
Gaps: v1 uses `ofapi_fanout_replay_state.replay_floor` and retention deletes only
a **contiguous prefix** — a recent/pending/failed row blocks every later frame
(#149, `repositories/ofapi.ts:1225-1292`); v2 answers 409
`sync_snapshot_required` with per-account detail (`modules/events/index.ts:520-528`).
Canonicalization gaps self-heal: an unmapped account leaves the row unstamped and
it is retried every sweep (`canonicalize-driver.ts:520-525`).

### 2.6 ASSESSMENT — what a Fansly push source can reuse

**Directly reusable, platform-agnostic:**

1. **The `observations` journal + insert protocol**
   (`repositories/observations.ts:107-241`) — zero vendor coupling; `source`,
   `producer`, `platform`, `native_account_ref`, `idempotency_key` are all
   caller-supplied.
2. **The canonicalizer registry and sweep** — adding a family is appending one
   object to `canonicalize/index.ts:120` and widening the union at `:69`. The
   health-floor gauge is **derived** (`health-floors.ts:75-85`) — free. The sweep
   dispatches on `source` (`canonicalize-driver.ts:435`); nothing else changes.
3. **`domain_events` + gapless seq + `pg_notify` + v2 SSE** — never mentions a
   platform; the v2 contract literally says "all platforms" (`routes.ts:5617`)
   with `auth: any` (`:5613`), and Fansly `message.*` events already flow this
   way from the `pull/sync` family.
4. **Projection registry + `projection_seq_watermarks`** — the whole WP-F1…F7
   Fansly build (#224-#231) rides these unchanged.
5. **Partition manager, DP-7 retention, erasure reach** — automatic for any new
   source.
6. **CAS pointer-only storage** — `insertObservation` accepts
   `payloadRef`/`omitInlinePayload` from any caller (`observations.ts:76,90`),
   and `representation = 'exact_bytes'` with `codec_version = 0`
   (`capture-payload-codec.ts:34`) is exactly the right shape for verbatim WS
   frames. **But** the only wired producer today is the pull lane
   (`sync/shared.ts:111`) — a push lane needs its own ~30 lines of the same
   wiring.
7. **The `observation-kinds` ratchet and `events:replay`** — both source-generic.

**OFAPI-specific, do NOT copy:**

1. **`ofapi_webhook_events` and everything keyed on it** — `fanout_seq`,
   `sync_event`, `projection_status`/`archive_status`, `capture_state`,
   `ofapi_fanout_replay_state` (`schema.ts:3151-3240`). Its dedupe key is the
   vendor's `x-ofapi-idempotency-key` header; a WS frame has no such thing.
   **This table exists because it predates the observations journal**
   (migration 0027 vs 0054) and today the receiver writes *both*
   (`ofapi-webhook-capture.ts:149-171`). It is legacy weight, not a template.
2. **HMAC verification** (`ofapi-webhooks.ts:83-141`) — a page-context WebSocket
   has no signature; its authenticity comes from the session and the proxy.
3. **Account mapping via `pages.ofapi_account_id`** (`schema.ts:303`,
   `findPageByOfapiAccountId` at `ofapi-events.ts:305`). Fansly maps on
   `pages.external_page_id` (`schema.ts:299`). **Good news:** the canonicalize
   driver's `accountIdByNativeRef` is already keyed `` `${platform}:${ref}` ``
   and populated from **both** columns (`canonicalize-driver.ts:649-656`), so
   `platform:"fansly" + nativeAccountRef:<fansly id>` resolves out of the box,
   including before a mapping exists (`:510-513,520-525`).
4. **v1 SSE + the legacy `SyncEvent` frames** (`mapOfapiEventToSyncEvent`,
   `modules/events/index.ts:119`) — an OnlyFans-desktop contract.
5. **Credit metering** (`services/ofapi-credits.ts`) — vendor billing.
6. **Command-outbox coupling** — the Fansly adapter is read-only by construction
   (test-pinned, `adapter.ts:1390-1405`; FANSLY-006).
7. **The single-replica + advisory-lock worker** (`ofapi-events.ts:391-446`) — it
   exists *only* to keep v1 `fanout_seq` contiguous (`:387-390`). A Fansly push
   source has no v1 obligation and must **not** inherit it;
   `domain_event_seq`'s `FOR UPDATE` already serializes per account.

**Verdict: write to `observations` with a new `source`, not to a separate
journal table.**

Cost of a new source: `schema.ts:3333` + `:3391` (two constants); one migration
copied from `0098:470-475`; `canonicalize/index.ts:69` (union); kinds registered
in `observation-kinds.ts:41+`. Everything else — sweep dispatch, health gauge,
partitions, retention, erasure, CAS, `events:replay` — is automatic. The repo's
own backlog prescribes exactly this (`backlog.md:531-533`).

Cost of a separate journal table (what `ofapi_webhook_events` actually pays):
its own partitioning strategy, its own retention prefix logic (#149,
~60 lines of contiguous-prefix SQL at `repositories/ofapi.ts:1225-1292`), a slot
on `tests/retention-deleters.test.ts`'s sanctioned-deleter list, its own erasure
reach, its own health floor (it has none), a bespoke worker with a single-replica
constraint — **and a second write into `observations` anyway.**

**The precedent to copy is `ofapi_capture` (#205), not `webhook`.** It added a
source in `0098`, writes only observations, registers its kinds
(`observation-kinds.ts:186-222`), and where it needs sub-minute latency it
materializes **off-sweep on its own tick**
(`ofapi-capture-materialization.ts:158-206`) or **inline in the capture job**
(`ofapi-capture-jobs.ts:548-577`, guarded by `minimumParseVersion: 7`).
That answers the obvious objection — "the sweep is minutely, a push source must
be live": journal to `observations` **and** materialize inline, with the family's
`minimumParseVersion` handing replay of settled material back to the sweep.

**Genuinely new work, covered by no existing seam:** the egress capability for a
socket (§4.6); a raw-fetch/lint accommodation (§4.7); an idempotency-key design
(WS frames carry no vendor id — the natural shape is the pull lane's
`page:stream:run:seq` adapted to `page:connection:frameSeq` with a content hash
as the collision discriminator); a completeness story (a socket gives no replay
and no proof of absence, and `capture_coverage` treats "not proven" as not
covered); a process host (worker, §7.4); and **the frame format itself** —
`backlog.md:529` says "формат сокета в нашем коде не снят — сначала один HAR",
and a grep for `WebSocket|ws://|wss://` across `apps/runtime/src` and `packages`
returns nothing outside comments.


---

## §6. HIDDEN DEPENDENCIES ON POLLING CADENCE

Scenario assumed throughout: `dm_conversations` drops from 1800 s to ~21600 s
(6 h) while a push source supplies new messages.

### 6.0 Two landmines that are bugs, not policy questions

**L1 — raising `cadenceSeconds` wedges the planner, effectively forever.**
`last_scheduled_slot` is an **absolute** slot index
`floor((now − slot_offset) / cadence)` — `computeCurrentPageSyncSlot`,
`packages/db/src/repositories/page-sync.ts:1012-1019` (verified independently).
The cadence reconciler updates `cadence_seconds` **and**
`slot_offset_seconds` but **never rebases the slot counter**
(`page-sync.ts:1590-1611`), and the planner then does
`if (currentSlot <= row.lastScheduledSlot) continue`
(`page-sync.ts:1930-1933`, verified). At today's clock the stored slot under
1800 s is ≈ 993 000; the new 21600 s slot would be ≈ 82 800, so
`dm_conversations` **would never be scheduled again** (~600 years).
`nextDueAt` (`repositories/sync.ts:2419`, `services/sync-status.ts:266`) would
also render a nonsense far-future date. **Any cadence increase needs a migration
that resets `last_scheduled_slot` to `-1`.** The only writers are
`page-sync.ts:1413` and `:1944`.

**L2 — the DM freshness SLA is 3600 s, so a 6 h cadence means a permanent 503.**
`dm_conversations` carries `cadenceSeconds: 1800` **and**
`freshnessSlaSeconds: 3600` (`page-sync.ts:253-263`; the `messages_live` domain
repeats 3600 at `:468-473`). `services/sync-status.ts:1029-1039`: a
`succeeded_at` older than the SLA ⇒ `state="delayed"`, reason `"stale"`,
`needsAttention: true` (`:1067`) ⇒ the domain block goes delayed
(`:1122,1185-1200`) ⇒ `services/health.ts:257,299-301,322,376` ⇒ **HTTP 503**,
and the dashboard reads literally "Out of date"
(`apps/dashboard/src/pages/settings/sync/syncBlockDisplay.ts:596,620-621`).
`succeeded_at` is stamped only by the sweep executor; a push source never touches
it. **5 of every 6 hours red, on fresh data.**
Two notes: `SYNC_DOMAIN_POLICY.freshnessSlaSeconds` is **dead code** — only the
stream number is read; and this is not a deploy blocker, since
`scripts/deploy-production.sh:1012-1015` accepts `200|503`.

### 6.1 Silently wrong data — the dangerous class

| # | mechanism | file:line | trigger today | breakage under rare sweeps + push |
|---|---|---|---|---|
| 1 | **Destructive thread finalization has no time guard** — `markPageDmConversationsInvisibleByGeneration` hides `is_visible AND (last_seen_generation IS NULL OR < generation)` | `packages/db/src/repositories/page-dm.ts:247-264`, called `sync/executor-handlers.ts:3460-3465` once `membershipCertified` (`:3446-3459`) | the sweep is the only writer of `last_seen_generation` | a thread **created by push** carries `NULL` (the OF precedent writes `existing?.lastSeenGeneration ?? null` — `services/ofapi-dm-projection.ts:319`) and gets **hidden**. It then vanishes from every chatter list, the workboard, the dm_messages candidate query (`page-dm.ts:1097`), all coverage counters (`:1312-1338`) and hydration (`agent-hydration.ts:313-317` requires `is_visible`) for up to 6 h. The `monotonicGenerationSet` guard (`page-dm.ts:176-180`) protects *existing* rows (the #237 lesson) — **nothing protects a new row** |
| 2 | **The Fansly subscribers sweep lacks the guard the OF one has** — `deactivatePageSubscriptionsByGeneration` takes an **optional** `lastSeenBefore` | `packages/db/src/repositories/fans.ts:1076-1096`; OF caller passes it with an explicit "live-webhook rows carry a null generation (Audit P-25)" comment at `sync/ofapi-audience-sync.ts:524-538`; **the Fansly caller passes nothing** at `sync/executor-handlers.ts:1753-1756` | no live writer exists for Fansly today | any push-written subscription row would be deactivated by the next sweep. (Follows are safe: `deactivatePageFollowsByGeneration` always gets `lastSeenBefore: fullSweepStartedAt` and requires two stale generations — `fans.ts:645-657,1049-1072`, `executor-handlers.ts:2328-2331` — decision #237 as written) |
| 3 | **Thread head fields are sweep-only for Fansly** — `unread_count`, `last_message_at`, `last_message_sender_role`, `last_message_preview`, `last_unread_message_id` | written only by `fanslyDmConversationsChunk`, `sync/executor-handlers.ts:3302,3383` | 30 min staleness | this is **the entire needs-reply surface**: `modules/workboard/report.ts:53,65-70` is `last_message_sender_role`-driven, the SLA urgency driver uses `lastFanMessageAt` (`modules/workboard/engine.ts:275-279`), the closing-classifier candidate query uses all of them (`repositories/workboard-v2.ts:739-772`), plus the chatter list (`services/conversations.ts:146,190`). There is **no Fansly unread-drift reconcile** — OF has one by design (`ofapi-dm-projection.ts:276-282`) |
| 4 | **Workboard recompute fires on push and then reads stale columns** | `services/workboard-event-recompute.ts:28-36,46-70` subscribes to the `domain_events` LISTEN/NOTIFY hub with a 5 s per-fan debounce; nightly reconcile 03:00 UTC (`services/sync-queue.ts:287`) | recompute is already push-shaped | it fires promptly on a pushed message, re-reads the **unchanged** sweep-written head columns (`workboard-v2.ts:125-143`), scores the fan as still silent, and the drift counter stays clean. **Silent wrongness with a green dashboard** |
| 5 | **`dm_messages` is requested only from inside the conversations sweep** | `requestPageSync(..., streams:["dm_messages"])` at `sync/executor-handlers.ts:3583-3589`, gated by `shouldRequestDmMessagesFollowup` (`:287-312`) | every 30 min | a new thread's history backfill waits up to 6 h; `message_coverage_status` stays `pending_backfill` that whole time |
| 6 | **Push writing head + message makes a thread permanently ineligible for the message walk** | `selectNextPageDmMessageSyncCandidate` offers a conversation only when `last_message_id IS DISTINCT FROM newest_stored_message_id` or status is `pending_backfill` — `page-dm.ts:1054-1060,1110-1113` | the sweep re-opens the mismatch by re-reading the provider head | the OF push projection writes both in one transaction (`ofapi-dm-projection.ts:300-346`) so heads always agree — meaning **the 6 h backstop's entire value flows through that one path** |
| 7 | **The `complete` coverage proof assumes contiguity that push destroys** | `resolveDmConversationCoverageStatus` — `providerHistoryExhausted \|\| overlapFound ⇒ "complete"`, `sync/fansly-dm-messages.ts:39-63`; `overlapFound` = "one returned message is already stored" (`:257`); page size 25 (`:26`); incremental stops on overlap (`executor-handlers.ts:4074-4080`) | "already stored" always means "contiguously walked" | a push outage losing messages more than 25 below the head creates a hole the 6 h walk will **never** revisit: it sees 25 stored pushed rows, declares overlap, stops. The contract already admits the claim is weak (`packages/contracts/src/routes-agent.ts:1252-1257`) |
| 8 | **Every read plane reads `message_archive`, which push must reach through the journal** | Agent Read Plane `repositories/agent-read.ts:286,952,1013,1521,1621-1659`; AI transcript `modules/ai/context/index.ts:93-109` → `repositories/message-archive.ts:1429`; `message_archive` is fed **only** by the minutely projection off `domain_events` (`services/projections/message-archive.ts:45,67-128`; `backfillArchiveFromHotTable` is CLI-only, `cli.ts:2382`) | — | a push that writes only `page_dm_messages` is **invisible** to `hub transcript`/`search`/`person`/`timeline`, and `hub coverage` degrades to `capture_floor_unknown` (`modules/agent-read/epistemics.ts:180-183,286-288`). Also: no attached `domain_events` partition ⇒ the append is refused ⇒ silent loss (`canonicalize-driver.ts:380`) |
| 9 | **`fanSilenceDays` and the ping gate ride the same archive** | computed from the transcript array, not a column — `modules/ai/features/index.ts:422-441`, `modules/ai/prompts/transcript/ping-segment.ts:36-56`; gate at `features/index.ts:459-461` | 30 min / 24 h staleness | a stale archive both mis-states silence and **defeats `gate_ping_active`** — the model sends "hey stranger, it's been 6 days" to a fan who wrote 20 minutes ago. Push **through** the journal fixes this; push **around** it leaves it wrong for 6 h |
| 10 | **The contract documents today's cadence as the reason a whole feature exists** | `clientContext` is accepted **only for Fansly** (`modules/ai/features/index.ts:345`) with the rationale written into `packages/contracts/src/routes.ts:2164-2171`: *"platforms whose kernel archive is pull-cadenced (Fansly: dm_conversations 30 min / dm_messages 24 h — no webhook lane)"* | — | if push lands, that contract comment and possibly the feature's justification need revisiting |
| 11 | **Hydration approvals become racy against ordinary inbound traffic** | `hydrationCoverageFingerprint` excludes head facts but **includes `storedMessageCount`** — `repositories/agent-hydration.ts:265-279`; dispatch refuses on drift (`services/agent-hydration.ts:479-487`), approve returns 409 `hydration_proposal_stale` (`modules/agent-read/handlers-hydration.ts:557`) | `stored_message_count` moves only when a sweep runs | a push that appends messages makes every owner approval — and every #202 auto-approval (`services/agent-hydration-autopilot.ts:146`) — racy against normal traffic. **The autopilot itself is request-driven, cron `*/2 * * * *`** (`services/agent-hydration.ts:168`), so cadence affects its success rate, not its trigger |
| 12 | **Presence dies completely (and is already marginal)** | Fansly presence is written **only** inside the followers sweep and followers_reconcile — `sync/executor-handlers.ts:1974-2027,2627-2657`, from `services/fansly-presence.ts:42-60` (windows 30/120 min at `:7-8`); the urgency driver requires the observation ≤30 min old (`modules/workboard/engine.ts:357-363`, `observedMaxMinutes: 30` at `:61`) | with an hourly followers sweep it already only fires in the half hour after a sweep | at 6 h it is dead — also the "active now" list (`repositories/reporting.ts:722,769-770`) and the workboard `online` badge (`report.ts:39,115-116`). OF has a live presence projection; Fansly has none |
| 13 | **Money and audience projections are recomputed only inside their sweeps** | `rebuildSpenderProjections` + `rebuildRevenueRollups` only from `sync/transactions.ts:316-328`; `rebuildFollowerRollups`/`rebuildSubscriberRollups`/`refreshFanPageSubscriberState` only from `executor-handlers.ts:1757-1758,2333-2337`; top_spenders rankings only from its own stream (`:1018,1166,1307` → `upsertTopSpendersWindow` `:734`) | 1 h | nothing recomputes these on event arrival; if those streams also slow, every fan-spend/revenue/subscriber-count surface lags. **By contrast** `fan_earnings_stats` and every Stage-10 projection are watermark-driven (`services/projections/fan-earnings.ts:39-77`) and cadence-independent |

### 6.2 Goes silent or loses data

| # | mechanism | file:line | breakage |
|---|---|---|---|
| 14 | **Incident detection AND resolution become 6 h late** | open: `sync/executor.ts:823` (auth), `:910` (credits), `:916` (chunk failure); resolve: `resolveSyncChunkRecoveryIncidents` at `:671,725` → `services/notification-incidents.ts:634-666` is the **only** closer of `auth_blocked`, `proxy_failed`, `proxy_missing`, `stream_failed_threshold` | fix a proxy at 09:00, get the "resolved" Telegram at 15:00. First-detection latency 30 min → 6 h (escalation after the first failure is unaffected — backoff caps at 30 min, `page-sync.ts:2561-2564`) |
| 15 | **The failure latch stays on longer and the success-rate denominator collapses** | `physicalFailed = staleAttempts > 0 \|\| physicalAttemptsSinceLastSuccess >= 3` — `services/sync-monitor.ts:743-744`, no time window on the counter (`repositories/sync.ts:2365-2378`) | a recovered lane stays `failed` (⇒ 503) for up to 6 h; `physicalSuccessRate24h` goes from a 48-sample to a 4-sample denominator, so one bad attempt reads 75 % instead of 98 % |
| 16 | **False `golden_signal_lag:sse_delivery` incidents on quiet nights** | threshold 600 000 ms (`services/golden-signals.ts:50`), measured as checkpoint staleness (`:177-190`) that only advances when a frame is consumed (`services/domain-events-smoke.ts:82,100,145,153,157-160`); breach opens a Telegram incident (`golden-signals.ts:340-348`) | today 30-min sweeps across the fleet keep events flowing; at 6 h a quiet night exceeds 10 min of global silence ⇒ flapping false incidents |
| 17 | **`notifications` is the one permanently lossy lane and nothing guards it** | header verbatim: *"THE ONLY PERMANENTLY-LOSSY LANE IN THE SYSTEM… Fansly announces a liker, a reply, a quote or a purchase ONCE"* — `sync/fansly-notifications.ts:1-9`; policy comment *"the cadence is the ONLY thing standing between us and permanent loss"* — `page-sync.ts:332-334`; its `freshnessSlaSeconds` is `null` (`:352`) and it is absent from `SYNC_DOMAIN_POLICY` | slowing this lane risks irreversible loss and **no surface anywhere will say so**. (~15/day against 50 rows a page makes 6 h probably survivable — but the failure is silent and permanent) |
| 18 | **The DM prune gate is global and unscoped — push can stop pruning fleet-wide** | flag `pageDmPruneEnabled` (default now **false**, `packages/shared/src/config-registry.ts:282`) **and** `countArchiveCoverageGaps(db) === 0`, memoized 15 min, fails closed — `services/page-dm-retention.ts:13,25-52`; the gate query has **no page or platform filter** — `repositories/message-archive.ts:1371-1389` | one hot row without an archive counterpart makes the global verdict false forever: a Fansly push that writes only `page_dm_messages` stops the prune for **every page and platform** and `page_dm_messages` grows unbounded. Conversely, pruning fresh push data is structurally impossible — the prune always deletes the oldest (`page-dm.ts:695-716`) |
| 19 | **Push-triggered sync requests could trip the queue-delay threshold** | `dm_conversations.queueDelayThresholdMs = 15 min` (`page-sync.ts:260`), consumed `sync-status.ts:966` | sized for 48 scheduled requests/day; if push enqueues targeted requests, a burst outrunning the executor by >15 min flips the block to `delayed` ⇒ the same 503 path as L2 |
| 20 | secondary thresholds, only if other streams also slow | `STALE_THRESHOLD_HOURS = 9` on `light` (`services/connections.ts:35,128-130`); `healthSyncLightMaxAgeMinutes = 180` (`config-registry.ts:142`, consumed `health.ts:234,278`); `healthSyncFollowerMaxAgeMinutes = 1080` survives 6 h (`config-registry.ts:143`) | — |

### 6.3 Absences — checked, and clean (absence is a finding)

- **No Telegram "page has not synced in N" alert exists.** The 20 incident kinds
  (`repositories/notifications.ts:17-37`, rendered
  `services/notification-incidents.ts:79-201`) contain no `sync_stale` /
  freshness kind, and the daily Telegram report is revenue-only. **Rare sweeps
  produce zero Telegram noise.**
- **Canonicalization is cadence-independent** — a minutely sweep over
  `observations` (`canonicalize-driver.ts:1-7,124`); the `domain_events` NOTIFY
  fires on append inside the write (`repositories/domain-events.ts:443-451`), not
  at run completion.
- **SSE is traffic-rate agnostic** — heartbeat 25 s, 15-min forced reconnect,
  cursor-based replay (`modules/events/index.ts:85,90,311-316,823-828`); the SDK
  has no idle timeout (`packages/contracts/src/sdk-runtime.ts:415-422,442-446`);
  **the dashboard consumes no SSE at all** — pure TanStack polling.
- **`capture_coverage` has no DM plane** (`packages/shared/src/capture-coverage.ts:2-14`)
  and the "never proven complete" logic is Vault-only and **deliberately does not
  measure staleness** (`repositories/vault-album-scans.ts:63-66`, decision #247).
- **Tiering / retention are calendar-based, not run-based** —
  `TIERING_HOT_WINDOW_MONTHS = 6` (`services/tiering/index.ts:28,137`); the
  30-day `sync_runs` sweep and 90-day samples prune are pure cutoffs
  (`repositories/sync.ts:1186-1290`, `repositories/ops-metrics.ts:34-41`).
- **Stream dependencies are "ever succeeded", not "recently"** — `dependencyMet`,
  `page-sync.ts:1705-1708`. No dependency starvation.
- **No message-level "absent ⇒ deleted" inference for Fansly.** The only message
  deleter is the OF webhook path (`services/ofapi-dm-projection.ts:366`). The
  snapshot-reconciliation risk is at *thread* level only (item 1).
- **Workboard state pruning is not snapshot-based** —
  `deleteIneligibleWorkboardStates` keys on `page_fans` existence
  (`repositories/workboard-v2.ts:232-252`).
- **No test pins the `dm_conversations` cadence.** `tests/fansly-new-streams.test.ts`
  pins only `fan_earnings`/`purchase_history`.
- **`lastConversationFullSweepAt` is a dead field** — produced at
  `page-dm.ts:1347`, read by nobody.
- **No route gates a client action on data freshness** — the command outbox gates
  on command lifecycle only.

### 6.4 The precedent already in this repo — OnlyFans runs the proposed architecture today

**OnlyFans already runs push + a 6 h reconcile.**
`ofapiDmReconcileIntervalMinutes` default **360**
(`packages/shared/src/config-registry.ts:251`); the handler no-ops when not due,
returning `satisfied: true, skipped: "reconcile_not_due"`
(`sync/ofapi-dm-sync.ts:552-573`). **That is the trick that keeps health green:
the stream keeps its 1800 s policy cadence and keeps stamping `succeeded_at`;
only the WORK is gated internally on 6 h.** The executor comment says so
explicitly — withholding `succeeded_at` on such skips "WOULD degrade
chatter-visible block health" (`sync/executor-handlers.ts:388-399`). A Fansly
precedent for the same shape exists at `sync/fansly-stats.ts:1611-1617`
(a daily sweep on a 6-hourly stream, due-ness decided from the cursor).
**This also sidesteps landmine L1 entirely** — the policy cadence never changes,
so the slot counter never needs rebasing.

**For the health surface, generalize the existing override rather than tune
SLAs.** `overrideMessagesLiveBlockWithOfapiIngest` already replaces
`messages_live` freshness with **push ingest recency** (24 h threshold, reasons
`webhook_live` / `webhook_silent` / `webhook_waiting`) —
`services/sync-status.ts:1386-1424`, with eligibility hard-coded to
`platform === "onlyfans" && ofapiAccountId !== null` at `:1579-1585`.
Generalizing that predicate neutralizes L2, item 19 and the client-contract
leakage (item 10) in one change.

**Push must enter through the journal, not the hot table.** The mandatory chain
is: observation (registered `source`) → a `CANONICALIZER_FAMILIES` entry
(`canonicalize/index.ts:120-247`; an unregistered kind matches no family, is
never canonicalized, and appears in **no** health-floor gauge) → `domain_events`
→ the minutely archive projection. Freshness floor is then ~1-2 min, documented
at `docs/fastreply-freshness-build-spec.md:9-11`. Writing `page_dm_messages`
directly satisfies the chatter UI and breaks items 8, 9 and 18 simultaneously.

**There is no push-silence deadman for Fansly.** The only such detector is
OFAPI's `ofapi_webhook_silence`, 720-minute threshold
(`services/ofapi-account-health.ts:47,184-208`). Since L2's SLA is exactly what
detects DM liveness today, relaxing it without adding a push deadman leaves the
system blind to a dead push source.

### 6.5 Decisions #102 / #202 / #237 — where they are and how they stand

- **#102** (Stage 28 retention; DM prune as a coverage-gated cache policy) —
  `docs/decisions.md:2791-2811`. **Current state differs from the entry:** the
  flag now defaults **off** for a different reason (the AI union read needs
  `purchased_at`/`deleted_at` in the hot table) — `config-registry.ts:282`.
- **#202** (hydration autopilot: delegated, budgeted approval) —
  `docs/decisions.md:6345-6395`, implemented in
  `services/agent-hydration-autopilot.ts`. Request-driven, unaffected by cadence,
  but exposed to item 11.
- **#237** (follower reconcile: destructive close only under a membership proof
  surviving concurrent live writes; `last_seen_generation` monotonic;
  `fullSweepStartedAt` guard; two-generation grace; blast-radius cap
  `max(50, activeFollowers/100)`) — `docs/decisions.md:9957-10012`.
  **Fully implemented for follows. The DM-thread equivalent was never built** —
  see §6.1 item 1.

### 6.6 Correction to §3.5

§3.5 said cadence is a code constant requiring a deploy. That is true, and
**worse than it sounds**: a deploy alone is not sufficient. Because
`ensurePageSyncStates` rewrites `cadence_seconds` without rebasing
`last_scheduled_slot` (`page-sync.ts:1590-1611` vs `:1930-1933`), a cadence
*increase* silently stops the stream. The safe route is the OnlyFans pattern —
**keep the policy cadence and gate the work inside the handler**
(`sync/ofapi-dm-sync.ts:552-573`), which is also the only route that is
runtime-tunable, via the existing live-config mechanism
(`ofapiDmReconcileIntervalMinutes`, `config-registry.ts:251`).
