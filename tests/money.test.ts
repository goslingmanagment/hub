import { describe, expect, it } from "vitest";

import {
  calculateGrossMillsFromNet,
  calculateNetMillsFromGross,
  dollarsToMills,
  formatUsdFromMills,
  millsToDecimalString,
  parsePeriod,
  resolveComparisonPeriodBounds,
  resolvePeriodBounds,
  resolveRevenueComparisonPeriodBoundsForPlatform,
  resolveRevenuePeriodBoundsForPlatform,
} from "@fansly-connect/shared";

describe("money helpers", () => {
  it("formats mills without floating point drift", () => {
    expect(millsToDecimalString(1234500n)).toBe("1234.500");
    expect(formatUsdFromMills(1234500n)).toBe("$1,234.50");
    expect(formatUsdFromMills(-5600n)).toBe("-$5.60");
  });

  it("converts OnlyMonster dollar amounts into mills", () => {
    expect(dollarsToMills(12.345)).toBe(12345n);
    expect(dollarsToMills("8.5")).toBe(8500n);
    expect(dollarsToMills(-1.25)).toBe(-1250n);
  });

  it("matches OnlyFans cent-rounded commission math", () => {
    expect(calculateNetMillsFromGross(12500n, 0)).toBe(12500n);
    expect(calculateNetMillsFromGross(12500n, 0.2)).toBe(10000n);
    expect(calculateNetMillsFromGross(4990n, 0.2)).toBe(3990n);
    expect(calculateNetMillsFromGross(-4990n, 0.2)).toBe(-3990n);
    expect(calculateNetMillsFromGross(-2500n, 0.2)).toBe(-2000n);
  });

  it("derives gross mills from net mills without float drift", () => {
    expect(calculateGrossMillsFromNet(16000n, 0)).toBe(16000n);
    expect(calculateGrossMillsFromNet(16000n, 0.2)).toBe(20000n);
    expect(calculateGrossMillsFromNet(11192n, 0.2)).toBe(13990n);
    expect(calculateGrossMillsFromNet(-16000n, 0.2)).toBe(-20000n);
  });

  it("builds Moscow trailing windows that include today", () => {
    const now = new Date("2026-03-07T10:00:00.000Z");
    const sevenDay = resolvePeriodBounds("7d", now);
    const thirtyDay = resolvePeriodBounds("30d", now);
    const comparison = resolveComparisonPeriodBounds("7d", now);

    expect(sevenDay.from?.toISOString()).toBe("2026-02-28T21:00:00.000Z");
    expect(sevenDay.to?.toISOString()).toBe("2026-03-07T21:00:00.000Z");
    expect(thirtyDay.from?.toISOString()).toBe("2026-02-05T21:00:00.000Z");
    expect(thirtyDay.to?.toISOString()).toBe("2026-03-07T21:00:00.000Z");
    expect(comparison?.from?.toISOString()).toBe("2026-02-21T21:00:00.000Z");
    expect(comparison?.to?.toISOString()).toBe("2026-02-28T21:00:00.000Z");
  });

  it("builds OnlyFans revenue windows on UTC calendar days", () => {
    const now = new Date("2026-03-09T12:00:00.000Z");
    const thirtyDay = resolveRevenuePeriodBoundsForPlatform("onlyfans", "30d", now);
    const comparison = resolveRevenueComparisonPeriodBoundsForPlatform("onlyfans", "30d", now);

    expect(thirtyDay.from?.toISOString()).toBe("2026-02-07T00:00:00.000Z");
    expect(thirtyDay.to?.toISOString()).toBe("2026-03-10T00:00:00.000Z");
    expect(comparison?.from?.toISOString()).toBe("2026-01-07T00:00:00.000Z");
    expect(comparison?.to?.toISOString()).toBe("2026-02-07T00:00:00.000Z");
  });

  it("rejects unsupported periods with the canonical option list", () => {
    expect(() => parsePeriod("90d")).toThrow(
      'Unsupported period "90d". Valid options: today, 7d, 30d, all, custom.',
    );
  });

  it("keeps custom period validation specific to custom ranges", () => {
    const now = new Date("2026-03-07T10:00:00.000Z");
    expect(() => resolvePeriodBounds("custom", now)).toThrow(
      "Custom period requires from/to dates",
    );
  });
});
