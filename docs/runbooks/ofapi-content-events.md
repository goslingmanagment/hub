# OFAPI content-event evidence (S11a)

Decision 271, migration 0166. The stored queue report and post-like evidence are
read-only consumers. They never enqueue a send, redelivery, detail read or counter
refresh. The canonicalizer consumes the raw webhook observation, then the existing
projection tick updates heads from domain events. Capture remains first.

`posts.liked` is emitted as projection-only `ofapi.post_like_observed`. The nested
`user.id` is the actor; the top-level `user_id` is never used as a fan. `payload.id`
is a notification ID. A post is attributed only from one explicit `{POST_LINK}`
anchor whose HTTPS host is exactly `onlyfans.com` and whose path has a numeric post
ID. Unsafe numeric IDs, missing actor and missing source time remain replayable
parse debt. Missing or ambiguous post links retain unattributed canonical evidence;
they never assign a notification ID as a post ID. The existing engagement
projection materializes attributable facts into `post_likes`. It still derives no
like from any Fansly code. No unlike event has been verified, so evidence is the
latest observed like, not a complete current roster of likers.

`chat_queue.updated/finished` become projection-only `ofapi.chat_queue_observed`.
The `ofapi_content_events` projector stores a head in `ofapi_chat_queue_state`,
retaining exact queue ID, original queue date, flags, pending/total, receipt time
and event/observation lineage. Finished cannot regress to updated. Other progress
ordering uses receipt time and explicitly reports that limitation. Pending and total
remain separate vendor values; no delivered count, money, recipient ID or command
confirmation is inferred. A queue is independent of individual-message custody.

The webhook family advances to version 5. The existing bounded sweep revisits raw
history, dedupes existing business facts, and discovers these new event kinds.
Hidden events receive atomic stream checkpoints, so historical content evidence
cannot masquerade as new chat activity. No provider egress occurs during replay.
Both canonical append and projection writes serialize with the erasure fence.
Material time is the earlier source/queue date and receipt, so recollecting old
source data after erasure cannot resurrect it. Fan erasure removes liker facts,
keeps bystanders/queues, and allows genuinely new activity. Page/model erasure also
removes the queue heads. Rebuilds reset only reconstructible heads and watermarks,
with the registry's detached-partition preflight.

## Owner use and rollout

The Collection screen has **Queue and post likes · retained events** with a page
selector. It reads at most 50 heads of each type from Hub; refresh is local. The
SDK operation `ofapiContentEventsGet` calls
`GET /api/v1/admin/ofapi/content/events?pageId=…&limit=50` and requires an owner
session. It returns source, source/receipt times, partial-list flags, lineage and
unattributed count. Coverage is always `observed_events_only`, including an empty
result. The report never claims a full history or a delivered recipient count.

1. Deploy compatible migrations and code through the normal reviewed release.
   No collector or event group is enabled by this change.
2. Queue events already belong to the baseline registration. The local replay
   projects their retained history without changing registration or spending.
3. To receive new post likes, the owner selects only **Post likes** (`engagement`)
   in the webhook controls, saves the choice, and applies that one group. Check
   registration readback and observe its credit delta before another enablement.
4. Repair retained heads with `projection:rebuild ofapi_content_events` for queues
   or `projection:rebuild fansly_engagement` for engagement, using the normal
   scoped rebuild CLI. A detached partition blocks an incomplete rebuild.

No paid probe, provider mutation, live enablement or deployment was performed in
this batch. The new collector spend is zero; optional new webhook delivery volume
is owner-controlled. The existing webhook group and accounting policies apply.

## Vendor discrepancies and validation

Live [event documentation](https://docs.onlyfansapi.com/webhooks/available-events)
was checked on 2026-09-06. It gives post identity through the post-link placeholder,
not `payload.id`. Queue `date` is not documented as a progress clock. The finished
example has both `isDone=true` and `isCanceled=true`; its prose cannot justify
counting all recipients as delivered. These distinctions supersede the prior
capture-only registry rationale and incomplete pinned schema assumptions.

Focused regressions cover raw capture, exact actor/post IDs, malformed/ambiguous
links, duplicate receipts, terminal precedence, no send or fetch, projection-only
checkpoints, full local rebuild, owner authorization/report response, populated
page and fan erasure, old-source replay fences and new post-erasure activity.
The dashboard rendering test preserves the incomplete/cancelled labels.

Validated locally: focused 93/93 across 10 files; full `pnpm check` passed
2,813 tests with 9 pre-existing skips, typecheck/lint/dashboard build green.
