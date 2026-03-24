import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

const queryMocks = vi.hoisted(() => ({
  useAdminConnections: vi.fn(),
  useAdminSyncRuns: vi.fn(),
  useAdminSyncTrigger: vi.fn(),
  useAdminSyncTriggerAll: vi.fn(),
  useAuthMe: vi.fn(),
  useLogout: vi.fn(),
  useOverview: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { OwnerRoute } from "../apps/dashboard/src/components/layout/OwnerRoute.tsx";
import { Sidebar } from "../apps/dashboard/src/components/layout/Sidebar.tsx";
import { Topbar } from "../apps/dashboard/src/components/layout/Topbar.tsx";
import { SettingsPage } from "../apps/dashboard/src/pages/SettingsPage.tsx";

function buildSyncUx(
  overrides: Partial<{
    state: "healthy" | "syncing" | "catching_up" | "retrying" | "attention" | "setup" | "off";
    label: string;
    headline: string;
    detail: string | null;
    progressLabel: string | null;
    nextRetryAt: string | null;
    updatedAt: string | null;
    requiresAction: boolean;
  }> = {},
) {
  return {
    state: "healthy" as const,
    label: "Up to date",
    headline: "Up to date",
    detail: "All syncs are current.",
    progressLabel: null,
    nextRetryAt: null,
    updatedAt: "2026-03-24T11:55:00.000Z",
    requiresAction: false,
    ...overrides,
  };
}

function buildOverview() {
  return {
    overall: {
      syncUx: buildSyncUx({
        state: "syncing",
        label: "Syncing",
        headline: "Syncing now",
      }),
    },
    pages: [{
      id: 1,
      label: "lana",
      platform: "fansly" as const,
      modelSlug: "lana",
      modelName: "Lana",
      username: "lana",
      subscriberCount: 12,
      followerCount: 34,
      syncUx: buildSyncUx(),
    }],
  };
}

function buildConnection(overrides: Partial<{
  requiresAction: boolean;
  state: "healthy" | "attention";
}> = {}) {
  const requiresAction = overrides.requiresAction ?? false;
  const state = overrides.state ?? (requiresAction ? "attention" : "healthy");

  return {
    id: 1,
    label: "lana",
    platform: "fansly" as const,
    username: "lana",
    displayName: "Lana",
    subscriberCount: 12,
    followerCount: 34,
    proxyUrl: null,
    proxyHasAuth: false,
    syncUx: buildSyncUx({
      state,
      requiresAction,
      label: requiresAction ? "Reconnect" : "Up to date",
      headline: requiresAction ? "Reconnect to resume sync" : "Up to date",
    }),
  };
}

function renderWithRouter(element: ReturnType<typeof createElement>, initialEntries = ["/"]) {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries },
    element,
  ));
}

describe("dashboard sync layout", () => {
  beforeEach(() => {
    queryMocks.useAdminConnections.mockReset();
    queryMocks.useAdminSyncRuns.mockReset();
    queryMocks.useAdminSyncTrigger.mockReset();
    queryMocks.useAdminSyncTriggerAll.mockReset();
    queryMocks.useAuthMe.mockReset();
    queryMocks.useLogout.mockReset();
    queryMocks.useOverview.mockReset();

    queryMocks.useOverview.mockReturnValue({ data: buildOverview() });
    queryMocks.useLogout.mockReturnValue({ mutateAsync: vi.fn() });
    queryMocks.useAuthMe.mockReturnValue({
      data: { user: { username: "owner", role: "owner" } },
      isLoading: false,
    });
    queryMocks.useAdminConnections.mockReturnValue({
      data: [buildConnection(), buildConnection({ requiresAction: true })],
      isLoading: false,
    });
    queryMocks.useAdminSyncRuns.mockReturnValue({
      data: [],
      isLoading: false,
    });
    queryMocks.useAdminSyncTrigger.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn(),
    });
    queryMocks.useAdminSyncTriggerAll.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn(),
    });
  });

  it("removes topbar sync chrome and uses the diagnostics breadcrumb label", () => {
    const html = renderWithRouter(
      createElement(Topbar, { user: { username: "owner", role: "owner" } }),
      ["/sync"],
    );

    expect(html).toContain("Sync Diagnostics");
    expect(html).not.toContain(">Sync</button>");
    expect(html).not.toContain("Syncing now");
    expect(html).not.toContain("Updated just now");
  });

  it("removes sync diagnostics from the primary sidebar", () => {
    const html = renderWithRouter(
      createElement(Sidebar, { user: { username: "owner", role: "owner" } }),
      ["/"],
    );

    expect(html).not.toContain("Sync Monitor");
    expect(html).not.toContain("href=\"/sync\"");
    expect(html).toContain("Settings");
  });

  it("defaults settings to credentials when the tab query is absent", () => {
    const html = renderWithRouter(createElement(SettingsPage), ["/settings"]);

    expect(html).toContain("Update Credentials");
    expect(html).toContain("Reconnect credentials to keep this page updating.");
    expect(html).not.toContain("Reconnect to resume sync");
    expect(html).not.toContain("Sync All Pages");
  });

  it("supports settings tab deep links for the sync workspace", () => {
    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=sync"]);

    expect(html).toContain("Sync All Pages");
    expect(html).toContain("Open Diagnostics");
    expect(html).toContain("Recent Activity");
    expect(html).not.toContain("Update Credentials");
  });

  it("keeps sync diagnostics owner-only", () => {
    const ownerHtml = renderWithRouter(
      createElement(Routes, undefined,
        createElement(Route, {
          path: "/",
          element: createElement("div", undefined, "Overview"),
        }),
        createElement(Route, {
          path: "/sync",
          element: createElement(OwnerRoute, undefined, createElement("div", undefined, "Sync Diagnostics Page")),
        }),
      ),
      ["/sync"],
    );

    expect(ownerHtml).toContain("Sync Diagnostics Page");

    queryMocks.useAuthMe.mockReturnValue({
      data: { user: { username: "lead", role: "team_lead" } },
      isLoading: false,
    });

    const nonOwnerHtml = renderWithRouter(
      createElement(Routes, undefined,
        createElement(Route, {
          path: "/",
          element: createElement("div", undefined, "Overview"),
        }),
        createElement(Route, {
          path: "/sync",
          element: createElement(OwnerRoute, undefined, createElement("div", undefined, "Sync Diagnostics Page")),
        }),
      ),
      ["/sync"],
    );

    expect(nonOwnerHtml).not.toContain("Sync Diagnostics Page");
  });
});
