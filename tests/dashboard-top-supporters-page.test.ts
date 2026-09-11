import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryRouter,
  Route,
  Routes,
} from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import type { SpenderListResponse } from "@agency_hub_core/contracts";

const queryMocks = vi.hoisted(() => ({
  useSpenders: vi.fn(),
  useSpenderBatch: vi.fn(),
}));
const storeMocks = vi.hoisted(() => ({
  topSupportersPeriod: "all" as "today" | "7d" | "30d" | "90d" | "180d" | "all",
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);
vi.mock("@/stores/spenderPeriodStore", () => ({
  useSpenderPeriodStore: (selector?: (s: typeof storeMocks) => unknown) => {
    if (typeof selector === "function") {
      return selector({ ...storeMocks } as never);
    }
    return { ...storeMocks };
  },
}));

import { TopSupportersPage } from "../apps/dashboard/src/pages/TopSupportersPage.tsx";

function makeItem(overrides: Partial<SpenderListResponse["items"][number]> = {}): SpenderListResponse["items"][number] {
  return {
    fan: {
      platform: "fansly",
      platformUserId: "fan-001",
      pageAlias: null,
      username: "buyer",
      displayName: "Buyer One",
      createdAtExternal: null,
    },
    metrics: {
      window: null,
      lifetime: {
        scopeGrossAmountMills: 250_000,
        scopeCreatorNetAmountMills: 250_000,
        platformGrossAmountMills: 250_000,
        platformCreatorNetAmountMills: 250_000,
      },
      comparison: null,
    },
    lifetimeLastTransactionAt: "2026-02-10T12:00:00.000Z",
    lastFanMessageAt: "2026-05-26T18:54:00.000Z",
    conversation: {
      platformConversationId: "conversation-001",
      unreadCount: 2,
      lastMessageAt: "2026-05-26T18:54:00.000Z",
      lastFanMessageAt: "2026-05-26T18:54:00.000Z",
      lastModelMessageAt: null,
      lastMessagePreview: "beach or hike - which one wins for you?",
      storedMessageCount: 1,
      messageCoverageStatus: "complete",
      messageBackfillComplete: true,
    },
    lastTransaction: {
      canonicalType: "tip",
      transactionState: "posted",
      grossAmountMills: 250_000,
      creatorNetAmountMills: 250_000,
      occurredAt: "2026-02-10T12:00:00.000Z",
    },
    retentionStatus: "needs_reactivation",
    ...overrides,
  };
}

function makeResponse(items: SpenderListResponse["items"]): SpenderListResponse {
  return {
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
      asOf: "2026-05-27T12:00:00.000Z",
    },
    diagnostics: {
      totalGrossAmountMills: 0,
      totalCreatorNetAmountMills: 0,
      attributedGrossAmountMills: 0,
      attributedCreatorNetAmountMills: 0,
      unattributedGrossAmountMills: 0,
      unattributedCreatorNetAmountMills: 0,
    },
    items,
    limit: 50,
    offset: 0,
    total: items.length,
  };
}

function renderPage(url = "/pages/lana/top-supporters") {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [url] },
      createElement(
        Routes,
        undefined,
        createElement(Route, {
          path: "/pages/:pageLabel/top-supporters",
          element: createElement(TopSupportersPage),
        }),
      ),
    ),
  );
}

