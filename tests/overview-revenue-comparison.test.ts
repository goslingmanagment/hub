import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DbModule from "@agency_hub_core/db";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";

const queries = vi.hoisted(() => ({
  listRevenuePages: vi.fn(),
  listRevenueModels: vi.fn(),
  getRevenuePageTotals: vi.fn(),
  getRevenueBreakdownForScope: vi.fn(),
}));
vi.mock("@agency_hub_core/db", async (original) => ({
  ...(await original<typeof DbModule>()),
  ...queries,
}));
import { getOverviewRevenueReport } from "../apps/runtime/src/services/reporting.ts";
import { pageRevenueItemSchema } from "@agency_hub_core/contracts";

const now = new Date("2026-09-10T19:45:00Z");
const pages = [
  {
    id: 1,
    label: "a",
    platform: "fansly",
    modelSlug: "model",
    modelName: "Model",
    status: "active",
  },
  {
    id: 2,
    label: "b",
    platform: "onlyfans",
    modelSlug: "model",
    modelName: "Model",
    status: "active",
  },
  {
    id: 3,
    label: "retired",
    platform: "onlyfans",
    modelSlug: "retired",
    modelName: "Retired",
    status: "deleted",
  },
];
const values: Record<number, { current: bigint; previous: bigint }> = {
  1: { current: 120000n, previous: 200000n },
  2: { current: 40000n, previous: 0n },
  3: { current: 0n, previous: 50000n },
};
function isPrevious(input: { period: { to: Date | null } }) {
  return (
    input.period.to !== null &&
    input.period.to < new Date("2026-09-10T00:00:00Z")
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  queries.listRevenuePages.mockImplementation(async (_db, scope?: number[]) =>
    pages.filter((p) => !scope || scope.includes(p.id)),
  );
  queries.listRevenueModels.mockResolvedValue([
    { id: 1, slug: "model", name: "Model", pageCount: 2, activePageCount: 2 },
    {
      id: 2,
      slug: "retired",
      name: "Retired",
      pageCount: 1,
      activePageCount: 0,
    },
  ]);
  queries.getRevenuePageTotals.mockImplementation(async (_db, input) =>
    input.pageIds.map((id: number) => ({
      pageId: id,
      netEarningsMills: values[id]![isPrevious(input) ? "previous" : "current"],
    })),
  );
  queries.getRevenueBreakdownForScope.mockImplementation(async (_db, input) => [
    {
      canonicalType: "message_purchase",
      bucket: "revenue",
      netAmountMills: input.pageIds.reduce(
        (sum: bigint, id: number) =>
          sum + values[id]![isPrevious(input) ? "previous" : "current"],
        0n,
      ),
    },
  ]);
});
const app = { db: {} } as AppContext;
describe("overview page and model comparisons", () => {
  it("uses each platform's actual previous window, with retired attribution and a genuine zero baseline", async () => {
    const result = await getOverviewRevenueReport(app, { period: "7d", now });
    expect(
      result.pages.map((p) => [
        p.pageId,
        p.netEarningsMills,
        p.previousNetEarningsMills,
      ]),
    ).toEqual([
      [1, 120000, 200000],
      [2, 40000, 0],
      [3, 0, 50000],
    ]);
    expect(
      result.models.map((m) => [
        m.modelSlug,
        m.netEarningsMills,
        m.previousNetEarningsMills,
        m.status,
      ]),
    ).toEqual([
      ["model", 160000, 200000, "active"],
      ["retired", 0, 50000, "retired"],
    ]);
    expect(result.comparison?.netEarningsMills).toBe(250000);
    const previous = queries.getRevenuePageTotals.mock.calls
      .map(([, input]) => input)
      .filter(isPrevious);
    expect(
      previous.map((p) => [
        p.platform,
        p.period.from.toISOString(),
        p.period.to.toISOString(),
        p.pageIds,
      ]),
    ).toEqual([
      ["fansly", "2026-08-28T00:00:00.000Z", "2026-09-04T00:00:00.000Z", [1]],
      [
        "onlyfans",
        "2026-08-26T00:00:00.000Z",
        "2026-09-03T00:00:00.000Z",
        [2, 3],
      ],
    ]);
  });
  it("does not query or invent a previous all-time period", async () => {
    const result = await getOverviewRevenueReport(app, { period: "all", now });
    expect(result.comparison).toBeNull();
    expect(result.pages.every((p) => p.previousNetEarningsMills === null)).toBe(
      true,
    );
    expect(
      result.models.every((m) => m.previousNetEarningsMills === null),
    ).toBe(true);
    expect(queries.getRevenuePageTotals).toHaveBeenCalledTimes(2);
  });
  it("preserves the caller's page scope in both time windows", async () => {
    queries.listRevenueModels.mockResolvedValue([
      { id: 1, slug: "model", name: "Model", pageCount: 1, activePageCount: 1 },
    ]);
    const result = await getOverviewRevenueReport(app, {
      period: "7d",
      now,
      pageIds: [2],
    });
    expect(result.pages.map((p) => p.pageId)).toEqual([2]);
    for (const [, input] of queries.getRevenuePageTotals.mock.calls)
      expect(input.pageIds).toEqual([2]);
  });
  it("accepts an older server that cannot supply page comparisons", () => {
    const parsed = pageRevenueItemSchema.parse({
      pageId: 1,
      pageLabel: "a",
      modelSlug: "model",
      modelName: "Model",
      netEarningsMills: 0,
      totalNetMills: 0,
    });
    expect(parsed.previousNetEarningsMills).toBeUndefined();
  });
});
