import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adminClientHealthResponseSchema, type AdminClientHealthResponse } from "@agency_hub_core/contracts";

const queryMocks = vi.hoisted(() => ({
  useAdminClientHealth: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { ClientHealthPage } from "../apps/dashboard/src/pages/dev/ClientHealthPage.tsx";
import {
  CLIENT_HEALTH_FEW_REPORTS,
  clientHealthPageModel,
  clientHealthRange,
  clientHealthRangeLabel,
  compareVersionsNewestFirst,
  formatKb,
  formatMs,
} from "../apps/dashboard/src/pages/dev/clientHealthView.ts";

// The owner's client-health page (chat-extension H-11c): its view model, and the
// page as it renders. The numbers come from the hub as they are
// (tests/client-health-view.test.ts); this pins how they are put in front of the
// owner, and that a group the hub held back prints no figure.

// ru-RU groups thousands with a no-break space.
const NBSP = " ";

const GROUP = { clientName: "chat-extension", hostKind: "chatspace" };

function answer(overrides: Partial<AdminClientHealthResponse> = {}): AdminClientHealthResponse {
  return adminClientHealthResponseSchema.parse({
    range: { from: "2026-09-27", to: "2026-10-03", timeZone: "Europe/Moscow" },
    minGroupSize: 20,
    perf: [
      {
        ...GROUP, clientVersion: "1.4.2", hostBuild: "index-DEVowLko", metric: "panelOpenMs", schemaVersion: 1,
        count: 1840, mean: 21.4, max: 2310, p50: 14.2, p95: 61.8, suppressed: false,
      },
      {
        ...GROUP, clientVersion: "1.4.2", hostBuild: "index-DEVowLko", metric: "insertMs", schemaVersion: 1,
        count: 412, mean: 38.25, max: 480, p50: 7.25, p95: 96, suppressed: false,
      },
      {
        ...GROUP, clientVersion: "1.10.0", hostBuild: null, metric: "insertMs", schemaVersion: 1,
        count: 7, mean: null, max: null, p50: null, p95: null, suppressed: true,
      },
      {
        ...GROUP, clientVersion: "1.4.2", hostBuild: "index-DEVowLko", metric: "futureMetricMs", schemaVersion: 1,
        count: 30, mean: 4, max: 9, p50: 3, p95: 8, suppressed: false,
      },
    ],
    contract: [
      { clientVersion: "1.4.2", hostBuild: "index-Bq81xZ0a", reports: 12, failedReports: 12, missing: [{ anchor: "composer.editor", reports: 12 }, { anchor: "chat.list", reports: 3 }] },
      { clientVersion: "1.4.2", hostBuild: "index-DEVowLko", reports: 1412, failedReports: 0, missing: [] },
      { clientVersion: "(other)", hostBuild: "(other)", reports: 2, failedReports: 0, missing: [] },
      { clientVersion: "1.10.0", hostBuild: null, reports: 3, failedReports: 1, missing: [{ anchor: "chat.header", reports: 1 }] },
    ],
    counters: [
      { code: "CG-NET-TIMEOUT", total: 14 },
      { code: "insert.prevented", total: 3 },
      { code: "p1.insert-misplaced", total: 0 },
      { code: "CG-HOST-CONTRACT", total: 96 },
    ],
    footprint: [
      { clientVersion: "1.4.2", cachesKBp95: 420, logsKBp95: 2600, domNodesP95: 5230.4 },
      { clientVersion: "1.10.0", cachesKBp95: null, logsKBp95: null, domNodesP95: null },
    ],
    asOf: "2026-10-03T12:00:00.000Z",
    ...overrides,
  });
}

describe("client-health page model", () => {
  it("orders versions newest first by their numbers, the placeholder last", () => {
    const versions = ["1.4.2", "(other)", "1.10.0", "1.4.10", "0.9.0"];
    expect([...versions].sort(compareVersionsNewestFirst)).toEqual(["1.10.0", "1.4.10", "1.4.2", "0.9.0", "(other)"]);
    expect(compareVersionsNewestFirst("1.4.2", "1.4.2")).toBe(0);
  });

  it("prints milliseconds and sizes the way a person reads them", () => {
    expect(formatMs(7.25)).toBe("7,3 мс");
    expect(formatMs(0.04)).toBe("0 мс");
    expect(formatMs(61.8)).toBe("62 мс");
    expect(formatMs(2310)).toBe(`2${NBSP}310 мс`);
    expect(formatKb(420)).toBe("420 КБ");
    expect(formatKb(2600)).toBe("2,5 МБ");
  });

  it("offers ranges that end today and names them in Russian", () => {
    expect(clientHealthRange("today", "2026-10-03")).toEqual({ from: "2026-10-03", to: "2026-10-03" });
    expect(clientHealthRange("7d", "2026-10-03")).toEqual({ from: "2026-09-27", to: "2026-10-03" });
    expect(clientHealthRange("30d", "2026-03-01")).toEqual({ from: "2026-01-31", to: "2026-03-01" });
    expect(clientHealthRangeLabel({ from: "2026-10-03", to: "2026-10-03" })).toBe("3 октября");
    expect(clientHealthRangeLabel({ from: "2026-09-27", to: "2026-10-03" })).toBe("27 сентября – 3 октября");
  });

  it("lists the contract rows newest version first, the busiest build first, and adds the reports up", () => {
    const model = clientHealthPageModel(answer());
    expect(model.contract.map((row) => [row.version, row.build, row.reports, row.failedReports, row.missing])).toEqual([
      ["1.10.0", "не определена", "3", "1", "chat.header — 1"],
      ["1.4.2", "index-DEVowLko", `1${NBSP}412`, "0", ""],
      ["1.4.2", "index-Bq81xZ0a", "12", "12", "composer.editor — 12, chat.list — 3"],
      ["другие", "другие", "2", "0", ""],
    ]);
    expect([model.reports, model.failedReports, model.minGroupSize, model.empty]).toEqual([1429, 13, 20, false]);
  });

  it("groups the speed rows by metric in the page's order, an unknown metric last under its code", () => {
    const model = clientHealthPageModel(answer());
    expect(model.perf.map((block) => [block.metric, block.label, block.rows.length])).toEqual([
      ["panelOpenMs", "Клавиша или клик → видимый отклик", 1],
      ["insertMs", "Вставка текста в поле с проверкой", 2],
      ["futureMetricMs", null, 1],
    ]);
    const [newest, older] = model.perf[1]!.rows;
    expect(newest).toMatchObject({ version: "1.10.0", build: "не определена", count: "7", suppressed: true });
    expect(older).toEqual({
      key: "chat-extension|1.4.2|chatspace|index-DEVowLko|1",
      version: "1.4.2",
      build: "index-DEVowLko",
      count: "412",
      suppressed: false,
      mean: "38 мс",
      p50: "7,3 мс",
      p95: "96 мс",
      max: "480 мс",
    });
  });

  it("puts the counters the extension always sends first, then the rest by size", () => {
    expect(clientHealthPageModel(answer()).counters).toEqual([
      { code: "p1.insert-misplaced", label: "Вставка в чужой чат", total: "0" },
      { code: "insert.prevented", label: "Вставка остановлена проверкой", total: "3" },
      { code: "CG-HOST-CONTRACT", label: null, total: "96" },
      { code: "CG-NET-TIMEOUT", label: null, total: "14" },
    ]);
  });

  it("names the extension's bookkeeping counters and lists them last, however large", () => {
    // What the extension counts beside its error codes (chat-extension core, telemetry/health.ts).
    const counters = [
      { code: "perf.capped", total: 54_000 },
      { code: "health.bad-counter", total: 2 },
      { code: "CG-NET-TIMEOUT", total: 14 },
      { code: "perf.rejected", total: 1 },
      { code: "p1.other", total: 1 },
      { code: "perf.invalid", total: 7 },
      { code: "send.held", total: 0 },
      { code: "futureCounter", total: 60_000 },
    ];
    expect(clientHealthPageModel(answer({ counters })).counters).toEqual([
      { code: "p1.other", label: "Другой критичный сбой", total: "1" },
      { code: "send.held", label: "Отправка удержана", total: "0" },
      { code: "futureCounter", label: null, total: `60${NBSP}000` },
      { code: "CG-NET-TIMEOUT", label: null, total: "14" },
      { code: "perf.capped", label: "Замеры сверх лимита, в отчёт не вошли", total: `54${NBSP}000` },
      { code: "perf.invalid", label: "Замеры с негодным значением, отброшены", total: "7" },
      { code: "perf.rejected", label: "Наборы замеров не того формата, отброшены", total: "1" },
      { code: "health.bad-counter", label: "Счётчики с недопустимым именем, отброшены", total: "2" },
    ]);
  });

  it("says a version has too few reports instead of printing a footprint figure", () => {
    expect(clientHealthPageModel(answer()).footprint).toEqual([
      { version: "1.10.0", caches: CLIENT_HEALTH_FEW_REPORTS, logs: CLIENT_HEALTH_FEW_REPORTS, domNodes: CLIENT_HEALTH_FEW_REPORTS },
      { version: "1.4.2", caches: "420 КБ", logs: "2,5 МБ", domNodes: `5${NBSP}230` },
    ]);
  });

  it("is empty only when the hub sent no row at all", () => {
    const nothing = { perf: [], contract: [], counters: [], footprint: [] };
    expect(clientHealthPageModel(answer(nothing)).empty).toBe(true);
    expect(clientHealthPageModel(answer({ ...nothing, counters: [{ code: "p1.insert-misplaced", total: 0 }] })).empty).toBe(false);
  });
});

describe("ClientHealthPage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-10-03 09:00 UTC = 12:00 in Moscow.
    vi.setSystemTime(new Date("2026-10-03T09:00:00.000Z"));
    queryMocks.useAdminClientHealth.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderPage() {
    return renderToStaticMarkup(createElement(ClientHealthPage));
  }

  it("asks for the last seven Moscow days and prints every section", () => {
    queryMocks.useAdminClientHealth.mockReturnValue({ data: answer(), isLoading: false, isError: false, isFetching: false });
    const html = renderPage();

    expect(queryMocks.useAdminClientHealth).toHaveBeenCalledWith({ from: "2026-09-27", to: "2026-10-03" });
    expect(html).toContain("Расширение для чата: отчёты о работе");
    expect(html).toContain("27 сентября – 3 октября, дни по московскому времени");
    for (const title of ["Проверка страницы ChatSpace", "Скорость", "Счётчики", "Сколько расширение держит у себя"]) {
      expect(html, title).toContain(title);
    }
    expect(html).toContain(`Всего отчётов: 1${NBSP}429, с ошибкой: 13.`);
    expect(html).toContain("composer.editor — 12, chat.list — 3");
    expect(html).toContain("Вставка текста в поле с проверкой");
    expect(html).toContain("7,3 мс");
    expect(html).toContain("Вставка в чужой чат");
    expect(html).toContain("2,5 МБ");
    // A row without a name is not called an error: only a CG- code is one, and the bookkeeping is not.
    expect(html).toContain("те, что начинаются с CG-, — ошибки");
    expect(html).toContain("служебные счётчики");
    expect(html).not.toContain("остальные строки — ошибки по коду");
  });

  it("prints only the size of a group the hub held back", () => {
    queryMocks.useAdminClientHealth.mockReturnValue({
      data: answer({
        perf: [{
          ...GROUP, clientVersion: "1.10.0", hostBuild: null, metric: "insertMs", schemaVersion: 1,
          count: 7, mean: null, max: null, p50: null, p95: null, suppressed: true,
        }],
        footprint: [{ clientVersion: "1.10.0", cachesKBp95: null, logsKBp95: null, domNodesP95: null }],
      }),
      isLoading: false,
      isError: false,
      isFetching: false,
    });
    const html = renderPage();

    expect(html).toMatch(/<td[^>]*>7<\/td><td colSpan="4"[^>]*>мало замеров<\/td>/);
    expect(html.split(CLIENT_HEALTH_FEW_REPORTS).length - 1).toBe(3);
    expect(html).toContain("Если замеров меньше 20, показано только их число");
    expect(html).not.toContain(" мс<");
  });

  it("names no person: the page has no column for one", () => {
    queryMocks.useAdminClientHealth.mockReturnValue({ data: answer(), isLoading: false, isError: false, isFetching: false });
    const headers = [...renderPage().matchAll(/<th[^>]*>([^<]*)</g)].map((match) => match[1]);
    expect(headers.filter((header) => /сотрудник|чаттер|логин|имя|кто/i.test(header ?? ""))).toEqual([]);
    expect(headers).toContain("Версия расширения");
  });

  it("says so when the range holds no report, and how reports start coming", () => {
    queryMocks.useAdminClientHealth.mockReturnValue({
      data: answer({ perf: [], contract: [], counters: [], footprint: [] }),
      isLoading: false,
      isError: false,
      isFetching: false,
    });
    const html = renderPage();
    expect(html).toContain("За этот период отчётов нет");
    expect(html).toContain("«Расширение для чата: отчёты о работе»");
    expect(html).not.toContain("<table");
  });

  it("shows loading, a failed load with a retry, and a failed refresh over the last answer", () => {
    queryMocks.useAdminClientHealth.mockReturnValue({ data: undefined, isLoading: true, isError: false, isFetching: true });
    expect(renderPage()).toContain("Загружаем отчёты");

    queryMocks.useAdminClientHealth.mockReturnValue({ data: undefined, isLoading: false, isError: true, isFetching: false });
    const failed = renderPage();
    expect(failed).toContain("Отчёты не загрузились");
    expect(failed).toContain("Повторить");

    queryMocks.useAdminClientHealth.mockReturnValue({ data: answer(), isLoading: false, isError: true, isFetching: false });
    const stale = renderPage();
    expect(stale).toContain("Обновить не получилось. Показаны данные прошлой загрузки.");
    expect(stale).toContain("Проверка страницы ChatSpace");
  });
});
