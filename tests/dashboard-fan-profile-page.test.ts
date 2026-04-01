import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

const queryMocks = vi.hoisted(() => ({
  usePageFanDetail: vi.fn(),
  usePageFanProfile: vi.fn(),
  usePageFanProfileVersion: vi.fn(),
  usePageFanProfileVersions: vi.fn(),
  usePageFanTransactions: vi.fn(),
  useCreateFanNote: vi.fn(),
  useSpenderDetail: vi.fn(),
}));
const storeMocks = vi.hoisted(() => ({
  period: "30d" as "today" | "7d" | "30d" | "all",
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);
vi.mock("@/stores/periodStore", () => ({
  usePeriodStore: () => ({
    period: storeMocks.period,
    setPeriod: vi.fn(),
  }),
}));

import { FanProfilePage } from "../apps/dashboard/src/pages/FanProfilePage.tsx";

function renderPage() {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: ["/pages/lana/fans/fansly/fan-001"] },
    createElement(
      Routes,
      undefined,
      createElement(Route, {
        path: "/pages/:pageLabel/fans/:platform/:platformUserId",
        element: createElement(FanProfilePage),
      }),
    ),
  ));
}

describe("FanProfilePage", () => {
  beforeEach(() => {
    storeMocks.period = "30d";
    queryMocks.usePageFanDetail.mockReset();
    queryMocks.usePageFanProfile.mockReset();
    queryMocks.usePageFanProfileVersion.mockReset();
    queryMocks.usePageFanProfileVersions.mockReset();
    queryMocks.usePageFanTransactions.mockReset();
    queryMocks.useCreateFanNote.mockReset();
    queryMocks.useSpenderDetail.mockReset();

    queryMocks.usePageFanDetail.mockReturnValue({
      data: {
        fan: {
          platform: "fansly",
          platformUserId: "fan-001",
          username: "buyer",
          displayName: "Buyer One",
          pageAlias: null,
          createdAtExternal: "2026-03-01T00:00:00.000Z",
        },
        page: {
          pageLabel: "lana",
          totalCreatorNetMills: 5000,
          isSubscriber: true,
          isFollower: true,
          subscriptionExpiresAt: "2026-04-10T00:00:00.000Z",
          subscriberSince: "2026-03-01T00:00:00.000Z",
          autoRenew: false,
          notes: [],
        },
      },
      isLoading: false,
      isError: false,
    });
    queryMocks.usePageFanProfile.mockReturnValue({
      data: { profile: null },
      isLoading: false,
    });
    queryMocks.usePageFanProfileVersions.mockReturnValue({
      data: { items: [] },
      isLoading: false,
    });
    queryMocks.usePageFanProfileVersion.mockReturnValue({
      data: null,
      isLoading: false,
    });
    queryMocks.usePageFanTransactions.mockReturnValue({
      data: { total: 0, items: [] },
    });
    queryMocks.useCreateFanNote.mockReturnValue({
      mutateAsync: vi.fn(),
    });
    queryMocks.useSpenderDetail.mockReturnValue({
      data: {
        metrics: {
          window: {
            grossAmountMills: 12340,
            creatorNetAmountMills: 12340,
            postedGrossAmountMills: 12340,
            pendingGrossAmountMills: 0,
            unknownGrossAmountMills: 0,
            postedCreatorNetAmountMills: 12340,
            pendingCreatorNetAmountMills: 0,
            unknownCreatorNetAmountMills: 0,
            transactionCount: 1,
            lastTransactionAt: "2026-03-10T00:00:00.000Z",
          },
          lifetime: {
            scopeGrossAmountMills: 50000,
            scopeCreatorNetAmountMills: 50000,
            platformGrossAmountMills: 50000,
            platformCreatorNetAmountMills: 50000,
          },
        },
        typeBreakdown: [
          {
            canonicalType: "subscription",
            grossAmountMills: 800,
            creatorNetAmountMills: 800,
            transactionCount: 1,
          },
          {
            canonicalType: "tip",
            grossAmountMills: 300,
            creatorNetAmountMills: 300,
            transactionCount: 1,
          },
          {
            canonicalType: "message_purchase",
            grossAmountMills: 134,
            creatorNetAmountMills: 134,
            transactionCount: 1,
          },
        ],
      },
    });
  });

  it("shows period-scoped total spent for bounded periods", () => {
    const html = renderPage();

    expect(html).toContain("Total Spent");
    expect(html).toContain("$12.34");
    expect(html).not.toContain("$50.00");
  });

  it("shows lifetime total spent when all time is selected", () => {
    storeMocks.period = "all";

    const html = renderPage();

    expect(queryMocks.useSpenderDetail).toHaveBeenCalledWith("fansly", "fan-001", expect.objectContaining({
      period: "lifetime",
    }));
    expect(html).toContain("Total Spent");
    expect(html).toContain("$50.00");
  });
});
