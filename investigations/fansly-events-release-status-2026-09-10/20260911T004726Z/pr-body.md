Incremental Fansly follower walks can request full reconciliation through three OR branches, but current telemetry cannot show which branch fired or which requests reached a completed roster generation. This diagnostic part of C1 records the unchanged decisions and atomic queue context, and adds a restricted timeline over existing run receipts. It does not change the follower predicate, cadence, presence writes or provider requests.

The aggregate and timeline keep valid trigger decisions separate from valid queue receipts. Claimed revisions are distinct from roster generations; successful non-destructive close is distinct from certified membership. Missing, invalid, duplicate and boundary evidence stays unknown. Timeline reads are limited to eight days and 500 runs per page. A pinned upper ID excludes later inserts but does not freeze mutable outcomes. No fan identities, bodies, headers or lease tokens are exposed.

This remains the single C1 draft. After an explicitly approved diagnostic deployment, retain the production timeline, establish headline/deletion/pagination causes and generation consolidation, then add the narrow policy fix here. Pending-at-request counts and sequence differences alone are not savings. Decision 291 and migrations 0182–0183 are numbered after main 32478124. The new SQL reader is 126 lines; its integration suite is 143 lines.

Validation on head d47dc9b0:

- `pnpm check`: 3205 tests passed in 292 files, nine existing skips; strictness ratchet unchanged at 1908 known errors in 121 files; lint and dashboard build passed.
- Real Docker-Postgres, serial: `pnpm exec vitest run --no-file-parallelism tests/followers-timeline.integration.test.ts tests/followers-diagnostics.integration.test.ts tests/generation-high-water.integration.test.ts tests/page-sync-lease-fencing.integration.test.ts tests/sync.integration.test.ts` — 70 passed in five files, zero skips, 27.03 seconds.
- Coverage: real handler/queue/presence receipts; each trigger and no request; concurrent queue receipts; partial/failed/skipped/non-destructive completion; pinned pagination and exclusive boundaries; lost/duplicate/malformed evidence; private-data exclusion; restricted-role permissions; existing lease/generation guards.
- `pnpm build:production`: passed locally after the final commit; backend artifacts and dashboard built successfully.
- All five GitHub checks passed on d47dc9b0, including the production Docker build and Chromium runtime smoke: https://github.com/goslingmanagment/core/actions/runs/34547632176
- Independent review identified a missing queue-validity marker. Added the existing integer/nonnegative/ordering checks plus seven malformed-queue regressions. Final re-review found no actionable issues. The reviewer read local test logs but did not rerun tests. `git diff --check` passes. Production query-plan performance is unmeasured.

Production evidence:

- A fresh catalog read on 11 September 00:24 UTC used `read_only` in READ ONLY and confirmed that the follower diagnostic reader is not deployed.
- At 00:33 UTC all three roles were healthy, zero restarts, 25 GiB free, on image f742e86eca4c, source 32478124. That intervening release was already present; this task did not deploy it. It includes C2a/C2b code. Replay completion, projection repair and C2b enablement were not verified.
- The verified retained T0 corpus for September 1–6 has 20881 follower-reconcile physical attempts: 19420 anomaly-source and 1461 scheduled-source. Ordinary followers account for 3079 attempts. These retained telemetry counts include retries; their source labels do not prove redundant work or complete coverage. Branch frequencies and eventual generation consolidation remain unmeasured.

Deployment remains owner-gated. Against the currently observed main, this delta adds diagnostics without another earnings parser bump. Rollback must retain the inherited v2 readers and additive schema. This PR does not authorize A1, live sockets, replay/repair or C2b enablement. No request savings or fresh-event latency claim is made.

