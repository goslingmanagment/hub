import { describe, expect, it } from "vitest";

import {
  SPENDER_AUTO_LIST_BUCKETS,
  SPENDER_STATS_INCLUDED_STATES,
  SPENDER_STATS_PAYER_MIN_LIFETIME_GROSS_MILLS,
  SPENDER_STATS_PURCHASE_TYPES,
  SPENDER_STATS_TRANSACTION_TYPES,
  assembleSpenderStatsDays,
  assembleSpenderStatsTiers,
  deriveSpenderStatsCoverage,
  resolveSpenderBusinessDateRangeForPlatform,
  resolveSpenderStatsWindows,
  spenderStatsAverageCheckMills,
  spenderStatsDeltaPct,
  sumSpenderStatsWindow,
  type SpenderStatsDayStateRow,
} from "@agency_hub_core/shared";

const AS_OF = new Date("2026-10-03T12:00:00.000Z");

describe("spender stats universe", () => {
  it("counts every state and every type the revenue rollups count", () => {
    expect([...SPENDER_STATS_INCLUDED_STATES].sort()).toEqual(["pending", "posted", "unknown"]);
    expect(SPENDER_STATS_TRANSACTION_TYPES).not.toContain("payout_reversal");
    expect(SPENDER_STATS_TRANSACTION_TYPES).toEqual(expect.arrayContaining(["refund", "chargeback", "other"]));
  });

  it("calls only revenue types purchases", () => {
    expect([...SPENDER_STATS_PURCHASE_TYPES].sort()).toEqual(
      ["message_purchase", "post_purchase", "stream_tip", "subscription", "tip"],
    );
    for (const type of SPENDER_STATS_PURCHASE_TYPES) {
      expect(SPENDER_STATS_TRANSACTION_TYPES).toContain(type);
    }
  });

  it("makes a payer exactly a member of the lowest spender bucket or above", () => {
    expect(SPENDER_STATS_PAYER_MIN_LIFETIME_GROSS_MILLS).toBe(10n);
    expect(SPENDER_STATS_PAYER_MIN_LIFETIME_GROSS_MILLS).toBe(SPENDER_AUTO_LIST_BUCKETS[0].minAmountMills);
  });
});

describe("resolveSpenderStatsWindows", () => {
  it("covers 30 local dates ending today, with disjoint 7-day windows inside", () => {
    const windows = resolveSpenderStatsWindows({ asOf: AS_OF, timeZone: "UTC" });

    expect(windows.windowDays).toBe(30);
    expect(windows.dates).toHaveLength(30);
    expect(windows.dates[0]).toBe("2026-09-04");
    expect(windows.dates[29]).toBe("2026-10-03");
    expect(new Set(windows.dates).size).toBe(30);
    expect([...windows.dates].sort()).toEqual(windows.dates);
    expect(windows.today).toEqual({ from: "2026-10-03", to: "2026-10-03" });
    expect(windows.d7).toEqual({ from: "2026-09-27", to: "2026-10-03" });
    expect(windows.prev7).toEqual({ from: "2026-09-20", to: "2026-09-26" });
    expect(windows.d30).toEqual({ from: "2026-09-04", to: "2026-10-03" });
    expect(windows.asOf).toBe(AS_OF);
  });

  it("matches the 30d window of /api/v2/spenders in UTC (not the 31-date revenue window)", () => {
    const windows = resolveSpenderStatsWindows({ asOf: AS_OF, timeZone: "UTC" });
    const spenders = resolveSpenderBusinessDateRangeForPlatform("onlyfans", "30d", AS_OF);

    expect(windows.d30).toEqual({
      from: spenders.fromBusinessDate,
      to: spenders.toBusinessDateInclusive,
    });
  });

  it("keeps whole calendar dates across a DST change", () => {
    const windows = resolveSpenderStatsWindows({
      asOf: new Date("2026-11-10T15:00:00.000Z"),
      timeZone: "America/New_York",
    });

    expect(windows.dates).toHaveLength(30);
    expect(windows.dates).toContain("2026-11-01");
    expect(windows.d30).toEqual({ from: "2026-10-12", to: "2026-11-10" });
  });

  it("refuses an unknown zone, an unsupported window and an invalid instant", () => {
    expect(() => resolveSpenderStatsWindows({ asOf: AS_OF, timeZone: "Mars/Olympus_Mons" })).toThrow(RangeError);
    expect(() => resolveSpenderStatsWindows({ asOf: AS_OF, timeZone: "UTC", windowDays: 7 })).toThrow(RangeError);
    expect(() => resolveSpenderStatsWindows({ asOf: new Date(Number.NaN), timeZone: "UTC" })).toThrow(RangeError);
  });
});

