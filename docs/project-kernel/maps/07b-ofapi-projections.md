> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Territory 07b — OFAPI Projections (webhook / sync → storage)

**Scope.** This document covers the services that transform inbound OnlyFans-via-OFAPI data (webhook journal rows and REST sync responses) into the durable Postgres storage model that the API serves. Files fully read for this territory:

- `apps/runtime/src/services/ofapi-dm-projection.ts` — webhook DM projection into `page_dm_threads` / `page_dm_messages`.
- `apps/runtime/src/services/ofapi-dm-archive.ts` — webhook DM cold archive into `dm_message_archive`, retention purge.
- `apps/runtime/src/services/ofapi-dm-analytics.ts` — hourly rebuild of `dm_message_daily_aggregates` from the archive.
- `apps/runtime/src/services/ofapi-presence-projection.ts` — `users.online` / `users.offline` → presence store.
- `apps/runtime/src/services/ofapi-subscription-projection.ts` — `subscriptions.new` / `.renewed` → `page_subscriptions` / `page_fans`.
- `apps/runtime/src/services/ofapi-sync-snapshot.ts` — read model that assembles a resumable desktop snapshot from the projected tables + archive.
- `apps/runtime/src/services/sync/ofapi-dm-sync.ts` — REST bootstrap/reconcile of DM conversations + per-conversation message backfill; the shared credit-budget guard.
- `apps/runtime/src/services/sync/ofapi-audience-sync.ts` — REST `fans/active` sweep into subscriptions/fans with generational expiry.
- `packages/db/src/repositories/ofapi-sync-snapshot.ts` — snapshot queries.
- `packages/db/src/repositories/dm-message-archive.ts` — archive upsert/tombstone/purge/status.
- `packages/db/src/repositories/dm-analytics.ts` — daily-aggregate rebuild/read.
- `packages/db/src/repositories/page-dm.ts` — the conversation/message repository shared by the projection and the sync streams.

Traced beyond scope for boundaries: `apps/runtime/src/services/ofapi-events.ts` (the settle path that invokes the post-settle hook and schedules the sweeps), `apps/runtime/src/services/ofapi-payloads.ts` (envelope schema + id/notification parsing), `packages/db/src/repositories/ofapi.ts` (journal-row bookkeeping, credit reservation), `packages/db/src/repositories/fans.ts` (fan/subscription/presence upserts), `apps/runtime/src/services/ofapi.ts` (OFAPI REST client), `packages/db/src/schema.ts`, `packages/shared/src/config.ts`, migration `0032_requeue_cross_stamped_ofapi_projections.sql`. Cross-refs: territory 07 (webhook receiver + SSE fanout + settle), 04 (Fansly/generic sync engine that these streams plug into), 05 (credit ledger / budgets).

---

## 1. Where this territory sits

Two ingest fronts feed the same durable store:

1. **Webhook projections (push, near-real-time).** OFAPI POSTs webhook deliveries to the receiver (territory 07); each delivery is journaled as one `ofapi_webhook_events` row and later *settled* by the single-worker event processor in `ofapi-events.ts`. **Strictly after** the settle commit, `runPostSettleOfapiProjections` (`ofapi-events.ts:94`) fans the settled row through four projections in this territory (cold archive, DM, subscription, presence) plus spend/health projections outside it. A minutely sweep re-runs any projection that was lost or failed.
2. **REST sync streams (pull, budgeted).** For OnlyFans pages mapped to an OFAPI account, the sync engine (territory 04) runs three executor streams that live here: `dm_conversations` and `dm_messages` (`ofapi-dm-sync.ts`) and `subscribers` (`ofapi-audience-sync.ts`). They call the OFAPI REST API for bootstrap + periodic reconcile/sweep and write the same tables the webhook projections do.

Both fronts write **platform-agnostic** tables (`page_dm_threads`, `page_dm_messages`, `page_subscriptions`, `page_fans`, `fans`) that the Fansly sync also fills, plus two OFAPI-only tables (`dm_message_archive`, `dm_message_daily_aggregates`). The invariant everywhere: **conversation heads only ever advance**, tip/purchase annotations are monotonic, and no projection ever blocks or fails the settle/fanout path.

### 1.1 Feature flags (all default `false`; `packages/shared/src/config.ts`)

| Env var | `AppContext.config` key | Gates |
| --- | --- | --- |
| `OFAPI_DM_PROJECTION_ENABLED` | `ofapiDmProjectionEnabled` | webhook DM projection (`isOfapiDmProjectionEnabled`) |
| `OFAPI_DM_COLD_ARCHIVE_ENABLED` | `ofapiDmColdArchiveEnabled` | webhook DM cold archive |
| `OFAPI_PRESENCE_PROJECTION_ENABLED` | `ofapiPresenceProjectionEnabled` | standalone presence projection **and** the presence fold-in inside the DM projection (`ofapi-dm-projection.ts:242`) |
| `OFAPI_AUDIENCE_SYNC_ENABLED` | `ofapiAudienceSyncEnabled` | audience `subscribers` sweep **and** the subscription webhook projection (see §7 discrepancy) |
| `OFAPI_DM_SYNC_ENABLED` | `ofapiDmSyncEnabled` | REST `dm_conversations` / `dm_messages` streams |
| `OFAPI_DM_COLD_ARCHIVE_RETENTION_DAYS` | `ofapiDmColdArchiveRetentionDays` | archive retain-until horizon (default 3650 days) |
| `OFAPI_DM_RECONCILE_INTERVAL_MINUTES` | `ofapiDmReconcileIntervalMinutes` | conversation reconcile cadence (default 360) |
| `OFAPI_AUDIENCE_SWEEP_INTERVAL_MINUTES` | `ofapiAudienceSweepIntervalMinutes` | audience sweep cadence (default 1440) |

The **DM daily-analytics rebuild is NOT flag-gated** — its queue/schedule/worker are registered unconditionally (`worker-services.ts:138,147,183`); when cold archive is off the archive table is empty and the rebuild simply writes zero rows.

### 1.2 The journal row (`ofapi_webhook_events`, `schema.ts:2119`)

Every projection consumes a subset of this row. Columns relevant here:

