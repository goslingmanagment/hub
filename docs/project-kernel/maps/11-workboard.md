> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Territory 11 — Workboard (v1 & v2)

**Scope.** This document covers the two generations of the "workboard" — the panel that tells chatters which fans to write to and when. It documents exactly these files:

- `apps/runtime/src/services/workboard.ts` — v1 report/snooze service
- `apps/runtime/src/services/workboard-presence.ts` — presence (online-now) service
- `apps/runtime/src/services/workboard-v2/*.ts` — v2 priority engine: `types.ts`, `engine.ts`, `recompute.ts`, `closing.ts`, `closing-classifier.ts`, `classify-closing.ts`, `ai-settings.ts`, `report.ts`, `ai-analytics.ts`, `spender-diagnostics.ts`
- `packages/db/src/repositories/workboard.ts` — v1 SQL data access
- `packages/db/src/repositories/workboard-v2.ts` — v2 SQL data access

It also traces callers/callees beyond scope: the HTTP registrations in `apps/runtime/src/api/server.ts`, the pg-boss wiring in `apps/runtime/src/worker-services.ts` and `apps/runtime/src/services/sync-queue.ts`, the Drizzle schema in `packages/db/src/schema.ts`, the config registry in `packages/shared/src/config-registry.ts` / `packages/shared/src/config.ts`, the auth/page-scoping in `apps/runtime/src/services/auth.ts` and `apps/runtime/src/services/fansly-page.ts`, and the Zod contracts in `packages/contracts/src/routes.ts`. Cross-references: territory 02 (workboard HTTP routes), 10 (AI gateway — NB the v2 closing classifier does **not** use it), 13 (user↔page assignments).

---

## 1. What the workboard is, and how v1 and v2 differ

The workboard is a per-page queue of fans ("spenders"/subscribers/followers) surfaced to the dashboard so a human chatter knows whom to message next. There are **two independent implementations that coexist**, share some tables (`workboard_snoozes`) and the fan/DM/spend substrate, but are otherwise disjoint:

| | **v1** | **v2 (priority engine)** |
|---|---|---|
| Service | `services/workboard.ts`, `services/workboard-presence.ts` | `services/workboard-v2/*.ts` |
| Repo | `repositories/workboard.ts` | `repositories/workboard-v2.ts` |
| Compute model | **Read-time SQL**: every request runs large CTE queries that bucket fans into subscribers / active spenders / all spenders / snoozed | **Precomputed FSM**: a nightly (+ event-patched) job scores each fan into a persisted `workboard_state` row; requests just read/sort that table |
| Buckets | `subscribers`, `activeSpenders`, `inactiveSpenders`, `snoozed` + separate `presence` (active-now / recently-active) | `tab` ∈ {subscribers, spenders, fresh_mass, old_mass, service}, each with a `secondaryStatus`, plus a lifetime-gross "lists" mode |
| AI | none | L1 hard closing-detector + L2 Haiku conversation classifier (flag-gated) |
| Platform gate at HTTP | v1 report/snooze: Fansly **or** OnlyFans (`resolveAccessibleDmPage`); presence: same but effectively Fansly-or-OFAPI-mapped OnlyFans | v2 endpoints: **Fansly-only** (`resolveAccessibleFanslyPage`) — see §12 discrepancy |
| Tables written | `workboard_snoozes`; `page_fans.external_presence_*` (presence refresh) | `workboard_state`, `workboard_contact_log`, `wb_closing_cache`, `wb_closing_settings`, `wb_classifier_runs`, `wb_llm_usage_daily`, `workboard_snoozes` |

Both are read-only projections over the same upstream data owned by other territories: `page_fans`, `fans`, `page_subscriptions`, `page_dm_threads`, `page_dm_messages`, `fan_spend_lifetime`, `fan_spend_daily`, `transactions`, `fan_flags`.

---

## 2. Money & time conventions

- **Mills**: all money is integer mills, 1 mill = $0.001 (so $1 = 1000 mills). v1 serializes with `millsToNumber` (`workboard.ts:58,119,165`); the v2 engine converts with `Number(mills)/1000` (`engine.ts:135-137`).
- **Business day / timezone**: v2 day math is pinned to `UTC_TIME_ZONE` (`recompute.ts:228`, `engine.ts:138-144` via `startOfBusinessDay`). Rollup windows use `toBusinessDate(addUtcDays(now,-30|-90))` (`recompute.ts:229-230`).
- **Revenue buckets**: v2 counts only settled revenue-type transactions. `REVENUE_TYPES_SQL = ('subscription','tip','message_purchase','post_purchase','stream_tip')`; à-la-carte subset `ALA_CARTE_TYPES_SQL = ('tip','message_purchase','post_purchase','stream_tip')` (`workboard-v2.ts:9-10`). Purchase-spike urgency additionally re-checks `getTransactionClassification(...).bucket === "revenue"` (`engine.ts:239`).

---

## 3. Workboard v1 — service (`services/workboard.ts`)

`getWorkboardReport(app, principal, pageLabel)` (`workboard.ts:93`) is the single read entry point. It:

1. `requireDashboardUser(principal)` then `resolveAccessibleDmPage(app, principal, pageLabel, "Workboard")` — Fansly or OnlyFans page, access-checked (`workboard.ts:98-99`).
2. Runs four repo queries in parallel for `page.id` and `now` (`workboard.ts:101-106`): `listWorkboardSubscribers`, `listWorkboardActiveSpenders`, `listWorkboardAllSpenders`, `listWorkboardSnoozed`.
3. Returns a `WorkboardResponse` with four sections: `subscribers`, `activeSpenders`, `inactiveSpenders` (populated from **all** spenders, each re-segmented active/inactive by a 30-day recency test in `resolveWorkboardSpenderSegment`, `workboard.ts:80-91`), `snoozed`.

