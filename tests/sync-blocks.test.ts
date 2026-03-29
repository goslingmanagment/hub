import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  deleteCheckpoints: vi.fn(),
  deletePageTopSpenders: vi.fn(),
  ensureSyncStreamStateRows: vi.fn(),
  findPageByLabel: vi.fn(),
  listSyncMonitorStreamRows: vi.fn(),
  listVisiblePages: vi.fn(),
  requestSyncStreamRevisions: vi.fn(),
  resetPageDmSyncState: vi.fn(),
  resetSyncStreamStateRows: vi.fn(),
  setSyncStreamStatuses: vi.fn(),
}));

const connectionMocks = vi.hoisted(() => ({
  listConnectionStatuses: vi.fn(),
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

vi.mock("../apps/runtime/src/services/connections.ts", () => ({
  listConnectionStatuses: connectionMocks.listConnectionStatuses,
}));

vi.mock("../apps/runtime/src/services/sync-queue.ts", () => ({
  sendSyncPageWakeup: queueMocks.sendSyncPageWakeup,
}));

import { resolveSyncRequestPriority } from "@agency_hub_core/db";

import {
  getPageMessagesSyncBlock,
  getSyncBlocksOverview,
  pauseSyncBlock,
  resetSyncBlock,
  triggerSyncBlock,
} from "../apps/runtime/src/services/sync-blocks.ts";

function buildMonitorRow(overrides: Record<string, unknown> = {}) {
  return {
    pageId: 7,
    pageLabel: "lana",
    platform: "fansly",
    modelSlug: "lana",
    modelName: "Lana",
    username: "lana_page",
    displayName: "Lana",
    fanCount: 12,
    followerCount: 4,
    subscriberCount: 2,
    transactionCount: 8,
    dmConversationCount: 3,
    dmMessageCount: 25,
    dmEligibleConversationCount: 3,
    dmBackfillCompleteConversationCount: 2,
    dmLaggingConversationCount: 1,
    stream: "light",
    targetStatus: "active",
    cadenceSeconds: 3600,
    nextDueAt: new Date("2026-03-24T13:00:00.000Z"),
    desiredRevision: 4,
    satisfiedRevision: 4,
    desiredAt: new Date("2026-03-24T12:00:00.000Z"),
    backoffUntil: null,
    lastEnqueuedAt: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSucceededAt: new Date("2026-03-24T11:00:00.000Z"),
    lastFailedAt: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorSummary: null,
    checkpointCursorText: null,
    checkpointCursorTimestamp: null,
    checkpointState: null,
    checkpointLastSuccessfulAt: null,
    checkpointLastSuccessfulRunId: null,
    runningRunId: null,
    runningTrigger: null,
    runningStartedAt: null,
    runningLastActivityAt: null,
    runningStats: null,
    runningErrorSummary: null,
    lastCompletedRunId: null,
    lastCompletedTrigger: null,
    lastCompletedStatus: "success",
    lastCompletedStartedAt: null,
    lastCompletedFinishedAt: null,
    lastCompletedDurationMs: null,
    lastCompletedStats: null,
    lastCompletedErrorSummary: null,
    recentRunningCount: 0,
    recentSuccessCount: 1,
    recentPartialCount: 0,
    recentFailedCount: 0,
    recentSkippedCount: 0,
    recent429Count: 0,
    recent5xxCount: 0,
    recentFailedAttemptCount: 0,
    recentRetryCount: 0,
    last429At: null,
    last5xxAt: null,
    providerNextAvailableAt: null,
    providerMinSpacingMs: null,
    ...overrides,
  };
}

describe("sync blocks service", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("builds the 6-block overview and marks OnlyFans-only unsupported blocks as not_available", async () => {
    const now = new Date("2026-03-24T12:00:00.000Z");
    dbMocks.ensureSyncStreamStateRows.mockResolvedValue(undefined);
    dbMocks.listVisiblePages.mockResolvedValue([
      {
        id: 7,
        label: "lana",
        platform: "fansly",
        modelSlug: "lana",
        modelName: "Lana",
        username: "lana_page",
        displayName: "Lana",
      },
      {
        id: 8,
        label: "of-lana",
        platform: "onlyfans",
        modelSlug: "lana",
        modelName: "Lana",
        username: "of_lana",
        displayName: "OF Lana",
      },
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({ stream: "light" }),
      buildMonitorRow({
        stream: "top_spenders",
        cadenceSeconds: 3600,
        checkpointState: {
          mode: "bootstrap",
          totalMonths: 4,
          completedMonths: 1,
          pendingWindows: [{ kind: "week" }],
        },
      }),
      buildMonitorRow({ stream: "transactions", transactionCount: 12 }),
      buildMonitorRow({
        stream: "subscribers",
        subscriberCount: 5,
        targetStatus: "paused",
      }),
      buildMonitorRow({
        stream: "followers",
        followerCount: 9,
        consecutiveFailures: 3,
        lastFailedAt: new Date("2026-03-24T11:30:00.000Z"),
        lastErrorCode: "http_500",
        lastErrorSummary: "Followers sync failed",
      }),
      buildMonitorRow({
        stream: "dm_conversations",
        cadenceSeconds: 1800,
        dmConversationCount: 3,
        dmEligibleConversationCount: 3,
        dmBackfillCompleteConversationCount: 2,
        dmLaggingConversationCount: 1,
        lastSucceededAt: new Date("2026-03-24T10:50:00.000Z"),
      }),
      buildMonitorRow({
        stream: "dm_messages",
        cadenceSeconds: 86400,
        dmMessageCount: 25,
        lastSucceededAt: new Date("2026-03-24T10:40:00.000Z"),
      }),
      buildMonitorRow({
        pageId: 8,
        pageLabel: "of-lana",
        platform: "onlyfans",
        username: "of_lana",
        displayName: "OF Lana",
        stream: "light",
      }),
      buildMonitorRow({
        pageId: 8,
        pageLabel: "of-lana",
        platform: "onlyfans",
        username: "of_lana",
        displayName: "OF Lana",
        stream: "transactions",
      }),
    ]);
    connectionMocks.listConnectionStatuses.mockResolvedValue([
      { id: 7, connectionStatus: "active" },
      { id: 8, connectionStatus: "expired" },
    ]);

    const overview = await getSyncBlocksOverview({
      db: {},
    } as never, { now });

    expect(overview.generatedAt).toBe(now.toISOString());
    expect(overview.pages).toHaveLength(2);

    const fanslyPage = overview.pages.find((page) => page.pageLabel === "lana");
    const onlyFansPage = overview.pages.find((page) => page.pageLabel === "of-lana");

    expect(fanslyPage?.blocks.connection).toMatchObject({
      state: "up_to_date",
      connectionStatus: "connected",
    });
    expect(fanslyPage?.blocks.top_spenders).toMatchObject({
      state: "up_to_date",
      progress: expect.objectContaining({
        current: 1,
        total: 4,
        unit: "months",
      }),
    });
    expect(fanslyPage?.blocks.followers).toMatchObject({
      state: "error",
      needsAttention: true,
      error: expect.objectContaining({
        code: "http_500",
        consecutiveFailures: 3,
      }),
    });
    expect(fanslyPage?.blocks.messages).toMatchObject({
      state: "up_to_date",
      metrics: expect.objectContaining({
        storedMessageCount: 25,
        eligibleConversationCount: 3,
      }),
      intervals: [
        { stream: "dm_conversations", cadenceSeconds: 1800 },
        { stream: "dm_messages", cadenceSeconds: 86400 },
      ],
    });

    expect(onlyFansPage?.blocks.connection).toMatchObject({
      connectionStatus: "not_connected",
    });
    expect(onlyFansPage?.blocks.transactions.state).toBe("up_to_date");
    expect(onlyFansPage?.blocks.top_spenders.state).toBe("not_available");
    expect(onlyFansPage?.blocks.subscribers.state).toBe("not_available");
    expect(onlyFansPage?.blocks.followers.state).toBe("not_available");
    expect(onlyFansPage?.blocks.messages.state).toBe("not_available");
  });

  it("returns the combined Messages block with both substream cadences", async () => {
    const now = new Date("2026-03-24T12:00:00.000Z");
    dbMocks.ensureSyncStreamStateRows.mockResolvedValue(undefined);
    dbMocks.listVisiblePages.mockResolvedValue([{
      id: 7,
      label: "lana",
      platform: "fansly",
      modelSlug: "lana",
      modelName: "Lana",
      username: "lana_page",
      displayName: "Lana",
    }]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({ stream: "light" }),
      buildMonitorRow({ stream: "top_spenders" }),
      buildMonitorRow({ stream: "transactions" }),
      buildMonitorRow({ stream: "subscribers" }),
      buildMonitorRow({ stream: "followers" }),
      buildMonitorRow({
        stream: "dm_conversations",
        cadenceSeconds: 1800,
        dmConversationCount: 4,
        dmEligibleConversationCount: 3,
        dmBackfillCompleteConversationCount: 2,
        dmLaggingConversationCount: 1,
        lastSucceededAt: new Date("2026-03-24T10:20:00.000Z"),
      }),
      buildMonitorRow({
        stream: "dm_messages",
        cadenceSeconds: 86400,
        dmMessageCount: 14,
        lastSucceededAt: new Date("2026-03-24T09:20:00.000Z"),
      }),
    ]);
    connectionMocks.listConnectionStatuses.mockResolvedValue([{ id: 7, connectionStatus: "active" }]);

    const response = await getPageMessagesSyncBlock({
      db: {},
    } as never, {
      pageLabel: "lana",
      now,
    });

    expect(response.page).toMatchObject({
      pageLabel: "lana",
      platform: "fansly",
    });
    expect(response.block).toMatchObject({
      block: "messages",
      lastSuccessAt: "2026-03-24T09:20:00.000Z",
      progress: {
        label: "2 of 3 conversations backfilled",
        current: 2,
        total: 3,
        unit: "conversations",
        percent: expect.closeTo(66.6666667, 5),
        details: {
          laggingConversations: 1,
          visibleConversations: 4,
        },
      },
      intervals: [
        { stream: "dm_conversations", cadenceSeconds: 1800 },
        { stream: "dm_messages", cadenceSeconds: 86400 },
      ],
    });
    expect(response.block.substreams).toHaveLength(2);
  });

  it("prefers error over waiting while leaving clean pending streams as waiting and backed off streams as retrying", async () => {
    const now = new Date("2026-03-24T12:00:00.000Z");
    const buildPageRows = (
      base: {
        id: number;
        label: string;
        modelSlug: string;
        modelName: string;
        username: string;
        displayName: string;
      },
      topSpendersOverrides: Record<string, unknown>,
    ) => ([
      buildMonitorRow({
        pageId: base.id,
        pageLabel: base.label,
        modelSlug: base.modelSlug,
        modelName: base.modelName,
        username: base.username,
        displayName: base.displayName,
        stream: "light",
      }),
      buildMonitorRow({
        pageId: base.id,
        pageLabel: base.label,
        modelSlug: base.modelSlug,
        modelName: base.modelName,
        username: base.username,
        displayName: base.displayName,
        stream: "top_spenders",
        ...topSpendersOverrides,
      }),
      buildMonitorRow({
        pageId: base.id,
        pageLabel: base.label,
        modelSlug: base.modelSlug,
        modelName: base.modelName,
        username: base.username,
        displayName: base.displayName,
        stream: "transactions",
      }),
      buildMonitorRow({
        pageId: base.id,
        pageLabel: base.label,
        modelSlug: base.modelSlug,
        modelName: base.modelName,
        username: base.username,
        displayName: base.displayName,
        stream: "subscribers",
      }),
      buildMonitorRow({
        pageId: base.id,
        pageLabel: base.label,
        modelSlug: base.modelSlug,
        modelName: base.modelName,
        username: base.username,
        displayName: base.displayName,
        stream: "followers",
      }),
      buildMonitorRow({
        pageId: base.id,
        pageLabel: base.label,
        modelSlug: base.modelSlug,
        modelName: base.modelName,
        username: base.username,
        displayName: base.displayName,
        stream: "dm_conversations",
      }),
      buildMonitorRow({
        pageId: base.id,
        pageLabel: base.label,
        modelSlug: base.modelSlug,
        modelName: base.modelName,
        username: base.username,
        displayName: base.displayName,
        stream: "dm_messages",
      }),
    ]);

    dbMocks.ensureSyncStreamStateRows.mockResolvedValue(undefined);
    dbMocks.listVisiblePages.mockResolvedValue([
      {
        id: 7,
        label: "errored",
        platform: "fansly",
        modelSlug: "errored",
        modelName: "Errored",
        username: "errored_page",
        displayName: "Errored",
      },
      {
        id: 8,
        label: "waiting",
        platform: "fansly",
        modelSlug: "waiting",
        modelName: "Waiting",
        username: "waiting_page",
        displayName: "Waiting",
      },
      {
        id: 9,
        label: "retrying",
        platform: "fansly",
        modelSlug: "retrying",
        modelName: "Retrying",
        username: "retrying_page",
        displayName: "Retrying",
      },
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      ...buildPageRows({
        id: 7,
        label: "errored",
        modelSlug: "errored",
        modelName: "Errored",
        username: "errored_page",
        displayName: "Errored",
      }, {
        desiredRevision: 5,
        satisfiedRevision: 0,
        lastSucceededAt: null,
        lastFailedAt: new Date("2026-03-24T11:30:00.000Z"),
        consecutiveFailures: 1,
        lastErrorCode: "23502",
        lastErrorSummary: "Top spenders insert failed",
      }),
      ...buildPageRows({
        id: 8,
        label: "waiting",
        modelSlug: "waiting",
        modelName: "Waiting",
        username: "waiting_page",
        displayName: "Waiting",
      }, {
        desiredRevision: 5,
        satisfiedRevision: 0,
        lastSucceededAt: null,
      }),
      ...buildPageRows({
        id: 9,
        label: "retrying",
        modelSlug: "retrying",
        modelName: "Retrying",
        username: "retrying_page",
        displayName: "Retrying",
      }, {
        desiredRevision: 5,
        satisfiedRevision: 0,
        lastSucceededAt: null,
        lastFailedAt: new Date("2026-03-24T11:45:00.000Z"),
        consecutiveFailures: 1,
        backoffUntil: new Date("2026-03-24T12:15:00.000Z"),
        lastErrorCode: "23502",
        lastErrorSummary: "Top spenders insert failed",
      }),
    ]);
    connectionMocks.listConnectionStatuses.mockResolvedValue([
      { id: 7, connectionStatus: "active" },
      { id: 8, connectionStatus: "active" },
      { id: 9, connectionStatus: "active" },
    ]);

    const overview = await getSyncBlocksOverview({
      db: {},
    } as never, { now });

    const erroredPage = overview.pages.find((page) => page.pageLabel === "errored");
    const waitingPage = overview.pages.find((page) => page.pageLabel === "waiting");
    const retryingPage = overview.pages.find((page) => page.pageLabel === "retrying");

    expect(erroredPage?.blocks.top_spenders).toMatchObject({
      state: "error",
      error: expect.objectContaining({
        code: "23502",
      }),
    });
    expect(waitingPage?.blocks.top_spenders.state).toBe("waiting");
    expect(retryingPage?.blocks.top_spenders.state).toBe("retrying");
  });

  it("triggers the mapped block stream immediately without reviving auth_failed rows", async () => {
    dbMocks.findPageByLabel.mockResolvedValue({
      page: {
        id: 7,
        label: "lana",
        platform: "fansly",
      },
      proxy: {
        url: "socks5://proxy.example:1080",
      },
    });
    dbMocks.ensureSyncStreamStateRows.mockResolvedValue(undefined);
    dbMocks.requestSyncStreamRevisions.mockResolvedValue([
      { stream: "top_spenders", desiredRevision: 5 },
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({
        pageId: 7,
        stream: "top_spenders",
      }),
    ]);
    queueMocks.sendSyncPageWakeup.mockResolvedValue("job-1");

    const response = await triggerSyncBlock({
      db: {},
    } as never, {
      send: vi.fn(),
    } as never, {
      pageLabel: "lana",
      block: "top_spenders",
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(response).toMatchObject({
      accepted: true,
      action: "trigger",
      pageLabel: "lana",
      block: "top_spenders",
      revisions: [{ stream: "top_spenders", desiredRevision: 5 }],
    });
    expect(dbMocks.requestSyncStreamRevisions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: 7,
      streams: ["top_spenders"],
      reason: "manual",
      preserveAuthFailed: true,
    }));
    expect(queueMocks.sendSyncPageWakeup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: 7,
      provider: "fansly",
      priority: resolveSyncRequestPriority("top_spenders", "manual"),
    }));
  });

  it("pauses follower maintenance alongside the visible followers block and fully resets message state", async () => {
    dbMocks.findPageByLabel.mockResolvedValue({
      page: {
        id: 7,
        label: "lana",
        platform: "fansly",
      },
      proxy: null,
    });
    dbMocks.ensureSyncStreamStateRows.mockResolvedValue(undefined);
    dbMocks.setSyncStreamStatuses.mockResolvedValue(undefined);
    dbMocks.deleteCheckpoints.mockResolvedValue(undefined);
    dbMocks.resetPageDmSyncState.mockResolvedValue(undefined);
    dbMocks.resetSyncStreamStateRows.mockResolvedValue(undefined);
    dbMocks.requestSyncStreamRevisions.mockResolvedValue([
      { stream: "dm_conversations", desiredRevision: 9 },
      { stream: "dm_messages", desiredRevision: 4 },
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({ pageId: 7, stream: "dm_conversations" }),
      buildMonitorRow({ pageId: 7, stream: "dm_messages" }),
    ]);
    queueMocks.sendSyncPageWakeup.mockResolvedValue("job-1");

    await pauseSyncBlock({
      db: {},
    } as never, {
      pageLabel: "lana",
      block: "followers",
      now: new Date("2026-03-24T12:00:00.000Z"),
    });
    expect(dbMocks.setSyncStreamStatuses).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: 7,
      streams: ["followers", "followers_reconcile"],
      status: "paused",
    }));

    const response = await resetSyncBlock({
      db: {},
    } as never, {
      send: vi.fn(),
    } as never, {
      pageLabel: "lana",
      block: "messages",
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(response).toMatchObject({
      accepted: true,
      action: "reset",
      block: "messages",
    });
    expect(dbMocks.deleteCheckpoints).toHaveBeenCalledWith(expect.anything(), {
      platformAccountId: 7,
      streams: ["dm_conversations", "dm_messages"],
    });
    expect(dbMocks.resetPageDmSyncState).toHaveBeenCalledWith(expect.anything(), 7);
    expect(dbMocks.resetSyncStreamStateRows).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: 7,
      streams: ["dm_conversations", "dm_messages"],
    }));
    expect(dbMocks.requestSyncStreamRevisions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: 7,
      streams: ["dm_conversations", "dm_messages"],
      reason: "manual",
      preserveAuthFailed: true,
    }));
    expect(queueMocks.sendSyncPageWakeup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      platformAccountId: 7,
      provider: "fansly",
      priority: resolveSyncRequestPriority("dm_conversations", "manual"),
    }));
  });
});
