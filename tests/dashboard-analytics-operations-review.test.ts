import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminChatterUsageResponse } from "@agency_hub_core/contracts";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { QueryClient, QueryClientProvider } from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";

const mocks = vi.hoisted(() => ({
  usage: vi.fn(), auth: vi.fn(), pages: vi.fn(), collection: vi.fn(), media: vi.fn(), exports: vi.fn(), rows: vi.fn(), visitors: vi.fn(), inventory: vi.fn(), marketing: vi.fn(), actions: vi.fn(), credits: vi.fn(), daily: vi.fn(), ledger: vi.fn(), comparison: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => ({ useAdminChatterUsage: mocks.usage, useAuthMe: mocks.auth, useAdminOfapiCreditsSummary: mocks.credits, useAdminOfapiCreditsDaily: mocks.daily, useAdminOfapiCreditsLedger: mocks.ledger, useAdminOfapiSpendComparison: mocks.comparison }));
vi.mock("../apps/dashboard/src/api/pages.ts", () => ({ usePages: mocks.pages }));
vi.mock("../apps/dashboard/src/api/adminOfapiCollection.ts", () => ({ useAdminOfapiCollection: mocks.collection }));
vi.mock("../apps/dashboard/src/api/ofapiMedia.ts", () => ({ useOfapiMedia: mocks.media, ofapiMediaActions: {} }));
vi.mock("../apps/dashboard/src/api/ofapiExports.ts", () => ({
  useOfapiExportPages: mocks.collection,
  useOfapiExports: mocks.exports,
  useOfapiExportRows: mocks.rows,
  useOfapiVisitors: mocks.visitors,
  useOfapiExportInventory: mocks.inventory,
  ofapiExportJobsQueryOptions: (pageId: number) => ({ queryKey: ["ofapi", "exports", pageId], queryFn: async () => ({ jobs: [] }) }),
  readOfapiExportJobsForRecovery: vi.fn(),
  ofapiExportActions: {},
}));
vi.mock("../apps/dashboard/src/api/ofapiMarketing.ts", () => ({ useOfapiMarketing: mocks.marketing, marketingActions: {} }));
vi.mock("../apps/dashboard/src/api/ofapiActions.ts", () => ({ useOfapiActions: mocks.actions, accountActions: {} }));
vi.mock("../apps/dashboard/src/pages/settings/OfapiWebhookRecovery.tsx", () => ({ OfapiWebhookRecovery: () => null }));
vi.mock("../apps/dashboard/src/pages/settings/OfapiBannedWords.tsx", () => ({ OfapiBannedWords: () => null }));
vi.mock("../apps/dashboard/src/pages/settings/OfapiVendorEvidence.tsx", () => ({ OfapiVendorEvidence: () => null }));

import { UsagePage, otherUsageRequests } from "../apps/dashboard/src/pages/UsagePage.tsx";
import { OfapiMediaPage } from "../apps/dashboard/src/pages/OfapiMediaPage.tsx";
import { OfapiExportsPage, exportWindowError, exportQuoteReviewSnapshot, UnconfirmedExportQuoteNotice } from "../apps/dashboard/src/pages/OfapiExportsPage.tsx";
import { OfapiMarketing } from "../apps/dashboard/src/pages/OfapiMarketing.tsx";
import { OfapiActions } from "../apps/dashboard/src/pages/OfapiActions.tsx";
import { OfapiCreditsPage } from "../apps/dashboard/src/pages/OfapiCreditsPage.tsx";

function query(data?: unknown, error = false) {
  return { data, error: error ? new Error("Read failed") : null, isError: error, isLoading: data === undefined && !error, isPending: data === undefined && !error, isFetching: false, isLoadingError: data === undefined && error, isRefetchError: data !== undefined && error, refetch: vi.fn().mockResolvedValue({ isError: false }) };
}
function render(Page: ComponentType) {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(MemoryRouter, null, createElement(Page))));
}
const page = { id: 1, label: "lora-of", accountId: "account-1" };
const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cacheTotal: 0 };
const feature = (name: AdminChatterUsageResponse["rows"][number]["featureBreakdown"][number]["feature"], requests: number) => ({ feature: name, requestCount: requests, sharePct: 0, tokenCounts: tokens, costMicroUsd: 0, costApproximate: false, regenerateRatePct: 0 });
const usage = { range: { from: "2026-09-11", to: "2026-09-11", timeZone: "Europe/Moscow" }, rows: [{ userId: 1, username: "Alex", totalGenerations: 10, tokenCounts: tokens, cost: { microUsd: 0, approximate: false }, topFeature: { feature: "fast-reply", requestCount: 7, sharePct: 70 }, featureBreakdown: [feature("fast-reply", 7), feature("voice-script", 3)], regenerateRatePct: 0, warning: false, gateway: { requestCount: 10, completedCount: 8, failedCount: 1, cancelledCount: 1, quotaDeniedCount: 0, openReservationCount: 0, providerBreakdown: [] } }] } satisfies AdminChatterUsageResponse;
const emptyDaily = { days: [], balance: [], refills: [], byOperation: [], byPage: [] };
const summary = { enabled: true, balance: { value: 200, observedAt: "2026-09-11T12:00:00Z" }, today: { day: "2026-09-11", total: 1, bySource: { rest: 1, webhookAccrual: 0, external: 0, adjustment: 0 } }, budgets: [], floor: { value: 0, blocked: false }, forecast: { avgDailySpend7d: 1, daysLeft: 200, runOutDate: null }, incidents: [], reconciliation: { lastRunAt: null, lastDriftCredits: null }, accrual: { lastPostedDay: null }, pricing: { microUsdPerCredit: 10000 } };

beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.auth.mockReturnValue(query({ user: { role: "owner" } }));
  mocks.collection.mockReturnValue(query({ pages: [page], revision: 1, backgroundPaused: false }));
  mocks.pages.mockReturnValue(query([{ ...page, label: "lora-1", platform: "fansly" }]));
  for (const name of ["media", "exports", "rows", "visitors", "inventory", "marketing", "actions"] as const) mocks[name].mockReturnValue(query());
  mocks.credits.mockReturnValue(query(summary));
  mocks.daily.mockReturnValue(query(emptyDaily));
  mocks.ledger.mockReturnValue(query({ total: 0, pageOptions: [], rows: [] }));
  mocks.comparison.mockReturnValue(query({ summary: [], byPage: [], samples: [], limitations: [] }));
});

describe("analytics and operations page review", () => {
  it("reconciles additional AI features through one column and offers keyboard details", () => {
    mocks.usage.mockReturnValue(query(usage));
    const html = render(UsagePage);
    expect(otherUsageRequests(usage.rows[0]!)).toBe(3);
    expect(html).toContain(">Other</th>");
    expect(html).toContain(">3</td>");
    expect(html).not.toContain(">Voice script</th>");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("including failed and cancelled requests");
  });
  it("keeps a failed usage refresh distinct from losing the saved report", () => {
    mocks.usage.mockReturnValue(query(usage, true));
    const html = render(UsagePage);
    expect(html).toContain("Alex");
    expect(html).toContain("previous report is still shown");
    expect(html).not.toContain("Usage failed to load");
  });
  it("keeps loading media distinct from an empty vault and avoids a 1–0 range", () => {
    const html = render(OfapiMediaPage);
    expect(html).toContain("Loading saved media");
    expect(html).not.toContain("No upload tasks");
    expect(html).not.toContain("never collected");
    expect(html).not.toContain("1–0");
    expect(html).toContain("Item count unavailable");
  });
  it("shows zero media only after a successful saved response", () => {
    mocks.media.mockReturnValue(query({ sources: [], uploads: [], media: [], totalMedia: 0, inventory: { state: "unknown", note: "Not collected" } }));
    const html = render(OfapiMediaPage);
    expect(html).toContain("0 items");
    expect(html).toContain("does not establish that the provider vault is empty");
  });
  it("does not turn failed exports or marketing requests into empty inventories", () => {
    mocks.exports.mockReturnValue(query(undefined, true));
    expect(render(OfapiExportsPage)).not.toContain("No saved export jobs");
    mocks.marketing.mockReturnValue(query(undefined, true));
    const html = render(OfapiMarketing);
    expect(html).toContain("Read failed");
    expect(html).not.toContain("Ссылок в сохранённых данных пока нет");
  });
  it("shows account loading before asserting that an OFAPI binding is missing", () => {
    mocks.collection.mockReturnValue(query());
    const html = render(OfapiActions);
    expect(html).toContain("Загружаем привязанные аккаунты");
    expect(html).not.toContain("Для работы нужна страница");
  });
  it("enforces closed historical export days and the server's 366-day limit", () => {
    expect(exportWindowError("2026-09-10", "2026-09-10", "2026-09-11")).toBeNull();
    expect(exportWindowError("2025-09-10", "2026-09-10", "2026-09-11")).toBeNull();
    for (const [from, to] of [["2025-09-09", "2026-09-10"], ["2026-09-11", "2026-09-11"], ["2026-09-10", "2026-09-09"], ["2026-02-30", "2026-03-01"], ["2016-10-31", "2016-11-02"]]) expect(exportWindowError(from!, to!, "2026-09-11")).not.toBeNull();
  });
  it("requires a new explicit intention after an unconfirmed quote, showing the frozen scope", () => {
    const quote = { pageLabel: "Reviewed page", body: { pageId: 1, profile: "fans" as const, startDate: "2026-09-01T00:00:00Z", endDate: "2026-09-10T23:59:59Z", maxCredits: 10, maxRows: 1000, maxBytes: 4194304, fanType: "all" as const, expectedPolicyRevision: 1, dryRun: true } };
    const html = renderToStaticMarkup(createElement(UnconfirmedExportQuoteNotice, { quote, reviewSnapshot: "1:200", onReadJobs: vi.fn(), onStartNew: vi.fn() }));
    expect(html).toContain("Quote creation outcome is unknown");
    expect(html).toContain("Reviewed page");
    expect(html).toContain("2026-09-01");
    expect(html).toContain("may already have created");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Prepare a separate new quote<\/button>/);
    expect(html).toContain("Read and show jobs for this page");
    expect(html).not.toContain("Create quote</button>");
  });
  it("requires a successful original-page read after an unknown quote, even when jobs are cached", () => {
    const cached = { pageId: 1, dataUpdatedAt: 100, hasData: true, isError: false, isFetching: false };
    expect(exportQuoteReviewSnapshot(null, cached, 1)).toBeNull();

    const readback = { pageId: 1, dataUpdatedAt: 200 };
    expect(exportQuoteReviewSnapshot(readback, cached, 1)).toBeNull();
    const refreshed = { ...cached, dataUpdatedAt: 200 };
    expect(exportQuoteReviewSnapshot(readback, { ...refreshed, hasData: false }, 1)).toBeNull();
    expect(exportQuoteReviewSnapshot(readback, { ...refreshed, isError: true }, 1)).toBeNull();
    expect(exportQuoteReviewSnapshot(readback, { ...refreshed, isFetching: true }, 1)).toBeNull();
    expect(exportQuoteReviewSnapshot(readback, refreshed, 1)).toBe("1:200");
  });
  it("binds recovery review to its page and current jobs snapshot", () => {
    const readback = { pageId: 1, dataUpdatedAt: 200 };
    const current = { ...readback, hasData: true, isError: false, isFetching: false };
    expect(exportQuoteReviewSnapshot(readback, current, 2)).toBeNull();
    expect(exportQuoteReviewSnapshot(readback, { ...current, pageId: 2 }, 2)).toBeNull();
    const acknowledged = exportQuoteReviewSnapshot(readback, current, 1);
    const later = exportQuoteReviewSnapshot(readback, { ...current, dataUpdatedAt: 300 }, 1);
    expect(later).not.toBe(acknowledged);
    expect(later).toBe("1:300");
    // A separate unknown quote must first obtain its own explicit successful read.
    expect(exportQuoteReviewSnapshot(null, current, 1)).toBeNull();
  });
  it("keeps unknown revenue unknown and stops claiming causal ROI", () => {
    mocks.daily.mockReturnValue(query({ ...emptyDaily, byPage: [{ pageId: 1, pageLabel: "Unknown revenue", credits: 100 }] }));
    const html = render(OfapiCreditsPage);
    expect(html).toContain("Выручка / стоимость");
    expect(html).toContain("Нет данных");
    expect(html).not.toContain(">ROI<");
    expect(html).not.toContain("0.0×");
    expect(html).toContain("не показывает, сколько выручки принесли запросы OFAPI");
    expect(html).toContain("Остальные ограничения расхода продолжают действовать");
  });
  it("retains the last credit summary with a clear refresh-failure label", () => {
    mocks.credits.mockReturnValue(query(summary, true));
    const html = render(OfapiCreditsPage);
    expect(html).toContain("Баланс, прогноз и ограничения ниже относятся к предыдущему ответу");
    expect(html).toContain("Журнал операций");
  });
});
