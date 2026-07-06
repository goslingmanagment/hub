import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Kernel Stage 28: deletion is a governed act. This is the inverse of the
// Stage 1 audit — it enumerates every file that issues a SQL delete and pins
// the list. A new deleter anywhere fails here first and must justify itself
// (projection rebuild / session hygiene / sanctioned retention sweep) before
// joining the allowlist. The SCHEDULED deleters — the only ones that touch
// captured data on a timer — are exactly:
//   - deleteExpiredSyncObservability (sync_http_attempts, sync_run_events,
//     and since Stage 28 sync_runs; 30 days)
//   - the golden-signals sampler prune (ops_metric_samples; 90 days)
//   - the page_dm_messages prune (cache policy, archive-coverage-gated)
//   - pg-boss's own archival tables
// The Stage 28 erasure module is the one sanctioned NON-scheduled deleter:
// owner-initiated, dry-run default, tombstoned in erasure_log.
const SANCTIONED_DELETER_FILES = [
  "apps/runtime/src/cli.ts",
  "apps/runtime/src/services/erasure/index.ts",
  "apps/runtime/src/modules/catalog/index.ts",
  "apps/runtime/src/modules/events/index.ts",
  "apps/runtime/src/modules/identity/index.ts",
  "apps/runtime/src/modules/ops/index.ts",
  "apps/runtime/src/modules/workboard/index.ts",
  "apps/runtime/src/services/auth.ts",
  "apps/runtime/src/services/domain-events-stream.ts",
  "apps/runtime/src/services/events-stream.ts",
  "apps/runtime/src/services/projections/fan-earnings.ts",
  "apps/runtime/src/services/sync/executor.ts",
  "apps/runtime/src/services/sync/observability.ts",
  "apps/runtime/src/services/sync/rate-limiter.ts",
  "packages/db/src/repositories/auth.ts",
  "packages/db/src/repositories/catalog.ts",
  "packages/db/src/repositories/config-settings.ts",
  "packages/db/src/repositories/dm-analytics.ts",
  "packages/db/src/repositories/dm-message-archive.ts",
  "packages/db/src/repositories/fan-metadata.ts",
  "packages/db/src/repositories/message-archive.ts",
  "packages/db/src/repositories/observations.ts",
  "packages/db/src/repositories/ofapi.ts",
  "packages/db/src/repositories/ops-metrics.ts",
  "packages/db/src/repositories/page-dm.ts",
  "packages/db/src/repositories/runtime-instances.ts",
  "packages/db/src/repositories/spenders.ts",
  "packages/db/src/repositories/sync.ts",
  "packages/db/src/repositories/top-spenders.ts",
  "packages/db/src/repositories/transactions.ts",
  "packages/db/src/repositories/workboard-v2.ts",
];

describe("retention deleter enumeration (Stage 28)", () => {
  it("no file outside the pinned allowlist issues a SQL delete", () => {
    const root = join(__dirname, "..");
    let output = "";
    try {
      output = execFileSync(
        "grep",
        [
          "-rlE",
          "\\.delete\\(|delete from",
          "--include=*.ts",
          "packages/db/src/repositories",
          "apps/runtime/src",
        ],
        { cwd: root, encoding: "utf8" },
      );
    } catch {
      output = "";
    }
    const found = output.split("\n").filter((line) => line.trim() !== "").sort();
    expect(found).toEqual([...SANCTIONED_DELETER_FILES].sort());
  });
});
