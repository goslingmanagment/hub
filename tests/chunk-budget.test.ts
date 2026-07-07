// The Stage 26 request budget: multi-call units reserve their full cost up
// front (audit fix — the fan-earnings walk costs two calls per fan and must
// never start a fan it cannot finish within budget).

import { describe, expect, it } from "vitest";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";

describe("SyncChunkBudget", () => {
  it("reserves multi-call units: capacity(2) refuses the last single slot", async () => {
    const budget = new SyncChunkBudget(5);
    for (let i = 0; i < 4; i += 1) {
      await budget.onRequestEvent({ state: "started" } as never);
    }
    expect(budget.hasRequestCapacity()).toBe(true);
    expect(budget.hasRequestCapacity(2)).toBe(false);
    await budget.onRequestEvent({ state: "started" } as never);
    expect(budget.hasRequestCapacity()).toBe(false);
    expect(budget.shouldYield()).toBe(true);
  });

  it("resolves request_budget for a multi-call unit that no longer fits (review R3-4)", async () => {
    const budget = new SyncChunkBudget(5, 45_000);
    for (let i = 0; i < 4; i += 1) {
      await budget.onRequestEvent({ state: "started" } as never);
    }
    // The fan-earnings walk exits its loop on hasRequestCapacity(2); the
    // yield reason must resolve against the same required capacity instead
    // of returning null for every non-final chunk.
    expect(budget.hasRequestCapacity(2)).toBe(false);
    expect(budget.resolveYieldReason(2)).toBe("request_budget");
    expect(budget.resolveYieldReason()).toBeNull(); // single-call callers unchanged
  });
});
