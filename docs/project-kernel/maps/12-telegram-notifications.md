> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Territory 12 — Telegram Reports & Notification Incidents

**Scope note.** This document covers the Telegram outbound-notification subsystem of `core`: the Telegram Bot API client and credential resolution (`apps/runtime/src/services/telegram.ts`), the daily revenue report builder and its two renderers (`apps/runtime/src/services/telegram-report.ts`, `apps/runtime/src/services/telegram-report-image.ts`), the notification-incident detection/notification orchestration (`apps/runtime/src/services/notification-incidents.ts`), and the two DB repositories backing them (`packages/db/src/repositories/notifications.ts`, `packages/db/src/repositories/telegram-settings.ts`). It also traces the boundaries these expose: the pg-boss `telegram.daily-report` schedule and its worker handler (`apps/runtime/src/worker-services.ts`, `apps/runtime/src/services/sync-queue.ts`), the `/api/v1/admin/notifications/*` HTTP routes (`apps/runtime/src/api/server.ts`), the CLI `telegram` commands (`apps/runtime/src/cli.ts`), the incident **detection** call-sites in the sync executor and OFAPI health/credit monitors (`apps/runtime/src/services/sync/executor.ts`, `apps/runtime/src/services/ofapi-account-health.ts`, `apps/runtime/src/services/ofapi-credits.ts`, `apps/runtime/src/services/connections.ts`), the DB schema (`packages/db/src/schema.ts`), migrations `0018` and `0050`, config keys (`packages/shared/src/config-registry.ts`), and the dashboard Notifications page (`apps/dashboard/src/pages/NotificationsPage.tsx`, `apps/dashboard/src/api/adminNotifications.ts`). Report input data (`listVisiblePages`, `getRevenuePageTotalsForExactPeriod`) belongs to territory 09; notification routes to territory 02; DB tables to territory 04.

---

## 1. Overview

This subsystem is the single **outbound Telegram boundary** of `core`. It sends two categories of message to a Telegram chat via the Telegram Bot HTTP API:

1. **Daily revenue reports** — a once-per-report-date financial summary, delivered as a rendered PNG image (with a plain-text fallback), scheduled by pg-boss and also triggerable manually.
2. **Notification incidents** — operational alerts (sync auth failures, proxy failures, repeated stream failures, OFAPI account-auth problems, low OFAPI credit, OFAPI webhook silence, OFAPI credit burn rate), opened/resolved with deduplication and recovery watermarking, each transition pushed to Telegram.

Every real send attempt (and every skip) is journaled in `telegram_delivery_attempts`. There is no inbound Telegram traffic here — the bot's `getUpdates` is polled only during interactive chat-discovery, never as a webhook listener. (OFAPI webhooks are a separate territory.)

Money everywhere in the report is in **mills** (1 mill = $0.001).

---

## 2. Telegram Bot boundary (`services/telegram.ts`)

### 2.1 Bot API endpoint and methods

All calls target `https://api.telegram.org/bot<botToken>/<method>` (`telegram.ts:47`, `buildTelegramApiUrl`). The counterpart is **Telegram's Bot API servers**. Methods actually called:

| Method | Function | Payload sent | Response consumed |
|---|---|---|---|
| `getMe` | `discoverTelegramChats` (`telegram.ts:183`) | none (GET) | `result.username` → bot username; validates token |
| `getUpdates` | `discoverTelegramChats` (`telegram.ts:199`) | none (GET, no offset — peeks, does not consume) | `result[]` updates; extracts distinct `chat.{id,type,title}` |
| `sendMessage` | `sendTelegramMessage` (`telegram.ts:373`) | JSON `{chat_id, text, parse_mode?, disable_web_page_preview:true}` | `ok`, `result.message_id`, `description` |
| `sendPhoto` | `sendTelegramPhoto` (`telegram.ts:500`) | `multipart/form-data`: `chat_id`, `caption?`, `parse_mode?`, `photo` (PNG blob named `report.png`) | `ok`, `result.message_id`, `description` |

`parse_mode` is always `"HTML"` in practice (the report/caption and incident text use HTML; `MarkdownV2` is in the type union but unused). `disable_web_page_preview:true` is always set on `sendMessage`.

Timeouts: `sendMessage`/`getMe`/`getUpdates` = 10 s (`TELEGRAM_SEND_TIMEOUT_MS`/`TELEGRAM_DISCOVER_TIMEOUT_MS`, `telegram.ts:36,38`), `sendPhoto` = 30 s (`TELEGRAM_PHOTO_TIMEOUT_MS`, `telegram.ts:453`), enforced via `AbortSignal.timeout`.

### 2.2 Optional egress proxy