Per-item serialization (`serializeSpenderItem`, `workboard.ts:49`) carries: fan identity (`platformUserId`, `pageAlias`, `username`, `displayName`), `ltv.creatorNetAmountMills`, `segment`, `overdueDays`, `silenceDays`, a `conversation` block (`platformConversationId`, last fan/model message timestamps, `lastMessagePreview`, `storedMessageCount`, `messageCoverageStatus`, `messageBackfillComplete`, `messageSyncEligibility`), a `subscription` block, and `lastTransactionAt`. Subscribers additionally carry a `touchpoint` block (`code`, human `label` from `touchpointLabel`, `isSoft`, `dueAt`) and richer subscription fields (`autoRenew`, `autoRenewOffDetectedAt`, `tierName`, `subscriberSince`).

**Snooze mutations** (both `requireDashboardUser` + `resolveAccessibleDmPage`):
- `snoozeWorkboardFanReport` (`workboard.ts:172`) → repo `snoozeWorkboardFan`; body `{ fanId, days }`, `days ∈ {7,14,30}` (contract `workboardSnoozeBodySchema`, `routes.ts:1231`). Throws `NotFoundError` if the fan isn't on the page.
- `unsnoozeWorkboardFanReport` (`workboard.ts:195`) → repo `unsnoozeWorkboardFan`; returns `{ ok: true }`.

## 4. Workboard v1 — repository (`repositories/workboard.ts`)

All functions are raw `sql`-template `db.execute` queries. Key building blocks:

- **`subscribersBaseQuery`** (`workboard.ts:126`): CTEs `primary_conversation` (latest visible `page_dm_threads` per fan), `current_subscription` (latest `page_subscriptions`), `subscriber_candidates` (join `page_fans`+`fans`+spend+conversation). Selects only subscribers whose `subscription_expires_at` is within `(now, now+21d]`, and derives a **touchpoint** at 21/14/7/5/3/1 days-before-expiry, with `touchpoint_due_at`. `is_soft_touchpoint = code ∈ (21d,14d)`. `is_handled` = a contact/message at/after `greatest(touchpoint_due_at, now-48h)`.
- **`spenderBaseQuery`** (`workboard.ts:250`): CTEs `primary_conversation`, `retention_due` (subscribers due within 21d, excluded from the spender lists), `candidate_rows` (from `fan_spend_lifetime` join `fans`/`page_fans`/conversation), `filtered` (adds `silence_days` capped at 90 and a `subscription_status` of active/expired/never). Parameterized by `recentSpend`, `rhythmDays`, `minimumSpendMills` (**default 100000 mills = $100**), `actionableOnly`, `excludeSubscribers`.
- **Snooze exclusion**: `workboardSnoozeExclusionSql` (`workboard.ts:115`) appends `not exists (… workboard_snoozes … snoozed_until > now())`.

Public functions:

| Function | Line | What it returns / filter |
|---|---|---|
| `listWorkboardSubscribers` | 402 | Subscribers with an unhandled touchpoint, `overdue_days` computed, ordered by touchpoint proximity → auto-renew-off first → LTV desc |
| `listWorkboardActiveSpenders` | 586 | `recentSpend:true, rhythmDays:7, minSpend $100`; spent in last 30d, `overdueDays = max(0, silence-7)` |
| `listWorkboardInactiveSpenders` | 640 | `recentSpend:false, rhythmDays:14, minSpend $100` — **defined but has no caller** (see §12) |
| `listWorkboardAllSpenders` | 694 | `recentSpend:null, rhythmDays:null, minSpend 100 mills ($0.10), actionableOnly:false, excludeSubscribers:false` — the actual source of the `inactiveSpenders` section |
| `snoozeWorkboardFan` | 764 | Upsert into `workboard_snoozes` (unique on page+fan), `snoozed_until = now()+days`; returns null if fan not on page |
| `unsnoozeWorkboardFan` | 798 | Delete the snooze row (shared with v2) |
| `listWorkboardSnoozed` | 822 | Active snoozes joined to fan/spend, ordered by `snoozed_until` |
| `listWorkboardPresence` | 884 | Presence buckets (see §5) |

`getMessageSyncEligibility` (`workboard.ts:103`) derives `eligible | excluded | unresolved_identity` from conversation metadata (`FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY`) and null `fanId`.

## 5. Presence (`services/workboard-presence.ts` + `listWorkboardPresence`)

`getWorkboardPresenceReport(app, principal, pageLabel)` (`workboard-presence.ts:140`) returns `{ updatedAt, bestEffort:true, activeNow, recentlyActive }`. Buckets from `listWorkboardPresence` (`repositories/workboard.ts:884`): **active_now** = `external_presence_at ≥ now-30min`; **recently_active** = `now-120min ≤ external_presence_at < now-30min`. Each bucket returns `total` (window `count(*) over()`) and up to `limit` (default 20) items ordered by presence-recency → LTV → fanId. Item fields: fan identity, `presence` (`lastSeenAt`=external_presence_at, `observedAt`=external_presence_observed_at, `source`), `ltv`, `isSubscriber`, `platformConversationId`, `lastTransactionAt`.

**Two source paths, decided by page platform:**
- **OnlyFans** (`workboard-presence.ts:154-167`): DB-read-only. Eligible only if `isOfapiPresenceProjectionEnabled(config)` **and** the stored page has a non-empty `ofapiAccountId`; otherwise `BadRequestError("Workboard presence is only supported for Fansly pages")`. The OFAPI webhook projection keeps `page_fans.external_presence_*` fresh (territory: OFAPI/presence).
- **Fansly** (`workboard-presence.ts:169-203`): may trigger a live **outbound Fansly followers fetch** to refresh presence. TTL-gated (`PRESENCE_REFRESH_TTL_MS = 60_000`), in-flight-coalesced per page (`presenceRefreshInFlightByPageId`). `refreshPresenceForPage` (`workboard-presence.ts:67`) paginates `app.adapter.getFollowersPage(...)` (offset/limit 100, `lastSeenAfter = now - FANSLY_RECENTLY_ACTIVE_WINDOW_MS`, capped at `PRESENCE_REFRESH_MAX_PAGES = 1000`), builds signals via `buildFanslyFollowerPresenceSignals`, then in a transaction `upsertHydratedFansForPage` + `upsertFanPageExternalPresences` (writes `page_fans.external_presence_at/observed_at/source`).

