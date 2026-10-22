import { describe, expect, it } from "vitest";

import {
  parseSeriesAnswer,
  parseSummaryAnswer,
  previousSpan,
  trailingDays,
} from "../apps/runtime/src/sync/fansly/lib/creator-stats.ts";

// Fansly's creator statistics (reference/fansly-creator-stats): the money of a
// revenue answer and the history walk's spans.

const DAY = 86_400_000;
const D = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

describe("creator statistics answers", () => {
  it("reads revenue rows as mills per bucket and product type, keeping a missing counter null", () => {
    const answer = parseSeriesAnswer({
      family: "revenue",
      granularity: "hour",
      bucketField: "hourBucket",
      afterBucket: D("2026-09-17"),
      beforeBucket: D("2026-09-17"),
      rows: [
        { productType: 7101, hourBucket: "1789686000000", transactions: 2, grossMills: 5000, netMills: 4000, refunds: 0, refundedGrossMills: 0 },
        { hourBucket: "1789689600000", transactions: 1, grossMills: 1000, netMills: 800 },
      ],
    }, "revenue", "hour");
    expect(answer).toMatchObject({ family: "revenue", skipped: 1, served: { afterMs: D("2026-09-17"), beforeMs: D("2026-09-17") } });
    expect(answer?.rows).toEqual([{
      bucketStart: new Date(1_789_686_000_000),
      productType: 7101,
      transactions: 2,
      grossMills: 5000n,
      netMills: 4000n,
      refunds: 0,
      refundedGrossMills: 0n,
      refundedNetMills: null,
    }]);
    expect(parseSeriesAnswer({ family: "views", granularity: "hour", rows: [] }, "revenue", "hour")).toBeNull();
  });

  it("reads the summary's levels, tier levels, media likes and window totals", () => {
    const summary = parseSummaryAnswer({
      afterBucket: D("2026-09-22"),
      beforeBucket: D("2026-10-21"),
      dataSince: D("2025-01-01"),
      levels: [{ bucket: D("2026-10-21"), followerCount: 1200, subscriberCount: 65 }],
      revenue: { payingFans: { value: 143, previous: 32, delta: 111, deltaPercent: 346.875 }, byProductType: [] },
      subscriptions: {
        byTier: [{ tierId: "928", tierName: "friend", tierPos: 0, tierActive: true, levels: [{ bucket: D("2026-10-21"), subscriberCount: 65 }] }],
      },
      engagement: { mediaLikes: [{ source: 0, likes: { value: 10, previous: 2 }, series: { likes: [{ bucket: D("2026-10-21"), value: 4 }] } }] },
      views: [{ source: 1, uniqueViewers: { value: 900, previous: 700 }, uniquesApproximate: true }],
    });
    expect(summary?.levels).toEqual([{ day: "2026-10-21", followerCount: 1200, subscriberCount: 65 }]);
    expect(summary?.tierLevels).toEqual([{ tierId: "928", day: "2026-10-21", subscriberCount: 65 }]);
    expect(summary?.engagement).toEqual([{ day: "2026-10-21", metric: "media_likes", source: 0, value: 4 }]);
    expect(summary?.windowTotals).toEqual(expect.arrayContaining([
      { scope: "revenue", ref: "", metric: "payingFans", value: "143", previous: "32" },
      { scope: "views", ref: "1", metric: "uniqueViewers", value: "900", previous: "700" },
      { scope: "views", ref: "1", metric: "uniquesApproximate", value: "1", previous: null },
      { scope: "engagement", ref: "0", metric: "likes", value: "10", previous: "2" },
    ]));
    expect(summary?.dataSince).toBe(D("2025-01-01"));
  });
});

describe("creator statistics windows", () => {
  it("walks back in spans of at most 400 days that stop at the floor", () => {
    const today = trailingDays(new Date("2026-10-22T15:30:00Z"), 400);
    expect(today).toEqual({ afterMs: D("2026-10-22") - 399 * DAY, beforeMs: D("2026-10-22") });
    const floor = D("2024-03-10");
    const first = previousSpan(today.afterMs, floor);
    expect(first).toEqual({ afterMs: today.afterMs - 400 * DAY, beforeMs: today.afterMs - DAY });
    const second = previousSpan(first!.afterMs, floor);
    expect(second).toEqual({ afterMs: floor, beforeMs: first!.afterMs - DAY });
    expect(previousSpan(second!.afterMs, floor)).toBeNull();
  });
});
