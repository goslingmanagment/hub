# OFAPI webhook lifecycle release (S2, W1–W4)

This batch changes local interpretation and retry behavior. It makes no vendor
requests during capture/projection and does not enable optional subscriptions.
The baseline registration remains the existing 19 events. Owner enabling is a
separate collection-policy apply followed by remote registration readback.

## Shipped behavior

- Signed no-key typing/online/offline receipts each receive a local UUID after
  HMAC verification. Raw bytes commit before envelope interpretation. Identical
  typing pulses remain separate receipts. Missing identity for non-ephemeral
  facts and oversized identities remain quarantined. Old receipt replay does
  not fan out typing/presence after the five-minute live window.
- Subscription new/renewed/expired share a material timestamp fence. Expiry
  uses `payload.expiredAt`, emits existing `subscription.ended`, retains lapse
  history and never replaces a later renewal. A delayed initial notification
  cannot replace a newer price or reverse a completed audience retirement.
- Account transitions use disconnected_at or latestAuthAttempt timestamps,
  with receipt fallback for older payloads missing provider time. Equal-time
  recovery wins over an earlier failure. Current binding checks remain in the
  advisory lock shared with remap. Historical binding failures cannot alter
  the replacement or emit a false current account-auth frame.
- Account projection errors roll back state and effects together. The existing
  journal projection status records failure independently of settlement; the
  minutely sweep retries up to five attempts. Explicit local processing of a
  settled accepted row also retries pending/failed projections.
- All seven data export and both media upload lifecycle events validate into
  the durable journal and canonical events. Team-level export events attribute
  only to their payload account_ids; an unresolved account keeps canonical
  replay pending. Export quote status exposes a separate local lifecycle hint.
  It never marks the artifact imported, accepts costs, starts an export, or
  causes a new poll. Upload completed preserves isReady=false/null. Conflicting
  terminal export hints are exposed rather than silently called success.
- X-OFAPI-Redelivery-Of is retained in capture headers; matching original-key
  deliveries still dedupe at the original business fact.

## Controls and spend

`buildOfapiWebhookEventSet()` returns the unchanged baseline. Optional groups
are subscription_expiry, account_lifecycle, media_uploads, data_exports and
engagement. `registerOfapiWebhook` accepts an explicit optionalWebhookGroups
selection for the collection-policy apply workflow. A normal baseline recheck
preserves already-applied subscriptions. Intake of existing signed receipts
never consults a collection toggle.

No incremental HTTP calls are introduced. Enabling extra remote events incurs
the provider webhook tariff (documented on 2026-09-06 as 1 credit/100 events),
so it remains an owner action one group at a time. No historical quarantine
repair or production registration was run in this batch.

## Rollout and local recovery

1. Apply forward-only migration 0155, then deploy the code. It marks existing
   accepted account/async lifecycle rows with no projection bookkeeping as
   pending; canonicalizer v4 reuses existing message/money/auth dedup keys.
2. Keep optional groups off. Verify no new projection failures and that no-key
   signed fixtures reach typing/presence fanout and projections.
3. Apply one optional category through collection controls and independently
   read the remote webhook configuration. The collection screen owns desired
   versus applied state; code deployment alone does not apply the selection.
4. Watch capture, canonical and projection state and compare webhook spend.
   Export `completed` remains a vendor hint until an artifact is accepted.

The receiver preserves malformed signed input for a separate scoped repair.
An older authentication payload without source timestamps still has only
receipt-time evidence; the implementation does not invent the missing time.
Previously materialized legacy receive-time auth watermarks are not rewritten
from guessed historical evidence in this migration.

## Vendor contract sources and discrepancies

Checked live official docs on 2026-09-06:

- https://docs.onlyfansapi.com/webhooks/delivery-and-retries — no-key ephemeral
  events, unordered delivery, ten-second timeout and three attempts. The prior
  source comments said fifteen seconds/five attempts; those comments are fixed.
- https://docs.onlyfansapi.com/webhooks/available-events — expiry is dated by
  expiredAt; disconnected includes disconnected_at; account auth uses
  latestAuthAttempt; export events have no top-level account_id and carry the
  explicit account_ids list; export created_at is job creation, not transition
  occurrence; upload completed can carry media.isReady=false.

The pinned schema's sparse event example does not describe this complete live
catalog. Fixtures in the regression suite are documented synthetic payloads,
not claims of successful paid production canaries.

## Validation

Required focused suites: ofapi-webhook-lifecycle.integration,
ofapi-webhook.integration, ofapi-account-health.integration,
ofapi-audience-sync.integration, canonicalize-ofapi-webhook,
canonicalize-sweep.integration. Integration tests exercise raw HMAC intake,
SQL state, canonical replay and transaction rollback after journal settlement.
The integrator records final `pnpm check` and suite results in the PR.

No new business-fact table is introduced. The source journal and domain event
retention/erasure inventory remain authoritative; 0155 adds only a resource
lookup index and projection-retry bookkeeping backfill. The lifecycle summary
omits raw bodies, download URLs and reusable upload material.

A roster receipt may establish an auth time while the page auth status remains null. The first lifecycle event at that exact time is admissible; an already recorded recovery event still wins an equal-time failure. This boundary is pinned by the authenticated recovery integration test for 0 ms and 1 ms offsets.
