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
});
