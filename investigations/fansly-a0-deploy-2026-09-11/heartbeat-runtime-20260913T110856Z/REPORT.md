# Shared A0/C1/C2b observer — 13 September, 11:07 UTC wake

This wake performed bounded read-only production/UI observations and local
state updates. No implementation, deployment, flag change, replay, recovery,
socket, credential, PR or automation change occurred.

## Runtime and configuration

At 11:08:58.315943 UTC, all three Docker roles were healthy with zero restarts
on source `380326368fe3`, image `c443947a3569`. The retained full source is
`380326368fe39a6a9d22eb73b0b955f8ecd7c3cc`. Disk had 18,388,384 KiB available
(17.54 GiB), 78% used. Loopback health passed with a 1 ms database probe;
this proves liveness, not delivery latency or the current deployment gate.

The signed-in Chrome UI at 11:12:06.504–.915 UTC showed A0 all six pages,
C2b `lilly-1`, head catch-up `none`, and three active roles. It did not expose
per-role flag application/version; historical continuity remains unknown.

The 3,000-line worker tail actually spans 07:15:46.519–11:08:40.904 UTC.
No warning/error matched shadow/material/persist/diagnostic. All 233 threshold
warnings name the known OFAPI v5 observation backlog. The preceding bounded
tail also had 233 such warnings and 20 transaction-boundary early stops;
these are not equal-window rates. The 20 current transaction early stops
are not A0 virtual-stop activation.

Two incidental OnlyFans command outcomes are indeterminate and one capture
body read timed out. They remain outside the Fansly observation scope, with
no causal attribution. The observer did not retry either command. Other platform capture failures
were already present previously. No new Fansly diagnostic failure was found.

## Observation results

A0 retained 713 sweeps: 472 complete, 241 incomplete, none running. All 72 new
sweeps completed, 12 per page; all 641 prior rows are unchanged. One more known
flags discrepancy was retained. Historical material/reason gaps, eight lost
DM reports, 26 failed DM runs and one unknown DM run remain. The early-stop
NO-GO and earliest report time, 17 September 22:58:33.610 UTC, are unchanged.

C1 retained 2,289 unique runs, with all 1,833 prior rows unchanged. Of 349
valid decisions, 89 requested from a clean queue and each has one exact terminal.
All 22 new terminals have membership receipts; 47 historical gaps remain.
Presence equivalence and safe suppression are unproven. Its paginated snapshots
are not atomic, and repeated aggregates are not added together.

C2b now has 99 baseline checks/receipts on each of two endpoints. The first
post-activation daily completion, 10:53:03.993 UTC, is excluded as transitional
because full-sweep start is unavailable. Zero comparison sweeps qualify;
two subsequent independent completions and continuity evidence are needed.
The baseline does not establish correction detection, freshness or savings.

Neither bounded observation has reached its delivery condition. Keep the
shared heartbeat active with its original schedule. No stage gate changes.
The earlier interactive HTTP comparison remains separate from this observer;
its recorded +21.46% traffic change is not causal migration savings.
Event-to-reader latency still lacks the required implemented event path.

Independent review in REVIEW.md passed with no open findings. These observations
require no new owner action or completed-report notification: DONT_NOTIFY.
