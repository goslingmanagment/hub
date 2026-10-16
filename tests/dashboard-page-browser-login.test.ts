import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

import type { PageBrowserLoginResponse } from "@agency_hub_core/contracts";

// The owner's login page of a page's server browser (Project Browser PR 15):
// one view per moment of the login, its words, and the page rendered in each
// against the states the API answers. The api layer is mocked
// (@tanstack/react-query does not resolve from the root test suite).

const mocks = vi.hoisted(() => ({
  usePageBrowserLogin: vi.fn(),
  useStartPageBrowserLogin: vi.fn(),
  useFinishPageBrowserLogin: vi.fn(),
  usePageBrowserLoginStep: vi.fn(),
  pageBrowserScreenshotUrl: vi.fn((label: string, tick: number) => `/api/v1/page-browser/pages/${label}/login/screenshot?t=${tick}`),
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => mocks);
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({
  KernelApiError: class extends Error {
    constructor(message: string, _category: string, readonly status: number) { super(message); }
  },
}));

import { PageBrowserLoginPage } from "../apps/dashboard/src/pages/page-browser/PageBrowserLoginPage.tsx";
import { browserProblemText, loginChipOf, loginViewOf, stepProblemText } from "../apps/dashboard/src/pages/page-browser/pageBrowserLoginView.ts";

function response(overrides: Partial<PageBrowserLoginResponse> = {}): PageBrowserLoginResponse {
  return {
    page: { label: "lilly-1", pageId: 7 },
    transport: "node",
    login: { state: "wanted", changedAt: "2026-10-14T04:00:00.000Z" },
    browser: { ready: true, problem: null, reachable: true },
    screen: { screen: "login", screenVersion: "fansly-login/1", fields: ["login", "password"], siteError: null },
    refused: null,
    screenUrl: "/api/v1/page-browser/pages/lilly-1/screen/index.html?autoconnect=1",
    ...overrides,
  };
}

const mutation = () => ({ isPending: false, mutate: vi.fn() });

function render(data: PageBrowserLoginResponse): string {
  mocks.usePageBrowserLogin.mockReturnValue({ isPending: false, isError: false, data, error: null, refetch: vi.fn() });
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: ["/pages/lilly-1/browser-login"] },
    createElement(Routes, null, createElement(Route, { path: "/pages/:pageLabel/browser-login", element: createElement(PageBrowserLoginPage) })),
  ));
}

beforeEach(() => {
  for (const hook of [mocks.useStartPageBrowserLogin, mocks.useFinishPageBrowserLogin]) hook.mockReset().mockReturnValue(mutation());
  mocks.usePageBrowserLoginStep.mockReset().mockReturnValue({ pending: false, send: vi.fn() });
});

describe("the login's views", () => {
  it("one per moment: closed, preparing, out of reach, the form's screens, success, unknown, closing", () => {
    expect(loginViewOf(response({ login: { state: "off", changedAt: null }, screen: null, browser: { ready: true, problem: null, reachable: null } }))).toEqual({ kind: "closed", problem: null });
    expect(loginViewOf(response({ login: { state: "off", changedAt: null }, screen: null, browser: { ready: false, problem: "no browser profile is bound to the page", reachable: null } })))
      .toEqual({ kind: "closed", problem: "к странице не привязан браузер" });
    expect(loginViewOf(response({ screen: null, refused: "not_manual_login" }))).toEqual({ kind: "preparing" });
    expect(loginViewOf(response({ screen: null, browser: { ready: true, problem: null, reachable: false } }))).toEqual({ kind: "unreachable" });
    expect(loginViewOf(response({ screen: null, browser: { ready: false, problem: "no browser profile is bound to the page", reachable: null } }))).toEqual({ kind: "unreachable" });
    expect(loginViewOf(response())).toMatchObject({ kind: "form", screen: "login", fields: ["login", "password"] });
    expect(loginViewOf(response({ screen: { screen: "code", screenVersion: "v", fields: ["code"], siteError: null } }))).toMatchObject({ kind: "form", screen: "code" });
    expect(loginViewOf(response({ screen: { screen: "error", screenVersion: "v", fields: ["login", "password"], siteError: "Invalid username or password" } })))
      .toMatchObject({ kind: "form", screen: "error", siteError: "Invalid username or password" });
    expect(loginViewOf(response({ screen: { screen: "success", screenVersion: "v", fields: [], siteError: null } }))).toEqual({ kind: "success" });
    expect(loginViewOf(response({ screen: { screen: "unknown", screenVersion: "v", fields: [], siteError: null } }))).toEqual({ kind: "unknown" });
    expect(loginViewOf(response({ login: { state: "ending", changedAt: null } }))).toEqual({ kind: "closing" });
  });

  it("the code of a new device's login is the one Fansly e-mailed: its own words on the chip (owner decision 2026-10-15)", () => {
    const email = loginViewOf(response({ screen: { screen: "code", screenVersion: "fansly-login/2", fields: ["code"], siteError: null, codeFrom: "email" } }));
    expect(email).toEqual({ kind: "form", screen: "code", fields: ["code"], siteError: null, codeFrom: "email" });
    expect(loginChipOf(email)).toEqual({ label: "Ждёт код из письма", tone: "progress" });
    const wrong = loginViewOf(response({ screen: { screen: "error", screenVersion: "fansly-login/2", fields: ["code"], siteError: "2FA code is invalid or already used.", codeFrom: "email" } }));
    expect(wrong).toMatchObject({ kind: "form", screen: "error", codeFrom: "email" });
    expect(loginChipOf(wrong)).toEqual({ label: "Fansly показал ошибку", tone: "danger" });
    // The 2FA code: nothing said of where it comes from.
    const twofa = loginViewOf(response({ screen: { screen: "code", screenVersion: "fansly-login/2", fields: ["code"], siteError: null } }));
    expect(twofa).not.toHaveProperty("codeFrom");
    expect(loginChipOf(twofa)).toEqual({ label: "Ждёт код 2FA", tone: "progress" });
  });

  it("their chips and a step's problems in the owner's words", () => {
    expect(loginChipOf({ kind: "success" })).toEqual({ label: "Вход выполнен", tone: "good" });
    expect(loginChipOf({ kind: "unknown" })).toEqual({ label: "Незнакомый экран", tone: "warning" });
    expect(loginChipOf({ kind: "form", screen: "error", fields: ["code"], siteError: "x" })).toEqual({ label: "Fansly показал ошибку", tone: "danger" });
    expect(stepProblemText({ screen: null, refused: "screen_changed", unreachable: false })).toMatch(/ничего не нажато/);
    expect(stepProblemText({ screen: null, refused: null, unreachable: true })).toMatch(/не ответил/);
    expect(stepProblemText({ screen: { screen: "code", screenVersion: "v", fields: ["code"], siteError: null }, refused: null, unreachable: false })).toBeNull();
    expect(browserProblemText("something new")).toBe("something new");
  });
});

