import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getLatestSyncRunPerPage: vi.fn(),
  listVisiblePages: vi.fn(),
  findPageByLabel: vi.fn(),
  storePlatformCredentials: vi.fn(),
}));

const syncMonitorMocks = vi.hoisted(() => ({
  getSyncMonitorSnapshot: vi.fn(),
}));

const syncStatusMocks = vi.hoisted(() => ({
  getSyncStatusSummarySnapshot: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);
vi.mock("../apps/runtime/src/services/sync-monitor.ts", () => ({
  getSyncMonitorSnapshot: syncMonitorMocks.getSyncMonitorSnapshot,
}));
vi.mock("../apps/runtime/src/services/sync-summary.ts", () => ({
  getSyncStatusSummarySnapshot: syncStatusMocks.getSyncStatusSummarySnapshot,
}));

import { listConnectionStatuses } from "../apps/runtime/src/services/connections.ts";

describe("connections service", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reuses precomputed page sync summaries instead of refetching the sync snapshot", async () => {
    const now = new Date("2026-03-24T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    dbMocks.getLatestSyncRunPerPage.mockResolvedValue([]);

    const syncUx = {
      state: "healthy" as const,
      label: "Up to date",
      headline: "Up to date",
      detail: "All page syncs are current.",
      progressLabel: null,
      nextRetryAt: null,
      updatedAt: now.toISOString(),
      requiresAction: false,
    };

    const result = await listConnectionStatuses({
      db: {},
    } as never, {
      pages: [{
        id: 7,
        label: "lana",
        platform: "fansly",
        modelSlug: "lana",
        modelName: "Lana",
        username: "lana_page",
        displayName: "Lana",
        lastLightSyncAt: now,
        lastFollowerSyncAt: now,
        ofapiAccountId: null,
        ofapiAuthStatus: null,
        ofapiAuthChangedAt: null,
        subscriberCount: 10,
        followerCount: 20,
        hasCredentials: true,
        proxyUrl: null,
        egressKey: "direct",
        proxyHasAuth: false,
      }],
      syncUxByPageId: new Map([[7, syncUx]]),
    });

    vi.useRealTimers();

    expect(syncMonitorMocks.getSyncMonitorSnapshot).not.toHaveBeenCalled();
    expect(result).toEqual([
      expect.objectContaining({
        id: 7,
        label: "lana",
        syncUx,
      }),
    ]);
  });

  it("uses compact sync summaries when precomputed summaries are not supplied", async () => {
    const now = new Date("2026-03-24T12:00:00.000Z");
    dbMocks.getLatestSyncRunPerPage.mockResolvedValue([]);

    const syncUx = {
      state: "healthy" as const,
      label: "Up to date",
      headline: "Up to date",
      detail: "All page syncs are current.",
      progressLabel: null,
      nextRetryAt: null,
      updatedAt: now.toISOString(),
      requiresAction: false,
    };
    const app = { db: {} } as never;

    syncStatusMocks.getSyncStatusSummarySnapshot.mockResolvedValue({
      generatedAt: now.toISOString(),
      pages: [{
        pageId: 7,
        syncUx,
      }],
    });

    const result = await listConnectionStatuses(app, {
      pages: [{
        id: 7,
        label: "lana",
        platform: "fansly",
        modelSlug: "lana",
        modelName: "Lana",
        username: "lana_page",
        displayName: "Lana",
        lastLightSyncAt: now,
        lastFollowerSyncAt: now,
        ofapiAccountId: null,
        ofapiAuthStatus: null,
        ofapiAuthChangedAt: null,
        subscriberCount: 10,
        followerCount: 20,
        hasCredentials: true,
        proxyUrl: null,
        egressKey: "direct",
        proxyHasAuth: false,
      }],
    });

    expect(syncStatusMocks.getSyncStatusSummarySnapshot).toHaveBeenCalledWith(app, {
      pageIds: [7],
    });
    expect(result[0]?.syncUx).toBe(syncUx);
  });
});
