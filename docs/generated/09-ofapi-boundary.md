> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# The onlyfansapi.com (OFAPI) Boundary

This map covers the full boundary between the kernel and `onlyfansapi.com`
(OFAPI), the third-party OnlyFans gateway that fronts every OnlyFans page. It
traces the transport client (`ofapi.ts` / `ofapi-egress.ts`), inbound webhook
ingestion, the desktop read gateway, the command outbox, the credit ledger and
its reconciliation machinery, and the spend pipeline that turns platform
transactions into truth. All paths are repo-relative; `runtime` abbreviates
`apps/runtime/src`. This boundary is distinct from `packages/onlyfans`, the
retired OnlyMonster adapter (`runtime/services/onlyfans.ts:1`).

## 1. Transport (`ofapi.ts`, `ofapi-egress.ts`)

Every OFAPI HTTP call goes through `OfapiClient`, which is also the single
`_meta`/credit-spend tap; a gate test forbids the host string appearing
anywhere else in runtime code (comment `ofapi.ts:33-35`).

- **Base URL.** `OFAPI_DEFAULT_BASE_URL = "https://app.onlyfansapi.com/api"`
  (`ofapi.ts:36`), trailing slash stripped, overridable via `input.baseUrl` /
  `config.ofapiBaseUrl` (`ofapi.ts:552`).
- **Auth.** `authorization: Bearer ${input.apiKey}` is set on every request
  path (list `ofapi.ts:679`, proxyRead `ofapi.ts:816`, sendMessage
  `ofapi.ts:920`, typing `ofapi.ts:1048`, unsend `ofapi.ts:1119`, markRead
  `ofapi.ts:1199`, admin `request()` `ofapi.ts:1274`), alongside
  `accept: application/json`; JSON bodies add `content-type: application/json`.
- **Timeouts** (`ofapi.ts:21-27`): default `15_000ms`; a slow-read lane of
  `60_000ms` applies to chat-message history only (`ofapi.ts:1394`), and
  proxy-read uses `60_000ms`. The slow lane was added by a live-bug fix
  (2026-07-05) because chat-history reads scrape OnlyFans server-side and scale
  with chat size.
- **Egress resolver** (`resolveOfapiEgressContext` `ofapi-egress.ts:18-49`):
  looks up the page via `findPageById`, asserts `platform === "onlyfans"` and a
  matching `ofapiAccountId` (`ofapi-egress.ts:26-32`), and builds an undici
  `Dispatcher` from the page's stored proxy (`createProxyRequestDispatcher`
  `ofapi-egress.ts:41`), returning `{dispatcher, egressKey, close}`.
  Account-scoped reads (large bodies) must route through page egress rather
  than the hub VPS (`ofapi.ts:72-74`). The dispatcher is attached to the
  `fetch` init only on `proxyRead` (`ofapi.ts:821-823`); the observed-list path
  runs on default egress. Backfill and chargebacks build their own dispatcher
  directly via `createProxyRequestDispatcher`
  (`ofapi-transactions-backfill.ts:878`, `ofapi-chargebacks-sync.ts:250`).
- **Rate limiting / class-aware pacing** (`ofapi.ts:605-639`): a client-wide
  slot machine `waitForRequestSlot(priorityClass)` with `restDelayMs` default
  `500` (`OFAPI_DEFAULT_REST_DELAY_MS` `ofapi.ts:28`). Priority classes are
  `"bulk"` (observed list reads `ofapi.ts:674`), `"interactive"` (proxyRead
  `ofapi.ts:809`), and `"commands"` (all POST/DELETE command calls, e.g.
  `ofapi.ts:913`). The Stage 26 class-aware `EgressPacer` (`ofapi.ts:610`) runs
  in `enforce` mode (pacer paces) or `shadow` mode (the legacy slot machine
  enforces while the pacer decision is computed fire-and-forget and diffed via
  `onShadowDiff` `ofapi.ts:623-633`). Observed reads retry on 429 honoring
  `retry-after` (`resolveRetryAfterMs` `ofapi.ts:524`, capped at 60s) and on
  500/502/503/504 (`ofapi.ts:731-752`), up to `OFAPI_OBSERVED_RETRIES = 3`
  (`ofapi.ts:29`).