If `config.telegramProxyPageLabel` is set, `resolveTelegramRequestOptions` (`telegram.ts:137`) loads the named page via `findPageByLabel`, resolves its stored proxy through `resolveStoredProxyConfig`, and builds an undici `Dispatcher` (`createProxyRequestDispatcher`) that is attached to every fetch for the send (`withTelegramRequestOptions`). A missing page, a page with no proxy, or invalid proxy config throws `TelegramProxyConfigError`; in `sendTelegramMessage`/`sendTelegramPhoto` that is caught and turned into a `{status:"failed"}` result (the send never crashes the caller). The dispatcher is closed in a `finally` (`closeTelegramRequestOptions`). So Telegram traffic can be routed through the same residential/proxy egress used for platform pages.

### 2.3 Credentials — source and precedence

`TelegramSettingsRow` (from `telegram_settings`, singleton `id=1`) holds `encryptedBotToken` and `chatId`. Env fallbacks are `config.telegramBotToken` (`TELEGRAM_BOT_TOKEN`) and `config.telegramChatId` (`TELEGRAM_CHAT_ID`).

**Per-field precedence (DB wins over env, independently for token and chat id):**

- Bot token (`resolveBotTokenWithSource`, `telegram.ts:238`): if `settings.encryptedBotToken` is set, it is decrypted via `decryptJsonWithKeyVersion<string>(encryptedBotToken, config.encryptionKeysByVersion)` and returned with source `"db"`. **If decryption throws, it silently falls back to the env token** (source `"env"`); if neither exists, `{token:null, source:"none"}`.
- Chat id (`resolveTelegramCredentials`, `telegram.ts:281`): `settings.chatId ?? config.telegramChatId ?? null`; source `"db"` if the DB column is set, else `"env"`, else `"none"` (`resolveTelegramCredentialSources`, `telegram.ts:295`).

`resolveTelegramCredentials` returns `{botToken, chatId}` only when **both** are present, else `null` → sends resolve to `{status:"skipped", reason:"unconfigured"}`.

The stored token is written encrypted by the PATCH route (§6): `JSON.stringify(encryptJson(botToken, config.encryptionKey, config.encryptionKeyVersion))`. So the **secret bot token crosses into the DB encrypted-at-rest** and is only decrypted in-process at send time. Redaction: `redactSensitiveText` scrubs error strings before they are logged or surfaced (`describeTelegramFailure`, `friendlyTelegramError`).

### 2.4 Send result shape, retries, error mapping

`TelegramSendResult` (`telegram.ts:16`) is a discriminated union: `{status:"skipped", reason:"unconfigured"|"disabled"}`, `{status:"sent", chatId, messageId:number|null}`, or `{status:"failed", error:string}`.

