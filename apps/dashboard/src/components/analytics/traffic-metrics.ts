import type { StatsTrafficResponse } from "@agency_hub_core/contracts";

type TrafficRow = StatsTrafficResponse["rows"][number];

export type FypMediaViewRow = Pick<
  TrafficRow,
  "bucketStart" | "sourceLabel" | "views" | "previewViews"
>;

export function buildFypMediaViewSummary(rows: readonly FypMediaViewRow[]) {
  const buckets = new Map<string, { bucketStart: string; fyp: number; direct: number }>();
  let fypTotal = 0;
  let directTotal = 0;
  let served = false;

  for (const row of rows) {
    const lane = row.sourceLabel === "fyp" ? "fyp" : row.sourceLabel === "direct" ? "direct" : null;
    if (lane === null || row.views === null || row.previewViews === null) {
      // Fansly's widget uses BOTH counters. If either is absent, the combined
      // count is unknown; treating the missing member as zero would invent it.
      continue;
    }
    const combinedViews = row.views + row.previewViews;
    served = true;
    const bucket = buckets.get(row.bucketStart)
      ?? { bucketStart: row.bucketStart, fyp: 0, direct: 0 };
    bucket[lane] += combinedViews;
    buckets.set(row.bucketStart, bucket);
    if (lane === "fyp") {
      fypTotal += combinedViews;
    } else {
      directTotal += combinedViews;
    }
  }

  const totalViews = fypTotal + directTotal;
  const sharePercent = served && totalViews > 0
    ? (fypTotal / totalViews) * 100
    : null;
  return {
    series: [...buckets.values()].sort((left, right) =>
      left.bucketStart.localeCompare(right.bucketStart)),
    sharePercent,
  };
}