describe("TopSupportersPage", () => {
  beforeEach(() => {
    queryMocks.useSpenders.mockReset();
    queryMocks.useSpenderBatch.mockReset();
    storeMocks.topSupportersPeriod = "all";
    queryMocks.useSpenderBatch.mockReturnValue({ data: undefined });
  });

  it("requests the lifetime period by default and passes retentionStatus=all", () => {
    queryMocks.useSpenders.mockReturnValue({ data: makeResponse([]), isLoading: false });

    renderPage();

    const params = queryMocks.useSpenders.mock.calls[0]![0];
    expect(params).toMatchObject({
      scope: "page",
      pageLabel: "lana",
      period: "lifetime",
      retentionStatus: "all",
      offset: 0,
    });
  });

  it("renders all retention filter chips and the row status badge", () => {
    queryMocks.useSpenders.mockReturnValue({
      data: makeResponse([makeItem({ retentionStatus: "needs_reactivation" })]),
      isLoading: false,
    });

    const html = renderPage();

    expect(html).toContain("Все");
    expect(html).toContain("Активные");
    expect(html).toContain("Остывают");
    expect(html).toContain("Неактивные");
    expect(html).toContain("Нужен возврат");
    expect(html).toContain("Вернуть");
    expect(html).toContain("Подписка");
    expect(html).toContain("Следующий шаг");
    expect(html).toContain("Переписка");
    expect(html).toContain("Последняя покупка");
    expect(html).toContain("Без ответа");
    expect(html).toContain("Tip");
    expect(html).not.toContain("Last Activity");
    expect(html).not.toContain("Last activity ");
  });

  it("shows an empty state when no supporters match the active filter", () => {
    queryMocks.useSpenders.mockReturnValue({ data: makeResponse([]), isLoading: false });

    const html = renderPage();

    expect(html).toContain("За выбранный период спендеры не найдены.");
  });

  it("falls back to lifetime when period is the persisted \"all\" alias", () => {
    storeMocks.topSupportersPeriod = "all";
    queryMocks.useSpenders.mockReturnValue({ data: makeResponse([]), isLoading: false });

    renderPage();

    expect(queryMocks.useSpenders.mock.calls[0]![0].period).toBe("lifetime");
  });

  it("passes the persisted spender period through when it is not \"all\"", () => {
    storeMocks.topSupportersPeriod = "30d";
    queryMocks.useSpenders.mockReturnValue({ data: makeResponse([]), isLoading: false });

    renderPage();

    expect(queryMocks.useSpenders.mock.calls[0]![0].period).toBe("30d");
  });

  it("keeps filters visible and exposes a local retry after the initial list request fails", () => {
    queryMocks.useSpenders.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    const html = renderPage("/pages/lana/top-supporters?filter=cooling&q=buyer&offset=50");
    expect(html).toContain("Не удалось загрузить спендеров");
    expect(html).toContain("Повторить");
    expect(html).toContain('value="buyer"');
    expect(html).not.toContain("За выбранный период спендеры не найдены.");
  });

  it("reads bounded URL state and embeds it in an accessible fan link", () => {
    queryMocks.useSpenders.mockReturnValue({ data: makeResponse([makeItem()]), isError: false });
    const url = "/pages/lana/top-supporters?filter=cooling&q=buyer&offset=50&period=30d&sortBy=lastTransactionAt&dir=asc";
    const html = renderPage(url);
    expect(queryMocks.useSpenders.mock.calls[0]![0]).toMatchObject({
      retentionStatus: "cooling", query: "buyer", offset: 50, period: "30d", sortBy: "lastTransactionAt", sortDir: "asc",
    });
    expect(html).toContain(`backTo=${encodeURIComponent(url)}`);
    expect(html).toContain('aria-sort="ascending"');
    expect(html).toContain('aria-label="Открыть переписку · Buyer One"');
  });

  it.each(["-1", "NaN", "1.5", "Infinity", "9007199254740992"])("does not send invalid offset %s to the API", (offset) => {
    queryMocks.useSpenders.mockReturnValue({ data: makeResponse([]), isError: false });
    renderPage(`/pages/lana/top-supporters?offset=${offset}`);
    expect(queryMocks.useSpenders.mock.calls[0]![0].offset).toBe(0);
  });

  it("keeps the ranking after a detail failure without rendering missing subscriptions as absent", () => {
    queryMocks.useSpenders.mockReturnValue({ data: makeResponse([makeItem()]), isError: true, refetch: vi.fn() });
    queryMocks.useSpenderBatch.mockReturnValue({ data: undefined, isError: true, refetch: vi.fn() });
    const html = renderPage();
    expect(html).toContain("buyer");
    expect(html).toContain("$250.00");
    expect(html).toContain("ранее полученные данные");
    expect(html).toContain("Неизвестно");
  });

  it("does not total a partial batch breakdown or invent a missing period amount", () => {
    storeMocks.topSupportersPeriod = "30d";
    queryMocks.useSpenders.mockReturnValue({ data: makeResponse([makeItem()]), isError: false });
    queryMocks.useSpenderBatch.mockReturnValue({ data: { items: [] }, isError: false, refetch: vi.fn() });
    const html = renderPage();
    expect(html).toContain("Часть сведений о подписках и разбивке дохода недоступна");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("Чаевые <span");
  });

});
