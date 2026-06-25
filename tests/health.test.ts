import { afterEach, describe, expect, it, vi } from "vitest";

const healthMocks = vi.hoisted(() => ({
  getSyncStatusSnapshot: vi.fn(),
  listConnectionStatuses: vi.fn(),
}));

vi.mock("../apps/runtime/src/services/connections.ts", () => ({
  listConnectionStatuses: healthMocks.listConnectionStatuses,
}));

vi.mock("../apps/runtime/src/services/sync-status.ts", () => ({
  getSyncStatusSnapshot: healthMocks.getSyncStatusSnapshot,
}));

// getPublicSyncHealth now resolves live effective config; with no db overlay here it
// is the boot config, so stub it to return the passed config unchanged.
vi.mock("../apps/runtime/src/services/effective-config.ts", () => ({
  loadEffectiveConfig: vi.fn(async (_db: unknown, config: unknown) => config),
}));

import { getPublicSyncHealth, getSystemHealth } from "../apps/runtime/src/services/health.ts";

describe("health service", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("includes pages that have connection status data even when the sync snapshot has no page rows", async () => {
    healthMocks.listConnectionStatuses.mockResolvedValue([
      {
        id: 7,
        label: "lana",
        platform: "fansly",
        modelSlug: "lana",
        modelName: "Lana",
        connectionStatus: "never_synced",
        lastLightSyncAt: null,
        lastFollowerSyncAt: null,
        lastSyncError: "No successful sync yet",
      },
    ]);
    healthMocks.getSyncStatusSnapshot.mockResolvedValue({
      generatedAt: "2026-03-23T12:00:00.000Z",
      pages: [],
    });

    const result = await getPublicSyncHealth({
      config: {
        healthSyncLightMaxAgeMinutes: 180,
        healthSyncFollowerMaxAgeMinutes: 1080,
        healthSyncMonitoringToken: null,
      },
    } as never, {
      now: new Date("2026-03-23T12:00:00.000Z"),
    });

    expect(result.statusCode).toBe(503);
    expect(result.body).toMatchObject({
      status: "degraded",
      overall: {
        pageCount: 1,
        unhealthyPageCount: 1,
        failedStreams: 0,
        stalledStreams: 0,
      },
      pages: [
        {
          pageId: 7,
          pageLabel: "lana",
          platform: "fansly",
          connectionStatus: "never_synced",
          failedStreams: 0,
          stalledStreams: 0,
          pendingStreams: 0,
          issues: [
            "connection:never_synced",
            "light_sync_missing",
            "follower_sync_missing",
          ],
          lastErrorSummary: "No successful sync yet",
        },
      ],
    });
  });

  it("reports recent sync failure counters from the sync status snapshot", async () => {
    healthMocks.listConnectionStatuses.mockResolvedValue([
      {
        id: 7,
        label: "lana",
        platform: "fansly",
        modelSlug: "lana",
        modelName: "Lana",
        connectionStatus: "active",
        lastLightSyncAt: "2026-03-23T12:00:00.000Z",
        lastFollowerSyncAt: "2026-03-23T12:00:00.000Z",
        lastSyncError: null,
      },
    ]);
    healthMocks.getSyncStatusSnapshot.mockResolvedValue({
      generatedAt: "2026-03-23T12:00:00.000Z",
      recentCounters: {
        failedRuns: 2,
        http429s: 3,
        http5xxs: 4,
      },
      pages: [{
        pageId: 7,
        pageLabel: "lana",
        platform: "fansly",
        modelSlug: "lana",
        modelName: "Lana",
        blocks: {
          connection: { state: "up_to_date", statusReason: null, error: null },
          financials: { state: "up_to_date", statusReason: null, error: null },
          audience: { state: "up_to_date", statusReason: null, error: null },
          messages_live: { state: "up_to_date", statusReason: null, error: null },
          messages_history: { state: "not_available", statusReason: null, error: null },
        },
      }],
    });

    const result = await getPublicSyncHealth({
      config: {
        healthSyncLightMaxAgeMinutes: 180,
        healthSyncFollowerMaxAgeMinutes: 1080,
        healthSyncMonitoringToken: null,
      },
    } as never, {
      now: new Date("2026-03-23T12:00:00.000Z"),
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.overall).toMatchObject({
      recentFailedRuns: 2,
      recent429s: 3,
      recent5xxs: 4,
    });
  });

  it("does not degrade sync health for pages whose supported streams are intentionally paused", async () => {
    healthMocks.listConnectionStatuses.mockResolvedValue([
      {
        id: 9,
        label: "paused-onlyfans",
        platform: "onlyfans",
        modelSlug: "paused",
        modelName: "Paused",
        connectionStatus: "unverified",
        lastLightSyncAt: null,
        lastFollowerSyncAt: null,
        lastSyncError: null,
      },
    ]);
    healthMocks.getSyncStatusSnapshot.mockResolvedValue({
      generatedAt: "2026-03-23T12:00:00.000Z",
      pages: [{
        pageId: 9,
        pageLabel: "paused-onlyfans",
        platform: "onlyfans",
        modelSlug: "paused",
        modelName: "Paused",
        blocks: {
          connection: { state: "paused", statusReason: null, error: null },
          financials: { state: "paused", statusReason: null, error: null },
          audience: { state: "not_available", statusReason: null, error: null },
          messages_live: { state: "paused", statusReason: null, error: null },
          messages_history: { state: "paused", statusReason: null, error: null },
        },
      }],
    });

    const result = await getPublicSyncHealth({
      config: {
        healthSyncLightMaxAgeMinutes: 180,
        healthSyncFollowerMaxAgeMinutes: 1080,
        healthSyncMonitoringToken: null,
      },
    } as never, {
      now: new Date("2026-03-23T12:00:00.000Z"),
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      status: "ok",
      overall: {
        pageCount: 1,
        unhealthyPageCount: 0,
      },
      pages: [
        {
          pageId: 9,
          status: "ok",
          connectionStatus: "unverified",
          issues: [],
        },
      ],
    });
  });

  it("sanitizes database probe failures in the public health response", async () => {
    const app = {
      pool: {
        query: vi.fn().mockRejectedValue(new Error("password authentication failed for user \"postgres\"")),
      },
      logger: {
        error: vi.fn(),
      },
    };

    const result = await getSystemHealth(app as never);

    expect(result.statusCode).toBe(503);
    expect(result.body.checks.database.error).toBe("Database check failed");
    expect(app.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
      }),
      "Health check database probe failed",
    );
  });
});
