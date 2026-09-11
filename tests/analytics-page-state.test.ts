import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryRouter } from
  "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import {
  ANALYTICS_QUERY_SURFACES,
  analyticsFailureBanner,
  analyticsPanelState,
  mapPanelState,
  retryFailedAnalytics,
  type AnalyticsQueryEntry,
} from "../apps/dashboard/src/pages/analytics-query-state.ts";

const pagesMocks = vi.hoisted(() => ({ usePages: vi.fn(), pagesQueryOptions: {}, prefetchPages: vi.fn() }));
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

/* ------------------------------------------------------------------ *
 * The four states a query can be in, as React Query v5 reports them.
 * `isLoadingError` (no data, failed) and `isRefetchError` (data in hand,
 * refresh failed) are DIFFERENT facts and this page renders them differently.
 * ------------------------------------------------------------------ */
function loading() {
  return {
    data: undefined,
    isLoadingError: false,
    isRefetchError: false,
    error: null,
    refetch: vi.fn(),
  };
}

function failed(message = "500 Internal Server Error") {
  return {
    data: undefined,
    isLoadingError: true,
    isRefetchError: false,
    error: new Error(message),
    refetch: vi.fn(),
  };
}

function ready(data: unknown) {
  return {
    data,
    isLoadingError: false,
    isRefetchError: false,
    error: null,
    refetch: vi.fn(),
  };
}

function cached(data: unknown) {
  return {
    data,
    isLoadingError: false,
    isRefetchError: true,
    error: new Error("504 Gateway Timeout"),
    refetch: vi.fn(),
  };
}

/**
 * A fully-covered capture-coverage response.
 *
 * The panels' empty sentences depend on it: an empty chart over a lane that is
 * ramped and exhausted says something about the world, and an empty chart over
 * a lane with no coverage row at all says only that nobody looked. These tests
 * are about the REQUEST states, so the capture verdict is held at "complete"
 * and the coverage-request states are varied on their own below.
 */
function coveredPlane(plane: string) {
  return {
    plane,
    scopeRef: "",
    status: "window_captured",
    acquisitionMode: "retroactive",
    proof: "terminal_response",
    oldestCapturedAt: "2020-01-01T00:00:00.000Z",
    newestCapturedAt: new Date().toISOString(),
    expectedCount: null,
    observedUniqueCount: null,
    reasonCode: null,
    nextProbeAt: null,
    updatedAt: new Date().toISOString(),
  };
}

const COVERED = {
  planes: [
    coveredPlane("stats_account_daily"),
    coveredPlane("stats_earnings"),
    coveredPlane("media_stats"),
    coveredPlane("catalog"),
    coveredPlane("post_replies"),
  ],
  streams: [],
  holdings: [],
};

/** Succeeded-and-empty responses: the ONLY state in which a panel may say
 *  "nothing here" about the world rather than about our own request. */
const EMPTY = {
  traffic: { rows: [] },
  media: { media: [], top: [], bucketsTruncated: false },
  tags: { topTags: [], platformTags: [] },
  coverage: { planes: [], streams: [], holdings: [] },
  comments: { perPost: [], likers: { rows: [] } },
  revenue: { daily: [], months: [] },
};

/** Account-level media traffic that DOES carry both watch components:
 *  45 000 percent-points over 1 000 video views → 45.0 %. */
const WATCHED_MEDIA_TRAFFIC = {
  rows: [{
    bucketStart: "2026-08-01T00:00:00.000Z",
    measure: "visits",
    family: "10000",
    sourceLabel: "other",
    views: null,
    interactionTimeMs: null,
    videoPercentWatchedSum: 45_000,
    videoViews: 1_000,
  }],
};

const FANSLY_PAGE = { id: 1, label: "lora-1", platform: "fansly" };
const ONLYFANS_PAGE = { id: 2, label: "lora-of", platform: "onlyfans" };

function renderAnalyticsPage(path = "/analytics") {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: [path] },
    createElement(AnalyticsPage),
  ));
}

