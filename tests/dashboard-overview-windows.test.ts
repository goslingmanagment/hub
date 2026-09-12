import { describe, expect, it } from "vitest";

import { calendarSeries, describeMixedRevenueWindows } from "../apps/dashboard/src/pages/overview/presentation.ts";

// Audit B2: the Overview footnote must appear exactly when a displayed total
// combines per-platform windows of different widths.

const fanslyWindow = {
  platform: "fansly" as const,
  from: "2026-03-28T00:00:00.000Z",
  to: "2026-04-04T00:00:00.000Z",
  comparisonFrom: "2026-03-21T00:00:00.000Z",
  comparisonTo: "2026-03-28T00:00:00.000Z",
};

const onlyFansWindow = {
  platform: "onlyfans" as const,
  from: "2026-03-27T00:00:00.000Z",
  to: "2026-04-04T00:00:00.000Z",
  comparisonFrom: "2026-03-19T00:00:00.000Z",
  comparisonTo: "2026-03-27T00:00:00.000Z",
};

describe("describeMixedRevenueWindows", () => {
  it("describes differing window widths with platform display names", () => {
    const note = describeMixedRevenueWindows([fanslyWindow, onlyFansWindow], "7 Days");

    expect(note).toContain("7 Days");
    expect(note).toContain("7 days on Fansly");
    expect(note).toContain("8 days on OnlyFans");
  });

  it("stays silent for a single platform", () => {
    expect(describeMixedRevenueWindows([fanslyWindow], "7 Days")).toBeNull();
    expect(describeMixedRevenueWindows(undefined, "7 Days")).toBeNull();
    expect(describeMixedRevenueWindows([], "7 Days")).toBeNull();
  });

  it("stays silent when every platform spans the same width", () => {
    const alignedOnlyFans = {
      ...onlyFansWindow,
      from: "2026-03-28T00:00:00.000Z",
    };
    expect(describeMixedRevenueWindows([fanslyWindow, alignedOnlyFans], "7 Days")).toBeNull();
  });

  it("stays silent for unbounded windows (period=all)", () => {
    const unbounded = { ...onlyFansWindow, from: null, to: null };
    expect(describeMixedRevenueWindows([fanslyWindow, unbounded], "All Time")).toBeNull();
  });
});

describe("calendarSeries", () => {
  it("keeps missing dates and platform-specific edges instead of compressing gaps", () => {
    const result = calendarSeries([
      { businessDate: "2026-03-28", netAmountMills: 1000 },
      { businessDate: "2026-04-02", netAmountMills: -500 },
    ], [fanslyWindow, onlyFansWindow]);

    expect(result.map((point) => point.businessDate)).toEqual([
      "2026-03-27", "2026-03-28", "2026-03-29", "2026-03-30",
      "2026-03-31", "2026-04-01", "2026-04-02", "2026-04-03",
    ]);
    expect(result.map((point) => point.value)).toEqual([0, 1000, 0, 0, 0, 0, -500, 0]);
    expect(calendarSeries([], [fanslyWindow])).toHaveLength(7);
  });

  it("limits all-time padding to observed history, including a single negative point", () => {
    const unbounded = { ...fanslyWindow, from: null, to: null };
    expect(calendarSeries([], [unbounded])).toEqual([]);
    expect(calendarSeries([
      { businessDate: "2026-03-28", netAmountMills: -500 },
    ], [unbounded])).toEqual([{ businessDate: "2026-03-28", value: -500 }]);
    expect(calendarSeries([
      { businessDate: "2026-03-28", netAmountMills: 1000 },
      { businessDate: "2026-03-30", netAmountMills: 2000 },
    ], [unbounded]).map((point) => point.value)).toEqual([1000, 0, 2000]);
  });
});
