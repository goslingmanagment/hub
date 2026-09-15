import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Decision 351: a chatter's home is /account. Every owner page behind
// ProtectedLayout answers 403 for them, so neither a fresh sign-in nor a
// remembered `next` may land them there.

const mocks = vi.hoisted(() => ({
  useAuthMe: vi.fn(),
  useLogin: vi.fn(),
  useLogout: vi.fn(),
  usePages: vi.fn(),
  navigate: vi.fn(),
  search: new URLSearchParams(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => ({
  useAuthMe: mocks.useAuthMe,
  useLogin: mocks.useLogin,
  useLogout: mocks.useLogout,
  usePages: mocks.usePages,
}));
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({
  KernelApiError: class extends Error {
    constructor(
      message: string,
      _category: string,
      readonly status: number,
      _code: string | null = null,
      _body: unknown = null,
    ) { super(message); }
  },
}));
vi.mock("../apps/dashboard/src/lib/queryClient.ts", () => ({ clearDashboardSession: vi.fn() }));
vi.mock("react-router", () => ({
  Navigate: ({ to }: { to: string }) => createElement("nav-redirect", { "data-to": to }),
  Outlet: () => createElement("page-outlet"),
  Link: ({ children }: { children: ReactNode }) => children,
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: "/", search: "", hash: "", key: "k" }),
  useSearchParams: () => [mocks.search, vi.fn()],
}));
vi.mock("../apps/dashboard/src/components/layout/Sidebar.tsx", () => ({
  Sidebar: () => createElement("owner-sidebar"),
}));
vi.mock("../apps/dashboard/src/components/layout/Topbar.tsx", () => ({
  Topbar: () => createElement("owner-topbar"),
}));

import { ChatterLayout } from "../apps/dashboard/src/components/layout/ChatterLayout.tsx";
import { ProtectedLayout } from "../apps/dashboard/src/components/layout/ProtectedLayout.tsx";
import { LoginPage } from "../apps/dashboard/src/pages/LoginPage.tsx";
import { CHATTER_HOME, resolveRoleHome } from "../apps/dashboard/src/lib/navigation.ts";

function user(role: string) {
  return { authMethod: "session", user: { id: 3, username: "grisha", role, mustChangePassword: false, assignedPages: [] } };
}

beforeEach(() => {
  mocks.search = new URLSearchParams();
  mocks.navigate.mockReset();
  mocks.useAuthMe.mockReset().mockReturnValue({ data: user("chatter"), isLoading: false, isError: false });
  mocks.useLogin.mockReset().mockReturnValue({ isPending: false, isError: false, error: null, mutate: vi.fn(), reset: vi.fn() });
  mocks.useLogout.mockReset().mockReturnValue({ isPending: false, mutateAsync: vi.fn() });
  mocks.usePages.mockReset().mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
});

describe("resolveRoleHome", () => {
  it("sends a chatter to the cabinet whatever was requested", () => {
    expect(resolveRoleHome("chatter", "/")).toBe(CHATTER_HOME);
    expect(resolveRoleHome("chatter", "/usage")).toBe(CHATTER_HOME);
    expect(CHATTER_HOME).toBe("/account");
  });

  it("leaves every other role on the page they asked for", () => {
    expect(resolveRoleHome("owner", "/usage")).toBe("/usage");
    expect(resolveRoleHome("team_lead", "/transactions")).toBe("/transactions");
  });
});

describe("LoginPage", () => {
  it("opens the cabinet for a signed-in chatter, not the console", () => {
    mocks.search = new URLSearchParams({ next: "/usage" });
    expect(renderToStaticMarkup(createElement(LoginPage))).toContain('data-to="/account"');
  });

  it("returns an owner to the page they were sent away from", () => {
    mocks.search = new URLSearchParams({ next: "/usage" });
    mocks.useAuthMe.mockReturnValue({ data: user("owner"), isLoading: false, isError: false });
    expect(renderToStaticMarkup(createElement(LoginPage))).toContain('data-to="/usage"');
  });

  it("still shows the form when nobody is signed in", () => {
    mocks.useAuthMe.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).not.toContain("nav-redirect");
    expect(html).toContain("Логин");
  });
});

describe("ProtectedLayout", () => {
  it("turns a chatter back to their cabinet instead of a console of refusals", () => {
    const html = renderToStaticMarkup(createElement(ProtectedLayout));
    expect(html).toContain('data-to="/account"');
    expect(html).not.toContain("owner-sidebar");
  });

  it("leaves the console to the owner", () => {
    mocks.useAuthMe.mockReturnValue({ data: user("owner"), isLoading: false, isError: false });
    const html = renderToStaticMarkup(createElement(ProtectedLayout));
    expect(html).not.toContain("nav-redirect");
    expect(html).toContain("owner-sidebar");
    expect(html).toContain("page-outlet");
  });
});

describe("ChatterLayout", () => {
  it("is one line of chrome over the page, with no owner navigation", () => {
    const html = renderToStaticMarkup(createElement(ChatterLayout));
    expect(html).toContain("grisha");
    expect(html).toContain("Выйти");
    expect(html).toContain("page-outlet");
    expect(html).not.toContain("owner-sidebar");
    expect(html).not.toContain("owner-topbar");
  });

  it("opens the same cabinet for an owner — it is their account too", () => {
    mocks.useAuthMe.mockReturnValue({ data: user("owner"), isLoading: false, isError: false });
    const html = renderToStaticMarkup(createElement(ChatterLayout));
    expect(html).not.toContain("nav-redirect");
    expect(html).toContain("page-outlet");
  });
});
