import { describe, expect, it } from "vitest";

import {
  diffBusinessDays,
  resolveAutoSpenderSeriesGranularity,
  resolveBusinessDateRangeForPlatform,
  resolveComparisonPeriodBounds,
  resolvePeriodBounds,
  resolveRevenueBusinessDateRangeForPlatform,
  resolveRevenueComparisonPeriodBoundsForPlatform,
  resolveRevenuePeriodBoundsForPlatform,
  resolveSpenderBusinessDateRangeForPlatform,
  resolveSpenderComparisonPeriodBoundsForPlatform,
  resolveSpenderPeriodBoundsForPlatform,
  UTC_TIME_ZONE,
} from "@agency_hub_core/shared";

// P-34: `period=custom` used to read `to` as an exclusive instant for every
// range wider than a day, and as an inclusive calendar day for same-day ranges.
// The rule is now uniform — `from`/`to` are both inclusive business dates, so a
// range covers exactly (to - from + 1) calendar days at any width.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// `now` never participates in a custom range; it is pinned only so a
// regression in the branch order would show up as a resolved-window change.
const NOW = new Date("2026-06-15T09:30:00.000Z");

interface CustomRangeCase {
  name: string;
  from: string;
  to: string;
  expectedFrom: string;
  expectedToExclusive: string;
  expectedToExclusiveDate: string;
  dayCount: number;
}

const CUSTOM_RANGE_CASES: CustomRangeCase[] = [
  {
    name: "1-day range",
    from: "2026-03-09",
    to: "2026-03-09",
    expectedFrom: "2026-03-09T00:00:00.000Z",
    expectedToExclusive: "2026-03-10T00:00:00.000Z",
    expectedToExclusiveDate: "2026-03-10",
    dayCount: 1,
  },
  {
    name: "2-day range",
    from: "2026-03-01",
    to: "2026-03-02",
    expectedFrom: "2026-03-01T00:00:00.000Z",
    expectedToExclusive: "2026-03-03T00:00:00.000Z",
    expectedToExclusiveDate: "2026-03-03",
    dayCount: 2,
  },
  {
    name: "3-day range",
    from: "2026-03-04",
    to: "2026-03-06",
    expectedFrom: "2026-03-04T00:00:00.000Z",
    expectedToExclusive: "2026-03-07T00:00:00.000Z",
    expectedToExclusiveDate: "2026-03-07",
    dayCount: 3,
  },
  {
    name: "31-day range ending on a month boundary",
    from: "2026-03-01",
    to: "2026-03-31",
    expectedFrom: "2026-03-01T00:00:00.000Z",
    expectedToExclusive: "2026-04-01T00:00:00.000Z",
    expectedToExclusiveDate: "2026-04-01",
    dayCount: 31,
  },
  {
    name: "32-day range crossing a year boundary",
    from: "2025-12-01",
    to: "2026-01-01",
    expectedFrom: "2025-12-01T00:00:00.000Z",
    expectedToExclusive: "2026-01-02T00:00:00.000Z",
    expectedToExclusiveDate: "2026-01-02",
    dayCount: 32,
  },
];

describe("custom period bounds treat `to` as an inclusive business date (P-34)", () => {
  it.each(CUSTOM_RANGE_CASES)(
    "$name resolves to [from, to + 1 day) through every entry point",
    ({ from, to, expectedFrom, expectedToExclusive, expectedToExclusiveDate, dayCount }) => {
      const custom = { from, to };

      const generic = resolvePeriodBounds("custom", NOW, custom, UTC_TIME_ZONE);
      const fanslyRevenue = resolveRevenuePeriodBoundsForPlatform("fansly", "custom", NOW, custom);
      const onlyfansRevenue = resolveRevenuePeriodBoundsForPlatform(
        "onlyfans",
        "custom",
        NOW,
        custom,
      );
      const spender = resolveSpenderPeriodBoundsForPlatform("fansly", "custom", NOW, custom);

      for (const bounds of [generic, fanslyRevenue, onlyfansRevenue, spender]) {
        expect(bounds.from?.toISOString()).toBe(expectedFrom);
        expect(bounds.to?.toISOString()).toBe(expectedToExclusive);
        expect(bounds.to!.getTime() - bounds.from!.getTime()).toBe(dayCount * DAY_MS);
      }

      const businessRange = resolveBusinessDateRangeForPlatform("fansly", "custom", NOW, custom);
      const revenueBusinessRange = resolveRevenueBusinessDateRangeForPlatform(
        "onlyfans",
        "custom",
        NOW,
        custom,
      );
      expect(businessRange).toEqual({ from, toExclusive: expectedToExclusiveDate });
      expect(revenueBusinessRange).toEqual({ from, toExclusive: expectedToExclusiveDate });

      const spenderRange = resolveSpenderBusinessDateRangeForPlatform(
        "fansly",
        "custom",
        NOW,
        custom,
      );
      expect(spenderRange).toMatchObject({
        timeZone: "UTC",
        fromBusinessDate: from,
        toBusinessDateInclusive: to,
      });
      expect(diffBusinessDays(from, to)).toBe(dayCount);
    },
  );

  it("widens by exactly one calendar day per day added to `to`", () => {
    const widths = ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"];
    const durations = widths.map((to) => {
      const bounds = resolveRevenuePeriodBoundsForPlatform("fansly", "custom", NOW, {
        from: "2026-03-01",
        to,
      });
      return bounds.to!.getTime() - bounds.from!.getTime();
    });

    expect(durations).toEqual([1, 2, 3, 4, 5].map((days) => days * DAY_MS));
    // The 2-day range in particular used to collapse to the 1-day window.
    expect(durations.map((duration) => duration / HOUR_MS)).toEqual([24, 48, 72, 96, 120]);
  });

  it("keeps the inclusive rule on Moscow business days", () => {
    const bounds = resolvePeriodBounds("custom", NOW, { from: "2026-03-01", to: "2026-03-02" });
    const sameDay = resolvePeriodBounds("custom", NOW, { from: "2026-03-01", to: "2026-03-01" });

    expect(bounds.from?.toISOString()).toBe("2026-02-28T21:00:00.000Z");
    expect(bounds.to?.toISOString()).toBe("2026-03-02T21:00:00.000Z");
    expect(bounds.to!.getTime() - bounds.from!.getTime()).toBe(2 * DAY_MS);
    expect(sameDay.from?.toISOString()).toBe("2026-02-28T21:00:00.000Z");
    expect(sameDay.to?.toISOString()).toBe("2026-03-01T21:00:00.000Z");
  });

  it("still rejects an inverted custom range", () => {
    expect(() =>
      resolvePeriodBounds("custom", NOW, { from: "2026-03-10", to: "2026-03-01" }, UTC_TIME_ZONE)
    ).toThrow("Custom period requires from <= to, received 2026-03-10 > 2026-03-01");
  });
});

