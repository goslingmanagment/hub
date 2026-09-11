import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OverviewResponse, OverviewRevenueResponse } from "@agency_hub_core/contracts";
import { MemoryRouter, Route, Routes } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { DashboardShellProvider } from "../apps/dashboard/src/components/layout/DashboardShellContext.tsx";

const queryMocks = vi.hoisted(() => ({
  useAuthMe: vi.fn(),
  useOverview: vi.fn(),
  useOverviewGrowth: vi.fn(),
  useOverviewRevenue: vi.fn(),
  useOverviewRevenueDaily: vi.fn(),
  useRevenueChart: vi.fn(),
  useOverviewRevenueByModel: vi.fn(),
  usePageFollowersDaily: vi.fn(),
  usePageRevenue: vi.fn(),
  usePageRevenueDaily: vi.fn(),
  usePageSpenderAutoLists: vi.fn(),
  usePageSubscribers: vi.fn(),
  usePageSubscribersDaily: vi.fn(),
  usePageTransactions: vi.fn(),
  useSpenders: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);
vi.mock("../apps/dashboard/src/api/pages.ts", () => queryMocks);
vi.mock("../apps/dashboard/src/api/overview.ts", () => queryMocks);

import { OverviewPage } from "../apps/dashboard/src/pages/OverviewPage.tsx";
import {
  PageDetailPage,
  PageSpenderAutoListsSection,
  PageSpendersSection,
} from "../apps/dashboard/src/pages/PageDetailPage.tsx";

type DashboardShellValue = ComponentProps<typeof DashboardShellProvider>["value"];
type DashboardPage = DashboardShellValue["pages"][number];

function buildPageMetric(value: number | null) {
  return {
    value,
    available: value !== null,
  };
}

function buildSyncUx(
  overrides: Partial<{
    state: "healthy" | "syncing" | "catching_up" | "retrying" | "attention" | "setup" | "off";
    label: string;
    headline: string;
    detail: string | null;
    progressLabel: string | null;
    nextRetryAt: string | null;
    updatedAt: string | null;
    requiresAction: boolean;
  }> = {},
) {
  return {
    state: "healthy" as const,
    label: "Up to date",
    headline: "Up to date",
    detail: "All syncs are current.",
    progressLabel: null,
    nextRetryAt: null,
    updatedAt: "2026-03-24T11:55:00.000Z",
    requiresAction: false,
    ...overrides,
  };
}

function buildOverviewPageItem(syncUx = buildSyncUx(), overrides: Partial<DashboardPage> = {}): DashboardPage {
  return {
    id: 1,
    label: "lana",
    platform: "fansly",
    modelSlug: "lana",
    modelName: "Lana",
    username: "lana",
    subscriberCount: buildPageMetric(12),
    followerCount: buildPageMetric(34),
    revenueTodayMills: 0,
    revenue7dMills: 0,
    revenue30dMills: 0,
    newSubscribersToday: 0,
    newFollowersToday: 0,
    connectionStatus: "active",
    lastLightSyncAt: null,
    lastFollowerSyncAt: null,
    lastSyncError: null,
    syncUx,
    ...overrides,
  };
}

function buildOverviewPage(syncUx = buildSyncUx()): OverviewResponse {
  return {
    counts: {
      models: 1,
      pages: 1,
      fans: 0,
    },
    revenue: {
      "7d": {
        revenueMills: 0,
        adjustmentMills: 0,
        unclassifiedMills: 0,
        netEarningsMills: 0,
        previousNetEarningsMills: 0,
        deltaPct: null,
      },
      "30d": {
        revenueMills: 0,
        adjustmentMills: 0,
        unclassifiedMills: 0,
        netEarningsMills: 0,
        previousNetEarningsMills: 0,
        deltaPct: null,
      },
    },
    overall: {
      syncUx: buildSyncUx(),
    },
    pages: [buildOverviewPageItem(syncUx)],
    setup: {
      hasPages: true,
      hasFanslyPages: true,
      hasOnlyFansPages: false,
    },
  };
}

function buildOverviewRevenue(overview = buildOverviewPage(), net = 0): OverviewRevenueResponse {
  return {
    period: "7d", windowAt: "2026-09-10T19:45:00Z", from: "2026-09-04T00:00:00Z", to: "2026-09-11T00:00:00Z", currency: "USD",
    revenueMills: net, adjustmentMills: 0, unclassifiedMills: 0, netEarningsMills: net, totalNetMills: net, breakdown: [], comparison: null,
    platformWindows: [{ platform: "fansly", from: "2026-09-04T00:00:00Z", to: "2026-09-11T00:00:00Z", comparisonFrom: "2026-08-28T00:00:00Z", comparisonTo: "2026-09-04T00:00:00Z" }],
    models: [{ modelId: 1, modelSlug: "lana", modelName: "Lana", pageCount: overview.pages.length, netEarningsMills: net, totalNetMills: net }],
    pages: overview.pages.map((page) => ({ pageId: page.id, pageLabel: page.label, modelSlug: "lana", modelName: "Lana", platform: page.platform, netEarningsMills: net, totalNetMills: net })),
  };
}

function renderWithRouter(
  element: ReturnType<typeof createElement>,
  initialEntries = ["/"],
  pages = buildOverviewPage().pages,
  shellOverrides: Partial<DashboardShellValue> = {},
) {
  const shellValue: DashboardShellValue = {
    pageCatalogState: "ready" as const,
    pageCatalogError: null,
    pages,
    findPageByLabel: (pageLabel: string | undefined) =>
      pages.find((page) => page.label === pageLabel) ?? null,
    ...shellOverrides,
  };

  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries },
    createElement(
      DashboardShellProvider,
      { value: shellValue, children: element },
    ),
  ));
}

