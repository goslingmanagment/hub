import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const LANE_FILES = [
  "fansly-stats.ts",
  "fansly-media-stats.ts",
  "fansly-notifications.ts",
  "fansly-catalog.ts",
  "fansly-post-replies.ts",
  "fansly-payouts.ts",
] as const;
const FORBIDDEN_PRIVATE_MACHINERY = [
  "AttemptCounter",
  "upsertCaptureCoverage",
  "upsertCheckpointProgress",
  "persistRawPayload",
] as const;

function syncSource(file: string) {
  return readFileSync(
    join(ROOT, "apps/runtime/src/services/sync", file),
    "utf8",
  );
}

describe("Fansly lane scaffold ratchet", () => {
  it("keeps budget, journal, checkpoint, coverage and continuation machinery shared", () => {
    for (const file of LANE_FILES) {
      const source = syncSource(file);
      expect(source, `${file} must use the shared lane scaffold`)
        .toContain('from "./fansly-lane.ts"');
      expect(source, `${file} must reserve attempts durably`)
        .toContain("createFanslyLaneRuntime");
      expect(source, `${file} must journal through the ordered helper`)
        .toContain("createFanslyLaneJournal");
      expect(source, `${file} must spread continuations through the shared helper`)
        .toContain("spreadFanslyContinuation");
      for (const forbidden of FORBIDDEN_PRIVATE_MACHINERY) {
        expect(source, `${file} reintroduced private ${forbidden}`)
          .not.toContain(forbidden);
      }
    }
  });

  it("keeps every response family on the shared three-way classifier", () => {
    expect(syncSource("fansly-stats.ts")).toContain("classifyFanslyResponse");
    expect(syncSource("fansly-media-stats.ts")).toContain("classifyStatsWindow");
    for (const file of [
      "fansly-notifications.ts",
      "fansly-catalog.ts",
      "fansly-post-replies.ts",
      "fansly-payouts.ts",
      "fansly-purchase-history.ts",
    ]) {
      expect(syncSource(file), `${file} must use the shared response classifier`)
        .toContain("classifyFanslyResponse");
    }
  });

  it("keeps purchase-history journal and checkpoint work on the same scaffold", () => {
    const handlers = syncSource("executor-handlers.ts");
    const start = handlers.indexOf("export async function executePurchaseHistoryChunk");
    const end = handlers.indexOf("\nexport async function", start + 1);
    const purchaseHistory = handlers.slice(start, end < 0 ? undefined : end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(purchaseHistory).toContain("createFanslyLaneRuntime");
    expect(purchaseHistory).toContain("saveProgress: savePurchaseHistoryProgress");
    expect(purchaseHistory).toContain("complete(input.syncRunId");
    expect(purchaseHistory).toContain("createFanslyLaneJournal");
    expect(purchaseHistory).not.toContain("upsertCheckpointProgress");
    expect(purchaseHistory).not.toContain("persistRawPayload");
  });
});
