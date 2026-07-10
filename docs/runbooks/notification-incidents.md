# Notification incidents — delivery semantics & W3 operational notes

## Telegram delivery is at-least-once (W3.3, cross-review note)

Incident OPEN notifications retry on later monitor passes until one attempt
lands (`telegram_delivery_attempts.status = 'sent'`), capped at 5 total
attempts per incident. Consequences:

- **A duplicate page is possible** if the process dies between the Telegram
  accept and the attempt-row insert — the next pass sees `sentCount = 0` and
  re-sends. This is deliberate: preferable to the pre-W3 behavior where one
  transient Telegram failure at open time lost that incident's page
  permanently.
- Watch `telegram_delivery_attempts` after deploying a change to this
  machinery: duplicates on a standing incident should STOP once a `sent` row
  exists for it. A stream of repeats past 5 attempts is a bug.
- An incident opened while alerts were disabled records no attempt and is
  never retro-paged (re-enabling alerts must not flood).

Telegram alerting does NOT carry the outbox one-attempt law — sends already
retry in-process on 429/5xx, and a duplicate pager message is harmless.

## proxy_missing incidents (W3.1, decision #124)

A `proxy_missing` incident means the fail-closed egress guard refused to
resolve a Fansly page context because no proxy is stored (never assigned, or
purged by erasure). The affected stream parks as
`manual_action_required`/`proxy_missing` — sync does not retry on its own.

Repair: assign a proxy on the Credentials tab (or `page set-proxy` CLI — the
assignment path bypasses the guard deliberately and verifies through the NEW
proxy). The incident resolves on the next successful chunk or verification.

## syncUnblocked: false (W3.3, D4-N1)

A credential update/verify that returns `syncUnblocked: false` verified the
credentials but FAILED to clear the sync auth block — streams stay paused and
the incidents stay open (they are still true). Retry verification; if it
persists, check worker logs for `clearPageSyncAuthBlock` failures.