| Column | Meaning for projections |
| --- | --- |
| `id` (bigserial) | journal id; projection ordering + `source_journal_id` in the archive |
| `idempotency_key` | dedupe key from the `x-ofapi-idempotency-key` header; copied into `dm_message_archive.source_idempotency_key` |
| `event_type` | e.g. `messages.received`; each projection filters to its own set |
| `ofapi_account_id` | resolves to a `pages` row via `findPageByOfapiAccountId` |
| `platform_account_id` | filled at settle; the internal `pages.id` |
| `payload` (jsonb) | the raw OFAPI envelope `{ event, account_id, payload }` |
| `fanout_seq` (bigint) | settle-ordered SSE cursor from sequence `ofapi_webhook_events_fanout_seq`; copied into `dm_message_archive.source_fanout_seq` |
| `status` | `pending`→`processed`/`skipped`/`failed` (settle path) |
| `projection_status` | `none`/`pending`/`projected`/`skipped`/`failed` — DM/subscription/presence bookkeeping (shared column, single stream) |
| `projection_error`, `projection_attempts`, `projected_at` | projection retry bookkeeping (cap 5 attempts) |
| `archive_status` | `none`/`pending`/`archived`/`skipped`/`failed` — cold-archive bookkeeping (independent column) |
| `archive_error`, `archive_attempts`, `archived_at` | archive retry bookkeeping (cap 5 attempts) |
| `received_at` | wall-clock receive time; the archive uses it as `source_received_at` and the retain-until base |

**Important:** `projection_status` is a **single shared column** for the DM, subscription, and presence projections. Each runner is event-type-gated so it only stamps its own event types (see §11 / migration 0032). `settleOfapiWebhookEvent` and `markOfapiWebhookEventProjection` (`ofapi.ts:79,120`) never touch each other's columns; `markOfapiWebhookEventProjection` only advances rows whose `projection_status` is `pending` or `failed`, so a terminal `projected`/`skipped` is never demoted by a racing duplicate.

### 1.3 Shared payload helpers (`ofapi-payloads.ts`)

- `ofapiWebhookEnvelopeSchema` — Zod `{ event: string, account_id?: string|null, payload: unknown }`. The event **id is not in the body** (dedupe is header-based upstream).
- `asRecord(v)` — narrows to a plain object or null.
- `idToString(v)` — OnlyFans ids arrive as numbers in message payloads and strings in notification payloads; this coerces finite numbers / non-empty strings to string, else null.
- `extractMessageIdFromNotification(payload)` — pulls `firstId=<msgId>` from the chat link embedded in `payload.text` / `payload.replacePairs` values (ppv/tip notifications carry no explicit message id).
- `notificationChatId(payload)` — `payload.user.id`, else the `/my/chats/chat/<fanId>` link; **`payload.user_id` is deliberately NOT a fallback** (in live captures it holds the creator's id, not the fan's).
- `normalizeDmMessageText` (`packages/shared/src/dm-text.ts:23`) — OnlyFans message `text` is HTML; this converts `<br>/<p>/<div>/<li>` to newlines, strips remaining tags, decodes entities, collapses whitespace, trims.

---

## 2. DM projection — webhook events → `page_dm_threads` / `page_dm_messages`

File: `ofapi-dm-projection.ts`. Projected event types (`OFAPI_DM_PROJECTION_EVENT_TYPES`, line 43): `messages.received`, `messages.sent`, `messages.deleted`, `messages.ppv.unlocked`, `tips.received`.

Entry points:
- Post-settle: `runOfapiDmProjectionForSettledRow` (line 464) — runs when the flag is on **and** the row's event type is a DM type **and** `projection_status ∈ {pending, failed}`. It calls `projectOfapiDmEvent`, then `markOfapiWebhookEventProjection` with the outcome. Infrastructure errors are caught and recorded as `failed` (retryable); it never throws.
- Sweep: `sweepOfapiDmProjections` (line 512) — minutely, pulls up to 200 rows via `listOfapiWebhookEventsForDmProjection` (settled rows with `projection_status = pending`, or `failed` under `projection_attempts < 5`), oldest-first, and re-runs each.

`projectOfapiDmEvent` (line 410): validates the envelope, resolves the page via `findPageByOfapiAccountId`, requires `page.platform === "onlyfans"`, then dispatches by event type. Non-OnlyFans / unmapped / bad-payload cases return `{status:"skipped", reason}` (terminal, no retry).

### 2.1 `messages.received` / `messages.sent` — the message object

`parseOfapiDmMessagePayload` (line 148) maps the **complete OnlyFans message object**:

| Source field (payload) | Rule | Target |
| --- | --- | --- |
| `fromUser` (received) / `toUser` (sent) | the **fan/partner** user object; sent events omit `fromUser` in live captures | fan identity |
| `partner.id` | `idToString` | `fanId` — used as `platform_conversation_id`, `partner_platform_user_id`, and (received) `sender_platform_user_id` |
| `id` | required | `platform_message_id` |
| `createdAt` | required, parseable ISO | `created_at` |
| `text` | `normalizeDmMessageText` | `content` (+ 280-char truncated `last_message_preview`) |
| `fromUser.id` | actual sender | `senderPlatformUserId` |
| `partner.name` ?? `partner.displayName` | OF carries display name in `name` | `partner_display_name` |
| `partner.username` | | `partner_username` |
| `isTip === true` ? `price`→cents | **priced non-tip messages are PPV, not revenue**, so only tips carry an amount | `total_tip_amount_cents` |
| `replyToMessage.id` | | `in_reply_to_message_id` |
| `partner.lastSeen` | folded into presence (flag-gated) | `page_fans.external_presence_at` |

Missing id / fan identity / parseable timestamp → `null` → skipped as a permanent data problem.

`projectDmMessageEvent` (line 199) runs in one transaction:

