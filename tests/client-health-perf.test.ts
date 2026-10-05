import { describe, expect, it } from "vitest";

import { CLIENT_HEALTH_PERF_METRICS } from "@agency_hub_core/contracts";

import {
  CLIENT_HEALTH_MIN_GROUP_SIZE,
  clientHealthHistogramFits,
  clientHealthP50P95,
  clientHealthPercentile,
} from "../apps/runtime/src/services/client-health-perf.ts";

// The hub reads percentiles off merged buckets (H-11a helper, used by the
// owner's view in H-11c): linear inside a bucket, the first bucket from 0, the
// overflow bucket topped by the observed max, never above that max.

describe("client_health percentiles", () => {
  it("is null for an empty histogram", () => {
    expect(clientHealthPercentile({ bounds: [10], counts: [0, 0], max: 0 }, 0.5)).toBeNull();
  });

  it("interpolates linearly inside a bucket", () => {
    const buckets = { bounds: [10, 20], counts: [0, 10, 0], max: 20 };
    expect(clientHealthPercentile(buckets, 0.5)).toBe(15);
    expect(clientHealthPercentile(buckets, 0.95)).toBeCloseTo(19.5, 10);
    expect(clientHealthPercentile(buckets, 0)).toBe(10);
    expect(clientHealthPercentile(buckets, 1)).toBe(20);
  });

  it("starts the first bucket at 0", () => {
    expect(clientHealthPercentile({ bounds: [10], counts: [4, 0], max: 9.5 }, 0.5)).toBe(5);
  });

  it("tops the overflow bucket at the observed max", () => {
    const buckets = { bounds: [10], counts: [0, 2], max: 30 };
    expect(clientHealthPercentile(buckets, 0.5)).toBe(20);
    expect(clientHealthPercentile(buckets, 1)).toBe(30);
  });

  it("never reports above the observed max", () => {
    expect(clientHealthPercentile({ bounds: [10, 100], counts: [0, 1, 0], max: 12 }, 0.95)).toBe(12);
  });

  it("walks the buckets by rank and grows with q", () => {
    // 20 values: 10 at ≤ 4 ms, 9 in (4, 8], 1 in (8, 16] at 9 ms.
    const buckets = { bounds: [4, 8, 16], counts: [10, 9, 1, 0], max: 9 };
    expect(clientHealthPercentile(buckets, 0.5)).toBe(4);
    expect(clientHealthPercentile(buckets, 0.95)).toBeCloseTo(4 + (9 / 9) * 4, 10);
    expect(clientHealthPercentile(buckets, 0.99)).toBe(9);
    let previous = -1;
    for (let q = 0; q <= 1.000001; q += 0.05) {
      const value = clientHealthPercentile(buckets, Math.min(q, 1))!;
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("reads merged buckets, not an average of the parts' percentiles", () => {
    const { bounds } = CLIENT_HEALTH_PERF_METRICS.insertMs; // [4, 8, 16, 32, 50, 75, …]
    const fast = { bounds, counts: [10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], max: 4 }; // 10 × ≤ 4 ms
    const slow = { bounds, counts: [0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0], max: 75 }; // 10 × (50, 75] ms
    const merged = { bounds, counts: fast.counts.map((bucket, index) => bucket + slow.counts[index]!), max: 75 };

    const p95 = clientHealthPercentile(merged, 0.95)!;
    // rank 19 of 20 lands in the slow bucket, 9/10 of the way up: 50 + 0.9 × 25.
    expect(p95).toBeCloseTo(72.5, 10);
    const averagedParts = (clientHealthPercentile(fast, 0.95)! + clientHealthPercentile(slow, 0.95)!) / 2;
    expect(averagedParts).toBeLessThan(50);
  });

  it("refuses q outside [0, 1] and counts that do not fit the bounds", () => {
    for (const q of [-0.1, 1.1, Number.NaN]) {
      expect(() => clientHealthPercentile({ bounds: [10], counts: [1, 0], max: 1 }, q), String(q)).toThrow(RangeError);
    }
    expect(() => clientHealthPercentile({ bounds: [10, 20], counts: [1, 0], max: 1 }, 0.5)).toThrow(RangeError);
  });
});

describe("client_health group suppression", () => {
  it("suppresses a group under 20 observations", () => {
    expect(CLIENT_HEALTH_MIN_GROUP_SIZE).toBe(20);
    expect(clientHealthP50P95({ bounds: [10], counts: [19, 0], max: 9 }))
      .toEqual({ p50: null, p95: null, suppressed: true });
    expect(clientHealthP50P95({ bounds: [10], counts: [0, 0], max: 0 }))
      .toEqual({ p50: null, p95: null, suppressed: true });
  });

  it("shows p50 and p95 from 20 observations on", () => {
    expect(clientHealthP50P95({ bounds: [10], counts: [20, 0], max: 10 }))
      .toEqual({ p50: 5, p95: 9.5, suppressed: false });
  });
});

describe("client_health histogram fit (the intake drops one that does not fit)", () => {
  /** Bounds [10, 20]: buckets ≤ 10, (10, 20], > 20. */
  const fits = (counts: number[], sum: number, max: number) => clientHealthHistogramFits({ bounds: [10, 20], counts, sum, max });

  it("takes an empty histogram only with sum 0 and max 0", () => {
    expect(fits([0, 0, 0], 0, 0)).toBe(true);
    expect(fits([0, 0, 0], 5, 0)).toBe(false);
    expect(fits([0, 0, 0], 0, 7)).toBe(false);
  });

  it("wants max in the highest non-empty bucket", () => {
    expect(fits([1, 1, 0], 20, 15)).toBe(true);
    // max above the last bound while the overflow bucket is empty.
    expect(fits([1, 0, 0], 5, 9999)).toBe(false);
    // An observation in the overflow bucket, max at or below the last bound.
    expect(fits([0, 0, 1], 20, 20)).toBe(false);
    // count > 0 with max 0 above the first bucket.
    expect(fits([0, 3, 0], 0, 0)).toBe(false);
    // max inside a lower bucket than the highest non-empty one.
    expect(fits([1, 1, 0], 10, 9)).toBe(false);
    // All observations 0 ms: the first bucket, max 0, sum 0.
    expect(fits([4, 0, 0], 0, 0)).toBe(true);
  });

  it("wants a sum the buckets and max can hold", () => {
    // Two observations in (10, 20] and the max, 30, in the overflow: sum lies in (50, 70].
    expect(fits([0, 2, 1], 65, 30)).toBe(true);
    expect(fits([0, 2, 1], 51, 30)).toBe(true);
    expect(fits([0, 2, 1], 71, 30)).toBe(false);
    expect(fits([0, 2, 1], 49, 30)).toBe(false);
    expect(fits([0, 2, 1], 1e300, 30)).toBe(false);
    // The sum holds the max itself.
    expect(fits([2, 0, 0], 4, 6)).toBe(false);
  });

  it("takes a histogram built the client's way, floating-point sum included", () => {
    const { bounds } = CLIENT_HEALTH_PERF_METRICS.handlerMs; // [0.1, 0.5, 1, …]
    const samples = [0.05, 0.1, 0.3, 0.30000000000000004, 7, 120];
    const counts: number[] = Array.from({ length: bounds.length + 1 }, () => 0);
    for (const sample of samples) {
      const index = bounds.findIndex((bound) => sample <= bound);
      counts[index === -1 ? bounds.length : index]! += 1;
    }
    const sum = samples.reduce((total, sample) => total + sample, 0);
    expect(clientHealthHistogramFits({ bounds, counts, sum, max: 120 })).toBe(true);
  });

  it("takes the client's rounding: sum to three decimals, max as measured", () => {
    /** One histogram as the client sends it (its Histogram.toWire). */
    const wire = (bounds: readonly number[], samples: number[]) => {
      const counts: number[] = Array.from({ length: bounds.length + 1 }, () => 0);
      for (const sample of samples) {
        const index = bounds.findIndex((bound) => sample <= bound);
        counts[index === -1 ? bounds.length : index]! += 1;
      }
      const sum = Math.round(samples.reduce((total, sample) => total + sample, 0) * 1000) / 1000;
      return { bounds, counts, sum, max: Math.max(...samples) };
    };
    const panel = CLIENT_HEALTH_PERF_METRICS.panelOpenMs.bounds;
    const handler = CLIENT_HEALTH_PERF_METRICS.handlerMs.bounds;

    // One sample: the rounded sum lands above the max it is made of…
    expect(wire(panel, [37.4567891])).toMatchObject({ sum: 37.457, max: 37.4567891 });
    expect(clientHealthHistogramFits(wire(panel, [37.4567891]))).toBe(true);
    // …or below it, down to 0.
    expect(wire(handler, [0.0004])).toMatchObject({ sum: 0, max: 0.0004 });
    expect(clientHealthHistogramFits(wire(handler, [0.0004]))).toBe(true);
    // Samples just above a bucket edge, where the least sum is the samples themselves.
    expect(clientHealthHistogramFits(wire(panel, [50.0004, 50.0004, 50.0004]))).toBe(true);

    // Three tabs, one sample each: the background adds up three rounded sums.
    const tabs = [37.4567891, 37.4567891, 37.4567891].map((sample) => wire(panel, [sample]));
    const merged = {
      bounds: panel,
      counts: tabs[0]!.counts.map((_, index) => tabs.reduce((total, tab) => total + tab.counts[index]!, 0)),
      sum: Math.round(tabs.reduce((total, tab) => total + tab.sum, 0) * 1000) / 1000,
      max: 37.4567891,
    };
    expect(merged.sum).toBe(112.371);
    expect(clientHealthHistogramFits(merged)).toBe(true);
  });

  it("allows a thousandth per observation for that rounding and no more", () => {
    // Two observations in (10, 20] and the max, 30, in the overflow: sum lies in (50, 70].
    expect(fits([0, 2, 1], 70.003, 30)).toBe(true);
    expect(fits([0, 2, 1], 70.01, 30)).toBe(false);
    expect(fits([0, 2, 1], 49.997, 30)).toBe(true);
    expect(fits([0, 2, 1], 49.99, 30)).toBe(false);
    // One observation, the max itself: the sum is the max, give or take one rounding.
    expect(fits([1, 0, 0], 6.001, 6)).toBe(true);
    expect(fits([1, 0, 0], 6.01, 6)).toBe(false);
    expect(fits([1, 0, 0], 5.99, 6)).toBe(false);
  });
});
