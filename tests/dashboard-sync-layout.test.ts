import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OverviewResponse, SyncBlockStatus } from "@agency_hub_core/contracts";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { DashboardShellProvider } from "../apps/dashboard/src/components/layout/DashboardShellContext.tsx";

const queryMocks = vi.hoisted(() => ({
  useAdminConnections: vi.fn(),
  useAdminModels: vi.fn(),
  useAdminPages: vi.fn(),
  useAdminReorderModels: vi.fn(),
  useAdminSyncBlockPause: vi.fn(),
  useAdminSyncBlockReset: vi.fn(),
  useAdminSyncBlockResume: vi.fn(),
  useAdminSyncBlockTrigger: vi.fn(),
  useAdminSyncRunDetail: vi.fn(),
  useAdminVerifyPage: vi.fn(),
  useAuthMe: vi.fn(),
  useLogout: vi.fn(),
  useOverview: vi.fn(),
  usePageSyncBlocks: vi.fn(),
  useSyncOverview: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { Sidebar } from "../apps/dashboard/src/components/layout/Sidebar.tsx";
import { Topbar } from "../apps/dashboard/src/components/layout/Topbar.tsx";
import { SettingsPage } from "../apps/dashboard/src/pages/SettingsPage.tsx";
import {
  getSyncBlockActionPresentation,
} from "../apps/dashboard/src/pages/settings/sync/SyncBlockActions.tsx";

type DashboardShellValue = ComponentProps<typeof DashboardShellProvider>["value"];
type DashboardPage = OverviewResponse["pages"][number];

function buildPageMetric(value: number | null) {
  return {
    value,
    available: value !== null,
  };
}

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

function buildOverviewPage(overrides: Partial<DashboardPage> = {}): DashboardPage {
  return {
    id: 1,
    label: "lana",
    platform: "fansly",
    modelSlug: "lana",
    modelName: "Lana",
    username: "lana",
    subscriberCount: buildPageMetric(12),
    followerCount: buildPageMetric(34),
    revenueTodayMills: 0,
    revenue7dMills: 0,
    revenue30dMills: 0,
    newSubscribersToday: 0,
    newFollowersToday: 0,
    connectionStatus: "active",
    lastLightSyncAt: null,
    lastFollowerSyncAt: null,
    lastSyncError: null,
    syncUx: buildSyncUx(),
    ...overrides,
  };
}

function buildOverview(): OverviewResponse {
  return {
    counts: {
      models: 1,
      pages: 1,
      fans: 0,
    },
    revenue: {
      "7d": {
        revenueMills: 0,
        adjustmentMills: 0,
        unclassifiedMills: 0,
        netEarningsMills: 0,
        previousNetEarningsMills: 0,
        deltaPct: null,
      },
      "30d": {
        revenueMills: 0,
        adjustmentMills: 0,
        unclassifiedMills: 0,
        netEarningsMills: 0,
        previousNetEarningsMills: 0,
        deltaPct: null,
      },
    },
    overall: {
      syncUx: buildSyncUx({
        state: "syncing",
        label: "Syncing",
        headline: "Syncing now",
      }),
    },
    pages: [buildOverviewPage()],
    setup: {
      hasPages: true,
      hasFanslyPages: true,
      hasOnlyFansPages: false,
    },
  };
}

function buildSyncBlock(
  block: "connection" | "financials" | "audience" | "messages_live" | "messages_history",
  overrides: Partial<{
    connectionStatus: "connected" | "not_connected" | "error" | null;
    metrics: Record<string, unknown>;
    state: "not_started" | "scheduled" | "backfilling" | "up_to_date" | "syncing" | "retrying" | "delayed" | "failed" | "paused" | "not_available";
    progress: {
      label: string;
      current: number;
      total: number | null;
      unit: string;
      percent: number | null;
      details: Record<string, unknown>;
    } | null;
    progressStream: string | null;
    progressRole: "primary" | "supporting" | null;
    statusReason: {
      code: string | null;
      summary: string | null;
      waitingFor: string[] | null;
    } | null;
    primaryFresh: boolean;
    needsAttention: boolean;
  }> = {},
) {
  return {
    block,
    state: "up_to_date" as const,
    succeededAt: "2026-03-24T11:55:00.000Z",
    progress: null,
    progressStream: null,
    progressRole: null,
    error: null,
    statusReason: null,
    primaryFresh: true,
    needsAttention: false,
    nextDueAt: null,
    nextRetryAt: null,
    intervals: [],
    metrics: {},
    connectionStatus: null,
    substreams: [],
    ...overrides,
  };
}

function buildSyncOverview(): {
  generatedAt: string;
  diagnosis: ReturnType<typeof buildSyncDiagnosis> | null;
  pages: Array<{
    pageId: number;
    pageLabel: string;
    platform: "fansly";
    modelSlug: string;
    modelName: string;
    username: string;
    displayName: string;
    diagnosis: ReturnType<typeof buildSyncDiagnosis> | null;
    blocks: {
      connection: ReturnType<typeof buildSyncBlock>;
      financials: ReturnType<typeof buildSyncBlock>;
      audience: ReturnType<typeof buildSyncBlock>;
      messages_live: ReturnType<typeof buildSyncBlock>;
      messages_history: ReturnType<typeof buildSyncBlock>;
    };
  }>;
} {
  return {
    generatedAt: "2026-03-24T12:00:00.000Z",
    diagnosis: null,
    pages: [{
      pageId: 1,
      pageLabel: "lana",
      platform: "fansly" as const,
      modelSlug: "lana",
      modelName: "Lana",
      username: "lana",
      displayName: "Lana",
      diagnosis: null,
      blocks: {
        connection: buildSyncBlock("connection", {
          connectionStatus: "connected",
        }),
        financials: buildSyncBlock("financials", {
          metrics: { transactionCount: 12 },
        }),
        audience: buildSyncBlock("audience", {
          metrics: { followerCount: 34 },
        }),
        messages_live: buildSyncBlock("messages_live", {
          metrics: { visibleConversationCount: 3 },
        }),
        messages_history: buildSyncBlock("messages_history", {
          metrics: { readyConversationCount: 3, eligibleConversationCount: 4 },
        }),
      },
    }],
  };
}

function buildSyncDiagnosis(
  overrides: Partial<{
    code: "worker_offline" | "stalled_run" | "auth_blocked";
    severity: "warning" | "error";
    headline: string;
    detail: string;
    actionKind: "worker" | "credentials" | "sync_settings" | null;
  }> = {},
) {
  return {
    code: "worker_offline" as const,
    severity: "error" as const,
    headline: "No sync worker is processing jobs",
    detail: "Sync work is queued, but planner or execute jobs are not being claimed. Start or restart the worker service.",
    actionKind: "worker" as const,
    ...overrides,
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
    subscriberCount: buildPageMetric(12),
    followerCount: buildPageMetric(34),
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
  const pages = buildOverview().pages;
  const shellValue: DashboardShellValue = {
    pageCatalogState: "ready" as const,
    pageCatalogError: null,
    pages,
    findPageByLabel: (pageLabel: string | undefined) =>
      pages.find((page) => page.label === pageLabel) ?? null,
  };

  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries },
    createElement(
      DashboardShellProvider,
      { value: shellValue, children: element },
    ),
  ));
}

describe("dashboard sync layout", () => {
  beforeEach(() => {
    queryMocks.useAdminConnections.mockReset();
    queryMocks.useAdminModels.mockReset();
    queryMocks.useAdminPages.mockReset();
    queryMocks.useAdminReorderModels.mockReset();
    queryMocks.useAdminSyncBlockPause.mockReset();
    queryMocks.useAdminSyncBlockReset.mockReset();
    queryMocks.useAdminSyncBlockResume.mockReset();
    queryMocks.useAdminSyncBlockTrigger.mockReset();
    queryMocks.useAdminSyncRunDetail.mockReset();
    queryMocks.useAdminVerifyPage.mockReset();
    queryMocks.useAuthMe.mockReset();
    queryMocks.useLogout.mockReset();
    queryMocks.useOverview.mockReset();
    queryMocks.usePageSyncBlocks.mockReset();
    queryMocks.useSyncOverview.mockReset();

    queryMocks.useOverview.mockReturnValue({ data: buildOverview() });
    queryMocks.useSyncOverview.mockReturnValue({
      data: buildSyncOverview(),
      isLoading: false,
    });
    queryMocks.usePageSyncBlocks.mockReturnValue({
      data: {
        generatedAt: "2026-03-24T12:00:00.000Z",
        page: buildSyncOverview().pages[0],
      },
      isLoading: false,
    });
    queryMocks.useLogout.mockReturnValue({ mutateAsync: vi.fn() });
    queryMocks.useAuthMe.mockReturnValue({
      data: { user: { username: "owner", role: "owner" } },
      isLoading: false,
    });
    queryMocks.useAdminConnections.mockReturnValue({
      data: [buildConnection(), buildConnection({ requiresAction: true })],
      isLoading: false,
    });
    queryMocks.useAdminModels.mockReturnValue({
      data: [{ id: 1, slug: "lana", name: "Lana", pageCount: 1, sortOrder: 10 }],
      isLoading: false,
    });
    queryMocks.useAdminReorderModels.mockReturnValue({ mutate: vi.fn(), isPending: false });
    queryMocks.useAdminPages.mockReturnValue({
      data: [],
      isLoading: false,
    });
    queryMocks.useAdminSyncRunDetail.mockReturnValue({
      data: null,
      isLoading: false,
    });
    queryMocks.useAdminSyncBlockTrigger.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn(),
    });
    queryMocks.useAdminSyncBlockPause.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn(),
    });
    queryMocks.useAdminSyncBlockResume.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn(),
    });
    queryMocks.useAdminSyncBlockReset.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn(),
    });
    queryMocks.useAdminVerifyPage.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn(),
    });
  });

  it("removes sync diagnostics from the primary sidebar", () => {
    const html = renderWithRouter(
      createElement(Sidebar, { user: { username: "owner", role: "owner" } }),
      ["/"],
    );

    expect(html).not.toContain("Sync Monitor");
    expect(html).not.toContain("href=\"/sync\"");
    expect(html).toContain("Usage");
    expect(html).toContain("href=\"/usage\"");
    expect(html).toContain("Settings");
  });

  it("does not enable the owner-only connections query for non-owner sidebars", () => {
    const html = renderWithRouter(
      createElement(Sidebar, { user: { username: "lead", role: "team_lead" } }),
      ["/"],
    );

    expect(queryMocks.useAdminConnections).toHaveBeenCalledWith({ enabled: false });
    expect(html).not.toContain("href=\"/usage\"");
  });

  it("defaults settings to credentials when the tab query is absent", () => {
    const html = renderWithRouter(createElement(SettingsPage), ["/settings"]);

    expect(html).toContain("Update Credentials");
    expect(html).toContain("Credentials may need updating");
    expect(html).not.toContain("Sync All Pages");
  });

  it("shows credentials catalog load errors", () => {
    queryMocks.useAdminConnections.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("Connections API unavailable"),
    });

    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=credentials"]);

    expect(html).toContain("Connections failed to load");
    expect(html).toContain("Connections API unavailable");
    expect(html).not.toContain("No connections configured");
  });

  it("shows models catalog load errors", () => {
    queryMocks.useAdminModels.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("Models API unavailable"),
    });

    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=models"]);

    expect(html).toContain("Models failed to load");
    expect(html).toContain("Models API unavailable");
    expect(html).not.toContain("No models configured");
  });

  it("shows a stale-data warning when models refresh fails with cached data", () => {
    queryMocks.useAdminModels.mockReturnValue({
      data: [{ id: 1, slug: "lana", name: "Lana", pageCount: 1 }],
      isLoading: false,
      isError: true,
      error: new Error("Models API timeout"),
    });

    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=models"]);

    expect(html).toContain("role=\"status\"");
    expect(html).toContain("aria-live=\"polite\"");
    expect(html).toContain("Showing cached data");
    expect(html).toContain("Models API timeout");
    expect(html).toContain("Lana");
    expect(html).not.toContain("Models failed to load");
  });

  it("shows pages catalog load errors", () => {
    queryMocks.useAdminPages.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("Pages API unavailable"),
    });

    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=pages"]);

    expect(html).toContain("Pages failed to load");
    expect(html).toContain("Pages API unavailable");
    expect(html).not.toContain("No pages configured");
  });

  it("keeps the pages table visible when models fail to load", () => {
    queryMocks.useAdminPages.mockReturnValue({
      data: [{
        id: 1,
        label: "lana",
        platform: "fansly",
        modelSlug: "lana",
        modelName: "Lana",
        username: "lana",
        displayName: "Lana",
        connectionStatus: "active",
        lastLightSyncAt: null,
        lastFollowerSyncAt: null,
        lastSyncError: null,
        subscriberCount: buildPageMetric(12),
        followerCount: buildPageMetric(34),
        proxyUrl: null,
        proxyHasAuth: false,
        syncUx: buildSyncUx(),
      }],
      isLoading: false,
    });
    queryMocks.useAdminModels.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("Models API unavailable"),
    });

    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=pages"]);

    expect(html).toContain("Models API unavailable");
    expect(html).toContain("lana");
    expect(html).not.toContain("Models failed to load");
  });

  it("keeps the pages table visible when connections fail to load", () => {
    queryMocks.useAdminPages.mockReturnValue({
      data: [{
        id: 1,
        label: "lana",
        platform: "fansly",
        modelSlug: "lana",
        modelName: "Lana",
        username: "lana",
        displayName: "Lana",
        connectionStatus: "active",
        lastLightSyncAt: null,
        lastFollowerSyncAt: null,
        lastSyncError: null,
        subscriberCount: buildPageMetric(12),
        followerCount: buildPageMetric(34),
        proxyUrl: null,
        proxyHasAuth: false,
        syncUx: buildSyncUx(),
      }],
      isLoading: false,
    });
    queryMocks.useAdminConnections.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("Connections API unavailable"),
    });

    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=pages"]);

    expect(html).toContain("Connections API unavailable");
    expect(html).toContain("lana");
    expect(html).not.toContain("Connections failed to load");
  });

  it("uses loading copy for pending page dependencies", () => {
    queryMocks.useAdminPages.mockReturnValue({
      data: [{
        id: 1,
        label: "lana",
        platform: "fansly",
        modelSlug: "lana",
        modelName: "Lana",
        username: "lana",
        displayName: "Lana",
        connectionStatus: "active",
        lastLightSyncAt: null,
        lastFollowerSyncAt: null,
        lastSyncError: null,
        subscriberCount: buildPageMetric(12),
        followerCount: buildPageMetric(34),
        proxyUrl: null,
        proxyHasAuth: false,
        syncUx: buildSyncUx(),
      }],
      isLoading: false,
    });
    queryMocks.useAdminModels.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });

    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=pages"]);

    expect(html).toContain("Loading models catalog");
    expect(html).toContain("lana");
    expect(html).not.toContain("Models catalog is unavailable");
  });

  it("supports settings tab deep links for the sync workspace", () => {
    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=sync"]);

    expect(html).toContain("Financials");
    expect(html).toContain("View details");
    expect(html).not.toContain("Update Credentials");
  });

  it("offers recovery for an actionable paused OnlyFans substream hidden by a healthy block", () => {
    const block: SyncBlockStatus = {
      ...buildSyncBlock("financials"),
      substreams: [
        {
          stream: "transactions",
          role: "primary",
          state: "paused",
          succeededAt: null,
          nextDueAt: null,
          nextRetryAt: null,
          cadenceSeconds: 3600,
          isFresh: false,
          needsAttention: false,
          statusReason: null,
          error: null,
        },
        {
          stream: "fan_identities",
          role: "supporting",
          state: "up_to_date",
          succeededAt: "2026-03-24T11:55:00.000Z",
          nextDueAt: null,
          nextRetryAt: null,
          cadenceSeconds: 3600,
          isFresh: true,
          needsAttention: false,
          statusReason: null,
          error: null,
        },
        {
          stream: "top_spenders",
          role: "supporting",
          state: "paused",
          succeededAt: null,
          nextDueAt: null,
          nextRetryAt: null,
          cadenceSeconds: 86400,
          isFresh: false,
          needsAttention: false,
          statusReason: null,
          error: null,
        },
      ],
    };

    expect(getSyncBlockActionPresentation(block, "onlyfans")).toEqual({
      showTrigger: false,
      showPause: false,
      showResume: true,
      showReset: true,
      resumeLabel: "Resume top spenders",
    });

    expect(getSyncBlockActionPresentation({
      ...block,
      substreams: block.substreams.filter((substream) => substream.stream === "transactions"),
    }, "onlyfans")).toMatchObject({
      showResume: false,
    });
  });

  it("shows an explicit sync overview load error", () => {
    queryMocks.useSyncOverview.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("Sync API unavailable"),
    });

    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=sync"]);

    expect(html).toContain("Sync status failed to load");
    expect(html).toContain("Sync API unavailable");
    expect(html).not.toContain("No pages configured");
  });

  it("shows a stale-data warning when sync overview refresh fails with cached data", () => {
    queryMocks.useSyncOverview.mockReturnValue({
      data: buildSyncOverview(),
      isLoading: false,
      isError: true,
      error: new Error("Sync overview timeout"),
    });

    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=sync"]);

    expect(html).toContain("Showing cached data");
    expect(html).toContain("Sync overview timeout");
    expect(html).toContain("Financials");
    expect(html).not.toContain("Sync status failed to load");
  });

  it("shows stale sync overview warnings for cached empty page lists", () => {
    queryMocks.useSyncOverview.mockReturnValue({
      data: {
        generatedAt: "2026-03-24T12:00:00.000Z",
        diagnosis: null,
        pages: [],
      },
      isLoading: false,
      isError: true,
      error: new Error("Sync overview timeout"),
    });

    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=sync"]);

    expect(html).toContain("Showing cached data");
    expect(html).toContain("Sync overview timeout");
    expect(html).toContain("No pages configured");
    expect(html).not.toContain("Sync status failed to load");
  });

  it("shows an explicit sync detail load error instead of page not found", () => {
    queryMocks.usePageSyncBlocks.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("Details API unavailable"),
    });

    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=sync&page=lana"]);

    expect(html).toContain("Sync page failed to load");
    expect(html).toContain("Details API unavailable");
    expect(html).not.toContain("Page not found");
  });

  it("shows overall and page-level worker diagnostics on the sync overview", () => {
    const overview = buildSyncOverview();
    overview.diagnosis = buildSyncDiagnosis();
    overview.pages[0]!.diagnosis = buildSyncDiagnosis();
    queryMocks.useSyncOverview.mockReturnValue({
      data: overview,
      isLoading: false,
    });

    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=sync"]);

    expect(html).toContain("No sync worker is processing jobs");
    expect(html).toContain("Start or restart the worker service.");
  });

  it("shows page-level diagnosis in sync detail", () => {
    const overview = buildSyncOverview();
    overview.pages[0]!.diagnosis = buildSyncDiagnosis({
      code: "stalled_run",
      headline: "Sync needs attention",
      detail: "Subscribers stopped making progress and need the worker to recover.",
      actionKind: "sync_settings",
    });
    queryMocks.usePageSyncBlocks.mockReturnValue({
      data: {
        generatedAt: "2026-03-24T12:00:00.000Z",
        page: overview.pages[0],
      },
      isLoading: false,
    });

    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=sync&page=lana"]);

    expect(html).toContain("Sync needs attention");
    expect(html).toContain("Subscribers stopped making progress and need the worker to recover.");
  });

  it("uses delayed copy instead of failed wording on sync overview cards", () => {
    const overview = buildSyncOverview();
    overview.pages[0]!.blocks.messages_history = {
      ...overview.pages[0]!.blocks.messages_history,
      state: "delayed",
      statusReason: null,
      primaryFresh: false,
      needsAttention: true,
    };
    queryMocks.useSyncOverview.mockReturnValue({
      data: overview,
      isLoading: false,
    });

    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=sync"]);

    expect((html.match(/Sync is delayed/g) ?? [])).toHaveLength(2);
    expect(html).not.toContain("messages_history needs attention");
  });

  it("fills delayed sync detail notices when the backend has no explicit summary", () => {
    const overview = buildSyncOverview();
    overview.pages[0]!.blocks.messages_history = {
      ...overview.pages[0]!.blocks.messages_history,
      state: "delayed",
      statusReason: null,
      primaryFresh: false,
      needsAttention: true,
    };
    queryMocks.usePageSyncBlocks.mockReturnValue({
      data: {
        generatedAt: "2026-03-24T12:00:00.000Z",
        page: overview.pages[0],
      },
      isLoading: false,
    });

    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=sync&page=lana"]);

    expect((html.match(/Sync is delayed/g) ?? [])).toHaveLength(2);
  });

  it("renders catch-up progress for delayed message history detail", () => {
    const overview = buildSyncOverview();
    overview.pages[0]!.blocks.messages_history = {
      ...overview.pages[0]!.blocks.messages_history,
      state: "delayed",
      statusReason: {
        code: "history_incomplete",
        summary: "Conversation history is still catching up.",
        waitingFor: null,
      },
      primaryFresh: false,
      needsAttention: true,
      progress: {
        label: "203 / 3,669 conversations ready, 4 lagging",
        current: 203,
        total: 3669,
        unit: "conversations",
        percent: 5.53,
        details: {
          laggingConversationCount: 4,
        },
      },
      progressStream: "dm_messages",
      progressRole: "primary",
      metrics: {
        readyConversationCount: 203,
        eligibleConversationCount: 3669,
        laggingConversationCount: 4,
      },
    };
    queryMocks.usePageSyncBlocks.mockReturnValue({
      data: {
        generatedAt: "2026-03-24T12:00:00.000Z",
        page: overview.pages[0],
      },
      isLoading: false,
    });

    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=sync&page=lana"]);

    expect(html).toContain("203 / 3,669 ready");
    expect(html).toContain("3,466 left");
    expect(html).toContain("4 lagging");
  });

  it("renders fresh queue waits as healthy while message history backfill is running", () => {
    const overview = buildSyncOverview();
    overview.pages[0]!.blocks.financials = {
      ...overview.pages[0]!.blocks.financials,
      state: "scheduled",
      primaryFresh: true,
      statusReason: {
        code: "queue_waiting",
        summary: "Queued - will start after current sync completes.",
        waitingFor: ["dm_messages"],
      },
      progress: {
        label: "15 / 15 months",
        current: 15,
        total: 15,
        unit: "months",
        percent: 100,
        details: {},
      },
      progressStream: "top_spenders",
      progressRole: "supporting",
    };
    overview.pages[0]!.blocks.audience = {
      ...overview.pages[0]!.blocks.audience,
      state: "scheduled",
      primaryFresh: true,
      statusReason: {
        code: "queue_waiting",
        summary: "Queued - will start after current sync completes.",
        waitingFor: ["dm_messages"],
      },
    };
    overview.pages[0]!.blocks.messages_live = {
      ...overview.pages[0]!.blocks.messages_live,
      state: "scheduled",
      primaryFresh: true,
      statusReason: {
        code: "queue_waiting",
        summary: "Queued - will start after current sync completes.",
        waitingFor: ["dm_messages"],
      },
    };
    overview.pages[0]!.blocks.messages_history = {
      ...overview.pages[0]!.blocks.messages_history,
      state: "backfilling",
      primaryFresh: false,
      progress: {
        label: "203 / 3,669 conversations",
        current: 203,
        total: 3669,
        unit: "conversations",
        percent: 5.53,
        details: {},
      },
      progressStream: "dm_messages",
      progressRole: "primary",
    };
    queryMocks.useSyncOverview.mockReturnValue({
      data: overview,
      isLoading: false,
    });

    const html = renderWithRouter(createElement(SettingsPage), ["/settings?tab=sync"]);

    expect(html).toContain("Up to date · waiting for message history to finish");
    expect(html).not.toContain("Queued — message history is running");
    expect(html).toContain("Backfilling… 203/3,669 conversations");
  });

  it("shows sync-status breadcrumbs under the dev workspace", () => {
    const html = renderWithRouter(
      createElement(Topbar, { user: { username: "owner", role: "owner" } }),
      ["/dev/sync-status?runId=42"],
    );

    expect(html).toContain(">Dev<");
    expect(html).toContain(">Sync Status<");
  });

  it("shows usage breadcrumbs in the owner workspace", () => {
    const html = renderWithRouter(
      createElement(Topbar, { user: { username: "owner", role: "owner" } }),
      ["/usage"],
    );

    expect(html).toContain(">Usage<");
    expect(html).toContain("href=\"/\"");
  });
});
