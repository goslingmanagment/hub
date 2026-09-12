import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DbModule from "@agency_hub_core/db";
import type {
  ApiModuleContext,
  ApiServer,
} from "../apps/runtime/src/modules/context.ts";
const db = vi.hoisted(() => ({
  listRevenuePages: vi.fn(),
  listRevenueDailyForPages: vi.fn(),
  findRevenueModel: vi.fn(),
  findPageSummaryByLabel: vi.fn(),
  getRevenuePageTotals: vi.fn(),
  getRevenueBreakdownForScope: vi.fn(),
  getRevenueBreakdown: vi.fn(),
}));
vi.mock("@agency_hub_core/db", async (original) => ({
  ...(await original<typeof DbModule>()),
  ...db,
}));
import { registerFinanceRoutes } from "../apps/runtime/src/modules/finance/index.ts";
import {
  getModelRevenueReport,
  getPageRevenueReport,
} from "../apps/runtime/src/services/reporting.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";

const at = "2026-09-10T23:59:59.999Z";
const pages = [
  { id: 1, platform: "fansly", modelSlug: "one", modelName: "One" },
  { id: 2, platform: "onlyfans", modelSlug: "one", modelName: "One" },
  { id: 3, platform: "fansly", modelSlug: "two", modelName: "Two" },
];
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(at);
  db.listRevenuePages.mockImplementation(async () => {
    vi.setSystemTime("2026-09-11T00:00:00.010Z");
    return pages;
  });
  db.listRevenueDailyForPages.mockResolvedValue([]);
  db.findRevenueModel.mockResolvedValue({
    id: 1,
    slug: "one",
    name: "One",
    pageCount: 2,
  });
  db.getRevenuePageTotals.mockResolvedValue([]);
  db.getRevenueBreakdownForScope.mockResolvedValue([]);
  db.getRevenueBreakdown.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());
describe("one request clock across awaited reads", () => {
  it.each([
    "/api/v1/overview/revenue/daily",
    "/api/v1/overview/revenue/by-model",
  ])("pins platforms and models in %s", async (path) => {
    const handlers = new Map<string, (request: unknown) => Promise<unknown>>();
    const server = {
      get: (
        path: string,
        _schema: unknown,
        handler: (request: unknown) => Promise<unknown>,
      ) => handlers.set(path, handler),
      post: () => {},
    } as unknown as ApiServer;
    const ctx = {
      appContext: { db: {} },
      auth: {
        requirePrincipal: async () => ({
          authMethod: "session",
          user: { role: "owner" },
        }),
      },
    } as unknown as ApiModuleContext;
    registerFinanceRoutes(server, ctx);
    await handlers.get(path)!({
      query: { period: "today", groupByType: false },
    });
    expect(db.listRevenueDailyForPages.mock.calls.length).toBeGreaterThan(1);
    for (const [, input] of db.listRevenueDailyForPages.mock.calls)
      expect(input).toMatchObject({
        fromBusinessDate: "2026-09-10",
        toBusinessDate: "2026-09-11",
      });
  });
  it("pins a model's totals, comparison and disclosed bounds before its page lookup", async () => {
    const result = await getModelRevenueReport(
      { db: {} } as AppContext,
      "one",
      { period: "today" },
    );
    expect(result.windowAt).toBe(at);
    expect(result.from).toBe("2026-09-10T00:00:00.000Z");
    expect(result.to).toBe("2026-09-11T00:00:00.000Z");
    expect(result.comparison?.from).toBe("2026-09-09T00:00:00.000Z");
    for (const [, input] of db.getRevenuePageTotals.mock.calls)
      expect(input.period.from.toISOString()).toBe(result.from);
  });
  it("pins a page report before the awaited catalog lookup", async () => {
    db.findPageSummaryByLabel.mockImplementation(async () => {
      vi.setSystemTime("2026-09-11T00:00:00.010Z");
      return { ...pages[0], label: "a" };
    });
    const result = await getPageRevenueReport({ db: {} } as AppContext, "a", {
      period: "today",
    });
    expect(result.windowAt).toBe(at);
    expect(result.from).toBe("2026-09-10T00:00:00.000Z");
    expect(db.getRevenueBreakdown.mock.calls[0]?.[3].toISOString()).toBe(
      result.from,
    );
  });
});
