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
bulk-priority page every five minutes with a one-hour overlap. Credential changes
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
send. Dispatch makes one POST; accepted and indeterminate attempts block another
intent for that provider attempt. A process/transport uncertainty remains
indeterminate and is never retried automatically. A new successful provider
attempt is matched to the acknowledgement UUID. HTTP 409 is presented as a
paused/disabled webhook. The hard manual limit is 20 requests per UTC day.

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
