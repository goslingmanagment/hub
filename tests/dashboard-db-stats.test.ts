import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

const queryMocks = vi.hoisted(() => ({ useAdminDbStats: vi.fn() }));
vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);
import { DbStatsPage } from "../apps/dashboard/src/pages/dev/DbStatsPage.tsx";

const data = {
  tables: [
    { schema: "public", table: "observations", rowEstimate: 1200, totalBytes: 2048, indexBytes: 1024 },
    { schema: "public", table: "domain_events", rowEstimate: 0, totalBytes: 0, indexBytes: 0 },
  ],
  migrations: [
    { name: "0001_init.sql", appliedAt: "2026-03-01T12:00:00.000Z" },
    { name: "0002_add_sync_rollups.sql", appliedAt: "2026-03-22T12:00:00.000Z" },
  ],
};
function renderPage(path = "/dev/db-stats") {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, createElement(DbStatsPage)));
}

describe("DbStatsPage", () => {
  beforeEach(() => {
    queryMocks.useAdminDbStats.mockReset();
    queryMocks.useAdminDbStats.mockReturnValue({ data, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() });
  });
  it("labels row estimates and inclusive sizes, with newest migrations first", () => {
    const html = renderPage();
    expect(html).toContain("оценка PostgreSQL");
    expect(html).toContain("Общий размер уже включает индексы");
    expect(html).toContain("0 Б");
    expect(html).toContain("2 КиБ");
    expect(html.indexOf("0002_add_sync_rollups.sql")).toBeLessThan(html.indexOf("0001_init.sql"));
    expect(html).toContain('aria-label="Размеры таблиц" tabindex="0"');
    expect(html).toContain('aria-label="История миграций" tabindex="0"');
  });
  it("keeps navigation context and a retry when the first request fails", () => {
    queryMocks.useAdminDbStats.mockReturnValue({ data: undefined, isError: true, refetch: vi.fn() });
    const html = renderPage("/dev/db-stats?q=public");
    expect(html).toContain("База данных");
    expect(html).toContain('value="public"');
    expect(html).toContain("Повторить");
    expect(html).not.toContain("Нет сведений о таблицах");
  });
  it("keeps cached rows and migrations on a failed refresh", () => {
    queryMocks.useAdminDbStats.mockReturnValue({ data, isError: true, refetch: vi.fn() });
    const html = renderPage();
    expect(html).toContain("Показаны ранее полученные данные");
    expect(html).toContain("observations");
    expect(html).toContain("0002_add_sync_rollups.sql");
    expect(html).toContain("Повторить");
  });
  it("restores search from the URL and distinguishes a search miss from missing data", () => {
    const html = renderPage("/dev/db-stats?q=OBSERVATIONS");
    expect(html).toContain("observations");
    expect(html).not.toContain("domain_events");
    expect(html).toContain("Миграции не найдены");
    expect(html).toContain("Сбросить поиск");
    expect(html).not.toContain("Нет сведений о миграциях");
  });
  it("does not equate an empty migration response with a database that never migrated", () => {
    queryMocks.useAdminDbStats.mockReturnValue({ data: { tables: [], migrations: [] }, isError: false, refetch: vi.fn() });
    const html = renderPage();
    expect(html).toContain("Это не подтверждает, что миграции не применялись");
    expect(html).not.toContain("Миграции не найдены");
  });
});
