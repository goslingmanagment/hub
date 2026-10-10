# Notification incidents — delivery semantics & W3 operational notes

## Telegram delivery is at-least-once (W3.3; outbox rules since Д2)

Every page and recovery goes through the durable `notification_delivery_outbox`
(Decision 381: the paging sweep decides, the outbox delivers). Delivery rules
(`docs/error-handling.md`, "Durable critical-notification outbox"):

- **Horizon.** Every `sync_failure` row (opening, recovery, missed-alerts
  summary) carries `max_attempts = 400`: retries at 1, 2, 4, 8 min, then at most
  8 an hour — ≥ 49 h whatever the mix of successes and failures. The AI
  critical pair keeps 5.
- **Stop on the first failure.** A delivery pass ends at its first send that
  does not go through: during an outage one call a minute, not one ~40 s
  failure per due row. A timed-out request is not repeated inside its call.
- **Backoff release.** The first delivered row after 15 minutes without any
  delivery makes every backed-off `sync_failure` row due at once: what is still
  open goes out within a pass or two, at worst 15 minutes after Telegram is
  back. At most once per 15 minutes; never for the AI pair.
- **Missed alerts.** A page that resolves while its opening never reached
  Telegram (`pending` or `exhausted`) gets no late "🚨" and no orphan "✅": its
  opening is retired (`exhausted`, `last_error` `Not delivered: …`,
  `reported_in_outbox_id` → the summary) and the episode is a line of one
  "📵 Not delivered in time" summary. A manual resolve from the dashboard
  retires a pending opening without a summary.

Consequences:

- **A duplicate page is possible** when Telegram accepts a message and the
  answer is lost (or the process dies before the attempt row commits): the row
  is sent again. Bounded to ≤ 4 copies an hour of one standing row, ≤ 8 on a
  channel that flaps with a period of 15 min or more. Deliberate: a duplicate is
  preferable to a lost page.
- An incident opened while alerts were disabled gets a `suppressed` row and is
  never retro-paged (re-enabling alerts must not flood).

Telegram alerting does NOT carry the outbox one-attempt law — that law is the
platform command outbox's (`ofapi_commands`), where a duplicate is a real
action; a duplicate pager message is harmless.

Checks (read-only, `prodsql.sh`; `:d` = deploy time):

```sql
set local statement_timeout = '30s';
-- The queue right now (normally empty).
select id, paging_policy, transition, state, attempt_count, max_attempts
  from notification_delivery_outbox where state in ('pending', 'leased');
-- No undelivered opening without its summary (expect 0).
select count(*) from notification_delivery_outbox
 where created_at > :d and paging_policy = 'sync_failure' and transition <> 'resolved'
   and state = 'exhausted' and reported_in_outbox_id is null
   and last_error not like 'Not delivered: manually resolved%';
-- No sync_failure row exhausted by its counter (expect 0; else an outage outlasted 49 h).
select count(*) from notification_delivery_outbox
 where exhausted_at > :d and paging_policy = 'sync_failure' and last_error not like 'Not delivered:%';
-- The stop on the first failure: at most 2 failed sends a minute (worker + api fallback).
select date_trunc('minute', created_at), count(*) from telegram_delivery_attempts
 where created_at > :d and kind in ('incident_opened', 'incident_resolved') and status in ('failed', 'skipped')
 group by 1 having count(*) > 2;
-- The summaries and the openings each one reports (delivered, length ≤ 3 500).
select s.id, s.state, length(s.message_text), count(r.id) from notification_delivery_outbox s
  join notification_delivery_outbox r on r.reported_in_outbox_id = s.id
 where s.created_at > :d group by 1, 2, 3;
```

## proxy_missing incidents (W3.1, decision #124)

A `proxy_missing` incident means the fail-closed egress guard refused to
resolve a Fansly page context because no proxy is stored (never assigned, or
purged by erasure). The affected stream parks as
`manual_action_required`/`proxy_missing` — sync does not retry on its own.

Repair: assign a proxy on the Credentials tab (or `page set-proxy` CLI — the
assignment path bypasses the guard deliberately and verifies through the NEW
proxy). The incident resolves on the next successful chunk or verification.

## proxy_failed / auth_blocked recovery needs a provider answer

A sync chunk resolves these page-wide incidents only when it got at least one
successful provider response, at the time of the newest one. A chunk that made
no request, or whose every attempt failed, leaves them open and writes no
recovery tombstone. So does a settlement retry that reuses an earlier chunk's
completed result: it makes no request, and the original completion time can
itself come from a walk that made none. It still resolves `proxy_missing` and its own stream's
`stream_failed_threshold`. So during an outage the incident stays open instead of
flapping open/resolved; it closes at the first real success on any stream of the
page, or on page verification.

## stream_failed_threshold on a page the Fansly Sync Engine runs

A legacy stream's latch (`stream_failed_threshold:<page>:<stream>`) resolves
only through the legacy executor's own chunk recovery, and the legacy executor
never runs a stream of a page the Fansly Sync Engine owns. So the latch is
closed at the transition: the switch's phase C and every live takeover of the
`sync` host resolve the page's open ones through the ordinary resolve (recovery
tombstone, the paging sweep's resolve message after its hold), stored as
`metadata.resolution = 'engine_owned'`. The resolve message reads
`Stream <stream> closed: <page> (fansly)` with the line
`Reason: the page is owned by the Fansly Sync Engine; the legacy stream no longer runs`.
While the engine owns the page (`handover` or `live`) a legacy chunk failure
opens no legacy incident (`proxy_failed` or `stream_failed_threshold`); the
engine reports the page through its own `fansly_sync_engine` alerts. A page
rolled back to `off` gets its legacy latches back from the next legacy failure
(the streak stays on the legacy row). OnlyFans pages and the engine's own
latches are untouched.

## syncUnblocked: false (W3.3, D4-N1)

A credential update/verify that returns `syncUnblocked: false` verified the
credentials but FAILED to clear the sync auth block — streams stay paused and
the incidents stay open (they are still true). Retry verification; if it
persists, check worker logs for `clearPageSyncAuthBlock` failures.
