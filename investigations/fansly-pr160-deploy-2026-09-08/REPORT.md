# PR160 deployment and pre-A0 acceptance

Subsequent status, 19:08 UTC: the separately approved ari-1 replay has completed and all nine target replies passed archive acceptance. See the [current operation report and stage table](../fansly-ari-reply-replay-2026-09-08/REPORT.md). The deployment observations below retain their original timestamps; statements about manual replay not yet running describe that earlier deployment window.

Deployment succeeded; pre-A0 acceptance remains open. The owner explicitly approved deployment of 18649bd95f3bedb812847343d27fdeedf8b5d32f with the normal v6 replay and head catch-up `none`. No recovery activation, manual replay, socket probe, A1 or B2 is included.

The clean worktree /Users/dmitriy/.codex/worktrees/hub-sync-health-query is pinned to the merged commit. Its tree equals independently reviewed 536f93c4f5704c361fbf69fc4e290f5d45a405b2. PR https://github.com/goslingmanagment/core/pull/160 has five passing CI checks; local pnpm check (3110 passed / 9 existing skips), 15 Docker-Postgres tests without skips and production build passed. Decision 280 is included; there is no new migration or flag.

The standard command started at 17:37:02 UTC on 2026-09-08: `scripts/deploy-production.sh --mode dist-only --no-image-gc root@45.8.230.111`. Run ID 20260908T173702Z-80478. The dependency checksum matched the pinned clean full base. The normal sync-health gate and automatic rollback remain in effect.

## Preflight

At 17:35:36 UTC, all roles were healthy on b47f552abb97 with zero restarts and 31 GiB free. Loopback health was OK, DB probe 2 ms. The authenticated Configuration UI at approximately 17:36 UTC showed catch-up running/editor `none`, Save disabled, all roles active. No flags were changed.

Read-only SQL at 17:35:55 UTC found 2140 parse-zero sync-pull observations (738 DM, 74 earnings, 664 monthly, 664 stats) and 288946 v5 observations. Oldest zero DM receipt was 13:02:37.934 UTC, about 273 minutes old. At 17:37:59, a frozen exact-ID cohort with receipt before the baseline timestamp still contained the same 2140 zero observations. IDs and kind metadata only are retained in evidence/frozen-unparsed.txt; source bodies are not copied.

## Deployment result

The standard script exited 0 and reported deployment verified successfully, including role health, same-origin dashboard delivery, sync health and rebuilding the production-pinned Hub CLI. API/scheduler started at 17:47:35 UTC; worker at 17:47:55.782. At 17:52:05 all three roles were healthy on image revision 18649bd95f3b with zero restarts; free disk was 30 GiB and loopback health was OK (DB probe 1 ms). The CLI source revision is the full approved merge; `hub capabilities` returned ok. No rollback occurred and no gate was changed.

The first protected sync-health request (`req-8`) started at 17:48:44.967 and completed at 17:51:09.999 with HTTP 200 and responseTime 145031.326 ms. It passed the ordinary 150-second gate with little margin. This is one successful request, not proof that the production latency issue is fully resolved or that PR160 explains the entire prior timeout. A single follow-up loopback read started at 18:07:04.982 and timed out at 18:09:35.130 after 150.147 seconds (curl exit 28, no HTTP response). It was not retried. The API logged incoming request req-53. The latency issue therefore remains open after deploy; a passed gate must not be reported as its resolution. This follow-up read is separate from the successful deployment transaction and did not trigger a new rollback. Evidence: `sync-health-warm.json`, `api-warm-read.log`. Evidence: `evidence/deploy.log`, `api-gate.log`, `runtime-verified.txt`, `capabilities-after.json`.

Authenticated Configuration UI at approximately 17:56 UTC showed running/editor catch-up `none`, Save disabled and all roles active. No flag edit was performed. The earlier canary heartbeat stays paused. Evidence: `evidence/flag-after.txt`.

## Replay and fresh capture

The exact frozen cohort is independent of new arrivals. At 17:56:24, 400/2140 initial zero observations were v6: 121 DM, 6 earnings, 136 monthly and 137 stats. The same cohort was unchanged at 17:58:05. At 18:03:24, it had advanced to 647/2140 (132 DM, 7 earnings, 254 monthly, 254 stats); at 18:12:01, 1000/2140 (236 DM, 10 earnings, 377 monthly, 377 stats). Every read used `read_only`, a read-only transaction and a statement timeout; every saved transaction completed.

