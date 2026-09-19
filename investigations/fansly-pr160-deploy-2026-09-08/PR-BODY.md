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

Prepared next owner decision: existing runbook Gate 2, one scoped ari-1 replay, account 10, kind dm_messages, received window [2026-09-07T01:45Z, 2026-09-08T01:45Z), parser 6. Read-only census at 18:15 UTC: 128 eligible observations, all bodies available; nine ari reply targets come from five of them. Neither preview nor write has run. This is a separate production-write gate, not authorization for wider replay or recovery.

| Migration stage | State | Measured savings / latency |
|---|---|---|
| Pre-A0 known head / lilly-2 debt | PR157 deployed; ari target proven in archive; second ID unresolved; catch-up none; lilly-2 recovery awaits separate approval | Ari exact capture 188.695 s after the earlier canary activation; no fleet distribution |
| Pre-A0 reply repair / freshness | PR158, PR159 and PR160 deployed; both parse lanes advance; reply-corpus acceptance open | Two sweeps 672.721 / 733.831 s; residual zero-DM age about 263 min; no HTTP savings claim |
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

No production HTTP savings or event latency distribution measured; the >=50% goal is not claimed. Old edits/deletions, outage gaps, quiet-state freshness and Management Session socket coverage remain unproven. Full local production evidence and the prepared approval are retained in investigations/fansly-pr160-deploy-2026-09-08/REPORT.md and ARI-REPLAY-APPROVAL.md in the operator workspace.
