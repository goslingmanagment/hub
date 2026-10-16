import { describe, expect, it } from "vitest";

import { followPages } from "../apps/dashboard/src/lib/paging.ts";
import {
  bucketTimeline,
  businessDateRange,
  durationTicks,
  evenTickIndices,
  linearTicks,
  niceStep,
  stackedExtent,
  tickBudget,
} from "../apps/dashboard/src/components/charts/scale.ts";
import { everyDay } from "../apps/dashboard/src/components/page/PageActivityChart.tsx";
import {
  buildTrafficSourceRows,
  onTimeline,
} from "../apps/dashboard/src/components/analytics/traffic-metrics.ts";

const DAY = 86_400_000;

describe("chart value ticks", () => {
  it("steps on round numbers, not on one significant digit", () => {
    // recharts' own ticks for this axis were 0 · 7 · 14 · 21 · 28.
    expect(linearTicks(0, 28, { integer: true }).ticks).toEqual([0, 10, 20, 30]);
    expect(linearTicks(0, 200, { integer: true }).ticks).toEqual([0, 50, 100, 150, 200]);
    expect(linearTicks(0, 1_950, { integer: true }).ticks).toEqual([0, 500, 1_000, 1_500, 2_000]);
  });

  it("keeps whole counts whole", () => {
    expect(niceStep(0.4, true)).toBe(1);
    expect(niceStep(2.3, true)).toBe(5);
    expect(linearTicks(0, 3, { integer: true }).ticks).toEqual([0, 1, 2, 3]);
  });

  it("reaches below zero for a refund and always includes zero", () => {
    const scale = linearTicks(-1_200, 4_800);
    expect(scale.ticks).toContain(0);
    expect(scale.domain[0]).toBeLessThanOrEqual(-1_200);
    expect(scale.domain[1]).toBeGreaterThanOrEqual(4_800);
  });

  it("draws an all-zero series on a finite axis", () => {
    expect(linearTicks(0, 0)).toEqual({ domain: [0, 1], ticks: [0, 1] });
  });

  it("steps durations on clock-shaped intervals", () => {
    const minute = 60_000;
    expect(durationTicks(50 * minute).ticks).toEqual([0, 15 * minute, 30 * minute, 45 * minute, 60 * minute]);
    expect(durationTicks(5 * 60 * minute).ticks.at(-1)).toBe(6 * 60 * minute);
  });

  it("sums the stack per side", () => {
    expect(stackedExtent([{ a: 3, b: 4, c: -2 }, { a: 10, b: null }], ["a", "b", "c"]))
      .toEqual({ min: -2, max: 10 });
  });
});