Full-lane snapshots include new arrivals and must not be substituted for the frozen cohort. At 17:56:43 there were 676 zero DM observations and 43581 historical v5 DM observations; at 18:01:00 these were 678 and 43468. Historical earnings v5 also fell from 14981 to 14978 in that interval. Both samples are after this worker started, so historical progress is observed on this deployment. At 18:14:17 after the second completed sweep, zero DM count was 551 and v5 DM count 43271; v5 earnings was 14975. Thus history decreased another 200 observations after the first-sweep snapshot while frozen fresh capture progressed. The full five-kind totals were 1196 zero and 288063 v5. The oldest zero DM receipt was 13:50:52.383 UTC, about 263 minutes old: substantial freshness debt remains.

The first completed canonicalizer sweep was logged at 17:59:22.985: duration 672721 ms, 4600 scanned, 600 stamped, 4329 appended, 7438 deduped, 4000 skipped-unmapped, zero errored/unparseable/unavailable/partition-blocked. It exceeded its 600000 ms budget and named seven families to rotate to the next run. These are whole-sweep counts, not all Fansly DM or physical HTTP requests. `maxLagSeconds` includes historical replay and is not a fresh-message latency metric. The second consecutive sweep completed at 18:12:08.998: duration 733831 ms, 4814 scanned, 814 stamped, 4046 appended, 7190 deduped, 4000 skipped-unmapped; zero errored/unparseable/unavailable/partition-blocked, budget truncated with no remaining skipped families. Both sweeps completed, but neither met the configured 600-second budget. Evidence: `worker-second-complete.log`.

Projection ticks remain slow: one ended at 17:57:29 with 558934 ms total (message archive 490169 ms); another at 18:01:35 took 221749 ms (archive 198115 ms). These are individual durations, not a percentile. An instantaneous resource sample showed worker 111.46% CPU and Postgres 81.11%; it is not a utilization average. Disk changed across image deployment as well as replay, so its delta cannot be attributed to event growth. Evidence: `worker-sweep-three.log`, `worker-next-pass-middle.log`, `resource-sample.txt`, the frozen-progress and parse-lanes snapshots.

## Known heads

At 17:57:08 the exact recovered ari message 953354621215076352 / conversation 953353803074117634 was returned through production Hub transcript from `message_archive`, with materialObservedAt 12:36:33.695 UTC. This proves that particular captured target reached archive serving. Its first capture was 188.695 seconds after the earlier approved canary activation; archive completion time is only bounded by serving samples, not measured exactly. `delivery_not_exhausted` is retained: the exact positive ID is proven, general thread completeness is not. Evidence: `recovered-head-after.json`.

The other original ari target 953208142580178944 is still pending with four completed unconfirmed attempts and history coverage complete. It has not been declared deleted. The catch-up flag is off and no fifth attempt was started by this task.

At 17:58:41 the live debt report contained 1618 pending lilly-2 entries and 911 captured entries; pending entries include hidden/excluded/unresolved identities. At 18:00:26 the original fixed raw cohort contained 1516 missing captures out of 5615 known lilly-2 heads, down from 2767 missing at the historical 11:02 baseline. Recovery has never been enabled for lilly-2, so this movement is ordinary collection, not catch-up acceptance. Live debt entries and the frozen raw cohort are different denominators. The fixed cohort also had lilly-1 4/1671 and lora-1 1/43 missing; ari/lora-2/lora-3 had no missing IDs in that particular cohort. Evidence: `head-debt-after.txt`, `fixed-head-cohort-after.txt`.

## Reply material

At both 17:57:09 and 18:14:31, all 370 exact source observations representing the original 994-message reply cohort were still parser v5. The full serving comparison completed on the prior attempt at 17:05:59: all 994 IDs in archive, 631 parent and 582 root matches. That is historical evidence, not a repeat measurement on PR160. The full corpus was not reread while its sources remained untouched.

