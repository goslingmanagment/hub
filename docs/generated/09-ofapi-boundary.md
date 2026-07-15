> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# The onlyfansapi.com (OFAPI) Boundary

OFAPI is the runtime's OnlyFans transport, webhook source, credit meter, and
write executor. It is not treated as an internal database: signed deliveries
are journaled, reads are allowlisted and captured, writes enter an idempotent
outbox, and monetary rows pass through a single-writer and reconciliation
boundary.

## 1. Transport and egress

`apps/runtime/src/services/ofapi.ts` implements `OfapiClient`; its default base
URL is `https://app.onlyfansapi.com/api`. The client covers webhook
create/update, account listing, chats and chat messages, active fans,
transactions, chargebacks, generic allowlisted proxy reads, text/media sends,
typing, unsend, mark-read, and balance ping. Optional methods in the interface
let runtime features fail closed when the configured client does not implement
an operation.

Every observed HTTP attempt has operation metadata and an attempt number.
Transport failures, 429, and selected 5xx responses use bounded retry rules;
callers such as the DM conversation breaker can set `retries: 0` for a
single-attempt probe. OFAPI's legacy process-wide slot defaults to 500 ms.
Egress-pacer `enforce` replaces that slot; `shadow` computes a comparison
without adding latency.

`apps/runtime/src/services/ofapi-egress.ts` resolves account/page requests
through the page-scoped egress resolver. Generic vendor operations use the
OFAPI vendor scope. The former keeps page proxy identity for large account
reads when configured; the latter is direct to the gateway. Both ultimately
report their rate-limit class through the egress context described in
`docs/generated/08-platform-adapters-and-egress.md`.

### Credit accounting at the client

The client calls its credit-spend sink for every attempt that receives an HTTP
response. Provider `_meta._credits.used` wins. A successful response without
that metadata defaults to an estimated one-credit spend unless the operation
supplies a more precise fallback; an error without credit metadata creates no
spend claim. A reported balance can still create a zero-credit reconciliation
anchor. Zero-credit typing beacons are suppressed unless the provider reports
nonzero spend. Sink failure never changes the API result; reconciliation is the
durability backstop.

## 2. Webhook receiver

`apps/runtime/src/services/ofapi-webhooks.ts` subscribes to:

- messages received, sent, deleted, and PPV unlocked;
- tips and new transactions;
- subscriptions new and renewed;
- typing, online, and offline presence;
- connected, reconnected, session-expired, authentication-failed,
  OTP-required, and face-OTP-required account states.

`POST /api/v1/ofapi/webhook` is isolated under a buffer-mode JSON parser in
`apps/runtime/src/modules/ingest/index.ts`. It intentionally has no route-level
rate limiter: a 429 before journaling could permanently lose a signed delivery
after the provider's retry limit.

The receiver order is:

1. Load registered webhook configuration.
2. Verify a hex HMAC-SHA256 over the exact raw bytes using constant-time
   comparison. The current and previous encrypted secrets are both accepted
   during rotation.
3. Validate `x-ofapi-idempotency-key`, parse JSON, and validate the envelope.
4. In one transaction, insert the OFAPI event journal row and a `webhook`
   observation containing the full envelope. Mapping is not required, so an
   unknown account is still captured.
5. Return an idempotent success for an already-known delivery; for a new row,
   best-effort enqueue its event id. The minutely sweep recovers enqueue loss.

A journal/observation transaction failure returns 5xx and relies on provider
redelivery; it cannot produce an acknowledged but unobserved webhook.

Webhook registration uses a global account scope, replaces or creates the
remote webhook, stores the new signing secret encrypted, preserves the prior
secret for the grace window, and maps OFAPI accounts to OnlyFans pages only on
an existing id or an unambiguous username match. Ambiguous accounts/pages are
reported rather than guessed. Owner routes are
`GET /api/v1/admin/ofapi/webhook` and
`POST /api/v1/admin/ofapi/webhook`.

