import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDurableFanslyAttemptBudget,
  FanslyDailyAttemptBudgetExhaustedError,
} from "../apps/runtime/src/services/sync/fansly-lane.ts";

const ROOT = join(__dirname, "..");

function syncSource(file: string) {
  return readFileSync(
    join(ROOT, "apps/runtime/src/services/sync", file),
    "utf8",
  );
}

/** The response classifiers of the Sync Engine's lib. */
function engineLibSource(file: string) {
  return readFileSync(
    join(ROOT, "apps/runtime/src/sync/fansly/lib", file),
    "utf8",
  );
}

describe("Fansly lane scaffold ratchet", () => {
  it("keeps every response family on the shared three-way classifier", () => {
    expect(engineLibSource("stats-rules.ts")).toContain("classifyFanslyResponse");
    expect(engineLibSource("media-stats-rules.ts")).toContain("classifyStatsWindow");
    for (const file of [
      "notifications-rules.ts",
      "catalog-rules.ts",
      "post-replies-rules.ts",
      "payouts-rules.ts",
      "purchase-history.ts",
    ]) {
      expect(engineLibSource(file), `${file} must use the shared response classifier`)
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

describe("Fansly lane attempt budget", () => {
  const started = (attemptNumber: number) => ({
    requestId: "account_stats:1",
    state: "started" as const,
    operation: "account_stats",
    endpointTemplate: "/api/v1/it/amoie/stats",
    method: "GET",
    attemptNumber,
    timestamp: new Date("2026-08-20T05:01:00.000Z"),
  });

  it("keeps attempts held back out of a request's retry allowance and its admission", async () => {
    let state = { utcDay: "2026-08-20", callsToday: 1 };
    const budget = createDurableFanslyAttemptBudget({
      dailyCap: 3,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      saveProgress: async () => {},
    });
    const holding = budget.holdingBack(1);

    // Two attempts left today, one of them held for a later request: this one
    // may make one attempt, so the adapter allows it no retry.
    expect(budget.remainingAttempts()).toBe(2);
    expect(holding.remainingAttempts()).toBe(1);
    expect(holding.hasCapacity()).toBe(true);
    await holding.observer.onRequestEvent(started(1));
    expect(state.callsToday).toBe(2);

    // An adapter that retries past its allowance is refused before the wire.
    expect(holding.remainingAttempts()).toBe(0);
    expect(holding.hasCapacity()).toBe(false);
    await expect(holding.observer.onRequestEvent(started(2)))
      .rejects.toBeInstanceOf(FanslyDailyAttemptBudgetExhaustedError);
    expect(state.callsToday).toBe(2);

    // The held attempt is still there for the request it was held for.
    expect(budget.hasCapacity()).toBe(true);
    await budget.observer.onRequestEvent(started(1));
    expect(state.callsToday).toBe(3);
    expect(budget.holdingBack(0).remainingAttempts()).toBe(0);
  });
});
