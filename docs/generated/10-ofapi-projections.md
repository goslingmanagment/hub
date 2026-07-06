> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# OFAPI Webhook/Sync Projections

This map covers the read-model projections built from the OFAPI
(`onlyfansapi.com`) webhook and sync stream: the DM projection and its daily
analytics and cold archive, the presence and subscription projections, and the
sync snapshot read model that serves desktop resume. It also covers the two
platform-scrape helpers that sit alongside them — direct public-profile
resolution via Playwright/Chromium and the OnlyFans page-metadata backfill. All
paths are repo-relative; `runtime` abbreviates `apps/runtime/src`. These
projections run post-settle out of `runPostSettleOfapiProjections`
(`ofapi-events.ts:96-111`) plus a minutely sweep, and are all best-effort — they
never throw back into the webhook settle.

## Projection gating flags

| Projection | Config flag | Default | Target tables |
|---|---|---|---|
| DM projection | `ofapiDmProjectionEnabled` | off | `page_dm_threads`, `page_dm_messages`, `page_fans`, `fan_pages` |
| DM cold archive | `ofapiDmColdArchiveEnabled` | off | `dm_message_archive` |
| Presence projection | `ofapiPresenceProjectionEnabled` | off | `page_fans.external_presence_*` |
| Subscription projection | `isOfapiAudienceSyncEnabled` | off | `page_subscriptions`, `page_fans` |
| DM analytics | (runs on schedule) | — | `dm_message_daily` |

Each projectable webhook is stamped `projectionStatus="pending"` at journal
time when it is DM/subscription/presence-projectable
(`ofapi-webhooks.ts:176-180`); bookkeeping per producer is tracked via
`markOfapiWebhookEventProjection` and the archive-specific
`markOfapiWebhookEventArchivePending`.

## 1. DM projection (`ofapi-dm-projection.ts`, D1/D2)

Gated on `ofapiDmProjectionEnabled`. Projects
`messages.received/.sent/.deleted/.ppv.unlocked/tips.received`
(`OFAPI_DM_PROJECTION_EVENT_TYPES` `ofapi-dm-projection.ts:42-48`) into
**`page_dm_threads` / `page_dm_messages`** (plus `page_fans`, `fan_pages`)
through shared repo helpers.

- Conversations are keyed on the fan's OnlyFans user id; message upserts are
  keyed `(conversation_id, platform_message_id)`.
- Thread heads advance **forward-only** (`headAdvances`
  `ofapi-dm-projection.ts:184`, `headForwardOnly:true`
  `ofapi-dm-projection.ts:303`), and rows are locked `forUpdate` as a
  lost-update defense (B11 `ofapi-dm-projection.ts:209`).
- Event-specific effects: ppv → `markPageDmMessagePurchased`, tip →
  `raisePageDmMessageTipAmount`, deleted →
  `deletePageDmMessageByPlatformMessageId` followed by a head rebuild.
- Partner `lastSeen` is folded into presence when
  `ofapiPresenceProjectionEnabled` is set (`ofapi-dm-projection.ts:241-248`).
- Runs post-settle plus a minutely sweep with `MAX_ATTEMPTS = 5` and a limit of
  200 (`ofapi-dm-projection.ts:50-51`).

## 2. DM daily analytics (`ofapi-dm-analytics.ts`)

Rebuilds the **`dm_message_daily` aggregates** via
`rebuildDmMessageDailyAggregates` over a rolling
`OFAPI_DM_ANALYTICS_ROLLING_DAYS = 32` window (`ofapi-dm-analytics.ts:8`). The
queue `ofapi.dm-analytics.rebuild` (exclusive) is scheduled hourly at
`10 * * * *` UTC (`ofapi-dm-analytics.ts:49`).

## 3. DM cold archive (`ofapi-dm-archive.ts`)

Gated on `ofapiDmColdArchiveEnabled`. Archives `messages.received/.sent/.deleted`
into **`dm_message_archive`** (`upsertDmMessageArchive` /
`tombstoneDmMessageArchive`), storing media metadata and dimensions with
`rawShapeVersion = "ofapi-message-v1"` and a retention of `36500` days
(`ofapi-dm-archive.ts:22`). Rows are claimed via
`markOfapiWebhookEventArchivePending` with `MAX_ATTEMPTS = 5` and a sweep limit
of 200; cleanup runs inside the events cleanup job (`ofapi-events.ts:496`). A
status endpoint is exposed by `getOfapiDmColdArchiveStatus`
(`ofapi-dm-archive.ts:359`).

