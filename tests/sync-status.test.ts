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
    // No page is the Fansly Sync Engine's here (its blocks: tests/sync-engine-health).
    listSyncPages: async () => [],
  };
});

// The legacy blocks are those of the legacy page-sync executor's pages:
// OnlyFans. The page of these tests is a credentialed OnlyFans page with no
// OFAPI mapping, so no OFAPI overlay replaces a block and each one is derived
// from its legacy stream rows.

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
    platform: "onlyfans",
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
    platform: "onlyfans",
    username: "lana_page",
    displayName: "Lana",
    followerCount: null,
    subscriberCount: 4,
    lastLightSyncAt: new Date("2026-03-24T12:00:00.000Z"),
    lastFollowerSyncAt: null,
    ofapiAccountId: null,
    ofapiAuthStatus: null,
    ofapiAuthChangedAt: null,
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

  // Step 4 (S4-24): the legacy blocks describe the legacy executor's pages
  // only. A Fansly page is the Fansly Sync Engine's; one the engine does not
  // own is read by nothing, and no legacy row speaks for it.
  it("reads a Fansly page the engine does not own as not syncing, whatever its legacy rows say", async () => {
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage({ platform: "fansly" })]);
    // The parked rows of the page (step 4, S4-21), were the scoped read to return them.
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({ stream: "light", status: "paused", blockerKind: "retired" }),
      buildTaskRow({ stream: "followers", status: "paused", blockerKind: "retired" }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([]);

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: { fanslyDefaultDelayMs: 2_200 } } as never, {
      pageIds: [7], now: new Date("2026-03-24T12:00:00.000Z"),
    });

    const page = snapshot.pages[0]!;
    for (const block of Object.values(page.blocks)) {
      expect(block).toMatchObject({
        state: "not_available",
        needsAttention: false,
        substreams: [],
        tasks: [],
        statusReason: { code: "fansly_sync_engine_off", summary: "The Fansly Sync Engine does not run this page: nothing reads it." },
      });
    }
    expect(page.syncUx).toMatchObject({ state: "off", label: "Off", headline: "Not syncing" });
  });

  it("reads legacy rows of the legacy executor's platforms only, and no record row as a stream", async () => {
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({ stream: "light" }),
      buildTaskRow({ stream: "dm_conversations" }),
      // OnlyFans's retired legacy crawler: a parked record, not a stream.
      buildTaskRow({ stream: "dm_messages", status: "paused", blockerKind: "retired", succeededAt: null }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([]);
    const app = { db: {}, config: {} };

    const snapshot = await getSyncStatusSnapshot(app as never, { pageIds: [7], now: new Date("2026-03-24T12:00:00.000Z") });

    expect(dbMocks.listPageSyncStates).toHaveBeenLastCalledWith(app.db, { platforms: ["onlyfans"] });
    const page = snapshot.pages[0]!;
    expect(page.blocks.messages_live).toMatchObject({
      state: "up_to_date", primaryFresh: true,
      substreams: [expect.objectContaining({ stream: "dm_conversations", state: "up_to_date" })],
    });
    expect(page.blocks.messages_history).toMatchObject({ state: "not_available", statusReason: null, substreams: [] });
    expect(Object.values(page.blocks).flatMap((block) => block.substreams.map((substream) => substream.stream)))
      .not.toContain("dm_messages");
  });

  it.each(["ready", "physical debt", "active sibling"] as const)(
    "preserves the preview's DM block and UX with a scoped monitor read: %s",
    async (scenario) => {
      const now = new Date("2026-03-24T12:00:00.000Z");
      const dmStreams: DbModule.SyncStream[] = ["dm_conversations"];
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
        // A different page and non-DM stream still owns the same runtime group.
        buildTaskRow({
          pageId: 8, stream: "transactions", status: "running", requestSeq: 2,
          appliedSeq: 1, startedAt: now, progressedAt: now,
        }),
      ]);
      const monitorRows = [
        buildMonitorRow({
          stream: "dm_conversations",
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
        pendingMessageBackfillCount: 0,
        previewReadyConversationCount: 4,
      });
      expect(previewUx(scopedPage)).toEqual(previewUx(fullPage));
      expect(dbMocks.listSyncMonitorStreamRows).toHaveBeenLastCalledWith(app.db, {
        pageIds: [7], now, streams: dmStreams,
        windowStart: new Date("2026-03-23T12:00:00.000Z"),
      });
      if (scenario === "physical debt") {
        expect(previewUx(scopedPage).state).toBe("attention");
        expect(scopedPage.blocks.messages_live.statusReason?.code).toBe("physical_attempt_stuck");
      } else if (scenario === "active sibling") {
        expect(scopedPage.blocks.messages_live).toMatchObject({
          state: "scheduled", statusReason: { code: "queue_waiting", waitingFor: ["transactions"] },
        });
        // The history block is not available on the page, which reads as off.
        expect(previewUx(scopedPage).state).toBe("off");
      } else {
        expect(previewUx(scopedPage).state).toBe("off");
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
        stream: "dm_conversations",
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

  it("keeps a live failure streak visible on a running task (#137 addendum: false-green)", async () => {
    // Prod 2026-07-11: a 425-streak task flipped retrying → running between
    // failures and the snapshot nulled its error, so /health/sync read 200/ok
    // mid-wedge. The streak resets only on a real success — the task error
    // must survive every state until then.
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage({ id: 9, label: "lora-vip-of", username: "lora_vip" })]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({ pageId: 9, stream: "light" }),
      buildTaskRow({
        pageId: 9,
        stream: "dm_conversations",
        cadenceSeconds: 1800,
        status: "running",
        succeededAt: null,
        startedAt: new Date("2026-03-24T11:58:00.000Z"),
        progressedAt: new Date("2026-03-24T11:59:30.000Z"),
        finishedAt: null,
        failedAt: new Date("2026-03-24T11:55:00.000Z"),
        consecutiveFailures: 425,
        lastErrorCode: null,
        lastErrorSummary: "OFAPI request failed: GET .../chats",
        leaseOwner: "worker-1",
        leaseToken: "token",
        leaseHeartbeatAt: new Date("2026-03-24T11:59:30.000Z"),
        leaseExpiresAt: new Date("2026-03-24T12:05:00.000Z"),
      }),
    ]);
    dbMocks.listSyncMonitorStreamRows.mockResolvedValue([
      buildMonitorRow({ pageId: 9, pageLabel: "lora-vip-of", stream: "light" }),
      buildMonitorRow({
        pageId: 9,
        pageLabel: "lora-vip-of",
        stream: "dm_conversations",
        cadenceSeconds: 1800,
        status: "running",
        succeededAt: null,
        failedAt: new Date("2026-03-24T11:55:00.000Z"),
        consecutiveFailures: 425,
        lastErrorSummary: "OFAPI request failed: GET .../chats",
      }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
      pageIds: [9],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    const liveBlock = snapshot.pages[0]?.blocks.messages_live;
    const dmTask = liveBlock?.tasks?.find((task) => task.stream === "dm_conversations");
    expect(dmTask?.error).toMatchObject({
      consecutiveFailures: 425,
      summary: "OFAPI request failed: GET .../chats",
    });
  });

  it("surfaces an auth blocker as failed connection sync and requires action", async () => {
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage({ lastLightSyncAt: null })]);
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
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
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

  it("drops a retry deadline that pending work has already waited out", async () => {
    // The planner keeps a passed retry_at on pending work; status must read
    // it as neither a retry nor a budget wait.
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
        requestedAt: new Date("2026-03-24T11:50:00.000Z"),
        retryAt: new Date("2026-03-24T11:59:00.000Z"),
        succeededAt: new Date("2026-03-24T11:40:00.000Z"),
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
        succeededAt: new Date("2026-03-24T11:40:00.000Z"),
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
      nextRetryAt: null,
    });
    expect(snapshot.pages[0]?.blocks.audience.substreams[0]).toMatchObject({
      stream: "subscribers",
      state: "scheduled",
      nextRetryAt: null,
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
        stream: "dm_conversations",
        status: "running",
        requestSeq: 1,
        appliedSeq: 0,
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
      waitingFor: ["dm_conversations"],
    });
    expect(snapshot.pages[0]?.blocks.financials.substreams[0]).toMatchObject({
      stream: "transactions",
      state: "scheduled",
      needsAttention: false,
      statusReason: expect.objectContaining({
        code: "queue_waiting",
        waitingFor: ["dm_conversations"],
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

  it("reads fresh blocks queued behind the page's own running capture as up to date", async () => {
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
        stream: "dm_conversations",
        status: "queued",
        requestSeq: 2,
        appliedSeq: 1,
        succeededAt: new Date("2026-03-24T11:54:00.000Z"),
        requestedAt: new Date("2026-03-24T11:20:00.000Z"),
      }),
      // The posts capture is a stream of no block; while it runs, the page's
      // other requests wait behind it.
      buildTaskRow({
        stream: "posts",
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
      buildMonitorRow({ stream: "dm_conversations" }),
    ]);

    const snapshot = await getSyncStatusSnapshot({ db: {}, config: {} } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(snapshot.pages[0]?.blocks.financials.statusReason).toMatchObject({
      code: "queue_waiting",
      waitingFor: ["posts"],
    });
    expect(snapshot.pages[0]?.blocks.connection.state).toBe("up_to_date");
    expect(snapshot.pages[0]?.blocks.financials.state).toBe("scheduled");
    expect(snapshot.pages[0]?.blocks.messages_live.state).toBe("scheduled");
    expect(snapshot.pages[0]?.blocks.messages_history.state).toBe("not_available");
    expect(snapshot.pages[0]?.syncUx.state).toBe("healthy");
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
        stream: "dm_conversations",
        status: "running",
        requestSeq: 1,
        appliedSeq: 0,
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
        stream: "dm_conversations",
        status: "running",
        requestSeq: 1,
        appliedSeq: 0,
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
