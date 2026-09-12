import { describe, expect, it } from "vitest";
import {
  crossPageTransactionListQuerySchema,
  type CrossPageTransactionListResponse,
  type OverviewRevenueResponse,
} from "@agency_hub_core/contracts";
import {
  buildRevenueTransactionsRoute,
  buildSubscriberRoute,
  listOffset,
  overviewSearch,
  parseOverviewState,
  safeBackTo,
  subscriberFilter,
} from "../apps/dashboard/src/lib/overviewNavigation.ts";
import {
  matchesTransactionScope,
  parseTransactionSearch,
} from "../apps/dashboard/src/lib/transactionNavigation.ts";
import { groupRevenue } from "../apps/dashboard/src/pages/overview/presentation.ts";

const from = "2026-09-03T00:00:00.000Z";
const to = "2026-09-11T00:00:00.000Z";
describe("exact revenue navigation", () => {
  it("roundtrips row, chart, sort and period; URL wins over the saved default", () => {
    const state = {
      period: "30d" as const,
      row: "page / +",
      chart: "model:Model & Name",
      sort: "decline" as const,
    };
    expect(parseOverviewState(overviewSearch(state), "7d")).toEqual(state);
    expect(parseOverviewState(new URLSearchParams(), "today").period).toBe(
      "today",
    );
    const route = buildRevenueTransactionsRoute({
      pageLabel: state.row,
      from,
      to,
      type: "message_purchase",
      backTo: `/?${overviewSearch(state)}`,
    });
    const params = new URL(route, "https://hub.invalid").searchParams;
    const parsed = parseTransactionSearch(params);
    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect(parsed.data).toMatchObject({
        from,
        to,
        pageLabel: state.row,
        type: "message_purchase",
        reportableOnly: true,
        limit: 50,
        offset: 0,
      });
    expect(
      parseOverviewState(
        new URL(safeBackTo(params), "https://hub.invalid").searchParams,
        "today",
      ),
    ).toEqual(state);
  });
  it.each([
    { from },
    { to },
    { from, to: from },
    { from: to, to: from },
    { from: "2026-09-03T00:00:00", to },
    { from: "2026-02-30T00:00:00Z", to },
    { from: "garbage", to },
  ])("refuses invalid or incomplete exact bounds: %j", (input) => {
    expect(crossPageTransactionListQuerySchema.safeParse(input).success).toBe(
      false,
    );
  });
  it("accepts equivalent explicit offsets and fails closed on old/incorrect server scope", () => {
    const query = crossPageTransactionListQuerySchema.parse({
      from: "2026-09-03T03:00:00+03:00",
      to,
      pageLabel: "a",
      reportableOnly: true,
    });
    const response = {
      items: [],
      total: 0,
      offset: 0,
      limit: 50,
      summary: { netAmountMills: 0, currency: "USD", readAt: to },
      scope: {
        from,
        to,
        pageLabel: "a",
        reportableOnly: true,
        type: null,
        state: null,
      },
    } satisfies CrossPageTransactionListResponse;
    expect(matchesTransactionScope(response, query)).toBe(true);
    expect(
      matchesTransactionScope(
        { ...response, scope: { ...response.scope, pageLabel: "b" } },
        query,
      ),
    ).toBe(false);
    const { scope: _scope, ...older } = response;
    expect(matchesTransactionScope(older, query)).toBe(false);
  });
  it.each([
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example",
    "/%5cevil.example",
    "/%2f%2fevil.example",
    "/%00broken",
  ])("refuses unsafe return URL %s", (backTo) => {
    expect(safeBackTo(new URLSearchParams({ backTo }))).toBe("/");
  });
  it("preserves current audience filters and pagination without using the money period", () => {
    const url = new URL(
      buildSubscriberRoute("lora 1", "norenew", "/?period=30d&row=lora+1"),
      "https://hub.invalid",
    );
    expect(url.pathname).toBe("/pages/lora%201/subscribers");
    expect(subscriberFilter(url.searchParams.get("filter"))).toBe("norenew");
    expect(safeBackTo(url.searchParams)).toContain("period=30d");
    expect(subscriberFilter("unknown")).toBe("all");
    expect(listOffset("-50")).toBe(0);
    expect(listOffset("1e99")).toBe(0);
    expect(listOffset("50")).toBe(50);
  });
  it("retains retired rows and sorts models by server earnings, even without catalog metadata", () => {
    const report = {
      models: [
        { modelSlug: "low", netEarningsMills: -50 },
        { modelSlug: "high", netEarningsMills: 900 },
      ],
      pages: [
        {
          pageId: 3,
          modelSlug: "high",
          pageLabel: "archived",
          status: "deleted",
          deltaNetMills: -20,
        },
        {
          pageId: 2,
          modelSlug: "high",
          pageLabel: "active",
          deltaNetMills: 100,
        },
        { pageId: 1, modelSlug: "low", pageLabel: "unknown" },
      ],
    } as OverviewRevenueResponse;
    const groups = groupRevenue(report, [], "decline");
    expect(groups.map((group) => group.model.modelSlug)).toEqual([
      "high",
      "low",
    ]);
    expect(groups[0]?.pages.map((page) => page.pageLabel)).toEqual([
      "archived",
      "active",
    ]);
    expect(report.models[0]?.modelSlug).toBe("low");
  });
});
