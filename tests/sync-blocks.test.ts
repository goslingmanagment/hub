import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  deleteCheckpoints: vi.fn(),
  deletePageTopSpenders: vi.fn(),
  ensureSyncTaskRows: vi.fn(),
  findPageByLabel: vi.fn(),
  pauseSyncTasks: vi.fn(),
  requestSyncTaskGenerations: vi.fn(),
  resetPageDmSyncState: vi.fn(),
  resetSyncTasks: vi.fn(),
  resumeSyncTasks: vi.fn(),
}));

const syncStatusMocks = vi.hoisted(() => ({
  getSyncStatusSnapshot: vi.fn(),
}));

const queueMocks = vi.hoisted(() => ({
  sendSyncPageWakeup: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof import("@agency_hub_core/db")>("@agency_hub_core/db");
  return {
    ...actual,
    ...dbMocks,
  };
});

vi.mock("../apps/runtime/src/services/sync-status.ts", () => ({
  getSyncStatusSnapshot: syncStatusMocks.getSyncStatusSnapshot,
  SYNC_DOMAIN_BLOCKS: [
    "connection",
    "financials",
    "audience",
    "messages_live",
    "messages_history",
  ],
}));

vi.mock("../apps/runtime/src/services/sync-queue.ts", () => ({
  sendSyncPageWakeup: queueMocks.sendSyncPageWakeup,
}));

import { resolveSyncTaskPriority } from "@agency_hub_core/db";

import {
  getPageMessagesSyncBlock,
  getSyncBlocksOverview,
  pauseSyncBlock,
  resetSyncBlock,
  resumeSyncBlock,
  triggerSyncBlock,
} from "../apps/runtime/src/services/sync-blocks.ts";

function buildBlock(overrides: Record<string, unknown> = {}) {
  return {
    block: "connection",
    state: "up_to_date",
    lastSuccessAt: "2026-03-24T11:00:00.000Z",
    progress: null,
    progressStream: null,
    progressRole: null,
    error: null,
    statusReason: null,
    primaryFresh: true,
    needsAttention: false,
    nextDueAt: "2026-03-24T13:00:00.000Z",
    nextRetryAt: null,
    intervals: [{ stream: "light", cadenceSeconds: 3600 }],
    metrics: {},
    connectionStatus: "connected",
    substreams: [{
      stream: "light",
      role: "primary",
      state: "up_to_date",
      lastSuccessAt: "2026-03-24T11:00:00.000Z",
      nextDueAt: "2026-03-24T13:00:00.000Z",
      nextRetryAt: null,
      cadenceSeconds: 3600,
      isFresh: true,
      needsAttention: false,
      statusReason: null,
      error: null,
    }],
    tasks: [],
    ...overrides,
  };
}

function buildSnapshotPage(overrides: Record<string, unknown> = {}) {
  return {
    pageId: 7,
    pageLabel: "lana",
    platform: "fansly",
    modelSlug: "lana",
    modelName: "Lana",
    username: "lana_page",
    displayName: "Lana",
    blocks: {
      connection: buildBlock({
        block: "connection",
        state: "failed",
        connectionStatus: "error",
        needsAttention: true,
        statusReason: {
          code: "credentials_invalid",
          summary: "Refresh credentials",
          waitingFor: null,
        },
        error: {
          stream: "light",
          code: "credentials_invalid",
          summary: "Refresh credentials",
          lastFailedAt: "2026-03-24T11:45:00.000Z",
          consecutiveFailures: 1,
        },
      }),
      financials: buildBlock({
        block: "financials",
        progress: {
          label: "1 / 4 months",
          current: 1,
          total: 4,
          unit: "months",
          percent: 25,
          percentValid: true,
          details: {},
        },
        metrics: {
          transactionCount: 12,
        },
      }),
      audience: buildBlock({
        block: "audience",
        state: "failed",
        needsAttention: true,
        statusReason: {
          code: "http_500",
          summary: "Followers sync failed",
          waitingFor: null,
        },
        error: {
          stream: "followers",
          code: "http_500",
          summary: "Followers sync failed",
          lastFailedAt: "2026-03-24T11:30:00.000Z",
          consecutiveFailures: 3,
        },
      }),
      messages_live: buildBlock({
        block: "messages_live",
        metrics: {
          visibleConversationCount: 3,
        },
        intervals: [{ stream: "dm_conversations", cadenceSeconds: 1800 }],
        substreams: [{
          stream: "dm_conversations",
          state: "up_to_date",
          lastSuccessAt: "2026-03-24T10:50:00.000Z",
          nextDueAt: "2026-03-24T12:30:00.000Z",
          nextRetryAt: null,
          cadenceSeconds: 1800,
          needsAttention: false,
          error: null,
        }],
      }),
      messages_history: buildBlock({
        block: "messages_history",
        metrics: {
          messageCount: 25,
          eligibleConversationCount: 3,
          readyConversationCount: 2,
        },
        intervals: [{ stream: "dm_messages", cadenceSeconds: 86400 }],
        substreams: [{
          stream: "dm_messages",
          state: "up_to_date",
          lastSuccessAt: "2026-03-24T10:40:00.000Z",
          nextDueAt: "2026-03-25T10:40:00.000Z",
          nextRetryAt: null,
          cadenceSeconds: 86400,
          needsAttention: false,
          error: null,
        }],
      }),
    },
    syncUx: {
      state: "attention",
      label: "Needs attention",
      headline: "Sync needs attention",
      detail: "Audience sync is blocked.",
      progressLabel: null,
      nextRetryAt: null,
      updatedAt: "2026-03-24T11:30:00.000Z",
      requiresAction: false,
    },
    ...overrides,
  };
}

describe("sync blocks service", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("maps the canonical snapshot into the dashboard block overview", async () => {
    syncStatusMocks.getSyncStatusSnapshot.mockResolvedValue({
      generatedAt: "2026-03-24T12:00:00.000Z",
      pages: [
        buildSnapshotPage(),
        buildSnapshotPage({
          pageId: 8,
          pageLabel: "of-lana",
          platform: "onlyfans",
          username: "of_lana",
          displayName: "OF Lana",
          blocks: {
            connection: buildBlock({ block: "connection", connectionStatus: "not_connected" }),
            financials: buildBlock({ block: "financials" }),
            audience: buildBlock({ block: "audience", state: "not_available", connectionStatus: null, substreams: [], intervals: [] }),
            messages_live: buildBlock({ block: "messages_live", state: "not_available", connectionStatus: null, substreams: [], intervals: [] }),
            messages_history: buildBlock({ block: "messages_history", state: "not_available", connectionStatus: null, substreams: [], intervals: [] }),
          },
        }),
      ],
    });

    const overview = await getSyncBlocksOverview({} as never, {
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(overview.generatedAt).toBe("2026-03-24T12:00:00.000Z");
    expect(overview.pages).toHaveLength(2);
    expect(overview.pages[0]?.blocks.financials.progress).toMatchObject({
      current: 1,
      total: 4,
      unit: "months",
    });
    expect(overview.pages[0]?.blocks.audience).toMatchObject({
      state: "failed",
      needsAttention: true,
      error: expect.objectContaining({
        code: "http_500",
      }),
    });
    expect(overview.pages[1]?.blocks.messages_live.state).toBe("not_available");
    expect(overview.pages[1]?.blocks.messages_history.state).toBe("not_available");
    expect(overview.diagnosis).toMatchObject({
      code: "auth_failed",
      severity: "error",
    });
  });

  it("returns the message-history block for the legacy messages endpoint", async () => {
    syncStatusMocks.getSyncStatusSnapshot.mockResolvedValue({
      generatedAt: "2026-03-24T12:00:00.000Z",
      pages: [buildSnapshotPage()],
    });

    const response = await getPageMessagesSyncBlock({} as never, {
      pageLabel: "lana",
    });

    expect(response.page.pageLabel).toBe("lana");
    expect(response.block.block).toBe("messages_history");
    expect(response.block.intervals).toEqual([
      { stream: "dm_messages", cadenceSeconds: 86400 },
    ]);
  });

  it("triggers the financials domain through the v2 task request path", async () => {
    dbMocks.findPageByLabel.mockResolvedValue({
      page: {
        id: 7,
        label: "lana",
        platform: "fansly",
      },
      proxy: null,
    });
    dbMocks.ensureSyncTaskRows.mockResolvedValue(undefined);
    dbMocks.requestSyncTaskGenerations.mockResolvedValue([
      { task: "transactions", desiredGeneration: 5 },
      { task: "top_spenders", desiredGeneration: 5 },
    ]);
    queueMocks.sendSyncPageWakeup.mockResolvedValue("job-1");

    const response = await triggerSyncBlock({ db: {} } as never, {
      send: vi.fn(),
    } as never, {
      pageLabel: "lana",
      block: "financials",
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(response).toMatchObject({
      accepted: true,
      action: "trigger",
      pageLabel: "lana",
      block: "financials",
      revisions: [
        { stream: "transactions", desiredRevision: 5 },
        { stream: "top_spenders", desiredRevision: 5 },
      ],
    });
    expect(dbMocks.requestSyncTaskGenerations).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: 7,
      tasks: ["transactions", "top_spenders"],
      source: "manual",
    }));
    expect(queueMocks.sendSyncPageWakeup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: 7,
      provider: "fansly",
      priority: resolveSyncTaskPriority("transactions", "manual"),
    }));
  });

  it("pauses the audience domain including follower reconcile support work", async () => {
    dbMocks.findPageByLabel.mockResolvedValue({
      page: {
        id: 7,
        label: "lana",
        platform: "fansly",
      },
      proxy: null,
    });
    dbMocks.ensureSyncTaskRows.mockResolvedValue(undefined);
    dbMocks.pauseSyncTasks.mockResolvedValue(undefined);

    await pauseSyncBlock({ db: {} } as never, {
      pageLabel: "lana",
      block: "audience",
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(dbMocks.pauseSyncTasks).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: 7,
      tasks: ["subscribers", "followers", "followers_reconcile"],
      now: new Date("2026-03-24T12:00:00.000Z"),
    }));
  });

  it("resumes the messages live domain through v2 task control", async () => {
    dbMocks.findPageByLabel.mockResolvedValue({
      page: {
        id: 7,
        label: "lana",
        platform: "fansly",
      },
      proxy: null,
    });
    dbMocks.ensureSyncTaskRows.mockResolvedValue(undefined);
    dbMocks.resumeSyncTasks.mockResolvedValue(undefined);

    await resumeSyncBlock({ db: {} } as never, {
      pageLabel: "lana",
      block: "messages_live",
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(dbMocks.resumeSyncTasks).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: 7,
      tasks: ["dm_conversations"],
    }));
  });

  it("resets message history without clearing auth through the legacy message endpoint", async () => {
    dbMocks.findPageByLabel.mockResolvedValue({
      page: {
        id: 7,
        label: "lana",
        platform: "fansly",
      },
      proxy: null,
    });
    dbMocks.ensureSyncTaskRows.mockResolvedValue(undefined);
    dbMocks.deleteCheckpoints.mockResolvedValue(undefined);
    dbMocks.resetPageDmSyncState.mockResolvedValue(undefined);
    dbMocks.resetSyncTasks.mockResolvedValue(undefined);
    dbMocks.requestSyncTaskGenerations.mockResolvedValue([
      { task: "dm_messages", desiredGeneration: 4 },
    ]);
    queueMocks.sendSyncPageWakeup.mockResolvedValue("job-1");

    const response = await resetSyncBlock({ db: {} } as never, {
      send: vi.fn(),
    } as never, {
      pageLabel: "lana",
      block: "messages_history",
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(response).toMatchObject({
      accepted: true,
      action: "reset",
      block: "messages_history",
      revisions: [{ stream: "dm_messages", desiredRevision: 4 }],
    });
    expect(dbMocks.deleteCheckpoints).toHaveBeenCalledWith(expect.anything(), {
      platformAccountId: 7,
      streams: ["dm_messages"],
    });
    expect(dbMocks.resetPageDmSyncState).toHaveBeenCalledWith(expect.anything(), 7);
    expect(dbMocks.resetSyncTasks).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: 7,
      tasks: ["dm_messages"],
    }));
    expect(dbMocks.requestSyncTaskGenerations).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: 7,
      tasks: ["dm_messages"],
      source: "reset",
    }));
  });
});
