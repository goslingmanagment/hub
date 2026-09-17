# Shared A0/C1/C2b observer — 13 September, 23:07 UTC wake

Only bounded read-only production/UI observations and local operational
state/evidence updates ran. No code, PR, deploy, flag, recovery, replay,
credential or socket action was performed by this heartbeat.

## Runtime and configuration

At 23:09:47 UTC all three roles remained healthy with zero restarts on source
`380326368fe3`, image `c443947a3569`; their start times are unchanged.
Disk has 18,746,272 KiB available (17.88 GiB), 77% used. Loopback API/database
health passed; the database probe reported 0 ms at its measurement resolution.
This proves current liveness, not the protected deployment gate or event latency.
The final gate receipt for the current external release remains unavailable;
C1's historical owned-release pass is not reused as that proof.

The signed-in Chrome UI at 23:10:46–47 UTC shows A0 on the original six pages,
C2b on `lilly-1`, and head catch-up `none`. All three roles show active at
23:11:45 UTC. Effective per-role versions/application and uninterrupted flag
continuity remain unknown. The original observation clocks are unchanged.

The 3,000 retained parsed worker lines cover 18:47:23.040–23:09:15.706 UTC.
There are zero numeric error-level entries and no matching diagnostic-sink
warning, but six failed Lilly-2 DM run summaries at 20:47–21:07 UTC. Those
summaries have zero terminal failed HTTP attempts; sync status and HTTP outcome
are distinct. The interval must not be described as error-free.

All 262 threshold warnings include the known OFAPI backlog; three additionally
name `sse_delivery` at 19:04, 19:05 and 21:59 UTC. These recurring metric-name
warnings provide no gauge value or delivery-latency percentile. Twenty-three
transaction early-stop warnings are distinct from A0 virtual-stop diagnostics.
Tail-limited logs do not establish complete failure coverage or a new loss cause.

## Observation results

A0: 865 cumulative sweeps, 613 complete and 252 incomplete, none running.
All prior 787 rows are unchanged. The 78 new rows include 71 complete and seven
Lilly-2 incomplete: six overlap guards and one uncertified successor, followed
by complete generations. Missing-hot-head occurrences in successive complete
Lilly-2 sweeps rose from 2 to 57, 146 and 146, then fell to 3. These repeated
occurrences do not identify unique missing messages or establish reader loss.
Unknown material checks remain 403,215; lost-report runs remain eight.
Four additional flags occurrences and one exclusion-reason occurrence do not
establish provider deletion or a new cause. Full polling remains in place.

C1: 2,604 ordered unique rows across six separately consistent pages, with all
2,493 earlier rows unchanged. The 421 valid decisions comprise 316 no-request
and 105 clean-queue requests; every request has one later exact-generation
terminal. The new 36 decisions include 30 no-request and six mismatch requests.
The six new valid terminal receipts include four retirement and two grace-only
occurrences. Historical membership/decision gaps remain; no safe suppression or
presence-equivalence gate is established. Source-separated attempts are 11,441,
not savings. Page aggregates and cumulative snapshots are not added together.

C2b at 23:11:20 UTC: unchanged 99 valid checks and receipts on each endpoint,
within incomplete tracked scope. The 10:53:03.993 daily completion remains the
excluded transition; zero of two subsequent qualifying sweeps are available.
Scoped zeros do not prove quiet-correction detection or missing-roster coverage.

## Disposition

A0 remains NO-GO with the earliest seven-day report at
17 September 22:58:33.610 UTC. Neither A0 nor C2b has reached bounded-report
delivery. The transient enlarged Lilly-2 discrepancy cluster is retained for
natural follow-up; later complete sweeps and the reduced latest count provide
no new justified production action. No polling or recovery change follows.
No new savings, event-to-reader latency or stage acceptance is claimed.
Keep the shared heartbeat and its schedule active. Routine status is DONT_NOTIFY.

Independent evidence review is recorded in REVIEW-RUNTIME.md, REVIEW-A0.md,
REVIEW-C1.md and REVIEW-C2B.md; completion-manifest.json pins the final packet.
