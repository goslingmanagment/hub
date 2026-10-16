import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryRouter } from
  "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import {
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
  engine: { mode: "live", streams: [] },
  holdings: [],
};

/** The window every traffic response echoes back (the contract requires it):
 *  the charts lay their axis out over it. */
const TRAFFIC_WINDOW = {
  from: "2026-07-17T00:00:00.000Z",
  to: "2026-08-16T00:00:00.000Z",
  periodMs: 86_400_000,
  subjectKind: "account_profile",
  subjectRef: null,
};

/** Succeeded-and-empty responses: the ONLY state in which a panel may say
 *  "nothing here" about the world rather than about our own request. */
const EMPTY = {
  traffic: { window: TRAFFIC_WINDOW, rows: [] },
  media: { media: [], top: [], bucketsTruncated: false },
  tags: { topTags: [], platformTags: [] },
  coverage: { planes: [], engine: { mode: "live", streams: [] }, holdings: [] },
  comments: { perPost: [], likers: { rows: [] } },
  revenue: { daily: [], months: [] },
};

/** Account-level media traffic that DOES carry both watch components:
 *  45 000 percent-points over 1 000 video views → 45.0 %. */
const WATCHED_MEDIA_TRAFFIC = {
  window: { ...TRAFFIC_WINDOW, subjectKind: "account_media" },
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

function renderAnalyticsPage() {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: ["/analytics"] },
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

const PANEL_FAILED = "Запрос не выполнен — данные не показаны.";

beforeEach(() => {
  pagesMocks.usePages.mockReset();
  for (const mock of Object.values(insightsMocks)) {
    mock.mockReset();
  }
});

describe("analytics retry", () => {
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

    expect(html).toContain("Загружаем страницы…");
    expect(html).not.toContain("Нет страниц Fansly для аналитики");
    // The header renders through the wait: a blank frame is what made the old
    // page feel broken rather than slow.
    expect(html).toContain("Аналитика");
  });

  it("reports a failed catalog as a failure, not as an empty agency", () => {
    pagesMocks.usePages.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      refetch: vi.fn(),
    });

    const html = renderAnalyticsPage();

    expect(html).toContain("Не удалось загрузить список страниц");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Нет страниц Fansly для аналитики");
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

    expect(html).toContain("Нет страниц Fansly для аналитики");
    expect(html).not.toContain("Загружаем страницы…");
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
    expect(html).toContain("Рейтинг медиа за этот период не собран.");
    // …and the one still in flight says so rather than claiming a result.
    expect(html).toContain("Топ тегов FYP");
    expect(html).not.toContain("Рейтинг тегов за этот период не собран.");
    expect(html).toContain("Загружаем…");
    // The old page-wide gate is gone.
    expect(html).not.toContain("Loading analytics and capture coverage…");
  });

  it("never renders a failed query's empty state, and names the surface in the banner", () => {
    withCatalog({ useStatsTags: failed("502 Bad Gateway") });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const html = renderAnalyticsPage();

    expect(html).not.toContain("Рейтинг тегов за этот период не собран.");
    expect(html).toContain(PANEL_FAILED);
    expect(html).toContain("502 Bad Gateway");
    expect(html).toContain("Не показано: Топ тегов FYP.");
    // Everything else still rendered — one failure no longer blanks the page.
    expect(html).toContain("Рейтинг медиа за этот период не собран.");
    expect(html).toContain("За этот период комментариев не собрано.");
  });

  it("confines a media failure to Top Media and Content Performance", () => {
    withCatalog({ useStatsMedia: failed() });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const html = renderAnalyticsPage();

    // Exactly the two panels that read `media`, and no others.
    expect(occurrences(html, PANEL_FAILED)).toBe(2);
    expect(html).toContain("Не показано: Топ медиа, Эффективность контента.");
    expect(html).not.toContain("Рейтинг медиа за этот период не собран.");
    expect(html).not.toContain("Медиа этой страницы ещё не собраны.");
    expect(html).toContain("Рейтинг тегов за этот период не собран.");
    expect(html).toContain("Структура дохода за этот период не собрана.");
  });

  it("never says Avg. watch is “not served” while its own request is pending", () => {
    withCatalog();
    withTraffic(ready(EMPTY.traffic), loading());

    const html = renderAnalyticsPage();

    // "not served" is a verdict about Fansly's payload ([E5]); the request has
    // not answered, so it is not available to be made.
    expect(html).toContain("Средний досмотр");
    expect(html).not.toContain("Fansly не передаёт");
    expect(html).toContain("загружаем…");
    // Content Performance's own table is fed by `media`, which succeeded.
    expect(html).toContain("Медиа этой страницы ещё не собраны.");
  });

  it("never says Avg. watch is “not served” when its request failed", () => {
    withCatalog();
    withTraffic(ready(EMPTY.traffic), failed());

    const html = renderAnalyticsPage();

    expect(html).not.toContain("Fansly не передаёт");
    expect(html).toContain("недоступно");
    expect(html).toContain("Не показано: Просмотры: FYP и прямые, Эффективность контента · средний досмотр.");
  });

  it("says “not served” only about a SUCCEEDED request that carried no components", () => {
    withCatalog();
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const html = renderAnalyticsPage();

    expect(html).toContain("Fansly не передаёт");
    expect(html).not.toContain("Fansly не передаёт (из кэша");
  });

  it("qualifies a cached “not served” whose refresh failed — it is not Fansly's verdict", () => {
    // `{ data: null, refreshFailed: true }` means "the last response we could
    // get carried no components", not "Fansly serves none". The panel's own
    // cached badge is about the `media` query and cannot qualify this figure.
    withCatalog();
    withTraffic(ready(EMPTY.traffic), cached(EMPTY.traffic));

    const html = renderAnalyticsPage();

    expect(html).toContain("Fansly не передаёт (из кэша — не удалось обновить)");
    // …and no UNQUALIFIED "not served" anywhere: the qualified string is the
    // only occurrence.
    expect(occurrences(html, "Fansly не передаёт")).toBe(1);
  });

  it("labels a cached average-watch figure as cached", () => {
    withCatalog();
    withTraffic(ready(EMPTY.traffic), cached(WATCHED_MEDIA_TRAFFIC));

    const html = renderAnalyticsPage();

    expect(html).toContain("45,0 % (из кэша — не удалось обновить)");
  });

  it("serves the account-level average when both components arrived", () => {
    withCatalog();
    withTraffic(ready(EMPTY.traffic), ready(WATCHED_MEDIA_TRAFFIC));

    const html = renderAnalyticsPage();

    expect(html).toContain("45,0 %");
    expect(html).not.toContain("Fansly не передаёт");
  });

  it("cannot turn a failed comments request into an empty Likers card", () => {
    withCatalog({ useContentComments: failed() });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const html = renderAnalyticsPage();

    // "Not collected by design" is a claim about Fansly, not about our request.
    expect(html).not.toContain("Лайки не собираются");
    expect(html).not.toContain("За этот период комментариев не собрано.");
    expect(occurrences(html, PANEL_FAILED)).toBe(2);
    expect(html).toContain("Не показано: Комментарии к постам, Лайки.");
  });

  it("keeps cached data on screen and labels it cached when the refresh fails", () => {
    withCatalog({ useStatsMedia: cached(EMPTY.media) });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const html = renderAnalyticsPage();

    expect(html).toContain("Не удалось обновить");
    // Stale data is still data: the panel renders, and it is not in the banner.
    expect(html).toContain("Рейтинг медиа за этот период не собран.");
    expect(html).not.toContain("Часть данных не загрузилась.");
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

    expect(html).toContain("Проверяем полноту");
    expect(html).toContain("Загружаем сведения о сборе…");
    expect(html).not.toContain("No coverage data for this page.");
  });

  it("says coverage is unavailable — never “no coverage data” — when the request failed", () => {
    withCatalog({ useStatsCoverage: failed() });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const html = renderAnalyticsPage();

    expect(html).toContain("Полнота не проверена");
    // The old panel mapped `!data` to this sentence, turning a failed request
    // into a verdict about the page.
    expect(html).not.toContain("No coverage data for this page.");
    expect(html).toContain(PANEL_FAILED);
    expect(html).toContain("Не показано: Покрытие данных, отметки полноты на всех панелях.");
    // The other panels' data is not in doubt — only its completeness is.
    expect(html).toContain("Рейтинг медиа за этот период не собран.");
  });

  it("does not let an old “complete” verdict remove the badge after a failed refresh", () => {
    withCatalog({ useStatsCoverage: cached(COVERED) });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const html = renderAnalyticsPage();

    expect(html).toContain("Полнота: не удалось обновить");
    expect(html).not.toContain("Часть данных не загрузилась.");
  });

  it("does not let the Likers card state its lane verdict over a pending coverage request", () => {
    // The verdict is a CONSTANT ([E4]), which is exactly why it slipped the
    // first time: nothing about it is derived from coverage rows, so nothing
    // stopped it being rendered definitively while coverage was unknown.
    withCatalog({ useStatsCoverage: loading() });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const likers = panelMarkup(renderAnalyticsPage(), "Лайки");

    expect(likers).toContain("Проверяем полноту");
    expect(likers).not.toContain(">Сбор не начат<");
  });

  it("does not let the Likers card state its lane verdict over a FAILED coverage request", () => {
    withCatalog({ useStatsCoverage: failed() });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const likers = panelMarkup(renderAnalyticsPage(), "Лайки");

    expect(likers).toContain("Полнота не проверена");
    expect(likers).not.toContain(">Сбор не начат<");
  });

  it("marks the Likers verdict as cached when the coverage refresh failed", () => {
    withCatalog({ useStatsCoverage: cached(COVERED) });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const likers = panelMarkup(renderAnalyticsPage(), "Лайки");

    expect(likers).toContain("Полнота: не удалось обновить");
    expect(likers).not.toContain(">Сбор не начат<");
    // The cached verdict is still reported — in the badge's tooltip, WITH the
    // failure beside it. Losing it would be losing a fact.
    expect(likers).toContain("Последняя известная оценка: Сбор не начат.");
  });

  it("states the Likers lane verdict once coverage has actually answered", () => {
    withCatalog();
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const likers = panelMarkup(renderAnalyticsPage(), "Лайки");

    expect(likers).toContain(">Сбор не начат<");
    expect(likers).toContain("Лайки не собираются");
  });

  it("falls through to the real capture verdict once coverage answered", () => {
    withCatalog({ useStatsCoverage: ready(EMPTY.coverage) });
    withTraffic(ready(EMPTY.traffic), ready(EMPTY.traffic));

    const html = renderAnalyticsPage();

    // A SUCCEEDED coverage request with no row for a required plane is a
    // capture verdict ("coverage unknown"), not a request state — and none of
    // the request-state badges may stand in for it.
    expect(html).toContain("Полнота неизвестна");
    expect(html).not.toContain("Проверяем полноту");
    expect(html).not.toContain("Полнота не проверена");
    expect(html).not.toContain("Полнота: не удалось обновить");
    // …and an empty panel under an unknown verdict does not claim the world
    // was empty.
    expect(html).toContain("За этот период ничего не собрано");
  });
});
