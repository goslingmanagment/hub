import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { ApiError } from "../apps/dashboard/src/api/client.ts";
import { DashboardShellProvider } from "../apps/dashboard/src/components/layout/DashboardShellContext.tsx";
import { resolveLegacyWorkboardRedirect } from "../apps/dashboard/src/lib/navigation.ts";

const queryMocks = vi.hoisted(() => ({
  useWorkboard: vi.fn(),
  useWorkboardPresence: vi.fn(),
  useWorkboardSnooze: vi.fn(),
  useWorkboardUnsnooze: vi.fn(),
}));
const presencePanelMock = vi.hoisted(() => vi.fn((props: {
  isOpen: boolean;
  unavailable: boolean;
}) => `Presence ${props.isOpen ? "Скрыть" : "Показать"}${props.unavailable ? " Presence unavailable right now." : ""}`));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);
vi.mock("../apps/dashboard/src/components/page/workboard/PresencePanel.tsx", () => ({
  PresencePanel: presencePanelMock,
}));

import { WorkboardPage } from "../apps/dashboard/src/pages/WorkboardPage.tsx";

type DashboardShellValue = ComponentProps<typeof DashboardShellProvider>["value"];
type DashboardPage = DashboardShellValue["pages"][number];
type PageCatalogState = DashboardShellValue["pageCatalogState"];

function buildPageMetric(value: number | null) {
  return {
    value,
    available: value !== null,
  };
}

