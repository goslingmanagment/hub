import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  ensureSyncTaskRows: vi.fn(),
  listVisiblePages: vi.fn(),
  listSyncTaskRows: vi.fn(),
  listSyncMonitorStreamRows: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof import("@agency_hub_core/db")>("@agency_hub_core/db");
  return {
    ...actual,
    ensureSyncTaskRows: dbMocks.ensureSyncTaskRows,
    listVisiblePages: dbMocks.listVisiblePages,
    listSyncTaskRows: dbMocks.listSyncTaskRows,
    listSyncMonitorStreamRows: dbMocks.listSyncMonitorStreamRows,
  };
});

import { getSyncStatusSnapshot } from "../apps/runtime/src/services/sync-status.ts";

function buildTaskRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-03-24T12:00:00.000Z");
  return {
    platformAccountId: 7,
    task: "light",
    status: "idle",
    desiredGeneration: 1,
    runningGeneration: null,
    appliedGeneration: 1,
    scheduleIntervalSeconds: 3600,
    slotOffsetSeconds: 0,
    lastScheduledSlot: 10,
    lastRequestedAt: now,
    lastEnqueuedAt: now,
    lastStartedAt: now,
    lastProgressAt: now,
    lastFinishedAt: now,
    lastSuccessAt: now,
    lastFailureAt: null,
    retryClass: null,
    retryAt: null,
    blockerType: null,
    blockerCode: null,
    blockerReason: null,
    blockedSince: null,
    currentPhase: null,
    currentWorkClass: "live",
    progressPayload: {},
    leaseOwner: null,
    leaseToken: null,
    leaseHeartbeatAt: null,
    leaseExpiresAt: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorSummary: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

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
    followerCount: 9,
    subscriberCount: 4,
    transactionCount: 18,
    dmConversationCount: 6,
    dmMessageCount: 25,
    dmEligibleConversationCount: 6,
    dmBackfillCompleteConversationCount: 6,
    dmLaggingConversationCount: 0,
    stream: "light",
    targetStatus: "active",
    cadenceSeconds: 3600,
    nextDueAt: new Date("2026-03-24T13:00:00.000Z"),
    desiredRevision: 1,
    satisfiedRevision: 1,
    desiredAt: new Date("2026-03-24T12:00:00.000Z"),
    backoffUntil: null,
    lastEnqueuedAt: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSucceededAt: new Date("2026-03-24T12:00:00.000Z"),
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

function buildVisiblePage(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    label: "lana",
    platform: "fansly",
    username: "lana_page",
    displayName: "Lana",
    followerCount: 9,
    subscriberCount: 4,
    lastLightSyncAt: new Date("2026-03-24T12:00:00.000Z"),
    lastFollowerSyncAt: new Date("2026-03-24T12:00:00.000Z"),
    modelSlug: "lana",
    modelName: "Lana",
    hasCredentials: true,
    proxyUrl: null,
    proxyHasAuth: false,
    ...overrides,
  };
}

