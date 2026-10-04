import { afterEach, describe, expect, it, vi } from "vitest";

const healthMocks = vi.hoisted(() => ({
  getSyncStatusSnapshot: vi.fn(),
  listConnectionStatuses: vi.fn(),
  // No page is the Fansly Sync Engine's here: the legacy stream checks judge
  // the legacy executor's pages (OnlyFans), and a Fansly page is one the engine
  // does not own (the engine pages' block: tests/sync-engine-health).
  listSyncPages: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("../apps/runtime/src/services/connections.ts", () => ({
  listConnectionStatuses: healthMocks.listConnectionStatuses,
}));

vi.mock("../apps/runtime/src/services/sync-status.ts", () => ({
  getSyncStatusSnapshot: healthMocks.getSyncStatusSnapshot,
}));

// The unit-level app context carries no db; stub the engine page list the way
// the other health data sources are stubbed.
vi.mock("@agency_hub_core/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listSyncPages: healthMocks.listSyncPages,
}));

// getPublicSyncHealth now resolves live effective config; with no db overlay here it
// is the boot config, so stub it to return the passed config unchanged.
vi.mock("../apps/runtime/src/services/effective-config.ts", () => ({
  loadEffectiveConfig: vi.fn(async (_db: unknown, config: unknown) => config),
}));

import { getPublicSyncHealth, getSystemHealth } from "../apps/runtime/src/services/health.ts";

const TASK_HEALTH_NOW = new Date("2026-03-23T12:00:00.000Z");

function mockTaskHealthScenario(financialsBlock: Record<string, unknown>) {
  healthMocks.listConnectionStatuses.mockResolvedValue([
    {
      id: 7,
      label: "lora-of",
      platform: "onlyfans",
      modelSlug: "lora",
      modelName: "Lora",
      connectionStatus: "active",
      lastLightSyncAt: TASK_HEALTH_NOW.toISOString(),
      lastFollowerSyncAt: null,
      lastSyncError: null,
    },
  ]);
  healthMocks.getSyncStatusSnapshot.mockResolvedValue({
    generatedAt: TASK_HEALTH_NOW.toISOString(),
    pages: [{
      pageId: 7,
      pageLabel: "lora-of",
      platform: "onlyfans",
      modelSlug: "lora",
      modelName: "Lora",
      blocks: {
        connection: {
          block: "connection",
          state: "up_to_date",
          statusReason: null,
          error: null,
          metrics: {},
          tasks: [],
        },
        financials: financialsBlock,
        audience: {
          block: "audience",
          state: "up_to_date",
          statusReason: null,
          error: null,
          metrics: {},
          tasks: [],
        },
        messages_live: {
          block: "messages_live",
          state: "up_to_date",
          statusReason: null,
          error: null,
          metrics: {},
          tasks: [],
        },
        messages_history: {
          block: "messages_history",
          state: "not_available",
          statusReason: null,
          error: null,
          metrics: {},
          tasks: [],
        },
      },
    }],
  });
}

function readMockedTaskHealth() {
  return getPublicSyncHealth({
    config: {
      healthSyncLightMaxAgeMinutes: 180,
      healthSyncMonitoringToken: null,
    },
  } as never, {
    now: TASK_HEALTH_NOW,
  });
}

describe("health service", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("includes pages that have connection status data even when the sync snapshot has no page rows", async () => {
    healthMocks.listConnectionStatuses.mockResolvedValue([
      {
        id: 7,
        label: "lana-of",
        platform: "onlyfans",
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
        healthSyncMonitoringToken: null,
      },
    } as never, {
      now: new Date("2026-03-23T12:00:00.000Z"),
    });

    expect(result.statusCode).toBe(503);
    // The legacy checks have one threshold left: the follower one went with
    // the legacy Fansly follower check (step 4, S4-24).
    expect(result.body.thresholds).toEqual({ lightMaxAgeMinutes: 180 });
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
          pageLabel: "lana-of",
          platform: "onlyfans",
          connectionStatus: "never_synced",
          followerAgeMinutes: null,
          failedStreams: 0,
          stalledStreams: 0,
          pendingStreams: 0,
          issues: [
            "connection:never_synced",
            "light_sync_missing",
          ],
          lastErrorSummary: "No successful sync yet",
        },
      ],
    });
  });

  it("judges no Fansly page by legacy streams: one the engine does not own is unhealthy because nothing reads it", async () => {
    healthMocks.listConnectionStatuses.mockResolvedValue([
      {
        id: 7,
        label: "lana",
        platform: "fansly",
        modelSlug: "lana",
        modelName: "Lana",
        // Everything a legacy check would have passed.
        connectionStatus: "active",
        lastLightSyncAt: "2026-03-23T11:50:00.000Z",
        lastFollowerSyncAt: "2026-03-23T11:00:00.000Z",
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
          connection: { block: "connection", state: "not_available", statusReason: null, error: null, metrics: {} },
          financials: { block: "financials", state: "not_available", statusReason: null, error: null, metrics: {} },
          audience: { block: "audience", state: "not_available", statusReason: null, error: null, metrics: {} },
          messages_live: { block: "messages_live", state: "not_available", statusReason: null, error: null, metrics: {} },
          messages_history: { block: "messages_history", state: "not_available", statusReason: null, error: null, metrics: {} },
        },
      }],
    });

    const result = await getPublicSyncHealth({
      config: {
        healthSyncLightMaxAgeMinutes: 180,
        healthSyncMonitoringToken: null,
      },
    } as never, {
      now: new Date("2026-03-23T12:00:00.000Z"),
    });

    expect(result.statusCode).toBe(503);
    expect(result.body.pages).toEqual([
      {
        pageId: 7,
        pageLabel: "lana",
        platform: "fansly",
        modelSlug: "lana",
        modelName: "Lana",
        status: "degraded",
        connectionStatus: "active",
        lastLightSyncAt: "2026-03-23T11:50:00.000Z",
        lightAgeMinutes: 10,
        lastFollowerSyncAt: "2026-03-23T11:00:00.000Z",
        followerAgeMinutes: 60,
        failedStreams: 0,
        stalledStreams: 0,
        pendingStreams: 0,
        lastErrorSummary: "engine:not_live",
        issues: ["engine:not_live"],
      },
    ]);
    expect(result.body.overall).toMatchObject({ pageCount: 1, unhealthyPageCount: 1 });
  });

  it("reports recent sync failure counters from the sync status snapshot", async () => {
    healthMocks.listConnectionStatuses.mockResolvedValue([
      {
        id: 7,
        label: "lana-of",
        platform: "onlyfans",
        modelSlug: "lana",
        modelName: "Lana",
        connectionStatus: "active",
        lastLightSyncAt: "2026-03-23T12:00:00.000Z",
        lastFollowerSyncAt: null,
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
        pageLabel: "lana-of",
        platform: "onlyfans",
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

  it("degrades for a failed supporting task hidden by an up-to-date block", async () => {
    mockTaskHealthScenario({
      block: "financials",
      state: "up_to_date",
      statusReason: null,
      error: null,
      metrics: {},
      tasks: [{
        stream: "top_spenders",
        state: "failed",
        needsAttention: true,
        statusReason: {
          code: "top_spenders_window_rejected",
          summary: "The top spenders window could not be rebuilt.",
          waitingFor: null,
        },
        error: {
          code: "top_spenders_window_rejected",
          summary: "The top spenders window could not be rebuilt.",
          failedAt: "2026-03-23T11:59:00.000Z",
          consecutiveFailures: 1,
        },
      }],
    });

    const result = await readMockedTaskHealth();

    expect(result.statusCode).toBe(503);
    expect(result.body).toMatchObject({
      status: "degraded",
      overall: {
        failedStreams: 0,
        unhealthyPageCount: 1,
      },
      pages: [{
        pageId: 7,
        status: "degraded",
        failedStreams: 0,
        issues: ["failed_tasks"],
        lastErrorSummary: "The top spenders window could not be rebuilt.",
      }],
    });
  });

  it("does not treat a dependency-delayed supporting task as failed", async () => {
    mockTaskHealthScenario({
      block: "financials",
      state: "up_to_date",
      statusReason: null,
      error: null,
      metrics: {},
      tasks: [{
        stream: "top_spenders",
        state: "delayed",
        needsAttention: true,
        statusReason: {
          code: "unmet_dependency",
          summary: "Waiting for transactions.",
          waitingFor: ["transactions"],
        },
        error: null,
      }],
    });

    const result = await readMockedTaskHealth();

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      status: "ok",
      overall: {
        failedStreams: 0,
        unhealthyPageCount: 0,
      },
      pages: [{
        pageId: 7,
        status: "ok",
        issues: [],
        lastErrorSummary: null,
      }],
    });
  });

  it("does not degrade a paused block when no task failed", async () => {
    mockTaskHealthScenario({
      block: "financials",
      state: "paused",
      statusReason: null,
      error: null,
      metrics: {},
      tasks: [{
        stream: "transactions",
        state: "paused",
        needsAttention: false,
        statusReason: null,
        error: null,
      }],
    });

    const result = await readMockedTaskHealth();

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      status: "ok",
      overall: {
        failedStreams: 0,
        unhealthyPageCount: 0,
      },
      pages: [{
        pageId: 7,
        status: "ok",
        issues: [],
        lastErrorSummary: null,
      }],
    });
  });

  it("degrades a paused aggregate when a supporting sibling task failed", async () => {
    mockTaskHealthScenario({
      block: "financials",
      state: "paused",
      statusReason: null,
      error: null,
      metrics: {},
      tasks: [{
        stream: "transactions",
        state: "paused",
        needsAttention: false,
        statusReason: null,
        error: null,
      }, {
        stream: "top_spenders",
        state: "failed",
        needsAttention: true,
        statusReason: null,
        error: {
          code: "top_spenders_window_rejected",
          summary: "Top spenders are blocked on a rejected window.",
          failedAt: "2026-03-23T11:59:00.000Z",
          consecutiveFailures: 1,
        },
      }],
    });

    const result = await readMockedTaskHealth();

    expect(result.statusCode).toBe(503);
    expect(result.body).toMatchObject({
      status: "degraded",
      overall: {
        failedStreams: 0,
        unhealthyPageCount: 1,
      },
      pages: [{
        pageId: 7,
        status: "degraded",
        failedStreams: 0,
        issues: ["failed_tasks"],
        lastErrorSummary: "Top spenders are blocked on a rejected window.",
      }],
    });
  });

  it("does not degrade an OFAPI-mapped page for its unverified legacy connection or its parked streams", async () => {
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
        label: "lora-of",
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
        pageId: 7,
        pageLabel: "lora-of",
        platform: "onlyfans",
        modelSlug: "lora",
        modelName: "Lora",
        blocks: {
          connection: { block: "connection", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          financials: { block: "financials", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          audience: { block: "audience", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          // The incident shape: 251 consecutive 23514s, state "retrying" —
          // previously counted into pendingStreams and reported 200/ok.
          messages_live: {
            block: "messages_live",
            state: "retrying",
            statusReason: null,
            error: {
              stream: "dm_conversations",
              code: "23514",
              summary: "stored_message_count check violated",
              failedAt: "2026-03-23T11:59:00.000Z",
              consecutiveFailures: 251,
            },
            metrics: {},
          },
          messages_history: { block: "messages_history", state: "not_available", statusReason: null, error: null, metrics: {} },
        },
      }],
    });

    const result = await getPublicSyncHealth({
      config: {
        healthSyncLightMaxAgeMinutes: 180,
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
          issues: ["dm_conversations:retry_wedged"],
        },
      ],
    });
  });

  it("keeps degrading when the wedged stream's state leaves retrying (#137 addendum: false-green)", async () => {
    // Prod 2026-07-11: a 425-streak stream flipped retrying → pending between
    // failures and /health/sync went back to 200/ok. The streak only resets on
    // a real success, so the state transition must not clear it.
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
          messages_live: {
            block: "messages_live",
            state: "syncing",
            statusReason: null,
            error: null,
            tasks: [{
              stream: "dm_conversations",
              error: {
                stream: "dm_conversations",
                code: null,
                summary: "OFAPI request failed: GET .../chats",
                failedAt: "2026-03-23T11:59:00.000Z",
                consecutiveFailures: 425,
              },
            }],
            metrics: {},
          },
          messages_history: { block: "messages_history", state: "not_available", statusReason: null, error: null, metrics: {} },
        },
      }],
    });

    const result = await getPublicSyncHealth({
      config: {
        healthSyncLightMaxAgeMinutes: 180,
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
          issues: ["dm_conversations:retry_wedged"],
        },
      ],
    });
  });

  it("keeps a short retry streak pending instead of wedged", async () => {
    healthMocks.listConnectionStatuses.mockResolvedValue([
      {
        id: 7,
        label: "lora-of",
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
        pageId: 7,
        pageLabel: "lora-of",
        platform: "onlyfans",
        modelSlug: "lora",
        modelName: "Lora",
        blocks: {
          connection: { block: "connection", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          financials: { block: "financials", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          audience: { block: "audience", state: "up_to_date", statusReason: null, error: null, metrics: {} },
          messages_live: {
            block: "messages_live",
            state: "retrying",
            statusReason: null,
            error: {
              stream: "dm_conversations",
              code: "http_5xx",
              summary: "upstream flake",
              failedAt: "2026-03-23T11:59:00.000Z",
              consecutiveFailures: 3,
            },
            metrics: {},
          },
          messages_history: { block: "messages_history", state: "not_available", statusReason: null, error: null, metrics: {} },
        },
      }],
    });

    const result = await getPublicSyncHealth({
      config: {
        healthSyncLightMaxAgeMinutes: 180,
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
    expect(result.body.contractHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.body.checks.database.error).toBe("Database check failed");
    expect(app.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
      }),
      "Health check database probe failed",
    );
  });
});