describe("the login page", () => {
  it("closed: the start, refused with the browser's problem when it is not ready; no screenshot asked", () => {
    const closed = render(response({ login: { state: "off", changedAt: null }, screen: null, browser: { ready: false, problem: "its browser has no pinned exit IP", reachable: null } }));
    expect(closed).toContain("Начать вход");
    expect(closed).toContain("у браузера не закреплён выходной IP");
    expect(closed).not.toContain("/login/screenshot");
  });

  it("the login form: its two fields, a password field the browser does not keep, the screenshot asked", () => {
    const html = render(response());
    expect(html).toContain('id="pb-login"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain("/api/v1/page-browser/pages/lilly-1/login/screenshot?t=0");
    expect(html).toContain("Открыть экран браузера");
  });

  it("the site's error beside the form; the code's field alone; the success's finish; the unknown screen's way to the browser's screen", () => {
    expect(render(response({ screen: { screen: "error", screenVersion: "v", fields: ["login", "password"], siteError: "Invalid username or password" } }))).toContain("Invalid username or password");
    const code = render(response({ screen: { screen: "code", screenVersion: "v", fields: ["code"], siteError: null } }));
    expect(code).toContain('id="pb-code"');
    expect(code).not.toContain('id="pb-password"');
    expect(render(response({ screen: { screen: "success", screenVersion: "v", fields: [], siteError: null } }))).toContain("Завершить вход");
    expect(code).toContain("Код 2FA");
    expect(code).not.toContain("Код из письма");
    const unknown = render(response({ screen: { screen: "unknown", screenVersion: "v", fields: [], siteError: null } }));
    expect(unknown).toContain("Ничего не нажато");
    expect(unknown).toContain('href="/api/v1/page-browser/pages/lilly-1/screen/index.html?autoconnect=1"');
    expect(unknown).toContain('target="_blank"');
  });
});

describe("the code Fansly e-mailed for a login from a new device (owner decision 2026-10-15)", () => {
  it("the form asks for the code from the e-mail, says where to find it, and keeps the code's one field", () => {
    const html = render(response({ screen: { screen: "code", screenVersion: "fansly-login/2", fields: ["code"], siteError: null, codeFrom: "email" } }));
    expect(html).toContain("Ждёт код из письма");
    expect(html).toContain("Код из письма");
    expect(html).toContain("отправил код на почту аккаунта");
    expect(html).toContain("Найдите письмо от Fansly");
    expect(html).toContain('id="pb-code"');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).not.toContain("Код 2FA");
    expect(html).not.toContain('id="pb-password"');
    // Its error: the site's words, the same field, the same notice.
    const wrong = render(response({ screen: { screen: "error", screenVersion: "fansly-login/2", fields: ["code"], siteError: "2FA code is invalid or already used.", codeFrom: "email" } }));
    expect(wrong).toContain("2FA code is invalid or already used.");
    expect(wrong).toContain("Код из письма");
    expect(wrong).toContain('id="pb-code"');
  });
});


describe("the landing action in the dashboard", () => {
  it("offers opening the modal before any credential fields", () => {
    const data = response({ screen: { screen: "landing", screenVersion: "fansly-login/3", fields: [], siteError: null } });
    expect(loginViewOf(data)).toEqual({ kind: "landing" });
    const html = render(data);
    expect(html).toContain("Открыть окно входа");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('name="login"');
    expect(html).not.toContain("Незнакомый экран");
  });
});
