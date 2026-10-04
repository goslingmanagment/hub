import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";

const dbMocks = vi.hoisted(() => ({
  countActiveLiveWorkByResource: vi.fn(),
  ensurePageSyncStates: vi.fn(),
  getConfigOverrides: vi.fn(),
  listPageSyncStates: vi.fn(),
  listCheckpointStates: vi.fn(),
  listSyncMonitorStreamRows: vi.fn(),
  listSyncPages: vi.fn(),
  listVisiblePages: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof DbModule>("@agency_hub_core/db");
  return {
    ...actual,
    countActiveLiveWorkByResource: dbMocks.countActiveLiveWorkByResource,
    listSyncPages: dbMocks.listSyncPages,
    ensurePageSyncStates: dbMocks.ensurePageSyncStates,
    getConfigOverrides: dbMocks.getConfigOverrides,
    listPageSyncStates: dbMocks.listPageSyncStates,
    listCheckpointStates: dbMocks.listCheckpointStates,
    listSyncMonitorStreamRows: dbMocks.listSyncMonitorStreamRows,
    listVisiblePages: dbMocks.listVisiblePages,
  };
});

import { getSyncStatusSummarySnapshot } from "../apps/runtime/src/services/sync-summary.ts";

const NOW = new Date("2026-03-24T12:00:00.000Z");
/** `'infinity'` as the driver reads it: a hold only new credentials lift. */
const INDEFINITE = new Date(8.64e15);

// A page of the legacy page-sync executor (OnlyFans, OFAPI-mapped) is summed
// up from its legacy stream rows; a Fansly page by the Fansly Sync Engine.
const OFAPI_CONFIG = {
  ofapiAccountHealthEnabled: true,
  ofapiAudienceSyncEnabled: true,
  ofapiDmSyncEnabled: true,
};

function buildOnlyFansPage(overrides: Record<string, unknown> = {}) {
  return buildVisiblePage({
    platform: "onlyfans",
    hasCredentials: false,
    ofapiAccountId: "acct_test",
    followerCount: null,
    lastFollowerSyncAt: null,
    ...overrides,
  });
}

/** The engine row of the Fansly page (`sync_pages`), as `listSyncPages` reads it. */
function buildEnginePage(overrides: Record<string, unknown> = {}) {
  return {
    pageId: 7,
    pageLabel: "lana",
    mode: "live",
    pausedAll: false,
    pausedResources: [],
    holdKind: null,
    holdUntil: null,
    holdSince: null,
    holdDetail: {},
    lastCompletedAt: new Date("2026-03-24T11:59:30.000Z"),
    dbNow: NOW,
    ...overrides,
  };
}

function workCounts(resource: string, overrides: Record<string, unknown> = {}) {
  return {
    pageId: 7, resource, active: 1, running: 0, quarantined: 0, blockedByVendor: 0, maxFailureCount: 0, nextDueAt: null,
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

describe("sync summary service", () => {
  beforeEach(() => {
    dbMocks.listCheckpointStates.mockResolvedValue([]);
    dbMocks.getConfigOverrides.mockResolvedValue(new Map());
    dbMocks.listSyncPages.mockResolvedValue([]);
    dbMocks.countActiveLiveWorkByResource.mockResolvedValue([]);
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

  it("sums up a Fansly page by the Fansly Sync Engine, never by its legacy rows", async () => {
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listSyncPages.mockResolvedValue([buildEnginePage()]);
    // The page's parked legacy rows (step 4, S4-21), were the scoped read to return them.
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({ stream: "light", status: "paused", blockerKind: "retired" }),
      buildTaskRow({ stream: "purchase_history", status: "blocked", succeededAt: null }),
    ]);
    const app = { db: {}, config: {} };

    const snapshot = await getSyncStatusSummarySnapshot(app as never, { pageIds: [7], now: NOW });

    expect(dbMocks.listPageSyncStates).toHaveBeenCalledWith(app.db, { platforms: ["onlyfans"] });
    expect(dbMocks.listSyncPages).toHaveBeenCalledWith(app.db, { modes: ["handover", "live"] });
    expect(dbMocks.countActiveLiveWorkByResource).toHaveBeenCalledWith(app.db, { pageIds: [7] });
    expect(dbMocks.listSyncMonitorStreamRows).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveProperty("recentCounters");
    expect(snapshot.pages[0]?.syncUx).toEqual({
      state: "healthy",
      label: "Fansly Sync Engine",
      headline: "Managed by the Fansly Sync Engine",
      detail: "Managed by the Fansly Sync Engine",
      progressLabel: null,
      nextRetryAt: null,
      updatedAt: "2026-03-24T11:59:30.000Z",
      requiresAction: false,
    });
  });

  it("asks for new credentials while the engine holds the page for them", async () => {
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    for (const [holdKind, detail] of [
      ["auth", "Fansly refused the page's credentials: the engine holds the page until new ones are saved"],
      ["identity_mismatch", "The credentials belong to another Fansly account: the engine holds the page until new ones are saved"],
    ] as const) {
      dbMocks.listSyncPages.mockResolvedValue([buildEnginePage({
        holdKind, holdUntil: INDEFINITE, holdSince: new Date("2026-03-24T11:00:00.000Z"),
        holdDetail: { credentialsGeneration: "gen-1" },
      })]);
      const snapshot = await getSyncStatusSummarySnapshot({ db: {}, config: {} } as never, { pageIds: [7], now: NOW });
      expect(snapshot.pages[0]?.syncUx, holdKind).toMatchObject({
        state: "attention", label: "Reconnect", headline: "Reconnect to resume sync", detail, requiresAction: true,
      });
    }
    // A timed hold (the network's back-off) is the engine's own business.
    dbMocks.listSyncPages.mockResolvedValue([buildEnginePage({
      holdKind: "network", holdUntil: new Date("2026-03-24T12:05:00.000Z"), holdSince: NOW,
    })]);
    const held = await getSyncStatusSummarySnapshot({ db: {}, config: {} } as never, { pageIds: [7], now: NOW });
    expect(held.pages[0]?.syncUx).toMatchObject({ state: "healthy", requiresAction: false });
  });

  it("needs attention for quarantined or vendor-blocked work of a Settings block, and for no other key", async () => {
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listSyncPages.mockResolvedValue([buildEnginePage()]);
    dbMocks.countActiveLiveWorkByResource.mockResolvedValue([
      workCounts("transactions.head", { quarantined: 2 }),
      workCounts("dm-messages.history", { active: 3, blockedByVendor: 1 }),
    ]);
    const blocked = await getSyncStatusSummarySnapshot({ db: {}, config: {} } as never, { pageIds: [7], now: NOW });
    expect(blocked.pages[0]?.syncUx).toMatchObject({
      state: "attention",
      label: "Needs attention",
      headline: "The Fansly Sync Engine needs attention",
      detail: "2 quarantined, 1 blocked by Fansly",
      requiresAction: false,
    });

    // A key no block shows (the statistics reads) has its own surfaces.
    dbMocks.countActiveLiveWorkByResource.mockResolvedValue([workCounts("stats.daily", { quarantined: 1 })]);
    const elsewhere = await getSyncStatusSummarySnapshot({ db: {}, config: {} } as never, { pageIds: [7], now: NOW });
    expect(elsewhere.pages[0]?.syncUx).toMatchObject({ state: "healthy", headline: "Managed by the Fansly Sync Engine" });
  });

  it("reads a page in handover as switching", async () => {
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listSyncPages.mockResolvedValue([buildEnginePage({ mode: "handover" })]);
    const snapshot = await getSyncStatusSummarySnapshot({ db: {}, config: {} } as never, { pageIds: [7], now: NOW });
    expect(snapshot.pages[0]?.syncUx).toMatchObject({
      state: "catching_up", label: "Switching", headline: "Switching to the Fansly Sync Engine",
    });
  });

  it("reads a Fansly page the engine does not own as not syncing", async () => {
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listSyncPages.mockResolvedValue([]);
    dbMocks.listPageSyncStates.mockResolvedValue([buildTaskRow({ stream: "light" })]);
    const snapshot = await getSyncStatusSummarySnapshot({ db: {}, config: {} } as never, { pageIds: [7], now: NOW });
    expect(snapshot.pages[0]?.syncUx).toMatchObject({
      state: "off", label: "Off", headline: "Not syncing",
      detail: "The Fansly Sync Engine does not run this page: nothing reads it.",
      requiresAction: false,
    });
    expect(dbMocks.countActiveLiveWorkByResource).not.toHaveBeenCalled();
  });

  it.each([
    ["2026-03-24T12:05:00.000Z", "retrying", "2026-03-24T12:05:00.000Z"],
    // The planner keeps a passed deadline on pending work; it is no longer a
    // retry.
    ["2026-03-24T11:59:00.000Z", "catching_up", null],
  ])("reads a pending legacy row's retry deadline %s as %s", async (retryAt, state, nextRetryAt) => {
    dbMocks.listVisiblePages.mockResolvedValue([buildOnlyFansPage()]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({ stream: "dm_conversations" }),
      buildTaskRow({
        stream: "subscribers",
        status: "pending",
        requestSeq: 2,
        appliedSeq: 1,
        requestedAt: new Date("2026-03-24T11:58:00.000Z"),
        retryAt: new Date(retryAt),
      }),
    ]);
    const snapshot = await getSyncStatusSummarySnapshot({ db: {}, config: OFAPI_CONFIG } as never, {
      pageIds: [7], now: NOW,
    });
    expect(snapshot.pages[0]?.syncUx).toMatchObject({ state, nextRetryAt });
    expect(dbMocks.listSyncPages).not.toHaveBeenCalled();
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
    dbMocks.listVisiblePages.mockResolvedValue([buildOnlyFansPage()]);
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
      // The retired legacy crawler's parked row: a record, not a stream.
      buildTaskRow({ stream: "dm_messages", status: "paused", blockerKind: "retired", succeededAt: null }),
    ]);

    const snapshot = await getSyncStatusSummarySnapshot({
      db: {},
      config: OFAPI_CONFIG,
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
