import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

import type { PageBrowserDraftView, PageBrowserProxyCheckResponse } from "@agency_hub_core/contracts";

// The one proxy field of a page's server browser in the dashboard (Project
// Browser, owner decision 2026-10-15): what Hub reads in the pasted text,
// the password masked, the question for a text that reads two ways, the
// owner's check in his words, the environment's fields — and the draft page
// and the Settings section rendered. The api layer is mocked.

const mocks = vi.hoisted(() => ({
  usePageBrowserDrafts: vi.fn(),
  usePageBrowserProfiles: vi.fn(),
  useDeletePageBrowserDraft: vi.fn(),
  savePageBrowserDraft: vi.fn(),
  checkPageBrowserProxy: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => mocks);
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({
  KernelApiError: class extends Error {
    constructor(message: string, _category: string, readonly status: number) { super(message); }
  },
}));
vi.mock("../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { PageBrowserDraftPage } from "../apps/dashboard/src/pages/page-browser/PageBrowserDraftPage.tsx";
import {
  asSocks5Text,
  checkViewOf,
  draftChipOf,
  envOfFields,
  maskedRows,
  proxyPreviewOf,
} from "../apps/dashboard/src/pages/page-browser/proxyEntryView.ts";
import { BrowserProfilesSection } from "../apps/dashboard/src/pages/settings/BrowserProfilesSection.tsx";

const PASSWORD = "dash-proxy-password-41c9";
const MASKED = { scheme: "socks5" as const, host: "198.51.100.20", port: 7000, username: "user-zone-de", passwordSet: true };
const ENV = { timeZone: "Europe/Berlin", languages: ["de-DE", "de", "en-US", "en"], geolocation: { latitude: 52.5244, longitude: 13.4105, accuracyM: 1000 } };

function checked(overrides: Partial<PageBrowserProxyCheckResponse> = {}): PageBrowserProxyCheckResponse {
  return {
    ok: true,
    problem: null,
    spoken: "socks5",
    proxy: MASKED,
    socksEndpoint: "198.51.100.20:7000",
    latencyMs: 412,
    exit: { ip: "203.0.113.7", country: null, countryCode: "DE", region: "Land Berlin", city: "Berlin", isp: "Example Mobile GmbH", asn: "AS64500", timeZone: "Europe/Berlin", latitude: 52.5244, longitude: 13.4105 },
    ipInfoService: "ipinfo.io",
    env: ENV,
    checkId: "4b1f0e2a-9c3d-4e5f-8a7b-6c5d4e3f2a1b",
    checkedAt: "2026-10-15T12:00:00.000Z",
    ...overrides,
  };
}

const draft = (overrides: Partial<PageBrowserDraftView> = {}): PageBrowserDraftView => ({
  name: "ari-2",
  page: null,
  proxy: MASKED,
  env: ENV,
  revision: 2,
  createdAt: "2026-10-15T11:00:00.000Z",
  updatedAt: "2026-10-15T11:05:00.000Z",
  command: "scripts/deploy-page-browser.sh add-profile <host> --page ari-2 --image <образ>",
  ...overrides,
});

beforeEach(() => {
  mocks.useDeletePageBrowserDraft.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mocks.usePageBrowserProfiles.mockReturnValue({ data: { profiles: [] }, isError: false, isPending: false });
  mocks.usePageBrowserDrafts.mockReturnValue({ data: { drafts: [], pages: [{ pageId: 7, label: "lilly-1", proxy: { ...MASKED, host: "203.0.113.90", port: 1080 } }] }, isError: false, isPending: false });
});

describe("the pasted proxy as the field shows it", () => {
  it("its parts, the password masked; HTTP read and said unusable; a two-way text asks", () => {
    const parsed = proxyPreviewOf(`198.51.100.20:7000:user-zone-de:${PASSWORD}`, null);
    expect(parsed).toMatchObject({ kind: "parsed", problem: null, httpScheme: false, masked: MASKED });
    const rows = maskedRows(MASKED);
    expect(rows).toEqual([
      { label: "Тип", value: "SOCKS5" }, { label: "Адрес", value: "198.51.100.20" }, { label: "Порт", value: "7000" },
      { label: "Логин", value: "user-zone-de" }, { label: "Пароль", value: "••••••••" },
    ]);
    expect(JSON.stringify(parsed)).not.toContain(PASSWORD);
    expect(proxyPreviewOf(`http://u:${PASSWORD}@198.51.100.20:8080`, null)).toMatchObject({ kind: "parsed", httpScheme: true, problem: expect.stringContaining("HTTP-прокси") });
    expect(proxyPreviewOf("gate.example.com:1080:john.doe:5555", null)).toEqual({
      kind: "ambiguous",
      options: [
        { order: "host_first", label: "адрес gate.example.com:1080, логин john.doe" },
        { order: "user_first", label: "адрес john.doe:5555, логин gate.example.com" },
      ],
    });
    expect(proxyPreviewOf("gate.example.com:1080:john.doe:5555", "user_first")).toMatchObject({ kind: "parsed", masked: { host: "john.doe", port: 5555 } });
    expect(proxyPreviewOf("198.51.100.20", null)).toMatchObject({ kind: "invalid", reason: expect.stringContaining("Нет порта") });
    // A pasted HTTP proxy whose port speaks SOCKS5: the field's own text, as socks5://.
    expect(asSocks5Text(`http://u:${PASSWORD}@198.51.100.20:8080`, null)).toBe(`socks5://u:${PASSWORD}@198.51.100.20:8080`);
  });
});

describe("the owner's check in his words", () => {
  it("works: the protocol, latency, exit IP, country in Russian, city and region, ISP and ASN, time zone, the service", () => {
    expect(checkViewOf(checked())).toEqual({
      tone: "good",
      title: "Прокси работает",
      reason: null,
      offerSocks5: false,
      rows: [
        { label: "Протокол", value: "SOCKS5" },
        { label: "Задержка", value: "412 мс" },
        { label: "Выходной IP", value: "203.0.113.7" },
        { label: "Страна", value: "Германия (DE)" },
        { label: "Город, регион", value: "Berlin, Land Berlin" },
        { label: "Провайдер", value: "Example Mobile GmbH · AS64500" },
        { label: "Часовой пояс", value: "Europe/Berlin" },
        { label: "Данные о месте", value: "ipinfo.io, через прокси" },
      ],
    });
  });

  it("does not: a wrong password, an HTTP proxy, a TLS port, no answer — each said plainly", () => {
    const failed = (code: NonNullable<PageBrowserProxyCheckResponse["problem"]>["code"], spoken: PageBrowserProxyCheckResponse["spoken"]) =>
      checkViewOf(checked({ ok: false, problem: { code, detail: "x" }, spoken, latencyMs: null, exit: null, ipInfoService: null, env: null }));
    expect(failed("wrong_login", "socks5")).toMatchObject({ tone: "danger", reason: "Неверный логин или пароль прокси" });
    expect(failed("not_socks5", "http").reason).toMatch(/^Это HTTP-прокси, а браузер страницы выходит только через SOCKS5/);
    expect(failed("not_socks5", "tls").reason).toContain("TLS");
    expect(failed("no_answer", null).reason).toBe("Прокси не отвечает: соединение не открылось вовремя");
    expect(failed("refused", null).reason).toContain("отказал");
    // Pasted as HTTP, and the port speaks SOCKS5: offered as SOCKS5.
    expect(checkViewOf(checked({ proxy: { ...MASKED, scheme: "http" } }))).toMatchObject({ tone: "warning", offerSocks5: true });
  });
});

describe("the environment's fields", () => {
  it("read as the operator takes them, or why not", () => {
    expect(envOfFields({ timeZone: " Europe/Berlin ", languages: "de-DE, de en-US;en", latitude: "52,5244", longitude: "13.4105", accuracyM: "1000" }))
      .toEqual({ env: ENV, problem: null });
    expect(envOfFields({ timeZone: "Europe/Berlin", languages: "de_DE", latitude: "1", longitude: "1", accuracyM: "1" }).problem).toMatch(/не код языка/);
    expect(envOfFields({ timeZone: "Europe/Berlin", languages: "de", latitude: "", longitude: "1", accuracyM: "1" }).problem).toMatch(/Широта/);
  });
});

function renderAt(path: string, element: ReturnType<typeof createElement>, routePath: string): string {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, createElement(Routes, null, createElement(Route, { path: routePath, element }))));
}

