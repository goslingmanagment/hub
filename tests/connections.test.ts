import { afterEach, describe, expect, it, vi } from "vitest";

import type { SyncUxSummary } from "@agency_hub_core/contracts";

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
// The legacy executor's platform set comes from the platform registry, which
// this file's narrow db mock cannot build.
vi.mock("../apps/runtime/src/sync/onlyfans/boundary.ts", () => ({
  legacyExecutorPlatforms: () => ["onlyfans"],
}));
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

  // Step 4 (S4-24): a Fansly page's connection is the Fansly Sync Engine's. Its
  // last legacy `light` run is a frozen record and is not read; an OnlyFans
  // page (the legacy executor's) is judged by its latest run as before.
  describe("a page's connection status", () => {
    const now = new Date("2026-03-24T12:00:00.000Z");
    const healthy: SyncUxSummary = {
      state: "healthy", label: "Fansly Sync Engine", headline: "Managed by the Fansly Sync Engine",
      detail: "Managed by the Fansly Sync Engine", progressLabel: null, nextRetryAt: null, updatedAt: null, requiresAction: false,
    };
    const reconnect: SyncUxSummary = {
      ...healthy, state: "attention", label: "Reconnect", headline: "Reconnect to resume sync",
      detail: "Fansly refused the page's credentials: the engine holds the page until new ones are saved", requiresAction: true,
    };
    const page = (overrides: Record<string, unknown>) => ({
      id: 7, label: "lana", platform: "fansly", modelSlug: "lana", modelName: "Lana", username: "lana_page",
      displayName: "Lana", lastLightSyncAt: now, lastFollowerSyncAt: now, ofapiAccountId: null, ofapiAuthStatus: null,
      ofapiAuthChangedAt: null, subscriberCount: 10, followerCount: 20, hasCredentials: true, proxyUrl: null,
      egressKey: "direct", proxyHasAuth: false,
      ...overrides,
    });
    const failedRun = { platformAccountId: 0, status: "failed", errorSummary: "401 unauthorized" };

    async function statuses(pages: Array<ReturnType<typeof page>>, syncUx: Record<number, SyncUxSummary>) {
      vi.useFakeTimers();
      vi.setSystemTime(now);
      try {
        return await listConnectionStatuses({ db: {} } as never, {
          pages: pages as never,
          syncUxByPageId: new Map(Object.entries(syncUx).map(([id, ux]) => [Number(id), ux])),
        });
      } finally {
        vi.useRealTimers();
      }
    }

    it("asks no legacy run of a Fansly page, and reads the engine's credentials hold as expired", async () => {
      // A failed legacy run, were one read for the Fansly page, would say "expired".
      dbMocks.getLatestSyncRunPerPage.mockImplementation(async (_db: unknown, pageIds: number[]) =>
        pageIds.map((platformAccountId) => ({ ...failedRun, platformAccountId })));

      const result = await statuses(
        [
          page({ id: 7, label: "lana" }),
          page({ id: 8, label: "lana-held" }),
          page({ id: 9, label: "lana-stale", lastLightSyncAt: new Date("2026-03-24T02:00:00.000Z") }),
          page({ id: 10, label: "lana-new", lastLightSyncAt: null }),
          page({ id: 11, label: "lana-bare", hasCredentials: false }),
        ],
        { 7: healthy, 8: reconnect, 9: healthy, 10: healthy, 11: { ...reconnect, detail: "Fresh credentials are required before sync can continue." } },
      );

      expect(dbMocks.getLatestSyncRunPerPage).toHaveBeenCalledWith({}, [], { stream: "light" });
      expect(result.map((row) => [row.label, row.connectionStatus, row.lastSyncError])).toEqual([
        ["lana", "active", null],
        ["lana-held", "expired", "Fansly refused the page's credentials: the engine holds the page until new ones are saved"],
        ["lana-stale", "stale", null],
        ["lana-new", "never_synced", null],
        ["lana-bare", "unverified", null],
      ]);
    });

    it("judges an OnlyFans page by its latest legacy run", async () => {
      dbMocks.getLatestSyncRunPerPage.mockImplementation(async (_db: unknown, pageIds: number[]) =>
        pageIds.map((platformAccountId) => ({ ...failedRun, platformAccountId })));

      const result = await statuses([page({ id: 8, label: "lana-of", platform: "onlyfans" })], { 8: healthy });

      expect(dbMocks.getLatestSyncRunPerPage).toHaveBeenCalledWith({}, [8], { stream: "light" });
      expect(result[0]).toMatchObject({ connectionStatus: "expired", lastSyncError: "401 unauthorized" });
    });
  });
});