- **Per-call credit metering** (`ofapi.ts:130-177`, `reportCreditSpend`
  `ofapi.ts:558-604`): charge-bearing HTTP responses that reached the server are reported
  to the injected `onCreditSpend` sink, retries included (the server charged
  each). `parseResponseMeta` (`ofapi.ts:434-449`) reads
  `_meta._credits.used/.balance`, `_meta._cache.is_cached`, and
  `_meta._rate_limits.remaining_minute`. `resolveOfapiCreditSpend`
  (`ofapi.ts:157-177`): server `creditsUsed` always wins (never estimated); a
  2xx without `_meta` assumes 1 credit with `estimated=true`; an error without
  `_meta` produces no row unless a balance is present, in which case a
  0-credit reconciliation anchor is emitted. Fallback credits are overridable
  per operation. Typing sends `fallbackCredits:0` and suppresses a zero-credit
  observation so high-frequency ephemeral beacons cannot grow the permanent
  ledger; an unexpected non-zero provider charge is still reported. The
  upload-status gateway op sends `0` `ofapi-read-gateway.ts:338`). Sink
  failures are swallowed (`ofapi.ts:601-603`). Each observation carries
  `pageId` (ledger attribution, D2), `actorUserId` (Stage 9 acting principal,
  NULL = system), `attemptNumber`, and `requestId` (`operation:uuid`).
- **Response-shape telemetry** lands in `sync_http_attempts.response_shape`
  (returnedItems, hasNextPage, credits, rate) via `executeObservedRequest`
  (`ofapi.ts:782-790`).
- **Wire coercions.** Numeric-string media ids become numbers (`toWireMediaId`
  `ofapi.ts:898`); `lockedText:true` is set when priced media is accompanied by
  non-empty text (`ofapi.ts:1019`). Response-shape helpers tolerate wrapped
  `{data}` / bare bodies and `{data:{list,hasMore}}` shapes (`toListPage`
  `ofapi.ts:469`, `toFansListPage` `ofapi.ts:499`).

### Operation catalog (`OfapiClient`, `ofapi.ts:179-319`)