function row(input: Partial<SpenderStatsDayStateRow> & Pick<SpenderStatsDayStateRow, "date">): SpenderStatsDayStateRow {
  return {
    state: "posted",
    grossMills: 0n,
    purchasesGrossMills: 0n,
    creatorNetMills: 0n,
    purchaseCount: 0,
    ...input,
  };
}

describe("window money", () => {
  const windows = resolveSpenderStatsWindows({ asOf: AS_OF, timeZone: "UTC" });
  const days = assembleSpenderStatsDays(windows.dates, [
    row({ date: "2026-10-03", grossMills: 5_000n, purchasesGrossMills: 5_000n, creatorNetMills: 4_000n, purchaseCount: 1 }),
    row({ date: "2026-10-03", state: "pending", grossMills: 2_000n, purchasesGrossMills: 2_000n, creatorNetMills: 1_600n, purchaseCount: 1 }),
    // A refund: negative gross, not a purchase.
    row({ date: "2026-09-30", grossMills: -3_000n, creatorNetMills: -2_400n }),
    row({ date: "2026-09-25", grossMills: 10_000n, purchasesGrossMills: 10_000n, creatorNetMills: 8_000n, purchaseCount: 2 }),
    row({ date: "2026-09-04", state: "unknown", grossMills: 1_000n, purchasesGrossMills: 1_000n, creatorNetMills: 800n, purchaseCount: 1 }),
  ]);

  it("zero-fills every date and splits gross by state and by purchase", () => {
    expect(days).toHaveLength(30);
    expect(days.map((day) => day.date)).toEqual(windows.dates);
    const today = days.at(-1)!;
    expect(today.grossMills).toBe(7_000n);
    expect(today.byState).toEqual({ pending: 2_000n, posted: 5_000n, unknown: 0n });
    const refundDay = days.find((day) => day.date === "2026-09-30")!;
    expect(refundDay.purchasesGrossMills).toBe(0n);
    expect(refundDay.adjustmentsMills).toBe(-3_000n);
    for (const day of days) {
      expect(day.grossMills).toBe(day.purchasesGrossMills + day.adjustmentsMills);
      expect(Object.values(day.byState).reduce((sum, value) => sum + value, 0n)).toBe(day.grossMills);
    }
  });

  it("refuses an aggregate outside the window", () => {
    expect(() => assembleSpenderStatsDays(windows.dates, [row({ date: "2026-09-03", grossMills: 1n })]))
      .toThrow(RangeError);
  });

  it("sums each window from its own dates only", () => {
    const today = sumSpenderStatsWindow(days, windows.today, 2);
    const d7 = sumSpenderStatsWindow(days, windows.d7, 3);
    const prev7 = sumSpenderStatsWindow(days, windows.prev7, 1);
    const d30 = sumSpenderStatsWindow(days, windows.d30, 4);

    expect(today).toEqual({
      grossMills: 7_000n,
      purchasesGrossMills: 7_000n,
      adjustmentsMills: 0n,
      creatorNetMills: 5_600n,
      purchaseCount: 2,
      payerCount: 2,
    });
    expect(d7.grossMills).toBe(4_000n);
    expect(d7.adjustmentsMills).toBe(-3_000n);
    expect(prev7.grossMills).toBe(10_000n);
    expect(prev7.purchaseCount).toBe(2);
    expect(d30.grossMills).toBe(15_000n);
    expect(d30.purchasesGrossMills).toBe(18_000n);
    expect(d30.creatorNetMills).toBe(12_000n);
    expect(d30.purchaseCount).toBe(5);
    expect(d30.payerCount).toBe(4);
  });
});

describe("spenderStatsDeltaPct", () => {
  it("is null without a previous window", () => {
    expect(spenderStatsDeltaPct(5_000n, 0n)).toBeNull();
    expect(spenderStatsDeltaPct(0n, 0n)).toBeNull();
  });

  it("is the change in percent of the previous window", () => {
    expect(spenderStatsDeltaPct(15_000n, 10_000n)).toBe(50);
    expect(spenderStatsDeltaPct(5_000n, 10_000n)).toBe(-50);
    expect(spenderStatsDeltaPct(0n, 10_000n)).toBe(-100);
  });

  it("keeps the sign meaningful when the previous window was negative", () => {
    expect(spenderStatsDeltaPct(1_000n, -1_000n)).toBe(200);
  });
});