---

## 6. Workboard v2 — shared types (`workboard-v2/types.ts`)

The v2 vocabulary (enums the engine and DB both use):

- **`WorkboardTab`** = `subscribers | spenders | fresh_mass | old_mass | service` (`types.ts:6`). Mirrors DB enum `workboard_tab` (`schema.ts:1726`).
- **`MassSubstate`** = `fresh | gray | active | dead | archived` (`types.ts:13`; DB enum `schema.ts:1734`). Applies only to the two mass tabs.
- **`SecondaryStatus`** = `recent_purchase | need_reply | due_now | later | dont_touch_today` (`types.ts:15`; DB enum `schema.ts:1742`). The within-tab urgency label.
- **`FreeloaderStatus`** = `none | cooling | freeloader | ceiling` (`types.ts:29`; DB enum `schema.ts:1750`).
- **Contact-action enum** (DB `workboard_contact_action` = `opened | handled | snoozed`, `schema.ts:1757`; contract default `handled`).
- **`ConversationState`** (L2 semantic read) = `question | buy_signal | smalltalk | closing | cold | complaint` (`types.ts:38`).
- Supporting: `ValueTier` (`whale|vip|payer|new`), `ValueConfidence`, `QConfidence`, `UrgencySeverity` (`critical|high|medium|normal|muted`), `RatioHealth`, `LatencyBand`, `FanFlag` (`whale|vip|risky`), `CoverageStatus` (`pending_backfill|partial_window|complete`), `DmSenderRole` (`fan|model|system|unknown`).

**`FanSignals`** (`types.ts:51`) is the normalized per-(page,fan) input the pure engine scores: spend (`ltvMills`, `spend30Mills`, `spend90Mills`, `alaCarteShare90`, `lastTransactionAt`), subscription (`isSubscriber`, `subscriptionExpiresAt`, `autoRenew`, `subscriptionPriceMills`), tenure (`followerSince`, `hasEverFanMessaged`), `flags`, last purchase (`lastPurchaseAt/NetMills/Type`), conversation aggregates (`lastMessageSenderRole`, `lastFanMessageAt`, `lastModelMessageAt`, `tailContent`, `storedMessageCount`, `messageCoverageStatus`, `modelMsgCount`, `fanMsgCount`, `unknownMsgCount`, `initiatorRole`, `avgReplyGapHours`, `priorQScore`, `l2NeedsReply`, `l2State`), touch (`lastProductiveContactAt`), presence (`externalPresenceAt/ObservedAt`, `presenceFeedTruncated`), service gating (`snoozedUntil`, `refundCooldownUntil`), and persisted lifecycle (`massSubstate`, `reactivationAttemptedAt`, `freeloaderStatus`, `freeloaderConv90`, `lifetimeFreeEpisodes`, `convertedRecently`).

**`WorkboardEvaluation`** (`types.ts:150`) is the engine's output record (tab, massSubstate, valueScore, urgencyScore, rankScore, secondaryStatus, severity, tiers/confidences, qScore, freeloaderStatus, needsReply, needsHumanTriage, isPurchaseFollowup, whyNowCode/Value, reasonChips, followupDueAt, serviceReason).

## 7. Workboard v2 — the scoring engine (`workboard-v2/engine.ts`)

`engine.ts` is **pure** (no DB, no clock except `signals.now`). All coefficients live in the exported `WB` constant (`engine.ts:28-119`). `evaluateFan(signals)` (`engine.ts:707`) is the top-level function. The algorithm has five axes:

### 7.1 Value — "who matters" (slow), `computeValue` → [0,100] (`engine.ts:172`)
Weighted sum (`weights: {ltv 0.35, velocity 0.35, tier 0.2, potential 0.1}`) of: (1) log-normalized recency-decayed realized LTV (`ltvRefDollars 1000`, decay half-life ≈83d), (2) à-la-carte-tilted run-rate velocity (`velRefDollarsPerDay 5`), (3) subscription price tier (`tierRefDollars 50`), (4) a cold-start potential floor for fresh followers/subscribers with <$20 LTV. Plus flag bonuses (`whale +20, vip +12, risky -15`). Returns `{score, confidence (high if any spend), tier}` where tier is `whale (≥65 or whale flag) | vip (≥40 or vip flag) | payer (LTV>0) | new`.

### 7.2 Urgency — "why today" (fast), dominant-driver + capped bonus (`engine.ts:388` `combineUrgency`)
Each driver returns a value in [0,100]; the winner is the max, plus `min(bonusCap 8, 0.25 × sum of others)`. Drivers (only when `tab !== "service"`):

| Driver | Fn | Fires when | Peak value |
|---|---|---|---|
| purchase | `purchaseDriver:234` | settled revenue purchase within 3d; exp decay (half-life 36h); ×1.05 if ≥$50 | base 95 |
| expiry | `expiryDriver:254` | subscriber with future expiry; interpolated anchors 1d→88 … 21d→16; ×autoRenew mult (off 1.12 / unknown 1.05 / on 0.8) | ~88 |
| sla | `slaDriver:275` | `needsReply` + fan wrote last; `min(80, 30+22·ln(1+h/6))`; capped 50 if coverage `pending_backfill`; ×0.7 if unverified; ×0.5 if L2 state `cold` | 80 |
| intent (L2) | `intentDriver:302` | `needsReply` + fan tail + L2 state; buy_signal 90 / complaint 85 / question 55 | 90 |
| cadence | `cadenceDriver:334` | overdue vs target cadence, clock-bent by conversation quality + freeloader multiplier; per-tab caps | 30–70 |
| presence | `presenceDriver:356` | fresh external presence (observed ≤30min ago); ≤30min → +35, ≤120min → +20 | 35 |
| reactivation | `reactivationDriver:374` | `old_mass` + `dead` substate, one-shot within 7d window | +25 |

