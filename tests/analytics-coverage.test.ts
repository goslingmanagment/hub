import { describe, expect, it } from "vitest";

import type { StatsCoverageResponse } from "@agency_hub_core/contracts";
import {
  ANALYTICS_COVERAGE_PLANES,
  CAPTURE_COVERAGE_PLANES,
} from "@agency_hub_core/shared";

import { coverageVerdict } from
  "../apps/dashboard/src/components/analytics/coverage.ts";

type CoverageRow = StatsCoverageResponse["planes"][number];

function row(overrides: Partial<CoverageRow> = {}): CoverageRow {
  return {
    plane: CAPTURE_COVERAGE_PLANES.statsAccountDaily,
    scopeRef: "",
    status: "window_captured",
    acquisitionMode: "retroactive",
    proof: "terminal_response",
    oldestCapturedAt: "2026-05-01T00:00:00.000Z",
    newestCapturedAt: "2026-08-23T00:00:00.000Z",
    expectedCount: null,
    observedUniqueCount: null,
    reasonCode: null,
    nextProbeAt: null,
    updatedAt: "2026-08-23T00:05:00.000Z",
    ...overrides,
  };
}

const window30d = {
  from: "2026-07-24T00:00:00.000Z",
  to: "2026-08-23T00:00:00.000Z",
};

