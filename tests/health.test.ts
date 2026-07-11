import { afterEach, describe, expect, it, vi } from "vitest";

const healthMocks = vi.hoisted(() => ({
  getSyncStatusSnapshot: vi.fn(),
  listConnectionStatuses: vi.fn(),
  countUnresolvedProjectionDebtByAccount: vi.fn(
    async (): Promise<Array<{ platformAccountId: number; unresolvedCount: number }>> => [],
  ),
}));

vi.mock("../apps/runtime/src/services/connections.ts", () => ({
  listConnectionStatuses: healthMocks.listConnectionStatuses,
}));

vi.mock("../apps/runtime/src/services/sync-status.ts", () => ({
  getSyncStatusSnapshot: healthMocks.getSyncStatusSnapshot,
}));

// The unit-level app context carries no db; stub the projection-debt count
// (#135 A2b) the way the other health data sources are stubbed.
vi.mock("@agency_hub_core/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  countUnresolvedProjectionDebtByAccount: healthMocks.countUnresolvedProjectionDebtByAccount,
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
        lastSyncError: "Page \"9\" has no stored platform credentials",
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

  it("does not degrade sync health for a deep-backfill-only message history backlog", async () => {
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
      pages: [{
        pageId: 7,
        pageLabel: "lana",
        platform: "fansly",
        modelSlug: "lana",
        modelName: "Lana",
        blocks: {
          connection: { block: "connection", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          financials: { block: "financials", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          audience: { block: "audience", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          messages_live: { block: "messages_live", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          messages_history: {
            block: "messages_history",
            state: "delayed",
            statusReason: {
              code: "history_incomplete",
              summary: "Conversation history is still catching up.",
              waitingFor: null,
            },
            error: null,
            metrics: {
              eligibleConversationCount: 2538,
              readyConversationCount: 2538,
              laggingConversationCount: 0,
              deepBackfillPendingPagesEstimate: 1756,
            },
          },
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
        unhealthyPageCount: 0,
        stalledStreams: 0,
      },
      pages: [
        {
          pageId: 7,
          status: "ok",
          stalledStreams: 0,
          issues: [],
          lastErrorSummary: null,
        },
      ],
    });
  });

  it("does not require legacy OnlyFans credentials when OFAPI account health covers the connection", async () => {
    healthMocks.listConnectionStatuses.mockResolvedValue([
      {
        id: 9,
        label: "lora-of",
        platform: "onlyfans",
        modelSlug: "lora",
        modelName: "Lora",
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
        pageLabel: "lora-of",
        platform: "onlyfans",
        modelSlug: "lora",
        modelName: "Lora",
        blocks: {
          connection: {
            block: "connection",
            state: "paused",
            connectionStatus: "connected",
            statusReason: null,
            error: null,
            metrics: {
              ofapiAuthStatus: null,
            },
          },
          financials: { block: "financials", state: "paused", statusReason: null, error: null, metrics: {} },
          audience: { block: "audience", state: "not_available", statusReason: null, error: null, metrics: {} },
          messages_live: {
            block: "messages_live",
            state: "up_to_date",
            statusReason: {
              code: "webhook_live",
              summary: "Live DMs are fed by OFAPI webhooks.",
              waitingFor: null,
            },
            error: null,
            metrics: {
              webhookIngest: true,
            },
          },
          messages_history: { block: "messages_history", state: "paused", statusReason: null, error: null, metrics: {} },
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
        unhealthyPageCount: 0,
      },
      pages: [
        {
          pageId: 9,
          status: "ok",
          connectionStatus: "unverified",
          issues: [],
          lastErrorSummary: null,
        },
      ],
    });
  });

  it("degrades a page whose retrying stream is wedged on a long failure streak (#135)", async () => {
    healthMocks.listConnectionStatuses.mockResolvedValue([
      {
        id: 7,
        label: "lora-1",
        platform: "fansly",
        modelSlug: "lora",
        modelName: "Lora",
        connectionStatus: "active",
        lastLightSyncAt: "2026-03-23T12:00:00.000Z",
        lastFollowerSyncAt: "2026-03-23T12:00:00.000Z",
        lastSyncError: null,
      },
    ]);
    healthMocks.getSyncStatusSnapshot.mockResolvedValue({
      generatedAt: "2026-03-23T12:00:00.000Z",
      pages: [{
        pageId: 7,
        pageLabel: "lora-1",
        platform: "fansly",
        modelSlug: "lora",
        modelName: "Lora",
        blocks: {
          connection: { block: "connection", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          financials: { block: "financials", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          audience: { block: "audience", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          messages_live: { block: "messages_live", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          // The incident shape: 251 consecutive 23514s, state "retrying" —
          // previously counted into pendingStreams and reported 200/ok.
          messages_history: {
            block: "messages_history",
            state: "retrying",
            statusReason: null,
            error: {
              stream: "dm_messages",
              code: "23514",
              summary: "stored_message_count check violated",
              failedAt: "2026-03-23T11:59:00.000Z",
              consecutiveFailures: 251,
            },
            metrics: {},
          },
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

    expect(result.statusCode).toBe(503);
    expect(result.body).toMatchObject({
      status: "degraded",
      overall: {
        unhealthyPageCount: 1,
      },
      pages: [
        {
          pageId: 7,
          status: "degraded",
          pendingStreams: 1,
          issues: ["dm_messages:retry_wedged"],
        },
      ],
    });
  });

  it("keeps degrading when the wedged stream's state leaves retrying (#137 addendum: false-green)", async () => {
    // Prod 2026-07-11: a 425-streak dm_messages flipped retrying → pending
    // between failures and /health/sync went back to 200/ok. The streak only
    // resets on a real success, so the state transition must not clear it.
    healthMocks.listConnectionStatuses.mockResolvedValue([
      {
        id: 9,
        label: "lora-vip-of",
        platform: "onlyfans",
        modelSlug: "lora",
        modelName: "Lora",
        connectionStatus: "active",
        lastLightSyncAt: "2026-03-23T12:00:00.000Z",
        lastFollowerSyncAt: null,
        lastSyncError: null,
      },
    ]);
    healthMocks.getSyncStatusSnapshot.mockResolvedValue({
      generatedAt: "2026-03-23T12:00:00.000Z",
      pages: [{
        pageId: 9,
        pageLabel: "lora-vip-of",
        platform: "onlyfans",
        modelSlug: "lora",
        modelName: "Lora",
        blocks: {
          connection: { block: "connection", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          financials: { block: "financials", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          audience: { block: "audience", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          messages_live: { block: "messages_live", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          messages_history: {
            block: "messages_history",
            state: "backfilling",
            statusReason: null,
            error: null,
            tasks: [{
              stream: "dm_messages",
              error: {
                stream: "dm_messages",
                code: null,
                summary: "OFAPI request failed: GET .../chats/292065372/messages",
                failedAt: "2026-03-23T11:59:00.000Z",
                consecutiveFailures: 425,
              },
            }],
            metrics: {},
          },
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

    expect(result.statusCode).toBe(503);
    expect(result.body).toMatchObject({
      status: "degraded",
      pages: [
        {
          pageId: 9,
          status: "degraded",
          issues: ["dm_messages:retry_wedged"],
        },
      ],
    });
  });

  it("keeps a short retry streak pending instead of wedged", async () => {
    healthMocks.listConnectionStatuses.mockResolvedValue([
      {
        id: 7,
        label: "lora-1",
        platform: "fansly",
        modelSlug: "lora",
        modelName: "Lora",
        connectionStatus: "active",
        lastLightSyncAt: "2026-03-23T12:00:00.000Z",
        lastFollowerSyncAt: "2026-03-23T12:00:00.000Z",
        lastSyncError: null,
      },
    ]);
    healthMocks.getSyncStatusSnapshot.mockResolvedValue({
      generatedAt: "2026-03-23T12:00:00.000Z",
      pages: [{
        pageId: 7,
        pageLabel: "lora-1",
        platform: "fansly",
        modelSlug: "lora",
        modelName: "Lora",
        blocks: {
          connection: { block: "connection", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          financials: { block: "financials", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          audience: { block: "audience", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          messages_live: { block: "messages_live", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          messages_history: {
            block: "messages_history",
            state: "retrying",
            statusReason: null,
            error: {
              stream: "dm_messages",
              code: "http_5xx",
              summary: "upstream flake",
              failedAt: "2026-03-23T11:59:00.000Z",
              consecutiveFailures: 3,
            },
            metrics: {},
          },
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
      pages: [
        {
          pageId: 7,
          status: "ok",
          pendingStreams: 1,
          issues: [],
        },
      ],
    });
  });

  it("degrades a page with unresolved projection debt (#135)", async () => {
    healthMocks.listConnectionStatuses.mockResolvedValue([
      {
        id: 7,
        label: "lora-1",
        platform: "fansly",
        modelSlug: "lora",
        modelName: "Lora",
        connectionStatus: "active",
        lastLightSyncAt: "2026-03-23T12:00:00.000Z",
        lastFollowerSyncAt: "2026-03-23T12:00:00.000Z",
        lastSyncError: null,
      },
    ]);
    healthMocks.getSyncStatusSnapshot.mockResolvedValue({
      generatedAt: "2026-03-23T12:00:00.000Z",
      pages: [{
        pageId: 7,
        pageLabel: "lora-1",
        platform: "fansly",
        modelSlug: "lora",
        modelName: "Lora",
        blocks: {
          connection: { block: "connection", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          financials: { block: "financials", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          audience: { block: "audience", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          messages_live: { block: "messages_live", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          messages_history: { block: "messages_history", state: "up_to_date", statusReason: null, error: null, metrics: {} },
        },
      }],
    });
    healthMocks.countUnresolvedProjectionDebtByAccount.mockResolvedValueOnce([
      { platformAccountId: 7, unresolvedCount: 2 },
    ]);

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
      pages: [
        {
          pageId: 7,
          status: "degraded",
          issues: ["projection_debt"],
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
