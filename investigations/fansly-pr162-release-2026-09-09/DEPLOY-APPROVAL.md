# PR162 release gate

Owner approved PR162 deployment to all Hub production roles: «Да деплой на все».
Dispatched at 2026-09-09T18:27:49.639388+00:00. This is separate from the completed PR161
deployment and the exhausted one-use plan probe. No flag flips are included.

PR: https://github.com/goslingmanagment/core/pull/162
Reviewed implementation: 708585d249f5d9cd31e875e6bab28026925287b7
Independently confirmed final PR head: 641d7a4fba1f439062ab5ca05b35bdb86ea5ca27
Worktree: /Users/dmitriy/.codex/worktrees/hub-agent-transcript-tombstone

No outstanding review findings. pnpm check, 122 Docker-Postgres tests without
skips, and production build passed. Reviewer independently reran five focused
Postgres tests. All five final-head CI checks passed in run 34386000613. PR162 merged at
2026-09-09T18:09:54Z as 8b25d57e5d1343271177426ee9caf644cb1ee5c0. The clean worktree
is pinned to that exact merged revision; its tree equals the independently
reviewed final tree. pnpm build:production also passed on the merged revision.
This is the concrete deployment target.

Read-only preflight at 18:21 UTC: all three roles remain healthy on PR161's
image, zero restarts, 29 GiB free; /api/v1/health passed. The authenticated
Configuration UI shows catch-up `none` with Save disabled and all roles active.
No configuration version is exposed in that UI snapshot. No flag was edited.

After the concrete reviewed merge revision receives a deployment yes, run:

```sh
scripts/deploy-production.sh --mode dist-only --no-image-gc root@45.8.230.111
```

No dependency, schema, migration, flag, contract, timeout or runtime privilege
change. The existing dist-only compatibility gate must pass. Retain the normal
API/worker/scheduler, protected sync-health and dashboard gates plus automatic
rollback. The earlier sync-health latency remains open; do not bypass that gate.
The rollback target is the currently deployed PR161 image/release
34d897779fd004336e114333501f284f1faeefc1. Keep head catch-up `none` and record its
actual current override/version before any separately approved activation. No
flag flip or socket probe is part of this deployment.

After all gates pass, verify production image/roles, health, disk and the rebuilt
production-pinned Hub CLI revision/capabilities. Then use the prepared exact pass
at ../fansly-five-page-reply-replay-2026-09-08/evidence/lora-1/after-tombstone-fix/.
Its original 143 IDs are unchanged; 140 retain their old successful read timestamps,
and the three pending messages remain in conversation 790634843078664193:

- 953135194070597632 at 2026-09-07T00:04:58Z
- 953381558998294528 at 2026-09-07T16:23:56Z
- 953448940269740033 at 2026-09-07T20:51:41Z

One read at a time, 2 ms windows, stop on the first failure. Rerun full retained
material validation and the exact original cohort acceptance gate; source v6
stamps alone are not serving acceptance. No repeat lora-1 replay.

After lora-1 passes, the owner's existing sequential Lilly reply permission
persists: lilly-2/account 5, then lilly-1/account 4; dm_messages/parser6/received
[2026-09-07T01:45:00Z,2026-09-08T01:45:00Z). At the 17:53:55 read-only preflight,
the complete original 826/1695 observations still were v5 and all bodies existed.
Refresh again immediately before each approved preview/write. Retain all 409/316
original target IDs and verify parent/root, normalized text and media/raw refs
before moving to the next page. Standard runtime bootstrap includes OFAPI
credential preflight GET /whoami and proof persistence; scoped Fansly repair uses
retained bodies and does not authorize provider history refetch.

Finish six original diagnostic ID and ari rereads, the full 994 positive target
and 27 attachment cohorts, and freshness/known-head acceptance. Do not declare
A0 ready until those prerequisites have actual evidence. No lilly-2 known-head
recovery, other page activation, A0/A1 flip or B2 is included in this approval.
Physical HTTP savings and fresh-event latency percentiles remain unmeasured.

The independent fixed-cohort audit now confirms retained raw capture of all
5615 original lilly-2 heads, with cutoff 9 September 18:09:10.055267 UTC. Across
all pages 7422/7427 heads are captured. Four missing lilly-1 heads are pending
unexcluded debt with zero attempts; the lora-1 gap has an aggregation-partner
exclusion. This is not serving acceptance, recovery attribution, or a provider
deletion classification. These results do not close pre-A0 or authorize recovery.
