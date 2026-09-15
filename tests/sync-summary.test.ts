import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";

const dbMocks = vi.hoisted(() => ({
  ensurePageSyncStates: vi.fn(),
  listPageSyncStates: vi.fn(),
  listCheckpointStates: vi.fn(),
  listSyncMonitorStreamRows: vi.fn(),
  listVisiblePages: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof DbModule>("@agency_hub_core/db");
  return {
    ...actual,
    ensurePageSyncStates: dbMocks.ensurePageSyncStates,
    listPageSyncStates: dbMocks.listPageSyncStates,
    listCheckpointStates: dbMocks.listCheckpointStates,
    listSyncMonitorStreamRows: dbMocks.listSyncMonitorStreamRows,
    listVisiblePages: dbMocks.listVisiblePages,
  };
});

import { getSyncStatusSummarySnapshot } from "../apps/runtime/src/services/sync-summary.ts";

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

function buildTaskRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-03-24T12:00:00.000Z");
  return {
    pageId: 7,
    stream: "light",
    status: "idle",
    requestSeq: 1,
    leasedSeq: null,
    appliedSeq: 1,
    requestSource: null,
    dispatchSource: "scheduled",
    requestPayload: {},
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

describe("sync summary service", () => {
  beforeEach(() => {
    dbMocks.listCheckpointStates.mockResolvedValue([]);
    // Read paths never seed: this snapshot serves GET /overview and (through
    // listConnectionStatuses) the Sidebar's /admin/connections on every page.
    // Any call into the seeding/repair writer is a regression.
    dbMocks.ensurePageSyncStates.mockImplementation(() => {
      throw new Error("getSyncStatusSummarySnapshot must not seed page_sync_states");
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("builds a page sync summary without monitor aggregate counters", async () => {
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({ stream: "light" }),
      buildTaskRow({ stream: "followers" }),
      buildTaskRow({ stream: "transactions" }),
      buildTaskRow({
        stream: "purchase_history",
        status: "blocked",
        succeededAt: null,
        blockerCode: "purchase_history_contract_rejected",
      }),
    ]);

    const snapshot = await getSyncStatusSummarySnapshot({
      db: {},
      config: {},
    } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(dbMocks.listSyncMonitorStreamRows).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveProperty("recentCounters");
    expect(snapshot.pages[0]?.syncUx).toMatchObject({
      state: "healthy",
      headline: "Up to date",
      requiresAction: false,
    });
  });

  it.each([
    ["2026-03-24T10:12:00.000Z", "attention"],
    [null, "attention"],
    ["2026-03-24T11:12:00.000Z", "healthy"],
  ])("uses certified full freshness in the lightweight summary: %s", async (fullCompletedAt, state) => {
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({ stream: "light" }), buildTaskRow({ stream: "dm_conversations" }),
    ]);
    dbMocks.listCheckpointStates.mockImplementation(async (_db, _ids, stream) =>
      stream === "dm_conversations" ? [{ pageId: 7, state: boundedCheckpoint(fullCompletedAt) }] : []);
    const snapshot = await getSyncStatusSummarySnapshot({ db: {}, config: {} } as never, {
      pageIds: [7], now: new Date("2026-03-24T12:00:00.000Z"),
    });
    expect(snapshot.pages[0]?.syncUx.state).toBe(state);
    expect(snapshot.pages[0]?.syncUx.headline).not.toContain("Audience");
    expect(snapshot.pages[0]?.syncUx.detail).not.toContain("subscribers");
    expect(dbMocks.listSyncMonitorStreamRows).not.toHaveBeenCalled();
    expect(dbMocks.ensurePageSyncStates).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "paused" }, "off"],
    [{ status: "blocked", blockerKind: "auth" }, "attention"],
    [{ status: "retrying", retryAt: new Date("2026-03-24T12:05:00Z") }, "retrying"],
  ])("preserves operational precedence over full freshness: %j", async (overrides, state) => {
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listPageSyncStates.mockResolvedValue([buildTaskRow({ stream: "dm_conversations", ...overrides })]);
    dbMocks.listCheckpointStates.mockImplementation(async (_db, _ids, stream) =>
      stream === "dm_conversations" ? [{ pageId: 7, state: boundedCheckpoint(null) }] : []);
    const snapshot = await getSyncStatusSummarySnapshot({ db: {}, config: {} } as never, {
      pageIds: [7], now: new Date("2026-03-24T12:00:00.000Z"),
    });
    expect(snapshot.pages[0]?.syncUx.state).toBe(state);
    if (overrides.status === "blocked") expect(snapshot.pages[0]?.syncUx.requiresAction).toBe(true);
  });

  it("reports action required from page credentials without monitor metrics", async () => {
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage({
      hasCredentials: false,
    })]);
    dbMocks.listPageSyncStates.mockResolvedValue([]);

    const snapshot = await getSyncStatusSummarySnapshot({
      db: {},
      config: {},
    } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(dbMocks.listSyncMonitorStreamRows).not.toHaveBeenCalled();
    expect(snapshot.pages[0]?.syncUx).toMatchObject({
      state: "attention",
      headline: "Reconnect to resume sync",
      requiresAction: true,
    });
  });

  it("judges OFAPI pages by enabled OFAPI streams, not retired compatibility rows", async () => {
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage({
      platform: "onlyfans",
      hasCredentials: false,
      ofapiAccountId: "acct_test",
      ofapiAuthStatus: null,
    })]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({
        stream: "light",
        status: "paused",
        succeededAt: null,
      }),
      buildTaskRow({
        stream: "transactions",
        status: "paused",
        succeededAt: null,
      }),
      buildTaskRow({ stream: "subscribers" }),
      buildTaskRow({ stream: "dm_conversations" }),
    ]);

    const snapshot = await getSyncStatusSummarySnapshot({
      db: {},
      config: {
        ofapiAccountHealthEnabled: true,
        ofapiAudienceSyncEnabled: true,
        ofapiDmSyncEnabled: true,
      },
    } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(dbMocks.listSyncMonitorStreamRows).not.toHaveBeenCalled();
    expect(snapshot.pages[0]?.syncUx).toMatchObject({
      state: "healthy",
      headline: "Up to date",
      requiresAction: false,
    });
  });

  it("never seeds page_sync_states, and reports a page that has no state rows", async () => {
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listPageSyncStates.mockResolvedValue([]);

    const snapshot = await getSyncStatusSummarySnapshot({
      db: {},
      config: {},
    } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(dbMocks.ensurePageSyncStates).not.toHaveBeenCalled();
    expect(snapshot.pages).toHaveLength(1);
    expect(snapshot.pages[0]?.pageId).toBe(7);
    expect(snapshot.pages[0]?.syncUx).toBeDefined();
  });

  it("never seeds page_sync_states when no page scope is given either", async () => {
    dbMocks.listVisiblePages.mockResolvedValue([
      buildVisiblePage(),
      buildVisiblePage({ id: 8, label: "lana-2" }),
    ]);
    dbMocks.listPageSyncStates.mockResolvedValue([]);

    await getSyncStatusSummarySnapshot({
      db: {},
      config: {},
    } as never, { now: new Date("2026-03-24T12:00:00.000Z") });

    expect(dbMocks.ensurePageSyncStates).not.toHaveBeenCalled();
  });
});
