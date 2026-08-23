import { describe, expect, it } from "vitest";

import { buildFypMediaViewSummary } from
  "../apps/dashboard/src/components/analytics/traffic-metrics.ts";

describe("Analytics FYP media share", () => {
  it("matches Fansly by combining full and preview views for each lane", () => {
    const summary = buildFypMediaViewSummary([
      {
        bucketStart: "2026-08-21T00:00:00.000Z",
        sourceLabel: "fyp",
        views: 17_255,
        previewViews: 1,
      },
      {
        bucketStart: "2026-08-21T00:00:00.000Z",
        sourceLabel: "direct",
        views: 24_011,
        previewViews: 5_041,
      },
    ]);

    expect(summary.series).toEqual([{
      bucketStart: "2026-08-21T00:00:00.000Z",
      fyp: 17_256,
      direct: 29_052,
    }]);
    expect(summary.sharePercent).toBeCloseTo(37.2635397778, 8);
  });

  it("does not turn an absent full or preview counter into zero", () => {
    const summary = buildFypMediaViewSummary([
      {
        bucketStart: "2026-08-21T00:00:00.000Z",
        sourceLabel: "fyp",
        views: 12,
        previewViews: null,
      },
      {
        bucketStart: "2026-08-21T00:00:00.000Z",
        sourceLabel: "direct",
        views: null,
        previewViews: 3,
      },
    ]);

    expect(summary.series).toEqual([]);
    expect(summary.sharePercent).toBeNull();
  });
});
