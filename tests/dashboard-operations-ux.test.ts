import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ofapiPageHref, resolveOfapiPage } from "../apps/dashboard/src/lib/ofapiNavigation.ts";

const mocks = vi.hoisted(() => ({
  pages: vi.fn(), media: vi.fn(), exports: vi.fn(), visitors: vi.fn(), rows: vi.fn(), inventory: vi.fn(),
  auth: vi.fn(), shell: vi.fn(), runs: vi.fn(), settings: vi.fn(), reports: vi.fn(), reportPreview: vi.fn(), incidents: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/ofapiExports.ts", () => ({
  ofapiExportActions: {}, useOfapiExportPages: mocks.pages, useOfapiExports: mocks.exports,
  useOfapiVisitors: mocks.visitors, useOfapiExportRows: mocks.rows, useOfapiExportInventory: mocks.inventory,
}));
vi.mock("../apps/dashboard/src/api/ofapiMedia.ts", () => ({ ofapiMediaActions: {}, useOfapiMedia: mocks.media }));
vi.mock("../apps/dashboard/src/api/queries.ts", () => ({
  useAuthMe: mocks.auth, useNotificationsSettings: mocks.settings, useReportHistory: mocks.reports,
  useReportPreview: mocks.reportPreview, useNotificationIncidents: mocks.incidents,
  useUpdateNotificationsSettings: () => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() }),
  useSendTestMessage: () => ({ isPending: false, mutate: vi.fn() }),
  useDiscoverTelegramChats: () => ({ isPending: false, mutate: vi.fn() }),
  useSendReport: () => ({ isPending: false, mutate: vi.fn() }),
  useResolveIncident: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("../apps/dashboard/src/api/workboard.ts", () => ({ useWorkboardV2AiRuns: mocks.runs }));
vi.mock("../apps/dashboard/src/components/layout/DashboardShellContext.tsx", () => ({ useDashboardShell: mocks.shell }));
vi.mock("../apps/dashboard/src/components/ai/AiPageDashboard.tsx", () => ({ AiPageDashboard: () => null, fmtNum: String, fmtUsd: String }));

import { OfapiMediaPage } from "../apps/dashboard/src/pages/OfapiMediaPage.tsx";
import { OfapiExportsPage } from "../apps/dashboard/src/pages/OfapiExportsPage.tsx";
import { AiAnalyticsPage } from "../apps/dashboard/src/pages/AiAnalyticsPage.tsx";
import { NotificationsPage } from "../apps/dashboard/src/pages/NotificationsPage.tsx";

const available = [{ id: 1, label: "first-of" }, { id: 2, label: "second-of" }];
function query(data: unknown = undefined, state: "ready" | "loading" | "error" = "ready") {
  return { data, isLoading: state === "loading", isFetching: state === "loading", isError: state === "error", isSuccess: state === "ready", error: state === "error" ? new Error("Request failed") : null, refetch: vi.fn() };
}
function render(component: ComponentType, path: string) {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, createElement(component)));
}
const emptyMedia = { uploads: [], media: [], sources: [], totalMedia: 0, inventory: { state: "unknown", note: "Coverage unknown" } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockReturnValue(query({ user: { role: "team_lead" } }));
  mocks.pages.mockReturnValue(query({ pages: available, revision: 1, backgroundPaused: false }));
  mocks.media.mockReturnValue(query(emptyMedia));
  mocks.exports.mockReturnValue(query({ jobs: [] }));
  mocks.visitors.mockReturnValue(query({ days: [], note: "Unknown coverage" }));
  mocks.rows.mockReturnValue(query());
  mocks.inventory.mockReturnValue(query());
  mocks.shell.mockReturnValue({ pages: [{ id: 3, label: "creator-fansly", platform: "fansly" }], pageCatalogState: "ready", pageCatalogError: null });
  mocks.runs.mockReturnValue(query({ runs: [] }));
  mocks.settings.mockReturnValue(query({ configured: true, connectionStatus: "untested", chatId: "12345", enabled: true, reportHourUtc: 3, dailyReportEnabled: false, syncFailureAlertsEnabled: false, aiCriticalAlertsEnabled: false }));
  mocks.reports.mockReturnValue(query({ items: [] }));
  mocks.reportPreview.mockReturnValue(query());
  mocks.incidents.mockReturnValue(query({ items: [], total: 0 }));
});