describe("spenderStatsAverageCheckMills", () => {
  it("is null without a purchase", () => {
    expect(spenderStatsAverageCheckMills(0n, 0)).toBeNull();
  });

  it("divides purchases gross by purchases, rounding once to whole mills", () => {
    expect(spenderStatsAverageCheckMills(18_000n, 5)).toBe(3_600n);
    expect(spenderStatsAverageCheckMills(10n, 3)).toBe(3n);
    expect(spenderStatsAverageCheckMills(20n, 3)).toBe(7n);
    expect(spenderStatsAverageCheckMills(5n, 2)).toBe(3n);
    expect(spenderStatsAverageCheckMills(-5n, 2)).toBe(-3n);
  });

  it("refuses a negative or fractional count", () => {
    expect(() => spenderStatsAverageCheckMills(10n, -1)).toThrow(RangeError);
    expect(() => spenderStatsAverageCheckMills(10n, 1.5)).toThrow(RangeError);
  });
});

describe("assembleSpenderStatsTiers", () => {
  it("lists every bucket in order, then the two remainders, so the rows sum to the total", () => {
    const tiers = assembleSpenderStatsTiers({
      byTierKey: new Map([
        ["0-25", { members: 10, windowPayers: 4, windowGrossMills: 30_000n }],
        ["600-plus", { members: 1, windowPayers: 1, windowGrossMills: 200_000n }],
      ]),
      untiered: { members: 2, windowPayers: 0, windowGrossMills: -5_000n },
      unattributedGrossMills: 7_000n,
    });

    expect(tiers.map((tier) => tier.key)).toEqual([
      ...SPENDER_AUTO_LIST_BUCKETS.map((bucket) => bucket.key),
      "untiered",
      "unattributed",
    ]);
    expect(tiers.reduce((sum, tier) => sum + tier.windowGrossMills, 0n)).toBe(232_000n);
    expect(tiers[0]).toEqual({
      key: "0-25",
      label: "[FB] $0-$25 Spenders",
      minMills: 10n,
      maxMills: 25_000n,
      members: 10,
      windowPayers: 4,
      windowGrossMills: 30_000n,
    });
    expect(tiers[1]).toMatchObject({ key: "25-50", members: 0, windowPayers: 0, windowGrossMills: 0n });
    expect(tiers[5]).toMatchObject({ key: "600-plus", minMills: 600_000n, maxMills: null });
    expect(tiers[7]).toEqual({
      key: "unattributed",
      label: "Unattributed",
      minMills: null,
      maxMills: null,
      members: 0,
      windowPayers: 0,
      windowGrossMills: 7_000n,
    });
  });

  it("refuses a tier the hub does not define", () => {
    expect(() => assembleSpenderStatsTiers({
      byTierKey: new Map([["1000-plus", { members: 1, windowPayers: 1, windowGrossMills: 1n }]]),
      untiered: { members: 0, windowPayers: 0, windowGrossMills: 0n },
      unattributedGrossMills: 0n,
    })).toThrow(RangeError);
  });
});

describe("deriveSpenderStatsCoverage", () => {
  const newest = new Date("2026-10-03T10:00:00.000Z");
  const rebuilt = new Date("2026-10-03T11:00:00.000Z");
  const complete = {
    newestTransactionAt: newest,
    historyBeforeWindow: true,
    projectionAsOf: rebuilt,
    payerCount: 5,
    hasArchivedMessages: true,
  };

  it("is complete for a page whose projection was built and that earned nothing", () => {
    expect(deriveSpenderStatsCoverage({
      newestTransactionAt: null,
      historyBeforeWindow: false,
      projectionAsOf: rebuilt,
      payerCount: 0,
      hasArchivedMessages: false,
    })).toEqual({ state: "complete", reasons: [] });
  });

  it("is partial while the projection is missing or behind", () => {
    expect(deriveSpenderStatsCoverage({ ...complete, projectionAsOf: null }))
      .toEqual({ state: "partial", reasons: ["projection_missing"] });
    expect(deriveSpenderStatsCoverage({ ...complete, projectionAsOf: new Date("2026-10-03T09:00:00.000Z") }))
      .toEqual({ state: "partial", reasons: ["projection_behind"] });
  });
});