### 7.3 Conversation quality Q ∈ [−1,+1], `computeQuality` (`engine.ts:442`)
Weighted (`ratio 0.35, initiator 0.3, lastWriter 0.1, latency 0.25`) blend of message-ratio reciprocity, who initiated, whether the last writer is fan vs model (and whether the tail is an L1 closing via `isClosingMessage`), and average reply gap. Returns `q`, damped `qEff` (× confidence damp × role confidence), `qConfidence` (`low` if `pending_backfill` or ≤1 msg; `high` if `complete` or ≥6 msgs; else `medium`), and a `breakdown` (`ratioHealth`, `initiator`, `latencyBand`).

### 7.4 Freeloader throttle, `computeFreeloader` (`engine.ts:503`)
Sliding-window counter of meaningful conversation-days over 90d (`windowN 10`, `coolingStart 7`, `lifetimeCap 25`). Emits `{status, frequencyMultiplier, rankPenalty}`: `ceiling` (lifetime ≥25) → freq ×0.1, penalty 18; `freeloader` (conv90 ≥10) → freq ×0.25, penalty 12; `cooling` (conv90 ≥7) → tapering freq. Suppressed if the fan is actively/healthily conversing (`intentStrong`) or has converted (any 90d net > 0).

### 7.5 FSM — tab + mass-substate derivation (`deriveTab` `engine.ts:579`, first match wins)
1. **service** if `deriveServiceReason` returns non-null: snoozed / refund_cooldown / archived substate / freeloader `ceiling` (`engine.ts:542`).
2. **subscribers** if active subscriber with future expiry.
3. **spenders** if `ltvDollars ≥ WB.fsm.spenderMinDollars` (**0.01** — any settled cent; comment notes it was $100 in v1).
4. else **fresh_mass** vs **old_mass** by `deriveMassSubstate` + follower age (`freshWindowDays 30`). Mass substates: `archived` sticks; `active` requires a real two-way conversation (`fanMsgCount ≥ 2`, `q ≥ 0.2`, confidence ≠ low); `dead` after 45d silence; `fresh`/`gray` split at `grayAfterDays 14`.

