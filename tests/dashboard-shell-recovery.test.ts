import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Routes, Route } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

const hooks = vi.hoisted(() => ({ useAuthMe: vi.fn(), useOverview: vi.fn(), useLogout: vi.fn() }));
vi.mock("../apps/dashboard/src/api/queries.ts", () => hooks);
vi.mock("../apps/dashboard/src/lib/queryClient.ts", () => ({ clearDashboardSession: vi.fn() }));
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ KernelApiError: class extends Error {} }));
vi.mock("../apps/dashboard/src/components/layout/Sidebar.tsx", () => ({ Sidebar: () => "Navigation stays available" }));
vi.mock("../apps/dashboard/src/components/layout/Topbar.tsx", () => ({ Topbar: () => "Account stays available" }));
import { ProtectedLayout } from "../apps/dashboard/src/components/layout/ProtectedLayout.tsx";

function render(child: ReactElement = createElement("p", null, "Section content")) {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/pages/demo?period=30d"] },
    createElement(Routes, null, createElement(Route, { element: createElement(ProtectedLayout) },
      createElement(Route, { path: "/pages/:pageLabel", element: child })))));
}

describe("dashboard shell recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hooks.useLogout.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    hooks.useAuthMe.mockReturnValue({ data: { user: { username: "owner", role: "owner" } }, isLoading: false, isError: false, refetch: vi.fn() });
    hooks.useOverview.mockReturnValue({ data: { pages: [] }, isLoading: false, isError: false, refetch: vi.fn() });
  });
  it("offers retry for a transient session read failure without pretending the session expired", () => {
    hooks.useAuthMe.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error("network"), refetch: vi.fn() });
    const html = render();
    expect(html).toContain("Не удалось проверить сессию");
    expect(html).toContain("Повторить");
    expect(html).not.toContain("Section content");
    expect(hooks.useOverview).not.toHaveBeenCalled();
  });
  it("keeps an authenticated cached shell and section available on a failed refresh", () => {
    hooks.useAuthMe.mockReturnValue({ data: { user: { username: "owner", role: "owner" } }, isLoading: false, isError: true, refetch: vi.fn() });
    const html = render();
    expect(html).toContain("Navigation stays available");
    expect(html).toContain("Section content");
    expect(html).toContain("Повторить");
  });
  it.each(["chatter", "content_manager", "unknown"])("keeps %s out of the dashboard without starting its queries", role => {
    hooks.useAuthMe.mockReturnValue({ data: { user: { username: "Test account", role } }, isLoading: false, isError: false, refetch: vi.fn() });
    const html = render();
    expect(html).toContain("Нет доступа к панели");
    expect(html).toContain("Test account");
    expect(html).toContain("Выйти и сменить аккаунт");
    expect(html).toContain("Проверить доступ");
    expect(html).not.toContain("Section content");
    expect(hooks.useOverview).not.toHaveBeenCalled();
  });
  it("allows a team lead to enter the existing scoped dashboard", () => {
    hooks.useAuthMe.mockReturnValue({ data: { user: { username: "Lead", role: "team_lead" } }, isLoading: false, isError: false, refetch: vi.fn() });
    expect(render()).toContain("Section content");
    expect(hooks.useOverview).toHaveBeenCalledTimes(1);
  });
  it("waits for authentication before requesting the dashboard catalog", () => {
    hooks.useAuthMe.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() });
    expect(render()).toContain("Проверяем сессию");
    expect(hooks.useOverview).not.toHaveBeenCalled();
  });
  it("contains a suspended route inside the shell", () => {
    function Pending(): never { throw new Promise(() => {}); }
    const html = render(createElement(Pending));
    expect(html).toContain("Navigation stays available");
    expect(html).toContain("Account stays available");
    expect(html).toContain("Открываем раздел");
  });
});
