import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { DashboardShellProvider } from "../apps/dashboard/src/components/layout/DashboardShellContext.tsx";

const queryMocks = vi.hoisted(() => ({
  useWorkboard: vi.fn(),
  useWorkboardPresence: vi.fn(),
  useWorkboardSnooze: vi.fn(),
  useWorkboardUnsnooze: vi.fn(),
}));

const presencePanelMock = vi.hoisted(() => vi.fn(() => "presence"));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);
vi.mock("../apps/dashboard/src/components/page/workboard/PresencePanel.tsx", () => ({
  PresencePanel: presencePanelMock,
}));

import { WorkboardPage } from "../apps/dashboard/src/pages/WorkboardPage.tsx";

type DashboardShellValue = ComponentProps<typeof DashboardShellProvider>["value"];
type DashboardPage = DashboardShellValue["pages"][number];

function buildPage(): DashboardPage {
  return {
    id: 1,
    label: "lana",
    platform: "fansly",
    modelSlug: "lana",
    modelName: "Lana",
    username: "lana",
    subscriberCount: { value: 12, available: true },
    followerCount: { value: 34, available: true },
    revenueTodayMills: 0,
    revenue7dMills: 0,
    revenue30dMills: 0,
    newSubscribersToday: 0,
    newFollowersToday: 0,
    connectionStatus: "active",
    lastLightSyncAt: null,
    lastFollowerSyncAt: null,
    lastSyncError: null,
    syncUx: {
      state: "healthy",
      label: "Up to date",
      headline: "Up to date",
      detail: null,
      progressLabel: null,
      nextRetryAt: null,
      updatedAt: "2026-03-24T11:55:00.000Z",
      requiresAction: false,
    },
  };
}

function renderPage() {
  const pages = [buildPage()];
  const shellValue: DashboardShellValue = {
    pageCatalogState: "ready",
    pageCatalogError: null,
    pages,
    findPageByLabel: (pageLabel: string | undefined) =>
      pages.find((page) => page.label === pageLabel) ?? null,
  };

  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: ["/pages/lana/workboard"] },
    createElement(
      DashboardShellProvider,
      {
        value: shellValue,
        children: createElement(
          Routes,
          undefined,
          createElement(Route, {
            path: "/pages/:pageLabel/workboard",
            element: createElement(WorkboardPage),
          }),
          createElement(Route, {
            path: "/pages/:pageLabel",
            element: createElement("div", null, "Page detail"),
          }),
        ),
      },
    ),
  ));
}

describe("WorkboardPage presence availability", () => {
  beforeEach(() => {
    presencePanelMock.mockClear();
    queryMocks.useWorkboard.mockReset();
    queryMocks.useWorkboardPresence.mockReset();
    queryMocks.useWorkboardSnooze.mockReset();
    queryMocks.useWorkboardUnsnooze.mockReset();

    queryMocks.useWorkboard.mockReturnValue({
      data: {
        subscribers: { total: 0, items: [] },
        activeSpenders: { total: 0, items: [] },
        inactiveSpenders: { total: 0, items: [] },
        snoozed: { total: 0, items: [] },
      },
      isLoading: false,
      isError: false,
      error: undefined,
    });
    queryMocks.useWorkboardPresence.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: undefined,
    });
    queryMocks.useWorkboardSnooze.mockReturnValue({
      mutateAsync: vi.fn(),
    });
    queryMocks.useWorkboardUnsnooze.mockReturnValue({
      mutateAsync: vi.fn(),
    });
  });

  it("keeps stale presence data available when a background refetch fails", () => {
    queryMocks.useWorkboardPresence.mockReturnValue({
      data: {
        updatedAt: "2026-03-30T11:58:00.000Z",
        bestEffort: true,
        activeNow: {
          total: 1,
          items: [{
            fanId: 301,
            fan: {
              platformUserId: "presence-active",
              pageAlias: "Presence Active",
              username: "presence_active",
              displayName: "Presence Active",
            },
            presence: {
              lastSeenAt: "2026-03-30T11:50:00.000Z",
              observedAt: "2026-03-30T11:58:00.000Z",
              source: "fansly_followers_last_seen",
            },
            ltv: {
              creatorNetAmountMills: 240000,
            },
            isSubscriber: true,
            platformConversationId: "conversation-301",
            lastTransactionAt: "2026-03-30T11:00:00.000Z",
          }],
        },
        recentlyActive: {
          total: 0,
          items: [],
        },
      },
      isLoading: false,
      isError: true,
      error: new Error("presence refetch failed"),
    });

    renderPage();

    const presenceProps = presencePanelMock.mock.calls.at(-1)?.[0];
    expect(presenceProps).toMatchObject({
      unavailable: false,
      activeNowTotal: 1,
    });
  });
});
