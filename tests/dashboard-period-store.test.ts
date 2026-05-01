import { describe, expect, it } from "vitest";

import { migratePeriodState } from "../apps/dashboard/src/stores/periodStore.ts";

describe("dashboard period store", () => {
  it("defaults to 7d and migrates invalid persisted values back to 7d", () => {
    expect(migratePeriodState(null, 3)).toEqual({ period: "7d" });
    expect(migratePeriodState({ period: "custom" }, 3)).toEqual({ period: "7d" });
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
});
