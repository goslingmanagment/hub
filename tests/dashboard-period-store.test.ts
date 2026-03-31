import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("dashboard period store", () => {
  it("removes custom ranges and migrates invalid persisted values back to 30d", () => {
    const source = readFileSync(
      new URL("../apps/dashboard/src/stores/periodStore.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain('export type PeriodOption = "today" | "7d" | "30d" | "all";');
    expect(source).toContain("version: 2");
    expect(source).toContain("SUPPORTED_PERIODS.has(persistedState.period as PeriodOption)");
    expect(source).toContain(": DEFAULT_PERIOD;");
  });
});