The six original diagnostic IDs were reread after this deployment, completing at 17:59:27. All six were in archive; parent refs matched in 3/6 (lilly-1, lilly-2, lora-1), root refs in 2/6 (lilly-1, lora-1). The previously populated lilly-2 parent survived. All six raw texts, normalized through the deployed source's `normalizeDmMessageText`, matched serving hashes at the 18:03:08 raw check; all six attachment arrays and serving media counts were empty. The raw bodies were held only in process memory; saved evidence has IDs/hashes and metadata. An initial raw-vs-plain hash difference on lora-3 was fully explained by normal HTML normalization, not text loss. The six source observations remained v5, so these matches are not attributed to completed v6 replay of the cohort. Evidence: `evidence/diagnostic-sample/`.

Explicit clears, later parent/root changes outside the retained window, attached-message content parity for the full 27-message attachment subset, and general thread completeness remain uncovered. Source stamps and raw capture alone cannot close P2. No manual replay or archive rebuild has been run.

## Stage state and remaining gates

| Stage | State | Savings / latency | Next requirement |
|---|---|---|---|
| Pre-A0 known head / debt | PR157 deployed; recovered ari ID proven in archive; second ari ID unresolved; lilly-2 recovery off | Ari capture 188.695 s after canary activation; no fleet latency distribution | Separate approved lilly-2 recovery window with before/after acceptance |
| Pre-A0 reply / fresh capture | PR158 and PR159 deployed; PR160 removes measured monitor query work; production acceptance incomplete | Fresh cohort progress measured above; serving freshness still degraded; no HTTP savings claim | Fresh backlog/lag recovery and retained source-to-serving reply parity |
| A0 + T0 | Not started | No shadow clock, physical-attempt baseline or savings | All three diagnostic prerequisites accepted, then offline corpus and >=7 full shadow days on six pages |
| C1 | Not started | Unmeasured | Start only after A0 starts; diagnostic trigger counts first |
| C2a | Not started | Unmeasured | Correctness cases and retained repair plan |
| C2b | Not started | Unmeasured | C2a; semantic dirty/receipt shadow with daily rotation retained |
| C2c | Gated | Unmeasured | Coverage, per-fan max-age and cost proof |
| W0 | Not started | Unmeasured | Management Session fixtures; live socket probe requires explicit yes |
| B0 | W0 gated | Unmeasured | Capture-only receiver, >=7 days and sufficient event variety |
| B1 | B0/T0 gated | Unmeasured | Delivery lag, added attempts and history fairness measured |
| A1 | Owner/calendar/evidence gated | Unmeasured | Separate explicit yes after freshness and A0/T0 evidence |
| B2 | Not authorized | Unmeasured | Separate owner decision; do not build by default |

The >=50% savings goal is not met or claimed. Outage gaps, provider edits/deletions, quiet-state freshness and Management Session socket coverage remain unproven. Provider-deleted-head repair stays outside A0; the planned shadow only counts that discrepancy. At 18:14:15 all three runtime roles were again healthy on the approved revision with zero restarts, loopback health OK (DB 0 ms) and 30 GiB free. The current authorization covers the completed deployment and ordinary background replay. Recovery flag flips, manual replay, live socket probes and A1 still require their own explicit owner decision after a concrete scoped action is prepared.

The subsequently approved [ari-1 scope](ARI-REPLAY-APPROVAL.md) passed preview, one write and nine-message serving acceptance at 19:04:21 UTC. The next concrete owner decision is now [the remaining five pages](../fansly-ari-reply-replay-2026-09-08/REMAINING-REPLAY-APPROVAL.md): 2765 retained observations in the same 24-hour window, processed sequentially with per-page gates. That wider scope has not run and needs a new yes. Head recovery remains none.


Subsequent state, 2026-09-08 20:54 UTC: the remaining-five-page scope was
explicitly approved via `\+`. Lora-3 54/54 and lora-2 63/63 passed; lora-1's
170 observations are v6 and 140/143 targets pass, but three targets in one
conversation time out through Agent reads. Neither Lilly preview nor write
started. A separately reviewed PR161 query fix is prepared; new deployment
approval is required before its production verification. Remaining replay
approval persists subject to the original per-page gate. Current evidence and
the concrete next action are in
../fansly-five-page-reply-replay-2026-09-08/REPORT.md and
../fansly-five-page-reply-replay-2026-09-08/PR161-DEPLOY-APPROVAL.md.
