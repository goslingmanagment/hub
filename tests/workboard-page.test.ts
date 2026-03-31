import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { ApiError } from "../apps/dashboard/src/api/client.ts";
import { DashboardShellProvider } from "../apps/dashboard/src/components/layout/DashboardShellContext.tsx";
import { resolveLegacyWorkboardRedirect } from "../apps/dashboard/src/lib/navigation.ts";

const queryMocks = vi.hoisted(() => ({
  useWorkboard: vi.fn(),
  useWorkboardSnooze: vi.fn(),
  useWorkboardUnsnooze: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { WorkboardPage } from "../apps/dashboard/src/pages/WorkboardPage.tsx";

type DashboardShellValue = ComponentProps<typeof DashboardShellProvider>["value"];
type DashboardPage = DashboardShellValue["pages"][number];
type PageCatalogState = DashboardShellValue["pageCatalogState"];

function buildPage(platform: "fansly" | "onlyfans" = "fansly"): DashboardPage {
  return {
    id: 1,
    label: "lana",
    platform,
    modelSlug: "lana",
    modelName: "Lana",
    username: "lana",
    subscriberCount: 12,
    followerCount: 34,
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
  beforeEach(() => {
    queryMocks.useWorkboard.mockReset();
    queryMocks.useWorkboardSnooze.mockReset();
    queryMocks.useWorkboardUnsnooze.mockReset();

    queryMocks.useWorkboard.mockReturnValue({
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

    expect(html).toContain("Loading workboard");
    expect(html).toContain("Resolving page details and fetching the workboard snapshot.");
    expect(html).not.toContain("Page not found");
  });

  it("shows not found only after the shell catalog has loaded without the page", () => {
    const html = renderPage({
      pages: [{
        ...buildPage(),
        label: "other",
      }],
    });

    expect(html).toContain("Page not found");
    expect(queryMocks.useWorkboard).toHaveBeenCalledWith("lana", { enabled: false });
  });

  it("redirects non-Fansly pages back to the page detail route", () => {
    const html = renderPage({
      pages: [buildPage("onlyfans")],
    });

    expect(html).toBe("");
    expect(html).not.toContain("Page not found");
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

    expect(html).toContain("Workboard unavailable");
    expect(html).toContain("does not expose a workboard snapshot");
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

    expect(html).toContain("1 need attention");
    expect(html).toContain("1 hidden");
    expect(html).toContain("No visible fans in this tab");
    expect(html).not.toContain("Deleted user");
  });

  it("uses the canonical workboard route for legacy CRM aliases", () => {
    expect(resolveLegacyWorkboardRedirect("lana")).toBe("/pages/lana/workboard");
    expect(resolveLegacyWorkboardRedirect(undefined)).toBe("/");
  });
});
