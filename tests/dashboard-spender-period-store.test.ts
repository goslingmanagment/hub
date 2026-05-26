import { describe, expect, it } from "vitest";

import { migrateSpenderPeriodState } from "../apps/dashboard/src/stores/spenderPeriodStore.ts";

describe("dashboard spender period store", () => {
  it("defaults to 7d and preserves supported spender periods", () => {
    expect(migrateSpenderPeriodState(null)).toEqual({ period: "7d" });
    expect(migrateSpenderPeriodState({ period: "custom" })).toEqual({ period: "7d" });
    expect(migrateSpenderPeriodState({ period: "today" })).toEqual({ period: "today" });
    expect(migrateSpenderPeriodState({ period: "7d" })).toEqual({ period: "7d" });
    expect(migrateSpenderPeriodState({ period: "30d" })).toEqual({ period: "30d" });
    expect(migrateSpenderPeriodState({ period: "90d" })).toEqual({ period: "90d" });
    expect(migrateSpenderPeriodState({ period: "180d" })).toEqual({ period: "180d" });
    expect(migrateSpenderPeriodState({ period: "all" })).toEqual({ period: "all" });
  });
});
