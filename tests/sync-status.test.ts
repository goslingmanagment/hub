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
    expect(snapshot.pages[0]?.syncUx.state).toBe("attention");
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
});
