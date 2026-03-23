import { afterEach, describe, expect, it, vi } from "vitest";

const healthMocks = vi.hoisted(() => ({
  getSyncMonitorSnapshot: vi.fn(),
  listConnectionStatuses: vi.fn(),
}));

vi.mock("../apps/runtime/src/services/connections.ts", () => ({
  listConnectionStatuses: healthMocks.listConnectionStatuses,
}));

vi.mock("../apps/runtime/src/services/sync-monitor.ts", () => ({
  getSyncMonitorSnapshot: healthMocks.getSyncMonitorSnapshot,
}));

import { getPublicSyncHealth } from "../apps/runtime/src/services/health.ts";

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
    healthMocks.getSyncMonitorSnapshot.mockResolvedValue({
      generatedAt: "2026-03-23T12:00:00.000Z",
      window: {
        hours: 24,
        startedAt: "2026-03-22T12:00:00.000Z",
      },
      overall: {
        pages: 0,
        streams: 0,
        runningStreams: 0,
        failedStreams: 0,
        stalledStreams: 0,
        pendingStreams: 0,
        backoffStreams: 0,
        counts: {
          fans: 0,
          followers: 0,
          subscribers: 0,
          transactions: 0,
          conversations: 0,
          messages: 0,
        },
        recentRuns: {
          running: 0,
          success: 0,
          partial: 0,
          failed: 0,
          skipped: 0,
        },
        recentErrors: {
          total429s: 0,
          total5xxs: 0,
          failedRuns: 0,
        },
        providers: [],
      },
      pages: [],
      recentEvents: [],
    });

    const result = await getPublicSyncHealth({
      config: {
        healthSyncLightMaxAgeMinutes: 180,
        healthSyncFollowerMaxAgeMinutes: 1080,
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
});
