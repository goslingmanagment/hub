import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

const queryMocks = vi.hoisted(() => ({
  useAuthMe: vi.fn(),
  useOverview: vi.fn(),
  useOverviewGrowth: vi.fn(),
  useOverviewRevenue: vi.fn(),
  usePageFollowersDaily: vi.fn(),
  usePageRevenue: vi.fn(),
  usePageRevenueDaily: vi.fn(),
  usePageSubscribers: vi.fn(),
  usePageSubscribersDaily: vi.fn(),
  usePageTransactions: vi.fn(),
  useSpenders: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { CrmSummaryHeader } from "../apps/dashboard/src/components/page/crm/CrmSummaryHeader.tsx";
import { OverviewPage } from "../apps/dashboard/src/pages/OverviewPage.tsx";
import { PageDetailPage } from "../apps/dashboard/src/pages/PageDetailPage.tsx";

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

function buildOverviewPage(syncUx = buildSyncUx()) {
  return {
    overall: {
      syncUx: buildSyncUx(),
    },
    pages: [{
      id: 1,
      label: "lana",
      platform: "fansly" as const,
      modelSlug: "lana",
      modelName: "Lana",
      username: "lana",
      subscriberCount: 12,
      followerCount: 34,
      syncUx,
    }],
  };
}

function buildCrmSummary(
  overrides: Partial<{
    pendingMessageBackfillCount: number;
    previewReadyConversationCount: number;
    messageSyncUx: ReturnType<typeof buildSyncUx>;
  }> = {},
) {
  return {
    page: {
      id: 1,
      label: "lana",
      platform: "fansly" as const,
      modelSlug: "lana",
      modelName: "Lana",
      username: "lana",
      displayName: "Lana",
      followerCount: 34,
      subscriberCount: 12,
      lastLightSyncAt: null,
      lastFollowerSyncAt: null,
    },
    retention: {
      total: 12,
      countsByTouchpoint: {
        "21d": 1,
        "14d": 1,
        "7d": 1,
        "5d": 1,
        "3d": 1,
        "1d": 1,
      },
    },
    reactivation: {
      total: 5,
    },
    freshness: {
      lastConversationChunkSucceededAt: null,
      lastConversationFullSweepAt: null,
      lastMessageChunkSucceededAt: null,
    },
    coverage: {
      pendingMessageBackfillCount: overrides.pendingMessageBackfillCount ?? 0,
      previewReadyConversationCount: overrides.previewReadyConversationCount ?? 1,
    },
    messageSyncUx: overrides.messageSyncUx ?? buildSyncUx(),
  };
}

function renderWithRouter(element: ReturnType<typeof createElement>, initialEntries = ["/"]) {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries },
    element,
  ));
}

describe("dashboard sync product surfaces", () => {
  beforeEach(() => {
    queryMocks.useAuthMe.mockReset();
    queryMocks.useOverview.mockReset();
    queryMocks.useOverviewGrowth.mockReset();
    queryMocks.useOverviewRevenue.mockReset();
    queryMocks.usePageFollowersDaily.mockReset();
    queryMocks.usePageRevenue.mockReset();
    queryMocks.usePageRevenueDaily.mockReset();
    queryMocks.usePageSubscribers.mockReset();
    queryMocks.usePageSubscribersDaily.mockReset();
    queryMocks.usePageTransactions.mockReset();
    queryMocks.useSpenders.mockReset();

    queryMocks.useAuthMe.mockReturnValue({
      data: { user: { username: "owner", role: "owner" } },
      isLoading: false,
    });
    queryMocks.useOverviewRevenue.mockReturnValue({
      data: {
        netEarningsMills: 0,
        pages: [{ pageId: 1, netEarningsMills: 0 }],
      },
    });
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

  it("shows overview attention banner with sync settings link", () => {
    queryMocks.useOverview.mockReturnValue({
      data: buildOverviewPage(buildSyncUx({
        state: "attention",
        label: "Needs attention",
        headline: "Sync needs attention",
      })),
      isLoading: false,
    });

    const html = renderWithRouter(createElement(OverviewPage));

    expect(html).toContain("Data may be incomplete");
    expect(html).toContain("Check sync settings");
    expect(html).toContain("href=\"/settings?tab=sync\"");
  });

  it("shows page detail exceptions with generic sync copy", () => {
    queryMocks.useOverview.mockReturnValue({
      data: buildOverviewPage(buildSyncUx({
        state: "attention",
        label: "Needs attention",
        headline: "Sync needs attention",
        detail: "Worker needs help.",
      })),
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
    );

    expect(html).toContain("Data updates paused");
    expect(html).toContain("check sync settings");
    expect(html).toContain("href=\"/settings?tab=sync\"");
    expect(html).not.toContain("Sync needs attention");
  });

  it("suppresses credentials exceptions on page detail", () => {
    queryMocks.useOverview.mockReturnValue({
      data: buildOverviewPage(buildSyncUx({
        state: "attention",
        label: "Reconnect",
        headline: "Reconnect to resume sync",
        requiresAction: true,
      })),
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
    );

    expect(html).not.toContain("Data updates paused");
    expect(html).not.toContain("Reconnect credentials");
  });

  it("uses CRM coverage language instead of generic sync chrome", () => {
    const html = renderToStaticMarkup(createElement(CrmSummaryHeader, {
      summary: buildCrmSummary({
        pendingMessageBackfillCount: 3,
        previewReadyConversationCount: 0,
        messageSyncUx: buildSyncUx({
          state: "retrying",
          headline: "Conversation history is still syncing",
        }),
      }),
    }));

    expect(html).toContain("3 conversations are still loading. Previews will fill in automatically.");
    expect(html).not.toContain("Conversation history is still syncing");
    expect(html).not.toContain("Up to date");
  });

  it("shows CRM credential blockers in credential language", () => {
    const html = renderToStaticMarkup(createElement(CrmSummaryHeader, {
      summary: buildCrmSummary({
        previewReadyConversationCount: 2,
        messageSyncUx: buildSyncUx({
          state: "attention",
          requiresAction: true,
          label: "Reconnect",
          headline: "Reconnect to resume sync",
        }),
      }),
    }));

    expect(html).toContain("Reconnect credentials to keep conversation history current.");
    expect(html).not.toContain("Reconnect to resume sync");
  });
});
