# OFAPI delivery recovery and event controls (S3)

This batch adds two vendor operations: delivery-history GET and one-attempt
manual redelivery POST. All vendor requests in validation use synthetic
responses. Production collection and optional subscriptions remain off until
the owner saves/applies them.

## Behavior and evidence

Migration 0158 stores each numeric provider attempt ID separately; delivery UUID
groups ordinary retries and never deduplicates attempt facts. Both failures and
successes are collected. Original attempt, manual-redelivery UUID, provider
outcome, retained receipt, projection status and canonical parser version remain
distinct. A queued acknowledgement never means successful delivery or projection.

History capture records exact responses before parsing. Fixed closed windows,
100-row pages, durable leases/cursors and overlapping scans prevent a crash
from silently skipping a page. A malformed page preserves raw evidence and
the old offset. Manual scans have at most 20 pages; automatic scans use one
bulk-priority page every five minutes with a one-hour overlap, and catch up
faster once coverage is more than 30 minutes old (see "Automatic redelivery and
collector catch-up" below). Credential changes
start a new scope. Scope is always labeled credential-visible: key access is
not proof of complete team coverage. Captured facts have no scheduled deletion.

The owner console lists safe machine metadata only. Payloads, callback URLs,
error messages and signing secrets do not enter summary responses. Local replay
targets one retained accepted receipt and its exact observation, retries failed
projection independently of its automatic retry cap, and retains the existing
SSE identity. Quarantined envelopes require separate validation; this action
does not silently approve them.

Remote redelivery requires a locally captured attempt with no local receipt.
The request first commits a durable intent and audit record. Preview does not
send. Dispatch makes one POST; an in-flight, accepted or indeterminate request
blocks another intent for any attempt of the same business key (H2 below). A
process/transport uncertainty remains
indeterminate and is never retried automatically. A new successful provider
attempt is matched to the acknowledgement UUID. HTTP 409 is presented as a
paused/disabled webhook. The hard manual limit is 20 manual requests per UTC
day; automatic requests (below) have their own counter and never consume it.

Exclusive page-scoped attempts, their intents and exclusive raw history or
single-account export receipts participate in governed page erasure. Mixed
captures and team export receipts remain exact and are counted in the existing
shared-observation residual. Erasure fences prevent older shared export facts,
status hints and delivery summaries from being recreated for the erased page.
New provider events after the erasure keep the existing material-time semantics.

## Owner rollout

1. Deploy migration 0158 and the API/worker/dashboard together after checks.
   Deploying does not enable collection or change remote subscriptions.
2. Open OFAPI credits → “События и восстановление”. Read the last day manually
   to verify history permissions and inspect provider → receipt → parser →
   projection evidence. Continue a partial scan until its state is complete.
3. Enable “Сохранять историю доставок” and save to start the free history
   collector. Clear it and save to stop new scheduled reads. Retained receipts
   and their recovery continue to work independently.
4. For each optional event group, select only that additional group and save,
   then press “Применить события”. Wait for applied status: the server reads the
   remote registration back and compares the complete event set, URL and scope.
   The groups are subscription expiry, account disconnects, media uploads,
   data exports and post likes. Existing 19 baseline subscriptions are preserved.
   Enable one group at a time and inspect outcomes before enabling the next.
5. To disable a group, clear it, save and apply; savings begin only after remote
   confirmation. Do not stop intake of callbacks for already accepted work.

History GET is free. Optional webhook groups create the documented paid event
stream; volume determines spend. A manual remote replay is approximately 0.01
credit per event under the current provider tariff. The endpoint itself has no
generic one-credit fallback; incoming webhook accounting remains the charge
authority. Local replay and DB-only reads make no vendor call.

## Contract discrepancies and limits

Live docs checked 2026-09-06 are authoritative:
[delivery history](https://docs.onlyfansapi.com/api-reference/webhooks/list-webhook-deliveries)
uses numeric attempt IDs, date_start/date_end, limit ≤100 and offset;
[manual redelivery](https://docs.onlyfansapi.com/api-reference/webhooks/redeliver-webhook-delivery)
returns a new data.redelivery_id UUID while retaining the business idempotency
key. These operation details are absent/incomplete in the pinned snapshot.
X-OFAPI-Redelivery-Of remains provenance, not a new business identity.

The provider keeps attempts for seven days and may generate no delivery while
paused. A gap older than retention or absent from the credential's scope cannot
be declared recovered. This batch preserves and reports evidence it can read;
it does not invent missing attempts or mark receipt/projection success from an
HTTP acknowledgement. Global malformed response bodies with unresolved account
scope remain reported erasure residuals instead of deleting bystander evidence.

## Validation

Focused tests cover attempt-versus-delivery identity, successful retry after
two failures, frozen pagination/resume, capture-before-parser failure, default
off, policy CAS/readback mismatch, owner authorization, preview, accepted versus
projected, HTTP 409, indeterminate outcome without repeat POST, exact local
projection/canonical replay and populated exclusive/shared erasure with replay.
Unit wire tests pin free history query parameters and malformed-page behavior.
Integrator runs pnpm check and the combined integration suites before PR review.


## Freshness and history boundary repair — 2026-09-08 (#276)

Read-only production evidence at `21e0ee332740`: current receipt processing and
message archive worked, but 135 current-account observations waited behind
452,533 unmapped historical webhook observations. The worker's recovery cursor
was process-local. Scan `ca170eee-6211-44c5-851e-8d4a3bb4d498` repeatedly failed
with `history_window_failed`: raw HTTP 200 observation 2271284 contained 91
attempts, three at `23:45:27.000000Z` against a `23:45:27.398Z` lower bound.
The raw page survived; five failed attempts in that page each had a later success
with the same delivery UUID. These counts describe the inspection, not all-time
coverage or a completed production repair.

The receipt job now canonicalizes its exact accepted observation through the
shared driver after settle and operational projections. Migration 0171 persists
background traversal per family/version/query scope, after every full page, with
revision CAS. Restart preserves progress; reaching the end wraps for another
attempt at unstamped history. Explicit replay and dry-run never move this cursor.

New history scans freeze inclusive windows at `.000` through `.999` boundary
seconds. Response validation allows the entire first/last second and still rejects
anything outside. Existing scans retain their original fractional query and offset
on resume; neither the raw attempt timestamp nor its provider identity changes.
The second-precision interpretation comes from the retained production response;
the provider docs describe inclusive date bounds but do not promise fractional
filter precision. Collection cadence, subscriptions and remote writes are unchanged.

Rollout requires owner approval for these concrete operations:

1. Deploy the tested revision with additive migration 0171. The previous image
   can run with that table present if application rollback is needed; do not
   reverse the migration or delete captured facts.
2. Observe a real new webhook: accepted receipt, stable fanout identity,
   operational projection and parser v5 for its exact observation, independent
   of old unmapped rows. API/worker/scheduler must report the intended revision.
3. Allow the existing automatic history collector to resume the failed scan.
   Require a completed stored scan and later successful windows; no repeat
   `history_window_failed` on same-second boundary timestamps. Check attempt
   identities and recovered-delivery status separately from receipt/projection.
4. Repair pre-deploy debt using the existing local `events:replay` path, first
   dry-run, then write mode for the same frozen received window:
   `[2026-09-07T23:45:00Z, 2026-09-08T02:06:25Z)`, kinds `messages.received`,
   `messages.sent`, `subscriptions.new`, `subscriptions.expired`, `users.online`,
   `users.offline`. Before either run, use the read plane to verify that **every
   eligible row** in this exact time/kind scope belongs through current native
   binding to page 8 or 9. The capture stores `account_id=NULL`, so `--account`
   would silently miss these rows; do not use that filter as a substitute for
   the binding census. If the census includes another native reference, stop
   this repair and prepare an exact-observation manifest instead. This window
   is bounded to the inspected 170 rows; later pre-deploy arrivals need their
   own verified extension. Use the deployed CLI via the authorized operational
   entrypoint. This is local database repair; remote redelivery is unnecessary.
5. Confirm remaining eligible debt by native binding for those two accounts and that closed window
   is zero (excluding typing and explicitly unparseable evidence), and inspect
   new receipts separately. Background historical debt can remain nonzero.

Regression coverage includes receipt dedup/SSE stability, a database failure
between canonical append and stamp followed by repair, continuation of a legacy
scan at offset 100, both boundary seconds and truly escaped-window rejection,
worker restart over unmapped history, cursor wrap/CAS and cursor-free dry replay.
Local validation is not production behavioral acceptance.

Follow-up read-only census at 2026-09-08 02:06:25 UTC found 170 pending
current-account observations in the repair window: 7 received messages, 3 sent
messages, 3 new subscriptions, 1 subscription expiry, 84 offline and 72 online
receipts. This expanded the prepared local repair to include subscription expiry;
no production write or redelivery was performed during implementation.

The read-plane check of the complete frozen time/kind scope returned only the
current native bindings: 124 pending rows for page 8 and 46 for page 9; all have
`observations.account_id=NULL`. No other page or unresolved reference was in that
scope. Prepared preview command, to run only through the approved production gate:

```sh
docker exec agency-hub-worker-1 node apps/runtime/dist/cli.js events:replay \
  --from 2026-09-07T23:45:00Z --to 2026-09-08T02:06:25Z \
  --kind messages.received --kind messages.sent \
  --kind subscriptions.new --kind subscriptions.expired \
  --kind users.online --kind users.offline --dry-run
```

After checking the census and preview, the approved write uses the identical
arguments with only `--dry-run` removed. Expected postcondition is zero remaining
eligible rows in this scope, not a globally empty historical backlog.

### Production acceptance — 2026-09-08, 10:10–10:24 UTC

Owner-approved PR #156 was deployed as `a6631a709991` with migration 0171.
API, worker and scheduler independently reported that revision and remained
healthy. The old 170-row overnight cohort had naturally progressed before
approval; a fresh full-scope census extended the upper bound to
`2026-09-08T10:14:00Z` and found 84 eligible rows, exclusively pages 8 and 9.
The same six-kind deployed CLI preview and write appended/stamped all 84, with
zero errors, binding conflicts or partition blocks. The last verification found
zero pending non-typing rows for both pages since the original lower bound.

The original fractional-window scan automatically completed at 10:15:30 UTC,
offset 91, without changing its bounds. All three formerly rejected boundary
timestamps were present in the retained successful response. A subsequent normal
free dashboard scan completed the closed day ending 10:20:00.999 UTC: 2,248
examined attempts and 553 new inserts. One response-body timeout preserved offset
100; continuing the same scan completed without a window error. All 22 failed
attempts had a success for the same delivery UUID in that captured day.

Eight real post-deploy webhook observations, covering both pages, were already
at v5 at 10:23:54 UTC while background sweeps remained among old unmapped rows.
One receipt was confirmed canonical within 7.4 seconds; this bounds one sample,
not a latency percentile. No synthetic callback, remote redelivery, subscription
change or message send was used. Historical unmapped debt remains retained.

Detailed evidence, exact repair command, validation and limitations:
[`investigations/ofapi-webhooks-prod-acceptance-2026-09-08.md`](https://github.com/goslingmanagment/core/blob/ecc864dadebfe200107d07319054df5b4c4385f3/investigations/ofapi-webhooks-prod-acceptance-2026-09-08.md).


## Automatic redelivery and collector catch-up — 2026-09-26 (H2, amends #265)

Decision #265 made remote redelivery a distinct owner action: durable intent
before a single POST, a hard 20/day limit, accepted/rejected/indeterminate
outcomes, and no claim of receipt from an acknowledgement. On 2026-09-23 a
~50-minute hub outage lost 14 business webhooks (55 provider attempts) that
nobody redelivered until the manual Stage 0 on 2026-09-26, and the history
collector was measured 27–63 minutes behind. This amendment keeps every #265
guarantee and adds a system actor next to the owner.

### Automatic redelivery

After each delivery-history sweep (the minutely OFAPI sweep job,
`runOfapiWebhookAutoRedelivery` right after `sweepOfapiWebhookDeliveryHistory`),
the worker requests one provider redelivery per eligible business key. The key
is the provider idempotency key; the redelivered attempt is the key's newest
captured attempt. A key is eligible when:

- its event type is a business fact: `messages.received`, `messages.sent`,
  `messages.deleted`, `messages.ppv.unlocked`, `tips.received`,
  `transactions.new`, `subscriptions.new`, `subscriptions.renewed`,
  `subscriptions.expired`. Presence, typing, account and async-job hooks are
  never redelivered automatically;
- every captured attempt of the key failed and happened at or after the enable
  moment (stored in `ofapi_webhook_auto_redelivery_state` the first time the
  worker sees the switch on; switching off clears it and a later switch-on
  starts a new moment). Failures before the moment, or from a switched-off
  period, stay for the manual action;
- its newest attempt is inside the 7-day retention and quiet: older than 10
  minutes by the clock, and completed history coverage (the newest completed
  scan window) reaches at least 10 minutes past it, so a lagging collector
  cannot fire in the middle of the provider's own retry chain;
- the receiver is proven alive after that attempt: a later successful delivery
  on this webhook or a local receipt received later. A dead api container or
  proxy behind a live worker therefore never receives a redelivery that would
  fail the same way;
- there is no local receipt (`ofapi_webhook_events` row with that key), no
  in-flight, accepted or indeterminate intent of either origin for any attempt
  of the key, and no earlier automatic request of any provider outcome.

Nearest to expiry goes first, at most 25 per tick. Candidates are selected
once per tick outside the reservation lock (partial index
`ofapi_webhook_delivery_failed_business_idx`); under the advisory lock shared
with the manual path only the one key is re-checked before its intent commits.

Before any claim the worker proves verified credential access and the declared
key scope for webhooks. Each request then commits a `dispatching` intent with
`origin='auto'`, `actor_user_id` null and `business_key`, plus a
`system.ofapi_webhook_auto_redelivery_requested` audit event (source `worker`),
and makes exactly one POST:

- `accepted`: verified acknowledgement; the tick continues;
- `rejected`: a definite 4xx other than 408 (409 = paused/disabled webhook);
- `indeterminate`: transport loss, timeout, 5xx, or any failure after the
  request may have reached OFAPI; never sent again;
- `not_sent`: a typed refusal the client raises before any egress (credential
  not verified, credit accounting unavailable, key scope denied/unavailable).
  It does not use the key's automatic shot, blocks nothing and counts toward
  no limit.

The first request that does not end `accepted` stops the tick and pauses
automatic requests (`paused_until`, `pause_reason`): 15 minutes, doubling on
each consecutive failure up to 6 hours; an accepted request resets the count.
A paused webhook or a degraded provider therefore costs one business key per
pause — a handful per day at most — and never blocks the shared sweep job for
more than one request. A unique index on `(webhook_id, business_key) WHERE
origin='auto' AND state<>'not_sent'` makes the one-request-per-key rule
durable; an interrupted dispatch settles as `indeterminate` after two minutes.

The manual guard is key-level too: an in-flight, accepted or indeterminate
request of either origin for any attempt of the key blocks a manual request
for another attempt of that key. The only exception is an attempt the
provider reported after that request (the earlier redelivery visibly failed),
which the owner may redeliver. The delivery-history view shows, for every
attempt, the newest request for its attempt or its business key.

Migration 0207 adds `origin` (`manual` default, so existing rows and an older
binary stay valid), `business_key` (backfilled from the attempt), the
`not_sent` state and check constraints: a manual intent has an actor, an
automatic one has none and has a business key. Migration 0208 builds the two
attempt indexes CONCURRENTLY outside a transaction (0143/0169 precedent). The
admin API contract is unchanged.

Caps, per UTC day, on separate counters that skip `not_sent`: 20 manual
requests (previously this limit counted every intent of the day) and
`OFAPI_WEBHOOK_AUTO_REDELIVERY_DAILY_CAP` automatic requests (default and
maximum 1000, about 10 credits). When the cap blocks an eligible key, the
worker logs `OFAPI webhook auto-redelivery daily cap reached` and opens the
existing `ofapi_burn_rate` incident under its own latch
`ofapi_burn_rate:global:auto_redelivery_cap` ("OFAPI webhook auto-redelivery
daily cap reached"; on the OFAPI credits page «Исчерпан суточный лимит
автоповтора вебхуков»; a new incident kind is a contract change and waits for
H3). The latch stays open until the day's automatic count is below the cap
(the next UTC day or a raised cap) or the feature is switched off; the
burn-rate paging policy pages after 30 minutes open. The hourly burn-rate
latch is unaffected.

Config (live overlay, no restart), both `editable` in the dashboard
configuration:

| Key | Env | Default |
|---|---|---|
| `ofapiWebhookAutoRedeliveryEnabled` | `OFAPI_WEBHOOK_AUTO_REDELIVERY_ENABLED` | `false` |
| `ofapiWebhookAutoRedeliveryDailyCap` | `OFAPI_WEBHOOK_AUTO_REDELIVERY_DAILY_CAP` | `1000` (1–1000) |

### Collector catch-up and coverage age

Coverage is the end of the newest completed history window. While it is at
most 30 minutes old the collector keeps the #265 cadence: one page every five
minutes. Once it is older, a healthy collector continues every minute with up
to five pages per tick; each page is captured and persisted before the next
request, and the frozen window, one-hour overlap and 7-day bound are unchanged.
A failed page keeps the five-minute pause. History GET remains free.

The golden-signal sampler emits `ofapi_delivery_history_age` (p50 = p95): now
minus the coverage end, or, before any window completes, minus the first
scan's creation (or the policy's last save). While collection is off or no
webhook is registered it reads a neutral 0, so a latch opened earlier resolves
instead of standing forever; a failing probe is a breach. Above 45 minutes it
opens `golden_signal_lag:global:ofapi_delivery_history_age` (existing kind and
paging policy); the value is on `GET /api/v1/ops/metrics`.

### Rollout

1. Deploy with migrations 0207 and 0208 (0208 builds concurrently; both are in
   the deploy script's rollback-compatible list). The switch stays off: no
   automatic POST, no enable moment. Catch-up and the coverage signal act at
   once on the existing collector (collection is enabled in production).
   Rollback caveat: the previous image counts every intent of the UTC day
   toward its manual limit of 20, so automatic intents written before a
   rollback can block manual redelivery until UTC midnight.
2. Enable: set `ofapiWebhookAutoRedeliveryEnabled` to on in the dashboard
   configuration (or the env var plus a worker restart). Within a minute the
   worker logs `OFAPI webhook auto-redelivery switched on`, and
   `select enabled_at,paused_until,pause_count from ofapi_webhook_auto_redelivery_state`
   returns the moment (null while switched off).
3. Verify read-only: `select origin,state,count(*) from
   ofapi_webhook_redelivery_intents where created_at>=current_date group by 1,2`;
   each automatic intent has a business-type attempt, no receipt at request
   time, and later a receipt/canonical event when accepted. A non-null
   `paused_until` with its `pause_reason` means the last request did not end
   accepted. Collector coverage: `select now()-max(window_end) from
   ofapi_webhook_delivery_scans where state='complete'` stays under ~30
   minutes; `ops_metric_samples` has `ofapi_delivery_history_age`.
4. Disable by switching it off; intents and their outcomes remain.

Validation: `tests/ofapi-webhook-auto-redelivery.integration.test.ts` covers
default off and the persisted/forgotten enable moment, the live overlay,
selection (types, quiet period, retention, enable moment, recovered keys,
receipts, active manual intents, keyless attempts), expiry ordering,
business-key dedup, the live-receiver and coverage preconditions, stop and
backoff after transport/409/post-response failures with no repeat, local
refusals that keep the key, key-scope readiness before a claim, the per-key
re-check under the lock, the key-level manual guard and history view, the
separate manual counter, schema checks, the cap alert with cap 1 and its
resolution, unavailable access, bounded catch-up, the five-minute cadence, the
pause after a failed page, the coverage-age latch and its resolution when
collection is switched off.

## Frame provenance and money facts — 2026-09-26 (H3)

Redelivery restores a fact; it is not fresh news. The v2 event stream and
`GET /api/v1/events/v2/facts` therefore say how each durable frame reached the
ledger, without changing its business identity (refs, dedup keys, sequence):

- `provenance: "redelivery"` — the event's source observation came from an
  OFAPI webhook receipt whose `capture_headers.redeliveryOf` is set (the
  provider's `x-ofapi-redelivery-of`, present on manual and automatic
  redeliveries alike). A redelivery reuses the original idempotency key, so the
  lookup is observation → same-key receipt, batched per replay page.
- `provenance: "repair"` — a superseding event (schema 2,
  `data.supersedesEventId`): the PPV ref repair, the Fansly 1970 repair and the
  DM corrections reconciler.
- `provenance: "live"` — everything else. Fansly accounts are never
  redelivered and skip the receipt lookup. When the lookup fails the field is
  omitted; clients treat a missing provenance as not live.

Clients show attention (toasts, sounds) only for `live` frames after the
replay boundary. The facts route pages `message.ppv_unlocked`, `tip.received`
and `transaction.posted` of one granted account by `account_seq`, excluding
events superseded under a `supersedes:<id>` key and serving their repair
instead. It reads existing rows only: no new sequence, cursor or business
identity (#265), and no OFAPI request.

Validation: `tests/domain-events-v2-platform.integration.test.ts` (live,
redelivered and repaired frames on replay and live lanes, facts paging and
supersession) and `tests/domain-events-stream.test.ts` (one lookup per batch,
Fansly skip, failed lookup omits provenance).
