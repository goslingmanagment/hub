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
});
