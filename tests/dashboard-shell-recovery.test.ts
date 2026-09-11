import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Routes, Route } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

const hooks = vi.hoisted(() => ({ useAuthMe: vi.fn(), useOverview: vi.fn() }));
vi.mock("../apps/dashboard/src/api/queries.ts", () => hooks);
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
    hooks.useAuthMe.mockReturnValue({ data: { user: { username: "owner", role: "owner" } }, isLoading: false, isError: false, refetch: vi.fn() });
    hooks.useOverview.mockReturnValue({ data: { pages: [] }, isLoading: false, isError: false, refetch: vi.fn() });
  });
  it("offers retry for a transient session read failure without pretending the session expired", () => {
    hooks.useAuthMe.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error("network"), refetch: vi.fn() });
    const html = render();
    expect(html).toContain("Не удалось проверить сессию");
    expect(html).toContain("Повторить");
    expect(html).not.toContain("Section content");
  });
  it("keeps an authenticated cached shell and section available on a failed refresh", () => {
    hooks.useAuthMe.mockReturnValue({ data: { user: { username: "owner", role: "owner" } }, isLoading: false, isError: true, refetch: vi.fn() });
    const html = render();
    expect(html).toContain("Navigation stays available");
    expect(html).toContain("Section content");
    expect(html).toContain("Повторить");
  });
  it("contains a suspended route inside the shell", () => {
    function Pending(): never { throw new Promise(() => {}); }
    const html = render(createElement(Pending));
    expect(html).toContain("Navigation stays available");
    expect(html).toContain("Account stays available");
    expect(html).toContain("Открываем раздел");
  });
});
