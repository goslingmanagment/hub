import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { buildLoginRoute, resolveLoginReturnPath, resolveDashboardPeriod, resolveSpenderPeriod } from "../apps/dashboard/src/lib/navigation.ts";

const mocks = vi.hoisted(() => ({ useAuthMe: vi.fn(), usePages: vi.fn(), useOverview: vi.fn(), useLogin: vi.fn() }));
vi.mock("../apps/dashboard/src/api/queries.ts", () => mocks);
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ KernelApiError: class extends Error { constructor(message: string, _category: string, readonly status: number) { super(message); } } }));
vi.mock("../apps/dashboard/src/components/layout/Sidebar.tsx", () => ({ Sidebar: () => "navigation" }));
vi.mock("../apps/dashboard/src/components/layout/Topbar.tsx", () => ({ Topbar: () => "account" }));
vi.mock("../apps/dashboard/src/stores/periodStore.ts", () => ({ usePeriodStore: () => ({ period: "7d", setPeriod: vi.fn() }) }));
vi.mock("../apps/dashboard/src/stores/spenderPeriodStore.ts", () => ({ useSpenderPeriodStore: () => ({ period: "7d", topSupportersPeriod: "all", setPeriod: vi.fn(), setTopSupportersPeriod: vi.fn() }) }));

import { ProtectedLayout } from "../apps/dashboard/src/components/layout/ProtectedLayout.tsx";
import { useDashboardShell } from "../apps/dashboard/src/components/layout/DashboardShellContext.tsx";
import { LoginPage } from "../apps/dashboard/src/pages/LoginPage.tsx";
import { PeriodSelector } from "../apps/dashboard/src/components/shared/PeriodSelector.tsx";
import { KernelApiError } from "../apps/dashboard/src/api/sdk.ts";

function PageProbe() {
  const { pages, pageCatalogState } = useDashboardShell();
  return createElement("p", null, `${pageCatalogState}:${pages.map((page) => page.label).join(",")}`);
}
function renderShell() {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/pages/test"] },
    createElement(Routes, null, createElement(Route, { element: createElement(ProtectedLayout) },
      createElement(Route, { path: "*", element: createElement(PageProbe) })))));
}
function renderLogin() {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(LoginPage)));
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.useAuthMe.mockReturnValue({ data: { user: { username: "owner", role: "owner" } }, isLoading: false, isError: false });
  mocks.usePages.mockReturnValue({ data: [{ id: 1, label: "test", platform: "fansly", modelSlug: "model", modelName: "Model", username: "test" }], isLoading: false, isError: false });
  mocks.useLogin.mockReturnValue({ isPending: false, isError: false, mutate: vi.fn(), reset: vi.fn() });
});

describe("shared page shell", () => {
  it("opens page identity from the small catalog without calling overview", () => {
    expect(renderShell()).toContain("ready:test");
    expect(mocks.usePages).toHaveBeenCalledWith({ enabled: true });
    expect(mocks.useOverview).not.toHaveBeenCalled();
  });
  it("keeps catalog data usable after a failed refresh and shows a retry", () => {
    const result = mocks.usePages();
    mocks.usePages.mockReturnValue({ ...result, isError: true, error: new Error("offline"), refetch: vi.fn() });
    const html = renderShell();
    expect(html).toContain("ready:test");
    expect(html).toContain("Показаны ранее полученные данные");
    expect(html).toContain("Повторить");
  });
  it("does not turn an initial catalog failure into an empty ready catalog", () => {
    mocks.usePages.mockReturnValue({ isLoading: false, isError: true, error: new Error("offline"), refetch: vi.fn() });
    const html = renderShell();
    expect(html).toContain("error:");
    expect(html).toContain("Данные не удалось загрузить");
  });
  it("shows auth recovery for network failure and disables the page query", () => {
    mocks.useAuthMe.mockReturnValue({ isLoading: false, isError: true, error: new Error("offline"), refetch: vi.fn() });
    expect(renderShell()).toContain("Не удалось проверить вход");
    expect(mocks.usePages).toHaveBeenCalledWith({ enabled: false });
  });
  it("holds protected content while authentication is pending", () => {
    mocks.useAuthMe.mockReturnValue({ isLoading: true, isError: false });
    const html = renderShell();
    expect(html).toContain("Проверяем вход");
    expect(html).not.toContain("navigation");
    expect(mocks.usePages).toHaveBeenCalledWith({ enabled: false });
  });
});

describe("login recovery", () => {
  it("preserves a scoped destination across expired-session login", () => {
    const destination = "/settings?tab=configuration&feature=voice#config-voiceNotesEnabled";
    const login = new URL(buildLoginRoute(destination), "https://hub.invalid");
    expect(login.pathname).toBe("/login");
    expect(resolveLoginReturnPath(login.searchParams.get("next"))).toBe(destination);
  });
  it.each(["https://evil.example", "//evil.example", "/%2f%2fevil.example", "/\\evil.example", "/%00bad", "/login", "/LOGIN?next=/", "/%6cogin/", "/bad%zz"])("refuses an unsafe or recursive destination %s", (target) => {
    expect(resolveLoginReturnPath(target)).toBe("/");
  });
  it("distinguishes ordinary logged-out state from a failed login and keeps a form error inline", () => {
    mocks.useAuthMe.mockReturnValue({ isError: true, error: new KernelApiError("Unauthorized", "auth", 401, null, null) });
    mocks.useLogin.mockReturnValue({ isError: true, error: new KernelApiError("Unauthorized", "auth", 401, null, null), isPending: false });
    const html = renderLogin();
    expect(html).toContain("Неверный логин или пароль");
    expect(html).not.toContain("Не удалось проверить текущую сессию");
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('role="alert"');
  });
});

describe("period identity across pages", () => {
  it("lets the valid URL win and rejects unsupported periods using the correct fallback", () => {
    expect(resolveDashboardPeriod("30d", "7d")).toBe("30d");
    expect(resolveDashboardPeriod("180d", "7d")).toBe("7d");
    expect(resolveSpenderPeriod("180d", "7d")).toBe("180d");
    expect(resolveSpenderPeriod("lifetime", "all")).toBe("all");
    expect(resolveSpenderPeriod(null, "all")).toBe("all");
  });
  it.each(["dashboard", "spender", "topSupporters"] as const)("shows the URL period in both wide and narrow %s controls", (mode) => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/pages/test?period=30d"] }, createElement(PeriodSelector, { mode })));
    expect(html).toMatch(/<option value="30d" selected="">/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>30D<\/button>/);
  });
});