## 3. Journal processing and legacy sync fanout

`apps/runtime/src/services/ofapi-events.ts` owns queue
`ofapi.events.process.v2`. Jobs are exclusive per event id, have bounded queue
retries, and are supplemented by a minutely pending-row sweep. The worker is
required to run as one replica and also holds a PostgreSQL advisory lock; this
preserves committed fanout ordering for the v1 SSE cursor.

Processing resolves the page, maps supported envelopes to a `SyncEvent`, and
settles the journal row as processed, skipped, or failed. Settle and
`pg_notify` share one transaction. Data-shape/mapping failures settle rather
than retry forever; infrastructure failures propagate to queue retry.

The legacy frame mapping includes message receive/send/delete, PPV unlock,
tip, chat-list refresh on subscription changes, presence, typing, and account
auth. PPV/tip conversation identity comes from `notificationChatId` in
`ofapi-payloads.ts`, including nested user and `MESSAGE_LINK` shapes; a
top-level creator id is not used as the fan chat. `transactions.new` is
journaled and projected but intentionally has no legacy desktop frame.

After settle, best-effort work runs in this order-independent side lane:
command correlation from `messages.sent`, cold DM archive, hot DM projection,
subscription projection, presence projection, spend projection, and account
health. Each service is independently flag-gated and keeps its own retry
bookkeeping, so it cannot roll back or reorder the settled fanout fact.

## 4. Read gateway

`GET /api/v1/ofapi/read/*` is registered at 120 requests per minute and
requires an API-key principal. `apps/runtime/src/services/ofapi-read-gateway.ts`
parses the path and query before any upstream request, checks current page
assignment, then proxies through page-scoped egress.

Local synthetic endpoints are `accounts` and `whoami`. The upstream read-only
allowlist covers chats, chat-message list/item, chat media, user lookup/list,
transactions, all/active fans, user lists and members, vault media/list/item,
and upload status. Query names, enum values, integer ranges, cursor
combinations, limits, and account-id syntax are explicit. Mutating vault paths
and every unrecognized path are rejected.

`apps/runtime/src/services/ofapi-read-gateway-capture.ts` tees each successful
upstream response into an asynchronous in-process queue after the response
path has succeeded. Queue cap is 500; overflow or insert failure increments a
visible drop counter and opens a global incident at the configured threshold.
This lane alone is deliberately fail-open because reads recur; webhook, pull,
and command capture are not.

Ordinary captures use the gateway operation as observation kind. When DM
readthrough reconciliation is enabled, chat-message list reads use kind
`ofapi_gateway_chat_messages_v2` and payload
`{ofapiAccountId, chatId, conversationRef, cursors, body}`. After insertion the
drainer attempts immediate projection using the exact returned
`(observationId, receivedAt)`; the minutely dedicated projector is the retry.

## 5. Command outbox

`POST /api/v1/ofapi/commands`, `GET /api/v1/ofapi/commands/:commandId`, and
`POST /api/v1/ofapi/commands/:commandId/cancel` are implemented by
`apps/runtime/src/services/ofapi-command-outbox.ts`. Creation is limited to 60
requests per minute and requires current page assignment.

The accepted command kinds are:

- `send_text_message_v1`
- `send_media_message_v1`
- `typing_active_v1`
- `unsend_message_v1`
- `mark_chat_read_v1`

The caller supplies a `clientCommandId`. A canonical payload hash makes retry
of the same client command id idempotent and rejects conflicting reuse.
Explicit retry lineage is permitted only for text/media commands, only in the
same account/conversation and kind, and only from a retryable terminal or
indeterminate source state.

Media validation accepts a free price of 0 or integer prices 3 through 200,
requires one to 50 unique media ids, and requires preview ids to be unique
members of the attachment set. Unsend accepts a numeric platform message id.

