# Fansly known-head catch-up (Decision 277)

This closes the stale-follow-up defect before A0. A history coverage value of
`complete` is independent of the exact known-head debt. The reporting view
contains no message text or credentials. Its `captured` receipt confirms the
hot writer accepted that exact ID; archive/Read Plane acceptance is checked
separately. `attempts` counts completed reads that did not confirm the ID, not
physical HTTP attempts (T0 is still required).

## Controls

`fanslyDmHeadCatchupPageAllowlist` / `FANSLY_DM_HEAD_CATCHUP_PAGE_ALLOWLIST`
is live, default `none`. Use exact comma-separated page labels. Unset/blank
allows no page; the config API accepts the nonempty rollback value `none`.
The worker reloads it at each DM chunk, as does the list follow-up writer.
Migration 0172 and full list responses record missing IDs even while the
selection flag is off. They issue no additional provider requests or recovery
wakeups while it is off. A newly enabled page is picked up by its next ordinary
full list sweep; do not reset checkpoints or raise budgets.

One selected ID has at most five completed attempts, with waits of 1 minute,
5 minutes, 15 minutes and 1 hour. Each attempt walks at most five message pages
from the head, continuing past ordinary overlap. Its target, page count and
start time survive chunk/worker restarts. Existing physical-request budgets,
page leases, proxy pacing, stream pauses, HTTP Retry-After and history quota
still apply. An exhausted ID is retained as unresolved; it is neither declared
deleted nor silently acknowledged. A later exact receipt can still close it.

Exhaustion ends additional bounded head searches, not ordinary pending history
(Decision 326). On allowlisted pages, only uncaptured debt with fewer than five
attempts blocks the pending-history path. Due debt keeps head-search priority;
unexhausted debt in backoff cannot bypass its wait through ordinary history.
The list sweep may wake pending history after all head debt is exhausted while
the report continues to show the unresolved IDs. That history resumes from the
oldest stored cursor, even if the expected head is still missing. This does not fix a
provider-deleted head or change coverage into proof of exact-ID capture.
Pages off the allowlist apply the same rule once the head has been read: a
pending thread whose head is not newer than its last head read resumes history
from the oldest stored cursor instead of rereading that head. A newer head is
still read first, once.

## Separate owner gates

1. **Merge and deploy:** after independent review and green checks, request
   approval for the specific commit and migration 0172. Deploy from the clean
   stage checkout with `scripts/deploy-production.sh --mode dist-only
   root@45.8.230.111`. Use the full deployment path if its pinned-base gate
   requires it. Keep the allowlist `none`. Verify deployed image revisions,
   health and the read-only report. This deploy does not authorize activation.
2. **Small-page activation:** get an explicit yes for one page and verification
   window. Capture the previous value/version from `GET /api/v1/admin/config`.
   The owner-session `PATCH /api/v1/admin/config` accepts
   `{"patches":[{"key":"fanslyDmHeadCatchupPageAllowlist","value":"ari-1","expectedVersion":0}],"note":"Approved known-head catch-up canary"}`.
   Replace version 0 with the actual current override version; do not overwrite
   another operator's change. No owner token is sent to Fansly by this change.
3. **lilly-2 recovery:** a separate explicit yes for adding `lilly-2` to the
   allowlist. The baseline fixed cohort at 2026-09-08 11:02:47 UTC had 2,767 of
   5,615 heads still absent from captured `/message` bodies. The same raw-only
   method found 4,883 at 02:02 UTC; these are historical measurements, not a
   current estimate or an archive census. Re-measure before activation.
   Keep other page values exactly as approved. Start within existing budgets;
   no reset, new queue, raised concurrency, or ad hoc provider calls.
4. **Acceptance:** save report snapshots before/after and repeat the fixed raw
   cohort query. Inspect oldest debt, exhausted IDs, exclusion/identity reasons,
   stream blockers and request/429 logs. Verify selected recovered IDs in the
   archive/Agent transcript. Do not infer completion from a successful run or
   history coverage. A0 starts only after this and the reply-link prerequisite
   have actual acceptance evidence.

## Read the report

Run only through the production `read_only` role in a read-only transaction:

```sh
ssh root@45.8.230.111 'docker exec -i agency-hub-postgres-1 psql -X -v ON_ERROR_STOP=1 -U read_only -d agency_hub_core -At' \
  < investigations/fansly-dm-head-debt-2026-09-08/report.sql
```

The migration grants SELECT on `fansly_dm_head_debt_report` only if the
existing role exists. It creates no role and broadens no base-table grant.
The SQL produces page/state counts, age, completed failed attempts, and up to
50 oldest unresolved IDs for review. `backoff` is the head-debt deadline;
transport circuit breakers and stream pauses can defer actual eligibility.
Retain each output outside the observability tables.

## Rollback

After owner approval, remove just the affected page from the saved allowlist
(or write `none` when no page remains). Check the new config version. The next
chunk stops additional target search. If ordinary incremental continuity is
unfinished, it keeps that `before` cursor and mode; only a pin that already
reached known ground (or issued no request) is cleared. An in-flight request can finish. The previous full
list and legacy selection remain; retained raw, history, receipts and exhausted
debt are not deleted. A binary rollback to the parent also leaves migration
0172 in place. It restores the old stale-follow-up bug, so it is containment,
not acceptance of the migration.

Continuity clarification: reaching the target or the five-page search cap does
not finish an ordinary incremental catch-up that has not reached prior stored
ground. Its normal `before` cursor continues without the recovery rider until
overlap/exhaustion. The cap bounds additional target search, not delivery of a
burst's intervening messages. This preserves the pre-existing history path.
