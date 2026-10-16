import type { StatsTrafficResponse } from "@agency_hub_core/contracts";

import { bucketKey, bucketTimeline } from "@/components/charts/scale";

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
    const source = row.sourceLabel === "fyp" ? "fyp" : row.sourceLabel === "direct" ? "direct" : null;
    if (source === null || row.views === null || row.previewViews === null) {
      // Fansly's widget uses BOTH counters. If either is absent, the combined
      // count is unknown; treating the missing member as zero would invent it.
      continue;
    }
    const combinedViews = row.views + row.previewViews;
    served = true;
    const bucket = buckets.get(row.bucketStart)
      ?? { bucketStart: row.bucketStart, fyp: 0, direct: 0 };
    bucket[source] += combinedViews;
    buckets.set(row.bucketStart, bucket);
    if (source === "fyp") {
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
    fypTotal: served ? fypTotal : null,
    directTotal: served ? directTotal : null,
  };
}

/** One point of a chart drawn over a dense timeline. A key that is absent
 *  (or null) is a value nobody measured: the chart leaves a hole there. */
export type TimelinePoint = { bucketStart: string } & Record<string, number | null | string>;

/**
 * The served buckets laid out on the WHOLE window: every bucket of
 * `[from, to)`, with the ones the response did not carry left empty — a hole
 * at its place in time, never a zero and never squeezed out of the axis.
 */
export function onTimeline<T extends { bucketStart: string }>(
  window: { from: string; to: string; periodMs: number },
  served: readonly T[],
): Array<T | { bucketStart: string }> {
  const byKey = new Map(served.map((point) => [bucketKey(point.bucketStart), point]));
  return bucketTimeline(window, window.periodMs, byKey.keys()).map((key) => {
    const point = byKey.get(key);
    return point === undefined ? { bucketStart: key } : { ...point, bucketStart: key };
  });
}

export type TrafficMeasure = "visits" | "dwell";

/** The four profile families this build can name, in the §2.1 census order. */
export const TRAFFIC_FAMILY_KEYS = ["10000", "44000", "44010", "44030"] as const;
export const UNKNOWN_SOURCE_KEY = "unknown";

/**
 * Panel 1's chart rows: one per bucket of the window, one key per family.
 *
 * TWO KINDS OF "NOTHING", AND THEY ARE NOT THE SAME FACT.
 *
 * - A bucket the response carries no row for at all is a day Hub holds
 *   nothing about. It stays EMPTY — the chart shows a hole.
 * - A family missing from a bucket that DID come back is a zero. Fansly's
 *   `profileDatapoints[].stats[]` lists only the sources that had traffic that
 *   day: the live 31-bucket capture carried Direct on 31 days and Suggestions
 *   on 18 (reference/fansly_api_spec.md §3.18). Leaving those holes in a STACK
 *   is what cut the layers into cliffs; the platform's own chart reads them as
 *   zero, and so does this one.
 *
 * A row that WAS served but carries no value for the measure stays null: the
 * platform sent the source and withheld the metric, and that is not a zero.
 *
 * A code this build cannot name — and a family it has no series for — goes to
 * the "unknown" layer (A1: surfaced, never dropped), which is drawn only when
 * some bucket actually carries one.
 */
export function buildTrafficSourceRows(
  response: Pick<StatsTrafficResponse, "rows" | "window"> | undefined,
  measure: TrafficMeasure,
): { rows: TimelinePoint[]; keys: string[]; servedBuckets: number } {
  if (response === undefined) {
    return { rows: [], keys: [], servedBuckets: 0 };
  }
  const known = new Set<string>(TRAFFIC_FAMILY_KEYS);
  const buckets = new Map<string, Map<string, number | null>>();
  let sawUnknown = false;

  for (const row of response.rows) {
    const named = row.measure !== null && row.family !== null && known.has(row.family);
    if (named && row.measure !== measure) {
      continue;
    }
    const key = named ? row.family! : UNKNOWN_SOURCE_KEY;
    sawUnknown ||= key === UNKNOWN_SOURCE_KEY;
    const bucketStart = bucketKey(row.bucketStart);
    const bucket = buckets.get(bucketStart) ?? new Map<string, number | null>();
    buckets.set(bucketStart, bucket);
    const value = measure === "visits" ? row.views : row.interactionTimeMs;
    const current = bucket.get(key);
    // NULL IS NOT ZERO: a withheld metric adds nothing, and only turns into a
    // number if another row of the same source in this bucket carries one.
    bucket.set(key, value === null ? current ?? null : (current ?? 0) + value);
  }

  const keys: string[] = [...TRAFFIC_FAMILY_KEYS];
  if (sawUnknown) {
    keys.push(UNKNOWN_SOURCE_KEY);
  }
  const rows = bucketTimeline(response.window, response.window.periodMs, buckets.keys())
    .map((bucketStart): TimelinePoint => {
      const bucket = buckets.get(bucketStart);
      const point: TimelinePoint = { bucketStart };
      if (bucket === undefined) {
        return point;
      }
      for (const key of keys) {
        // Served bucket, absent source: Fansly lists only sources with traffic.
        point[key] = bucket.has(key) ? bucket.get(key)! : 0;
      }
      return point;
    });
  return { rows, keys, servedBuckets: buckets.size };
}

/** True while the bucket's day is still running: its numbers are not final. */
export function bucketInProgress(bucketStart: string, periodMs: number, now = Date.now()): boolean {
  const start = Date.parse(bucketStart);
  return Number.isFinite(start) && start + periodMs > now;
}