The durable states are `queued`, `in_flight`, `confirmed`,
`failed_retryable`, `failed_terminal`, `indeterminate`, and `cancelled`.
`apps/runtime/src/services/ofapi-command-executor.ts` claims a queued row with
a minimum creation time so an expired command cannot race execution. The
general queued TTL defaults to ten minutes and is config-resolvable; typing
expires after ten seconds. The minutely sweep expires queued rows before its
execution-disabled early return and records a cancelled `command_result`
observation with `expired_queued_ttl`. In-flight attempts older than two
minutes become indeterminate. Typing payloads are the only short-retention
command exception; terminal business command payloads remain retained.

Only the transaction that wins finalization records the command-result fact,
so direct response and webhook verifier cannot both settle the command. A
confirmed direct text/media send also writes a `source="command"` DM candidate
best-effort. A later `messages.sent` webhook independently upgrades message
material through the webhook archive lane and may correlate exactly one
matching in-flight/indeterminate command by account, conversation, timing,
text, media count, and price. Ambiguous matches are not guessed.

## 6. Credit ledger and reports

`apps/runtime/src/services/ofapi-credits.ts` persists response-level spends,
daily webhook accrual, reported-balance anchors, and reconciliation
adjustments. It also monitors burn rate and the available balance. Credit
reports in `ofapi-credit-report.ts` expose overall and per-chatter summaries,
runway estimates, UTC-day series, ledger pagination, and CSV export. Actor user
id attributes desktop gateway/command activity; scheduled work remains system
activity.

The recurring UTC jobs are:

| Time | Work |
|---|---|
| 00:05 daily | balance ping |
| 00:40 daily | previous-day webhook accrual |
| minute 05 hourly | credit reconciliation |

Budget guards in `apps/runtime/src/services/sync/ofapi-dm-sync.ts` reserve
credit before a request. Per-chunk exhaustion yields normally; daily budget or
balance floor writes a durable delay/block instead of repeatedly spending.

## 7. Spend truth and monetary correction

Webhook `transactions.new` rows first enter
`ofapi-spend-projection.ts`. When truth ingest is enabled,
`ofapi-spend-transaction-ingest.ts` applies unconsumed rows under a per-page
lock and `transactions-writer-gate.ts`; a page assigned to another writer is
refused and incidented while other pages continue. REST backfill in
`ofapi-transactions-backfill.ts` uses the same writer seam and does not demote
an already-posted transaction with a stale pending copy.

`apps/runtime/src/services/money-negation-guards.ts` prevents two failure
classes under the same page lock:

- if `:reversal` and `:chargeback` both negate one payment, the first active
  negative wins and the other is stored inactive as
  `superseded_duplicate_negation`;
- if no active posted original exists, the negative is stored inactive as
  `reversal_without_settled_original`; a later posted original is the only
  path that can reactivate it.

Rows are deactivated, not deleted, and affected spender/revenue projections
are rebuilt from the earliest changed date. Daily chargeback reconcile runs at
03:10 UTC.

`apps/runtime/src/services/ofapi-pending-reconcile.ts` runs at 03:25 UTC. A
pending older than seven days is rescanned through the normal transactions
backfill from one day before its earliest occurrence. Pages whose fresh scan
is blocked are not expired. On successfully scanned pages, rows still active
and pending are retired as missing from the sync window and rollups rebuilt;
the job rereads original ids to report settled, expired, and unresolved counts
without optimistic arithmetic. A later reappearing provider row can reactivate
through the ordinary upsert path.

## 8. Boundary invariants

- Webhook HMAC is over raw bytes; JSON reserialization is never verification.
- Capture and acknowledgment precede all optional projections.
- Read and command routes recheck current page assignment instead of trusting
  a stale account id held by a client.
- OFAPI writes exist only as durable commands; a UI call never directly
  performs an unjournaled platform mutation.
- Provider credit metadata is preferred, but missing ledger writes do not
  change the provider response; balance reconciliation makes gaps visible.
- Money corrections retain lineage and rebuild derived state rather than
  deleting inconvenient facts.