describe("custom comparison windows match the width of the inclusive current window", () => {
  it.each(CUSTOM_RANGE_CASES)("$name compares against the preceding $dayCount days", ({
    from,
    to,
    expectedFrom,
    dayCount,
  }) => {
    const custom = { from, to };
    const current = resolveRevenuePeriodBoundsForPlatform("fansly", "custom", NOW, custom);
    const currentWidthMs = current.to!.getTime() - current.from!.getTime();

    const comparisons = [
      resolveComparisonPeriodBounds("custom", NOW, custom, UTC_TIME_ZONE),
      resolveRevenueComparisonPeriodBoundsForPlatform("fansly", "custom", NOW, custom),
      resolveSpenderComparisonPeriodBoundsForPlatform("fansly", "custom", NOW, custom),
    ];

    for (const comparison of comparisons) {
      expect(comparison?.to?.toISOString()).toBe(expectedFrom);
      expect(comparison!.to!.getTime() - comparison!.from!.getTime()).toBe(currentWidthMs);
      expect(comparison!.to!.getTime() - comparison!.from!.getTime()).toBe(dayCount * DAY_MS);
      expect(comparison!.from!.getTime()).toBe(current.from!.getTime() - dayCount * DAY_MS);
    }
  });

  it("shifts the comparison window one day further back per day added to `to`", () => {
    const narrow = resolveRevenueComparisonPeriodBoundsForPlatform("fansly", "custom", NOW, {
      from: "2026-03-10",
      to: "2026-03-10",
    });
    const wide = resolveRevenueComparisonPeriodBoundsForPlatform("fansly", "custom", NOW, {
      from: "2026-03-10",
      to: "2026-03-11",
    });

    expect(narrow?.from?.toISOString()).toBe("2026-03-09T00:00:00.000Z");
    expect(narrow?.to?.toISOString()).toBe("2026-03-10T00:00:00.000Z");
    expect(wide?.from?.toISOString()).toBe("2026-03-08T00:00:00.000Z");
    expect(wide?.to?.toISOString()).toBe("2026-03-10T00:00:00.000Z");
  });
});

describe("custom day counts drive spender series granularity from the inclusive range", () => {
  it.each([
    { from: "2026-01-01", to: "2026-03-31", dayCount: 90, granularity: "day" },
    { from: "2026-01-01", to: "2026-04-01", dayCount: 91, granularity: "week" },
    { from: "2026-01-01", to: "2026-12-31", dayCount: 365, granularity: "week" },
    { from: "2026-01-01", to: "2027-01-01", dayCount: 366, granularity: "month" },
  ])("$from..$to counts $dayCount days and picks $granularity", ({
    from,
    to,
    dayCount,
    granularity,
  }) => {
    const range = resolveSpenderBusinessDateRangeForPlatform("fansly", "custom", NOW, { from, to });

    expect(range.fromBusinessDate).toBe(from);
    expect(range.toBusinessDateInclusive).toBe(to);
    expect(diffBusinessDays(range.fromBusinessDate!, range.toBusinessDateInclusive!)).toBe(dayCount);
    expect(
      resolveAutoSpenderSeriesGranularity(range.fromBusinessDate!, range.toBusinessDateInclusive!),
    ).toBe(granularity);
  });
});
