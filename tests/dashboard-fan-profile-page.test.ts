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
  period: "30d" as "today" | "7d" | "30d" | "90d" | "180d" | "all",
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);
vi.mock("@/stores/spenderPeriodStore", () => ({
  useSpenderPeriodStore: () => ({
    period: storeMocks.period,
    setPeriod: vi.fn(),
  }),
}));

import { FanProfilePage } from "../apps/dashboard/src/pages/FanProfilePage.tsx";

function renderPage(url = "/pages/lana/fans/fansly/fan-001") {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: [url] },
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
          autoRenewOffDetectedAt: "2026-03-20T00:00:00.000Z",
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

    expect(html).toContain("Доход автора");
    expect(html).toContain("$12.34");
    expect(html).not.toContain("$50.00");
  });

  it("shows lifetime total spent when all time is selected", () => {
    storeMocks.period = "all";

    const html = renderPage();

    expect(queryMocks.useSpenderDetail).toHaveBeenCalledWith("fansly", "fan-001", expect.objectContaining({
      period: "lifetime",
    }));
    expect(html).toContain("Доход автора");
    expect(html).toContain("$50.00");
  });

  it("does not turn failed secondary queries into zero money or empty history", () => {
    const failed = { data: undefined, isError: true, refetch: vi.fn() };
    queryMocks.useSpenderDetail.mockReturnValue(failed);
    queryMocks.usePageFanTransactions.mockReturnValue(failed);
    queryMocks.usePageFanProfile.mockReturnValue(failed);
    const html = renderPage();
    expect(html).toContain("Данные не удалось загрузить");
    expect(html).toContain("История операций");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("Операций пока нет");
    expect(html).not.toContain("Операции пока не найдены");
    expect(html).not.toContain("Профиль ещё не создан");
    expect(html).not.toContain("AI-профиль ещё не создан");
  });

  it("shows independent loading states while keeping the known identity visible", () => {
    const loading = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
    queryMocks.useSpenderDetail.mockReturnValue(loading);
    queryMocks.usePageFanTransactions.mockReturnValue(loading);
    queryMocks.usePageFanProfile.mockReturnValue(loading);
    const html = renderPage();
    expect(html).toContain("buyer");
    expect(html).toContain("Загружаем суммы");
    expect(html).toContain("Загружаем историю операций");
    expect(html).toContain("Загружаем AI-профиль");
    expect(html).not.toContain("$0.00");
  });

  it("retains secondary data after a refresh failure and labels it as stale", () => {
    const known = queryMocks.useSpenderDetail.getMockImplementation()!();
    queryMocks.useSpenderDetail.mockReturnValue({ ...known, isError: true, refetch: vi.fn() });
    const html = renderPage();
    expect(html).toContain("$12.34");
    expect(html).toContain("ранее полученные данные");
  });

  it("uses the source period and persists the transaction page and return link", () => {
    const backTo = "/pages/lana/top-supporters?filter=cooling&q=buyer&offset=50&period=all";
    const html = renderPage(`/pages/lana/fans/fansly/fan-001?period=all&txOffset=50&backTo=${encodeURIComponent(backTo)}`);
    expect(queryMocks.useSpenderDetail.mock.calls[0]![2].period).toBe("lifetime");
    expect(queryMocks.usePageFanTransactions.mock.calls[0]![2]).toEqual({ limit: 50, offset: 50 });
    expect(queryMocks.usePageFanTransactions.mock.calls[1]![2]).toEqual({ limit: 10, offset: 0 });
    expect(html).toContain('href="/pages/lana/top-supporters?filter=cooling&amp;q=buyer&amp;offset=50&amp;period=all"');
  });

  it("keeps a safe return link on an initial profile failure", () => {
    queryMocks.usePageFanDetail.mockReturnValue({ data: undefined, isError: true, refetch: vi.fn() });
    const html = renderPage("/pages/lana/fans/fansly/fan-001?backTo=https%3A%2F%2Fevil.invalid");
    expect(html).toContain("Не удалось загрузить карточку фана");
    expect(html).toContain('href="/pages/lana"');
    expect(html).not.toContain('href="https://evil.invalid"');
  });

});
