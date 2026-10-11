import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Decision 351: a chatter's home is /account. Every owner page behind
// ProtectedLayout answers 403 for them, so neither a fresh sign-in nor a
// remembered `next` may land them there.
//
// The app also answers on the chatters' own site, where nginx serves only
// /account, /join and /login. There the sign-in carries the product's name and
// the cabinet is every role's home: the console lives under another name.

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
import { resolveRoleHome } from "../apps/dashboard/src/lib/navigation.ts";
import { CHATTER_SITE_ORIGIN, CONSOLE_ORIGIN } from "../apps/dashboard/src/lib/sites.ts";

function user(role: string) {
  return { authMethod: "session", user: { id: 3, username: "grisha", role, mustChangePassword: false, assignedPages: [] } };
}

function openOn(origin: string) {
  vi.stubGlobal("window", { location: { origin } });
}

function signedOut() {
  mocks.useAuthMe.mockReturnValue({ data: undefined, isLoading: false, isError: false });
}

const CHATGOOSE_WORDMARK = '<span class="text-accent">Chat</span><span>Goose</span>';
const AGENCYHUB_WORDMARK = '<span class="text-accent">Agency</span><span>Hub</span>';

beforeEach(() => {
  mocks.search = new URLSearchParams();
  mocks.navigate.mockReset();
  mocks.useAuthMe.mockReset().mockReturnValue({ data: user("chatter"), isLoading: false, isError: false });
  mocks.useLogin.mockReset().mockReturnValue({ isPending: false, isError: false, error: null, mutate: vi.fn(), reset: vi.fn() });
  mocks.useLogout.mockReset().mockReturnValue({ isPending: false, mutateAsync: vi.fn() });
  mocks.usePages.mockReset().mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveRoleHome", () => {
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

describe("on the chatters' site", () => {
  beforeEach(() => openOn(CHATTER_SITE_ORIGIN));

  it("signs a person in to ChatGoose, not to a console they never see", () => {
    signedOut();
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain(CHATGOOSE_WORDMARK);
    expect(html).not.toContain("Agency");
    expect(html).toContain("Логин");
  });

  it.each(["owner", "team_lead", "chatter"])("makes the cabinet home for the %s role, whatever page was remembered", (role) => {
    expect(resolveRoleHome(role, "/usage")).toBe("/account");
    expect(resolveRoleHome(role, "/")).toBe("/account");
  });

  it.each(["owner", "team_lead"])("opens the cabinet, not the console, when the %s role is already signed in", (role) => {
    mocks.search = new URLSearchParams({ next: "/usage" });
    mocks.useAuthMe.mockReturnValue({ data: user(role), isLoading: false, isError: false });
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain('data-to="/account"');
    expect(html).not.toContain('data-to="/usage"');
  });

  it("ends an owner's in-app visit to a console route on the cabinet, before the console asks the kernel for anything", () => {
    mocks.useAuthMe.mockReturnValue({ data: user("owner"), isLoading: false, isError: false });
    const html = renderToStaticMarkup(createElement(ProtectedLayout));
    expect(html).toContain('data-to="/account"');
    expect(html).not.toContain("owner-sidebar");
    expect(html).not.toContain("page-outlet");
    expect(mocks.useAuthMe).not.toHaveBeenCalled();
    expect(mocks.usePages).not.toHaveBeenCalled();
  });

  it.each(["owner", "team_lead", "chatter"])("still opens the cabinet itself for the %s role", (role) => {
    mocks.useAuthMe.mockReturnValue({ data: user(role), isLoading: false, isError: false });
    const html = renderToStaticMarkup(createElement(ChatterLayout));
    expect(html).not.toContain("nav-redirect");
    expect(html).toContain("page-outlet");
  });
});

describe("on the console's own name", () => {
  beforeEach(() => openOn(CONSOLE_ORIGIN));

  it("keeps the AgencyHub sign-in", () => {
    signedOut();
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain(AGENCYHUB_WORDMARK);
    expect(html).not.toContain("Goose");
  });

  it("tells a chatter whose name this is instead of opening the cabinet under it", () => {
    const html = renderToStaticMarkup(createElement(ChatterLayout));
    expect(html).toContain("Это консоль владельца");
    expect(html).toContain("grisha");
    expect(html).toContain("Войти под другим логином");
    expect(html).toContain(`href="${CHATTER_SITE_ORIGIN}/account"`);
    expect(html).not.toContain("page-outlet");
  });

  it("still opens the account page there for an owner", () => {
    mocks.useAuthMe.mockReturnValue({ data: user("owner"), isLoading: false, isError: false });
    const html = renderToStaticMarkup(createElement(ChatterLayout));
    expect(html).toContain("page-outlet");
    expect(html).not.toContain("Это консоль владельца");
  });

  it("returns an owner to the page they were sent away from, and leaves them the console", () => {
    mocks.search = new URLSearchParams({ next: "/usage" });
    mocks.useAuthMe.mockReturnValue({ data: user("owner"), isLoading: false, isError: false });
    expect(resolveRoleHome("owner", "/usage")).toBe("/usage");
    expect(renderToStaticMarkup(createElement(LoginPage))).toContain('data-to="/usage"');
    const shell = renderToStaticMarkup(createElement(ProtectedLayout));
    expect(shell).not.toContain("nav-redirect");
    expect(shell).toContain("owner-sidebar");
  });
});
