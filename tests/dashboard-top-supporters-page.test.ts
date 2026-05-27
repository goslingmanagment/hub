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

    expect(html).toContain("All");
    expect(html).toContain("Active");
    expect(html).toContain("Cooling");
    expect(html).toContain("Inactive");
    expect(html).toContain("Needs reactivation");
    expect(html).toContain("REACTIVATE");
    expect(html).toContain("Last Activity");
    expect(html).not.toContain("Last activity ");
  });

  it("shows an empty state when no supporters match the active filter", () => {
    queryMocks.useSpenders.mockReturnValue({ data: makeResponse([]), isLoading: false });

    const html = renderPage();

    expect(html).toContain("No supporters found for this period.");
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
});