### 7.6 needs_reply / cooldown / rank / status / severity (in `evaluateFan`, `engine.ts:707`)
- **needs_reply** (`engine.ts:730-749`): fan wrote last AND not an L1 closing. Cleared if "handled" (productive touch at/after the fan's message). Fresh (<24h) tails default `true`; >24h defers to the L2 verdict `l2NeedsReply`, or if unclassified defaults `true` and sets `replyUnverified`.
- **Cooldown gate** (`engine.ts:754-759`): a productive touch within `cooldownDays 3` with no newer fan message suppresses cadence and marks status `dont_touch_today` (unless a purchase follow-up).
- **rankScore** = `computeRankScore` (`engine.ts:606`) = `urgency·(1 + 0.15·qEff) + valueWeightByTab[tab]·value − freeloaderPenalty`. `valueWeightByTab`: spenders 0.3, subscribers 0.1, mass 0.05, service 0.
- **secondaryStatus** (`deriveSecondaryStatus:617`): recent_purchase → need_reply → dont_touch_today (gated) → due_now (urgency ≥50) → later (≥25) → dont_touch_today.
- **severity** (`deriveSeverity:641`), **reasonChips** (`buildReasonChips:672`, e.g. `buy_signal`, `complaint`, `renew_off`, `expires_soon`, `replies_waiting`, `unverified`, `freeloader`, `cooldown`, `cold_start`), and **followupDueAt** (purchase +20h).

## 8. Workboard v2 — recompute (`workboard-v2/recompute.ts`)

`recomputeWorkboardPage(db, {platformAccountId, now})` (`recompute.ts:223`):
1. `loadWorkboardSignalRows` (see §11) for the page.
2. For each row: `updateFreeloaderEpisodes` (maintains the persisted 90d episode list, `recompute.ts:75`), `mapRowToSignals` (coerces raw SQL columns → `FanSignals`, incl. `refundCooldownUntil = refund_recent_at + 14d`, `recompute.ts:107`), `evaluateFan`, `toRecord`.
3. `upsertWorkboardStates` in chunks of 500, then `deleteIneligibleWorkboardStates` (drop rows whose fan left/was deleted).

`recomputeWorkboardFan(db, {platformAccountId, fanId})` (`recompute.ts:253`) does the same for one fan — the **instant board patch** after Готово/snooze/undo/purchase. `recomputeAllWorkboardPages` (`recompute.ts:281`) loops `listWorkboardRecomputePageIds` — the scheduled-job entry point.

`mapRowToSignals` loads `l2_layer` into `WorkboardSignalRow` but **does not** map it into `FanSignals` (only `l2NeedsReply` and `l2State` are used); see §12.

## 9. Closing classifier (L1 + L2)

### 9.1 L1 hard detector (`workboard-v2/closing.ts`)
`isClosingMessage(rawContent)` (`closing.ts:49`) — deterministic, free, multilingual (EN + RU). Returns `true` only when the whole normalized message equals a closing phrase from `CLOSING_PHRASES` (`closing.ts:9`), is a ≤3-token combination of closing phrases, or is emoji/punctuation-only (≤6 glyphs). Bare affirmatives (`yes/да/давай`) are deliberately **not** closings — they defer to L2. Used everywhere as the free first pass: engine quality/needs_reply, `report.ts:53`, `classify-closing.ts:88`, `spender-diagnostics.ts:31`.

### 9.2 L2 LLM classifier (`workboard-v2/closing-classifier.ts`) — **direct Anthropic call, NOT the AI gateway**
`createAnthropicClosingClassifier({apiKey, model})` (`closing-classifier.ts:142`) instantiates `new Anthropic({ apiKey })` from `@anthropic-ai/sdk` and calls `client.messages.create` **directly** — it does **not** route through the ChatMuse AI gateway of territory 10 (no proxy, no page-scoped client resolver). Request shape (`closing-classifier.ts:147-156`):
- `model` (default `claude-haiku-4-5`), `max_tokens: 1536`, `temperature: 0`.
- `system`: a long strict prompt (`closing-classifier.ts:43-81`) instructing it to classify **the fan's last message in conversation context** into one of the six `ConversationState`s + `needs_reply` + an ≤8-word `reason`, with detailed rules for buy_signal vs smalltalk and solicitation/spam→cold.
- `messages`: one user turn whose content is `JSON.stringify([{id, messages:[{role:"fan"|"creator", text}]}])`, each text sliced to 500 chars (`buildUserContent:99`).

Response text is parsed by `parseVerdicts` (`closing-classifier.ts:108`): extract the JSON array, coerce each `state` (unknown→`smalltalk`), derive `needsReply` (`closing` ⇒ false), slice `reason` to 160 chars. **Any missing/unparseable id defaults to `needsReply:true, state:"smalltalk"`** (safe: never suppress a reply on parse failure). `classifyBatch` returns verdicts + `inputTokens`/`outputTokens` from `response.usage`. `maybeCreateClosingClassifier` (`closing-classifier.ts:170`) returns `null` when the feature is off or no API key.

### 9.3 Orchestration (`workboard-v2/classify-closing.ts`)
`runClosingClassificationForPage(db, classifier, {platformAccountId, capMin, capMax, batchSize=15})` (`classify-closing.ts:77`):
1. `listClosingClassificationCandidates` → filter out L1 closings in TS (only spend L2 on undecided tails).
2. Adaptive per-day cap = `min(capMax, max(capMin, floor(0.5 × countUnansweredTails)))`.
3. Chunk into batches of 15; **before each batch** `reserveLlmUsageDailyCall` atomically reserves a call slot against the cap (returns false when exhausted → stop). On success: `classifyBatch`, then `addLlmUsageDailyTokens`, then build `wb_closing_cache` rows with `layer:"l2"`, `contentHash` = sha1 of the **context** (not just the tail), `state`, `reason`.
4. On any API error: `break` — leftover tails stay uncached (engine shows "unverified", retried next run). Result: `{classified, deferred, calls, inputTokens, outputTokens}`.

`runClosingClassificationAllPages(db, {config, now, createClassifier?})` (`classify-closing.ts:164`): returns early if no `anthropicApiKey`; resolves each page's effective settings (`resolveClosingSettings`) over `listWorkboardRecomputePageIds`; caches classifiers per model; classifies each enabled page and writes a `wb_classifier_runs` row (`trigger:"cron"`) only when a run actually called the API. `CLOSING_CLASSIFIER_FEATURE = "closing-classifier"` is the `wb_llm_usage_daily.feature` key.

### 9.4 Effective settings & cost (`workboard-v2/ai-settings.ts`)
`resolveClosingSettings(config, override)` (`ai-settings.ts:34`) — per-page DB override over env defaults. `enabled = hasApiKey && (override.enabled ?? envEnabled)`; `capMin`/`capMax`/`model` fall back to env (`DEFAULT_CAP_MIN 50`, `DEFAULT_CAP_MAX 400`, `DEFAULT_MODEL "claude-haiku-4-5"`). `estimateCostUsd`/`modelPricing` (`ai-settings.ts:60-74`): USD/1M-token table — haiku-4-5 $1/$5, 3-5-haiku $1/$5, sonnet-4-5 $3/$15; unknown models fall back to haiku pricing (conservative upper bound, no batch/cache discount).

## 10. Workboard v2 — read/mutation services

### 10.1 `report.ts` — the board
`getWorkboardV2Report(app, principal, pageLabel, query)` (`report.ts:130`): `resolveAccessibleFanslyPage` (Fansly-only), then parallel `listWorkboardV2` (paged, tab-scoped, status-filtered) + `getWorkboardV2Counts`, plus `computeOldMassBudget` (only for the `old_mass` tab) + `computeAiCoverage`. Returns `{tab, total, limit, offset, items, counts, oldMassBudget, aiCoverage}`. `mapItem` (`report.ts:77`) serializes each state row, computing an `online` flag (`external_presence_at` within `PRESENCE_ONLINE_MINUTES = 6`) and a read-time `closingVerdict` (`report.ts:42`, layers `model_last | l1 | fresh | l2 | unverified | unknown` derived from role/preview/age/cache).

- `getWorkboardV2Lists` (`report.ts:179`): the lifetime-gross **"lists" mode** — buckets the roster into `SPENDER_AUTO_LIST_BUCKETS` (the `[FB] $X-$Y Spenders` bands, `packages/shared/src/spender-buckets.ts`) via `listWorkboardSpenderBands` (exact counts + up to `LISTS_ITEM_CAP = 500` members/band). FSM/priority not used here.
- **Cap meter** `computeOldMassBudget` (`report.ts:247`): residual daily budget `total = max(OLD_MASS_FLOOR 15, PAGE_DAILY_CAPACITY 150 − higher-tab actionable count)`, `used = countOldMassContactsToday`, `resetsAt` = next UTC midnight.
- **AI coverage badge** `computeAiCoverage` (`report.ts:217`): effective-enabled flag + classified/closings counts + today's calls + spender-diagnostics summary.

Mutations (all `resolveAccessibleFanslyPage`, all end with a single-fan recompute):
| Service fn | Line | Writes |
|---|---|---|
| `recordWorkboardContactV2` | 267 | `appendWorkboardContact` (touch log; `modelId`, action, `wasProductive`), `markReactivationAttemptedIfDead` if productive, then `recomputeWorkboardFan` |
| `snoozeWorkboardV2` | 292 | `snoozeWorkboardFanV2` (arbitrary 1–120 days), recompute |
| `unsnoozeWorkboardV2` | 304 | `unsnoozeWorkboardFan` (shared v1 fn), recompute |
| `undoWorkboardContactV2` | 316 | `deleteLastWorkboardContact`, recompute |
| `triggerWorkboardV2Recompute` | 328 | full-page `recomputeWorkboardPage` |

### 10.2 `ai-analytics.ts` — owner AI panel
`getWorkboardV2AiReport` (`ai-analytics.ts:50`): resolves settings + 30d usage rows (`getLlmUsageRange`) with per-day cost, cache/tail/pending counts, spender diagnostics, and the last 25 verdicts (`listRecentClosingVerdicts`). `updateWorkboardV2AiSettings` (`ai-analytics.ts:143`): `upsertClosingSettings` then re-reads the report. `runWorkboardV2AiClassify` (`ai-analytics.ts:196`): requires an API key; `insertClassifierRunRunningIfIdle` (advisory-locked one-in-flight-per-page); **detaches** `executeClassifyRun` (`void`, `ai-analytics.ts:164`) which optionally clears the cache (reclassify), runs `runClosingClassificationForPage`, recomputes the page, and `finishClassifierRun`. Responds immediately with `{runId, status:"running", alreadyRunning}`. `listWorkboardV2AiRuns` (`ai-analytics.ts:228`): global cross-page run log; first calls `failStaleClassifierRuns(20 min)` to reconcile orphaned `running` rows.

### 10.3 `spender-diagnostics.ts`
`summarizeSpenderDiagnostics(rows)` (`spender-diagnostics.ts:43`) buckets each active spender's latest DM tail into a diagnosis state (`no_visible_dialog | model_last | unknown_sender | closing (L1) | missing_message_id | <L2 state> | pending_ai`) and returns counts (`spenders`, `diagnosed`, `pending`, `l2Classified`, `closings`, role breakdowns, ordered `states`). Consumed by both `report.ts` and `ai-analytics.ts`.

---

## 11. Workboard v2 — repository (`repositories/workboard-v2.ts`)

**`loadWorkboardSignalRows`** (`workboard-v2.ts:72`) is the heart: one big query, one row per `page_fans` fan (LEFT-joined so no-spend/no-DM fans still appear). CTEs: `spend_window` (net30/net90/alacarte90 from `fan_spend_daily`, posted revenue types), `last_purchase` (from `transactions`), `refund_recent` (refund/chargeback in last 14d), `current_sub` (price from `page_subscriptions`), `primary_thread` (latest visible `page_dm_threads`), `cq` (per-conversation message counts/initiator/avg gap/latest-meaningful over `page_dm_messages`), `flags` (from `fan_flags`), `last_touch` (max productive `acted_at` from `workboard_contact_log`). Joins `fan_spend_lifetime`, `wb_closing_cache` (by `last_message_id`), `workboard_snoozes`, and the prior `workboard_state`. Optional `fanId` scope makes single-fan recompute fast. Data-type note (`workboard-v2.ts:12-15`): int8 → bigint, numeric → string, int4 → number, ts → Date.

Other functions:

| Function | Line | Reads/Writes |
|---|---|---|
| `deleteIneligibleWorkboardStates` | 231 | DELETE `workboard_state` rows whose fan is gone/deleted |
| `upsertWorkboardStates` | 254 | INSERT…ON CONFLICT (page,fan) into `workboard_state` |
| `listWorkboardV2` | 343 | Paged tab read of `workboard_state` + joins; order `is_purchase_followup desc, rank_score desc, fan_id asc` |
| `getWorkboardV2Counts` | 420 | per-(tab, secondary_status) counts |
| `listWorkboardSpenderBands` | 460 | lifetime-gross band counts + capped members |
| `appendWorkboardContact` | 561 | INSERT `workboard_contact_log` |
| `markReactivationAttemptedIfDead` | 573 | UPDATE `workboard_state.reactivation_attempted_at` for dead old_mass |
| `countOldMassContactsToday` | 591 | count today's productive old_mass touches |
| `snoozeWorkboardFanV2` | 610 | UPSERT `workboard_snoozes` (arbitrary days) |
| `deleteLastWorkboardContact` | 626 | DELETE latest `workboard_contact_log` row |
| `listWorkboardRecomputePageIds` | 647 | page ids = all Fansly **or** OnlyFans-with-`ofapi_account_id` |
| `listClosingClassificationCandidates` | 684 | fan-last unanswered tails (spenders exempt from 24h gate), context window ≤12 msgs, ordered by tab priority |
| `listSpenderDiagnosisRows` | 757 | latest DM diagnosis inputs for spender-tab fans |
| `countClosingCache` / `countUnansweredTails` | 796 / 813 | coverage + adaptive-cap inputs |
| `getLlmUsageDaily` / `incrementLlmUsageDaily` / `reserveLlmUsageDailyCall` / `addLlmUsageDailyTokens` | 827–892 | `wb_llm_usage_daily` accounting (reserve is the atomic cap-gated INSERT…WHERE calls<cap) |
| `upsertClosingCache` / `clearClosingCacheForPage` | 905 / 938 | `wb_closing_cache` |
| `getClosingSettings` / `listClosingSettings` / `upsertClosingSettings` | 954–974 | `wb_closing_settings` |
| `getClosingStateDistribution` / `listRecentClosingVerdicts` | 1000 / 1026 | verdict analytics |
| `insertClassifierRun` / `insertClassifierRunRunning` / `insertClassifierRunRunningIfIdle` / `finishClassifierRun` / `failStaleClassifierRuns` / `getActiveClassifierRun` / `listClassifierRuns` | 1067–1222 | `wb_classifier_runs` (advisory-lock namespace `9_002_001`) |
| `getLlmUsageRange` | 1225 | 30d usage trend |

---

## 12. Discrepancies (name/comment/type vs actual behavior)

1. **v2 read endpoints are Fansly-only, but recompute covers OnlyFans.** `listWorkboardRecomputePageIds` (`workboard-v2.ts:647`) evaluates and persists `workboard_state` for Fansly **and** OFAPI-mapped OnlyFans pages, and v1 (`resolveAccessibleDmPage`) serves both platforms. But every v2 HTTP handler (`report.ts:136`, `ai-analytics.ts:55`) uses `resolveAccessibleFanslyPage`, which throws `BadRequestError("Workboard v2 is only supported for Fansly pages")` for OnlyFans — so v2 state is computed for OnlyFans pages that can never be read through the v2 API.
2. **`over_cap` cache layer is declared but never written.** `ClosingCacheUpsert.layer: "l2" | "over_cap"` (`workboard-v2.ts:899`) and the schema comment (`schema.ts:1875`) say layer may be `over_cap`, but `classify-closing.ts` only ever pushes `layer:"l2"`; over-budget tails are left uncached (the loop `break`s). No code path stores `over_cap`. The read-time "unverified" state in `report.ts`/engine is computed from the **absence** of a cache row, not from a stored layer.
3. **`l2_layer` is loaded but unused by the engine.** `loadWorkboardSignalRows` selects `cc.layer as l2_layer` (`workboard-v2.ts:206`, typed on `WorkboardSignalRow:57`), but `mapRowToSignals` never maps it into `FanSignals`; only `l2_needs_reply` and `l2_state` drive the engine.
4. **Unused v1 export.** `listWorkboardInactiveSpenders` (`repositories/workboard.ts:640`) has no caller — the service's `inactiveSpenders` section is built from `listWorkboardAllSpenders`. Likewise `incrementLlmUsageDaily`, `insertClassifierRunRunning` (non-`IfIdle`), `getActiveClassifierRun`, and `getClosingStateDistribution` are exported with no in-repo caller.
5. **Task premise vs code — the classifier bypasses the AI gateway.** The v2 closing classifier does not call the ChatMuse AI gateway (territory 10); it constructs the Anthropic SDK client directly with the raw `ANTHROPIC_API_KEY` (`closing-classifier.ts:143`). The two subsystems only share the key (config note, `config-registry.ts:200`).

---

## 13. Per-page / per-model / per-user scoping (relevant to the planned standalone multi-user app)

The workboard is designed to become a standalone authenticated multi-user app. What exists today:

- **Per-page scoping is pervasive.** Every table is keyed by `platform_account_id` (the page). Every read/mutation resolves a page by label and calls `canAccessPage` (`auth.ts:712`): owners see all pages; other roles are limited to `principal.assignedPageIds` (the user↔page assignments of territory 13, surfaced via `listUserPageAssignments`). No cross-page workboard aggregation endpoint exists.
- **Per-model scoping** exists only in the touch log: `workboard_contact_log.model_id` (`schema.ts:1841`) is written from `page.modelId` (`report.ts:275`) and indexed for cross-page anti-spam (`workboard_contact_log_model_fan_date_idx`), though no query in scope currently reads across pages by model.
- **Roles / auth method.** All workboard routes require a **cookie session** via `requireDashboardUser` (`auth.ts:720`) — which admits only `owner` and `team_lead`. **Chatters authenticate by API key and are therefore currently excluded from every workboard endpoint.** The v2 AI panel (`.../workboard/v2/ai`, settings, classify, and `/api/v1/workboard/ai/runs`) additionally requires `requireOwner` (`auth.ts:729`).
- **Per-user assignment** is *not yet* modeled inside the workboard itself: there is no "assigned to chatter X" column on `workboard_state` or the contact log; assignment today means only "which pages a user may open" (assignedPageIds), not "which fans a user owns."

---

## 14. Boundary catalog

### 14.1 Inbound HTTP endpoints (registered in `api/server.ts`; contracts in `packages/contracts/src/routes.ts`)
All under `/api/v1/pages/:pageLabel/...` unless noted; all `requireDashboardUser` (session; owner/team_lead) except the AI group (`requireOwner`).

| Method + path | Handler (service) | Request | Response |
|---|---|---|---|
| GET `/workboard` | `getWorkboardReport` | pageLabel | subscribers / activeSpenders / inactiveSpenders / snoozed |
| GET `/workboard/presence` | `getWorkboardPresenceReport` | pageLabel | activeNow / recentlyActive buckets |
| POST `/workboard/snooze` | `snoozeWorkboardFanReport` | `{fanId, days∈{7,14,30}}` | `{fanId, snoozedUntil}` |
| DELETE `/workboard/snooze/:fanId` | `unsnoozeWorkboardFanReport` | fanId | `{ok}` |
| GET `/workboard/v2` | `getWorkboardV2Report` | query `{tab, status?(csv), limit≤200=50, offset=0}` | items + counts + oldMassBudget + aiCoverage |
| GET `/workboard/v2/lists` | `getWorkboardV2Lists` | pageLabel | gross-spend bands |
| POST `/workboard/v2/contact` | `recordWorkboardContactV2` | `{fanId, action=handled, wasProductive=true}` | `{ok, fanId}` |
| POST `/workboard/v2/recompute` | `triggerWorkboardV2Recompute` | pageLabel | `{ok, evaluated}` |
| POST `/workboard/v2/snooze` | `snoozeWorkboardV2` | `{fanId, days 1–120}` | `{ok, fanId, snoozedUntil}` |
| DELETE `/workboard/v2/snooze/:fanId` | `unsnoozeWorkboardV2` | fanId | `{ok, fanId}` |
| DELETE `/workboard/v2/contact/:fanId` | `undoWorkboardContactV2` | fanId | `{ok, fanId}` |
| GET `/workboard/v2/ai` (owner) | `getWorkboardV2AiReport` | pageLabel | settings/usage/coverage/states/recent |
| PUT `/workboard/v2/ai/settings` (owner) | `updateWorkboardV2AiSettings` | `{enabled?, dailyCapMax? 1–5000, model? ≤120}` | AI report |
| POST `/workboard/v2/ai/classify` (owner) | `runWorkboardV2AiClassify` | `{reclassify=false}` | `{ok, runId, status:"running", alreadyRunning}` |
| GET `/api/v1/workboard/ai/runs` (owner) | `listWorkboardV2AiRuns` | — | cross-page run log |

### 14.2 Outbound — Anthropic Messages API (the L2 classifier)
Direct `@anthropic-ai/sdk` `messages.create` (`closing-classifier.ts:147`). **Out:** model, `max_tokens 1536`, `temperature 0`, the strict system prompt, one user turn = JSON array of `{id, messages:[{role, text≤500ch}]}` (up to 15 threads, ≤12 context msgs each). **In:** JSON array `{id, state, needs_reply, reason≤160ch}` + `usage.input_tokens`/`output_tokens`. Counterpart: `api.anthropic.com`. Not proxied via the AI gateway.

### 14.3 Outbound — Fansly followers API (presence refresh)
`app.adapter.getFollowersPage(...)` (`workboard-presence.ts:79`). **Out:** page account id, `{offset, limit 100, lastSeenAfter, minDelayMs}` + session/proxy/egressKey. **In:** follower items (`followerId`, last-seen) + account records. Counterpart: Fansly (via the platform adapter). OnlyFans presence is DB-read-only (fed by the OFAPI webhook projection).

### 14.4 pg-boss queue jobs (`worker-services.ts`, `sync-queue.ts`)
| Queue const / name | Schedule (UTC) | Handler | Populates |
|---|---|---|---|
| `WORKBOARD_CLASSIFY_QUEUE = "workboard.classify-closing"` | `0 1 * * *` (01:00), retryLimit 1 / retryDelay 120s | `runClosingClassificationAllPages` (skipped if no `ANTHROPIC_API_KEY`) | `wb_closing_cache`, `wb_llm_usage_daily`, `wb_classifier_runs` |
| `WORKBOARD_RECOMPUTE_QUEUE = "workboard.recompute"` | `0 3 * * *` (03:00), retryLimit 1 / retryDelay 60s | `recomputeAllWorkboardPages` | `workboard_state` |

Classify runs first (01:00) so fresh verdicts feed the 03:00 recompute; recompute runs after spend rollups settle. Manual API classify runs execute **detached** inside the API process (not on the queue).

### 14.5 Postgres tables written/read within this territory (`packages/db/src/schema.ts`)
| Table | Keys | Role |
|---|---|---|
| `workboard_snoozes` | unique (page, fan) | v1 **and** v2 snoozes; `snoozed_until` |
| `workboard_state` | PK (page, fan) | v2 persisted FSM row: tab, mass_substate, value/urgency/rank scores, secondary_status, tiers/confidences, needs_reply, why_now, reason_chips (jsonb), freeloader_status/episodes(jsonb)/lifetime, reactivation_attempted_at, service_reason |
| `workboard_contact_log` | id; idx (page,fan,acted_at), (model,fan,date), (page,date) | append-only touch log; `model_id`, `action`(opened/handled/snoozed), `was_productive`, `business_date` |
| `wb_closing_cache` | unique (page, platform_message_id) | permanent L2 verdict cache; `needs_reply`, `layer`("l2"), `content_hash`, `state`, `reason`, `model` |
| `wb_closing_settings` | PK page | per-page override: `enabled`, `daily_cap_max`, `model` (null = inherit env) |
| `wb_classifier_runs` | id | run log; `trigger`(cron/manual/reclassify), token counts, `status`, `error` |
| `wb_llm_usage_daily` | PK (page, business_date, feature) | per-page/day cap + cost counter; feature `"closing-classifier"` |

Read-only upstream (owned elsewhere): `page_fans`, `fans`, `page_subscriptions`, `page_dm_threads`, `page_dm_messages`, `fan_spend_lifetime`, `fan_spend_daily`, `transactions`, `fan_flags`, `pages`.

### 14.6 Secrets / config (`config-registry.ts`, `config.ts`)
| Env var | Config field | Default | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | `anthropicApiKey` | (unset) | secret, never editable; key-gates the classifier AND the AI gateway |
| `WB_CLOSING_LLM_ENABLED` | `wbClosingLlmEnabled` | false | staged flag; parsed as `enabled && key!=null` (`config.ts:434`) |
| `WB_CLOSING_LLM_MODEL` | `wbClosingLlmModel` | `claude-haiku-4-5` | editable |
| `WB_CLOSING_LLM_DAILY_CAP_MIN` | `wbClosingLlmDailyCapMin` | 50 | editable |
| `WB_CLOSING_LLM_DAILY_CAP_MAX` | `wbClosingLlmDailyCapMax` | 400 | editable; raises the daily Anthropic spend ceiling |
| `OFAPI_PRESENCE_PROJECTION_ENABLED` | `ofapiPresenceProjectionEnabled` | false | staged; gates OnlyFans presence reads (`workboard-presence.ts:160`) |
