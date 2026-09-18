# C1 observation — 13 September 2026, 00:16 UTC

The cumulative window is 11 September 01:05:57.089215 through
13 September 00:16:17.255893 UTC. Four successful pages contain
**500 + 500 + 500 + 210 = 1,710 ordered, unique runs**, with pinned upper
run ID 737989 and exhausted final pagination. Each page has its own atomic
read-only snapshot; the complete timeline is not atomic.

Page `asOf` values are 00:16:19.680592, 00:16:28.062682,
00:18:29.051537 and 00:18:36.908265 UTC. The initial third page failed
because the `read_only` connection limit was reached. Its partial output and
failure remain in `page-3`; `page-3-retry` successfully reused cursor 731728
and the same upper ID/window. No failed page is counted as empty or complete.

There are 321 incremental and 1,389 reconcile runs. The **283 valid decisions**
comprise 218 no-request, 61 count-mismatch-only and 4 count-mismatch plus
exhausted-without-known decisions. The other 38 incremental runs have no
decision receipt: 37 partial chunks and one failed run. They are not no-request
decisions, and partial chunks are not terminal failures.

All **65 requested revisions** have a valid clean prior queue and exactly one
later successful exact-generation terminal on the same page/revision.
There are 47 historical terminals without membership receipts, including the
three known writer-gap runs 733622, 733859 and 734003; no new terminal is missing
that receipt. A terminal's membership proof and actual UPDATE receipt are
different evidence. These aggregates do not identify retired rows across
generations, prove immediate active-after counts or justify trigger suppression.

Compared with the preceding 18:37 cumulative snapshot, 314 runs are new and
the 1,396 earlier rows are unchanged. Retained physical follower attempts total
7,429, including 26 retry ordinals, zero failed/429 attempts and 459 unknown
byte counts. The first-page coverage has 1,710 runs and zero unknown, boundary,
unfinished or unrecorded attempts. Aggregates are taken only from the first
page; snapshots, later pages and separate log receipts are not summed.

All four report hashes match their manifests, the read receipts confirm
`read_only` / read-only `on`, and the page cursor chain is continuous.
[timeline-pages.json](timeline-pages.json) retains every manifest/hash and
[summary.json](summary.json) retains the request-to-terminal pairs.

The shared [runtime receipt](../../fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260913T001518Z/runtime.json)
at 00:15:20.877342 UTC records source label `380326368fe3`, all three healthy
roles and zero restarts. This metadata does not certify a new deployment gate
or continuous flag application. C1 policy, presence equivalence, A0 acceptance,
physical savings and fresh-event latency remain open. This update changes only
local operational documents; original evidence and previous failures remain.
