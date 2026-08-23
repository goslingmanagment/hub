import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryRouter } from
  "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { analyticsQueryState } from
  "../apps/dashboard/src/pages/analytics-query-state.ts";

const pagesMocks = vi.hoisted(() => ({ usePages: vi.fn() }));
const insightsMocks = vi.hoisted(() => ({
  useStatsTraffic: vi.fn(),
  useStatsMedia: vi.fn(),
  useStatsTags: vi.fn(),
  useStatsCoverage: vi.fn(),
  useContentComments: vi.fn(),
  useMoneyRevenueMix: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/pages.ts", () => pagesMocks);
vi.mock("../apps/dashboard/src/api/insights.ts", () => insightsMocks);

const { AnalyticsPage } = await import("../apps/dashboard/src/pages/AnalyticsPage.tsx");

/** Every insight hook parked mid-flight: this suite is about the CATALOG's
 *  three states, and the panels' own gate must not decide the outcome. */
function pendingInsight() {
  return { data: undefined, isError: false, isSuccess: false, isLoading: true, refetch: vi.fn() };
}

function renderAnalyticsPage() {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: ["/analytics"] },
    createElement(AnalyticsPage),
  ));
}

const FANSLY_PAGE = { id: 1, label: "lora-1", platform: "fansly" };
const ONLYFANS_PAGE = { id: 2, label: "lora-of", platform: "onlyfans" };

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

/**
 * The Analytics page must never claim "no Fansly pages" about a request that
 * has not answered. Before PR 1 the page took its catalog from the shell's
 * `useOverview()` — 7.5 s at p50 on a cold cache — and rendered exactly that
 * false empty state for the whole wait, with none of its own seven requests
 * in flight behind it.
 */
describe("AnalyticsPage catalog states", () => {
  beforeEach(() => {
    pagesMocks.usePages.mockReset();
    for (const mock of Object.values(insightsMocks)) {
      mock.mockReset();
      mock.mockImplementation(() => pendingInsight());
    }
  });

  it("says it is loading — not that there is nothing to analyse — while the catalog is pending", () => {
    pagesMocks.usePages.mockReturnValue({
      data: undefined,
      isPending: true,
      isError: false,
      refetch: vi.fn(),
    });

    const html = renderAnalyticsPage();

    expect(html).toContain("Loading pages…");
    expect(html).not.toContain("No Fansly pages to analyse.");
    // The header renders through the wait: a blank frame is what made the old
    // page feel broken rather than slow.
    expect(html).toContain("Analytics");
  });

  it("reports a failed catalog as a failure, not as an empty agency", () => {
    pagesMocks.usePages.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      refetch: vi.fn(),
    });

    const html = renderAnalyticsPage();

    expect(html).toContain("The page list could not be loaded.");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("No Fansly pages to analyse.");
  });

  it("claims the empty state ONLY once the catalog succeeded with no Fansly page", () => {
    // A28-2: an OnlyFans page in the catalog is not a Fansly page — the
    // succeeded-but-empty verdict is about the FILTERED list.
    pagesMocks.usePages.mockReturnValue({
      data: [ONLYFANS_PAGE],
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    });

    const html = renderAnalyticsPage();

    expect(html).toContain("No Fansly pages to analyse.");
    expect(html).not.toContain("Loading pages…");
  });

  it("hands the page over to the panels once the catalog carries a Fansly page", () => {
    pagesMocks.usePages.mockReturnValue({
      data: [FANSLY_PAGE, ONLYFANS_PAGE],
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    });

    const html = renderAnalyticsPage();

    expect(html).not.toContain("No Fansly pages to analyse.");
    expect(html).not.toContain("Loading pages…");
    // The selector offers the Fansly page and only the Fansly page.
    expect(html).toContain("lora-1");
    expect(html).not.toContain("lora-of");
    expect(html).toContain("Loading analytics and capture coverage…");
  });

  it("fires the seven analytics requests off the catalog, without waiting for /overview", () => {
    pagesMocks.usePages.mockReturnValue({
      data: [FANSLY_PAGE],
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    });

    renderAnalyticsPage();

    // `enabled` is what decides whether a request leaves the browser; every
    // one of them must be enabled on the catalog alone.
    for (const mock of Object.values(insightsMocks)) {
      expect(mock).toHaveBeenCalled();
      for (const call of mock.mock.calls) {
        expect(call[0]).toBe("lora-1");
        expect(call[call.length - 1]).toEqual({ enabled: true });
      }
    }
  });
});
