# OFAPI webhooks: production verification, 2026-09-08

Read-only observations around 01:31–01:40 UTC (04:31–04:40 Moscow).
Production API, worker and scheduler image label: `21e0ee332740`, same image
`sha256:bc60fd50d8a527eea7d867e803743310bf6f1c43d64ffc0b4e4db390545e38ff`.
Source inspection used the matching local commit. No production changes,
local replay, remote redelivery, registration changes, or manual history scan.

## Result

Live intake and checked operational projections work. The system is not fully
healthy: delivery-history collection is stuck, and canonicalization of current
accounts is delayed behind a large historical unmapped corpus.

API/database health is OK; api/worker/scheduler/Postgres containers are healthy.
Root filesystem: 79 GiB total, 46 GiB used, 32 GiB available.

## Applied subscriptions

Authenticated production status and collection-policy GET responses, inspected
from the Settings page's normal network requests:

- Registration `stable`, global scope, endpoint
  `https://gosling-agency.ru/api/v1/ofapi/webhook`, both OF pages bound.
- 31 registered event types: 19 baseline plus 12 optional events.
- Optional groups all desired and applied: subscription_expiry,
  account_lifecycle, media_uploads, data_exports, engagement.
- Policy version 6, applyState=applied, errorCode=null,
  appliedAt=`2026-09-07T04:55:53.558Z`.
- Free history collection enabled. Stored vendor event catalog has 70 entries;
  catalog membership does not automatically enable a subscription.
- This inspection read Hub's persisted remote confirmation. It did not issue
  another provider registration/inventory request.

Baseline covers messages received/sent/deleted/PPV unlocked, tips, transactions,
new/renewed subscriptions, typing/online/offline, six account-auth transitions,
and chat queue updated/finished. Optional groups add subscription expiry,
account disconnected, two media-upload events, seven export events and post likes.

## Live data path and evidence

HMAC verification over raw bytes → durable capture and deduplication → queued
worker processing and SSE notification → independent operational projections
and message archive. Observation-to-domain-event canonicalization runs in its
own sweep; it does not gate the direct message/archive projection.

Missing vendor identities are accepted only for signed typing/presence receipts,
with a distinct local identity. Other malformed/conflicting signed bodies remain
retained for inspection. Local replay uses retained evidence and keeps the SSE
identity; remote redelivery is a separate explicit one-attempt operation.

At the final SQL snapshot, the preceding 24 hours contained 3,009 normal webhook
observations: 2,141 at canonical version 5, 733 typing receipts (intentionally
outside this canonicalizer), and 135 pending canonicalization. Five subscription
expiry observations were at version 5. The latest message receipt was
`2026-09-08T01:31:45.659Z`; worker log recorded archive storage for event 753065
at `01:31:46.308Z`, about 649 ms later. This is one example, not a latency percentile.
The Settings history sample separately showed received messages and presence
events with accepted receipts and projected operational state despite parser 0.

API logs since the current container started contained 55 incoming webhook
requests and no OFAPI/webhook warnings in the inspected log window. This is not
a complete provider-side delivery census.

## Defect 1: fractional-second window rejects the entire history page

Latest scan `ca170eee-6211-44c5-851e-8d4a3bb4d498`:

- from=`2026-09-07T23:45:27.398Z`, to=`2026-09-08T00:51:07.638Z`;
- failed, nextOffset=0, capturedAttempts=0, history_window_failed;
- repeated warning after each automatic retry, including 01:20, 01:26 and 01:32.

Retained HTTP 200 response observation 2271284 at
`2026-09-08T01:38:39.025Z` has 91 attempts. Three are timestamped
`2026-09-07T23:45:27.000000Z`, 398 ms before the requested lower bound;
none are past the upper bound. The strict `some(createdAt < from || createdAt > to)`
check at `apps/runtime/src/services/ofapi-webhook-recovery.ts:110` rejects the
whole page before attempt persistence. The raw response is preserved.

Thus the immediate cause is a mismatch in timestamp precision at the window
boundary, not HTTP failure or insufficient credits. Any fix must define provider
window precision and retain completeness/pagination guarantees; removing window
validation entirely would not establish correctness.

The same retained page has five failed provider attempts (one HTTP 502, four
connection failures). All five have a successful attempt with the same delivery
UUID in that page. These particular delivery failures recovered automatically.
This does not prove complete recovery outside this captured page/window.

## Defect 2: historical unmapped rows delay fresh canonicalization

135 current-account observations were still below version 5:
65 offline, 57 online, seven received messages, three sent messages, three new
subscriptions. Oldest=`2026-09-07T23:45:18.932Z`, almost two hours old.

Four historical account refs account for another 452,533 non-typing, version<5
webhook observations (189,357 + 118,520 + 82,190 + 62,466). The worker logs repeatedly
show scanned=4000 and skippedUnmapped=4000, with no parser errors or binding
conflicts. The scan progresses through old observation IDs while current
observations are above 2,267,000.

The driver processes at most 200 × 20 rows per family per tick and remembers its
cursor only in a module-level Map (`canonicalize-driver.ts:277`). A restart starts
that traversal again. Fresh mapped rows share the ordered scan with retained
unmapped history. The live metric warning `obs_backlog_webhook_ofapi_v5` corroborates
the backlog; occasional `sse_delivery` warnings are smoke-checkpoint staleness,
not a measured desktop message delivery latency.

Root-level remediation should let fresh mapped facts progress independently of
historical unmapped retry work and preserve traversal progress across restarts.
Historical facts must remain retained. Existing direct operational projections
explain why received messages can already be archived while canonicalization lags.

## Other evidence and limits

One `ofapi.webhook.fact_conflict` observation occurred at
`2026-09-07T11:47:02.440Z` for messages.sent on the VIP account. Its different raw
body was retained; semantic equivalence of the two bodies was not examined.

SQL used `read_only` inside read-only transactions. That role cannot read the
webhook journal/config/recovery tables directly; denied reads were not retried
under an app or superuser role. Operational metadata came from the authenticated
owner UI's ordinary GET responses; raw receipt timestamps and aggregate counts
came from the readable observations table. No claim of a globally empty intake
or projection retry queue is made from these limited samples.

Primary code: `services/ofapi-webhooks.ts`, `services/ofapi-webhook-capture.ts`,
`services/ofapi-events.ts`, `services/canonicalize/ofapi-webhook.ts`,
`services/canonicalize-driver.ts`, `services/ofapi-webhook-recovery.ts`
under `apps/runtime/src`.
