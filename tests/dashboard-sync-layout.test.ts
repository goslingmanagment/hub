import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

const queryMocks = vi.hoisted(() => ({
  useAdminConnections: vi.fn(),
  useAdminSyncRuns: vi.fn(),
  useAdminSyncRunDetail: vi.fn(),
  useAdminSyncTrigger: vi.fn(),
  useAdminSyncTriggerAll: vi.fn(),
  useAuthMe: vi.fn(),
  useLogout: vi.fn(),
  useOverview: vi.fn(),
  useSyncMonitor: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { Sidebar } from "../apps/dashboard/src/components/layout/Sidebar.tsx";
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

function buildMonitorResponse() {
  return {
    generatedAt: "2026-03-24T12:00:00.000Z",
    window: { hours: 24, startedAt: "2026-03-23T12:00:00.000Z" },
    overall: {
      pages: 1,
      streams: 7,
      runningStreams: 0,
      failedStreams: 0,
      stalledStreams: 0,
      pendingStreams: 0,
      backoffStreams: 0,
      counts: { fans: 0, followers: 34, subscribers: 12, transactions: 100, conversations: 10, messages: 200 },
      recentRuns: { running: 0, success: 1, partial: 0, failed: 0, skipped: 0 },
      recentErrors: { total429s: 0, total5xxs: 0, failedRuns: 0, failedAttempts: 0, retryAttempts: 0, last429At: null, last5xxAt: null },
      providers: [],
      syncUx: buildSyncUx(),
    },
    pages: [{
      pageId: 1,
      pageLabel: "lana",
      platform: "fansly" as const,
      modelSlug: "lana",
      modelName: "Lana",
      username: "lana",
      displayName: "Lana",
      counts: { fans: 0, followers: 34, subscribers: 12, transactions: 100, conversations: 10, messages: 200 },
      summary: { runningStreams: 0, failedStreams: 0, stalledStreams: 0, pendingStreams: 0, backoffStreams: 0, recentErrors: 0 },
      streams: [],
      syncUx: buildSyncUx(),
    }],
    recentEvents: [],
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
    queryMocks.useAdminSyncRunDetail.mockReset();
    queryMocks.useAdminSyncTrigger.mockReset();
    queryMocks.useAdminSyncTriggerAll.mockReset();
    queryMocks.useAuthMe.mockReset();
    queryMocks.useLogout.mockReset();
    queryMocks.useOverview.mockReset();
    queryMocks.useSyncMonitor.mockReset();

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
    queryMocks.useAdminSyncRunDetail.mockReturnValue({
      data: null,
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
    queryMocks.useSyncMonitor.mockReturnValue({
      data: buildMonitorResponse(),
      isLoading: false,
    });
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

  it("does not enable the owner-only connections query for non-owner sidebars", () => {
    renderWithRouter(
      createElement(Sidebar, { user: { username: "lead", role: "team_lead" } }),
      ["/"],
    );

    expect(queryMocks.useAdminConnections).toHaveBeenCalledWith({ enabled: false });
  });

  it("defaults settings to credentials when the tab query is absent", () => {
    const html = renderWithRouter(createElement(SettingsPage), ["/settings"]);

    expect(html).toContain("Update Credentials");
    expect(html).toContain("Credentials may need updating");
    expect(html).not.toContain("Sync All Pages");
  });

  it("supports settings tab deep links for the sync workspace", () => {
    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=sync"]);

    expect(html).toContain("Sync Data");
    expect(html).toContain("Sync diagnostics");
    expect(html).not.toContain("Update Credentials");
  });
});
