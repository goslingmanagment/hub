# W0 live preflight — 14 September 2026

**The six-hour Lilly-1 experiment has not been started.** The official browser
control API works, but its current attempt reports a locked Mac. Page/session
provenance, the page proxy and same-generation REST binding remain unverified.

## Verified now

| Read | Result |
| --- | --- |
| Official Computer Use, 18:42:13 UTC | `@oai/sky.get_app_state` reports a locked Mac; automatic unlock failed. |
| Production metadata, 18:45:56 UTC | API, worker and scheduler healthy, zero restarts; source `ac92197ba976`. |
| Immutable runtime image | `sha256:ca60d6371efa39d256c929eec025f05d78edf97dba21076b82f58b1f5f8cc01d`. |
| Host admission | No W0 container present; Python 3.12.3, existing `agency-hub_default` network. |
| Disk | 17,301,684 KiB available on the runtime filesystem; 79% used. |
| Prepared source | Reviewed continuity bundle hash verified; all five launcher modules pinned in `source-pins.json`. |

The public Computer Use contract was recovered from this task's earlier
successful SKILL.md read. No private implementation or browser profile was read.
This resolves the earlier missing-contract diagnosis. It does not resolve the
fresh, directly observed screen lock. See `browser-access.json` for the attempt
times and provenance; `host.stdout` retains the separately timed host read.

## Why the long run remains pending

Independent review distinguishes two claims. The continuity process and the
browser observers need not start together. That separation does not waive the
live prerequisites for the selected session. The current protocol runbook
requires REST binding for the same credential generation before a new probe and
keeps sustained use gated by the required evidence and agreed scope. D334
prepares the runner; it does not establish binding, fan-out or presence.

An initial review recommendation to launch the long run immediately was too
broad and was withdrawn before any provider action. The final launch review is
retained in `REVIEW.md`. Existing deployment authorization remains in force;
these evidence requirements have not been replaced by a deployment approval.

The next action is to unlock the Mac, then inspect the existing Lilly-1 browser
session and route and establish the same-generation binding through the
authorized REST path. Paired delivery requires a real overlapping browser and
receiver observation. A separate viewing account is needed for fan-visible
presence; Lilly-1 remains the creator-side page. A later browser observation
cannot be paired retrospectively with an earlier receiver interval.

During a future approved run, independent observations must detect browser
delivery loss or REST restrictions; the launcher does not check either. Before
each receiver gap, retain a confirmed boundary for the selected objects and
subsequent ordinary REST/reader receipts. Its generation checks and cleanup
receipts do not prove those conditions or recovery.

No live socket, browser navigation, test message, credential change, flag flip,
deployment or recovery dispatch was performed during this preflight. There is
no new continuity, gap recovery, savings, latency or W0/B0 acceptance result.
The source and existing production behavior are unchanged.
