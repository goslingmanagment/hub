import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  ensurePageSyncStates: vi.fn(),
  getOfapiFinancialTruthSummaries: vi.fn(),
  listVisiblePages: vi.fn(),
  listPageSyncStates: vi.fn(),
  listSyncMonitorStreamRows: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof import("@agency_hub_core/db")>("@agency_hub_core/db");
  return {
    ...actual,
    ensurePageSyncStates: dbMocks.ensurePageSyncStates,
    getOfapiFinancialTruthSummaries: dbMocks.getOfapiFinancialTruthSummaries,
    listVisiblePages: dbMocks.listVisiblePages,
    listPageSyncStates: dbMocks.listPageSyncStates,
    listSyncMonitorStreamRows: dbMocks.listSyncMonitorStreamRows,
  };
});

import { getSyncStatusSnapshot } from "../apps/runtime/src/services/sync-status.ts";

function buildTaskRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-03-24T12:00:00.000Z");
  return {
    pageId: 7,
    stream: "light",
    status: "idle",
    requestSeq: 1,
    leasedSeq: null,
    appliedSeq: 1,
    cadenceSeconds: 3600,
    slotOffsetSeconds: 0,
    lastScheduledSlot: 10,
    requestedAt: now,
    enqueuedAt: now,
    startedAt: now,
    progressedAt: now,
    finishedAt: now,
    succeededAt: now,
    failedAt: null,
    retryKind: null,
    retryAt: null,
    blockerKind: null,
    blockerCode: null,
    blockerMessage: null,
    blockedAt: null,
    phase: null,
    workClass: "live",
    progress: {},
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
    dmDeepBackfillPendingConversationCount: 0,
    dmDeepBackfillPendingPageEstimate: 0,
    dmDeepBackfillSpenderPendingConversationCount: 0,
    dmDeepBackfillSpenderPendingPageEstimate: 0,
    dmDeepBackfillRegularPendingConversationCount: 0,
    dmDeepBackfillRegularPendingPageEstimate: 0,
    dmDeepBackfillRecentRequestCount: 0,
    dmDeepBackfillLastCompletedAt: null,
    stream: "light",
    status: "idle",
    cadenceSeconds: 3600,
    nextDueAt: new Date("2026-03-24T13:00:00.000Z"),
    requestSeq: 1,
    appliedSeq: 1,
    requestedAt: new Date("2026-03-24T12:00:00.000Z"),
    retryAt: null,
    enqueuedAt: null,
    startedAt: null,
    finishedAt: null,
    succeededAt: new Date("2026-03-24T12:00:00.000Z"),
    failedAt: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorSummary: null,
    checkpointCursorText: null,
    checkpointCursorTimestamp: null,
    checkpointState: null,
    cursorLastSucceededAt: null,
    cursorLastSucceededRunId: null,
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
    egressKey: "direct",
    proxyHasAuth: false,
    ...overrides,
  };
}

