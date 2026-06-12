import { describe, expect, it } from "vitest";

import { describeMixedRevenueWindows } from "../apps/dashboard/src/pages/OverviewPage.tsx";

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
