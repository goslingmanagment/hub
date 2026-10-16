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
  period: "all" as "today" | "7d" | "30d" | "90d" | "180d" | "all",
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);
vi.mock("@/stores/periodStore", () => ({ usePeriodStore: () => ({ ...storeMocks }) }));

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

function renderPage() {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ["/pages/lana/top-supporters"] },
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
    storeMocks.period = "all";
    queryMocks.useSpenderBatch.mockReturnValue({ data: undefined });
  });

  it("requests the lifetime period for all time and passes retentionStatus=all", () => {
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
    expect(html).toContain("Нужно вернуть");
    expect(html).toContain("Вернуть");
    expect(html).toContain("Подписка");
    expect(html).toContain("Действие");
    expect(html).toContain("Переписка");
    expect(html).toContain("Последняя трата");
    expect(html).toContain("ждёт ответа");
    expect(html).toContain("Чаевые");
    expect(html).not.toContain("Last Activity");
    expect(html).not.toContain("Last activity ");
  });

  it("shows an empty state when no supporters match the active filter", () => {
    queryMocks.useSpenders.mockReturnValue({ data: makeResponse([]), isLoading: false });

    const html = renderPage();

    expect(html).toContain("За этот период трат нет.");
  });

  it("passes the console period through when it is not \"all\"", () => {
    storeMocks.period = "30d";
    queryMocks.useSpenders.mockReturnValue({ data: makeResponse([]), isLoading: false });

    renderPage();

    expect(queryMocks.useSpenders.mock.calls[0]![0].period).toBe("30d");
  });
});
