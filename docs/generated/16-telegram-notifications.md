> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Telegram boundary + notifications

Telegram is the kernel's outbound-only alert and reporting boundary: a single
bot service sends messages/photos to the operator's chat, a daily revenue
report is rendered and delivered on a business-day schedule, and the incident
machinery routes every operational alert to that same bot. Inbound Telegram is
used only for one-time chat discovery, never as a webhook. This document maps
the sender service (`services/telegram.ts`), the daily revenue report
(`services/telegram-report.ts`), and the notification-incident machinery
(`services/notification-incidents.ts`).

## The bot service (`services/telegram.ts`, 561 lines)

All sending is a raw `fetch` to `api.telegram.org/bot<token>/<method>`, with the
URL assembled by `buildTelegramApiUrl` (`telegram.ts:46`).

Senders:

- `sendTelegramMessage` (`telegram.ts:332`) — `sendMessage`, HTML parse-mode,
  10 s timeout, 2 retries on 429/5xx.
- `sendTelegramPhoto` (`telegram.ts:455`) — `sendPhoto` multipart, 30 s
  timeout.
- `sendTelegramTestMessage` (`telegram.ts:550`) — connectivity test.

Chat discovery (inbound, not a webhook): `discoverTelegramChats`
(`telegram.ts:177`) calls `getMe` + `getUpdates` so the operator can pick a
Chat ID from the UI.

**Credentials — DB config OVER env, resolved per field:**

- `resolveBotTokenWithSource` (`telegram.ts:238`) prefers the encrypted DB
  token (decrypted via `decryptJsonWithKeyVersion`) and falls back to
  `config.telegramBotToken` only when the DB token is absent or undecryptable.
- `resolveTelegramCredentials` (`telegram.ts:276`) independently prefers
  `settings.chatId` over `config.telegramChatId` (`telegram.ts:281`).
- `resolveTelegramCredentialSources` (`telegram.ts:295`) reports each field's
  origin as `"db"` / `"env"` / `"none"`.

**Optional proxy egress:** `resolveTelegramRequestOptions`
(`telegram.ts:137`) routes the request through a stored proxy page when
`config.telegramProxyPageLabel` is set.

**Connection state:** `deriveTelegramConnectionState` (`telegram.ts:313`) only
treats the connection as verified after a real send that happened after
`credentialsUpdatedAt`.

## Daily revenue report (`services/telegram-report.ts`, 570 lines)

`buildDailyRevenueTelegramReport` (`telegram-report.ts:349`) closes the agency
business day at **02:00 Moscow** (`telegram-report.ts:22-23`). It builds three
windows — yesterday / 7d / 30d — each with a prior-period comparison, and reads
exact transactions via `getRevenuePageTotalsForExactPeriod` rather than the UTC
rollup.

- `renderDailyRevenueTelegramReport` (`telegram-report.ts:285`) renders
  proportional HTML: top 10 models + top 10 pages with overflow rows and colour
  dots.
- Delivery is a rendered PNG (`telegram-report-image.ts`, via chromium) with a
  text fallback, in `deliverDailyRevenueReport` (`telegram-report.ts:475`).
- `sendDailyRevenueTelegramReport` (`telegram-report.ts:497`) is gated on
  `settings.enabled && dailyReportEnabled`; the scheduled path logs an
  `insertDeliveryAttempt` of kind `daily_report_scheduled`.
- `sendManualDailyRevenueTelegramReport` (`telegram-report.ts:543`) is the
  manual (operator-triggered) path.

**Scheduling:** `ensureTelegramDailyReportSchedule` (`services/schedules.ts:48`)
registers the cron, run only by the leader-elected scheduler role. The
admin/config surface for Telegram (settings GET/PATCH, test, discover-chats,
incidents, report preview/send/history) lives in `ops/index.ts:750-1207`.

## Notification incidents (`services/notification-incidents.ts`, 496 lines)

The incident machinery, in which **Telegram is the only alert sink** — every
alert goes out through `sendTelegramMessage`, gated on
`settings.enabled && syncFailureAlertsEnabled`
(`notification-incidents.ts:177,270`).

Core primitives:

- `openIncidentAndNotify` (`notification-incidents.ts:136`) — dedups by
  `incidentKey` (`notification-incidents.ts:19`), opens the incident, then
  sends.
- `resolveIncidentAndNotify` (`notification-incidents.ts:232`) — resolves and
  notifies.
- `STREAM_FAILURE_THRESHOLD` = 3 consecutive failures
  (`notification-incidents.ts:17`).
- Each send writes an `insertDeliveryAttempt` (kind `incident_opened` /
  `incident_resolved`).
- Per-kind titles are at `notification-incidents.ts:44-71`.

Public entry points:

| Entry point | Anchor | Behavior |
|---|---|---|
| `notifyAuthFailedIncident` | — | page auth failure |
| `notifySyncChunkFailureIncident` | — | proxy vs `stream_failed_threshold` |
| `resolveSyncChunkRecoveryIncidents` | — | sync recovery |
| `notifyOfapiAuthIncident` | — | OFAPI auth failure |
| `notifyOfapiGlobalIncident` / `resolveOfapiGlobalIncident` | `:429-461` | global kinds (below) |
| `notifyWrongTransactionsWriterIncident` | `:210` | opens immediately |
| `handleSuccessfulPageVerificationRecovery` | `:463` | page-verification recovery |

The `notifyOfapiGlobalIncident` kinds
(`notification-incidents.ts:429-461`): `low_credit`, `webhook_silence`,
`burn_rate`, `db_disk_usage`, `observations_partitions`,
`read_gateway_capture`, `golden_signal_lag`.
