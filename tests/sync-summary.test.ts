import { afterEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";

const dbMocks = vi.hoisted(() => ({
  ensurePageSyncStates: vi.fn(),
  listPageSyncStates: vi.fn(),
  listSyncMonitorStreamRows: vi.fn(),
  listVisiblePages: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof DbModule>("@agency_hub_core/db");
  return {
    ...actual,
    ensurePageSyncStates: dbMocks.ensurePageSyncStates,
    listPageSyncStates: dbMocks.listPageSyncStates,
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

describe("sync summary service", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("builds a page sync summary without monitor aggregate counters", async () => {
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([buildVisiblePage()]);
    dbMocks.listPageSyncStates.mockResolvedValue([
      buildTaskRow({ stream: "light" }),
      buildTaskRow({ stream: "followers" }),
      buildTaskRow({ stream: "transactions" }),
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

  it("reports action required from page credentials without monitor metrics", async () => {
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
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

  it("does not require legacy credentials for OFAPI-mapped OnlyFans pages without action auth", async () => {
    dbMocks.ensurePageSyncStates.mockResolvedValue([]);
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
    ]);

    const snapshot = await getSyncStatusSummarySnapshot({
      db: {},
      config: {
        ofapiAccountHealthEnabled: true,
      },
    } as never, {
      pageIds: [7],
      now: new Date("2026-03-24T12:00:00.000Z"),
    });

    expect(dbMocks.listSyncMonitorStreamRows).not.toHaveBeenCalled();
    expect(snapshot.pages[0]?.syncUx).toMatchObject({
      state: "off",
      requiresAction: false,
    });
  });
});