1. **Lock the conversation row for update** (`listPageDmConversationsByPlatformConversationIds(..., forUpdate:true)`). Lock order — conversation **before** fans — matches the REST reconcile's `applyChatSummaries`, so the two writers serialize instead of racing a lost update on the head (audit B11).
2. If the message id is already stored (`getExistingPageDmMessageIds`), short-circuit to `projected` — at-least-once replay; tip/purchase annotations are owned by their own events.
3. `upsertFans` on `(platform="onlyfans", platformUserId=fanId)` (fans are global, keyed on `(platform, platform_user_id)`), then `upsertFanPages` to link `fan_id ↔ platform_account_id`.
4. If `ofapiPresenceProjectionEnabled` and `partner.lastSeen` present: `upsertFanPageExternalPresences` folds the fan's last-seen into `page_fans` (source `ofapi_last_seen`, forward-only — see §6).
5. **Head/unread computation.** `headAdvances` (line 185): the head moves only to a strictly later `created_at`, or (equal timestamp) a greater message id (numeric compare via `BigInt` when both are numeric strings, lexicographic fallback). Unread heuristic: a `received` message increments `unread_count`; a `sent` message at a new head zeroes it (`unread_count = received ? existing+1 : advance ? 0 : existing`).
6. `upsertPageDmConversation` with `headForwardOnly:true` (see §9.5). `last_message_sender_role` is set to `fan` (received) / `model` (sent); `message_coverage_status` defaults to `pending_backfill`; `metadata.provider` set to `ofapi`; `is_visible:true` (a live message un-hides a generation-retired thread).
7. `upsertPageDmMessages` with `sender_role = fan|received-fanId` or `model|senderPlatformUserId`.
8. `refreshPageDmConversationWindow(enforceRetention:true)` — recomputes `stored_message_count`, `newest/oldest_stored_message_id`, `last_fan/model_message_at` from disk and **prunes to the retention tier immediately** (see §4).

**Sender-role resolution:** received → `fan`, sent → `model`. (The REST path additionally derives from `isSentByMe`/id comparison; see §9.2.)

**Message account invariant:** `page_dm_messages` carries `platform_account_id` redundantly and a composite FK `page_dm_messages_conversation_account_fk` on `(conversation_id, platform_account_id) → page_dm_threads(id, platform_account_id)` (`schema.ts:952`). A message can never be attached to a conversation belonging to a different page. Message uniqueness is `(conversation_id, platform_message_id)` (`page_dm_messages_conversation_message_uniq`).

### 2.2 `messages.deleted` — tombstone

`projectDmMessageDeleted` (line 329): `idToString(payload.id)` → `deletePageDmMessageByPlatformMessageId` (soft-delete: sets `deleted_at`, blanks `content`, zeros tip, nulls reply/purchase). Returns the conversation id when a live row was removed; if nothing stored → skipped. Then `refreshPageDmConversationWindow(rebuildHeadForDeletedMessageId)` rebuilds the head from the newest remaining stored row **only if the deleted id was the head** (audit B10 — never previews deleted content, never regresses a head legitimately ahead of the stored window). If the deleted id was `last_unread_message_id`, `unread_count` is decremented and the unread pointer re-derived.

### 2.3 `messages.ppv.unlocked` — purchase annotation

`projectDmPpvUnlocked` (line 362): message id via `extractMessageIdFromNotification` (from the chat link). `markPageDmMessagePurchased` sets `purchased_at` guarded on `purchased_at is null` (idempotent). Not stored / already marked → skipped. Runs on `app.db` directly (no wrapping transaction).

### 2.4 `tips.received` — monotonic tip amount

`projectDmTipReceived` (line 382): message id from the link; `payload.amountGross` (USD) → cents. `raisePageDmMessageTipAmount` sets `total_tip_amount_cents = greatest(existing, incoming)` — **monotonic, not additive**, because tip events are at-least-once and can race the message upsert. Not stored → skipped. Non-positive amount → skipped.

---

## 3. Boundary between the webhook projection and the SSE frame

The same journal row is also mapped to an SSE `SyncEvent` frame in `mapOfapiEventToSyncEvent` (`ofapi-events.ts:117`) — that is the fanout path (territory 07), separate from this projection. The projection writes durable rows; the SSE frame is the live push. The two share the payload helpers but are independent: `subscriptions.new/.renewed` produce a `chatListUpdated` frame and feed the subscription projection; `transactions.new` is journaled without fanout and is not projected here.

---

## 4. Retention tiers & window bookkeeping (`page-dm.ts`)

Retention limits (`page-dm.ts:19`): **regular 200 / spender 1000** messages per conversation. `getPageDmMessageRetentionLimit` (line 598) returns 1000 when `fan_spend_lifetime.creator_net_amount_mills > 0` for the `(page, fan)`, else 200. `prunePageDmMessagesToLimit` deletes rows ranked beyond the limit (order `created_at desc, platform_message_id desc, id desc`). The `page_dm_threads.stored_message_count` check constraint bounds it `between 0 and 1000` (`schema.ts:902`).

- `refreshPageDmConversationWindow` (line 718) — used by **live ingest and deletions** (webhook projection); recomputes the window and optionally prunes, but deliberately leaves `message_coverage_status` / `last_message_sync_at` untouched.
- `finalizePageDmConversationMessageSync` (line 801) — used by the **REST message backfill**; prunes, recomputes the window, **and** writes `message_coverage_status` / `last_message_sync_at`.

`message_coverage_status` (enum `pending_backfill | partial_window | complete`) is the coverage watermark per conversation. `selectNextPageDmMessageSyncCandidate` / `selectNextPageDmMessageDeepBackfillCandidate` (lines 909, 1010) pick the next conversation to backfill, prioritizing stale-head mismatches then `pending_backfill`, then unread, expiring subscribers (≤21 days), and lifetime spend.

---

## 5. DM cold archive (`ofapi-dm-archive.ts`) + tiered retention

The cold archive is a **complete, immutable, per-message durable copy** of OnlyFans DM webhook events into `dm_message_archive` (`schema.ts:960`), independent of the hot `page_dm_messages` window. Archived event types (line 24): `messages.received`, `messages.sent`, `messages.deleted` (no ppv/tips).