describe("chart date ticks", () => {
  it("labels at a constant step, always including the newest bucket", () => {
    const indices = evenTickIndices(30, 6);
    expect(indices.at(-1)).toBe(29);
    const steps = new Set(indices.slice(1).map((index, at) => index - indices[at]!));
    expect(steps.size).toBe(1);
    expect(indices.length).toBeLessThanOrEqual(6);
  });

  it("labels every day of a week", () => {
    expect(evenTickIndices(7, 10)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("fits the label budget to the width", () => {
    expect(tickBudget(0)).toBe(6);
    expect(tickBudget(300)).toBe(4);
    expect(tickBudget(3_000)).toBe(10);
  });
});

describe("chart timeline", () => {
  const window = { from: "2026-09-16T10:23:00.000Z", to: "2026-09-20T10:23:00.000Z" };

  it("spans the window asked for, on UTC days", () => {
    expect(bucketTimeline(window, DAY, [])).toEqual([
      "2026-09-17T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
      "2026-09-19T00:00:00.000Z",
      "2026-09-20T00:00:00.000Z",
    ]);
  });

  it("never loses a served bucket that sits off the grid", () => {
    expect(bucketTimeline(window, DAY, ["2026-09-18T04:00:00Z"])).toContain("2026-09-18T04:00:00.000Z");
  });

  it("lists business dates inclusively", () => {
    expect(businessDateRange("2026-09-29", "2026-10-02"))
      .toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
  });

  it("leaves an uncaptured bucket empty rather than squeezing it out", () => {
    const points = onTimeline({ ...window, periodMs: DAY }, [
      { bucketStart: "2026-09-17T00:00:00.000Z", fyp: 3, direct: 4 },
      { bucketStart: "2026-09-19T00:00:00.000Z", fyp: 1, direct: 0 },
    ]);
    expect(points).toHaveLength(4);
    expect(points[1]).toEqual({ bucketStart: "2026-09-18T00:00:00.000Z" });
    expect(points[2]).toMatchObject({ fyp: 1, direct: 0 });
  });

  it("zero-fills only the days between a page detail series' ends", () => {
    expect(everyDay([
      { businessDate: "2026-10-03", value: 5 },
      { businessDate: "2026-10-01", value: 2 },
    ])).toEqual([
      { businessDate: "2026-10-01", value: 2 },
      { businessDate: "2026-10-02", value: 0 },
      { businessDate: "2026-10-03", value: 5 },
    ]);
  });
});

function trafficRow(overrides: {
  bucketStart: string;
  sourceCode: string;
  family: string | null;
  measure: "visits" | "dwell" | null;
  views: number | null;
  interactionTimeMs?: number | null;
}) {
  return {
    subjectKind: "account_profile",
    subjectRef: "",
    periodMs: DAY,
    sourceLabel: "x",
    mappingVersion: 2,
    familyLabel: null,
    previewViews: null,
    uniqueViewers: null,
    previewUniqueViewers: null,
    videoViews: null,
    previewVideoViews: null,
    previewInteractionTimeMs: null,
    videoPercentWatchedSum: null,
    previewVideoPercentWatchedSum: null,
    revisionCount: 1,
    lastObservedAt: "2026-09-20T00:00:00.000Z",
    interactionTimeMs: null,
    ...overrides,
  };
}

describe("traffic by source rows", () => {
  const window = {
    from: "2026-09-16T10:23:00.000Z",
    to: "2026-09-19T10:23:00.000Z",
    periodMs: DAY,
    subjectKind: "account_profile",
    subjectRef: null,
  };

  it("reads a source absent from a served day as zero and an unserved day as a hole", () => {
    const { rows, keys, servedBuckets } = buildTrafficSourceRows({
      window,
      rows: [
        trafficRow({ bucketStart: "2026-09-17T00:00:00.000Z", sourceCode: "10001", family: "10000", measure: "visits", views: 12 }),
        trafficRow({ bucketStart: "2026-09-17T00:00:00.000Z", sourceCode: "10000", family: "10000", measure: "dwell", views: 9, interactionTimeMs: 4_000 }),
        trafficRow({ bucketStart: "2026-09-19T00:00:00.000Z", sourceCode: "44011", family: "44010", measure: "visits", views: 2 }),
      ],
    }, "visits");

    expect(keys).toEqual(["10000", "44000", "44010", "44030"]);
    expect(servedBuckets).toBe(2);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ bucketStart: "2026-09-17T00:00:00.000Z", 10000: 12, 44000: 0, 44010: 0, 44030: 0 });
    expect(rows[1]).toEqual({ bucketStart: "2026-09-18T00:00:00.000Z" });
    expect(rows[2]).toMatchObject({ 10000: 0, 44010: 2 });
  });

  it("keeps a withheld metric null, and surfaces a code it cannot name", () => {
    const { rows, keys } = buildTrafficSourceRows({
      window,
      rows: [
        trafficRow({ bucketStart: "2026-09-17T00:00:00.000Z", sourceCode: "10001", family: "10000", measure: "visits", views: null }),
        trafficRow({ bucketStart: "2026-09-17T00:00:00.000Z", sourceCode: "45001", family: "45000", measure: null, views: 7 }),
      ],
    }, "visits");

    expect(keys).toContain("unknown");
    expect(rows[0]).toMatchObject({ 10000: null, unknown: 7 });
  });
});

describe("following a keyset-paged window", () => {
  it("joins every page until the cursor runs out", async () => {
    const cursors: Array<string | undefined> = [];
    const result = await followPages(
      async (cursor) => {
        cursors.push(cursor);
        const index = cursor === undefined ? 0 : Number(cursor);
        return { rows: [index], nextCursor: index < 2 ? String(index + 1) : null };
      },
      (first, pages) => ({ ...first, rows: pages.flatMap((page) => page.rows), nextCursor: pages.at(-1)!.nextCursor }),
    );
    expect(cursors).toEqual([undefined, "1", "2"]);
    expect(result).toEqual({ rows: [0, 1, 2], nextCursor: null });
  });

  it("stops at its page cap and leaves the cut visible", async () => {
    let calls = 0;
    const result = await followPages(
      async () => {
        calls += 1;
        return { rows: [calls], nextCursor: "more" };
      },
      (first, pages) => ({ ...first, rows: pages.flatMap((page) => page.rows), nextCursor: pages.at(-1)!.nextCursor }),
    );
    expect(calls).toBe(10);
    expect(result.nextCursor).toBe("more");
  });
});