/** Every insight hook succeeded and empty, then override the ones under test. */
function withCatalog(overrides: Partial<Record<keyof typeof insightsMocks, unknown>> = {}) {
  pagesMocks.usePages.mockReturnValue({
    data: [FANSLY_PAGE],
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  });
  insightsMocks.useStatsTraffic.mockImplementation(() => ready(EMPTY.traffic));
  insightsMocks.useStatsMedia.mockReturnValue(overrides.useStatsMedia ?? ready(EMPTY.media));
  insightsMocks.useStatsTags.mockReturnValue(overrides.useStatsTags ?? ready(EMPTY.tags));
  insightsMocks.useStatsCoverage.mockReturnValue(
    overrides.useStatsCoverage ?? ready(COVERED));
  insightsMocks.useContentComments.mockReturnValue(
    overrides.useContentComments ?? ready(EMPTY.comments));
  insightsMocks.useMoneyRevenueMix.mockReturnValue(
    overrides.useMoneyRevenueMix ?? ready(EMPTY.revenue));
}

/** The two traffic panels come from ONE hook called twice, so they are set by
 *  subject kind rather than by mock identity. */
function withTraffic(profile: unknown, media: unknown) {
  insightsMocks.useStatsTraffic.mockImplementation((
    _label: string,
    _window: unknown,
    subjectKind: string,
  ) => (subjectKind === "account_profile" ? profile : media));
}

function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/**
 * The markup of ONE panel: from its title to the start of the next card.
 *
 * Page-wide `toContain` cannot tell which card carries a badge, and the two
 * P1s of the codex review both lived in a card whose neighbours were already
 * honest.
 */
