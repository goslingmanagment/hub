# C1 observation and runtime boundary — 11 September 23:08 UTC

C1 diagnostics continue on production source `9597d9315111`. The cumulative
read contains 133 valid incremental decisions: 113 no-request, 19 count-only
requests and one newly observed count-plus-exhaustion request on Ari-1.
All 20 requested revisions have a later `exact_generation` completion.
None requested while work was already pending. Redundancy or a safe trigger
suppression has not been established; implementation remains paused under the
owner's latest diagnosis-only instruction.

## Read verification and coverage

Window: 11 September 01:05:57.089215–23:08:13.183701 UTC. The reviewed reader
returned two pages, **500 + 101 = 601 unique ordered runs**. Pagination uses
the first `throughRunId=728676`, cursor 727169, and exhausts on the second page.
SHA-256, payload count, `read_only` role and READ ONLY transaction were verified
against both raw receipts. Their `asOf` values are 23:08:37.104686 and
23:09:36.613830. Each page is repeatable; the combined timeline is not one
atomic snapshot. Only the first page supplies the cumulative aggregates.

The first report hash recorded in its manifest is
`aa602bc5c9f55ed141e32b1a299493d3374583396fd91855b1594b8e615fc1e3`;
the second report hash is
`2d2fb64f8fed65f0ce1f000608f0613c2e8ad387b896814e5f6d12a072707ded`.
No returned run is unfinished at the requested cutoff. One failed Lora-2
incremental run, 726189, still lacks a decision receipt; absence remains unknown.
No invalid or duplicate incremental decisions are reported. The failed reconcile
chunk 724951 is retained even though its revision 1519 later completed.

| countMismatch | exhaustedWithoutKnown | unchangedHeadWithRows | Decisions |
|---|---|---|---:|
| false | false | false | 113 |
| true | false | false | 19 |
| true | true | false | 1 |

`unchangedHeadWithRows` and the exhaustion predicate without a simultaneous
count mismatch remain unobserved. No `nonDestructiveClose` was observed.
There are 22 successful reconcile terminals: 20 linked to the requests and
two scheduled revisions. A terminal proof is distinct from claimed revision,
membership generation, queue state at request time and subsequent convergence.

## New evidence

- Ari-1 run **728613** has active/source **224/223**, three pages and 223 rows
  processed, with a known checkpoint that was not encountered before exhaustion.
  Both predicates are true. Queue revision 56 was fully applied; the request
  allocated revision 57. Reconcile **728617**, generation 57, completed at
  **22:53:00.634**, observed/source 223/223 and one deactivation candidate.
  The missing checkpoint's identity and whether deletion or pagination caused
  the mismatch are not established.
- Lilly-1 revision 728/generation 679 ended with zero candidates; 729/680
  ended with two. Run 727444 subsequently reports 3360/3360 without a request.
  This is compatible with the required absence grace, not evidence that the
  second walk was redundant. New revision 730/generation 681 completed in
  728472 with zero candidates; the next incremental comparison is not present.
- Lilly-2 revisions 2533/783 and 2534/784 completed in runs 727134 and 727402;
  later decisions do not request work. Provider headline counts changed between
  those walks, so an unchanged-roster repeat is not established.
- Lora-1 revision 1250/generation 1206 completed in 726897; later decisions
  repeatedly show 9473/9473 without requesting work.
- Lora-2 revision 1617/generation 1579 completed in 728621, observed/source
  8132/8132 with zero candidates. A later incremental comparison is not present.

Candidate counts are recorded before UPDATE; they are not an export of actual
deactivated identities. All 20 queue receipts were clean at request time.
The evidence therefore does not justify coalescing or suppressing these requests.

## Physical attempts and the new runtime

| Source | Stream | Attempts | Retry ordinals |
|---|---|---:|---:|
| scheduled | followers | 271 | 2 |
| anomaly | followers_reconcile | 1840 | 23 |
| scheduled | followers_reconcile | 273 | 0 |

No terminal failed HTTP attempt or HTTP 429 row appears in these retained
groups. Known loss, unfinished and boundary counters are zero for these two
streams. This describes retained telemetry, not all external traffic or savings.

The new worker started at **21:35:18.103889537 UTC**. Its cohort has 34 runs:
nine incremental, including three requests, and 25 reconcile chunks. All three
requested revisions reached exact-generation completion. All six pages appear.
Each of those 34 runs has exactly one matching current-worker HTTP summary:
20 incremental and 126 reconcile attempts, no retries or failed attempts.
These 146 attempts are part of the cumulative totals, not an additional cohort
to add. Logs from the replaced container between 17:07 and 21:35 are not recovered.

At **23:08:13 UTC**, API, worker and scheduler reported source
`9597d931511185a5c571ea2d56dcf8302aa5bb72`, image
`754d3c1296c41853e353418ee720786ff6b83a0dbd427becc34921bb07a76b13`,
healthy with zero restarts. Ordinary health passed with a 7 ms database probe;
22.34 GiB remained free. C1 code/diagnostic readers are retained in the source,
and new receipts confirm activity after the boundary. The current release's
deploy-gate result is unknown here; the preserved 66d6ac1a deploy result is exit
zero at 19:47:07. No protected sync-health call was repeated.

The source includes the same projection-age query from `2c6b42b7` whose P2 was
independently reproduced earlier: the first unconsumed sequence timestamp can
understate the oldest unconsumed event's age. The five-minute versus 31 ms
counterexample is local synthetic evidence, not a measured production incident.
`source-receipt.json` ties the observed label to identical local Git source;
it does not establish whether a live alarm was missed. The defect remains
recorded, without a fix in this diagnosis-only task.

## A0 and next boundary

[A0](../../fansly-a0-deploy-2026-09-11/OBSERVATION-20260911T230813Z.md) now has
43 complete and 234 incomplete sweeps. The new-worker cohort is 16 complete
and four incomplete, with 100 unknown material checks. One completed Lilly-1
sweep contains a state change below the proposed stop. The larger material
query timeout and other runtime changes prevent attributing coverage improvement
to any single change. Provider-event freshness and physical savings are unmeasured.

Continue read-only observation to the existing seven-day point. No product
code, PR, flag, migration, deployment, recovery, replay or socket was changed
by this follow-up. No tests were rerun for observation-only files. The heartbeat
scope was updated to retain the owner's latest diagnosis-only instruction;
its schedule and seven-day gate are unchanged.

Raw manifests, per-page `asOf`, `summary.json`, `worker-log-summary.json` and
source receipts accompany this report. Independent review is recorded in
`REVIEW.md`. No C1 suppression fix or migration acceptance is declared.