describe("sync status service", () => {
  beforeEach(() => {
    dbMocks.getOfapiFinancialTruthSummaries.mockResolvedValue(new Map());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("aggregates recent monitor counters for health reporting", async () => {
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listPageSyncStates.mockResolvedValue([]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({
        stream: "transactions",
        recentFailedCount: 1,
        recent429Count: 2,
      }),
      buildMonitorRow({
        stream: "followers",
        recentFailedCount: 3,
        recent5xxCount: 4,
      }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.recentCounters).toEqual({
      failedRuns: 4,
      http429s: 2,
      http5xxs: 4,
    });
  });

  it("does not report message history as up_to_date while backlog remains", async () => {
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
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
      egressKey: "direct",
      proxyHasAuth: false,
    }]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({ stream: "light" }),
      buildTaskRow({ stream: "dm_conversations", cadenceSeconds: 1800 }),
      buildTaskRow({ stream: "dm_messages", cadenceSeconds: 86400, workClass: "history" }),
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

  it("keeps message history catching up while deep backfill pages remain", async () => {
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({ stream: "light" }),
      buildTaskRow({ stream: "dm_conversations", cadenceSeconds: 1800 }),
      buildTaskRow({ stream: "dm_messages", cadenceSeconds: 86400, workClass: "history" }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({ stream: "light" }),
      buildMonitorRow({ stream: "dm_conversations", cadenceSeconds: 1800 }),
      buildMonitorRow({
        stream: "dm_messages",
        cadenceSeconds: 86400,
        dmEligibleConversationCount: 10,
        dmBackfillCompleteConversationCount: 10,
        dmLaggingConversationCount: 0,
        dmDeepBackfillPendingConversationCount: 4,
        dmDeepBackfillPendingPageEstimate: 17,
        dmDeepBackfillSpenderPendingConversationCount: 3,
        dmDeepBackfillSpenderPendingPageEstimate: 15,
        dmDeepBackfillRegularPendingConversationCount: 1,
        dmDeepBackfillRegularPendingPageEstimate: 2,
      }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.messages_history).toMatchObject({
      state: "delayed",
      progress: expect.objectContaining({
        label: "10 / 10 conversations ready, 17 deep pages",
        details: expect.objectContaining({
          deepBackfillPendingConversationCount: 4,
          deepBackfillPendingPagesEstimate: 17,
          deepBackfillSpenderPendingPagesEstimate: 15,
          deepBackfillRegularPendingPagesEstimate: 2,
        }),
      }),
      metrics: expect.objectContaining({
        deepBackfillPendingConversationCount: 4,
        deepBackfillPendingPagesEstimate: 17,
        deepBackfillSpenderPendingPagesEstimate: 15,
        deepBackfillRegularPendingPagesEstimate: 2,
      }),
    });
    expect(snapshot.pages[0]?.syncUx.state).toBe("catching_up");
  });

  it("surfaces an auth blocker as failed connection sync and requires action", async () => {
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
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
      egressKey: "direct",
      proxyHasAuth: false,
    }]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({
        stream: "light",
        status: "blocked",
        requestSeq: 2,
        appliedSeq: 1,
        succeededAt: null,
        failedAt: new Date("2026-03-24T11:59:00.000Z"),
        blockerKind: "auth",
        blockerCode: "credentials_invalid",
        blockerMessage: "Session expired",
        lastErrorCode: "auth_blocked",
        lastErrorSummary: "Session expired",
      }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({
        stream: "light",
        succeededAt: null,
        failedAt: new Date("2026-03-24T11:59:00.000Z"),
        lastErrorCode: "auth_blocked",
        lastErrorSummary: "Session expired",
      }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.connection.state).toBe("failed");
    expect(snapshot.pages[0]?.blocks.connection.connectionStatus).toBe("error");
    expect(["credentials_invalid", "auth_blocked"]).toContain(
      snapshot.pages[0]?.blocks.connection.error?.code ?? null,
    );
    expect(snapshot.pages[0]?.blocks.connection.error?.summary).toBe("Session expired");
    expect(snapshot.pages[0]?.syncUx.state).toBe("attention");
  });

  it("reports OFAPI-mapped OnlyFans connection as connected without legacy credentials", async () => {
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage({
      platform: "onlyfans",
      hasCredentials: false,
      ofapiAccountId: "acct_test",
      ofapiAuthStatus: null,
      ofapiAuthChangedAt: null,
      lastLightSyncAt: null,
      lastFollowerSyncAt: null,
    })]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({
        stream: "light",
        status: "paused",
        succeededAt: null,
        progressedAt: null,
      }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({
        stream: "light",
        succeededAt: null,
      }),
    ]);

    const snapshot = await getSyncStatusSnapshot({
      db: {},
      config: {
        ofapiAccountHealthEnabled: true,
      },
    } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.connection).toMatchObject({
      state: "up_to_date",
      connectionStatus: "connected",
      primaryFresh: true,
      needsAttention: false,
      statusReason: {
        code: "ofapi_auth_connected",
      },
      metrics: {
        ofapiAuthStatus: null,
      },
    });
  });

  it("does not mask credentialed OnlyFans connection failures with OFAPI auth health", async () => {
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage({
      platform: "onlyfans",
      hasCredentials: true,
      ofapiAccountId: "acct_test",
      ofapiAuthStatus: null,
      ofapiAuthChangedAt: null,
    })]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({
        stream: "light",
        status: "blocked",
        succeededAt: null,
        progressedAt: null,
        blockerKind: "auth",
        blockerCode: "credentials_invalid",
        blockerMessage: "Session expired",
        lastErrorCode: "credentials_invalid",
        lastErrorSummary: "Session expired",
      }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({
        stream: "light",
        succeededAt: null,
      }),
    ]);

    const snapshot = await getSyncStatusSnapshot({
      db: {},
      config: {
        ofapiAccountHealthEnabled: true,
      },
    } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.connection).toMatchObject({
      state: "failed",
      connectionStatus: "error",
      primaryFresh: false,
      needsAttention: true,
      statusReason: {
        code: "credentials_invalid",
        summary: "Session expired",
      },
      error: {
        code: "credentials_invalid",
        summary: "Session expired",
      },
    });
  });

  it("reports OFAPI-mapped OnlyFans financials from transaction truth without legacy credentials", async () => {
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
    dbMocks.getOfapiFinancialTruthSummaries.mockResolvedValue(new Map([
      [7, {
        pageId: 7,
        transactionCount: 677,
        latestTransactionAt: new Date("2026-06-30T14:43:46.000Z"),
      }],
    ]));
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage({
      platform: "onlyfans",
      hasCredentials: false,
      ofapiAccountId: "acct_test",
      ofapiAuthStatus: null,
      ofapiAuthChangedAt: null,
      lastLightSyncAt: null,
      lastFollowerSyncAt: null,
    })]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({
        stream: "transactions",
        status: "paused",
        succeededAt: null,
        progressedAt: null,
        lastErrorCode: "bad_request",
        lastErrorSummary: "Page \"7\" has no stored platform credentials",
      }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({
        stream: "transactions",
        succeededAt: null,
        transactionCount: 0,
      }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {} } as never, {
      pageIds: [7],
      now: new Date("2026-07-02T00:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.financials).toMatchObject({
      state: "up_to_date",
      succeededAt: "2026-06-30T14:43:46.000Z",
      primaryFresh: true,
      needsAttention: false,
      statusReason: {
        code: "ofapi_financials_live",
      },
      metrics: {
        ofapiFinancials: true,
        transactionCount: 677,
        lastOfapiTransactionAt: "2026-06-30T14:43:46.000Z",
      },
    });
  });

  it("does not mask credentialed OnlyFans financial failures with OFAPI transaction truth", async () => {
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
    dbMocks.getOfapiFinancialTruthSummaries.mockResolvedValue(new Map([
      [7, {
        pageId: 7,
        transactionCount: 677,
        latestTransactionAt: new Date("2026-06-30T14:43:46.000Z"),
      }],
    ]));
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage({
      platform: "onlyfans",
      hasCredentials: true,
      ofapiAccountId: "acct_test",
      ofapiAuthStatus: null,
      ofapiAuthChangedAt: null,
      lastLightSyncAt: null,
      lastFollowerSyncAt: null,
    })]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({
        stream: "transactions",
        status: "blocked",
        succeededAt: null,
        progressedAt: null,
        blockerKind: "auth",
        blockerCode: "credentials_invalid",
        blockerMessage: "Legacy session expired",
        lastErrorCode: "credentials_invalid",
        lastErrorSummary: "Legacy session expired",
      }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({
        stream: "transactions",
        succeededAt: null,
        transactionCount: 0,
      }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
      pageIds: [7],
      now: new Date("2026-07-02T00:00:00.000Z"),
    });

    expect(dbMocks.getOfapiFinancialTruthSummaries).not.toHaveBeenCalled();
    expect(snapshot.pages[0]?.blocks.financials).toMatchObject({
      state: "failed",
      primaryFresh: false,
      needsAttention: true,
      statusReason: {
        code: "credentials_invalid",
        summary: "Legacy session expired",
      },
      error: {
        code: "credentials_invalid",
        summary: "Legacy session expired",
      },
    });
  });

  it("prefers the current dependency blocker over stale last-error fields", async () => {
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
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
      egressKey: "direct",
      proxyHasAuth: false,
    }]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({ stream: "light" }),
      buildTaskRow({ stream: "transactions" }),
      buildTaskRow({
        stream: "dm_conversations",
        cadenceSeconds: 1800,
        status: "blocked",
        requestSeq: 2,
        appliedSeq: 1,
        succeededAt: null,
        blockerKind: "dependency",
        blockerCode: "unmet_dependency",
        blockerMessage: "Waiting for light, transactions",
        lastErrorCode: "http_500",
        lastErrorSummary: "Old transport failure",
        failedAt: new Date("2026-03-24T11:30:00.000Z"),
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
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({
        stream: "transactions",
        succeededAt: new Date("2026-03-24T11:55:00.000Z"),
      }),
      buildTaskRow({
        stream: "top_spenders",
        status: "running",
        requestSeq: 1,
        appliedSeq: 0,
        workClass: "maintenance",
        succeededAt: null,
        progress: {
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
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({
        stream: "light",
        succeededAt: new Date("2026-03-24T11:50:00.000Z"),
      }),
      buildTaskRow({
        stream: "transactions",
        status: "queued",
        requestSeq: 2,
        appliedSeq: 1,
        succeededAt: new Date("2026-03-24T11:55:00.000Z"),
        requestedAt: new Date("2026-03-24T11:40:00.000Z"),
      }),
      buildTaskRow({
        stream: "top_spenders",
        succeededAt: new Date("2026-03-24T11:56:00.000Z"),
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

  it("surfaces OFAPI budget blocks instead of generic queue delays", async () => {
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([
      buildVisiblePage({
        platform: "onlyfans",
        username: "loravie",
        ofapiAccountId: "acct_lora",
      }),
    ]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({
        stream: "subscribers",
        status: "pending",
        requestSeq: 2,
        appliedSeq: 0,
        requestedAt: new Date("2026-03-24T11:30:00.000Z"),
        retryAt: new Date("2026-03-24T13:00:00.000Z"),
        succeededAt: null,
        progress: {
          mode: "audience_sweep",
          offset: 1880,
          pageCount: 98,
          ofapiBudgetBlock: "ofapi_daily_credit_budget",
        },
      }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({
        stream: "subscribers",
        platform: "onlyfans",
        status: "pending",
        succeededAt: null,
      }),
    ]);

    const snapshot = await getSyncStatusSnapshot({
      db: {},
      config: { ofapiAudienceSyncEnabled: true },
    } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.audience).toMatchObject({
      state: "delayed",
      statusReason: {
        code: "ofapi_daily_credit_budget",
        summary: "OFAPI daily credit budget reached; sync will resume after the UTC budget reset.",
      },
    });
    expect(snapshot.pages[0]?.blocks.audience.substreams[0]).toMatchObject({
      stream: "subscribers",
      state: "delayed",
      statusReason: expect.objectContaining({
        code: "ofapi_daily_credit_budget",
      }),
    });
  });

  it("ignores stale OFAPI budget markers left on completed progress payloads", async () => {
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([
      buildVisiblePage({
        platform: "onlyfans",
        username: "loravie",
        ofapiAccountId: "acct_lora",
      }),
    ]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({
        stream: "subscribers",
        status: "pending",
        requestSeq: 2,
        appliedSeq: 1,
        requestedAt: new Date("2026-03-24T11:59:00.000Z"),
        succeededAt: new Date("2026-03-24T11:58:00.000Z"),
        progress: {
          mode: "audience_sweep",
          skipped: "sweep_not_due",
          fullSweepCompleted: true,
          ofapiBudgetBlock: "ofapi_daily_credit_budget",
        },
      }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({
        stream: "subscribers",
        platform: "onlyfans",
        status: "pending",
        succeededAt: new Date("2026-03-24T11:58:00.000Z"),
      }),
    ]);

    const snapshot = await getSyncStatusSnapshot({
      db: {},
      config: { ofapiAudienceSyncEnabled: true },
    } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.audience).toMatchObject({
      state: "scheduled",
      statusReason: null,
    });
    expect(snapshot.pages[0]?.blocks.audience.substreams[0]).toMatchObject({
      stream: "subscribers",
      state: "scheduled",
      statusReason: null,
    });
  });

  it("treats fresh queue waits as healthy when a sibling page is actively using the same queue group", async () => {
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([
      buildVisiblePage(),
      buildVisiblePage({
        id: 8,
        label: "lana-alt",
        username: "lana_alt",
      }),
    ]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({
        stream: "transactions",
        status: "queued",
        requestSeq: 2,
        appliedSeq: 1,
        succeededAt: new Date("2026-03-24T11:55:00.000Z"),
        requestedAt: new Date("2026-03-24T11:20:00.000Z"),
      }),
      buildTaskRow({
        pageId: 8,
        stream: "dm_messages",
        status: "running",
        requestSeq: 1,
        appliedSeq: 0,
        workClass: "history",
        succeededAt: null,
        startedAt: new Date("2026-03-24T11:58:00.000Z"),
        progressedAt: new Date("2026-03-24T11:59:00.000Z"),
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

  it("does not mark a fresh running lease stalled because an older progress timestamp exists", async () => {
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({ stream: "light" }),
      buildTaskRow({
        stream: "dm_conversations",
        status: "running",
        requestSeq: 2,
        leasedSeq: 2,
        appliedSeq: 1,
        succeededAt: new Date("2026-03-24T11:45:00.000Z"),
        startedAt: new Date("2026-03-24T11:59:00.000Z"),
        progressedAt: new Date("2026-03-24T11:30:00.000Z"),
      }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({ stream: "light" }),
      buildMonitorRow({ stream: "dm_conversations" }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.messages_live).toMatchObject({
      state: "syncing",
      statusReason: null,
    });
    expect(snapshot.pages[0]?.blocks.messages_live.substreams).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stream: "dm_conversations",
        state: "syncing",
        statusReason: null,
      }),
    ]));
  });

  it("keeps page sync UX blue while history backfill runs and fresh siblings wait in queue", async () => {
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({
        stream: "light",
        succeededAt: new Date("2026-03-24T11:50:00.000Z"),
      }),
      buildTaskRow({
        stream: "transactions",
        status: "queued",
        requestSeq: 2,
        appliedSeq: 1,
        succeededAt: new Date("2026-03-24T11:55:00.000Z"),
        requestedAt: new Date("2026-03-24T11:20:00.000Z"),
      }),
      buildTaskRow({
        stream: "subscribers",
        status: "queued",
        requestSeq: 2,
        appliedSeq: 1,
        succeededAt: new Date("2026-03-24T11:54:00.000Z"),
        requestedAt: new Date("2026-03-24T11:20:00.000Z"),
      }),
      buildTaskRow({
        stream: "followers",
        status: "queued",
        requestSeq: 2,
        appliedSeq: 1,
        succeededAt: new Date("2026-03-24T11:54:00.000Z"),
        requestedAt: new Date("2026-03-24T11:20:00.000Z"),
      }),
      buildTaskRow({
        stream: "dm_conversations",
        status: "queued",
        requestSeq: 2,
        appliedSeq: 1,
        succeededAt: new Date("2026-03-24T11:54:00.000Z"),
        requestedAt: new Date("2026-03-24T11:20:00.000Z"),
      }),
      buildTaskRow({
        stream: "dm_messages",
        status: "running",
        requestSeq: 1,
        appliedSeq: 0,
        workClass: "history",
        succeededAt: null,
        startedAt: new Date("2026-03-24T11:58:00.000Z"),
        progressedAt: new Date("2026-03-24T11:59:00.000Z"),
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
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([
      buildVisiblePage(),
      buildVisiblePage({
        id: 8,
        label: "lana-proxy",
        username: "lana_proxy",
        proxyUrl: "http://127.0.0.1:18080",
        egressKey: "http://127.0.0.1:18080",
      }),
    ]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({
        stream: "transactions",
        status: "queued",
        requestSeq: 2,
        appliedSeq: 1,
        succeededAt: new Date("2026-03-24T11:55:00.000Z"),
        requestedAt: new Date("2026-03-24T11:20:00.000Z"),
      }),
      buildTaskRow({
        pageId: 8,
        stream: "dm_messages",
        status: "running",
        requestSeq: 1,
        appliedSeq: 0,
        workClass: "history",
        succeededAt: null,
        startedAt: new Date("2026-03-24T11:58:00.000Z"),
        progressedAt: new Date("2026-03-24T11:59:00.000Z"),
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
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([
      buildVisiblePage(),
      buildVisiblePage({
        id: 8,
        label: "lana-alt",
        username: "lana_alt",
      }),
    ]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({
        stream: "transactions",
        status: "queued",
        requestSeq: 2,
        appliedSeq: 1,
        succeededAt: new Date("2026-03-24T11:55:00.000Z"),
        requestedAt: new Date("2026-03-24T11:20:00.000Z"),
      }),
      buildTaskRow({
        pageId: 8,
        stream: "dm_messages",
        status: "running",
        requestSeq: 1,
        appliedSeq: 0,
        workClass: "history",
        succeededAt: null,
        startedAt: new Date("2026-03-24T11:20:00.000Z"),
        progressedAt: new Date("2026-03-24T11:00:00.000Z"),
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
