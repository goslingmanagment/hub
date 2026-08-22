import { describe, expect, it } from "vitest";

import { analyticsQueryState } from
  "../apps/dashboard/src/pages/analytics-query-state.ts";

describe("analytics page query state", () => {
  it("renders an explicit error before any chart can claim an empty dataset", () => {
    expect(analyticsQueryState([
      { label: "Traffic", isError: true, isSuccess: false },
      { label: "Coverage", isError: false, isSuccess: true },
    ])).toEqual({ state: "error", failedLabels: ["Traffic"] });
  });

  it("keeps panels behind a loading state until every query succeeded", () => {
    expect(analyticsQueryState([
      { label: "Traffic", isError: false, isSuccess: true },
      { label: "Coverage", isError: false, isSuccess: false },
    ])).toEqual({ state: "loading" });
  });

  it("allows empty-state rendering only after every query succeeded", () => {
    expect(analyticsQueryState([
      { label: "Traffic", isError: false, isSuccess: true },
      { label: "Coverage", isError: false, isSuccess: true },
    ])).toEqual({ state: "ready" });
  });
});