## 4. Presence projection (`ofapi-presence-projection.ts`, Phase 4/D9)

Gated on `ofapiPresenceProjectionEnabled`. Projects `users.online/.offline` into
**`page_fans.external_presence_*`** (`upsertFanPageExternalPresences`, source
`OFAPI_EXTERNAL_PRESENCE_SOURCE_LAST_SEEN`). It projects **known fans only** —
unknown ids are skipped and never REST-looked-up
(`ofapi-presence-projection.ts:127-132`) — and advances forward-only. Runs
post-settle plus a sweep, `MAX_ATTEMPTS = 5`, limit 200.

## 5. Subscription projection (`ofapi-subscription-projection.ts`, Phase 3/D8)

Gated on `isOfapiAudienceSyncEnabled`. Projects `subscriptions.new/.renewed`
into **`page_subscriptions` / `page_fans`** (plus presence from
`user.lastSeen`). The subscriber is taken from `payload.user` — the top-level
`user_id` is distrusted (it is the creator). The webhook carries no dates, so
the audience sweep owns renew/expiry; `sourceUpdatedAt` advances forward-only,
and rows are locked `forUpdate` (P-26 `ofapi-subscription-projection.ts:176`).
Runs post-settle plus a sweep, `MAX_ATTEMPTS = 5`, limit 200.

## 6. Sync snapshot read model (`ofapi-sync-snapshot.ts`)

`getOfapiSyncSnapshot` (`ofapi-sync-snapshot.ts:68`) serves
`GET /api/v1/events/snapshot` (`modules/events/index.ts:282`), providing durable
resume state for the desktop client. It assembles from `page_dm_threads`
(heads), hot messages, an archive delta, unresolved tombstones, and
`ofapi_auth_status`. `resumeAllowed` requires BOTH the DM projection and the
cold archive to be enabled (`ofapi-sync-snapshot.ts:213-215`); presence and
typing are omitted as ephemeral. Cursors are bounded by
`getOfapiFanoutReplayWindow`.

## 7. Public-profile resolution (`onlyfans-public-profiles.ts`)

`PlaywrightOnlyFansPublicProfileResolver` (`onlyfans-public-profiles.ts:125`) is
a Playwright/Chromium headless resolver that maps an OnlyFans **fan platform
user id → {username, displayName}** by navigating `https://onlyfans.com/u<id>`
and capturing the `/api2/v2/users/u<id>` XHR
(`onlyfans-public-profiles.ts:188-212`). It does NOT go through the OFAPI
gateway — it is a direct browser scrape through the page proxy
(`buildPlaywrightProxy`). It blocks image/media/font requests, pins the UA, and
runs with empty storageState (unauthenticated). Statuses are
`resolved|not_found|unavailable|failed|rate_limited`, mapped from HTTP
404/429/401/403 (`onlyfans-public-profiles.ts:56-67`), with a spacing delay
between resolves. It is used to name fans the kernel knows only by numeric id.

## 8. OnlyFans page-metadata backfill (`onlyfans-page-metadata-backfill.ts`)

`backfillOnlyFansPageMetadata` (`onlyfans-page-metadata-backfill.ts:102`)
refreshes stored OnlyFans **page identity** (username, display name, avatar)
from OFAPI `listAccounts()` (`updateOnlyFansPageIdentityFromOfapi`). Since Stage
18 the OnlyMonster credentials path is retired, so this is OFAPI-only and
requires a `page.ofapiAccountId` mapping (`onlyfans-page-metadata-backfill.ts:149`).
Display-name resolution and avatar-URL hygiene (stripping signed-URL query keys,
restricting to onlyfans.com hosts) live in `onlyfans.ts`
(`normalizeOnlyFansAvatarUrl` `onlyfans.ts:17`, `resolveOnlyFansDisplayName`
`onlyfans.ts:68`).
