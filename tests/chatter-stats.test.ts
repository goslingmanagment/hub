import { describe, expect, it } from "vitest";

import { byKindOf, settleSale, streaksOf } from "../apps/runtime/src/services/chatter-stats.ts";

// Whose a sale is when two shifts hold it: who last wrote to the fan; neither — both.
describe("settleSale", () => {
  const ME = 1;
  const COLLEAGUE = 2;

  it("is mine when no other shift holds it, whoever wrote", () => {
    expect(settleSale(ME, [], null)).toBe("mine");
    expect(settleSale(ME, [], COLLEAGUE)).toBe("mine");
  });

  it("is mine when two shifts hold it and I wrote last", () => {
    expect(settleSale(ME, [COLLEAGUE], ME)).toBe("mine");
  });

  it("is the colleague's when two shifts hold it and they wrote last", () => {
    expect(settleSale(ME, [COLLEAGUE], COLLEAGUE)).toBe("theirs");
  });

  it("is both of ours when neither of us wrote", () => {
    expect(settleSale(ME, [COLLEAGUE], null)).toBe("both");
    expect(settleSale(ME, [COLLEAGUE], 3)).toBe("both");
  });
});

describe("streaksOf", () => {
  const days = new Set(["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);

  it("counts the days in a row up to today", () => {
    expect(streaksOf(days, "2026-11-02")).toEqual({ current: 4, longest: 4 });
  });

  it("keeps the run while today has no shift yet", () => {
    expect(streaksOf(days, "2026-11-03")).toEqual({ current: 4, longest: 4 });
  });

  it("is broken by a whole day without a shift", () => {
    expect(streaksOf(days, "2026-11-04")).toEqual({ current: 0, longest: 4 });
    expect(streaksOf(new Set(), "2026-11-04")).toEqual({ current: 0, longest: 0 });
  });
});

// What a shift's sales are made of («Мои смены» draws a card's share bar from it): Hub's sum, never the browser's.
describe("byKindOf", () => {
  const sales = [
    { kind: "message_purchase", netMills: 23_992 },
    { kind: "tip", netMills: 8_000 },
    { kind: "stream_tip", netMills: 4_000 },
    { kind: "subscription", netMills: 7_992 },
    { kind: "post_purchase", netMills: 9_600 },
    { kind: "message_purchase", netMills: 15_992 },
  ];

  it("sums the net of each kind, a stream tip with the tips", () => {
    expect(byKindOf(sales)).toEqual({ ppv: 39_984, tip: 12_000, subscription: 7_992, post: 9_600 });
  });

  it("adds up to the shift's sales", () => {
    const byKind = byKindOf(sales);
    expect(byKind.ppv + byKind.tip + byKind.subscription + byKind.post).toBe(sales.reduce((sum, sale) => sum + sale.netMills, 0));
  });

  it("is zero of every kind without sales", () => {
    expect(byKindOf([])).toEqual({ ppv: 0, tip: 0, subscription: 0, post: 0 });
  });
});
