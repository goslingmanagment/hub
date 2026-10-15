import { describe, expect, it } from "vitest";

import { migratePeriodState } from "../apps/dashboard/src/stores/periodStore.ts";
import { resolveDashboardPeriod, revenuePeriod } from "../apps/dashboard/src/lib/navigation.ts";

describe("dashboard period store", () => {
  it("defaults to 7d and migrates invalid persisted values back to 7d", () => {
    expect(migratePeriodState(null, 4)).toEqual({ period: "7d" });
    expect(migratePeriodState({ period: "custom" }, 4)).toEqual({ period: "7d" });
  });

  it("migrates the old persisted 30d default to 7d", () => {
    expect(migratePeriodState({ period: "30d" }, 2)).toEqual({ period: "7d" });
  });

  it("preserves supported non-default persisted values and new 30d selections", () => {
    expect(migratePeriodState({ period: "today" }, 2)).toEqual({ period: "today" });
    expect(migratePeriodState({ period: "7d" }, 2)).toEqual({ period: "7d" });
    expect(migratePeriodState({ period: "all" }, 2)).toEqual({ period: "all" });
    expect(migratePeriodState({ period: "30d" }, 3)).toEqual({ period: "30d" });
  });

  it("holds the spender reports' longer windows, as the one period of the console", () => {
    for (const value of ["today", "7d", "30d", "90d", "180d", "all"] as const) {
      expect(migratePeriodState({ period: value }, 4)).toEqual({ period: value });
    }
  });

  it("shows a longer window's last 30 days on the revenue reports", () => {
    expect(revenuePeriod("90d")).toBe("30d");
    expect(revenuePeriod("180d")).toBe("30d");
    expect(revenuePeriod("all")).toBe("all");
    expect(resolveDashboardPeriod(null, "180d")).toBe("30d");
    expect(resolveDashboardPeriod("today", "180d")).toBe("today");
  });
});
