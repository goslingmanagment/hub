import { describe, expect, it } from "vitest";

import { agentTeamSalesBodySchema } from "@agency_hub_core/contracts";
import type { ComputedWork } from "../apps/runtime/src/services/chatter-shifts.ts";
import { holdersOf, workRef } from "../apps/runtime/src/services/agent-team-sales.ts";

// The ledger's split rules read who held a page at a sale from Hub (ledger release 2): a shift by `workHoldsSale`, a
// look-in only when its person wrote to the fan last — as «Заработок» counts it.

const MIN = 60_000;
const T = Date.parse("2026-11-10T12:00:00Z");

function work(kind: "shift" | "visit", startedAt: number, endedAt: number, salesSince: Record<string, number>): ComputedWork {
  return {
    kind, startedAt, endedAt, ongoing: false, workedMinutes: Math.round((endedAt - startedAt) / MIN), pauses: [], lastInputAt: endedAt - MIN,
    lastBeatAt: endedAt - MIN, pages: new Map(Object.keys(salesSince).map((label) => [label, 60])), messages: new Map(), salesSince: new Map(Object.entries(salesSince)),
  };
}

describe("who held a page at a sale", () => {
  const shift = work("shift", T - 60 * MIN, T + 60 * MIN, { "page-a": T - 30 * MIN });
  const visit = work("visit", T - 10 * MIN, T + 10 * MIN, { "page-a": T - 10 * MIN });
  const works = [{ userId: 1, work: shift }, { userId: 2, work: visit }];

  it("names a shift that held the page, and a look-in only when its person wrote to the fan last", () => {
    expect(holdersOf(works, { pageLabel: "page-a", at: T }, null)).toEqual([workRef(1, shift)]);
    expect(holdersOf(works, { pageLabel: "page-a", at: T }, 2)).toEqual([workRef(1, shift), workRef(2, visit)]);
  });

  it("names nobody before the shift began on the page, after it ended, or on another page", () => {
    expect(holdersOf(works, { pageLabel: "page-a", at: T - 40 * MIN }, 1)).toEqual([]);
    expect(holdersOf(works, { pageLabel: "page-a", at: T + 60 * MIN }, 1)).toEqual([]);
    expect(holdersOf(works, { pageLabel: "page-b", at: T }, 1)).toEqual([]);
  });
});

describe("the window of one read", () => {
  it("takes at most 31 days, from before to", () => {
    expect(agentTeamSalesBodySchema.safeParse({ from: "2026-11-01T00:00:00+03:00", to: "2026-12-01T00:00:00+03:00" }).success).toBe(true);
    expect(agentTeamSalesBodySchema.safeParse({ from: "2026-11-01T00:00:00+03:00", to: "2026-12-03T00:00:00+03:00" }).success).toBe(false);
    expect(agentTeamSalesBodySchema.safeParse({ from: "2026-11-02T00:00:00+03:00", to: "2026-11-01T00:00:00+03:00" }).success).toBe(false);
  });
});
