import { describe, expect, it } from "vitest";

import { creditOf, disputePeopleOf, payoutCellOf } from "../apps/runtime/src/services/shift-report.ts";

// The draft shift report's money rules (week-4.md §2): what a mark credits and
// how a payout-sheet cell rounds.

describe("shift report money", () => {
  it("credits «моё» whole, «делим» by the share, «не моё» nothing, the chatter's own amount over Hub's", () => {
    expect(creditOf({ mark: "mine", netMills: 80_000, amountMills: null, sharePercent: 50 })).toBe(80_000);
    expect(creditOf({ mark: "mine", netMills: 80_000, amountMills: 75_000, sharePercent: 50 })).toBe(75_000);
    expect(creditOf({ mark: "share", netMills: 20_001, amountMills: null, sharePercent: 50 })).toBe(10_001);
    expect(creditOf({ mark: "share", netMills: 20_000, amountMills: null, sharePercent: 30 })).toBe(6_000);
    expect(creditOf({ mark: "not_mine", netMills: 20_000, amountMills: 5_000, sharePercent: 50 })).toBe(0);
  });

  it("rounds a cell to the cent on Fansly and to the dollar on OnlyFans", () => {
    expect(payoutCellOf("fansly", 12_344)).toBe(12_340);
    expect(payoutCellOf("fansly", 12_345)).toBe(12_350);
    expect(payoutCellOf("onlyfans", 12_499)).toBe(12_000);
    expect(payoutCellOf("onlyfans", 12_500)).toBe(13_000);
  });

  it("lets the owner split a «делим» dispute with the teammate who has not marked the sale yet", () => {
    expect(disputePeopleOf({
      marks: [{ userId: 5, username: "nikita", mark: "share", shareWithUserId: 3, shareWith: "vanya", amountMills: null }],
    })).toEqual([{ userId: 5, username: "nikita" }, { userId: 3, username: "vanya" }]);
  });
});