function buildPage(platform: "fansly" | "onlyfans" = "fansly"): DashboardPage {
  return {
    id: 1,
    label: "lana",
    platform,
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
    syncUx: {
      state: "healthy" as const,
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

function renderPage({
  initialEntries = ["/pages/lana/workboard"],
  pages = [buildPage()],
  pageCatalogState = "ready" as PageCatalogState,
  pageCatalogError = null as Error | null,
}: {
  initialEntries?: string[];
  pages?: DashboardPage[];
  pageCatalogState?: PageCatalogState;
  pageCatalogError?: Error | null;
} = {}) {
  const shellValue: DashboardShellValue = {
    pageCatalogState,
    pageCatalogError,
    pages,
    findPageByLabel: (pageLabel: string | undefined) =>
      pages.find((page) => page.label === pageLabel) ?? null,
  };

  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries },
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

describe("WorkboardPage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    queryMocks.useWorkboard.mockReset();
    queryMocks.useWorkboardPresence.mockReset();
    queryMocks.useWorkboardSnooze.mockReset();
    queryMocks.useWorkboardUnsnooze.mockReset();
    presencePanelMock.mockClear();

    queryMocks.useWorkboard.mockReturnValue({
      data: undefined,
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

  it("shows an explicit loading state while the shell page catalog is still resolving", () => {
    queryMocks.useWorkboard.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: undefined,
    });

    const html = renderPage({
      pages: [],
      pageCatalogState: "loading",
    });

    expect(html).toContain("Загрузка");
    expect(html).toContain("Подготовка данных страницы и загрузка очереди.");
    expect(html).not.toContain("Страница не найдена");
  });

  it("shows not found only after the shell catalog has loaded without the page", () => {
    const html = renderPage({
      pages: [{
        ...buildPage(),
        label: "other",
      }],
    });

    expect(html).toContain("Страница не найдена");
    expect(queryMocks.useWorkboard).toHaveBeenCalledWith("lana", { enabled: false });
  });

  it("redirects non-Fansly pages back to the page detail route", () => {
    const html = renderPage({
      pages: [buildPage("onlyfans")],
    });

    expect(html).toBe("");
    expect(html).not.toContain("Страница не найдена");
    expect(queryMocks.useWorkboard).toHaveBeenCalledWith("lana", { enabled: false });
  });

  it("shows an explicit not-found state when the API reports no workboard snapshot", () => {
    queryMocks.useWorkboard.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError(404, { message: "Missing snapshot" }),
    });

    const html = renderPage();

    expect(html).toContain("Workboard недоступен");
    expect(html).toContain("Для этой страницы Workboard недоступен.");
  });

  it("keeps API totals in the header while surfacing rows hidden client-side", () => {
    queryMocks.useWorkboard.mockReturnValue({
      data: {
        subscribers: {
          total: 1,
          items: [{
            fanId: 101,
            fan: {
              platformUserId: "deleted-user-12345678",
              pageAlias: null,
              username: null,
              displayName: null,
            },
            ltv: { creatorNetAmountMills: 3117560 },
            touchpoint: {
              code: "7d",
              label: "7d",
              isSoft: false,
              dueAt: "2026-03-30T12:00:00.000Z",
            },
            overdueDays: 1,
            conversation: {
              platformConversationId: null,
              lastFanMessageAt: null,
              lastModelMessageAt: null,
              lastMessagePreview: null,
              storedMessageCount: 0,
              messageBackfillComplete: false,
            },
            subscription: {
              expiresAt: "2026-04-05T12:00:00.000Z",
              autoRenew: false,
              tierName: "VIP",
              subscriberSince: "2026-03-01T12:00:00.000Z",
            },
            lastTransactionAt: null,
          }],
        },
        activeSpenders: {
          total: 0,
          items: [],
        },
        inactiveSpenders: {
          total: 0,
          items: [],
        },
        snoozed: {
          total: 1,
          items: [{
            fanId: 101,
            fan: {
              platformUserId: "deleted-user-12345678",
              pageAlias: null,
              username: null,
              displayName: null,
            },
            ltv: { creatorNetAmountMills: 3117560 },
            snoozedUntil: "2026-04-06T12:00:00.000Z",
          }],
        },
      },
      isLoading: false,
      isError: false,
      error: undefined,
    });

    const html = renderPage();

    expect(html).toContain("Ожидают внимания: 1");
    expect(html).toContain("1 скрыто");
    expect(html).toContain("Нет видимых фанов");
    expect(html).not.toContain("Deleted user");
  });

  it("keeps the presence section collapsed and does not fetch it until opened", () => {
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

    const html = renderPage();

    expect(html).toContain("Presence");
    expect(html).toContain("Показать");
    expect(html).not.toContain("Inferred from Fansly follower activity.");
    expect(html).not.toContain("Active now");
    expect(queryMocks.useWorkboardPresence).toHaveBeenCalledWith("lana", { enabled: false });
  });

  it("keeps the main queue available while the presence section stays collapsed", () => {
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
      isError: true,
      error: new Error("presence failed"),
    });

    const html = renderPage();

    expect(html).toContain("Presence");
    expect(html).toContain("Показать");
    expect(html).not.toContain("Ошибка загрузки");
  });

  it("keeps stale presence data available when a background refetch fails", () => {
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
    expect(presenceProps?.activeNow[0]?.fanLabel).toBe("Presence Active");
  });

  it("counts unique actionable fans when the spender tab includes the full spender pool", () => {
    queryMocks.useWorkboard.mockReturnValue({
      data: {
        subscribers: {
          total: 1,
          items: [{
            fanId: 101,
            fan: {
              platformUserId: "subscriber-101",
              pageAlias: "Subscriber One",
              username: "subscriber_one",
              displayName: "Subscriber One",
            },
            ltv: { creatorNetAmountMills: 3117560 },
            touchpoint: {
              code: "7d",
              label: "7d",
              isSoft: false,
              dueAt: "2026-03-30T12:00:00.000Z",
            },
            overdueDays: 1,
            conversation: {
              platformConversationId: null,
              lastFanMessageAt: null,
              lastModelMessageAt: null,
              lastMessagePreview: null,
              storedMessageCount: 0,
              messageBackfillComplete: false,
            },
            subscription: {
              expiresAt: "2026-04-05T12:00:00.000Z",
              autoRenew: false,
              tierName: "VIP",
              subscriberSince: "2026-03-01T12:00:00.000Z",
            },
            lastTransactionAt: null,
          }],
        },
        activeSpenders: {
          total: 1,
          items: [{
            fanId: 201,
            fan: {
              platformUserId: "spender-201",
              pageAlias: "Active Spender",
              username: "active_spender",
              displayName: "Active Spender",
            },
            ltv: { creatorNetAmountMills: 200000 },
            segment: "active",
            overdueDays: 2,
            silenceDays: 9,
            conversation: {
              platformConversationId: null,
              lastFanMessageAt: null,
              lastModelMessageAt: null,
              lastMessagePreview: null,
              storedMessageCount: 0,
              messageBackfillComplete: false,
            },
            subscription: {
              status: "never",
              expiresAt: null,
            },
            lastTransactionAt: "2026-03-25T12:00:00.000Z",
          }],
        },
        inactiveSpenders: {
          total: 2,
          items: [
            {
              fanId: 201,
              fan: {
                platformUserId: "spender-201",
                pageAlias: "Active Spender",
                username: "active_spender",
                displayName: "Active Spender",
              },
              ltv: { creatorNetAmountMills: 200000 },
              segment: "active",
              overdueDays: 2,
              silenceDays: 9,
              conversation: {
                platformConversationId: null,
                lastFanMessageAt: null,
                lastModelMessageAt: null,
                lastMessagePreview: null,
                storedMessageCount: 0,
                messageBackfillComplete: false,
              },
              subscription: {
                status: "never",
                expiresAt: null,
              },
              lastTransactionAt: "2026-03-25T12:00:00.000Z",
            },
            {
              fanId: 202,
              fan: {
                platformUserId: "spender-202",
                pageAlias: "Inactive Spender",
                username: "inactive_spender",
                displayName: "Inactive Spender",
              },
              ltv: { creatorNetAmountMills: 150000 },
              segment: "inactive",
              overdueDays: 5,
              silenceDays: 19,
              conversation: {
                platformConversationId: null,
                lastFanMessageAt: null,
                lastModelMessageAt: null,
                lastMessagePreview: null,
                storedMessageCount: 0,
                messageBackfillComplete: false,
              },
              subscription: {
                status: "expired",
                expiresAt: "2026-02-01T12:00:00.000Z",
              },
              lastTransactionAt: "2026-02-10T12:00:00.000Z",
            },
          ],
        },
        snoozed: {
          total: 0,
          items: [],
        },
      },
      isLoading: false,
      isError: false,
      error: undefined,
    });

    const html = renderPage();

    expect(html).toContain("Ожидают внимания: 3");
    expect(html).toContain("Все спендеры");
  });

  it("uses the canonical workboard route for legacy CRM aliases", () => {
    expect(resolveLegacyWorkboardRedirect("lana")).toBe("/pages/lana/workboard");
    expect(resolveLegacyWorkboardRedirect(undefined)).toBe("/");
  });
});
