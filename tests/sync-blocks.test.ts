import { afterEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";

const dbMocks = vi.hoisted(() => ({
  deleteCheckpoints: vi.fn(),
  deletePageTopSpenders: vi.fn(),
  ensurePageSyncStates: vi.fn(),
  findPageByLabel: vi.fn(),
  listPageSyncStates: vi.fn(),
  pausePageSync: vi.fn(),
  requestPageSync: vi.fn(),
  resetPageDmSyncState: vi.fn(),
  resetPageSync: vi.fn(),
  resumePageSync: vi.fn(),
}));

const syncStatusMocks = vi.hoisted(() => ({
  getSyncStatusSnapshot: vi.fn(),
}));

const queueMocks = vi.hoisted(() => ({
  sendSyncPageWakeup: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof DbModule>("@agency_hub_core/db");
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

import { resolvePageSyncPriority } from "@agency_hub_core/db";

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
    succeededAt: "2026-03-24T11:00:00.000Z",
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
      succeededAt: "2026-03-24T11:00:00.000Z",
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
          failedAt: "2026-03-24T11:45:00.000Z",
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
          failedAt: "2026-03-24T11:30:00.000Z",
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
          succeededAt: "2026-03-24T10:50:00.000Z",
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
          succeededAt: "2026-03-24T10:40:00.000Z",
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

    expect(syncStatusMocks.getSyncStatusSnapshot).toHaveBeenCalledWith({}, {
      now: new Date("2026-03-24T12:00:00.000Z"),
      pageIds: undefined,
      includeMonitorRows: false,
      monitorStreams: ["dm_messages"],
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
      code: "auth_blocked",
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

  it("suppresses page-level worker diagnostics while another non-connection block is actively syncing", async () => {
    syncStatusMocks.getSyncStatusSnapshot.mockResolvedValue({
      generatedAt: "2026-03-24T12:00:00.000Z",
      pages: [buildSnapshotPage({
        blocks: {
          connection: buildBlock({ block: "connection", connectionStatus: "connected" }),
          financials: buildBlock({
            block: "financials",
            state: "delayed",
            primaryFresh: false,
            needsAttention: true,
            statusReason: {
              code: "queue_delayed",
              summary: "Queued too long with no active sync making progress.",
              waitingFor: null,
            },
          }),
          audience: buildBlock({ block: "audience", state: "scheduled", primaryFresh: false }),
          messages_live: buildBlock({ block: "messages_live", state: "scheduled", primaryFresh: false }),
          messages_history: buildBlock({
            block: "messages_history",
            state: "backfilling",
            primaryFresh: false,
            progress: {
              label: "82 / 3,004 conversations",
              current: 82,
              total: 3004,
              unit: "conversations",
              percent: 2.73,
              percentValid: true,
              details: {},
            },
          }),
        },
      })],
    });

    const overview = await getSyncBlocksOverview({} as never, {
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(overview.pages[0]?.diagnosis).toBeNull();
    expect(overview.diagnosis).toBeNull();
  });

  it("surfaces page-level worker diagnostics when queue delay has no active or fresh sibling blocks", async () => {
    syncStatusMocks.getSyncStatusSnapshot.mockResolvedValue({
      generatedAt: "2026-03-24T12:00:00.000Z",
      pages: [buildSnapshotPage({
        blocks: {
          connection: buildBlock({ block: "connection", connectionStatus: "connected" }),
          financials: buildBlock({
            block: "financials",
            state: "delayed",
            primaryFresh: false,
            needsAttention: true,
            statusReason: {
              code: "queue_delayed",
              summary: "Queued too long with no active sync making progress.",
              waitingFor: null,
            },
          }),
          audience: buildBlock({ block: "audience", state: "scheduled", primaryFresh: false }),
          messages_live: buildBlock({ block: "messages_live", state: "scheduled", primaryFresh: false }),
          messages_history: buildBlock({ block: "messages_history", state: "scheduled", primaryFresh: false }),
        },
      })],
    });

    const overview = await getSyncBlocksOverview({} as never, {
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(overview.pages[0]?.diagnosis).toMatchObject({
      code: "worker_offline",
      severity: "warning",
      detail: "Queued too long with no active sync making progress.",
    });
  });

  it("triggers the financials domain through the v2 task request path", async () => {
    dbMocks.findPageByLabel.mockResolvedValue({
      page: {
        id: 7,
        label: "lana",
        platform: "fansly",
      },
      proxy: {
        url: "socks5://proxy.example",
        rateLimitScopeKey: "shared-proxy-pool",
      },
    });
    dbMocks.ensurePageSyncStates.mockResolvedValue(undefined);
    dbMocks.requestPageSync.mockResolvedValue([
      { stream: "transactions", requestedSeq: 5 },
      { stream: "top_spenders", requestedSeq: 5 },
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
      requests: [
        { stream: "transactions", requestedSeq: 5 },
        { stream: "top_spenders", requestedSeq: 5 },
      ],
    });
    expect(dbMocks.requestPageSync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      pageId: 7,
      streams: ["transactions", "top_spenders"],
      source: "manual",
    }));
    expect(queueMocks.sendSyncPageWakeup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: 7,
      provider: "fansly",
      egressKey: "shared-proxy-pool",
      priority: resolvePageSyncPriority("transactions", "manual"),
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
    dbMocks.ensurePageSyncStates.mockResolvedValue(undefined);
    dbMocks.pausePageSync.mockResolvedValue(undefined);

    await pauseSyncBlock({ db: {} } as never, {
      pageLabel: "lana",
      block: "audience",
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(dbMocks.pausePageSync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      pageId: 7,
      streams: ["subscribers", "followers", "followers_reconcile"],
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
    dbMocks.ensurePageSyncStates.mockResolvedValue(undefined);
    dbMocks.listPageSyncStates.mockResolvedValue([
      { stream: "dm_conversations", status: "paused" },
    ]);
    dbMocks.resumePageSync.mockResolvedValue(undefined);
    dbMocks.requestPageSync.mockResolvedValue([
      { stream: "dm_conversations", requestedSeq: 3 },
    ]);
    queueMocks.sendSyncPageWakeup.mockResolvedValue("job-2");

    const response = await resumeSyncBlock({ db: {} } as never, {
      send: vi.fn(),
    } as never, {
      pageLabel: "lana",
      block: "messages_live",
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(response).toMatchObject({
      accepted: true,
      action: "resume",
      block: "messages_live",
      requests: [{ stream: "dm_conversations", requestedSeq: 3 }],
    });
    expect(dbMocks.resumePageSync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      pageId: 7,
      streams: ["dm_conversations"],
    }));
    expect(dbMocks.requestPageSync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      pageId: 7,
      streams: ["dm_conversations"],
      source: "manual",
    }));
    expect(queueMocks.sendSyncPageWakeup).toHaveBeenCalledTimes(1);
  });

  it("resumes only paused OnlyFans financial substreams", async () => {
    dbMocks.findPageByLabel.mockResolvedValue({
      page: {
        id: 9,
        label: "lana-of",
        platform: "onlyfans",
      },
      proxy: null,
    });
    dbMocks.ensurePageSyncStates.mockResolvedValue(undefined);
    dbMocks.listPageSyncStates.mockResolvedValue([
      { stream: "transactions", status: "paused" },
      { stream: "fan_identities", status: "idle" },
      { stream: "top_spenders", status: "paused" },
    ]);
    dbMocks.resumePageSync.mockResolvedValue(undefined);
    dbMocks.requestPageSync.mockResolvedValue([
      { stream: "transactions", requestedSeq: 2 },
      { stream: "top_spenders", requestedSeq: 2 },
    ]);
    queueMocks.sendSyncPageWakeup.mockResolvedValue("job-of-financials");

    const response = await resumeSyncBlock({ db: {} } as never, {
      send: vi.fn(),
    } as never, {
      pageLabel: "lana-of",
      block: "financials",
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(response.requests).toEqual([
      { stream: "transactions", requestedSeq: 2 },
      { stream: "top_spenders", requestedSeq: 2 },
    ]);
    expect(dbMocks.resumePageSync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      pageId: 9,
      streams: ["transactions", "top_spenders"],
    }));
    expect(dbMocks.requestPageSync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      pageId: 9,
      streams: ["transactions", "top_spenders"],
      source: "manual",
    }));
    expect(queueMocks.sendSyncPageWakeup).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        platformAccountId: 9,
        provider: "onlyfans",
        priority: Math.max(
          resolvePageSyncPriority("transactions", "manual"),
          resolvePageSyncPriority("top_spenders", "manual"),
        ),
      }),
    );
  });

  it("does not turn Resume into a trigger when no block rows are paused", async () => {
    dbMocks.findPageByLabel.mockResolvedValue({
      page: {
        id: 9,
        label: "lana-of",
        platform: "onlyfans",
      },
      proxy: null,
    });
    dbMocks.ensurePageSyncStates.mockResolvedValue(undefined);
    dbMocks.listPageSyncStates.mockResolvedValue([
      { stream: "transactions", status: "idle" },
      { stream: "fan_identities", status: "idle" },
      { stream: "top_spenders", status: "idle" },
    ]);

    const response = await resumeSyncBlock({ db: {} } as never, {
      send: vi.fn(),
    } as never, {
      pageLabel: "lana-of",
      block: "financials",
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(response.requests).toEqual([]);
    expect(dbMocks.resumePageSync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      streams: [],
    }));
    expect(dbMocks.requestPageSync).not.toHaveBeenCalled();
    expect(queueMocks.sendSyncPageWakeup).not.toHaveBeenCalled();
  });

  it("allows OnlyFans message domains when the platform exposes DM streams", async () => {
    dbMocks.findPageByLabel.mockResolvedValue({
      page: {
        id: 9,
        label: "lana-of",
        platform: "onlyfans",
      },
      proxy: null,
    });
    dbMocks.ensurePageSyncStates.mockResolvedValue(undefined);
    dbMocks.requestPageSync.mockResolvedValue([
      { stream: "dm_conversations", requestedSeq: 2 },
    ]);
    queueMocks.sendSyncPageWakeup.mockResolvedValue("job-of-messages");

    const response = await triggerSyncBlock({ db: {} } as never, {
      send: vi.fn(),
    } as never, {
      pageLabel: "lana-of",
      block: "messages_live",
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(response).toMatchObject({
      accepted: true,
      action: "trigger",
      pageLabel: "lana-of",
      block: "messages_live",
      requests: [{ stream: "dm_conversations", requestedSeq: 2 }],
    });
    expect(dbMocks.requestPageSync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      pageId: 9,
      streams: ["dm_conversations"],
      source: "manual",
    }));
  });

  it("resumes message history by re-requesting work and enqueueing a wakeup", async () => {
    dbMocks.findPageByLabel.mockResolvedValue({
      page: {
        id: 7,
        label: "lana",
        platform: "fansly",
      },
      proxy: null,
    });
    dbMocks.ensurePageSyncStates.mockResolvedValue(undefined);
    dbMocks.listPageSyncStates.mockResolvedValue([
      { stream: "dm_messages", status: "paused" },
    ]);
    dbMocks.resumePageSync.mockResolvedValue(undefined);
    dbMocks.requestPageSync.mockResolvedValue([
      { stream: "dm_messages", requestedSeq: 4 },
    ]);
    queueMocks.sendSyncPageWakeup.mockResolvedValue("job-3");

    const response = await resumeSyncBlock({ db: {} } as never, {
      send: vi.fn(),
    } as never, {
      pageLabel: "lana",
      block: "messages_history",
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(response).toMatchObject({
      accepted: true,
      action: "resume",
      block: "messages_history",
      requests: [{ stream: "dm_messages", requestedSeq: 4 }],
    });
    expect(dbMocks.resumePageSync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      pageId: 7,
      streams: ["dm_messages"],
    }));
    expect(dbMocks.requestPageSync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      pageId: 7,
      streams: ["dm_messages"],
      source: "manual",
    }));
    expect(queueMocks.sendSyncPageWakeup).toHaveBeenCalledTimes(1);
  });

  it("refuses the message-history reset before touching any state (Stage 2 guard)", async () => {
    // Stage 2 destruction-door guard: this reset would hard-delete every
    // stored DM for the page (resetPageDmSyncState); it refuses until the
    // message archive exists (Stage 10).
    const db = {
      transaction: vi.fn(async (callback: (tx: object) => Promise<unknown>) => callback({})),
    };

    await expect(resetSyncBlock({ db } as never, {
      send: vi.fn(),
    } as never, {
      pageLabel: "lana",
      block: "messages_history",
      now: new Date("2026-03-24T12:00:00.000Z"),
    })).rejects.toMatchObject({
      statusCode: 409,
    });

    expect(db.transaction).not.toHaveBeenCalled();
    expect(dbMocks.resetPageDmSyncState).not.toHaveBeenCalled();
    expect(dbMocks.resetPageSync).not.toHaveBeenCalled();
  });
});