describe("analytics capture coverage", () => {
  it("uses the same exported plane names as capture and every dashboard panel", () => {
    expect(CAPTURE_COVERAGE_PLANES).toMatchObject({
      statsAccountDaily: "stats_account_daily",
      statsAccountHourly: "stats_account_hourly",
      statsEarnings: "stats_earnings",
      mediaStats: "media_stats",
      catalog: "catalog",
      postReplies: "post_replies",
    });
    expect(ANALYTICS_COVERAGE_PLANES.traffic).toEqual([
      CAPTURE_COVERAGE_PLANES.statsAccountDaily,
    ]);
    expect(ANALYTICS_COVERAGE_PLANES.revenue).toEqual([
      CAPTURE_COVERAGE_PLANES.statsEarnings,
    ]);
    expect(ANALYTICS_COVERAGE_PLANES.contentPerformance).toEqual([
      CAPTURE_COVERAGE_PLANES.catalog,
      CAPTURE_COVERAGE_PLANES.mediaStats,
    ]);
  });

  it("accepts a fully covered selected window even when the global walk is not exhausted", () => {
    expect(coverageVerdict(
      [row()],
      ANALYTICS_COVERAGE_PLANES.traffic,
      window30d,
    )).toMatchObject({ state: "complete", label: "complete for 30-day window" });
  });

  it("marks an exhausted floor stale when the head was not refreshed", () => {
    expect(coverageVerdict(
      [row({
        status: "provider_exhausted",
        newestCapturedAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:05:00.000Z",
      })],
      ANALYTICS_COVERAGE_PLANES.traffic,
      window30d,
    )).toMatchObject({ state: "stale", label: "stale head" });
  });

  it("marks a 90-day selection partial when only 30 days are covered", () => {
    expect(coverageVerdict(
      [row({ oldestCapturedAt: "2026-07-24T00:00:00.000Z" })],
      ANALYTICS_COVERAGE_PLANES.traffic,
      { from: "2026-05-25T00:00:00.000Z", to: window30d.to },
    )).toMatchObject({ state: "partial", label: "partial — selected window" });
  });

  it("never calls a multi-plane panel complete when one required plane has no row", () => {
    expect(coverageVerdict(
      [row({ plane: CAPTURE_COVERAGE_PLANES.catalog })],
      ANALYTICS_COVERAGE_PLANES.contentPerformance,
      window30d,
    )).toMatchObject({ state: "unknown", label: "coverage unknown" });
  });

  it.each([
    CAPTURE_COVERAGE_PLANES.statsAccountDaily,
    CAPTURE_COVERAGE_PLANES.statsAccountHourly,
    CAPTURE_COVERAGE_PLANES.statsEarnings,
  ])("uses a complete fresh window despite unfinished %s history", (plane) => {
    const selected = { from: "2026-08-22T00:00:00.000Z", to: window30d.to };
    expect(coverageVerdict([
      row({ plane, status: "partial_provider_surface", newestCapturedAt: "2026-08-01T00:00:00.000Z" }),
      row({ plane, scopeRef: "steady", oldestCapturedAt: selected.from }),
    ], [plane], selected)).toMatchObject({ state: "complete" });
  });

  it("combines overlapping history and fresh bounds for a wider selection", () => {
    expect(coverageVerdict([
      row({ status: "provider_exhausted", newestCapturedAt: "2026-08-01T00:00:00.000Z" }),
      row({ scopeRef: "steady", oldestCapturedAt: window30d.from }),
    ], ANALYTICS_COVERAGE_PLANES.traffic, {
      from: "2026-05-25T00:00:00.000Z", to: window30d.to,
    })).toMatchObject({ state: "complete" });
  });

  it("keeps a fully captured historical selection complete across a later capture gap", () => {
    expect(coverageVerdict([
      row({ status: "provider_exhausted", newestCapturedAt: "2026-07-10T00:00:00.000Z" }),
      row({ scopeRef: "steady", oldestCapturedAt: window30d.from }),
    ], ANALYTICS_COVERAGE_PLANES.traffic, {
      from: "2026-05-25T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z",
    })).toMatchObject({ state: "complete" });
  });

  it("keeps the existing 48-hour fresh-head tolerance with unfinished history", () => {
    const rows = [
      row({ status: "in_progress", newestCapturedAt: "2026-08-01T00:00:00.000Z" }),
      row({ scopeRef: "steady", oldestCapturedAt: window30d.from, newestCapturedAt: "2026-08-21T00:00:00.000Z" }),
    ];
    expect(coverageVerdict(rows, ANALYTICS_COVERAGE_PLANES.traffic, window30d))
      .toMatchObject({ state: "complete" });
    expect(coverageVerdict(rows, ANALYTICS_COVERAGE_PLANES.traffic, {
      ...window30d, to: "2026-08-23T00:00:00.001Z",
    }).state).not.toBe("complete");
  });

  it("does not let a fresh window prove unfinished older history", () => {
    expect(coverageVerdict([
      row({ status: "in_progress", newestCapturedAt: "2026-08-01T00:00:00.000Z" }),
      row({ scopeRef: "steady", oldestCapturedAt: window30d.from }),
    ], ANALYTICS_COVERAGE_PLANES.traffic, {
      from: "2026-05-25T00:00:00.000Z", to: window30d.to,
    })).toMatchObject({ state: "partial", label: "partial — in progress" });
  });

  it("does not bridge a gap between successful historical and fresh windows", () => {
    expect(coverageVerdict([
      row({ status: "provider_exhausted", newestCapturedAt: "2026-07-23T00:00:00.000Z" }),
      row({ scopeRef: "steady", oldestCapturedAt: window30d.from }),
    ], ANALYTICS_COVERAGE_PLANES.traffic, {
      from: "2026-05-25T00:00:00.000Z", to: window30d.to,
    })).toMatchObject({ state: "partial", detail: expect.stringContaining("gap") });
  });

  it("retains a failed fresh capture even when history previously covered the selection", () => {
    expect(coverageVerdict([
      row({ status: "provider_exhausted" }),
      row({ scopeRef: "steady", status: "partial_provider_surface", oldestCapturedAt: window30d.from }),
    ], ANALYTICS_COVERAGE_PLANES.traffic, window30d))
      .toMatchObject({ state: "partial", label: "partial — partial provider surface" });
  });

  it.each([
    { oldestCapturedAt: null },
    { newestCapturedAt: null },
    { oldestCapturedAt: "2026-08-24T00:00:00.000Z" },
  ])("does not infer fresh bounds from updatedAt or old history: %j", (bounds) => {
    expect(coverageVerdict([
      row({ status: "provider_exhausted", newestCapturedAt: "2026-08-01T00:00:00.000Z" }),
      row({ scopeRef: "steady", ...bounds }),
    ], ANALYTICS_COVERAGE_PLANES.traffic, window30d)).toMatchObject({ state: "partial" });
  });

  it("keeps the joined floor limitation for a selection older than both captures", () => {
    expect(coverageVerdict([
      row({ oldestCapturedAt: "2026-07-01T00:00:00.000Z", newestCapturedAt: "2026-08-01T00:00:00.000Z" }),
      row({ scopeRef: "steady", oldestCapturedAt: window30d.from }),
    ], ANALYTICS_COVERAGE_PLANES.traffic, {
      from: "2026-05-25T00:00:00.000Z", to: window30d.to,
    })).toMatchObject({ state: "partial", label: "partial — selected window" });
  });

  it("keeps the joined head stale when the fresh sweep is also old", () => {
    expect(coverageVerdict([
      row({ status: "provider_exhausted", newestCapturedAt: "2026-08-01T00:00:00.000Z" }),
      row({ scopeRef: "steady", oldestCapturedAt: window30d.from, newestCapturedAt: "2026-08-19T00:00:00.000Z" }),
    ], ANALYTICS_COVERAGE_PLANES.traffic, {
      from: "2026-05-25T00:00:00.000Z", to: window30d.to,
    })).toMatchObject({ state: "stale" });
  });

  it("preserves the existing exhausted empty-floor meaning when windows overlap", () => {
    expect(coverageVerdict([
      row({ status: "provider_exhausted", oldestCapturedAt: null, newestCapturedAt: "2026-08-01T00:00:00.000Z" }),
      row({ scopeRef: "steady", oldestCapturedAt: window30d.from }),
    ], ANALYTICS_COVERAGE_PLANES.traffic, {
      from: "2025-01-01T00:00:00.000Z", to: window30d.to,
    })).toMatchObject({ state: "complete" });
  });

  it("does not collapse independent media scopes even if one is named steady", () => {
    const plane = CAPTURE_COVERAGE_PLANES.mediaStats;
    expect(coverageVerdict([
      row({ plane, scopeRef: "media-1", status: "in_progress" }),
      row({ plane, scopeRef: "steady", oldestCapturedAt: window30d.from }),
    ], [plane], window30d)).toMatchObject({ state: "partial", label: "partial — in progress" });
  });

  it("preserves unrelated scopes and required planes when choosing a fresh account window", () => {
    expect(coverageVerdict([
      row({ status: "in_progress" }),
      row({ scopeRef: "steady", oldestCapturedAt: window30d.from }),
      row({ scopeRef: "additional", status: "in_progress" }),
    ], ANALYTICS_COVERAGE_PLANES.traffic, window30d))
      .toMatchObject({ state: "partial", label: "partial — in progress" });
    expect(coverageVerdict([
      row({ status: "in_progress" }),
      row({ scopeRef: "steady", oldestCapturedAt: window30d.from }),
    ], [...ANALYTICS_COVERAGE_PLANES.traffic, CAPTURE_COVERAGE_PLANES.catalog], window30d))
      .toMatchObject({ state: "unknown" });
  });
});