Entry points mirror the DM projection but use the **independent `archive_status` column** and a `markOfapiWebhookEventArchivePending` claim (line 290) so exactly one worker archives a row:
- `runOfapiDmColdArchiveForSettledRow` (line 267) — flag-gated; skips rows whose `archive_status` is a terminal non-`failed` value, and `failed` rows at/over 5 attempts. Claims the row (`none|failed → pending`), archives, then marks `archived`/`skipped`/`failed`.
- `sweepOfapiDmColdArchives` (line 332) — minutely, up to 200 rows via `listOfapiWebhookEventsForDmColdArchive`.

### 5.1 Archive row shape (`upsertDmMessageArchive`, `dm-message-archive.ts:67`)

`parseArchiveMessage` (line 144) maps a message; money is in **mills** here (not cents): `usdToMills(price) = BigInt(round(price*1000))`. Fields written: `platform="onlyfans"`, `platform_account_id`, `ofapi_account_id`, `platform_conversation_id = fanId`, `fan_platform_user_id`, `platform_message_id`, `sender_platform_user_id`, `sender_role` (`model` if sent else `fan`), `is_sent_by_me`, `message_created_at`, `text_plain`, `price_mills` (the PPV unlock price, whether or not sold), `is_opened`, `is_tip`, `tip_amount_mills` (`isTip ? price_mills : 0`), `in_reply_to_message_id`, media metadata, and full source provenance (`source="webhook"`, `source_event_type`, `source_idempotency_key`, `source_journal_id`, `source_fanout_seq`, `source_received_at`, `raw_shape_version="ofapi-message-v1"`), plus `retention_policy="default"` and `retain_until`. Upsert conflict target is `(platform, ofapi_account_id, platform_message_id)` — a message id unique **per OFAPI account**.

Media (`normalizeArchiveMediaItem`, line 121): `{ id, type ∈ {photo,video,audio,gif,other}, isReady (default true unless explicitly false), locked (canView===false), width/height (best of full/preview/thumb/squarePreview files), durationSeconds }`. **D5: media is never downloaded** — stable metadata only, no signed URLs.

### 5.2 Deletions → tombstones

`messages.deleted` → `tombstoneDmMessageArchive` (line 142): inserts/updates a row with **null `platform_conversation_id`, null `message_created_at`**, `deleted_at = source_received_at`, `sender_role="unknown"`. On conflict, `deleted_at` is set only if currently null (`coalesce`), preserving the earliest deletion. These null-conversation/null-created rows are the "unresolved tombstones" surfaced in the snapshot (§8) — a deletion whose original message was never archived.

### 5.3 Retention purge

`retain_until = source_received_at + retentionDays·86400s` (`archiveRetainUntil`, line 77; default `DEFAULT_DM_COLD_ARCHIVE_RETENTION_DAYS = 3650`). `cleanupExpiredDmMessageArchive` → `deleteExpiredDmMessageArchiveRows` deletes rows where `retain_until < now`, run daily by `OFAPI_EVENT_CLEANUP_QUEUE` (`ofapi-events.ts:494`). Note: this is a single time-based horizon, **not** the 200/1000 message-count tiers — those tiers apply only to the **hot** `page_dm_messages` window (§4). The 3650-day default retains ~10 years of transcript in the cold archive.

### 5.4 Archive status endpoint

`getOfapiDmColdArchiveStatus` (line 358) → `getDmMessageArchiveStatus` (`dm-message-archive.ts:225`) returns `rowCount`, `tombstoneCount`, `lastArchivedAt`, `lastSourceReceivedAt`, `nextPurgeAt` (`min(retain_until)`), `archiveLagMs` (now − last source received), `archivePendingCount`/`archiveFailedCount`/`lastArchiveError` (from `ofapi_webhook_events.archive_status`). Served at `GET /api/v1/admin/ofapi/dm-archive/status` (owner-only, `server.ts:1716`). Static policy labels advertise: ACL owner-only, no raw transcript export endpoint yet, media = stable metadata only.

---

## 6. Presence projection (`ofapi-presence-projection.ts`)

Event types: `users.online`, `users.offline`. Post-settle `runOfapiPresenceProjectionForSettledRow` (line 149) and minutely `sweepOfapiPresenceProjections` (line 184), both gated by `ofapiPresenceProjectionEnabled` and using the shared `projection_status` column (reusing `listOfapiWebhookEventsForDmProjection`).

`parseOfapiPresencePayload` (line 62) — **note the snake_case fields** (presence webhook payloads differ from the camelCase message payloads):
- `fanId = payload.fan.id`.
- `lastSeenAt = last_seen_online_at ?? status_changed_at ?? observed_at`. For `users.online` this is ~now; for `users.offline` it is the historical last-seen (earlier than the status change).
- `observedAt = observed_at`.

`projectOfapiPresenceEvent` (line 92): resolves the page (OnlyFans only), then **`findPlatformFan("onlyfans", fanId)` — known fans only (D9).** Unknown fan ids are skipped, **never** looked up over REST (presence fires for the whole audience; a per-unknown-id REST lookup would burn credits). For a known fan, `upsertFanPageExternalPresences` writes:

| Presence field | Column (`page_fans` / `fanPages`, `schema.ts:648`) |
| --- | --- |
| `lastSeenAt ?? received_at` | `external_presence_at` |
| `observedAt ?? received_at` | `external_presence_observed_at` |
| `OFAPI_EXTERNAL_PRESENCE_SOURCE_LAST_SEEN` (`"ofapi_last_seen"`) | `external_presence_source` |

The store is **forward-only**: `upsertFanPageExternalPresences` (`fans.ts:433`) uses `greatest(existing, incoming)` on both timestamps, so out-of-order events cannot regress a fresher last-seen. Cost ~0 (webhooks already journaled). The same store is written by three sources: this projection, the DM projection's fold-in (§2.1), the subscription projection (§7), and the audience sweep (§10).

---

## 7. Subscription projection (`ofapi-subscription-projection.ts`)

Event types: `subscriptions.new`, `subscriptions.renewed`. Keeps the subscriber set fresh between audience sweeps.

**Discrepancy / gating:** despite the name, `runOfapiSubscriptionProjectionForSettledRow` (line 237) and `sweepOfapiSubscriptionProjections` (line 272) are gated by **`isOfapiAudienceSyncEnabled` (`OFAPI_AUDIENCE_SYNC_ENABLED`)**, not a dedicated subscription flag. There is no `OFAPI_SUBSCRIPTION_PROJECTION_ENABLED`. It shares the `projection_status` column and `listOfapiWebhookEventsForDmProjection`.