describe("dashboard sync product surfaces", () => {
  beforeEach(() => {
    queryMocks.useAuthMe.mockReset();
    queryMocks.useOverview.mockReset();
    queryMocks.useOverviewGrowth.mockReset();
    queryMocks.useOverviewRevenue.mockReset();
    queryMocks.useOverviewRevenueDaily.mockReset();
    queryMocks.useOverviewRevenueByModel.mockReset();
    queryMocks.usePageFollowersDaily.mockReset();
    queryMocks.usePageRevenue.mockReset();
    queryMocks.usePageRevenueDaily.mockReset();
    queryMocks.usePageSpenderAutoLists.mockReset();
    queryMocks.usePageSubscribers.mockReset();
    queryMocks.usePageSubscribersDaily.mockReset();
    queryMocks.usePageTransactions.mockReset();
    queryMocks.useSpenders.mockReset();

    queryMocks.useAuthMe.mockReturnValue({
      data: { user: { username: "owner", role: "owner" } },
      isLoading: false,
    });
    queryMocks.useOverview.mockReturnValue({ data: buildOverviewPage() });
    queryMocks.useOverviewRevenue.mockReturnValue({ data: buildOverviewRevenue() });
    queryMocks.useRevenueChart.mockReset();
    queryMocks.useRevenueChart.mockReturnValue({ data: { series: [] } });
    queryMocks.useOverviewRevenueDaily.mockReturnValue({ data: { series: [] } });
    queryMocks.useOverviewRevenueByModel.mockReturnValue({ data: { models: [] } });
    queryMocks.useOverviewGrowth.mockReturnValue({
      data: {
        pages: [{ pageId: 1, newFollowers: 0, newSubscribers: 0 }],
      },
      isLoading: false,
      isFetching: false,
      isPlaceholderData: false,
    });
    queryMocks.usePageRevenue.mockReturnValue({
      data: {
        netEarningsMills: 0,
        comparison: { deltaPct: null },
        breakdown: [],
      },
    });
    queryMocks.usePageFollowersDaily.mockReturnValue({ data: { items: [] } });
    queryMocks.usePageSubscribersDaily.mockReturnValue({ data: { items: [] } });
    queryMocks.usePageRevenueDaily.mockReturnValue({ data: { series: [] } });
    queryMocks.usePageSpenderAutoLists.mockReturnValue({
      data: {
        page: {
          id: 1,
          label: "lana",
          platform: "fansly",
          modelSlug: "lana",
          modelName: "Lana",
        },
        currency: "USD",
        metric: "lifetimeGrossAmountMills",
        period: {
          timeZone: "UTC",
          fromBusinessDate: null,
          toBusinessDateInclusive: null,
          asOf: "2026-03-24T11:55:00.000Z",
        },
        asOf: "2026-03-24T11:55:00.000Z",
        totalEntries: 0,
        lists: [],
      },
    });
    queryMocks.usePageSubscribers.mockReturnValue({ data: { total: 0, items: [] } });
    queryMocks.usePageTransactions.mockReturnValue({ data: { total: 0, items: [] } });
    queryMocks.useSpenders.mockReturnValue({ data: { total: 0, items: [] } });
  });

  it("suppresses credentials exceptions on overview and shows only attention/off", () => {
    queryMocks.useOverview.mockReturnValue({
      data: buildOverviewPage(buildSyncUx({
        state: "attention",
        label: "Reconnect",
        headline: "Reconnect to resume sync",
        detail: "Credentials expired.",
        requiresAction: true,
      })),
      isLoading: false,
    });

    const html = renderWithRouter(createElement(OverviewPage));

    expect(html).not.toContain("Reconnect credentials");
    expect(html).not.toContain("href=\"/settings?tab=credentials\"");
  });

  it.each(["attention", "off"] as const)("keeps %s visible and links the expanded row to its sync detail", (state) => {
    queryMocks.useOverview.mockReturnValue({ data: buildOverviewPage(buildSyncUx({ state, label: "Needs attention", detail: "Worker needs help." })) });
    const html = renderWithRouter(createElement(OverviewPage), ["/?period=7d&row=lana"]);
    expect(html).toContain("Worker needs help.");
    expect(html).toContain('href="/settings?tab=sync&amp;page=lana"');
  });

  it("keeps revenue available when catalog loading fails, with retry and unknown audience", () => {
    queryMocks.useOverview.mockReturnValue({ isError: true });
    queryMocks.useOverviewRevenue.mockReturnValue({ data: buildOverviewRevenue(undefined, 123450) });
    const html = renderWithRouter(createElement(OverviewPage));
    expect(html).toContain("$123.45");
    expect(html).toContain("Данные не удалось загрузить");
    expect(html).toContain("Повторить");
    expect(html).toContain("Счётчик недоступен");
  });

  it("does not relabel the previous period's placeholder as current", () => {
    queryMocks.useOverviewRevenue.mockReturnValue({ data: buildOverviewRevenue(undefined, 999999), isPlaceholderData: true, isFetching: true });
    const html = renderWithRouter(createElement(OverviewPage));
    expect(html).not.toContain("$999.99");
    expect(html).toContain("Загружаем доход");
  });

  it("preserves current-window cached values with a warning after failed refresh", () => {
    queryMocks.useOverviewRevenue.mockReturnValue({ data: buildOverviewRevenue(undefined, 123450), isError: true });
    const html = renderWithRouter(createElement(OverviewPage));
    expect(html).toContain("$123.45");
    expect(html).toContain("Показаны ранее полученные данные");
  });

  it("keeps unknown audience missing without inventing an agency subscriber total", () => {
    const overview = buildOverviewPage();
    overview.pages.push(buildOverviewPageItem(buildSyncUx(), { id: 2, label: "lana-2", subscriberCount: buildPageMetric(null) }));
    queryMocks.useOverview.mockReturnValue({ data: overview });
    queryMocks.useOverviewRevenue.mockReturnValue({ data: buildOverviewRevenue(overview) });
    const html = renderWithRouter(createElement(OverviewPage));
    expect(html).toContain("Счётчик недоступен");
    expect(html).toContain("Аудитория разных страниц не складывается");
    expect(html).not.toContain("New subscribers");
    expect(html).toContain('href="/pages/lana-2"');
    expect(html).toContain("$0.00");
  });

  it("shows independent chart errors with retries while keeping the table", () => {
    queryMocks.useRevenueChart.mockReturnValue({ isError: true });
    queryMocks.useOverviewRevenueByModel.mockReturnValue({ isError: true });
    const html = renderWithRouter(createElement(OverviewPage));
    expect(html.match(/Данные не удалось загрузить/g)).toHaveLength(2);
    expect(html).toContain("Повторить");
    expect(html).toContain('href="/pages/lana"');
    expect(queryMocks.useOverviewGrowth).not.toHaveBeenCalled();
  });

  it("keeps refunds and unclassified money visible in the expanded source comparison", () => {
    queryMocks.useOverviewRevenue.mockReturnValue({ data: buildOverviewRevenue(undefined, 185000) });
    queryMocks.usePageRevenue.mockReturnValue({ data: {
      netEarningsMills: 185000, adjustmentMills: -20000, unclassifiedMills: 5000,
      breakdown: [
        { canonicalType: "message_purchase", bucket: "revenue", netAmountMills: 200000 },
        { canonicalType: "refund", bucket: "adjustment", netAmountMills: -20000 },
        { canonicalType: "other", bucket: "unclassified", netAmountMills: 5000 },
      ], comparison: null,
    } });
    const html = renderWithRouter(createElement(OverviewPage), ["/?period=7d&row=lana"]);
    expect(html).toContain("$185.00");
    expect(html).toContain("Платные сообщения");
    expect(html).toContain("Возвраты");
    expect(html).toContain("-$20.00");
    expect(html).toContain("Без классификации");
    expect(html).toContain("$5.00");
    expect(html).toContain("включая pending");
    expect(html).toContain("type=refund");
    expect(html).toContain("reportableOnly=true");
  });

  it("keeps OnlyFans audience separate and never exposes an unavailable follower link", () => {
    const overview = buildOverviewPage();
    overview.pages.push(buildOverviewPageItem(buildSyncUx(), { id: 2, label: "of-page", platform: "onlyfans", subscriberCount: buildPageMetric(4371), followerCount: buildPageMetric(null) }));
    queryMocks.useOverview.mockReturnValue({ data: overview });
    queryMocks.useOverviewRevenue.mockReturnValue({ data: buildOverviewRevenue(overview) });
    const html = renderWithRouter(createElement(OverviewPage), ["/?period=7d&row=of-page"]);
    expect(html).toContain((4371).toLocaleString("ru-RU"));
    expect(html).not.toContain((4383).toLocaleString("ru-RU"));
    expect(html).toContain("/pages/of-page/subscribers?filter=all");
    expect(html).not.toContain("/pages/of-page/followers");
    expect(html).toContain("filter=norenew");
    expect(html).toContain("filter=expiring7d");
  });

  it("retains historical earnings without linking to a deleted page or inventing old-server deltas", () => {
    const report = buildOverviewRevenue(undefined, 10000);
    report.pages.push({ pageId: 2, pageLabel: "retired", modelSlug: "lana", modelName: "Lana", netEarningsMills: 0, totalNetMills: 0, previousNetEarningsMills: 200000, deltaNetMills: -200000, deltaPct: -100, platform: "fansly", status: "deleted" });
    queryMocks.useOverviewRevenue.mockReturnValue({ data: report });
    const html = renderWithRouter(createElement(OverviewPage));
    expect(html).toContain("-$200.00");
    expect(html).toContain("-100.0%");
    expect(html).toContain("retired");
    expect(html).toContain("архив");
    expect(html).toContain("pageLabel=retired");
    expect(html).not.toContain('href="/pages/retired"');
    expect(html).toContain("нет сравнения");
  });

  it("shows page detail attention with incomplete-data copy", () => {
    const overview = buildOverviewPage(buildSyncUx({
      state: "attention",
      label: "Needs attention",
      headline: "Sync needs attention",
      detail: "Worker needs help.",
    }));
    queryMocks.useOverview.mockReturnValue({
      data: overview,
      isLoading: false,
    });

    const html = renderWithRouter(
      createElement(Routes, undefined,
        createElement(Route, {
          path: "/pages/:pageLabel",
          element: createElement(PageDetailPage),
        }),
      ),
      ["/pages/lana"],
      overview.pages,
    );

    expect(html).toContain("Data may be incomplete");
    expect(html).toContain("check sync settings");
    expect(html).toContain("href=\"/settings?tab=sync&amp;page=lana\"");
    expect(html).not.toContain("Sync needs attention");
  });

  it("keeps partial pause copy on page detail and deep-links to its sync controls", () => {
    const overview = buildOverviewPage(buildSyncUx({
      state: "off",
      label: "Off",
      headline: "Some data updates are paused",
      detail: "1 sync is paused on this page.",
    }));
    queryMocks.useOverview.mockReturnValue({
      data: overview,
      isLoading: false,
    });

    const html = renderWithRouter(
      createElement(Routes, undefined,
        createElement(Route, {
          path: "/pages/:pageLabel",
          element: createElement(PageDetailPage),
        }),
      ),
      ["/pages/lana"],
      overview.pages,
    );

    expect(html).toContain("Some data updates are paused \u2014 check sync settings");
    expect(html).toContain("href=\"/settings?tab=sync&amp;page=lana\"");
  });

  it("hides non-blocking catching-up sync states on page detail", () => {
    const overview = buildOverviewPage(buildSyncUx({
      state: "catching_up",
      label: "Catching up",
      headline: "Sync is catching up",
      detail: "Conversation history is still catching up.",
    }));
    queryMocks.useOverview.mockReturnValue({
      data: overview,
      isLoading: false,
    });

    const html = renderWithRouter(
      createElement(Routes, undefined,
        createElement(Route, {
          path: "/pages/:pageLabel",
          element: createElement(PageDetailPage),
        }),
      ),
      ["/pages/lana"],
      overview.pages,
    );

    expect(html).not.toContain("Data may be incomplete");
    expect(html).not.toContain("Open Sync Settings");
  });

  it("suppresses credentials exceptions on page detail", () => {
    const overview = buildOverviewPage(buildSyncUx({
      state: "attention",
      label: "Reconnect",
      headline: "Reconnect to resume sync",
      requiresAction: true,
    }));
    queryMocks.useOverview.mockReturnValue({
      data: overview,
      isLoading: false,
    });

    const html = renderWithRouter(
      createElement(Routes, undefined,
        createElement(Route, {
          path: "/pages/:pageLabel",
          element: createElement(PageDetailPage),
        }),
      ),
      ["/pages/lana"],
      overview.pages,
    );

    expect(html).not.toContain("Data updates paused");
    expect(html).not.toContain("Reconnect credentials");
  });

  it("keeps page-detail queries disabled for stale page routes until the not-found state is shown", () => {
    const html = renderWithRouter(
      createElement(Routes, undefined,
        createElement(Route, {
          path: "/pages/:pageLabel",
          element: createElement(PageDetailPage),
        }),
      ),
      ["/pages/missing"],
      buildOverviewPage().pages,
    );

    expect(html).toContain("Page not found");
    expect(queryMocks.usePageRevenue).toHaveBeenCalledWith("missing", "7d", { enabled: false });
    expect(queryMocks.usePageFollowersDaily).toHaveBeenCalledWith("missing", "7d", { enabled: false });
    expect(queryMocks.usePageSubscribersDaily).toHaveBeenCalledWith("missing", "7d", { enabled: false });
    expect(queryMocks.usePageRevenueDaily).toHaveBeenCalledWith("missing", "7d", { enabled: false });
    expect(queryMocks.usePageSubscribers).toHaveBeenCalledWith("missing", { limit: 6 }, { enabled: false });
    expect(queryMocks.usePageSpenderAutoLists).toHaveBeenCalledWith("missing", {
      period: "7d",
    }, { enabled: false });
    expect(queryMocks.usePageTransactions).toHaveBeenCalledWith("missing", {
      limit: 50,
      offset: 0,
      type: undefined,
    }, {
      enabled: false,
    });
    expect(queryMocks.useSpenders).toHaveBeenCalledWith({
      scope: "page",
      pageLabel: "missing",
      period: "7d",
      limit: 50,
      offset: 0,
      sortBy: "creatorNetAmountMills",
      sortDir: "desc",
    }, {
      enabled: false,
    });
  });

  it("enables page-detail queries once the shell catalog resolves the page", () => {
    const overview = buildOverviewPage();

    renderWithRouter(
      createElement(Routes, undefined,
        createElement(Route, {
          path: "/pages/:pageLabel",
          element: createElement(PageDetailPage),
        }),
      ),
      ["/pages/lana"],
      overview.pages,
    );

    expect(queryMocks.usePageRevenue).toHaveBeenCalledWith("lana", "7d", { enabled: true });
    expect(queryMocks.usePageFollowersDaily).toHaveBeenCalledWith("lana", "7d", { enabled: true });
    expect(queryMocks.usePageSubscribersDaily).toHaveBeenCalledWith("lana", "7d", { enabled: true });
    expect(queryMocks.usePageRevenueDaily).toHaveBeenCalledWith("lana", "7d", { enabled: true });
    expect(queryMocks.usePageSubscribers).toHaveBeenCalledWith("lana", { limit: 6 }, { enabled: true });
    expect(queryMocks.usePageSpenderAutoLists).toHaveBeenCalledWith("lana", {
      period: "7d",
    }, { enabled: true });
    expect(queryMocks.usePageTransactions).toHaveBeenCalledWith("lana", {
      limit: 50,
      offset: 0,
      type: undefined,
    }, {
      enabled: true,
    });
    expect(queryMocks.useSpenders).toHaveBeenCalledWith({
      scope: "page",
      pageLabel: "lana",
      period: "7d",
      limit: 50,
      offset: 0,
      sortBy: "creatorNetAmountMills",
      sortDir: "desc",
    }, {
      enabled: true,
    });
  });

  it("renders all-time page spenders from lifetime metrics instead of zeroing window values", () => {
    const html = renderToStaticMarkup(createElement(PageSpendersSection, {
      spenders: {
        scope: {
          kind: "page",
          platform: "fansly",
          pageCount: 1,
          page: {
            id: 1,
            label: "lana",
            platform: "fansly",
            modelSlug: "lana",
            modelName: "Lana",
          },
          model: null,
        },
        period: {
          timeZone: "UTC",
          fromBusinessDate: null,
          toBusinessDateInclusive: null,
          asOf: "2026-03-24T11:55:00.000Z",
        },
        diagnostics: {
          totalGrossAmountMills: 1234,
          totalCreatorNetAmountMills: 1234,
          attributedGrossAmountMills: 1234,
          attributedCreatorNetAmountMills: 1234,
          unattributedGrossAmountMills: 0,
          unattributedCreatorNetAmountMills: 0,
        },
        total: 1,
        items: [{
          fan: {
            platform: "fansly",
            platformUserId: "fan-001",
            username: "buyer",
            displayName: "Buyer One",
            createdAtExternal: null,
            pageAlias: null,
          },
          metrics: {
            window: null,
            lifetime: {
              scopeGrossAmountMills: 1234,
              scopeCreatorNetAmountMills: 1234,
              platformGrossAmountMills: 1234,
              platformCreatorNetAmountMills: 1234,
            },
            comparison: null,
          },
          lifetimeLastTransactionAt: null,
          lastFanMessageAt: null,
          conversation: {
            platformConversationId: null,
            unreadCount: 0,
            lastMessageAt: null,
            lastFanMessageAt: null,
            lastModelMessageAt: null,
            lastMessagePreview: null,
            storedMessageCount: 0,
            messageCoverageStatus: "pending_backfill",
            messageBackfillComplete: false,
          },
          lastTransaction: null,
          retentionStatus: "inactive",
        }],
        limit: 50,
        offset: 0,
      },
      spenderPeriod: "lifetime",
      spendersOffset: 0,
      onPageChange: () => undefined,
      onOpenFanProfile: () => undefined,
    }));

    expect(html).toContain("$1.23");
    expect(html).toContain(">—</td>");
  });

  it("renders page spender auto-list buckets with entry counts", () => {
    const html = renderToStaticMarkup(createElement(
      MemoryRouter,
      undefined,
      createElement(PageSpenderAutoListsSection, {
        pageLabel: "lana",
        autoLists: {
          page: {
            id: 1,
            label: "lana",
            platform: "fansly",
            modelSlug: "lana",
            modelName: "Lana",
          },
          currency: "USD",
          metric: "lifetimeGrossAmountMills",
          period: {
            timeZone: "UTC",
            fromBusinessDate: null,
            toBusinessDateInclusive: null,
            asOf: "2026-03-24T11:55:00.000Z",
          },
          asOf: "2026-03-24T11:55:00.000Z",
          totalEntries: 3,
          lists: [
            {
              key: "0-25",
              label: "[FB] $0-$25 Spenders",
              minAmountMills: 10,
              maxAmountMillsExclusive: 25000,
              entryCount: 2,
            },
            {
              key: "600-plus",
              label: "[FB] $600+ Spenders",
              minAmountMills: 600000,
              maxAmountMillsExclusive: null,
              entryCount: 1,
            },
          ],
        },
      }),
    ));

    expect(html).toContain("Spender Auto Lists");
    expect(html).toContain('href="/pages/lana/spender-autolists/0-25"');
    expect(html).toContain("[FB] $0-$25 Spenders");
    expect(html).toContain("2 Entries");
    expect(html).toContain("[FB] $600+ Spenders");
    expect(html).toContain("1 Entries");
  });
});