describe("the draft page and the Settings section rendered", () => {
  it("a new browser: whose it is, one proxy field, the check, the environment, the save — locked until all is there", () => {
    const html = renderAt("/browser-profiles/new", createElement(PageBrowserDraftPage), "/browser-profiles/new");
    expect(html).toContain("Новый браузер страницы");
    expect(html).toContain("Новая страница");
    expect(html).toContain("Существующая страница переходит на браузер");
    expect(html).toContain("data-proxy-field");
    expect(html).toContain("Проверить прокси");
    expect(html).toContain('id="pb-env-timeZone"');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*data-draft-save/);
    // Saved only after a check: the address it connected to is the one stored.
    expect(html).toContain("data-draft-needs-check");
  });

  it("an existing page moving to its browser: its own proxy shown, masked, checkable; no field", () => {
    const html = renderAt("/browser-profiles/new?page=lilly-1", createElement(PageBrowserDraftPage), "/browser-profiles/new");
    expect(html).toContain("Прокси страницы: <span class=\"font-mono text-text-primary\">SOCKS5 · 203.0.113.90:1080 · логин user-zone-de · пароль ••••••••</span>");
    expect(html).not.toContain("data-proxy-field");
  });

  it("the section: a button to start a browser, each draft with what add-profile will run, the profiles as before", () => {
    mocks.usePageBrowserDrafts.mockReturnValue({ data: { drafts: [draft(), draft({ name: "lilly-1", page: { pageId: 7, label: "lilly-1" }, command: "scripts/deploy-page-browser.sh add-profile <host> --page lilly-1 --image <образ> --existing" })], pages: [] }, isError: false, isPending: false });
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(BrowserProfilesSection)));
    expect(html).toContain("Новый браузер страницы");
    expect(html).toContain('data-browser-draft="ari-2"');
    expect(html).toContain("scripts/deploy-page-browser.sh add-profile &lt;host&gt; --page ari-2 --image &lt;образ&gt;");
    expect(html).toContain("--page lilly-1 --image &lt;образ&gt; --existing");
    expect(html).toContain("Ждёт add-profile");
    expect(draftChipOf(draft({ page: { pageId: 7, label: "lilly-1" }, proxy: null }))).toEqual({ label: "У страницы нет прокси", tone: "danger" });
  });
});