describe("sync status service", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not report message history as up_to_date while backlog remains", async () => {
    dbMocks.ensureSyncTaskRows.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([{
      id: 7,
      label: "lana",
      platform: "fansly",
      username: "lana_page",
      displayName: "Lana",
      followerCount: 9,
      subscriberCount: 4,
      lastLightSyncAt: new Date("2026-03-24T12:00:00.000Z"),
      lastFollowerSyncAt: new Date("2026-03-24T12:00:00.000Z"),
      modelSlug: "lana",
      modelName: "Lana",
      hasCredentials: true,
      proxyUrl: null,
      proxyHasAuth: false,
    }]);
    dbMocks.listSyncTaskRows.mockResolvedValue([
      buildTaskRow({ task: "light" }),
      buildTaskRow({ task: "dm_conversations", scheduleIntervalSeconds: 1800 }),
      buildTaskRow({ task: "dm_messages", scheduleIntervalSeconds: 86400, currentWorkClass: "history" }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({ stream: "light" }),
      buildMonitorRow({ stream: "dm_conversations", cadenceSeconds: 1800 }),
      buildMonitorRow({
        stream: "dm_messages",
        cadenceSeconds: 86400,
        dmEligibleConversationCount: 10,
        dmBackfillCompleteConversationCount: 3,
        dmLaggingConversationCount: 2,
      }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.messages_history).toMatchObject({
      state: "delayed",
      statusReason: {
        code: "history_incomplete",
        summary: "Conversation history is still catching up.",
      },
      progress: expect.objectContaining({
        current: 3,
        total: 10,
      }),
      metrics: expect.objectContaining({
        readyConversationCount: 3,
        eligibleConversationCount: 10,
        laggingConversationCount: 2,
      }),
    });
    expect(snapshot.pages[0]?.syncUx.state).toBe("catching_up");
  });

  it("surfaces an auth blocker as failed connection sync and requires action", async () => {
    dbMocks.ensureSyncTaskRows.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([{
      id: 7,
      label: "lana",
      platform: "fansly",
      username: "lana_page",
      displayName: "Lana",
      followerCount: 9,
      subscriberCount: 4,
      lastLightSyncAt: null,
      lastFollowerSyncAt: null,
      modelSlug: "lana",
      modelName: "Lana",
      hasCredentials: true,
      proxyUrl: null,
      proxyHasAuth: false,
    }]);
    dbMocks.listSyncTaskRows.mockResolvedValue([
      buildTaskRow({
        task: "light",
        status: "blocked",
        desiredGeneration: 2,
        appliedGeneration: 1,
        lastSuccessAt: null,
        lastFailureAt: new Date("2026-03-24T11:59:00.000Z"),
        blockerType: "auth",
        blockerCode: "credentials_invalid",
        blockerReason: "Session expired",
        lastErrorCode: "auth_failed",
        lastErrorSummary: "Session expired",
      }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({
        stream: "light",
        lastSucceededAt: null,
        lastFailedAt: new Date("2026-03-24T11:59:00.000Z"),
        lastErrorCode: "auth_failed",
        lastErrorSummary: "Session expired",
      }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.connection.state).toBe("failed");
    expect(snapshot.pages[0]?.blocks.connection.connectionStatus).toBe("error");
    expect(["credentials_invalid", "auth_failed"]).toContain(
      snapshot.pages[0]?.blocks.connection.error?.code ?? null,
    );
    expect(snapshot.pages[0]?.blocks.connection.error?.summary).toBe("Session expired");
    expect(snapshot.pages[0]?.syncUx.state).toBe("attention");
  });

  it("prefers the current dependency blocker over stale last-error fields", async () => {
    dbMocks.ensureSyncTaskRows.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([{
      id: 7,
      label: "lana",
      platform: "fansly",
      username: "lana_page",
      displayName: "Lana",
      followerCount: 9,
      subscriberCount: 4,
      lastLightSyncAt: new Date("2026-03-24T12:00:00.000Z"),
      lastFollowerSyncAt: new Date("2026-03-24T12:00:00.000Z"),
      modelSlug: "lana",
      modelName: "Lana",
      hasCredentials: true,
      proxyUrl: null,
      proxyHasAuth: false,
    }]);
    dbMocks.listSyncTaskRows.mockResolvedValue([
      buildTaskRow({ task: "light" }),
      buildTaskRow({ task: "transactions" }),
      buildTaskRow({
        task: "dm_conversations",
        scheduleIntervalSeconds: 1800,
        status: "blocked",
        desiredGeneration: 2,
        appliedGeneration: 1,
        lastSuccessAt: null,
        blockerType: "dependency",
        blockerCode: "unmet_dependency",
        blockerReason: "Waiting for light, transactions",
        lastErrorCode: "http_500",
        lastErrorSummary: "Old transport failure",
        lastFailureAt: new Date("2026-03-24T11:30:00.000Z"),
      }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({ stream: "light" }),
      buildMonitorRow({ stream: "transactions" }),
      buildMonitorRow({ stream: "dm_conversations", cadenceSeconds: 1800 }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.messages_live).toMatchObject({
      state: "delayed",
      error: null,
      statusReason: {
        code: "unmet_dependency",
        summary: "Waiting for light, transactions",
        waitingFor: ["light", "transactions"],
      },
    });
    expect(snapshot.pages[0]?.blocks.messages_live.substreams[0]).toMatchObject({
      stream: "dm_conversations",
      statusReason: {
        code: "unmet_dependency",
        waitingFor: ["light", "transactions"],
      },
      error: null,
    });
    expect(snapshot.pages[0]?.syncUx.state).toBe("catching_up");
  });

  it("keeps financials in catching-up mode when only top spenders enrichment is running", async () => {
    dbMocks.ensureSyncTaskRows.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listSyncTaskRows.mockResolvedValue([
      buildTaskRow({
        task: "transactions",
        lastSuccessAt: new Date("2026-03-24T11:55:00.000Z"),
      }),
      buildTaskRow({
        task: "top_spenders",
        status: "running",
        desiredGeneration: 1,
        appliedGeneration: 0,
        currentWorkClass: "maintenance",
        lastSuccessAt: null,
        progressPayload: {
          totalMonths: 15,
          completedMonths: 14,
        },
      }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({ stream: "transactions" }),
      buildMonitorRow({ stream: "top_spenders" }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.financials).toMatchObject({
      state: "backfilling",
      primaryFresh: true,
      progressStream: "top_spenders",
      progressRole: "supporting",
    });
    expect(snapshot.pages[0]?.blocks.financials.substreams).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stream: "transactions",
        role: "primary",
        state: "up_to_date",
        isFresh: true,
      }),
      expect.objectContaining({
        stream: "top_spenders",
        role: "supporting",
        state: "backfilling",
      }),
    ]));
    expect(snapshot.pages[0]?.syncUx.state).toBe("catching_up");
  });

  it("surfaces queue-delayed runtime problems on primary financial streams", async () => {
    dbMocks.ensureSyncTaskRows.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listSyncTaskRows.mockResolvedValue([
      buildTaskRow({
        task: "light",
        lastSuccessAt: new Date("2026-03-24T11:50:00.000Z"),
      }),
      buildTaskRow({
        task: "transactions",
        status: "queued",
        desiredGeneration: 2,
        appliedGeneration: 1,
        lastSuccessAt: new Date("2026-03-24T11:55:00.000Z"),
        lastRequestedAt: new Date("2026-03-24T11:40:00.000Z"),
      }),
      buildTaskRow({
        task: "top_spenders",
        lastSuccessAt: new Date("2026-03-24T11:56:00.000Z"),
      }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({ stream: "transactions" }),
      buildMonitorRow({ stream: "top_spenders" }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.financials.state).toBe("delayed");
    expect(snapshot.pages[0]?.blocks.financials.statusReason).toMatchObject({
      code: "queue_delayed",
      summary: "Queued too long with no active sync making progress.",
    });
    expect(snapshot.pages[0]?.blocks.financials.substreams[0]).toMatchObject({
      stream: "transactions",
      state: "delayed",
      statusReason: expect.objectContaining({
        code: "queue_delayed",
      }),
    });
  });

  it("treats fresh queue waits as healthy when a sibling page is actively using the same queue group", async () => {
    dbMocks.ensureSyncTaskRows.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([
      buildVisiblePage(),
      buildVisiblePage({
        id: 8,
        label: "lana-alt",
        username: "lana_alt",
      }),
    ]);
    dbMocks.listSyncTaskRows.mockResolvedValue([
      buildTaskRow({
        task: "transactions",
        status: "queued",
        desiredGeneration: 2,
        appliedGeneration: 1,
        lastSuccessAt: new Date("2026-03-24T11:55:00.000Z"),
        lastRequestedAt: new Date("2026-03-24T11:20:00.000Z"),
      }),
      buildTaskRow({
        platformAccountId: 8,
        task: "dm_messages",
        status: "running",
        desiredGeneration: 1,
        appliedGeneration: 0,
        currentWorkClass: "history",
        lastSuccessAt: null,
        lastStartedAt: new Date("2026-03-24T11:58:00.000Z"),
        lastProgressAt: new Date("2026-03-24T11:59:00.000Z"),
      }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({ stream: "transactions" }),
      buildMonitorRow({ stream: "top_spenders" }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.financials.state).toBe("scheduled");
    expect(snapshot.pages[0]?.blocks.financials.statusReason).toMatchObject({
      code: "queue_waiting",
      summary: "Queued - will start after current sync completes.",
      waitingFor: ["dm_messages"],
    });
    expect(snapshot.pages[0]?.blocks.financials.substreams[0]).toMatchObject({
      stream: "transactions",
      state: "scheduled",
      needsAttention: false,
      statusReason: expect.objectContaining({
        code: "queue_waiting",
        waitingFor: ["dm_messages"],
      }),
    });
    expect(snapshot.pages[0]?.syncUx.state).toBe("healthy");
  });

  it("keeps page sync UX blue while history backfill runs and fresh siblings wait in queue", async () => {
    dbMocks.ensureSyncTaskRows.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listSyncTaskRows.mockResolvedValue([
      buildTaskRow({
        task: "light",
        lastSuccessAt: new Date("2026-03-24T11:50:00.000Z"),
      }),
      buildTaskRow({
        task: "transactions",
        status: "queued",
        desiredGeneration: 2,
        appliedGeneration: 1,
        lastSuccessAt: new Date("2026-03-24T11:55:00.000Z"),
        lastRequestedAt: new Date("2026-03-24T11:20:00.000Z"),
      }),
      buildTaskRow({
        task: "subscribers",
        status: "queued",
        desiredGeneration: 2,
        appliedGeneration: 1,
        lastSuccessAt: new Date("2026-03-24T11:54:00.000Z"),
        lastRequestedAt: new Date("2026-03-24T11:20:00.000Z"),
      }),
      buildTaskRow({
        task: "followers",
        status: "queued",
        desiredGeneration: 2,
        appliedGeneration: 1,
        lastSuccessAt: new Date("2026-03-24T11:54:00.000Z"),
        lastRequestedAt: new Date("2026-03-24T11:20:00.000Z"),
      }),
      buildTaskRow({
        task: "dm_conversations",
        status: "queued",
        desiredGeneration: 2,
        appliedGeneration: 1,
        lastSuccessAt: new Date("2026-03-24T11:54:00.000Z"),
        lastRequestedAt: new Date("2026-03-24T11:20:00.000Z"),
      }),
      buildTaskRow({
        task: "dm_messages",
        status: "running",
        desiredGeneration: 1,
        appliedGeneration: 0,
        currentWorkClass: "history",
        lastSuccessAt: null,
        lastStartedAt: new Date("2026-03-24T11:58:00.000Z"),
        lastProgressAt: new Date("2026-03-24T11:59:00.000Z"),
      }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({ stream: "light" }),
      buildMonitorRow({ stream: "transactions" }),
      buildMonitorRow({ stream: "top_spenders" }),
      buildMonitorRow({ stream: "subscribers" }),
      buildMonitorRow({ stream: "followers" }),
      buildMonitorRow({ stream: "dm_conversations" }),
      buildMonitorRow({
        stream: "dm_messages",
        dmEligibleConversationCount: 3669,
        dmBackfillCompleteConversationCount: 203,
        dmLaggingConversationCount: 3466,
      }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.financials.statusReason).toMatchObject({
      code: "queue_waiting",
    });
    expect(snapshot.pages[0]?.blocks.audience.statusReason).toMatchObject({
      code: "queue_waiting",
    });
    expect(snapshot.pages[0]?.blocks.connection.state).toBe("up_to_date");
    expect(snapshot.pages[0]?.blocks.financials.state).toBe("scheduled");
    expect(snapshot.pages[0]?.blocks.audience.state).toBe("scheduled");
    expect(snapshot.pages[0]?.blocks.messages_live.state).toBe("scheduled");
    expect(snapshot.pages[0]?.blocks.messages_history.state).toBe("backfilling");
    expect(snapshot.pages[0]?.syncUx.state).toBe("syncing");
  });

  it("still marks queue waits as delayed when active siblings are in another queue group", async () => {
    dbMocks.ensureSyncTaskRows.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([
      buildVisiblePage(),
      buildVisiblePage({
        id: 8,
        label: "lana-proxy",
        username: "lana_proxy",
        proxyUrl: "http://127.0.0.1:18080",
      }),
    ]);
    dbMocks.listSyncTaskRows.mockResolvedValue([
      buildTaskRow({
        task: "transactions",
        status: "queued",
        desiredGeneration: 2,
        appliedGeneration: 1,
        lastSuccessAt: new Date("2026-03-24T11:55:00.000Z"),
        lastRequestedAt: new Date("2026-03-24T11:20:00.000Z"),
      }),
      buildTaskRow({
        platformAccountId: 8,
        task: "dm_messages",
        status: "running",
        desiredGeneration: 1,
        appliedGeneration: 0,
        currentWorkClass: "history",
        lastSuccessAt: null,
        lastStartedAt: new Date("2026-03-24T11:58:00.000Z"),
        lastProgressAt: new Date("2026-03-24T11:59:00.000Z"),
      }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({ stream: "transactions" }),
      buildMonitorRow({ stream: "top_spenders" }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.financials.state).toBe("delayed");
    expect(snapshot.pages[0]?.blocks.financials.statusReason).toMatchObject({
      code: "queue_delayed",
    });
  });

  it("does not treat stalled sibling work as an active queue owner", async () => {
    dbMocks.ensureSyncTaskRows.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([
      buildVisiblePage(),
      buildVisiblePage({
        id: 8,
        label: "lana-alt",
        username: "lana_alt",
      }),
    ]);
    dbMocks.listSyncTaskRows.mockResolvedValue([
      buildTaskRow({
        task: "transactions",
        status: "queued",
        desiredGeneration: 2,
        appliedGeneration: 1,
        lastSuccessAt: new Date("2026-03-24T11:55:00.000Z"),
        lastRequestedAt: new Date("2026-03-24T11:20:00.000Z"),
      }),
      buildTaskRow({
        platformAccountId: 8,
        task: "dm_messages",
        status: "running",
        desiredGeneration: 1,
        appliedGeneration: 0,
        currentWorkClass: "history",
        lastSuccessAt: null,
        lastStartedAt: new Date("2026-03-24T11:20:00.000Z"),
        lastProgressAt: new Date("2026-03-24T11:00:00.000Z"),
      }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({ stream: "transactions" }),
      buildMonitorRow({ stream: "top_spenders" }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.financials.state).toBe("delayed");
    expect(snapshot.pages[0]?.blocks.financials.statusReason).toMatchObject({
      code: "queue_delayed",
    });
  });
});