describe("OnlyFans page context", () => {
  it("defaults only an absent target and refuses explicit unavailable or empty targets", () => {
    expect(resolveOfapiPage(available, null)).toBe(available[0]);
    expect(resolveOfapiPage(available, "second-of")).toBe(available[1]);
    expect(resolveOfapiPage(available, "deleted-of")).toBeUndefined();
    expect(resolveOfapiPage(available, "")).toBeUndefined();
    expect(resolveOfapiPage(undefined, "second-of")).toBeUndefined();
  });
  it("carries labels safely while preserving a destination's query and fragment", () => {
    const href = ofapiPageHref("/settings?tab=collection&page=old#jobs", "creator & VIP");
    expect(href).toBe("/settings?tab=collection&page=creator+%26+VIP#jobs");
    expect(ofapiPageHref("/ofapi-media", null)).toBe("/ofapi-media");
    expect(ofapiPageHref("/ofapi-media", "")).toBe("/ofapi-media?page=");
  });
  it("loads media for the explicit second page rather than the first page", () => {
    render(OfapiMediaPage, "/ofapi-media?page=second-of");
    expect(mocks.media).toHaveBeenLastCalledWith(2, 0);
  });
  it("keeps an unavailable media target visible and disables page-dependent requests", () => {
    const html = render(OfapiMediaPage, "/ofapi-media?page=removed-of");
    expect(mocks.media).toHaveBeenLastCalledWith(0, 0);
    expect(html).toContain("Страница из ссылки недоступна");
    expect(html).not.toContain("Для этой страницы ещё нет заданий загрузки.");
  });
  it("loads exports and visitors for the same explicit page", () => {
    render(OfapiExportsPage, "/ofapi-exports?page=second-of");
    expect(mocks.exports).toHaveBeenLastCalledWith(2);
    expect(mocks.visitors).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: 2 }));
  });
});

describe("operational query states", () => {
  it.each(["loading", "error"] as const)("never turns initial %s media into an empty history or zero range", (state) => {
    mocks.media.mockReturnValue(query(undefined, state));
    const html = render(OfapiMediaPage, "/ofapi-media?page=first-of");
    expect(html).not.toContain("Для этой страницы ещё нет заданий загрузки.");
    expect(html).not.toContain("В сохранённом каталоге нет материалов");
    expect(html).not.toContain("1–0");
    expect(html).toContain(state === "loading" ? "Загружаем историю и каталог" : "Данные не удалось загрузить");
  });
  it("retains an unknown upload outcome and marks the saved history when refresh fails", () => {
    mocks.media.mockReturnValue(query({ ...emptyMedia, uploads: [{ id: "saved-upload", destination: "vault", reason: "indeterminate", uploadStatus: null, state: "blocked", createdAt: "2026-09-11T10:00:00Z", isReady: null, actualCredits: null, spentCredits: 2 }] }, "error"));
    const html = render(OfapiMediaPage, "/ofapi-media?page=first-of");
    expect(html).toContain("Показаны ранее полученные данные");
    expect(html).toContain("Результат неизвестен · нужна проверка");
  });
  it("does not label a failed export-list request as no jobs", () => {
    mocks.exports.mockReturnValue(query(undefined, "error"));
    const html = render(OfapiExportsPage, "/ofapi-exports?page=first-of");
    expect(html).toContain("Данные не удалось загрузить");
    expect(html).not.toContain("Для этой страницы ещё нет заданий экспорта.");
  });
  it.each(["loading", "error"] as const)("distinguishes an AI catalog %s from no supported pages", (state) => {
    mocks.shell.mockReturnValue({ pages: [], pageCatalogState: state, pageCatalogError: null });
    const html = render(AiAnalyticsPage, "/ai-analytics");
    expect(html).not.toContain("Нет Fansly-страниц для анализа");
    expect(html).toContain(state === "loading" ? "Загружаем список страниц" : "Не удалось загрузить список страниц");
  });
  it("does not report an idle classifier when the run-log request failed", () => {
    mocks.runs.mockReturnValue(query(undefined, "error"));
    const html = render(AiAnalyticsPage, "/ai-analytics?page=creator-fansly");
    expect(html).toContain("Данные не удалось загрузить");
    expect(html).not.toContain("Пока нет запусков");
  });
  it("restores notification tab and incident filters from a direct link", () => {
    const html = render(NotificationsPage, "/notifications?tab=incidents&status=open&kind=ofapi_auth&page=second-of&offset=50");
    expect(mocks.incidents).toHaveBeenLastCalledWith({ status: "open", kind: "ofapi_auth", pageLabel: "second-of", limit: 50, offset: 50 });
    expect(html).toContain("Инцидентов с такими фильтрами нет");
    expect(html).toContain("Сбросить фильтры");
  });
  it("names the saved Telegram recipient next to a separate explicit test action", () => {
    const html = render(NotificationsPage, "/notifications?tab=settings");
    expect(html).toContain("Получатель: чат 12345");
    expect(html).toContain("Отправить тест");
    expect(html).toContain("Доставка ещё не проверена");
  });
  it("retains cached report rows when history refresh fails", () => {
    mocks.reports.mockReturnValue(query({ items: [{ id: 1, reportDate: "2026-09-10", kind: "daily_report_scheduled", status: "sent", error: null, createdAt: "2026-09-11T03:00:00Z" }] }, "error"));
    const html = render(NotificationsPage, "/notifications?tab=reports");
    expect(html).toContain("Показаны ранее полученные данные");
    expect(html).toContain("2026-09-10");
    expect(html).toContain("Отправить отчёт в Telegram");
  });
});
