import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

import type { PageBrowserProfileResponse, PageBrowserProfileSummary } from "@agency_hub_core/contracts";

// The onboarding page of a new page's server browser (Project Browser PR
// 16): where the owner is (the proxy, the exit IP, the login, the account and
// the page), the browser's own word, the login's view as a page's — and the
// page rendered in each against the states the API answers. The api layer is
// mocked (@tanstack/react-query does not resolve from the root test suite).

const mutation = () => ({ mutate: vi.fn(), isPending: false });
const mocks = vi.hoisted(() => ({
  usePageBrowserProfile: vi.fn(),
  usePageBrowserProfiles: vi.fn(),
  useAdminModels: vi.fn(),
  useClosePageBrowserProfile: vi.fn(),
  useCreatePageThroughBrowser: vi.fn(),
  useFinishPageBrowserProfileLogin: vi.fn(),
  usePageBrowserProfileLoginStep: vi.fn(),
  usePinPageBrowserProfile: vi.fn(),
  useStartPageBrowserProfileLogin: vi.fn(),
  useVerifyPageBrowserProfile: vi.fn(),
  sendPageBrowserProfileProxy: vi.fn(),
  pageBrowserProfileScreenshotUrl: vi.fn((id: string, tick: number) => `/api/v1/page-browser/profiles/${id}/login/screenshot?t=${tick}`),
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

import { PageBrowserOnboardingPage } from "../apps/dashboard/src/pages/page-browser/PageBrowserOnboardingPage.tsx";
import {
  browserStatusOf,
  onboardingChipOf,
  onboardingStepsOf,
  profileLoginViewOf,
} from "../apps/dashboard/src/pages/page-browser/pageBrowserOnboardingView.ts";

const PROFILE = "0b5c1f7e-6c2a-4f0e-9d61-2a1f3c4d5e6f";

function summary(overrides: Partial<PageBrowserProfileSummary> = {}): PageBrowserProfileSummary {
  return {
    profileId: PROFILE,
    name: "ari-2",
    container: "page-browser-ari-2",
    onboarding: "off",
    createdAt: "2026-10-14T04:00:00.000Z",
    proxySet: true,
    pinnedExitIp: "203.0.113.7",
    envSet: true,
    operator: { step: null, stopReason: null, mode: "automation", exitOpen: false, exitIp: null, accountId: null, sessionKnown: false, selfTest: null, lastStateAt: null, linkError: null },
    ...overrides,
  };
}

function response(overrides: Partial<PageBrowserProfileResponse> = {}, profile: Partial<PageBrowserProfileSummary> = {}): PageBrowserProfileResponse {
  return {
    profile: summary(profile),
    socksEndpoint: "203.0.113.50:1080",
    proxy: { url: "socks5://203.0.113.50:1080", username: "pb-user" },
    env: { timeZone: "Europe/Berlin", languages: ["de-DE", "de", "en-US", "en"], geolocation: { latitude: 52.52, longitude: 13.4, accuracyM: 5000 } },
    login: { state: "off", changedAt: null },
    browser: { ready: true, problem: null, reachable: null },
    screen: null,
    refused: null,
    screenUrl: `/api/v1/page-browser/profiles/${PROFILE}/screen/index.html?autoconnect=1`,
    identity: { requestedAt: null, pending: false, ok: null, accountId: null, username: null, displayName: null, checkedAt: null, error: null },
    ...overrides,
  };
}

const UP = { step: "site_loaded", exitOpen: true, exitIp: "203.0.113.7", sessionKnown: true, selfTest: { ok: true, at: "2026-10-14T04:01:00.000Z", failed: null }, lastStateAt: "2026-10-14T04:02:00.000Z" };

beforeEach(() => {
  for (const hook of ["useClosePageBrowserProfile", "useCreatePageThroughBrowser", "useFinishPageBrowserProfileLogin", "usePinPageBrowserProfile", "useStartPageBrowserProfileLogin", "useVerifyPageBrowserProfile"] as const) {
    mocks[hook].mockReturnValue(mutation());
  }
  mocks.usePageBrowserProfileLoginStep.mockReturnValue({ pending: false, send: vi.fn() });
  mocks.useAdminModels.mockReturnValue({ data: [{ slug: "ari", name: "Ari" }] });
});

function render(data: PageBrowserProfileResponse): string {
  mocks.usePageBrowserProfile.mockReturnValue({ isPending: false, isError: false, data, refetch: vi.fn() });
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [`/browser-profiles/${PROFILE}`] },
    createElement(Routes, null, createElement(Route, { path: "/browser-profiles/:profileId", element: createElement(PageBrowserOnboardingPage) }))));
}

