# OnlyFansAPI webhook correctness audit — 2026-09-06

Target: `/tmp/hub-ofapi-audit-20260906/deployed`, git `7fac98f310d673134c8dcb5dd6596e126e7f9e69` (root verified this revision against the production image label). The original local checkout was older; all findings below were checked again against the deployed revision. No source edits, production/vendor requests, or vitest suites were performed by this audit worker.

Root verification during this audit: the target integration/unit selection passed **722 tests across 57 files, zero skipped**; live read-only observations showed last-24h accepted `users.typing=1153`, `users.online=994`, `users.offline=970`, and no `ofapi.webhook.invalid_identity` / malformed observations over the last 72h. Thus W1 is a confirmed compatibility defect whose production trigger was not observed in that window. Root also independently ran the source-execution repro and checked the subscription SQL guard.

The endpoint/event surface is not parity-complete. There are four confirmed correctness defects below; these are repository/source-execution findings, not claims that every condition occurred in production.

## Confirmed defects

### W1 — P1: valid no-key ephemeral deliveries are acknowledged and quarantined instead of processed

- Trigger: signed `users.typing`, `users.online` or `users.offline` delivery with no `X-OFAPI-Idempotency-Key`. The official contract explicitly permits this: those ephemeral events “carry no idempotency key”. [Delivery and retries](https://docs.onlyfansapi.com/webhooks/delivery-and-retries) (downloaded `llms-full.txt:4898-4907`).
- Code: `apps/runtime/src/services/ofapi-webhooks.ts:153-160` treats every missing header as invalid. `ofapi-webhook-capture.ts:68-98,182-215` records `ofapi.webhook.invalid_identity` and `quarantined_malformed`; it never accepts the original event kind. Receiver returns HTTP-success acknowledgment and does not enqueue processing.
- Impact: these valid deliveries never update typing/presence, never fan out and never canonicalize. Exact bytes survive, so local repair remains possible. This does **not** imply all production presence is broken: deliveries which do carry the header still work.
- Existing tests encode the wrong assumption: `tests/ofapi-webhook.integration.test.ts:272-327` uses the typing fixture, omits the header, and requires quarantine. This is why passing that suite does not prove compatibility with current docs.
- Actual-source repro: `webhook-repro.cjs` transpiles the deployed receiver and supplies valid HMACs with mocked storage seams; all three event kinds choose `capturePath=quarantine` and `received=true`. The full capture implementation was separately inspected to verify that seam is terminal quarantine.

### W2 — P2: an older subscription notification overwrites newer subscription material

- Trigger: a notification created before the currently stored subscription snapshot arrives later (delivery retries, previously missed event manually redelivered, or replay). Vendor explicitly says delivery order is not guaranteed and directs consumers to payload timestamps. [Delivery and retries](https://docs.onlyfansapi.com/webhooks/delivery-and-retries).
- Code: `apps/runtime/src/services/ofapi-subscription-projection.ts:183-208` preserves the newer `sourceUpdatedAt` but still takes the old notification's `priceMills`, sets `canonicalStatus=active`, and subsequently writes `isSubscriber=true` at `:211-218`. `packages/db/src/repositories/fans.ts:845-880` unconditionally replaces the conflict row and sets `isCurrent=true`; there is no SQL timestamp fence.
- Impact: a stale initial subscription price replaces the newer price while its timestamp falsely remains current. The same unconditional activation can resurrect a subscription the later audience sweep had retired. Material can remain incorrect until another audience pass.
- Actual-source repro result: current price `10000` mills, `sourceUpdatedAt=2026-09-06`; a delayed `subscriptions.new` created `2026-09-05` with `$4.00` yields `priceMills=4000` while `sourceUpdatedAt` remains `2026-09-06`. This repro uses the deployed source and mocked repository calls; the SQL's absence of a guard was independently inspected.

### W3 — P2: account lifecycle arrival order can pause a recovered account

- Trigger: the account reconnects, then an earlier `accounts.authentication_failed` or `*_required` notification arrives for the same current binding. Official delivery order is not guaranteed. Account payloads include authentication-attempt timestamps, but the handler does not read payload at all. [Account event catalog](https://docs.onlyfansapi.com/webhooks/available-events#accountsreconnected), [delivery ordering](https://docs.onlyfansapi.com/webhooks/delivery-and-retries).
- Code: `apps/runtime/src/services/ofapi-account-health.ts:68-73,100-123` uses `row.receivedAt` as the state timestamp and pauses streams based on that arrival. `packages/db/src/repositories/ofapi.ts` function `advancePageOfapiAuthStatus` only compares that receive timestamp. The canonicalizer also uses receipt time for account events (`canonicalize/ofapi-webhook.ts:301-315`). Binding-generation checks added in release #132 prevent cross-binding effects, but do not solve ordering within one binding.
- Impact: the older error wins over actual recovery, creates a fresh auth incident and parks working collectors until a further recovery or owner intervention.
- Actual-source repro: apply `accounts.reconnected` for auth attempt 10:01 received 10:02, then failure of attempt 10:00 received 10:03. Final state is `authentication_failed`; recorded actions are `resolve`, then `pause`, `notify`.

### W4 — P2: failed account-health projection is not retried after journal settlement

- Trigger: a transient failure in account-health processing after the webhook has settled, e.g. `getOfapiBindingPage` times out for a recovery notification. The existing code catches it, logs a warning and returns.
- Code: `apps/runtime/src/services/ofapi-account-health.ts:89-99,154-159`; `ofapi-events.ts:97-114` runs health after settlement, while `:287-288` returns immediately for an already-settled journal row. Unlike the DM/subscription/presence/spend paths, account health has no pending/failed bookkeeping and no projection sweep. `ofapi-events.ts:469-504` invokes only the account-health monitor, which checks credit balance and webhook silence, not missing lifecycle projections.
- Impact: a missed recovery leaves the old auth block/incident indefinitely; a missed failure does not park the account or alert. Retrying the pg-boss job or vendor delivery cannot repair it, because journal status already says processed.
- Actual-source repro: account-health binding read fails on processing a recovery; journal becomes `processed`. A second call after removing the failure returns before health; exactly one health read across both calls, auth state remains the previous failure. No DB integration or production fault injection was used.

## Event coverage

The official OnlyFans catalog documents **32 events**. The registration constant includes **19**, and the webhook canonicalizer declares **16**. The 13 omitted subscriptions are lifecycle/functionality gaps, not automatically 13 production incidents. Accounts-disconnected support is partial in the deployed revision: health logic exists, but the registered set still excludes it.

| Event | Registered by Hub | Canonicalized | Implemented handling |
|---|---|---|---|
| `accounts.connected` | yes | yes | account health + SSE + canonical |
| `accounts.reconnected` | yes | yes | account health + SSE + canonical |
| `accounts.disconnected` | no | no | health handler exists in deployed revision, but registration/SSE/canonical absent |
| `accounts.session_expired` | yes | yes | account health + SSE + canonical |
| `accounts.authentication_failed` | yes | yes | account health + SSE + canonical |
| `accounts.otp_code_required` | yes | yes | account health + SSE + canonical |
| `accounts.face_otp_required` | yes | yes | account health + SSE + canonical |
| `transactions.new` | yes | yes | canonical + spend projection + transaction ingest; no legacy SSE by design |
| `messages.received` | yes | yes | DM hot/cold archive, SSE, canonical event |
| `messages.sent` | yes | yes | DM hot/cold archive, SSE, canonical event |
| `messages.ppv.unlocked` | yes | yes | DM/SSE/canonical + estimated spend signal |
| `messages.deleted` | yes | yes | DM hot/cold archive, SSE, canonical event |
| `chat_queue.updated` | yes | no | journal only, no dedicated domain event/projection |
| `chat_queue.finished` | yes | no | journal only, no dedicated domain event/projection |
| `tips.received` | yes | yes | SSE/canonical + estimated spend signal; money comes from transactions.new |
| `subscriptions.new` | yes | yes | subscriber/page-fan projection + SSE + canonical |
| `subscriptions.renewed` | yes | yes | subscriber/page-fan projection + SSE + canonical |
| `subscriptions.expired` | no | no | not subscribed; no dedicated webhook handler |
| `posts.liked` | no | no | not subscribed; no dedicated webhook handler |
| `users.typing` | yes | no | legacy SSE when identity header passes; W1 affects documented no-key delivery |
| `users.online` | yes | yes | presence/SSE/canonical when identity header passes; W1 affects documented no-key delivery |
| `users.offline` | yes | yes | presence/SSE/canonical when identity header passes; W1 affects documented no-key delivery |
| `data_exports.calculating_credits` | no | no | not subscribed/handled as webhook; export workflows poll REST |
| `data_exports.calculating_credits_completed` | no | no | not subscribed/handled as webhook; export workflows poll REST |
| `data_exports.calculating_credits_failed` | no | no | not subscribed/handled as webhook; export workflows poll REST |
| `data_exports.in_progress` | no | no | not subscribed/handled as webhook; export workflows poll REST |
| `data_exports.completed` | no | no | not subscribed/handled as webhook; export workflows poll REST |
| `data_exports.failed` | no | no | not subscribed/handled as webhook; export workflows poll REST |
| `data_exports.cancelled` | no | no | not subscribed/handled as webhook; export workflows poll REST |
| `fan_summary.completed` | no | no | not subscribed; no dedicated webhook handler |
| `media_uploads.completed` | no | no | not subscribed; no dedicated webhook handler |
| `media_uploads.failed` | no | no | not subscribed; no dedicated webhook handler |

Sources: [OnlyFans event catalog](https://docs.onlyfansapi.com/webhooks/available-events), the delivery-filter enum in [List webhook deliveries](https://docs.onlyfansapi.com/api-reference/webhooks/list-webhook-deliveries); `apps/runtime/src/services/ofapi-webhooks.ts:47-67`, `canonicalize/ofapi-webhook.ts:30-47`, `ofapi-events.ts:122-225`. Exact machine-readable list: `webhook-catalog.json`.

Material missing lifecycle support:

- `subscriptions.expired`: neither subscribed, canonicalized, projected, nor mapped into SSE. The REST audience sweep remains the fallback for expiry, so this is missing near-real-time expiry, not proof that expiry is never discovered. The vendor requires using `payload.expiredAt`, not delivery time, for event ordering. [Expired event](https://docs.onlyfansapi.com/webhooks/available-events#subscriptionsexpired).
- `accounts.disconnected`: health logic includes `disconnected` in deployed `ofapi-account-health.ts:35-45`, but `OFAPI_WEBHOOK_EVENTS` omits it and the canonicalizer/SSE mapping omit it. A separately configured webhook can still reach the health handler; Hub's own subscription configuration does not request the signal. Subsequent REST `account_not_found` has a new independent recovery/blocking path. [Disconnected event](https://docs.onlyfansapi.com/webhooks/available-events#accountsdisconnected).
- `media_uploads.completed/failed`, `posts.liked`, `fan_summary.completed` and the seven export lifecycle kinds are not subscribed/handled as webhook events. Existing export polling must not be described as no export support.
- `chat_queue.updated/finished` are intentionally journal-only despite being subscribed; no queue projection/domain event.

## Delivery/recovery functionality gaps

- Hub has webhook register/status/reconcile but no typed delivery-history or manual-redelivery workflow (source search for `deliveries`/`redeliver` found no such API path). The current contract supports billing-aware manual replay with original idempotency key; this is a missing operator capability. [List deliveries](https://docs.onlyfansapi.com/api-reference/webhooks/list-webhook-deliveries), [Redeliver delivery](https://docs.onlyfansapi.com/api-reference/webhooks/redeliver-webhook-delivery).
- Receiver captures only signature and idempotency key; `X-OFAPI-Redelivery-Of` is not passed from `apps/runtime/src/modules/ingest/index.ts:110-115` to capture. Original-key dedupe works, but provenance cannot identify explicit provider replay.
- Comments claiming 15 seconds or five retries are stale. Current vendor documentation says 10 seconds total and 3 attempts. This is documentation drift rather than a proven runtime timeout bug. [Delivery and retries](https://docs.onlyfansapi.com/webhooks/delivery-and-retries).

## Verified safeguards and scope limits

- HMAC uses exact raw bytes, SHA-256, strict hex validation and timing-safe comparison. Secret rotation accepts active/previous/pending secrets. The route uses a Buffer parser before validation.
- Signed bytes commit before JSON interpretation; malformed/conflicting bytes are retained. Accepted rows and observations commit transactionally. A failed best-effort enqueue is recoverable by the pending sweep. Same-key/same-body delivery dedupes; same-key/different-body is preserved as a fact conflict, not silently overwritten.
- Presence parser reads nested fan ID and provider observation/last-seen timestamps; subscription/tip/PPV identity reads nested user/chat-link rather than untrusted notification `user_id`.
- Spend mapping recognizes all seven documented transaction categories; dollars become integer mills via the shared constructor. Pending versus terminal/reversed handling is explicit. PPV/tip notifications remain estimated signals, and only `transactions.new` enters money truth, preventing the obvious double-count. Fees/VAT/tax are represented; reversed rows use a separate transaction key and existing negation guards.
- No new confirmed vendor-shape defect in spend mapping was found in this scoped pass. That statement is not production acceptance or exhaustive concurrency proof. Potential repeated-domain-key sweep behavior was not elevated because occurrence of distinct delivery keys for the same status/version was not proven from current vendor contract or live data.
- Verification: `node /tmp/hub-ofapi-audit-20260906/webhook-repro.cjs` executed actual deployed TypeScript after transpilation, mocking DB/queue seams. Result: `webhook-repro-result.json`. Root owns integration suites and live verification; no suite was run in parallel by this worker.

Memory lookup used only to locate the prior audit context; all reported code findings were verified against the deployed source. Relevant registry lines if the root cites memory: `MEMORY.md:279-288` (prior scope and webhook ordering/ephemeral caution), rollout `01a07179-3f24-7222-84cf-36d9bba835c7`.