| Method | Endpoint / shape | Op id | Priority class | Notes |
|---|---|---|---|---|
| `createWebhook` / `updateWebhook` | `POST/PUT /webhooks` | `ofapi_webhook_crud` | commands | admin flow |
| `listAccounts` | `GET /accounts` | `ofapi_admin_accounts` | — | carries no `_meta` |
| `listChats` | `/:acct/chats` | — | bulk | observed |
| `listChatMessages` | `/:acct/chats/:id/messages` | — | bulk | `order=desc`, inclusive `first_id` cursor, slow-read timeout |
| `listActiveFans` | `/:acct/fans/active` | — | bulk | hard cap 20 (`OFAPI_FANS_PAGE_LIMIT` `ofapi.ts:31,1400`) |
| `listTransactions` | `/:acct/transactions` | — | bulk | observed |
| `listChargebacks` | `/:acct/chargebacks` (`data.list`) | — | bulk | observed |
| tracking / trial-link family | tracking + trial-link endpoints | — | bulk | observed |
| `pingBalance` | reads a 1-row chats page | — | bulk | `/accounts` has no `_meta`, so a chats page is used for balance (`ofapi.ts:264-267,1528`) |
| `proxyRead` | validated passthrough | per gateway op | interactive | exactly one attempt — desktop remains retry authority (`ofapi.ts:268-271`) |
| `sendTextMessage` | send text DM | — | commands | exactly one attempt (#56) |
| `sendMediaMessage` | send media DM | — | commands | exactly one attempt (#57) |
| `startTyping` | typing indicator | — | commands | exactly one attempt (#59), `fallbackCredits:0` |
| `unsendMessage` | unsend a DM | — | commands | exactly one attempt (#60) |
| `markChatRead` | mark chat read | — | commands | exactly one attempt (#61) |

## 2. Webhook ingestion (`ofapi-webhooks.ts`, `ofapi-events.ts`, `ofapi-payloads.ts`)

- **Endpoint.** `POST /api/v1/ofapi/webhook` (`modules/ingest/index.ts:91`),
  with the body parsed as a raw **buffer** (`{parseAs:"buffer"}`
  `modules/ingest/index.ts:85`) so the HMAC is verified over exact bytes.
  Rate-limited to `ofapiWebhookRateLimitMax ?? 1000` per
  `ofapiWebhookRateLimitWindowSeconds ?? 60`s
  (`modules/ingest/index.ts:95-96`), returning 429 on exceed. Owner-only admin
  status/register lives at `GET/POST /api/v1/admin/ofapi/webhook`
  (`modules/ingest/index.ts:113,122`).
- **Signature verification** (`verifyOfapiSignature` `ofapi-webhooks.ts:75-87`):
  hex `HMAC-SHA256(rawBody, signingSecret)` over the raw bytes, header name
  `signature` (`modules/ingest/index.ts:107`), constant-time `timingSafeEqual`,
  required to match `/^[0-9a-f]{64}$/i`. Both the current AND the previous
  signing secret are accepted (rotation grace, `ofapi-webhooks.ts:121-130`);
  failure raises `UnauthorizedError` and a `warn` log. The idempotency key
  comes from the `x-ofapi-idempotency-key` header (`ofapi-webhooks.ts:142`, max
  255 chars, format `evt_<40hex>` per the fixtures README).
- **Envelope** (`ofapiWebhookEnvelopeSchema` `ofapi-payloads.ts:11-15`):
  `{event, account_id?, payload}` — there is no event id in the body.
- **Subscribed events** (`OFAPI_WEBHOOK_EVENTS` `ofapi-webhooks.ts:41-59`):
  `messages.received/.sent/.deleted/.ppv.unlocked`, `tips.received`,
  `transactions.new`, `subscriptions.new/.renewed`,
  `users.typing/.online/.offline`, and the account lifecycle set
  `accounts.connected/.reconnected/.session_expired/.authentication_failed/.otp_code_required/.face_otp_required`.
- **Atomic journal → observation** (`receiveOfapiWebhook`
  `ofapi-webhooks.ts:105-216`): a single DB transaction inserts the
  `ofapi_webhook_events` journal row (`insertOfapiWebhookEvent`) plus an
  `insertObservation` (source `webhook`, producer `ofapi:webhook`,
  `payloadHash=sha256(rawBody)`, key = idempotency key). Atomicity means a
  missing observation partition rolls both back, yielding a 5xx so OFAPI
  retries — nothing is ever acked-but-unobserved. Journaling is unconditional
  (no capture flags); deliveries for unmapped accounts are captured too.
  `projectionStatus` is stamped `"pending"` if the event is
  DM/subscription/presence-projectable (`ofapi-webhooks.ts:176-180`), else
  `"none"`. A duplicate idempotency key returns `{received:true, duplicate:true}`
  with no second observation. A best-effort `sendOfapiEventProcessJob` follows
  (the minutely sweep re-enqueues if lost).
- **Async processing** (`ofapi-events.ts`): queues `ofapi.events.process.v2`
  (exclusive policy, `singletonKey=eventId`, `retryLimit:2`, batchSize 100
  `ofapi-events.ts:59,62,229-236`), `ofapi.events.sweep` (minutely `* * * * *`
  `ofapi-events.ts:253`), and `ofapi.events.cleanup` (daily `30 2 * * *` UTC
  `ofapi-events.ts:254`). A single-worker invariant is enforced via a pg
  advisory lock (namespace `58211`, key `1` `ofapi-events.ts:75,394`) plus a
  replica assertion (`ofapi-events.ts:378`). `processOfapiWebhookEvent`
  (`ofapi-events.ts:278`) resolves the page via `pages.ofapi_account_id`
  (`findPageByOfapiAccountId`), derives the SSE `SyncEvent` frame
  (`mapOfapiEventToSyncEvent` `ofapi-events.ts:119-222`), settles the row
  `processed/skipped/failed`, and issues `pg_notify('ofapi_sync_events', rowId)`
  inside the settle transaction (`ofapi-events.ts:343`) for SSE fanout
  (`services/events-stream.ts`). Data problems settle as skipped/failed with no
  retry; only infra errors retry. Retention is
  `DEFAULT_OFAPI_EVENT_RETENTION_DAYS = 36500` (effectively forever — journal
  rows are business facts, `ofapi-events.ts:70`).
- **SSE frame mapping** (`ofapi-events.ts:119-222`): `messages.received` →
  `messageReceived` (chatId = `payload.fromUser.id`); `messages.sent` →
  `messageSent` (chatId = `payload.toUser.id`); `messages.deleted` →
  `messageDeleted`; `messages.ppv.unlocked` → `ppvUnlocked`; `tips.received` →
  `tipReceived` (+amountUsd); `subscriptions.new/.renewed` → `chatListUpdated`;
  `users.online/.offline` → `presence`; `users.typing` → `typing`;
  `accounts.connected/.reconnected/.session_expired` → `accountAuthChanged
  authenticated:true`;
  `accounts.authentication_failed/.otp_code_required/.face_otp_required` →
  `authenticated:false`. `transactions.new` returns null — journaled but NOT
  fanned out, so there is no desktop frame and no credit-charged refetch
  (`ofapi-events.ts:117`).
- **Post-settle projections** (`runPostSettleOfapiProjections`
  `ofapi-events.ts:96-111`, all best-effort and never throwing into the
  settle): command webhook verification, DM cold archive, DM projection,
  subscription projection, presence projection, spend projection, and
  account-health.
- **Fixtures** (`tests/fixtures/ofapi-webhooks/`): `messages_deleted.json`,
  `messages_ppv_unlocked.json`, `messages_received.json`, `messages_sent.json`,
  `subscriptions_new.json`, `tips_received.json`, `transactions_new.json`,
  `unverified_subscriptions_renewed.json`, `unverified_tips_received.json`,
  `users_offline.json`, `users_online.json`, `users_typing.json`, plus a
  `README.md`. The `unverified_*` files are doc examples that did not fire
  during capture; the rest are live-captured 2026-06-10 and anonymized.
- **Payload helpers** (`ofapi-payloads.ts`): notification chat/message ids are
  extracted from the OnlyFans chat-link regexes `/[?&]firstId=(\d+)/` and
  `/\/my\/chats\/chat\/(\d+)/` (`ofapi-payloads.ts:73-83`); the top-level
  `user_id` is the CREATOR, never the fan (`ofapi-payloads.ts:78`).
  `normalizeOfapiSyncMessage` builds the DM frame (media, tip, replyTo
  `ofapi-payloads.ts:175`).

## 3. Read gateway (`ofapi-read-gateway.ts`, `ofapi-read-gateway-capture.ts`)

- **Endpoint.** `GET /api/v1/ofapi/read/*` (`modules/ingest/index.ts:131`),
  API-key user, rate-limited 120/min. Gated on
  `ofapiDesktopReadGatewayEnabled === true` AND
  `ofapiCreditLedgerEnabled === true` (`ofapi-read-gateway.ts:366-371`).
- **Synthetic + proxied paths.** `whoami` returns a synthetic api-key/team JSON
  (`ofapi-read-gateway.ts:377-386`); `accounts` returns the chatter's assigned
  mapped pages shaped as OFAPI account records
  (`ofapi-read-gateway.ts:391-408`); everything else is a validated `proxy`
  request.
- **Allowlist** (`resolveOfapiReadGatewayRequest`
  `ofapi-read-gateway.ts:149-343`): strict path/query validation with account
  ids required to match `/^acct_[A-Za-z0-9]+$/`. Proxied ops are
  `ofapi_gateway_chats`, `ofapi_gateway_chat_messages` (first_id/last_id
  mutually exclusive, order constraints), `ofapi_gateway_chat_message`,
  `ofapi_gateway_chat_media`, `ofapi_gateway_users_list`, `ofapi_gateway_user`,
  `ofapi_gateway_transactions`, `ofapi_gateway_fans_all` / `_active` (including
  `filter[online]=1` and `filter[total_spent]`
  `ofapi-read-gateway.ts:266-267`), `ofapi_gateway_user_lists`,
  `ofapi_gateway_user_list_users`, `ofapi_gateway_vault_media`,
  `ofapi_gateway_vault_lists`, `ofapi_gateway_vault_media_item`, and
  `ofapi_gateway_upload_status` (fallbackCredits 0). `media/vault/delete-media`
  is explicitly rejected (read-only allowlist `ofapi-read-gateway.ts:315`); any
  other path raises `BadRequestError`.
- **Execution** (`executeOfapiReadGatewayRequest`
  `ofapi-read-gateway.ts:358`): the page must be in
  `principal.assignedPageIds`, else `NotFoundError`; page egress is resolved
  (`resolveOfapiEgressContext`); a single upstream `proxyRead` attempt is
  attributed with `pageId` + `actorUserId=principal.user.id` (credit spend,
  Stage 9); the passthrough forwards headers `content-type, retry-after,
  x-ofapi-credits-*, x-rate-limit-*` (`ofapi.ts:869-876`); the egress
  dispatcher is closed in `finally`. An `OfapiApiError` with null status maps to
  `ServiceUnavailableError`.
- **Capture tee** (`ofapi-read-gateway-capture.ts`, Stage 9 producer 4): on 2xx
  only (`ofapi-read-gateway.ts:435`), `enqueueReadGatewayCapture` performs an
  O(1) enqueue OFF the latency path; a single async drainer inserts
  observations (source `readthrough`, producer `read-gateway`,
  `accountId=pageId`, `kind=operation`, payload = response body verbatim,
  `payloadHash=sha256(body)`, `idempotencyKey=rg:<uuid>` — each response its own
  fact, `actorPrincipalId=principalUserId` `ofapi-read-gateway-capture.ts:95-110`).
  This is the **only fail-OPEN producer** (webhook, pull, command, and operator
  producers stay fail-closed `ofapi-read-gateway-capture.ts:3-7`): the queue cap
  is 500 with a drop-incident threshold of 25
  (`ofapi-read-gateway-capture.ts:28-29`); drops increment a counter and raise
  `notifyOfapiGlobalIncident kind:"read_gateway_capture"` via a self-re-arming
  latch (`ofapi-read-gateway-capture.ts:54-71`).

## 4. Command outbox (`ofapi-command-outbox.ts`, `ofapi-command-executor.ts`)

Contract prose: `docs/ofapi-command-outbox-contract.md`.

- **Routes** (`modules/ingest/index.ts:153-192`):
  `POST /api/v1/ofapi/commands` (create, rate-limit 60/min),
  `GET /api/v1/ofapi/commands/:id`, and
  `POST /api/v1/ofapi/commands/:id/cancel`. All API-key user, gated on
  `ofapiDesktopCommandOutboxEnabled === true` (`ofapi-command-outbox.ts:113`).
- **Command kinds** (`OfapiCommandKind` `ofapi-command-outbox.ts:19-24`):
  `send_text_message_v1`, `send_media_message_v1`, `typing_active_v1`,
  `unsend_message_v1`, `mark_chat_read_v1`. Only text/media accept
  `retryOfCommandId` (`ofapi-command-outbox.ts:200-206`); the retry source must
  be owned, in the same conversation, of the same kind, and in a retryable
  source state (`RETRYABLE_SOURCE_STATES = failed_retryable | failed_terminal |
  indeterminate | cancelled` `ofapi-command-outbox.ts:71-76`).
- **Enqueue** (`createOfapiCommand` `ofapi-command-outbox.ts:191-265`): resolves
  the assigned page, computes a canonical `sha256` payload hash
  (`ofapi-command-outbox.ts:135-160`), and calls `createOrGetOfapiCommand`,
  idempotent on `clientCommandId`. A new command returns HTTP **202** in state
  `queued` with `deduplicated=false`; an exact replay returns **200** with
  `deduplicated=true`; mismatched fields on the same `clientCommandId` raise
  `ConflictError` (**409**). The route then fires `sendOfapiCommandExecuteJob`
  if 202 + execution enabled (`modules/ingest/index.ts:165`). Cancel: only
  `queued → cancelled` is mutable; a repeat cancel is idempotent; anything else
  is 409 (`ofapi-command-outbox.ts:284-322`).
- **Executor loop** (`ofapi-command-executor.ts`): queues
  `ofapi.commands.execute` (**standard policy, retryLimit:0**
  `ofapi-command-executor.ts:148-151`) and `ofapi.commands.sweep` (exclusive,
  minutely `* * * * *` `ofapi-command-executor.ts:162`). The execute job uses
  `singletonKey=commandId, retryLimit:0` (`ofapi-command-executor.ts:172`).
  `executeOfapiCommand` (`ofapi-command-executor.ts:265`) is gated on
  `ofapiDesktopCommandExecutionEnabled`; `claimQueuedOfapiCommand`
  transactionally moves `queued → in_flight` (a partial-unique index enforces
  one in_flight per `(page_id, conversation_id)` lane; the DB constraint from
  migration `0039` limits one attempt per row).
- **Single-attempt / fail-closed.** Exactly one vendor call, then terminal. The
  **auth-gate fail-fast** (`ofapi-command-executor.ts:292-324`): if
  account-health is enabled AND `ofapiAuthStatusNeedsAction(page.ofapiAuthStatus)`,
  the command finalizes `failed_terminal` `ofapi_auth_action_required` WITHOUT
  spending the attempt (no HTTP). On success, `finalizeOfapiCommand` records
  `confirmed` (with `platformMessageId` for text/media/unsend; null for
  typing/markRead). On error, `classifyOfapiCommandFailure`
  (`ofapi-command-executor.ts:49-91`) classifies using
  `error.upstreamStatus ?? error.status` (unwrapping `ONLYFANS_COM_ERROR`
  `ofapi.ts:327-335`).
- **Failure classification** (`classifyOfapiCommandFailure`
  `ofapi-command-executor.ts:49-91`):

  | Upstream status | State | Error code |
  |---|---|---|
  | 429 | `failed_retryable` | `ofapi_rate_limited` |
  | 400, 401, 403, 404, 409, 422 | `failed_terminal` | `ofapi_http_<n>` |
  | 2xx (ambiguous success) | `indeterminate` | `ofapi_ambiguous_success` |
  | other non-null status | `indeterminate` | `ofapi_http_<n>` |
  | null (transport) | `indeterminate` | `ofapi_transport_unknown` |

- **Sweep** (`sweepOfapiCommands` `ofapi-command-executor.ts:429`): typing rows
  have a 10-second claim/expiry TTL and a two-minute dedupe horizon; terminal
  typing rows are deleted after that horizon. Other stale
  `in_flight` older than `STALE_IN_FLIGHT_MS = 2min` as `indeterminate` (never
  auto-requeued `ofapi-command-executor.ts:34,434`) and re-enqueues up to
  `COMMAND_SWEEP_LIMIT = 100` queued commands. As of Stage 28 the redaction arm
  is retired — terminal business-command payloads are kept permanently
  (`ofapi-command-executor.ts:445-447`).
- **Webhook verification** (`verifyOfapiCommandFromSentWebhook`
  `ofapi-command-executor.ts:494-587`): on a `messages.sent` webhook, matches
  candidate in_flight/indeterminate text/media commands within
  `WEBHOOK_CORRELATION_WINDOW_MS = 10min` back / `WEBHOOK_CLOCK_SKEW_MS = 5s`
  forward (`ofapi-command-executor.ts:35-36`); an exactly-one match finalizes
  `confirmed` with source `messages.sent`; ambiguous or no-match cases are
  logged.
- **command_result observation** (Stage 7 producer 5,
  `recordCommandResultObservation` `ofapi-command-executor.ts:107-141`): every
  durable business-command settle emits an observation with source `command_result`, producer
  `ofapi:command-executor`, kind `command.<state>`, key `cmd:<id>:<state>`
  (deduping the direct-confirm vs webhook-confirm race), best-effort AFTER the
  finalize commit. Cosmetic typing is explicitly excluded.
- **Payload validation** (executor): text (`textPayload`), media
  (`mediaPayload` `ofapi-command-executor.ts:204` — price 0 or a 3..200
  integer, 1-50 unique mediaFiles matching `MEDIA_ID_PATTERN`, previews a
  subset of mediaFiles), unsend (numeric messageId). Invalid payloads raise
  `OfapiApiError 422`, classified as `failed_terminal`.

### Command state enum (`OfapiCommandView.state` `ofapi-command-outbox.ts:91-98`)

| State | Terminal | Meaning |
|---|---|---|
| `queued` | no | enqueued, awaiting execution |
| `in_flight` | no | claimed, one vendor call in progress |
| `confirmed` | yes | send acknowledged (directly or via later webhook/verifier) |
| `failed_retryable` | yes | rate-limited (429); a client may enqueue a retry |
| `failed_terminal` | yes | 4xx/validation/auth-required; not retryable as-is |
| `indeterminate` | yes | ambiguous outcome; only a later webhook/verifier promotes to `confirmed` |
| `cancelled` | yes | cancelled while still `queued` |

The state machine matches contract doc §160-170 exactly, and the outcome
classification (including 408/5xx → indeterminate, §329-338) and the stale
`in_flight → indeterminate, never requeued` rule (§338-339) are consistent
with code; migration `0039` provides the one-attempt constraint.

## 5. Credits (`ofapi-credits.ts`, `ofapi-credit-report.ts`, `ofapi-account-health.ts`)

- **Ledger sink** (`createOfapiCreditSpendSink` `ofapi-credits.ts:62-92`): wired
  into `createOfapiClient.onCreditSpend`; gated on `ofapiCreditLedgerEnabled`
  (default off). `recordOfapiCreditSpend` writes an append-only
  `ofapi_credit_ledger` row plus an `ofapi_credit_state` day counter in one
  transaction and never throws (reconciliation absorbs gaps).
- **Webhook accrual** (`ofapi-credits.ts:94-153`): OFAPI charges 1 credit per
  100 webhook events, so `ceil(events/100)` credits are accrued per completed
  UTC day (`webhookAccrualCredits` `ofapi-credits.ts:95`); the daily backfill
  walks `ACCRUAL_BACKFILL_MAX_DAYS = 7` (`ofapi-credits.ts:42`) and is
  idempotent (`upsertOfapiWebhookAccrual`, `occurredAt` inside the accrued day).
- **Reconciliation** (D5, bank-style, hourly; `planOfapiCreditReconciliation`
  `ofapi-credits.ts:187`, `runOfapiCreditReconciliation` `ofapi-credits.ts:251`):
  walks balance observations from a cursor with
  `residual = prevBalance - knownCredits - observedBalance`; positive residual
  becomes `external` spend, negative becomes `refill`; tolerance
  `RECONCILE_TOLERANCE_CREDITS = 1`, min gap `60_000ms`, batch 500
  (`ofapi-credits.ts:45-48`). Webhook burn is estimated per window
  (`events/100`) as known spend so accrual rows are not double-counted (F8,
  `ofapi-credits.ts:299-300`).
- **Burn monitor** (D6, `runOfapiCreditBurnMonitor` `ofapi-credits.ts:342`):
  compares trailing-60-minute all-source-except-refills spend against
  `ofapiBurnAlertCreditsPerHour ?? DEFAULT_BURN_ALERT_CREDITS_PER_HOUR = 300`
  (`ofapi-credits.ts:38`); raises a debounced `ofapi_burn_rate` incident; runs
  in the minutely OFAPI sweep (`ofapi-events.ts:491`).
- **Balance ping** (`runOfapiBalancePing` `ofapi-credits.ts:391`, default off
  via `ofapiBalancePingEnabled`): a 1-credit `pingBalance` on the first mapped
  page (falling back to `listAccounts`).
- **Credit queues/schedules** (`ofapi-credits.ts:34-36,424-435`, all UTC,
  exclusive): `ofapi.credits.balance-ping` `5 0 * * *`,
  `ofapi.credits.accrual` `40 0 * * *`, `ofapi.credits.reconcile` `5 * * * *`.
- **Credit report** (`ofapi-credit-report.ts`, owner-only `/ofapi-credits`
  dashboard, D7 — makes no OFAPI calls): `getOfapiCreditsSummary`
  (`ofapi-credit-report.ts:206`) returns balance, today by source
  (rest/webhookAccrual/external/adjustment), per-stream budgets (dm ceiling
  `ofapiDmDailyCreditBudget ?? 500`, audience `?? 300`), the credit floor
  (`ofapiCreditFloor ?? 500`, `isOfapiCreditFloorBlocking`), a 7-day runway
  (`estimateOfapiRunway` `ofapi-credit-report.ts:100`), a month-end projection,
  a refill recommendation (30-day target), and recent-burn drivers (top ops and
  pages). `getChatterOfapiCreditsSummary` is the page-scoped variant.
  `getOfapiCreditsDaily` yields a dense daily series plus balance, refills, and
  by-op / by-page with a revenue join. CSV export is capped at
  `OFAPI_LEDGER_CSV_MAX_ROWS = 50_000` (`ofapi-credit-report.ts:538`) and
  RFC-4180 escaped.
- **Account health** (`ofapi-account-health.ts`, gated
  `ofapiAccountHealthEnabled`, default off): `applyOfapiAccountHealthEvent`
  (`ofapi-account-health.ts:75`) post-settle projects `accounts.*` into
  `pages.ofapi_auth_status`, forward-only by receive time
  (`advancePageOfapiAuthStatus`). Action-required statuses
  `{authentication_failed, otp_code_required, face_otp_required}`
  (`OFAPI_AUTH_ACTION_REQUIRED_STATUSES` `ofapi-account-health.ts:33`) pause the
  page sync (`pausePageSyncForAuth`, blocker `auth`) and raise
  `notifyOfapiAuthIncident`; `session_expired` is alert-only (OFAPI recovers
  silently); `connected/reconnected` clears the auth block and resolves the
  incident. `runOfapiAccountHealthMonitor` (`ofapi-account-health.ts:147`,
  minutely) raises low-credit (`ofapiCreditAlertThreshold ?? 1000`) and
  webhook-silence (`ofapiWebhookSilenceThresholdMinutes ?? 720`) incidents.

## 6. Spend pipeline

- **Contract / mapping** (`ofapi-spend-projection-contract.ts`): event types
  `transactions.new | tips.received | messages.ppv.unlocked`
  (`ofapi-spend-projection-contract.ts:18-21`); categories
  `message|tip|subscription|post|stream|other`; statuses
  `pending|settled|reversed|estimated`. `mapTransactionsNew` handles real
  amounts (USD-only, fee/vat/tax `ofapi-spend-projection-contract.ts:224`);
  `mapPpvUnlocked` derives an estimated amount from the text `{AMOUNT}` token
  with status `estimated` (`ofapi-spend-projection-contract.ts:270`);
  `mapTipsReceived` (UNBLOCKED 2026-06-30) emits an estimated shadow SIGNAL only
  with `transactionId:null` to avoid double-counting against the
  `transactions.new type=tip` row (`ofapi-spend-projection-contract.ts:308-351`).
  Domain keys are `ofapi:<acct>:tx[-reversal]:<id>`, `:ppv:`, `:tip:`
  (`ofapi-spend-projection-contract.ts:182-191`).
  `OFAPI_TIPS_RECEIVED_BLOCKED_REASON` is retained for self-healing legacy rows
  (`ofapi-spend-projection-contract.ts:16`, mirrored hardcoded in the db pkg).
- **Shadow projection** (`ofapi-spend-projection.ts`, gated
  `ofapiSpendProjectionShadowEnabled`): writes
  `ofapi_spend_projection_events` (projected/skipped,
  `upsertOfapiSpendProjectionEvent`) with amounts as **mills** BigInt
  (`ofapi-spend-projection.ts:132-141`). Runs post-settle
  (`runOfapiSpendProjectionForSettledRow` `ofapi-spend-projection.ts:230`) plus a
  minutely sweep (limit 200). On its own it writes comparison rows only.
- **Transaction ingest → truth** (`ofapi-spend-transaction-ingest.ts`, gated
  `ofapiSpendTransactionIngestEnabled`): `applyOfapiSpendProjectionTransactions`
  (`ofapi-spend-transaction-ingest.ts:130`) lists missing projected txns (limit
  200), groups by page, and under `withOfapiSpendTransactionPageLock` plus the
  Stage-13 single-writer gate `assertPageTransactionsWriter(writer="ofapi")`
  (`ofapi-spend-transaction-ingest.ts:56`; a `WrongTransactionsWriterError`
  leaves that page's rows pending and opens an incident while other pages
  continue) upserts `transactions` (source `ofapi:webhook`, linking
  `sourceObservationId` via `findObservationByKey`), then runs
  `rebuildSpenderProjections` + `rebuildRevenueRollups` from the earliest dirty
  point.
- **Mapping** (`ofapi-spend-transaction-mapping.ts`): category maps to
  `TransactionType` (reversed → `refund`
  `ofapi-spend-transaction-mapping.ts:10`); status maps to `TransactionState`
  (pending → pending, else posted `ofapi-spend-transaction-mapping.ts:34`);
  `normalizeOfapiSpendAmountMills` negates the amount on reversed
  (`ofapi-spend-transaction-mapping.ts:40`).
- **Comparison job** (`ofapi-spend-comparison.ts`, read-only admin):
  `getOfapiSpendComparison` (`ofapi-spend-comparison.ts:75`) returns a
  projection-vs-core `transactions` summary plus by-page breakdown and samples
  over N days (default 7), with explicit stated limitations (no writes; ppv
  estimated; tips excluded until a fixture exists; desktop cadence unchanged).
- **Chargebacks sync** (`ofapi-chargebacks-sync.ts`, Stage 14, gated
  `ofapiChargebacksReconcileEnabled`): a daily reconcile of
  `GET /{account}/chargebacks`, writing `canonicalType='chargeback'` source
  `ofapi:rest` with the gross **negated** (mirroring OnlyMonster). The queue
  `ofapi.chargebacks.reconcile` (exclusive) is scheduled **`10 3 * * *` UTC
  (03:10)** (`ofapi-chargebacks-sync.ts:453-454`). The trailing window is
  `CHARGEBACKS_LOOKBACK_DAYS = 90` once a page has rows; the first walk is
  all-or-nothing (writes nothing if truncated,
  `ofapi-chargebacks-sync.ts:315-325`), capped at `MAX_PAGES_PER_RUN = 20` /
  `FIRST_WALK_MAX_PAGES = 200` (`ofapi-chargebacks-sync.ts:52-57`);
  `transactionId = <paymentId>:chargeback`; the single-writer gate applies; the
  day-credit budget is `ofapiBackfillDailyCreditBudget ?? 200` via
  `createOfapiRestGuard` budgetScope `backfill`.
- **Backfill** (`ofapi-transactions-backfill.ts`): a CLI/one-shot
  `runOfapiTransactionsBackfill` (`ofapi-transactions-backfill.ts:809`) over
  `GET /{account}/transactions`, dry-run or write. Writes are gated on
  `ofapiSpendTransactionIngestEnabled` (else ZERO OFAPI calls and all pages
  report `ingest_disabled` `ofapi-transactions-backfill.ts:833`). Eligibility
  (`loadWriteEligibility` `ofapi-transactions-backfill.ts:398`) requires
  onlyfans + `ofapiAccountId` + `transactionsWriter === "ofapi"` + no page
  credentials + no active non-OFAPI transactions. It writes source `ofapi:rest`
  with the same row shape as webhook ingest (converging). Terminal-state
  precedence skips pending rows already `posted`
  (`ofapi-transactions-backfill.ts:685-720`). Pagination uses an
  ascending-order-proven early stop
  (`ofapi-transactions-backfill.ts:456-604`), caps `LIMIT = 100` /
  `MAX_PAGES = 1000`, with stop reasons
  `completed|reached_window_end|page_cap|budget_exhausted`, a
  reserve-before-request budget guard, and an overlap check against projection
  events. The per-page report includes histograms, month summaries, and the
  overlap match rate.

## Cross-cutting cron summary (all UTC)

- `* * * * *` — events sweep (re-enqueue + all projection sweeps +
  account-health + burn monitor), command sweep.
- `10 * * * *` — DM analytics rebuild.
- `5 * * * *` — credit reconcile.
- `5 0 * * *` balance ping · `40 0 * * *` webhook accrual ·
  `30 2 * * *` events cleanup (+ DM archive purge) ·
  `10 3 * * *` chargebacks reconcile.
