import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

const queryMocks = vi.hoisted(() => ({
  useOverview: vi.fn(),
  useWorkboard: vi.fn(),
  useWorkboardSnooze: vi.fn(),
  useWorkboardUnsnooze: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { WorkboardPage } from "../apps/dashboard/src/pages/WorkboardPage.tsx";

function renderPage() {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: ["/pages/lana/crm"] },
    createElement(
      Routes,
      undefined,
      createElement(Route, {
        path: "/pages/:pageLabel/crm",
        element: createElement(WorkboardPage),
      }),
      createElement(Route, {
        path: "/pages/:pageLabel",
        element: createElement("div", null, "Page detail"),
      }),
    ),
  ));
}

describe("WorkboardPage", () => {
  beforeEach(() => {
    queryMocks.useOverview.mockReset();
    queryMocks.useWorkboard.mockReset();
    queryMocks.useWorkboardSnooze.mockReset();
    queryMocks.useWorkboardUnsnooze.mockReset();

    queryMocks.useWorkboard.mockReturnValue({
      data: undefined,
      isLoading: false,
    });
    queryMocks.useWorkboardSnooze.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
    queryMocks.useWorkboardUnsnooze.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
  });

  it("shows a loading skeleton while overview is still resolving", () => {
    queryMocks.useOverview.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    const html = renderPage();

    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("Page not found");
  });

  it("shows not found only after overview has loaded without the page", () => {
    queryMocks.useOverview.mockReturnValue({
      data: {
        pages: [{
          id: 1,
          label: "other",
          platform: "fansly",
        }],
      },
      isLoading: false,
    });

    const html = renderPage();

    expect(html).toContain("Page not found");
    expect(html).not.toContain("animate-pulse");
  });

  it("redirects non-Fansly pages back to the page detail route", () => {
    queryMocks.useOverview.mockReturnValue({
      data: {
        pages: [{
          id: 1,
          label: "lana",
          platform: "onlyfans",
        }],
      },
      isLoading: false,
    });

    const html = renderPage();

    expect(html).toBe("");
    expect(html).not.toContain("Page not found");
    expect(queryMocks.useWorkboard).toHaveBeenCalledWith("lana", { enabled: false });
  });

  it("filters deleted fallback rows from counts and renders the tab as empty", () => {
    queryMocks.useOverview.mockReturnValue({
      data: {
        pages: [{
          id: 1,
          label: "lana",
          platform: "fansly",
        }],
      },
      isLoading: false,
    });
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
    });

    const html = renderPage();

    expect(html).toContain("0 need attention");
    expect(html).toContain("All caught up");
    expect(html).not.toContain("Deleted user");
    expect(html).not.toContain("1 snoozed");
    expect(html).not.toContain("Snoozed (");
  });
});
