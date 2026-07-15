> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Telegram delivery, reports, and notification incidents

Telegram is an outbound operator boundary plus a polling-based chat discovery
tool. Runtime code is in `apps/runtime/src/services/telegram.ts`, daily report
composition is in `telegram-report.ts`, and incident latching/delivery is in
`notification-incidents.ts`. Owner dashboard handlers are grouped in the ops
module.

## Credentials and transport

Operational settings are stored in `telegram_settings` through
`packages/db/src/repositories/telegram-settings.ts`. The bot token is encrypted
with the versioned application encryption envelope; chat ID, enabled state,
report hour, and comparison mode are stored alongside it. Bot token and chat ID
resolve independently with database-over-environment precedence; the configured
environment report hour supplies the stored-settings default.

`resolveTelegramCredentials` reports whether the effective credential came
from the database or environment. A configured `telegramProxyPageLabel` causes
Bot API traffic to use that page's stored proxy through the shared proxy
dispatcher; an absent label uses direct server egress. Invalid/missing proxy
configuration is surfaced as a Telegram proxy configuration error.

`sendTelegramMessage` uses a 10-second request timeout and `sendTelegramPhoto`
uses 30 seconds. They retry HTTP 429 and 5xx responses up to two times using
`Retry-After` or exponential delay. Errors pass through secret redaction and
operator-facing classification. Results are `sent`, `failed`, or `skipped`
when notifications are disabled/unconfigured.

`discoverTelegramChats` validates the token with `getMe` and peeks `getUpdates`
without an offset. It extracts unique chats from pending updates for owner
selection; Core does not register a Telegram webhook or consume chat commands.

## Daily revenue reports

`apps/runtime/src/services/telegram-report.ts` builds a Moscow-business-day
net-revenue digest from the same reporting services used by HTTP routes. It
includes agency totals, prior-period comparisons, model/page
breakdowns, and top-page groups. Money is kept in mills until compact
formatting. The message uses Telegram HTML parse mode and escapes dynamic text.

The scheduled queue is `telegram.daily-report`; the scheduler registers it and
the worker sends at the configured UTC report hour. Report delivery and the
rendered body are written to `notification_deliveries`. Manual preview and send
routes reuse the same builder; manual sends are separately typed in delivery
history.

Owner routes in `apps/runtime/src/modules/ops/index.ts` expose notification
settings, test delivery, chat discovery, report preview/send/history, incident
listing, and manual incident resolution. The dashboard groups these into
settings, incidents, and reports tabs under
`apps/dashboard/src/pages/notifications/`.

## Incident latches

`packages/db/src/repositories/notifications.ts` persists
`notification_incidents` and `notification_deliveries`. An incident key
deduplicates a standing condition by kind and optional page/stream/subkey.
Global golden-signal incidents use a metric subkey so one breached signal does
not mask another.

The current incident vocabulary includes:

- page auth/proxy failure and missing Fansly proxy;
- repeated sync-stream failure;
- OFAPI authentication, low credit, webhook silence, and high burn rate;
- database disk usage and observations-partition lead;
- wrong transactions writer and read-gateway capture failure;
- per-metric golden-signal lag; and
- silent scheduler or silent ops sampler deadmen.

`openNotificationIncidentWithRecoveryGuard` creates or reopens a latch while
respecting recorded recovery. `notification-incidents.ts` renders exhaustive
per-kind open and resolved messages. Opening delivery is retried on monitor
cadence up to a bounded attempt count and each attempt is recorded. Recovery
records the recovery fact, sends the resolved message, and resolves the latch.
Sync recovery helpers also clear the page's persistent auth block when a
successful verification proves recovery.

Incident producers live beside the condition they observe: sync/auth/proxy
services, OFAPI account/credit/webhook monitors, the DB disk guard,
observations-partition monitor, golden-signals sampler, transaction writer
gate, read-gateway capture, and ops watchdog.

Tests in `tests/telegram*.test.ts`,
`tests/notification-incidents.integration.test.ts`,
`tests/notification-incident-messages.test.ts`, and
`tests/notifications-dashboard.integration.test.ts` cover transport,
formatting, persistence, deduplication, retry, recovery, and owner surfaces.
