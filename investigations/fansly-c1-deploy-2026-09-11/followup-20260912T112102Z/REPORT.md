# C1 observation and implementation resumed — 12 September 11:21 UTC

The owner resumed implementation and authorized all deployments. The C1 policy
still requires a demonstrated cause; neither repeated walks nor clean queues
establish redundant work. Work in this collection was read-only.

The three verified timeline pages contain 500 + 500 + 98 = **1098 unique runs**.
All 979 previous rows are unchanged; 119 are new. Each page's hash, role and
READ ONLY receipt was verified. The pinned upper ID and separate asOf timestamps
are retained in timeline-pages.json and summary.json. Pagination is exhausted;
these cumulative snapshots replace earlier snapshots and are not additive.

There are **206 valid decisions**: 165 no request, 38 count-only and three
count-plus-exhaustion. All **41 requested revisions** have clean atomic queue
receipts and later exact-generation completion. The 21 partial chunks without a
final decision and one old failed decision remain separate; no new branch or
safe suppression is established.

Lora-3 after revision 1523 reports 7561/7561 at 06:00, then 7562/7562 through 11:00,
without another request. Lora-2 revisions 1621/1622 show zero then one pre-UPDATE
candidate across generations 1583/1584. Lilly-1 revision 735/gen 686 completed with
zero candidates; its next incremental comparison remains pending. These chains
are compatible with existing absence protection; actual retired rows and the
protection applied to individual rows are absent from the old receipts.

Cumulative physical attempts: 525 scheduled followers, 3752 anomaly reconcile,
351 scheduled reconcile. Retry ordinals are 2/23/0 respectively; terminal failed
and HTTP429 attempt counts are zero. They are retained counters, not a saving.

Runtime changed outside this task: 424f2a4248b6 was healthy on all roles at 11:21;
02ff7e34239e was healthy on all roles at 11:24, worker start 11:22:49.027501853Z.
The ordinary-health 10ms DB probe and 21.69GiB free belong to the earlier 424f
observation. The log read for a window ending 11:21 returned no bytes because the
worker container was replaced again before that read. Logs for this interval are
uncovered; zero output does not prove absence of errors. No deploy gate for
these external releases was inspected here.

An independent C1 review verified the new timeline and found no justified
suppression. The next implementation adds disjoint protection counts and the
actual UPDATE count to the existing terminal diagnostics. The new diagnostic
slice must pass both independent reviews and required checks before release.

C2b preflight separately confirmed read_only EXECUTE permission and read its
Lilly-1 aggregate at 11:37:47 UTC: empty endpoints/outcomes, tracked_scope_complete
false, last daily spender sweep 10:53:28 UTC. This proves no tracked coverage in
that report, not the flag's value. Browser configuration read was unavailable;
no flag was changed. See c2b-preflight/ and C2B-PREFLIGHT-REVIEW.md.

Physical savings and fresh-event latency remain unmeasured. A0's original
seven-day point remains 17 September 22:58:33.610 UTC; the calendar does not pass
its completeness or freshness gate.