describe("the onboarding's steps and words (PR 16)", () => {
  it("leads the owner from the proxy to the pin, the login, the account", () => {
    expect(onboardingStepsOf(response({}, { proxySet: false, pinnedExitIp: null }))).toEqual({ proxy: "current", pin: "locked", login: "locked", account: "locked" });
    expect(onboardingStepsOf(response({}, { pinnedExitIp: null }))).toEqual({ proxy: "done", pin: "current", login: "locked", account: "locked" });
    expect(onboardingStepsOf(response())).toEqual({ proxy: "done", pin: "done", login: "current", account: "locked" });
    expect(onboardingStepsOf(response({ login: { state: "login", changedAt: null } }))).toMatchObject({ login: "current" });
    expect(onboardingStepsOf(response({ login: { state: "open", changedAt: null } }))).toEqual({ proxy: "done", pin: "done", login: "done", account: "current" });
    expect(onboardingStepsOf(response({ login: { state: "closing", changedAt: null } }))).toMatchObject({ login: "locked", account: "locked" });
  });

  it("reads the login as a page's: the screens of its browser while it is open", () => {
    expect(profileLoginViewOf(response())).toEqual({ kind: "closed", problem: null });
    expect(profileLoginViewOf(response({ browser: { ready: false, problem: "its exit IP is not pinned", reachable: null } }))).toEqual({ kind: "closed", problem: "не закреплён выходной IP" });
    const open = { login: { state: "login" as const, changedAt: null }, browser: { ready: true, problem: null, reachable: true } };
    expect(profileLoginViewOf(response(open))).toEqual({ kind: "preparing" });
    expect(profileLoginViewOf(response({ ...open, screen: { screen: "code", screenVersion: "v", fields: ["code"], siteError: null } }))).toMatchObject({ kind: "form", screen: "code" });
    expect(profileLoginViewOf(response({ ...open, browser: { ready: true, problem: null, reachable: false } }))).toEqual({ kind: "unreachable" });
  });

  it("says the browser's own word: its exit IP and self-test, or why it stands", () => {
    expect(browserStatusOf(summary())).toMatchObject({ label: "Ещё не запускался", tone: "neutral" });
    expect(browserStatusOf(summary({ operator: { ...summary().operator, ...UP } }))).toEqual({
      label: "Выход открыт",
      tone: "good",
      detail: "Браузер сам проверил свой выходной IP: 203.0.113.7 — это закреплённый IP. Самопроверка пройдена.",
    });
    expect(browserStatusOf(summary({ operator: { ...summary().operator, step: "exit_closed", stopReason: "exit_ip_changed", lastStateAt: UP.lastStateAt } })))
      .toMatchObject({ label: "Браузер стоит", tone: "danger", detail: expect.stringContaining("закрепите новый IP") });
    expect(browserStatusOf(summary({ operator: { ...summary().operator, linkError: "token", lastStateAt: UP.lastStateAt, step: "exit_closed" } }))).toMatchObject({ tone: "danger" });
    expect(onboardingChipOf(summary({ proxySet: false }))).toEqual({ label: "Нужен прокси", tone: "warning" });
    expect(onboardingChipOf(summary({ onboarding: "open" }))).toEqual({ label: "Вход выполнен", tone: "good" });
  });
});

describe("the onboarding page rendered (PR 16)", () => {
  it("first the proxy: its field, the container's SOCKS5; the later steps locked", () => {
    const html = render(response({ proxy: null }, { proxySet: false, pinnedExitIp: null }));
    expect(html).toContain("Подключение страницы · ari-2");
    expect(html).toContain('placeholder="user:pass@host:port"');
    expect(html).toContain("203.0.113.50:1080");
    expect(html).toContain('data-step-state="current"');
    expect(html).toContain("Сначала прокси и выходной IP.");
  });

  it("the login open: the form of the fields Fansly asks for, the browser's exit IP as it saw it", () => {
    const html = render(response({
      login: { state: "login", changedAt: null },
      browser: { ready: true, problem: null, reachable: true },
      screen: { screen: "login", screenVersion: "v", fields: ["login", "password"], siteError: null },
    }, { onboarding: "login", operator: { ...summary().operator, ...UP, mode: "manual_login" } }));
    expect(html).toContain('id="pb-password"');
    expect(html).toContain("Браузер сам проверил свой выходной IP: 203.0.113.7");
    expect(html).toContain("Открыть экран браузера");
    // The proxy does not change under an open login.
    expect(html).not.toContain('id="pb-proxy"');
  });

  it("the login closed: the account checked through the browser, then the page with its label fixed", () => {
    const html = render(response({
      login: { state: "open", changedAt: null },
      identity: { requestedAt: "2026-10-14T04:05:00.000Z", pending: false, ok: true, accountId: "300000000000000916", username: "ari2", displayName: "Ari Two", checkedAt: "2026-10-14T04:05:01.000Z", error: null },
    }, { onboarding: "open", operator: { ...summary().operator, ...UP } }));
    expect(html).toContain('data-identity="ok"');
    expect(html).toContain("@ari2 (Ari Two)");
    expect(html).toContain("Создать страницу");
    expect(html).toMatch(/<span class="[^"]*font-mono[^"]*">ari-2<\/span>/);
  });
});
