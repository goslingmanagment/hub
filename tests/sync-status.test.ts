import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";

const dbMocks = vi.hoisted(() => ({
  ensurePageSyncStates: vi.fn(),
  getConfigOverrides: vi.fn(),
  getOfapiFinancialTruthSummaries: vi.fn(),
  listVisiblePages: vi.fn(),
  listPageSyncStates: vi.fn(),
  listCheckpointStates: vi.fn(),
  listSyncMonitorStreamRows: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof DbModule>("@agency_hub_core/db");
  return {
    ...actual,
    ensurePageSyncStates: dbMocks.ensurePageSyncStates,
    getConfigOverrides: dbMocks.getConfigOverrides,
    getOfapiFinancialTruthSummaries: dbMocks.getOfapiFinancialTruthSummaries,
    listVisiblePages: dbMocks.listVisiblePages,
    listPageSyncStates: dbMocks.listPageSyncStates,
    listCheckpointStates: dbMocks.listCheckpointStates,
    listSyncMonitorStreamRows: dbMocks.listSyncMonitorStreamRows,
  };
});

import { getSyncStatusSnapshot, mapDomainBlockToSyncUx } from "../apps/runtime/src/services/sync-status.ts";
import { buildConversationHistorySyncUx } from "../apps/runtime/src/services/sync-ux.ts";

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
    recentPhysicalAttemptCount: 0,
    recentPhysicalSuccessCount: 0,
    stalePhysicalAttemptCount: 0,
    physicalAttemptsSinceLastSuccess: 0,
    lastPhysicalSuccessAt: null,
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

function boundedCheckpoint(fullCompletedAt: string | null) {
  return {
    version: 2, mode: "bounded", generation: 7,
    completedAt: "2026-03-24T12:00:00.000Z", offset: 300, observedCount: 300,
    pageCount: 3, unchangedPageStreak: 3, providerTotalMode: "present", providerReportedTotal: 500,
    fullSweepStartedAt: "2026-03-24T11:59:00.000Z", lastFullSweepCompletedAt: fullCompletedAt,
    polling: { anchorSlot: 100, slotOffsetSeconds: 0, lastCertifiedFull: fullCompletedAt === null ? null : {
      anchorSlot: 100, startedAt: "2026-03-24T10:00:00.000Z", completedAt: fullCompletedAt,
    } },
    previousTimestampMs: null, stopInvalidated: false,
  };
}

describe("sync status service", () => {
  beforeEach(() => {
    dbMocks.getOfapiFinancialTruthSummaries.mockResolvedValue(new Map());
    dbMocks.getConfigOverrides.mockResolvedValue(new Map());
    dbMocks.listCheckpointStates.mockResolvedValue([]);
    // Read paths never seed: `getSyncStatusSnapshot` serves GETs, so any call
    // into the seeding/repair writer is a regression, not a slow path. Every
    // test in this file therefore fails loudly if the read path writes.
    dbMocks.ensurePageSyncStates.mockImplementation(() => {
      throw new Error("getSyncStatusSnapshot must not seed page_sync_states");
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([true, false])("keeps full freshness separate from a recent bounded pass, monitor=%s", async (includeMonitorRows) => {
    const fullCompletedAt = "2026-03-24T10:12:00.000Z";
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listPageSyncStates.mockResolvedValue([buildTaskRow({ stream: "dm_conversations" })]);
    dbMocks.listCheckpointStates.mockResolvedValue([{ pageId: 7, state: boundedCheckpoint(fullCompletedAt) }]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([buildMonitorRow({ stream: "dm_conversations" })]);
    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
      pageIds: [7], now: new Date("2026-03-24T12:00:00.000Z"), includeMonitorRows,
    });
    expect(snapshot.pages[0]?.blocks.messages_live).toMatchObject({
      state: "delayed", primaryFresh: false,
      metrics: expect.objectContaining({ lastFullSweepCompletedAt: fullCompletedAt }),
      progress: expect.objectContaining({ percent: null, percentValid: false, total: null }),
      substreams: expect.arrayContaining([expect.objectContaining({
        stream: "dm_conversations", succeededAt: fullCompletedAt, state: "delayed",
      })]),
    });
    if (!includeMonitorRows) expect(dbMocks.listSyncMonitorStreamRows).not.toHaveBeenCalled();
  });

  it.each([
    // Decision 366: an accepted 180-minute full interval promises a certified
    // full within 210 minutes of the last one; a 30-minute policy keeps the
    // 60-minute target. The certified full below completed at 10:12.
    [180, "2026-03-24T13:41:00.000Z", "up_to_date", true],
    [180, "2026-03-24T13:43:00.000Z", "delayed", false],
    [30, "2026-03-24T11:13:00.000Z", "delayed", false],
  ])("judges full freshness against the page's accepted full interval %s at %s", async (fullIntervalMinutes, nowIso, state, fresh) => {
    const fullCompletedAt = "2026-03-24T10:12:00.000Z";
    dbMocks.getConfigOverrides.mockResolvedValue(new Map([
      ["fanslyDmBoundedEnabled", { value: true, version: 1 }],
      ["fanslyDmBoundedPageAllowlist", { value: "lana", version: 1 }],
      ["fanslyDmBoundedPolicies", { value: JSON.stringify({ lana: { fullIntervalMinutes } }), version: 1 }],
    ]));
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listPageSyncStates.mockResolvedValue([buildTaskRow({ stream: "dm_conversations" })]);
    dbMocks.listCheckpointStates.mockResolvedValue([{ pageId: 7, state: boundedCheckpoint(fullCompletedAt) }]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([buildMonitorRow({ stream: "dm_conversations" })]);
    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
      pageIds: [7], now: new Date(nowIso),
    });
    expect(snapshot.pages[0]?.blocks.messages_live).toMatchObject({
      state, primaryFresh: fresh,
      substreams: expect.arrayContaining([expect.objectContaining({
        stream: "dm_conversations", succeededAt: fullCompletedAt, state, isFresh: fresh,
      })]),
    });
  });

  it.each(["ready", "coverage", "physical debt", "active sibling"] as const)(
    "preserves preview DM blocks and UX with a scoped monitor read: %s",
    async (scenario) => {
      const now = new Date("2026-03-24T12:00:00.000Z");
      const dmStreams: DbModule.SyncStream[] = ["dm_conversations", "dm_messages"];
      dbMocks.listVisiblePages.mockResolvedValue([
        buildVisiblePage(),
        buildVisiblePage({ id: 8, label: "lana-alt" }),
      ]);
      dbMocks.listPageSyncStates.mockResolvedValue([
        buildTaskRow({
          stream: "dm_conversations",
          ...(scenario === "active sibling" ? {
            status: "queued", requestSeq: 2, appliedSeq: 1,
            requestedAt: new Date("2026-03-24T11:20:00.000Z"),
          } : {}),
        }),
        buildTaskRow({ stream: "dm_messages", workClass: "history" }),
        // A different page and non-DM stream still owns the same runtime group.
        buildTaskRow({
          pageId: 8, stream: "transactions", status: "running", requestSeq: 2,
          appliedSeq: 1, startedAt: now, progressedAt: now,
        }),
      ]);
      const monitorRows = [
        buildMonitorRow({ stream: "dm_conversations" }),
        buildMonitorRow({
          stream: "dm_messages",
          ...(scenario === "coverage" ? {
            dmBackfillCompleteConversationCount: 4,
            dmLaggingConversationCount: 1,
            dmDeepBackfillPendingConversationCount: 1,
            dmDeepBackfillPendingPageEstimate: 3,
          } : {}),
          ...(scenario === "physical debt" ? {
            stalePhysicalAttemptCount: 1, physicalAttemptsSinceLastSuccess: 2,
            recentPhysicalAttemptCount: 0, recentPhysicalSuccessCount: 0,
            lastPhysicalSuccessAt: new Date("2026-03-20T00:00:00.000Z"),
          } : {}),
        }),
        buildMonitorRow({
          stream: "transactions", stalePhysicalAttemptCount: 99,
          physicalAttemptsSinceLastSuccess: 999, transactionCount: 100_000,
        }),
      ];
      dbMocks.listSyncMonitorStreamRows.mockImplementation(
        async (_db: unknown, input: Parameters<typeof DbModule.listSyncMonitorStreamRows>[1]) => {
          const requested = new Set<string>(input?.streams);
          return monitorRows.filter((row) => requested.has(row.stream));
        },
      );
      const app = { db: {}, config: {} };
      const full = await getSyncStatusSnapshot(app as never, { pageIds: [7], now });
      const scoped = await getSyncStatusSnapshot(app as never, { pageIds: [7], now, monitorStreams: dmStreams });
      const fullPage = full.pages[0]!;
      const scopedPage = scoped.pages[0]!;
      for (const block of ["messages_live", "messages_history"] as const) {
        expect(scopedPage.blocks[block]).toEqual(fullPage.blocks[block]);
      }
      const previewUx = (page: typeof fullPage) => buildConversationHistorySyncUx({
        conversationSyncUx: mapDomainBlockToSyncUx(page.blocks.messages_live),
        messageSyncUx: mapDomainBlockToSyncUx(page.blocks.messages_history),
        pendingMessageBackfillCount: scenario === "coverage" ? 2 : 0,
        previewReadyConversationCount: 4,
      });
      expect(previewUx(scopedPage)).toEqual(previewUx(fullPage));
      expect(dbMocks.listSyncMonitorStreamRows).toHaveBeenLastCalledWith(app.db, {
        pageIds: [7], now, streams: dmStreams,
        windowStart: new Date("2026-03-23T12:00:00.000Z"),
      });
      expect(dbMocks.listPageSyncStates).toHaveBeenLastCalledWith(app.db);
      if (scenario === "coverage") {
        expect(scopedPage.blocks.messages_history).toMatchObject({
          state: "delayed", statusReason: { code: "history_incomplete" },
          progress: { label: "4 / 6 conversations ready, 1 lagging, 3 deep pages" },
        });
      } else if (scenario === "physical debt") {
        expect(previewUx(scopedPage).state).toBe("attention");
        expect(scopedPage.blocks.messages_history.statusReason?.code).toBe("physical_attempt_stuck");
      } else if (scenario === "active sibling") {
        expect(scopedPage.blocks.messages_live).toMatchObject({
          state: "scheduled", statusReason: { code: "queue_waiting", waitingFor: ["transactions"] },
        });
        expect(previewUx(scopedPage).state).toBe("healthy");
      } else {
        expect(previewUx(scopedPage).state).toBe("healthy");
      }
    },
  );

  it("aggregates recent monitor counters for health reporting", async () => {
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

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.recentCounters).toEqual({
      failedRuns: 4,
      http429s: 2,
      http5xxs: 4,
    });
  });

  it("reports physical request health independently from logical run outcomes", async () => {
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({ stream: "light" }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({
        stream: "light",
        recentPhysicalAttemptCount: 10,
        recentPhysicalSuccessCount: 3,
        physicalAttemptsSinceLastSuccess: 7,
        lastPhysicalSuccessAt: new Date("2026-03-24T10:00:00.000Z"),
      }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.connection.metrics).toMatchObject({
      physicalAttemptCount24h: 10,
      physicalSuccessCount24h: 3,
      physicalSuccessRate24h: 0.3,
      maxPhysicalAttemptsSinceLastSuccess: 7,
      stalePhysicalAttemptCount: 0,
      physicalAttemptsSinceLastSuccessByStream: { light: 7 },
    });
    expect(snapshot.pages[0]?.blocks.connection).toMatchObject({
      state: "failed",
      needsAttention: true,
      statusReason: {
        code: "physical_attempts_without_success",
      },
    });
  });

  it("marks a lane unhealthy when a physical attempt is stuck past its deadline", async () => {
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({ stream: "light" }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({
        stream: "light",
        recentPhysicalAttemptCount: 1,
        stalePhysicalAttemptCount: 1,
        physicalAttemptsSinceLastSuccess: 1,
      }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.connection).toMatchObject({
      state: "failed",
      needsAttention: true,
      statusReason: {
        code: "physical_attempt_stuck",
      },
      metrics: {
        stalePhysicalAttemptCount: 1,
      },
    });
  });

  it("does not report message history as up_to_date while backlog remains", async () => {
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

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
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

  it("keeps a live failure streak visible on a running task (#137 addendum: false-green)", async () => {
    // Prod 2026-07-11: a 425-streak dm_messages task flipped retrying →
    // running between failures and the snapshot nulled its error, so
    // /health/sync read 200/ok mid-wedge. The streak resets only on a real
    // success — the task error must survive every state until then.
    dbMocks.listVisiblePages.mockResolvedValue([{
      id: 9,
      label: "lora-vip-fansly",
      platform: "fansly",
      username: "lora_vip",
      displayName: "Lora VIP",
      followerCount: 9,
      subscriberCount: 4,
      lastLightSyncAt: new Date("2026-03-24T12:00:00.000Z"),
      lastFollowerSyncAt: null,
      modelSlug: "lora",
      modelName: "Lora",
      hasCredentials: true,
      proxyUrl: null,
      egressKey: "direct",
      proxyHasAuth: false,
    }]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({ pageId: 9, stream: "light" }),
      buildTaskRow({ pageId: 9, stream: "dm_conversations", cadenceSeconds: 1800 }),
      buildTaskRow({
        pageId: 9,
        stream: "dm_messages",
        cadenceSeconds: 86400,
        workClass: "history",
        status: "running",
        succeededAt: null,
        startedAt: new Date("2026-03-24T11:58:00.000Z"),
        progressedAt: new Date("2026-03-24T11:59:30.000Z"),
        finishedAt: null,
        failedAt: new Date("2026-03-24T11:55:00.000Z"),
        consecutiveFailures: 425,
        lastErrorCode: null,
        lastErrorSummary: "OFAPI request failed: GET .../chats/292065372/messages",
        leaseOwner: "worker-1",
        leaseToken: "token",
        leaseHeartbeatAt: new Date("2026-03-24T11:59:30.000Z"),
        leaseExpiresAt: new Date("2026-03-24T12:05:00.000Z"),
      }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({ pageId: 9, pageLabel: "lora-vip-fansly", stream: "light" }),
      buildMonitorRow({ pageId: 9, pageLabel: "lora-vip-fansly", stream: "dm_conversations", cadenceSeconds: 1800 }),
      buildMonitorRow({
        pageId: 9,
        pageLabel: "lora-vip-fansly",
        stream: "dm_messages",
        cadenceSeconds: 86400,
        status: "running",
        succeededAt: null,
        failedAt: new Date("2026-03-24T11:55:00.000Z"),
        consecutiveFailures: 425,
        lastErrorSummary: "OFAPI request failed: GET .../chats/292065372/messages",
      }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
      pageIds: [9],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    const historyBlock = snapshot.pages[0]?.blocks.messages_history;
    const dmTask = historyBlock?.tasks?.find((task) => task.stream === "dm_messages");
    expect(dmTask?.error).toMatchObject({
      consecutiveFailures: 425,
      summary: "OFAPI request failed: GET .../chats/292065372/messages",
    });
  });

  it("keeps message history catching up while deep backfill pages remain", async () => {
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

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
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

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
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

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
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

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
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

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
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

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
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

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
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

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
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

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
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

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.financials.state).toBe("delayed");
    expect(snapshot.pages[0]?.blocks.financials.statusReason).toMatchObject({
      code: "queue_delayed",
    });
  });

  it("does not treat stalled sibling work as an active queue owner", async () => {
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

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.financials.state).toBe("delayed");
    expect(snapshot.pages[0]?.blocks.financials.statusReason).toMatchObject({
      code: "queue_delayed",
    });
  });

  it("never seeds page_sync_states, and reports a page that has no state rows", async () => {
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listPageSyncStates.mockResolvedValue([]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([]);

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(dbMocks.ensurePageSyncStates).not.toHaveBeenCalled();
    expect(snapshot.pages).toHaveLength(1);
    expect(snapshot.pages[0]?.pageId).toBe(7);
  });
});
