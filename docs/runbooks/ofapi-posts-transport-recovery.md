# OFAPI posts transport recovery

Decision #259 repairs Hub-to-OFAPI routing. It does not resume parked jobs or
change credit limits. Use the authenticated owner operator API; never reset
attempt counters or alter checkpoints in SQL.

## Preconditions

- The deployed runtime includes #259. Capture and gateway resolve `vendor:ofapi`;
  Fansly and Anthropic retain their existing routes. No page-proxy deletion is
  needed to fix OFAPI, and deleting it could break a different consumer.
- Confirm current page/account binding and generation, enabled capture gate,
  fresh storage health and enough OFAPI balance for the effective floor plus
  unsettled reservations and the canary. Ordinary daily/scope limits still apply.
  A `credit_floor` denial is local admission, not evidence the network fix failed.
- Freeze the exact job ID, page ID, blocked reason and row version from owner
  capture status. Inspect its checkpoint/head anchor and pending observation.
  Existing cancel rejects a lease or reserved/dispatching attempts. If capture
  evidence remains pending, reconcile it first instead of discarding its owner.

The incident investigated on 2026-09-06 concerns only:

| Page | Parked job |
|---|---|
| lora-of (8) | d491cafb-da55-48c2-b118-012ae1e1c18d |
| lora-vip-of (9) | 402d8f84-f063-48c8-b4ac-354ebdae33ff |

These are historical evidence references, not permission to cancel whatever is
currently active. Re-read state before action. Both were blocked after five
`transport/post_dispatch` attempts with no accepted pages. The provider control
balance was 480 while the effective floor was 500: top-up is separate from code
rollout; do not lower the floor to make the canary run.

## One page at a time

1. Submit the owner-session `POST /api/v1/admin/ofapi/capture/jobs/:jobId/cancel`
   with `expectedState`, `expectedReasonCode`, `expectedJobRowVersion`, a reason,
   and `dryRun: true`. This records an audited dry run but dispatches no OFAPI
   request. Verify it says `would_cancel` for the frozen job.
2. Repeat with `dryRun: false` and the same CAS. A conflict means re-read; do not
   substitute a different job or force a reset. The cancelled row and its
   attempts remain and its slot becomes available.
3. Explicitly request only that page's `posts` scope using the existing owner
   sync trigger. It clears that stream's manual-action block under #249 and
   records the request and resumes that page's posts stream. This is an explicit
   resume action: do not call it when an owner pause must remain. Re-read the
   page's posts state immediately before triggering; this API does not provide
   a CAS fence against a concurrent Pause. Other streams are outside its scope.
   The new job retains the previous head anchor. If the
   anchor was null, the first full backfill starts under the bulk budget.
4. Verify a new `ofapi.posts_page.v1` observation and a `response_captured`
   attempt, its credit settlement and `egress_key=vendor:ofapi`. Parsing must
   accept the page and advance the offset with actual raw count minus overlap,
   or produce a valid terminal fact. A 200 status alone is insufficient.
5. For terminal jobs compare `accepted_pages`/`accepted_items` with
   `result.pages`, `result.acceptedCount` and the terminal fact. Completion now
   includes the final accepted page atomically with its terminal proof; an empty
   accepted response counts as one page and zero items. Jobs completed before
   this fix still omit their final page from the counters: their retained result
   and terminal fact remain authoritative, and must not be rewritten or recaptured
   merely to repair a display. Partial/blocked jobs keep counters at the last
   committed cursor so replay can consume the pending page once; assess their
   latest response using the attempt counts and observation chain.
6. After the first page demonstrates durable capture and correct pacing/billing,
   repeat for the second page. Continue until each job is complete and its posts
   checkpoint and `page_sync_states.succeeded_at` advance. An initial successful
   page is a canary, not completion of the entire walk.

## If it still fails

Logs and the parked job reason distinguish `connect`, `timeout`, and other
transport failures. Ledger details additionally identify before-headers versus
body-reading stage and bounded timing/byte counts. They contain no proxy auth or
raw response payload. The phase remains `post_dispatch` even for a connect
classification: this information alone does not authorize refunds or send
retries.

Stop repeated recovery if the route still fails. Keep the five-attempt bound;
use the new evidence to repair the cause. A body cap or timeout change needs its
own evidence and must respect request deadlines, job lease TTL and the remaining
page/call allowance. Never silently fall back to another route or replay sends.

A slow request can outlast the safe-read retry delay. Retry deadlines must be
derived when the transport or capture-commit failure is recorded, using the same
clock sample as that transition. A deadline captured before HTTP can already be
in the past when a 65-second body timeout occurs, causing the repository to
reject the transition and leave recovery to lease expiry. Preserve the strict
future-deadline check and fix the caller's clock; do not relax the invariant or
extend request timeouts to hide it.

If persisting the indeterminate transition itself fails, the worker logs
`OFAPI capture settlement failed; awaiting lease recovery` with job/attempt IDs
and the error class only. It does not repeat settlement or dispatch in that
chunk. The existing planner recovers the expired lease after the database is
available; verify the job reaches bounded retry or its existing terminal bound.
