import { describe, expect, it } from "vitest";

import { migrateSpenderPeriodState } from "../apps/dashboard/src/stores/spenderPeriodStore.ts";

describe("dashboard spender period store", () => {
  it("defaults to 7d for the shared spender period and preserves supported values", () => {
    expect(migrateSpenderPeriodState(null).period).toBe("7d");
    expect(migrateSpenderPeriodState({ period: "custom" }).period).toBe("7d");
    for (const value of ["today", "7d", "30d", "90d", "180d", "all"] as const) {
      expect(migrateSpenderPeriodState({ period: value }).period).toBe(value);
    }
  });

  it("defaults Top Supporters period to lifetime (\"all\") and preserves overrides", () => {
    expect(migrateSpenderPeriodState(null).topSupportersPeriod).toBe("all");
    expect(migrateSpenderPeriodState({ topSupportersPeriod: "custom" }).topSupportersPeriod).toBe("all");
    for (const value of ["today", "7d", "30d", "90d", "180d", "all"] as const) {
      expect(migrateSpenderPeriodState({ topSupportersPeriod: value }).topSupportersPeriod).toBe(value);
    }
  });

  it("keeps shared and Top Supporters periods independent across migrations", () => {
    const result = migrateSpenderPeriodState({ period: "30d", topSupportersPeriod: "all" });
    expect(result).toEqual({ period: "30d", topSupportersPeriod: "all" });
  });
});
