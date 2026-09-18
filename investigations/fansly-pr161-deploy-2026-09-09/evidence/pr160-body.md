Current production status, 2026-09-09 10:46 UTC: owner-approved PR161 deployment completed as 34d897779fd004336e114333501f284f1faeefc1 (standard dist-only/no-image-gc script, exit 0). API, worker and scheduler are healthy with zero restart counts; 29 GiB free; loopback health OK (DB 9 ms). The sync-health gate had two 150-second client timeouts before HTTP 200 in 105.498 seconds. Deployment success does not close its latency incident.

The first post-deploy exact lora-1 transcript read still returned 503 in 14.545 seconds (conversation 790634843078664193, message 953135194070597632, 2 ms window, actual default ASC). PostgreSQL timeout logs now identify the main list SELECT containing PR161 window_refs; the following count SELECT was rejected because the transaction was already aborted. The archive-floor query was not the timed-out statement in this request. This locates the failing phase, not the production execution-plan cause. No blind retry or new replay followed.

Lora-1 remains 140/143 verified across earlier timestamped reads; the other two pending targets were not read after the first failure. Including ari/lora-3/lora-2, 266/994 original positive targets have historical serving parity evidence. Three lora-1 targets and 725 Lilly targets remain unaccepted; neither Lilly preview nor write has started. Remaining approved replay permission persists behind the original per-page acceptance gate. No head-recovery flag, socket probe or A0/A1 activation occurred. No HTTP savings or fresh-event latency distribution is claimed.

The exact logged SQL was prepared as EXPLAIN (FORMAT JSON), without ANALYZE, with the actual 31 control parameters. One local Docker-Postgres test passed with zero skips (syntax/JSON planning/rollback only). The single production attempt as read_only was denied permission for page_dm_messages, psql exit 3. A concrete one-file, plan-only exception via the existing postgres role in a read-only transaction with a 10-second statement timeout is prepared but not authorized or executed. No grant or privilege bypass occurred. The final read-only parse-lane census timed out and returned no counts; the latest successful census is the 10:15:18 pre-deploy sample, not post-deploy freshness acceptance.

Current operator evidence: investigations/fansly-pr161-deploy-2026-09-09/REPORT.md and exact-plan-probe/PROPOSAL.md; original cohort state: investigations/fansly-five-page-reply-replay-2026-09-08/evidence/operation-status.json. Earlier dated operational entries below are historical; this update supersedes their deployment/next-gate status.

The sync monitor calculated current-run activity by aggregating all retained HTTP attempts and events before selecting the latest running run. A six-page Postgres fixture made the event subplan scan 1,163,960 historical rows six times. This change keeps the same running selector and reads only that run's activity through existing indexes.

On the synthetic fixture, EXPLAIN ANALYZE fell from 4,323.7 ms to 1,112.7 ms; all 102 normalized monitor rows matched. These are local query measurements. The preceding PR159 deployment failed six 150-second sync-health checks and rolled back; this benchmark does **not** reproduce that timeout or establish its exact cause.

Physical-failure debt outside the recent window, completed-run selection, page/stream scope, freshness/coverage semantics and the deployment gate remain intact. No flag or migration. Decision 280 and full synthetic before/after plans are included in `investigations/sync-health-query-2026-09-08/`.

Validation completed before opening this PR:

```text
pnpm check — PASS
strictness-ratchet: OK — 1908 existing errors / 121 files, unchanged budget
Unit: 280 files passed; 3110 tests passed; 9 existing skips
ESLint and dashboard production build: PASS
pnpm build:production: PASS

pnpm exec vitest run --no-file-parallelism tests/sync-monitor.integration.test.ts tests/sync.integration.test.ts
2 files passed; 15 tests passed; zero skips (Docker Postgres 16)

Local synthetic benchmark: PASS
166286 runs, 665120 attempts, 1163960 events, 132000 fan/page links,
48000 DM threads, 576000 messages; six pages / 17 streams
Repository call: 3137.6 → 987.8 ms
EXPLAIN ANALYZE: 4323.7 → 1112.7 ms
All 102 normalized rows equal; no timing threshold in regression tests
```

