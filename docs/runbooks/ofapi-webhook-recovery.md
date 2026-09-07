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