function panelMarkup(html: string, title: string): string {
  const start = html.indexOf(`>${title}<`);
  expect(start, `panel ${title} is not rendered`).toBeGreaterThan(-1);
  const rest = html.slice(start);
  const end = rest.indexOf("<section", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

const PANEL_FAILED = "This request failed — nothing is shown for it.";

beforeEach(() => {
  pagesMocks.usePages.mockReset();
  for (const mock of Object.values(insightsMocks)) {
    mock.mockReset();
  }
});

describe("analytics panel state", () => {
  it("calls a request with no data and no error what it is: loading", () => {
    expect(analyticsPanelState(loading())).toEqual({ status: "loading" });
  });

  it("keeps a failed request out of the data channel entirely", () => {
    expect(analyticsPanelState(failed("boom"))).toEqual({
      status: "error",
      message: "boom",
    });
  });

  it("reports data in hand as ready", () => {
    expect(analyticsPanelState(ready({ rows: [] }))).toEqual({
      status: "ready",
      data: { rows: [] },
      refreshFailed: false,
    });
  });

  it("keeps cached data AND says its refresh failed — the two are not exclusive", () => {
    // React Query v5's `isRefetchError`: what we hold is still true, it is
    // only old. Dropping it on a failed refresh would be losing a fact.
    expect(analyticsPanelState(cached({ rows: [1] }))).toEqual({
      status: "ready",
      data: { rows: [1] },
      refreshFailed: true,
    });
  });

  it("projects a submetric without losing the state it was measured in", () => {
    expect(mapPanelState(analyticsPanelState(loading()), () => 42))
      .toEqual({ status: "loading" });
    expect(mapPanelState(analyticsPanelState(cached([2]) as {
      data: number[] | undefined;
      isLoadingError: boolean;
      isRefetchError: boolean;
      error: unknown;
    }), (rows) => rows.length)).toEqual({
      status: "ready",
      data: 1,
      refreshFailed: true,
    });
  });
});

/**
 * The dependency map is the whole reason per-panel states are safe. It is
 * pinned because it is NOT one-to-one and nothing in the component tree makes
 * the hidden edges visible.
 */
describe("the query → surface map", () => {
  it("records that media traffic feeds Content Performance, not just the FYP chart", () => {
    expect(ANALYTICS_QUERY_SURFACES.mediaTraffic).toEqual([
      "FYP vs direct media views",
      "Content performance · Avg. watch",
    ]);
  });

  it("records both consumers of media and of comments", () => {
    expect(ANALYTICS_QUERY_SURFACES.media).toEqual(["Top media", "Content performance"]);
    expect(ANALYTICS_QUERY_SURFACES.comments).toEqual(["Comments per post", "Likers"]);
  });

  it("names surfaces in the banner, never query variables", () => {
    const entries: AnalyticsQueryEntry[] = [
      { id: "media", failed: true, refetch: vi.fn() },
      { id: "tags", failed: false, refetch: vi.fn() },
    ];
    expect(analyticsFailureBanner(entries)).toEqual(["Top media", "Content performance"]);
  });

  it("retries each failed query ONCE — not once per consumer", () => {
    const mediaRefetch = vi.fn();
    const tagsRefetch = vi.fn();
    const entries: AnalyticsQueryEntry[] = [
      { id: "media", failed: true, refetch: mediaRefetch },
      // The same query reached through its second consumer: a retry wired per
      // panel would fire this request twice on a box already too slow to
      // answer it once.
      { id: "media", failed: true, refetch: mediaRefetch },
      { id: "tags", failed: false, refetch: tagsRefetch },
    ];

    expect(retryFailedAnalytics(entries)).toEqual(["media"]);
    expect(mediaRefetch).toHaveBeenCalledTimes(1);
    expect(tagsRefetch).not.toHaveBeenCalled();
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
    for (const mock of Object.values(insightsMocks)) {
      mock.mockImplementation(() => loading());
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

  it.each(["missing", "", ONLYFANS_PAGE.label])(
    "does not substitute the first account for an explicit unavailable page=%s",
    (requestedPage) => {
      // Ready insight mocks also prove that data already in the cache stays
      // hidden until the user chooses an available account.
      withCatalog();
      pagesMocks.usePages.mockReturnValue({
        data: [FANSLY_PAGE, ONLYFANS_PAGE],
        isPending: false,
        isError: false,
        refetch: vi.fn(),
      });

      const html = renderAnalyticsPage(`/analytics?page=${encodeURIComponent(requestedPage)}`);

      expect(html).toContain("Аккаунт недоступен");
      expect(html).toContain("Выберите доступный аккаунт в списке выше.");
      expect(html).not.toContain(">Traffic by source<");
      expect(html).toContain('aria-label="Аккаунт для аналитики"');
      expect(html).toContain('value="lora-1"');
      const selected = html.match(/<option\b[^>]*selected=""[^>]*>/)?.[0];
      expect(selected).toContain('value=""');
      expect(selected).toContain('disabled=""');
      for (const mock of Object.values(insightsMocks)) {
        expect(mock).toHaveBeenCalled();
        for (const call of mock.mock.calls) {
          expect(call[0]).toBe("");
          expect(call[call.length - 1]).toEqual({ enabled: false });
        }
      }
    },
  );

  it("loads the explicitly selected available account even when it is not first", () => {
    withCatalog();
    pagesMocks.usePages.mockReturnValue({
      data: [FANSLY_PAGE, { ...FANSLY_PAGE, id: 3, label: "lana-2" }],
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    });

    const html = renderAnalyticsPage("/analytics?page=lana-2");

    expect(html).not.toContain("Аккаунт недоступен");
    expect(html.match(/<option\b[^>]*selected=""[^>]*>/)?.[0]).toContain('value="lana-2"');
    for (const mock of Object.values(insightsMocks)) {
      for (const call of mock.mock.calls) {
        expect(call[0]).toBe("lana-2");
        expect(call[call.length - 1]).toEqual({ enabled: true });
      }
    }
  });

  it("keeps an explicit unavailable account distinct from an empty catalog", () => {
    withCatalog();
    pagesMocks.usePages.mockReturnValue({
      data: [ONLYFANS_PAGE],
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    });

    const html = renderAnalyticsPage("/analytics?page=missing");

    expect(html).toContain("Аккаунт недоступен");
    expect(html).toContain("Нет доступных аккаунтов Fansly для выбора.");
    expect(html).not.toContain("No Fansly pages to analyse.");
    expect(html).not.toContain(">Traffic by source<");
  });
});

/**
 * The point of PR 4: the panels no longer share a fate. What each one renders
 * is a function of ITS OWN queries, and the states below are the ones that
 * used to be indistinguishable behind the page-wide gate.
 */
describe("AnalyticsPage per-panel states", () => {
  it("renders a succeeded-empty panel while another is still loading", () => {
    withCatalog({ useStatsTags: loading() });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const html = renderAnalyticsPage();

    // The answered panel is on screen…
    expect(html).toContain("No top-media window captured for this range.");
    // …and the one still in flight says so rather than claiming a result.
    expect(html).toContain("Top FYP tags");
    expect(html).not.toContain("No tag window captured for this range.");
    expect(html).toContain("Loading…");
    // The old page-wide gate is gone.
    expect(html).not.toContain("Loading analytics and capture coverage…");
  });

  it("never renders a failed query's empty state, and names the surface in the banner", () => {
    withCatalog({ useStatsTags: failed("502 Bad Gateway") });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const html = renderAnalyticsPage();

    expect(html).not.toContain("No tag window captured for this range.");
    expect(html).toContain(PANEL_FAILED);
    expect(html).toContain("502 Bad Gateway");
    expect(html).toContain("Not shown: Top FYP tags.");
    // Everything else still rendered — one failure no longer blanks the page.
    expect(html).toContain("No top-media window captured for this range.");
    expect(html).toContain("No comments captured in this window.");
  });

  it("confines a media failure to Top Media and Content Performance", () => {
    withCatalog({ useStatsMedia: failed() });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const html = renderAnalyticsPage();

    // Exactly the two panels that read `media`, and no others.
    expect(occurrences(html, PANEL_FAILED)).toBe(2);
    expect(html).toContain("Not shown: Top media, Content performance.");
    expect(html).not.toContain("No top-media window captured for this range.");
    expect(html).not.toContain("No media captured for this page yet.");
    expect(html).toContain("No tag window captured for this range.");
    expect(html).toContain("No earnings breakdown captured for this range.");
  });

  it("never says Avg. watch is “not served” while its own request is pending", () => {
    withCatalog();
    withTraffic(ready(EMPTY.traffic), loading());

    const html = renderAnalyticsPage();

    // "not served" is a verdict about Fansly's payload ([E5]); the request has
    // not answered, so it is not available to be made.
    expect(html).toContain("Avg. watch");
    expect(html).not.toContain("not served");
    expect(html).toContain("loading…");
    // Content Performance's own table is fed by `media`, which succeeded.
    expect(html).toContain("No media captured for this page yet.");
  });

  it("never says Avg. watch is “not served” when its request failed", () => {
    withCatalog();
    withTraffic(ready(EMPTY.traffic), failed());

    const html = renderAnalyticsPage();

    expect(html).not.toContain("not served");
    expect(html).toContain("unavailable");
    expect(html).toContain("Not shown: FYP vs direct media views, Content performance · Avg. watch.");
  });

  it("says “not served” only about a SUCCEEDED request that carried no components", () => {
    withCatalog();
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const html = renderAnalyticsPage();

    expect(html).toContain("not served");
    expect(html).not.toContain("not served (cached");
  });

  it("qualifies a cached “not served” whose refresh failed — it is not Fansly's verdict", () => {
    // `{ data: null, refreshFailed: true }` means "the last response we could
    // get carried no components", not "Fansly serves none". The panel's own
    // cached badge is about the `media` query and cannot qualify this figure.
    withCatalog();
    withTraffic(ready(EMPTY.traffic), cached(EMPTY.traffic));

    const html = renderAnalyticsPage();

    expect(html).toContain("not served (cached — refresh failed)");
    // …and no UNQUALIFIED "not served" anywhere: the qualified string is the
    // only occurrence.
    expect(occurrences(html, "not served")).toBe(1);
  });

  it("labels a cached average-watch figure as cached", () => {
    withCatalog();
    withTraffic(ready(EMPTY.traffic), cached(WATCHED_MEDIA_TRAFFIC));

    const html = renderAnalyticsPage();

    expect(html).toContain("45.0% (cached — refresh failed)");
  });

  it("serves the account-level average when both components arrived", () => {
    withCatalog();
    withTraffic(ready(EMPTY.traffic), ready(WATCHED_MEDIA_TRAFFIC));

    const html = renderAnalyticsPage();

    expect(html).toContain("45.0%");
    expect(html).not.toContain("not served");
  });

  it("cannot turn a failed comments request into an empty Likers card", () => {
    withCatalog({ useContentComments: failed() });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const html = renderAnalyticsPage();

    // "Empty by design" is a claim about Fansly, not about our request.
    expect(html).not.toContain("Empty by design");
    expect(html).not.toContain("No comments captured in this window.");
    expect(occurrences(html, PANEL_FAILED)).toBe(2);
    expect(html).toContain("Not shown: Comments per post, Likers.");
  });

  it("keeps cached data on screen and labels it cached when the refresh fails", () => {
    withCatalog({ useStatsMedia: cached(EMPTY.media) });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const html = renderAnalyticsPage();

    expect(html).toContain("cached — refresh failed");
    // Stale data is still data: the panel renders, and it is not in the banner.
    expect(html).toContain("No top-media window captured for this range.");
    expect(html).not.toContain("Some requests failed.");
  });
});

/**
 * Coverage is a shared epistemic dependency: every badge on the page is a
 * claim that rests on it. A missing badge asserts "complete", so the coverage
 * request's own state must always be visible somewhere.
 */
describe("AnalyticsPage coverage states", () => {
  it("says the verdict is pending rather than showing no badge at all", () => {
    withCatalog({ useStatsCoverage: loading() });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const html = renderAnalyticsPage();

    expect(html).toContain("coverage pending");
    expect(html).toContain("Loading coverage…");
    expect(html).not.toContain("No coverage data for this page.");
  });

  it("says coverage is unavailable — never “no coverage data” — when the request failed", () => {
    withCatalog({ useStatsCoverage: failed() });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const html = renderAnalyticsPage();

    expect(html).toContain("coverage unavailable");
    // The old panel mapped `!data` to this sentence, turning a failed request
    // into a verdict about the page.
    expect(html).not.toContain("No coverage data for this page.");
    expect(html).toContain(PANEL_FAILED);
    expect(html).toContain("Not shown: Coverage, every coverage badge.");
    // The other panels' data is not in doubt — only its completeness is.
    expect(html).toContain("No top-media window captured for this range.");
  });

  it("does not let an old “complete” verdict remove the badge after a failed refresh", () => {
    withCatalog({ useStatsCoverage: cached(COVERED) });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const html = renderAnalyticsPage();

    expect(html).toContain("coverage refresh failed");
    expect(html).not.toContain("Some requests failed.");
  });

  it("does not let the Likers card state its lane verdict over a pending coverage request", () => {
    // The verdict is a CONSTANT ([E4]), which is exactly why it slipped the
    // first time: nothing about it is derived from coverage rows, so nothing
    // stopped it being rendered definitively while coverage was unknown.
    withCatalog({ useStatsCoverage: loading() });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const likers = panelMarkup(renderAnalyticsPage(), "Likers");

    expect(likers).toContain("coverage pending");
    expect(likers).not.toContain(">not started<");
  });

  it("does not let the Likers card state its lane verdict over a FAILED coverage request", () => {
    withCatalog({ useStatsCoverage: failed() });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const likers = panelMarkup(renderAnalyticsPage(), "Likers");

    expect(likers).toContain("coverage unavailable");
    expect(likers).not.toContain(">not started<");
  });

  it("marks the Likers verdict as cached when the coverage refresh failed", () => {
    withCatalog({ useStatsCoverage: cached(COVERED) });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const likers = panelMarkup(renderAnalyticsPage(), "Likers");

    expect(likers).toContain("coverage refresh failed");
    expect(likers).not.toContain(">not started<");
    // The cached verdict is still reported — in the badge's tooltip, WITH the
    // failure beside it. Losing it would be losing a fact.
    expect(likers).toContain("Cached verdict: not started.");
  });

  it("states the Likers lane verdict once coverage has actually answered", () => {
    withCatalog();
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const likers = panelMarkup(renderAnalyticsPage(), "Likers");

    expect(likers).toContain(">not started<");
    expect(likers).toContain("Empty by design");
  });

  it("falls through to the real capture verdict once coverage answered", () => {
    withCatalog({ useStatsCoverage: ready(EMPTY.coverage) });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const html = renderAnalyticsPage();

    // A SUCCEEDED coverage request with no row for a required plane is a
    // capture verdict ("coverage unknown"), not a request state — and none of
    // the request-state badges may stand in for it.
    expect(html).toContain("coverage unknown");
    expect(html).not.toContain("coverage pending");
    expect(html).not.toContain("coverage unavailable");
    expect(html).not.toContain("coverage refresh failed");
    // …and an empty panel under an unknown verdict does not claim the world
    // was empty.
    expect(html).toContain("Nothing captured for this window");
  });
});