The integration cases prove latest-run ID ties, isolation from older/completed runs, maximum finish time (not latest start), in-flight attempts, event-only progress, absent activity, page/stream scope, and preservation of old physical-failure debt when no run is active. Independent review of e12620c6b5412b3dcfd7e3ac6a0b0fc01a26f87d found no blockers, independently confirmed all 102 rows match, and checked scope against migration 0012 composite FKs. Reviewer inspected but did not execute tests. The reviewer also confirmed final head 536f93c4f5704c361fbf69fc4e290f5d45a405b2 after its documentation-only validation update, with no blockers. All five CI checks passed ([run 34256451628](https://github.com/goslingmanagment/core/actions/runs/34256451628)). Squash merge 18649bd95f3bedb812847343d27fdeedf8b5d32f has the same tree as the independently reviewed final head; the clean worktree is pinned to that merge.

Production deployment was separately approved and completed successfully on 2026-09-08. The standard dist-only script exited 0; image/role checks, sync-health gate, dashboard verification and production-pinned CLI rebuild passed. At 18:14 UTC all roles were healthy on 18649bd95f3b with zero restarts, /health OK and 30 GiB free. Authenticated Configuration showed head catch-up running/editor none; no flags changed.

**Production sync-health latency remains unresolved.** The deployment's first request returned HTTP 200 in 145.031 seconds, narrowly inside the unchanged 150-second gate. One follow-up loopback request at 18:07 UTC timed out after 150.147 seconds (curl exit 28). It was not retried. This PR removes the locally measured query cost; successful deployment is not a complete performance RCA or acceptance of health latency.

Two consecutive background canonicalizer sweeps completed in 672.721 and 733.831 seconds, both above the existing 600-second budget, with zero errors/unavailable bodies/partition blockers. They reported 600 and 814 stamps across all families. The exact initial 2140-observation zero-version cohort advanced 1000 to v6 (236 DM, 10 earnings, 377 monthly, 377 stats) by 18:12 UTC. Historical v5 DM/earnings also advanced across those sweeps. At 18:14 UTC 1196 zero observations remained across the five sync-pull kinds; the oldest zero DM receipt was about 263 minutes old. Both lanes make progress; fresh serving latency has not been accepted.

The exact recovered ari head 953354621215076352 was served from message_archive at 17:57 UTC; the other original canary ID is still pending with four unconfirmed attempts. Lilly-2 recovery has never been enabled: its original fixed cohort had 1516 missing captures / 5615 known heads at 18:00 UTC, while its separate live debt view had 1618 pending entries at 17:58 UTC. Progress under ordinary collection is not catch-up acceptance.

At 18:14 UTC all 370 source observations for the 994-message reply cohort were still v5. The prior full comparison found all 994 IDs in archive, 631 parents and 582 roots matching. A fresh six-example check after this deploy found all six in archive and all normalized texts preserved; parents matched 3/6, roots 2/6, and the previously populated lilly-2 parent survived. All six sample attachment arrays were empty; full attached-message/explicit-clear parity is still uncovered.

Owner-approved ari-1 replay accepted, 2026-09-08 19:04 UTC: on deployed revision 18649bd95f3bedb812847343d27fdeedf8b5d32f, the exact account-10 / dm_messages / received [2026-09-07T01:45Z, 2026-09-08T01:45Z) / parser-6 scope passed preview and one write. Preview scanned 128, returned 2764 candidate drafts and stamped zero. The write scanned/stamped 128, appended 1487 and deduped 1405, with zero errors, unavailable/unparseable/unmapped skips, binding conflicts or partition blockers. Its additional 128 observation checkpoints explain 1487 + 1405 = 2764 + 128. Independent read-only SQL confirmed 128/128 at v6.

All nine fixed ari targets are now served from message_archive with matching parent, root and normalized text: parent/root improved from 5/9 to 9/9, repairing four missing pairs while preserving the other five. All nine attachment arrays were empty. Transcript coverage blockers remain; this proves the exact subset, not complete conversations or the remaining 985 reply targets. The write took 110.558 seconds; complete serving confirmation was sampled within 14m39s of write start (12m49s after completion). Early checks still saw 5/9 during ordinary projection. This is an upper bound for one repair, not a fresh-event latency percentile.

At 19:05 all three roles were healthy on 18649bd95f3b with zero restarts and 30 GiB free; loopback /health was OK. Authenticated Configuration at approximately 19:08 showed head catch-up running/editor none, Save disabled. The shared unparsed queue at 19:05 contained four observations (one DM about 24 seconds old and three earnings), while historical v5 DM/earnings continued to decrease. This is background progress, not isolated replay causality or full serving freshness acceptance. The separate sync-health timeout remains open. No new code, deploy or flag change was made for this operation; existing reviewed test results above remain applicable. No HTTP savings measurement or >=50% claim is made.

Local evidence is retained in investigations/fansly-ari-reply-replay-2026-09-08/REPORT.md, with the nine-row acceptance assertions, retained-source hashes, preview/write output and read-only runtime/queue samples. The proposed five-page scope was subsequently approved; see the update below for execution results and the current serving blocker.

| Migration stage | State | Measured savings / latency |
|---|---|---|
| Pre-A0 known head / lilly-2 debt | PR157 deployed; ari target proven in archive; second ID unresolved; catch-up none; lilly-2 recovery awaits separate approval | Ari exact capture 188.695 s after the earlier canary activation; no fleet distribution |
| Pre-A0 reply repair / freshness | PR158/159/160 deployed; ari 9/9, lora-3 54/54, lora-2 63/63 accepted; lora-1 140/143 verified; Lilly replays paused; PR161 merged as 34d89777, awaiting deploy approval | Ari serving confirmation within 14m39s of start; lora-3 within 7m05s, lora-2 within 4m20s; no physical-attempt savings measured |
| A0 + T0 | Not started; prerequisite acceptance open; no shadow clock or physical-attempt baseline | Unmeasured |
| C1 | Not started | Unmeasured |
| C2a | Not started | Unmeasured |
| C2b | Not started | Unmeasured |
| C2c | Evidence/freshness gated | Unmeasured |
| W0 | Not started; live socket requires separate yes, Management Session only | Unmeasured |
| B0 | W0 and subsequent >=7-day shadow gate pending | Unmeasured |
| B1 | B0/T0 and measured delivery/fairness gate pending | Unmeasured |
| A1 | Separate owner/calendar/evidence gate | Unmeasured |
| B2 | Not authorized; separate decision required | Unmeasured |

No production HTTP savings or event latency distribution measured; the >=50% goal is not claimed. Old edits/deletions, outage gaps, quiet-state freshness and Management Session socket coverage remain unproven. Deployment history is retained in investigations/fansly-pr160-deploy-2026-09-08/REPORT.md. Current scoped-replay acceptance and the next gate are in investigations/fansly-ari-reply-replay-2026-09-08/REPORT.md and REMAINING-REPLAY-APPROVAL.md in the operator workspace.

Owner-approved five-page replay update, 2026-09-08 20:54 UTC: the owner's `\+` authorized the previously proposed sequential scope. Lora-3 preview and one write passed (31/31 stamped v6, 653 appended, 747 deduped, 71.738 s); all 54 reply targets now match parent/root, normalized text and stable/direct raw media refs, repairing 39 missing pairs. Lora-2 preview/write passed (43/43 v6, 1097 appended, 1173 deduped, 80.313 s); all 63 targets match. Serving confirmation bounds were 7m05s and 4m20s from write start respectively, not fresh-event percentiles.

Lora-1 preview/write passed (170/170 v6, 4215 appended, 4440 deduped, 267.020 s), but full acceptance remains open: 140/143 targets match; three in conversation 790634843078664193 are blocked by a repeatable Agent transcript timeout, including a 2 ms window. All three writes had zero errors, unavailable/unparseable/unmapped skips, binding conflicts and partition blocks, without budget truncation. Checkpoint accounting is documented in the operator report. Four nonempty attachment messages across these readable cohorts passed. Including ari, 266/994 original positive targets are verified through timestamped reads; the remaining 3 blocked targets and 725 Lilly targets are not accepted. The complete 27-message attachment cohort and general conversation coverage remain open.

Neither Lilly preview nor write has started: the original per-page acceptance gate stopped progress. The remaining approved replay permission persists; a newly prepared query fix needs its own deployment yes. Independently reviewed PR #161 bounds transcript material to window candidates, with 120 Docker-Postgres tests, pnpm check and production build passed. Its local benchmark demonstrates less query work, not the complete production RCA or resolution of separate coverage/sync-health timeouts. No additional deployment or flag change occurred. Catch-up remains none; lilly-2 known-head recovery and A0/A1 remain separate gates.

At 20:53 all roles were healthy with zero restarts and 30 GiB free, loopback health OK (DB 10 ms). At 20:53:55 the five inspected pull families had no parse-zero rows; historical v5 DM/earnings remained 40206/14204. This is a single backlog snapshot, not archive freshness proof. Whole-database size grew 44,171,264 bytes between 20:01:50 and 20:53:34 across all concurrent work, not isolated replay cost. The standard replay bootstrap was traced to OFAPI credential preflight GET /whoami and proof persistence; the whole CLI is not globally read-only or zero-HTTP, though scoped Fansly canonicalization uses retained bodies. No Fansly history refetch or live socket was run, and physical attempts/savings remain unmeasured.

Current evidence: `investigations/fansly-five-page-reply-replay-2026-09-08/REPORT.md`, `AUTHORIZATION.md`, per-page accepted.json and labelled partial lora-1 evidence in the operator workspace. New query evidence is committed with PR #161. The next concrete owner gate is deployment of the reviewed PR161 revision, then exact blocked-read verification and completion of lora-1 acceptance before remaining approved Lilly work.

PR161 subsequently passed all five CI checks and merged at 21:07:12 UTC as 34d897779fd004336e114333501f284f1faeefc1. Its merged tree equals the independently reviewed final tree. Deployment of that exact revision is prepared and awaits a new owner yes; no new production mutation occurred.
