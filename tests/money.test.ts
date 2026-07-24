import { describe, expect, it } from "vitest";

import {
  calculateGrossMillsFromNet,
  calculateNetMillsFromGross,
  dollarsToMills,
  formatUsdFromMills,
  millsToDecimalString,
  parsePeriod,
  resolveBusinessDateRangeForPlatform,
  resolveComparisonPeriodBounds,
  resolveRevenueBusinessDateRangeForPlatform,
  resolveSpenderBusinessDateRangeForPlatform,
  resolvePeriodBounds,
  resolveRevenueComparisonPeriodBoundsForPlatform,
  resolveRevenuePeriodBoundsForPlatform,
} from "@agency_hub_core/shared";

describe("money helpers", () => {
  it("formats mills without floating point drift", () => {
    expect(millsToDecimalString(1234500n)).toBe("1234.500");
    expect(formatUsdFromMills(1234500n)).toBe("$1,234.50");
    expect(formatUsdFromMills(481496n)).toBe("$481.49");
    expect(formatUsdFromMills(-5600n)).toBe("-$5.60");
    expect(formatUsdFromMills(-5609n)).toBe("-$5.60");
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
    const thirtyDayRange = resolveRevenueBusinessDateRangeForPlatform("onlyfans", "30d", now);
    const comparison = resolveRevenueComparisonPeriodBoundsForPlatform("onlyfans", "30d", now);

    expect(thirtyDay.from?.toISOString()).toBe("2026-02-07T00:00:00.000Z");
    expect(thirtyDay.to?.toISOString()).toBe("2026-03-10T00:00:00.000Z");
    expect(thirtyDayRange).toEqual({
      from: "2026-02-07",
      toExclusive: "2026-03-10",
    });
    expect(comparison?.from?.toISOString()).toBe("2026-01-07T00:00:00.000Z");
    expect(comparison?.to?.toISOString()).toBe("2026-02-07T00:00:00.000Z");
  });

  it("builds Fansly revenue and spender windows on UTC calendar days", () => {
    const now = new Date("2026-03-09T12:00:00.000Z");
    const thirtyDay = resolveRevenuePeriodBoundsForPlatform("fansly", "30d", now);
    const comparison = resolveRevenueComparisonPeriodBoundsForPlatform("fansly", "30d", now);
    const spenderRange = resolveSpenderBusinessDateRangeForPlatform("fansly", "30d", now);

    expect(thirtyDay.from?.toISOString()).toBe("2026-02-08T00:00:00.000Z");
    expect(thirtyDay.to?.toISOString()).toBe("2026-03-10T00:00:00.000Z");
    expect(comparison?.from?.toISOString()).toBe("2026-01-09T00:00:00.000Z");
    expect(comparison?.to?.toISOString()).toBe("2026-02-08T00:00:00.000Z");
    expect(spenderRange).toMatchObject({
      timeZone: "UTC",
      fromBusinessDate: "2026-02-08",
      toBusinessDateInclusive: "2026-03-09",
    });
  });

  it("treats custom upper bounds as inclusive on UTC day ranges", () => {
    const now = new Date("2026-01-15T12:00:00.000Z");
    const bounds = resolveRevenuePeriodBoundsForPlatform("fansly", "custom", now, {
      from: "2025-12-01",
      to: "2026-01-01",
    });
    const businessRange = resolveBusinessDateRangeForPlatform("fansly", "custom", now, {
      from: "2025-12-01",
      to: "2026-01-01",
    });
    const spenderRange = resolveSpenderBusinessDateRangeForPlatform("fansly", "custom", now, {
      from: "2025-11-30",
      to: "2025-12-02",
    });

    expect(bounds.from?.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(bounds.to?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(businessRange).toEqual({
      from: "2025-12-01",
      toExclusive: "2026-01-02",
    });
    expect(spenderRange).toMatchObject({
      fromBusinessDate: "2025-11-30",
      toBusinessDateInclusive: "2025-12-02",
    });
  });

  it("treats same-day custom ranges as a single inclusive day", () => {
    const now = new Date("2026-03-09T12:00:00.000Z");
    const bounds = resolveRevenuePeriodBoundsForPlatform("fansly", "custom", now, {
      from: "2026-03-09",
      to: "2026-03-09",
    });
    const businessRange = resolveBusinessDateRangeForPlatform("fansly", "custom", now, {
      from: "2026-03-09",
      to: "2026-03-09",
    });

    expect(bounds.from?.toISOString()).toBe("2026-03-09T00:00:00.000Z");
    expect(bounds.to?.toISOString()).toBe("2026-03-10T00:00:00.000Z");
    expect(businessRange).toEqual({
      from: "2026-03-09",
      toExclusive: "2026-03-10",
    });
  });

  it("keeps UTC today revenue windows unchanged", () => {
    const now = new Date("2026-03-09T12:00:00.000Z");
    const today = resolveRevenuePeriodBoundsForPlatform("fansly", "today", now);

    expect(today.from?.toISOString()).toBe("2026-03-09T00:00:00.000Z");
    expect(today.to?.toISOString()).toBe("2026-03-10T00:00:00.000Z");
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

// ─── Kernel Stage 27: the codec (source-named constructors, brands) ─────────

import {
  millsFromCents,
  millsFromDollars,
  millsFromInteger,
  millsToDollarsNumber,
  millsToMicroUsd,
  millsToRoundedDollars,
  microUsdFromDbInt,
  microUsdFromDollars,
  microUsdToMills,
  type MicroUsd,
  type Mills,
} from "@agency_hub_core/shared";

describe("money codec (Stage 27)", () => {
  it("millsFromInteger keeps the deleted toMills semantics byte-for-byte", () => {
    expect(millsFromInteger(1234n)).toBe(1234n);
    expect(millsFromInteger(1234)).toBe(1234n);
    expect(millsFromInteger(1234.9)).toBe(1234n); // trunc, not round
    expect(millsFromInteger(-1234.9)).toBe(-1234n);
    expect(millsFromInteger("1234")).toBe(1234n);
  });

  it("millsFromDollars inherits dollarsToMills parsing (fixed 3-place fraction)", () => {
    expect(millsFromDollars(4.99)).toBe(4990n);
    expect(millsFromDollars("12.3456")).toBe(12345n); // truncated past mills
    expect(millsFromDollars("-0.001")).toBe(-1n);
    expect(millsFromDollars(0)).toBe(0n);
    expect(() => millsFromDollars("not-money")).toThrow(/Invalid dollar amount/);
  });

  it("millsFromCents bridges the _cents column exactly (×10)", () => {
    expect(millsFromCents(499)).toBe(4990n);
    expect(millsFromCents(0)).toBe(0n);
    expect(millsFromCents(-25)).toBe(-250n);
    expect(millsFromCents(120n)).toBe(1200n);
  });

  it("micro-USD constructors and the explicit converters round-trip honestly", () => {
    expect(microUsdFromDollars(4.99)).toBe(4_990_000);
    expect(microUsdFromDbInt(1234.7)).toBe(1234);
    expect(millsToMicroUsd(millsFromDollars(4.99))).toBe(4_990_000);
    // Lossy direction is explicit: sub-mill precision truncates toward zero.
    expect(microUsdToMills(4_990_999 as MicroUsd)).toBe(4990n);
    expect(microUsdToMills(microUsdFromDollars(1))).toBe(1000n);
  });

  it("the brands refuse cross-unit mixing at compile time", () => {
    const mills: Mills = millsFromDollars(1);
    const micro: MicroUsd = microUsdFromDollars(1);
    // @ts-expect-error mills is a bigint brand; micro-USD is a number brand
    const bad: Mills = micro;
    // @ts-expect-error converters are the only sanctioned mixing points
    const alsoBad: MicroUsd = mills;
    void bad;
    void alsoBad;
    expect(typeof mills).toBe("bigint");
    expect(typeof micro).toBe("number");
  });

  // Value preservation for the four rewritten float sites (old expression vs
  // codec call), swept over wire-realistic money values.
  it("preserves the ofapi-dm-archive usdToMills values (2-decimal wire dollars)", () => {
    for (let cents = 0; cents <= 20_000; cents += 7) {
      const amount = cents / 100; // OFAPI sends 2-decimal dollar amounts
      expect(millsFromDollars(amount)).toBe(BigInt(Math.round(amount * 1000)));
    }
  });

  it("preserves the telegram whole-dollar rounding", () => {
    for (const mills of [0n, 499n, 500n, 999n, 1000n, 1499n, 1500n, 123_456n, 9_999_499n]) {
      expect(millsToRoundedDollars(mills)).toBe(Math.round(Number(mills) / 1000));
    }
  });

  it("preserves the snapshot/workboard dollars-number conversion", () => {
    for (const mills of [0n, 1n, 999n, 1000n, 4990n, 123_456n, -2500n]) {
      expect(millsToDollarsNumber(mills)).toBe(Number(mills) / 1000);
    }
  });
});
