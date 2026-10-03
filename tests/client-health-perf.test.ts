import { describe, expect, it } from "vitest";

import { CLIENT_HEALTH_PERF_METRICS } from "@agency_hub_core/contracts";

import {
  CLIENT_HEALTH_MIN_GROUP_SIZE,
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
