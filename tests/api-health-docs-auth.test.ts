import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "@agency_hub_core/shared";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";

const routeMocks = vi.hoisted(() => ({
  authenticateApiKeyToken: vi.fn(),
  authenticateSessionToken: vi.fn(),
  getPublicSyncHealth: vi.fn(),
  getSystemHealth: vi.fn(),
}));

vi.mock("../apps/runtime/src/services/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../apps/runtime/src/services/auth.ts")>();
  return {
    ...actual,
    authenticateApiKeyToken: routeMocks.authenticateApiKeyToken,
    authenticateSessionToken: routeMocks.authenticateSessionToken,
  };
});

vi.mock("../apps/runtime/src/services/health.ts", () => ({
  getPublicSyncHealth: routeMocks.getPublicSyncHealth,
  getSystemHealth: routeMocks.getSystemHealth,
}));

const { buildApiServer } = await import("../apps/runtime/src/api/server.ts");
const { SESSION_COOKIE_NAME } = await import("../apps/runtime/src/services/auth.ts");

function createRouteTestContext(input?: {
  healthSyncMonitoringToken?: string | null;
}) {
  const encryptionKey = Buffer.alloc(32, 7);

  return {
    config: {
      databaseUrl: "",
      encryptionKey,
      encryptionKeyVersion: 1,
      encryptionKeysByVersion: new Map([[1, encryptionKey]]),
      logLevel: "silent",
      apiHost: "0.0.0.0",
      apiPort: 3000,
      trustProxy: false,
      sessionTtlDays: 30,
      fanslyBaseUrl: "https://example.invalid",
      onlyMonsterBaseUrl: "https://example.invalid",
      syncHttpTraceFile: null,
      fanslyDefaultDelayMs: 2500,
      fanslyDmConversationsDelayMs: 5000,
      fanslyDmMessagesDelayMs: 5000,
      followerPageDelayMs: 0,
      onlyFansDefaultDelayMs: 1000,
      transactionLookbackDays: 7,
      transactionRescanCapDays: 30,
      syncSharedRateLimitEnabled: false,
      syncPageExecutorConcurrency: 1,
      syncObservabilityRetentionDays: 30,
      healthSyncLightMaxAgeMinutes: 180,
      healthSyncFollowerMaxAgeMinutes: 1080,
      healthSyncMonitoringToken: input?.healthSyncMonitoringToken ?? null,
      telegramBotToken: null,
      telegramChatId: null,
      telegramEnabled: false,
      telegramReportHourUtc: 9,
    },
    logger: createLogger("silent"),
    pool: {} as AppContext["pool"],
    db: {} as AppContext["db"],
    adapter: {} as AppContext["adapter"],
    onlyFansAdapter: {} as AppContext["onlyFansAdapter"],
    async close() {},
  } satisfies AppContext;
}

const ownerPrincipal = {
  authMethod: "session" as const,
  user: {
    id: 1,
    username: "owner",
    role: "owner" as const,
    assignedPages: [],
  },
  assignedPageIds: [],
};

const leadPrincipal = {
  authMethod: "session" as const,
  user: {
    id: 2,
    username: "lead",
    role: "team_lead" as const,
    assignedPages: [],
  },
  assignedPageIds: [],
};

describe("health and docs route auth", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps public liveness unauthenticated", async () => {
    routeMocks.getSystemHealth.mockResolvedValue({
      statusCode: 200,
      body: {
        status: "ok",
        timestamp: "2026-04-30T00:00:00.000Z",
        checks: {
          api: { status: "ok" },
          database: { status: "ok", latencyMs: 1, error: null },
        },
      },
    });
    const server = await buildApiServer(createRouteTestContext());

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/health",
      });

      expect(response.statusCode).toBe(200);
      expect(routeMocks.getSystemHealth).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("requires dashboard auth or a configured monitoring token for detailed sync health", async () => {
    routeMocks.getPublicSyncHealth.mockResolvedValue({
      statusCode: 200,
      body: {
        status: "ok",
        timestamp: "2026-04-30T00:00:00.000Z",
        thresholds: {
          lightMaxAgeMinutes: 180,
          followerMaxAgeMinutes: 1080,
        },
        overall: {
          pageCount: 1,
          unhealthyPageCount: 0,
          runningStreams: 0,
          failedStreams: 0,
          stalledStreams: 0,
          pendingStreams: 0,
          recentFailedRuns: 0,
          recent429s: 0,
          recent5xxs: 0,
        },
        pages: [{
          pageId: 1,
          pageLabel: "lana",
          platform: "fansly",
          modelSlug: "lana",
          modelName: "Lana",
          status: "ok",
          connectionStatus: "active",
          lastLightSyncAt: null,
          lightAgeMinutes: null,
          lastFollowerSyncAt: null,
          followerAgeMinutes: null,
          failedStreams: 0,
          stalledStreams: 0,
          pendingStreams: 0,
          lastErrorSummary: null,
          issues: [],
        }],
      },
    });
    routeMocks.authenticateSessionToken.mockResolvedValue(ownerPrincipal);

    const server = await buildApiServer(createRouteTestContext({
      healthSyncMonitoringToken: "health-monitor-secret",
    }));

    try {
      const anonymous = await server.inject({
        method: "GET",
        url: "/api/v1/health/sync",
      });
      expect(anonymous.statusCode).toBe(401);
      expect(JSON.stringify(anonymous.json())).not.toContain("lana");
      expect(routeMocks.getPublicSyncHealth).not.toHaveBeenCalled();

      const monitored = await server.inject({
        method: "GET",
        url: "/api/v1/health/sync",
        headers: {
          "x-monitoring-token": "health-monitor-secret",
        },
      });
      expect(monitored.statusCode).toBe(200);
      expect(monitored.json().pages[0].pageLabel).toBe("lana");

      const sessionAuthed = await server.inject({
        method: "GET",
        url: "/api/v1/health/sync",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=owner-token`,
        },
      });
      expect(sessionAuthed.statusCode).toBe(200);
      expect(routeMocks.authenticateSessionToken).toHaveBeenCalledWith(expect.anything(), "owner-token");
    } finally {
      await server.close();
    }
  });

  it("requires owner auth for OpenAPI JSON and Swagger UI", async () => {
    routeMocks.authenticateSessionToken.mockImplementation(async (_app, token: string) => {
      if (token === "owner-token") {
        return ownerPrincipal;
      }
      if (token === "lead-token") {
        return leadPrincipal;
      }
      return null;
    });
    const server = await buildApiServer(createRouteTestContext());

    try {
      const anonymousSpec = await server.inject({
        method: "GET",
        url: "/api/v1/openapi.json",
      });
      expect(anonymousSpec.statusCode).toBe(401);

      const leadSpec = await server.inject({
        method: "GET",
        url: "/api/v1/openapi.json",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=lead-token`,
        },
      });
      expect(leadSpec.statusCode).toBe(403);

      const ownerSpec = await server.inject({
        method: "GET",
        url: "/api/v1/openapi.json",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=owner-token`,
        },
      });
      expect(ownerSpec.statusCode).toBe(200);
      expect(ownerSpec.json().components.securitySchemes.monitoringTokenAuth).toMatchObject({
        in: "header",
        name: "x-monitoring-token",
      });

      const anonymousDocs = await server.inject({
        method: "GET",
        url: "/documentation/",
      });
      expect(anonymousDocs.statusCode).toBe(401);

      const ownerDocs = await server.inject({
        method: "GET",
        url: "/documentation/",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=owner-token`,
        },
      });
      expect(ownerDocs.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });
});