Retry loop (`sendTelegramMessage` `telegram.ts:371`, `sendTelegramPhoto` `telegram.ts:492`): up to `TELEGRAM_SEND_MAX_RETRIES + 1` = **3 attempts**. A response retries when `shouldRetryTelegramResponse` (HTTP 429 or ≥500); a thrown error retries when `classifyTransportError` is `"timeout"` or `"transport"`. Backoff is `resolveRetryDelayMs(retryAfterHeader, attemptNumber)` (honours Telegram's `Retry-After` header on 429). Exhausting retries returns `{status:"failed"}`. Failures are logged at `warn` level with `"…failed; continuing"` — a Telegram failure never throws to the caller (except the worker handler, which re-throws on `failed` to force a pg-boss retry — see §4).

`friendlyTelegramError` (`telegram.ts:65`) maps raw Bot-API descriptions to operator-facing English (invalid token, chat not found, bot blocked, bot can't initiate, missing admin rights, invalid chat id) and otherwise returns the redacted raw description.

### 2.5 Chat discovery (interactive, read-only)

`discoverTelegramChats(botToken, options)` validates the token via `getMe`, then reads pending updates via `getUpdates` (no offset, so updates are not consumed) and dedupes chats seen across `message`/`edited_message`/`channel_post`/`my_chat_member`/`chat_member` update types into `{id,type,title}[]` (`telegram.ts:212-227`). Used by the discover-chats route so the operator can pick a chat id from a menu after messaging the bot.

### 2.6 Connection status derivation

`deriveTelegramConnectionState(configured, credentialsUpdatedAt, lastRealAttempt)` (`telegram.ts:313`) computes the UI status: `not_configured` when creds absent; otherwise it only trusts the latest **real** attempt (`sent`/`failed`, never `skipped`) whose `createdAt >= credentialsUpdatedAt`. That yields `connected` (last real attempt `sent`), `last_message_failed` (last real attempt `failed`), or `untested` (no qualifying attempt). A stale success made with previously-configured credentials therefore does **not** read as connected — this is the reason `credentials_updated_at` exists (migration `0050`, §5.4).

### 2.7 Test message

`sendTelegramTestMessage(app, now)` (`telegram.ts:550`) sends a two-line plain message `"✅ Agency Hub Core Telegram test\nUTC: <iso>"`. It does **not** itself write a delivery attempt — the API route and CLI wrap it (§6, §7).

---

## 3. Daily revenue report (`services/telegram-report.ts`, `services/telegram-report-image.ts`)

### 3.1 What the report summarizes

`buildDailyRevenueTelegramReport(app, now)` (`telegram-report.ts:349`) produces a `DailyRevenueTelegramReport`. Financial content:

- **Three trailing windows** per entity, keyed `yesterday`/`days7`/`days30`, each a `RevenueMetric {currentMills, previousMills, deltaPct}`:
  - `yesterday.current` = the closed business day `[previousBusinessDayStart, currentBusinessDayStart)`; `yesterday.previous` = the day before that.
  - `days7.current` = trailing 7 business days ending at the current business-day start; `previous` = the 7 days before that.
  - `days30.current` = trailing 30; `previous` = the 30 before that (`telegram-report.ts:362-378`).
- **Business-day boundary** = **02:00 Moscow time** (`REPORT_BUSINESS_TIME_ZONE = MOSCOW_TIME_ZONE`, `REPORT_BUSINESS_DAY_START_HOUR = 2`, `telegram-report.ts:22-23`; `startOfReportBusinessDay`, `telegram-report.ts:149`), aligning the daily close with chatter-shift accounting. This is why the report intentionally reads **exact transactions** for exact bounds, not the UTC-day `revenue_daily` rollup, so boundary-hour sales land on the correct report date.
- **Entities**: `agency` (sum over all visible pages), top **10 models** (`TOP_MODEL_LIMIT`) ranked by yesterday revenue with a `modelOverflow` aggregate for the rest, and top **10 pages** (`TOP_PAGE_LIMIT`) ranked by yesterday revenue with an `overflow` aggregate for the rest (`telegram-report.ts:410-444`).

`reportDate` = `toBusinessDate(previousBusinessDayStart, MSK)` (a `YYYY-MM-DD` string), `generatedAt` = `now.toISOString()`.

### 3.2 DB reads (inbound to this territory)

- `listVisiblePages(app.db)` — returns visible pages with `{id, label, platform, modelSlug, modelName, …}` (`reporting.ts:72`). Drives the page/model universe and labels.
- `getRevenuePageTotalsForExactPeriod(app.db, {pageIds, period:{from,to}})` — per exact period, returns `{pageId, netEarningsMills}` = `sum(transactions.creatorNetAmountMills)` grouped by page, excluding excluded transaction types (`reporting.ts:264`). Called 6× (current+previous × 3 windows) via `loadPageTotalsForBounds` → `toMills` (`telegram-report.ts:125-147`). This is the sole revenue data source of the report. (Both reads are territory 09.)

### 3.3 Formatting rules

- `formatDeltaCompact` (`telegram-report.ts:84`): `new` when prior=0 and current>0, `—` when both 0, `Nx` multiplier when ratio ≥ 10 (`DELTA_MULTIPLIER_THRESHOLD`), else `+N%`/`-N%`/`0%` (rounded).
- `modelDot`/`metricDirection`: `🟢`/`up` for >0, `🔴`/`down` for <0, `⚪`/`flat` when |delta|<0.05 or null.
- `formatShare` — a page/model's share of agency yesterday total (`<1%` when rounds to 0 but positive).
- `formatUsdCompact` — whole-dollar figure for 7d/30d; `formatUsdFromMills` (shared) — dollars-and-cents for yesterday figures.
- Page ordering within a model is **fixed** (not by revenue) via `pageOrderKey`/`comparePagesForDisplay`/`REPORT_PAGE_TIER_ORDER = ["vip","free","main"]` (`telegram-report.ts:208-241`): numbered pages first (numeric), then tier-token pages, then alphabetical — so a page keeps its row position day-to-day. `formatPageLabel` strips a trailing `-of` platform suffix and renders a bare OnlyFans page as `-free` (`telegram-report.ts:248`).

### 3.4 Two render forms

- **Plain-text HTML message** (`renderDailyRevenueTelegramReport`, `telegram-report.ts:285`): proportional HTML (bold names + colour-dot emoji, one line per entity), `parse_mode:"HTML"`. Deliberately avoids `<pre>` (Telegram renders code-block chrome). Header line, agency hero line with 7d/30d, then per-model blocks with indented pages, overflow lines, and a footer `Windows: 02:00-02:00 MSK · excl. current day`. HTML-escaped via local `escapeHtml`.
- **Rendered PNG image** (`telegram-report-image.ts`): `buildDailyRevenueReportHtml` builds a standalone HTML document (a 520px white card with a real `<table>`, tabular-nums, coloured delta cells/dots) — the aligned-column layout Telegram text cannot achieve. `renderDailyRevenueReportImage` (`telegram-report-image.ts:150`) dynamically `import("playwright")`, launches **headless chromium** (`--disable-background-networking/-default-apps/-extensions/-sync`), sets a 560×800 viewport at `deviceScaleFactor:2`, `setContent(html)`, and screenshots the `#card` locator to a PNG `Buffer`. Launch-per-render; browser always closed in `finally`. Chromium is noted as already provisioned in the image for the public-profile resolver.

### 3.5 Delivery orchestration

`deliverDailyRevenueReport` (`telegram-report.ts:475`): render image → `sendTelegramPhoto` with caption from `buildDailyRevenueReportCaption` (`📊 Revenue · <date> — <amount> <delta>`, HTML). **Fallback**: if image render throws (e.g. chromium unavailable) **or** the photo send returns `{status:"failed"}`, it falls back to `sendTelegramMessage` with the plain-text `report.text` — so a report always goes out in one form or the other. A `skipped` photo result (unconfigured) is returned as-is (no fallback).

Two entry points both build+deliver and then journal a `telegram_delivery_attempts` row:

| Function | `kind` written | Extra gating |
|---|---|---|
| `sendDailyRevenueTelegramReport` (`telegram-report.ts:497`) | `daily_report_scheduled` | Reads settings; if `!enabled \|\| !dailyReportEnabled`, writes a `skipped`/`disabled` attempt and returns without building |
| `sendManualDailyRevenueTelegramReport` (`telegram-report.ts:543`) | `daily_report_manual` | **No enable check** — always builds and delivers (a manual send bypasses the daily-report toggle) |

Each attempt row records `status`, `reportDate`, `messageId` (on `sent`), and `error` = the failure string, or the skip `reason`, or null.

---

## 4. pg-boss schedule (`TELEGRAM_DAILY_REPORT`)

Queue name constant: `TELEGRAM_DAILY_REPORT_QUEUE = "telegram.daily-report"` (`sync-queue.ts:9`). Queue created `policy:"standard", retryLimit:2, retryDelay:60, retryBackoff:true` (`sync-queue.ts:95`).

**Schedule** (`ensureTelegramDailyReportSchedule`, `sync-queue.ts:114`): cron **`0 * * * *` in UTC** — i.e. **hourly on the hour**, not once a day. Despite the "daily report" naming, the queue fires every hour and the worker handler self-gates on the operator's report hour and dedupes on already-sent report dates. Registered in `startWorkerServices` (`worker-services.ts:142`).

**Worker handler** (`worker-services.ts:185`, `batchSize:1`):
1. Read `telegram_settings`; if `!enabled || !dailyReportEnabled`, return (no-op).
2. `dueReportDate = resolveDueTelegramReportDate(now, settings.reportHourUtc)` (`worker-services.ts:61`): today's UTC business-day start, minus 1 day if `now.getUTCHours() >= reportHourUtc` else minus 2 days → a UTC `YYYY-MM-DD`. So a report date becomes "due" only after the configured hour has passed that UTC day.
3. `latestSentReportDate = getLatestScheduledReportDateOnOrBefore(db, dueReportDate)` — max `report_date` among `daily_report_scheduled` rows with `status='sent'` and `report_date <= dueReportDate` (`telegram-settings.ts:153`). This is the **dedup watermark**.
4. `listPendingTelegramReportDates(latestSent, due)` (`worker-services.ts:78`) walks from `latestSent + 1 day` up to `dueReportDate` inclusive (or just `[dueReportDate]` if no watermark) — **catches up any missed days**. For each date it calls `sendDailyRevenueTelegramReport(app, buildTelegramReportRunTime(reportDate))` where `buildTelegramReportRunTime = <date>T00:00Z + 1 day`.
5. If any delivery returns `{status:"failed"}`, the handler **throws** — surfacing to pg-boss so the job retries (up to `retryLimit:2`).

**Discrepancy to flag:** the due/pending date arithmetic in the worker is computed in **UTC** business days (`resolveDueTelegramReportDate`, `UTC_TIME_ZONE`), but the `report_date` actually persisted (and compared by the dedup watermark) is computed inside `buildDailyRevenueTelegramReport` in **Moscow** business days with a 02:00 offset. The two coordinate systems can produce different `YYYY-MM-DD` strings for the same run; the dedup relies on the persisted MSK-derived string. This is the actual behavior — the scheduling gate and the stored report date are computed independently.

---

## 5. DB schema & repositories

### 5.1 `telegram_settings` (singleton, `packages/db/src/repositories/telegram-settings.ts`)

Schema (`schema.ts:270`): `id integer PK default 1`, `enabled bool default true`, `daily_report_enabled bool default true`, `sync_failure_alerts_enabled bool default true`, `report_hour_utc integer default 9`, `encrypted_bot_token text` (JSON envelope), `chat_id text`, `updated_at`, `credentials_updated_at` (default now, NOT NULL — added by migration `0050`).

- `getTelegramSettings(db, {defaultReportHourUtc})` (`telegram-settings.ts:17`) — lazily inserts the singleton row (`id:1`, `reportHourUtc` = provided default or 9) `onConflictDoNothing`, then returns it. Called throughout with `defaultReportHourUtc = config.telegramReportHourUtc`.
- `updateTelegramSettings(db, patch)` (`telegram-settings.ts:38`) — updates `id=1`. **Bumps `credentials_updated_at = now` only when `encryptedBotToken` or `chatId` appear in the patch** (`credentialsChanged`); flag/report-hour edits leave the credential watermark untouched, so the connection status is not reset by a toggle.

### 5.2 `telegram_delivery_attempts` (`telegram-settings.ts`)

Schema (`schema.ts:284`): `id bigserial PK`, `kind text`, `status text`, `notification_incident_id bigint → notification_incidents(id) ON DELETE SET NULL`, `report_date text`, `message_id integer`, `error text`, `created_at`. Index `(kind, created_at)`.

Kinds (`TelegramDeliveryKind`, `telegram-settings.ts:8`): `test`, `daily_report_scheduled`, `daily_report_manual`, `incident_opened`, `incident_resolved`, `incident_manually_resolved`. Statuses: `sent`/`failed`/`skipped`.

Repository functions: `insertDeliveryAttempt` (writes one row); `listDeliveryAttempts({kind?, limit=50})`; `getLatestDeliveryAttempt`; `getLatestRealDeliveryAttempt` (latest with status ∈ {sent,failed}, ignoring skips — powers the connection status); `hasScheduledReportForDate` (a `daily_report_scheduled` + `sent` row for a given date); `getLatestScheduledReportDateOnOrBefore` (the dedup watermark, §4).

### 5.3 `notification_incidents` + `notification_incident_recoveries` (`packages/db/src/repositories/notifications.ts`)

`notification_incidents` (`schema.ts:232`): `id bigserial PK`, `incident_key text UNIQUE`, `kind` (enum below), `platform_account_id bigint → pages(id) ON DELETE CASCADE` (**nullable** — null for account-global OFAPI incidents), `stream` (sync_stream enum, nullable), `status` (`open`/`resolved`, default `open`), `opened_at`, `last_seen_at`, `resolved_at`, `error_code text`, `error_summary text`, `metadata jsonb`, `updated_at`. Indexes `(platform_account_id, status)` and `(status, last_seen_at)`.

Incident **kinds** (`notificationIncidentKindEnum`, `schema.ts:127` / `NotificationIncidentKind`, `notifications.ts:11`): `auth_blocked`, `proxy_failed`, `stream_failed_threshold`, `ofapi_auth`, `ofapi_low_credit`, `ofapi_webhook_silence`, `ofapi_burn_rate`. **Statuses**: `open`, `resolved`.

`notification_incident_recoveries` (`schema.ts:263`, migration `0018`): `incident_key text PK`, `recovered_at timestamptz`, `metadata jsonb`, `updated_at`. This is the **recovery watermark** table (§5.4).

Repository functions:

- `openNotificationIncidentInternal` (`notifications.ts:204`) — the core open/reopen/refresh path. Serializes per `incident_key` with `pg_advisory_xact_lock(hashtextextended(incidentKey, 837451029))` inside a transaction, and takes `SELECT … FOR UPDATE` on the row. Transitions: **`opened`** (no row), **`reopened`** (row `resolved` and event newer than `resolved_at`), **`existing`** (row already open, or resolved-in-future guard, refreshing `last_seen_at`/error/metadata). Retries up to `MAX_OPEN_INCIDENT_ATTEMPTS=3` on unique-violation (`23505`) races.
- `openNotificationIncidentWithRecoveryGuard` (`notifications.ts:374`) — same, plus a **recovery guard**: given `occurredAt`, if a recovery row exists with `recovered_at >= occurredAt` it returns `{incident:null, transition:"suppressed"}` — a stale failure that predates the last recovery does not reopen the incident. This is the variant the notification service uses.
- `recordNotificationIncidentRecovery` (`notifications.ts:396`) — upserts the recovery watermark, keeping `greatest(existing, new)` `recovered_at` (advisory-locked).
- `resolveNotificationIncident` (`notifications.ts:426`) — flips a still-`open` incident (optionally gated by `last_seen_at <= maxLastSeenAt`) to `resolved`, setting `resolved_at`/`last_seen_at`/metadata. Returns the row or null.
- Read paths: `getNotificationIncidentByKey`, `listNotificationIncidents`, and `listNotificationIncidentsWithPages({status?, kind?, pageLabel?, limit=50, offset=0})` — the last **inner-joins `pages`** (so it only returns page-scoped incidents; account-global OFAPI incidents with null `platform_account_id` are excluded from this listing) and computes `notificationCount` = count of `telegram_delivery_attempts` rows linked to the incident (`notifications.ts:143`).

### 5.4 Recovery watermarks (migration `0018`) & credential watermark (`0050`)

- **`0018_notification_incident_recovery_watermarks.sql`** creates `notification_incident_recoveries` (`incident_key` PK, `recovered_at`). Purpose: an out-of-order/stale failure event (`occurredAt` earlier than a recorded recovery) is **suppressed** rather than reopening a just-resolved incident (`openNotificationIncidentWithRecoveryGuard`, §5.3).
- **`0050_telegram_credentials_updated_at.sql`** adds `telegram_settings.credentials_updated_at`, backfilled from `updated_at`, then `DEFAULT now() NOT NULL`. Purpose (§2.6): the connection status must only count a successful delivery made with the **current** credentials as "connected"; rotating the token/chat resets this watermark so a stale success no longer reads as connected.

---

## 6. Incident detection & notification orchestration (`services/notification-incidents.ts`)

This module is the bridge between detectors (sync executor, OFAPI monitors) and both the incident tables and Telegram. It builds a stable **`incidentKey`** (`incidentKey`, `notification-incidents.ts:19`):
- account-global OFAPI incidents (`platformAccountId === null`): `"<kind>:global"`.
- `stream_failed_threshold` with a stream: `"<kind>:<accountId>:<stream>"`.
- otherwise: `"<kind>:<accountId>"`.

**Open path** `openIncidentAndNotify` (`notification-incidents.ts:122`): calls `openNotificationIncidentWithRecoveryGuard`; if transition is `existing`/`suppressed` or no incident, it returns silently (no Telegram). On a genuine `opened`/`reopened`, it reads `telegram_settings`; **only if `enabled && syncFailureAlertsEnabled`** does it `sendTelegramMessage` with `openMessageForIncident` text, then journals an `incident_opened` delivery attempt linked to the incident id. All wrapped in try/catch that logs-and-continues.

**Resolve path** `resolveIncidentAndNotify` (`notification-incidents.ts:184`): `recordNotificationIncidentRecovery` (watermark), then `resolveNotificationIncident` (gated `maxLastSeenAt = recoveredAt`); only if a row was actually resolved and `enabled && syncFailureAlertsEnabled` does it send `resolveMessageForIncident` and journal an `incident_resolved` attempt.

**Message text** (plain, no HTML parse_mode here):
- Open (`openMessageForIncident`, `openTitleForIncident`): a `🚨 <title>` line per kind, then optional `Page: <label> (<platform>)`, optional `Stream: <stream>`, then `Error: <summarized>`. `summarizeError` redacts via `redactSensitiveText` and truncates to 240 chars.
- Resolve (`resolveMessageForIncident`): `✅ Resolved` + a per-kind detail line, with page label/platform when present.

**Detector-facing exported functions and their call-sites:**

| Function | Kind | Called from | Trigger condition |
|---|---|---|---|
| `notifyAuthFailedIncident` | `auth_blocked` | `sync/executor.ts:537` | A sync chunk is classified as auth-blocked (403/blocked) |
| `notifySyncChunkFailureIncident` | `proxy_failed` **or** `stream_failed_threshold` | `sync/executor.ts:618` | On a failed chunk: if page `hasProxy` and `hasRecentTerminalProxyFailure(runId)` → `proxy_failed`; else opens `stream_failed_threshold` **only when** `previousConsecutiveFailures + 1 === STREAM_FAILURE_THRESHOLD (3)` (fires exactly on the 3rd consecutive failure) |
| `resolveSyncChunkRecoveryIncidents` | resolves `auth_blocked` + `proxy_failed` + `stream_failed_threshold` | `sync/executor.ts:427,463` | A chunk finishes `success` or `partial` (recovery) |
| `handleSuccessfulPageVerificationRecovery` | `clearPageSyncAuthBlock` then resolves `auth_blocked` + `proxy_failed` | `connections.ts:340`, `cli.ts:797,810` | A page's credentials verify successfully |
| `notifyOfapiAuthIncident` / `resolveOfapiAuthIncident` | `ofapi_auth` | `ofapi-account-health.ts:100,108` | OFAPI `accounts.*` auth event in `OFAPI_AUTH_ALERT_STATUSES` (open) / `…RECOVERED_STATUSES` (resolve); `errorCode` = the auth status |
| `notifyOfapiGlobalIncident` / `resolveOfapiGlobalIncident` | `ofapi_low_credit` | `ofapi-account-health.ts:143,150,159` | Minutely health monitor: last observed credit balance `< ofapiCreditAlertThreshold` (default 1000); threshold ≤ 0 resolves the incident |
| `notifyOfapiGlobalIncident` / `resolveOfapiGlobalIncident` | `ofapi_webhook_silence` | `ofapi-account-health.ts:176,184` | Monitor: mapped pages exist and no webhook event received for `ofapiWebhookSilenceThresholdMinutes` (default 720) |
| `notifyOfapiGlobalIncident` / `resolveOfapiGlobalIncident` | `ofapi_burn_rate` | `ofapi-credits.ts:354,366,373` | Minutely burn monitor: trailing-hour spend `> ofapiBurnAlertCreditsPerHour` (default 300); threshold ≤ 0 resolves |

`hasTerminalProxyFailure` wraps `hasRecentTerminalProxyFailure(db, {runId, limit:2000})` (`sync.ts:1075`, territory cross-ref). The three OFAPI thresholds are read live from effective config each cycle (`loadEffectiveConfig`).

---

## 7. HTTP routes (dashboard boundary, `apps/runtime/src/api/server.ts`)

All routes are `requireOwner`-gated and registered against Zod contracts in `packages/contracts/src/routes.ts`. Prefix `/api/v1/admin/notifications`. The dashboard consumes them via `apps/dashboard/src/api/adminNotifications.ts`.

| Route | Handler (server.ts) | Inbound body/query | Outbound response |
|---|---|---|---|
| `GET /notifications/settings` | `:3131` | — | `buildNotificationsSettingsResponse`: `{configured, botTokenSet, chatId, botTokenSource, chatIdSource, enabled, dailyReportEnabled, syncFailureAlertsEnabled, reportHourUtc, connectionStatus, lastMessageAt, lastMessageError}` |
| `PATCH /notifications/settings` | `:3356` | `{enabled?, dailyReportEnabled?, syncFailureAlertsEnabled?, reportHourUtc?(0-23), botToken?(regex-validated, nullable), chatId?(regex, nullable)}` | same settings response. `botToken` is `encryptJson`-encrypted before persisting; `null` clears it |
| `POST /notifications/test` | `:3385` | — | `sendTelegramTestMessage`, then writes a `test` delivery attempt; returns `{status, error}` |
| `POST /notifications/discover-chats` | `:3410` | `{botToken?}` (typed-but-unsaved token, else stored/env) | `discoverTelegramChats` → `{botUsername, chats:[{id,type,title}]}`; discovery/proxy errors become `400` |
| `GET /notifications/incidents` | `:3443` | `{status?, kind?, pageLabel?, limit(1-200)=50, offset=0}` | `listNotificationIncidentsWithPages` → `{items:[…, notificationCount], total}` (page-joined only) |
| `POST /notifications/incidents/:incidentId/resolve` | `:3469` | path `incidentId` | Manual resolve: looks up `incident_key`, records recovery watermark, resolves; on success **best-effort** sends `✅ Manually resolved\nIncident: <key>` and writes an `incident_manually_resolved` attempt; returns `{ok:true}` |
| `GET /notifications/reports/preview` | `:3519` | — | `buildDailyRevenueTelegramReport` (build-only, no send) → `{text, reportDate}` |
| `POST /notifications/reports/send` | `:3532` | — | `sendManualDailyRevenueTelegramReport` (bypasses daily toggle) → `{status, error, reportDate}` |
| `GET /notifications/reports/history` | `:3546` | — | `listDeliveryAttempts({kind:["daily_report_scheduled","daily_report_manual"], limit:50})` → `{items:[{id,kind,status,reportDate,error,createdAt}]}` |

`buildNotificationsSettingsResponse` (`server.ts:3097`) derives `configured` from `resolveTelegramCredentials`, sources from `resolveTelegramCredentialSources`, and connection status from `deriveTelegramConnectionState(configured, credentialsUpdatedAt, getLatestRealDeliveryAttempt)`. `botTokenSet` and `chatId` fold in the env fallbacks so the UI reflects the effective (DB-or-env) values. A separate `GET /api/v1/admin/incidents` (`server.ts:3033`) is an unrelated **log**-based incidents view (severity/code over admin logs), not the notification incidents table.

**Dashboard surface** (`apps/dashboard/src/pages/NotificationsPage.tsx`): three tabs — **Settings** (`NotificationsSettingsTab`: connection status, token/chat form, discover-chats, test, toggles), **Incidents** (`NotificationsIncidentsTab`, polling `useNotificationIncidents` every 30 s, manual resolve), **Reports** (`NotificationsReportsTab`: preview, manual send, history).

---

## 8. CLI boundary (`apps/runtime/src/cli.ts`)

`telegram test` (`cli.ts:1076`) → `sendTelegramTestMessage(app)`, prints skipped/failed/sent-to-`<chatId>`. `telegram report` (`cli.ts:1097`) → `sendManualDailyRevenueTelegramReport(app)`, prints skipped/failed/sent-for-`<reportDate>`. `handleSuccessfulPageVerificationRecovery` is also invoked from CLI credential-verification commands (`cli.ts:797,810`).

---

## 9. Config keys (`packages/shared/src/config-registry.ts`)

| Config field | Env var | Default | Registry editability | Use here |
|---|---|---|---|---|
| `telegramBotToken` | `TELEGRAM_BOT_TOKEN` | (unset) | NEVER (managed in Notifications) | Env fallback bot token |
| `telegramChatId` | `TELEGRAM_CHAT_ID` | (unset) | NEVER | Env fallback chat id |
| `telegramReportHourUtc` | `TELEGRAM_REPORT_HOUR` | 9 | NEVER (default only) | Default `report_hour_utc` when seeding the singleton |
| `telegramProxyPageLabel` | `TELEGRAM_PROXY_PAGE_LABEL` | (unset) | NEVER | Page whose stored proxy routes Telegram egress |
| `telegramEnabled` | `TELEGRAM_ENABLED` | derived | NEVER (derived) | `botToken && chatId` both set (bootstrap-derived; note operational enable is the DB `enabled` flag) |
| `ofapiCreditAlertThreshold` | `OFAPI_CREDIT_ALERT_THRESHOLD` | 1000 | EDITABLE (live) | `ofapi_low_credit` threshold |
| `ofapiWebhookSilenceThresholdMinutes` | `OFAPI_WEBHOOK_SILENCE_THRESHOLD_MINUTES` | 720 | EDITABLE (live) | `ofapi_webhook_silence` threshold |
| `ofapiBurnAlertCreditsPerHour` | `OFAPI_BURN_ALERT_CREDITS_PER_HOUR` | 300 | EDITABLE (live) | `ofapi_burn_rate` threshold |

Secrets crossing boundaries: the bot token (env or DB-encrypted) is the only secret in this territory; it is redacted from all logs/errors and encrypted at rest in `telegram_settings.encrypted_bot_token`. `config.encryptionKey`/`encryptionKeyVersion`/`encryptionKeysByVersion` are used for encrypt/decrypt.

---

## 10. Boundary summary

- **Outbound HTTP → Telegram Bot API** (`api.telegram.org`): `getMe`, `getUpdates` (discovery, read-only), `sendMessage` (JSON incident/manual/test text), `sendPhoto` (multipart PNG report + caption). Carries revenue figures (dollar amounts, deltas, per-model/per-page breakdown) and operational error summaries (redacted). Optional egress via a page-scoped proxy dispatcher.
- **DB writes**: `telegram_settings` (singleton flags/creds), `telegram_delivery_attempts` (every send/skip journaled), `notification_incidents` (open/reopen/resolve, advisory-locked), `notification_incident_recoveries` (recovery watermarks).
- **DB reads (cross-territory in)**: `listVisiblePages`, `getRevenuePageTotalsForExactPeriod` (report revenue, territory 09); `hasRecentTerminalProxyFailure`, `clearPageSyncAuthBlock`, OFAPI credit/webhook state, `findPageByLabel`/`findPageByOfapiAccountId`.
- **pg-boss**: consumes `telegram.daily-report` (hourly UTC cron; self-gated by report hour + report-date dedup; re-throws on delivery failure for retry).
- **Inbound HTTP (from dashboard, owner-only)**: the `/api/v1/admin/notifications/*` routes above — receive bot token / chat id / flags / report-hour and incident-resolve commands; return settings, incident lists, report preview/history.
- **CLI**: `telegram test`, `telegram report`.
- No AI-provider, no SSE/streaming, and no inbound Telegram webhook in this territory.