`parseOfapiSubscriptionPayload` (line 85):
- Subscriber identity is **`payload.user`** (full OF user object); `fanId = payload.user.id`. **`payload.user_id` is NOT trusted** (carries the creator's id in other notification payloads).
- `priceDollars` = `replacePairs["{PRICE}"]` parsed from a `"$4.00"` string, else `user.subscribePrice` (positive number), else null.
- `occurredAt = payload.createdAt`; `lastSeenAt = user.lastSeen`; identity `username`/`name`.

`projectOfapiSubscriptionEvent` (line 123), in one transaction:
1. `upsertFans` (onlyfans, fanId).
2. **Lock the subscription row for update** (`findPageSubscription(..., forUpdate:true)`; lock order fans-before-subscriptions matches the sweep — audit P-26).
3. Carry-forward from `existing`: `priceMills = dollarsToMills(priceDollars) ?? existing.priceMills ?? 0`. **The webhook carries no renew/expiry dates**, so `renewDate`, `endsAt`, `billingCycleDays`, `durationDays`, `autoRenew`, `renew_price_mills`, `last_seen_generation` all stay whatever the **sweep** last wrote (the sweep owns them). `sourceUpdatedAt` is forward-only (`existing.sourceUpdatedAt > occurredAt ? existing : occurredAt`).
4. `upsertPageSubscription` with `platform_subscription_id = fanId` (OnlyFans has one relationship per fan-page pair, no exposed subscription id), `canonical_status = "active"`, `raw_status = existing ?? 0`.
5. `upsertFanPages` with `is_subscriber:true`, `subscriber_since = source_created_at`.
6. If `lastSeen` present, `upsertFanPageExternalPresences` (source `ofapi_last_seen`).

---

## 8. Sync snapshot read model (`ofapi-sync-snapshot.ts`)

`getOfapiSyncSnapshot` (line 67) assembles a **resumable, chatter-key-scoped snapshot** for one OFAPI account, served at `GET /api/v1/events/snapshot` (`server.ts:1542`; requires an API-key principal — the desktop/extension client — and filters by `principal.assignedPageIds`). It reads only projected/archive tables; it makes **no** OFAPI calls.

Flow:
1. `getOfapiFanoutReplayWindow` → `latestSeq`. `snapshotCursor` defaults to `latestSeq`; validates `snapshotCursor ≤ latestSeq` and `afterSeq ≤ snapshotCursor` (else `BadRequestError`).
2. `findOfapiSyncSnapshotPage` — the page must be in `assignedPageIds` **and** match `ofapi_account_id` (else `NotFoundError`).
3. `listOfapiSyncSnapshotThreads` — `page_dm_threads` for the page, keyset-paginated by `id > pageCursor` (limit+1 to detect `hasMore`). `hasUnreadTips` is a correlated subquery: among the newest `unread_count` non-deleted fan messages, any with `total_tip_amount_cents > 0`.
4. `listOfapiSyncSnapshotHotMessages` — non-deleted `page_dm_messages` for the returned threads (the hot window).
5. `listOfapiSyncSnapshotArchiveMessages` — `dm_message_archive` rows for those conversations where `source_fanout_seq > afterSeq` (delta) **or** id ∈ the hot message ids (so the client gets richer archive fields — media, price, isOpened — for hot rows). Media normalized via `normalizeArchiveMedia`.
6. `listOfapiSyncSnapshotUnresolvedTombstones` (only when `pageCursor === 0`) — archive rows with **null `platform_conversation_id`, null `message_created_at`, `source_fanout_seq > afterSeq`** (deletions whose original was never archived; §5.2).

Output frame (`version:1`): `{ requestedAfterSeq, snapshotCursor, stateAt, resumeAllowed, page{...auth}, coverage{durableDomains, omittedDomains, messageWindow}, threads[...], unresolvedTombstones[...], nextPageCursor }`. Per-message shape merges hot + archive into `{ chatId, messageId, message{id,text,createdAt,isSentByMe,price,isOpened,isTip,tipAmountUsd,media[]}, deletedAt, sourceUpdatedAt, sourceFanoutSeq }`. Money crosses the wire as **USD dollars** (`price = price_mills/1000`, `tipAmountUsd = tip_amount_mills/1000` for archive; `tipAmountUsd = total_tip_amount_cents/100` for hot).

`coverage` is derived from the two content flags: `durableDomains` includes `chat_heads`/`hot_messages` only when `ofapiDmProjectionEnabled`, `message_tombstones` only when `ofapiDmColdArchiveEnabled`, always `account_auth`. `omittedDomains` names `presence`/`typing` as `ephemeral_not_snapshotted` and adds `chat_heads_and_hot_messages`/`message_tombstones` when the respective flag is off. `resumeAllowed = dmProjectionEnabled && coldArchiveEnabled`. `page.authenticated` is derived from `pages.ofapi_auth_status` (`connected`/`reconnected`/`session_expired` → true; `authentication_failed`/`otp_code_required`/`face_otp_required` → false; else null).

---

## 9. REST DM sync (`ofapi-dm-sync.ts`)

Two executor streams for OnlyFans pages mapped to an OFAPI account (behind `OFAPI_DM_SYNC_ENABLED`). REST is used only for **bootstrap + reconcile**; live messages arrive via the webhook projection (§2). Eligibility (`isOfapiDmSyncEligiblePage`, line 90): flag on + `platform==="onlyfans"` + non-empty `ofapiAccountId`.

### 9.1 Credit-budget guard (`createOfapiRestGuard`, line 165) — shared with §10

Checked before **every** REST request (`resolveBlock`), returns one of three blocks:
- `ofapi_request_budget` — per-run request cap (`maxRequestsPerRun`, default 25) reached; yields like normal budget exhaustion.
- `ofapi_credit_floor` — last observed balance is below `ofapiCreditFloor` (default 500) **and** the observation is fresh (`< OFAPI_FLOOR_BALANCE_FRESHNESS_MS = 1h`). A stale sub-floor balance lets one probe request through per park cycle so `_meta` refreshes the balance (audit F7).
- `ofapi_daily_credit_budget` — `reserveOfapiDayCredits` (reserve-before-request, atomic; audit F9) refused a 1-credit reservation against the UTC-day budget (default 500 DM / 300 audience).

`recordResponse` settles each reservation to server-reported actuals (`page.meta.creditsUsed`). With the credit ledger on (`isOfapiCreditLedgerEnabled`), the OFAPI client's `onCreditSpend` sink already recorded actuals+balance; the guard only releases the reservation. Off, the guard settles `creditsDelta = actual − estimate` and records `page.meta.creditBalance`. Scope is `global` unless `budgetScope:"audience"` **and** ledger on → `audience` (dedicated day counter). Budget/floor blocks return `budgetBlockResult` with a 1h `continuationRetryAt` so the stream parks (cross-ref territory 05 for the ledger/day-counter internals).

### 9.2 `executeOfapiDmConversationsChunk` (line 495) — chat heads

- **OFAPI REST:** `client.listChats(ctx, accountId, {limit:100, offset, order:"recent"})` → `GET https://app.onlyfansapi.com/api/{accountId}/chats` (operation `ofapi_chats`).
- Checkpoint state (`pageSyncCursors`) tracks `offset`, `pageCount`, `bootstrapCompletedAt`, `lastReconcileAt`. A non-OFAPI checkpoint (parked OnlyMonster state) parses to null and restarts as a fresh bootstrap.
- **Bootstrap:** full offset walk (100/page), each page committed with `upsertCheckpointProgress`; on the last page (`!hasNextPage || items empty`) commits `upsertCheckpoint` (advances `lastSuccessfulRunId`) and sets `bootstrapCompletedAt`/`lastReconcileAt`.
- **Reconcile:** after bootstrap, every `ofapiDmReconcileIntervalMinutes` (default 360) fetch page-1 only and re-apply.
- `parseOfapiChatSummary` (line 336) maps each item: `fanId = item.fan.id`; `unreadCount = item.unreadMessagesCount`; head from `item.lastMessage` (`id`, `createdAt`, sender-role from `isSentByMe` boolean, else id-vs-fanId compare). **Sender-role resolution here:** `isSentByMe===true → model`, `false → fan`, else `senderId===fanId → fan` else `model`, else `unknown`.
- `applyChatSummaries` (line 574): **locks the conversation rows for update** (order: conversations before fans — matches the projection), `upsertFans`+`upsertFanPages`, then `upsertPageDmConversation` per summary. The chats list is **authoritative for `unread_count`** (corrects the projection's heuristic drift); heads still `headForwardOnly:true` so a fresher webhook head is never regressed. `last_fan/model_message_at` advance via `laterOf`. Conversations needing a message follow-up (`needsDmMessagesFollowup`, line 430) trigger `requestPageSync(streams:["dm_messages"])`.

### 9.3 `executeOfapiDmMessagesChunk` (line 808) — per-conversation backfill

- **OFAPI REST:** `client.listChatMessages(ctx, accountId, chatId, {limit:100, firstId})` → `GET .../{accountId}/chats/{chatId}/messages` (operation `ofapi_chat_messages`). `first_id` is **inclusive**, so the cursor echo row is filtered out (line 909).
- Picks the next conversation via `selectNextPageDmMessageSyncCandidate`; mode = `backfill` (walk older) or `incremental` (walk newer). Checkpoint carries `currentConversationId`, `currentBeforeMessageId`, `currentMode`.
- `parseOfapiRestMessage` (line 393) maps each message (same tip/PPV rule: only `isTip` messages carry cents). Already-stored ids are **skipped, not re-upserted** (line 951), so the webhook projection's tip/purchase annotations survive the REST walk. New rows → `upsertPageDmMessages`.
- Coverage transitions (`resolveOfapiCoverageStatus`, line 452): backfill → `complete` on overlap or provider-history exhaustion; → `partial_window` on hitting the retention cap; incremental keeps its status. On completion, `finalizePageDmConversationMessageSync` prunes, recomputes the window, and stamps `message_coverage_status` + `last_message_sync_at`.

### 9.4 Boundaries out of DM sync

Reads: `page_dm_threads`/`page_dm_messages`, `page_sync_cursors`, `fan_spend_lifetime` (spender tier). Writes: `fans`, `page_fans`, `page_dm_threads`, `page_dm_messages`, `page_sync_cursors`. Credit accounting: `ofapi_credit_*` (territory 05). Outbound HTTP: OFAPI REST (above).

### 9.5 `upsertPageDmConversation` head-forward guard (`page-dm.ts:163`)

Conflict target `(platform_account_id, platform_conversation_id)`. When `headForwardOnly:true` (set only by the OFAPI writers — projection and REST reconcile), the conflict-update wraps the five head columns (`last_message_id/at/sender_id/sender_role/preview`) in a SQL `headAdvanceCondition` (line 146) identical to the JS `headAdvances`: advance only to a strictly later timestamp, or a greater message id on equal timestamps (numeric compare when both ids are numeric). This is the **insert-race defense** for the case where the row did not exist at read-time (nothing to lock). Fansly's REST sync does **not** set the flag — it stays authoritative for its own heads and can move a head back when the platform deleted the head message.

---

## 10. REST audience sync (`ofapi-audience-sync.ts`) — subscribers

One executor stream (`subscribers`) for OFAPI-mapped OnlyFans pages, behind `OFAPI_AUDIENCE_SYNC_ENABLED`. `filterOnlyFansAudienceStreams` (line 97) strips `subscribers` from non-eligible OnlyFans pages; `pauseDisabledOnlyFansAudienceForAllPages` pauses the stream for ineligible pages.

- **OFAPI REST:** `client.listActiveFans(ctx, accountId, {limit:20, offset})` → `GET .../{accountId}/fans/active` (operation `ofapi_fans_active`). **Hard cap 20 fans/request** per the OFAPI OpenAPI validation.
- Own daily ceiling (`ofapiAudienceDailyCreditBudget` default 300, `budgetScope:"audience"`) so it can never starve DM sync.
- Checkpoint state: `generation`, `offset`, `pageCount`, `sweepStartedAt`, `lastSweepCompletedAt`. One full offset sweep per `ofapiAudienceSweepIntervalMinutes` (default 1440). A new sweep bumps `generation`.
- `parseOfapiActiveFan` (line 217): `fanId = item.id`; price from `subscribedOnData.price` ?? `.subscribePrice` ?? `item.subscribePrice` ?? 0; `regularPrice`, `subscribeAt`, `renewedAt`, `expiredAt`, `status`. **`autoRenew = status !== "Set to Expire"`** (the only documented status string; anything else ⇒ auto-renewing). `lastSeen` for presence.
- `applyActiveFans` (line 340): `upsertFans`, then batched `upsertPageSubscriptions` + `upsertFanPages` + `upsertFanPageExternalPresences`. Subscription: `platform_subscription_id = fanId`, `raw_status = 0`, `canonical_status="active"`, `price_mills = dollarsToMills(price)`, `renew_price_mills` from regularPrice, `renew_date = endsAt = expiredAt`, `source_created_at = subscribeAt`, `source_updated_at = renewedAt ?? subscribeAt`, `subscription_tier_id = null` (OnlyFans has no tiers), `last_seen_generation = state.generation`. This is the writer that **owns renew/expiry dates and the generation stamp** (the webhook subscription projection carries them forward, §7).
- **Generational expiry at end of sweep** (mirrors Fansly): `deactivatePageSubscriptionsByGeneration` sets `is_current=false` for rows with `last_seen_generation < generation` (or null) **and `last_seen_at < sweepStartedAt`** (audit P-25 — spares subscriptions the live webhook projection created mid-sweep with a null generation), then `refreshFanPageSubscriberState` + `rebuildSubscriberRollups`, all in one transaction.
- **Empty-first-page guard** (line 436): if `offset===0` returns zero fans while current subscribers exist, it raises an anomaly and **throws** to refuse destructive finalization. **Contradictory pagination** (empty page but `hasNextPage`) completes the sweep but skips the generational expiry.

### 10.1 Boundaries out of audience sync

Reads: `page_subscriptions` (current subscribers), `page_sync_cursors`, `pages`, `page_sync_states`. Writes: `fans`, `page_subscriptions`, `page_fans` (subscriber state + `external_presence_*`), subscriber rollups. Credit accounting: `ofapi_credit_*` audience day counter. Outbound HTTP: OFAPI REST (above).

---

## 11. Projection watermarks & cross-stamp requeue (migration 0032)

Per-row projection progress lives on `ofapi_webhook_events` (§1.2). There is **no separate watermark table** for the webhook projections — each row carries its own `projection_status`/`archive_status`. The audience sweep and per-conversation backfill use `pageSyncCursors` (checkpoint state) and `message_coverage_status` as their watermarks instead.

`getOfapiFanoutReplayWindow` / `fanout_seq` is the **SSE replay watermark** (settle-ordered), used by the snapshot to bound the archive delta (`source_fanout_seq > afterSeq`) and by the SSE cursor (territory 07).

**Migration `0032_requeue_cross_stamped_ofapi_projections.sql`.** Earlier, the DM projection runner stamped **every** settled row it saw. With `OFAPI_DM_PROJECTION_ENABLED` on, presence/subscription rows (`users.*`, `subscriptions.*`) were terminally marked `projection_status='skipped'` with the DM runner's `Event type "..." is not projected` reason — and since `markOfapiWebhookEventProjection` never demotes a settled status, the owning presence/subscription projections and their sweeps silently no-op'ed. The runners are now event-type-gated (each `run*ForSettledRow` early-returns unless the row's event type is in its own set). The migration requeues the mis-stamped rows: `projection_status='skipped'` **and** `projection_error LIKE 'Event type "%" is not projected'` **and** `event_type NOT IN (the five DM types)` → reset to `pending`, `projection_error=NULL`, `projection_attempts=0`, so the presence/subscription sweeps back-project them.

---

## 12. DM daily analytics (`ofapi-dm-analytics.ts` / `dm-analytics.ts`)

pg-boss queue `ofapi.dm-analytics.rebuild`, scheduled hourly at minute 10 UTC (`ensureOfapiDmAnalyticsSchedules`, line 45), worker `startOfapiDmAnalyticsWorker` (line 52), **all unconditional (no flag gate)**. `rebuildRecentDmAnalytics` rebuilds a rolling 32-day window (`OFAPI_DM_ANALYTICS_ROLLING_DAYS`, business date = UTC calendar date).

`rebuildDmMessageDailyAggregates` (`dm-analytics.ts:33`) runs delete-then-insert in one transaction over `[fromBusinessDate, throughBusinessDate]`, aggregating **from `dm_message_archive`** grouped by `(platform_account_id, UTC business date of coalesce(message_created_at, deleted_at, source_received_at))`. Output columns (`dm_message_daily_aggregates`, `schema.ts:1024`): `archive_rows`, `inbound_messages` (fan, non-deleted), `outbound_messages` (model, non-deleted), `deleted_messages`, `distinct_conversations`, `paid_outbound_messages` (model, `price_mills>0`), `paid_outbound_price_mills`, `tip_messages`, `tip_amount_mills`, `first/last_message_at`, `source_max_fanout_seq`, `rebuilt_at`. The table is **aggregate-only — no transcript text, media, or fan identifiers** (privacy boundary).

**Discrepancy:** the reader `listDmMessageDailyAggregates` (`dm-analytics.ts:112`) has **no live caller** in `apps/runtime/src` (only appears in the repository and compiled `dist/`). The daily-aggregates table is currently **write-only** — no HTTP endpoint or report reads it yet.

---

## 13. Boundary catalog

### 13.1 Inbound (served by this territory)

| Endpoint | Auth | Reads | Emits |
| --- | --- | --- | --- |
| `GET /api/v1/events/snapshot` (`server.ts:1542`) | API-key principal (desktop/extension), scoped to `assignedPageIds` | `page_dm_threads`, `page_dm_messages`, `dm_message_archive`, `pages` auth | resumable snapshot JSON: threads, hot+archive messages, unresolved tombstones, coverage, `nextPageCursor`, `snapshotCursor`; money in USD |
| `GET /api/v1/admin/ofapi/dm-archive/status` (`server.ts:1716`) | owner | `dm_message_archive`, `ofapi_webhook_events` | archive health counts, lag, next purge, static policy labels |

### 13.2 Inbound source (consumed, not served)

| Source | Counterpart | Data |
| --- | --- | --- |
| `ofapi_webhook_events` journal rows | OFAPI webhook receiver + settle path (territory 07) | settled envelope `{event, account_id, payload}` + `fanout_seq`, `received_at`, `idempotency_key`; consumed by the four projections post-settle and by the sweeps |

### 13.3 Outbound HTTP (OFAPI REST; base `https://app.onlyfansapi.com/api`, `ofapi.ts:27`)

| Operation | Path | Caller | Data pulled |
| --- | --- | --- | --- |
| `ofapi_chats` | `GET /{accountId}/chats` | `executeOfapiDmConversationsChunk` | chat heads: fan id/username/name, unread count, last message |
| `ofapi_chat_messages` | `GET /{accountId}/chats/{chatId}/messages` | `executeOfapiDmMessagesChunk` | message objects (id, text, createdAt, isSentByMe, price, isTip, replyTo) |
| `ofapi_fans_active` | `GET /{accountId}/fans/active` | `executeOfapiAudienceChunk` | active subscribers (id, prices, subscribe/renew/expire dates, status, lastSeen), max 20/request |

Each response's `_meta` (`creditsUsed`, `creditBalance`) settles the credit reservation (territory 05).

### 13.4 Storage (DB writes)

| Table | Written by | Key columns set |
| --- | --- | --- |
| `page_dm_threads` (conversations) | DM projection, DM sync reconcile | head fields (forward-only), `unread_count`, `stored_message_count`, `message_coverage_status`, `is_visible`, `metadata.provider="ofapi"` |
| `page_dm_messages` | DM projection, DM message backfill | `platform_message_id`, `sender_role`, `content`, `total_tip_amount_cents` (monotonic), `purchased_at`, `deleted_at` (soft delete) |
| `dm_message_archive` | cold archive | full immutable per-message copy + source provenance + media metadata; tombstones for deletions; mills money |
| `dm_message_daily_aggregates` | analytics rebuild | aggregate-only daily facts (no text/identifiers) |
| `page_subscriptions` | subscription projection, audience sweep | `platform_subscription_id=fanId`, `canonical_status="active"`, prices, renew/expiry (sweep-owned), `last_seen_generation` |
| `page_fans` (`fanPages`) | all four projections + both sweeps | subscriber state; `external_presence_at/observed_at/source` (forward-only, `greatest`) |
| `fans` | all projections + sweeps | global `(platform, platform_user_id)` identity, username/display name |
| `ofapi_webhook_events` | projections (bookkeeping only) | `projection_status`/`archive_status` + attempts/error/timestamp (never `status`/`fanout_seq`) |
| `page_sync_cursors` | DM/audience sync | checkpoint JSON (offset, generation, mode, cursor) |

### 13.5 pg-boss queues (`ofapi-events.ts`, `ofapi-dm-analytics.ts`)

| Queue | Cadence | This territory's work |
| --- | --- | --- |
| `ofapi.events.process` | per-delivery (single worker, batch 100, id-sorted) | post-settle hook → DM archive/projection, subscription, presence projections |
| `ofapi.events.sweep` | minutely | `sweepOfapiDmProjections`, `sweepOfapiDmColdArchives`, `sweepOfapiSubscriptionProjections`, `sweepOfapiPresenceProjections` (each cap 200 rows / 5 attempts) |
| `ofapi.events.cleanup` | daily | `cleanupExpiredDmMessageArchive` (retain-until purge) |
| `ofapi.dm-analytics.rebuild` | hourly (`10 * * * *` UTC) | rebuild 32-day `dm_message_daily_aggregates` window |

The REST streams (`dm_conversations`, `dm_messages`, `subscribers`) are dispatched by the generic sync engine/executor (territory 04), not by dedicated queues here.

---

## 14. Notes, discrepancies, and invariants

- **Shared `projection_status` column, three projections.** DM, subscription, and presence all use the one column and one `listOfapiWebhookEventsForDmProjection` query. Correctness relies on each runner being event-type-gated (migration 0032 fixed the historical cross-stamp). Cold archive uses an independent `archive_status` column.
- **Subscription projection is gated by the audience flag**, not a subscription-specific flag (§7).
- **Money units differ by store:** hot `page_dm_messages` uses **cents** (`total_tip_amount_cents`); the cold archive and subscriptions use **mills** (`tip_amount_mills`, `price_mills`, `price_mills`); the snapshot emits **USD dollars**. All webhook amounts originate as USD floats.
- **`price` is the PPV unlock price, not revenue** — only `isTip` messages record a tip amount; priced non-tip messages are PPV and record price (archive) or nothing (hot tip field).
- **Heads only ever advance** everywhere the OFAPI writers touch a conversation (`headForwardOnly` + `headAdvances`); Fansly's writer is exempt and stays authoritative for its own heads.
- **Retention is two-layered:** hot window pruned to 200 (regular) / 1000 (spender ≥ 1 mill lifetime net) messages per conversation; cold archive purged on a single time horizon (default 3650 days).
- **`dm_message_daily_aggregates` is write-only today** — the rebuild runs unconditionally but nothing reads the table (§12).
- **Presence is known-fans-only (D9)** and media is metadata-only (D5) — both explicitly avoid credit-charged REST lookups / downloads.
- **Concurrency:** the webhook projection and the REST reconcile both `SELECT … FOR UPDATE` the conversation (and subscription) row in a fixed lock order (conversations-before-fans; fans-before-subscriptions) to serialize the read-compute-full-row-upsert cycle (audits B11 / P-26); the insert-race case relies on the SQL head guard.
- **Projections never break the settle/fanout path:** `runPostSettleOfapiProjections` runs after the settle commit, every runner swallows its own errors into `projection_status='failed'`, and the minutely sweep is the retry mechanism.
