# Shared A0/C1/C2b observer — 13 September, 17:06 UTC wake

Only bounded read-only production/UI observations and local evidence/state
updates ran. No code, PR, deployment, flag, replay, recovery, socket, credentials
or automation change was made.

## Runtime and configuration

All three Docker roles remain healthy with zero restarts on source
`380326368fe3`, image `c443947a3569`. Their start times are unchanged.
The full revision mapping retained from prior evidence is
`380326368fe39a6a9d22eb73b0b955f8ecd7c3cc`. Disk has 18,389,212 KiB available
(17.54 GiB), 78% used. Loopback API/database health passed with a 12 ms database
probe; this is liveness, not the protected deployment gate or event latency.

Signed-in Chrome at 17:08:36–43 UTC shows A0 all six pages, C2b `lilly-1`, head
catch-up `none` and three active roles. Per-role applied flag versions and
uninterrupted historical continuity remain unknown. No clocks are reset.

The 3,000 parsed worker lines actually cover 12:02:37.446–17:07:13.321 UTC.
No warning/error matched shadow/material/persist/diagnostic. All 305 threshold
warnings include the known OFAPI v5 backlog; eight also name `sse_delivery`.
Those eight occur at 15:00–15:02 and 16:10–16:14 UTC. The following 53 threshold
checks through 17:07 report only the backlog. The log reports breached names, without the value or presence of the smoke
checkpoint gauge. This metric stores checkpoint age in both p50/p95 slots; it
is not a delivery-latency percentile. The retained smoke summaries advance
framesSeen while gapCount stays at the historical 2,781 and duplicates at zero.
Checkpoint persistence occurs only when dirty, so quiet traffic is one possible
explanation, not an established cause. No reader SLA or new loss is inferred.
These are bounded log observations, not an equal-window failure-rate comparison.

Twenty-six transaction lower-bound early-stop warnings are a previously observed
category, distinct from A0 virtual stops. Two incidental OnlyFans command
outcomes are non-confirmed and one link-stats reconciliation is incomplete.
The observer did not retry commands or perform other-platform recovery.

## Observation results

A0 retains 787 sweeps: 542 complete, 245 incomplete, none running. All prior
713 rows are unchanged. The 74 new rows include 70 complete and four incomplete
Lora-1 sweeps: two snapshot-overlap guards and two uncertified successors,
followed by complete generations 4866 and 4874. Unknown material checks remain
403,215; lost reports remain eight. Failed DM runs increased from 26 to 28,
while physical HTTP failed/retry counts did not rise. These are recurring
measurement/certification gaps, without a newly justified production action.

C1 retains 2,493 unique rows, all prior 2,289 unchanged. Of 385 valid decisions,
99 requested from clean queues and each has one exact-generation terminal.
Eleven new terminal membership receipts are valid; 47 historical gaps remain.
Source-separated follower attempts total 10,995. Identity, presence equivalence
and safe suppression remain unproven.

C2b is unchanged from the earlier 99-check baseline on each endpoint. The last
daily completion remains the excluded 10:53 transition; zero comparison sweeps
qualify. Two subsequent independent completions with continuity evidence remain
necessary. Scoped zeros do not prove correction detection or completeness.

Cumulative reports replace prior snapshots; they are not added. A0 and the
C1 page union are non-atomic. The A0 candidate remains NO-GO, with its original
17 September 22:58:33.610 UTC earliest report point. Neither A0 nor C2b has
reached bounded-report delivery. Keep the shared heartbeat and schedule active.
No new savings, event-to-reader latency or stage acceptance is claimed.

Independent [review](/Users/dmitriy/code/goose/hub/investigations/fansly-a0-deploy-2026-09-11/heartbeat-runtime-20260913T170716Z/REVIEW.md) passed with no open actionable findings.
The scheduled observer decision is DONT_NOTIFY; the direct owner status question is answered separately. No new operational action follows from these observations.
