import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as AuthServiceModule from "../apps/runtime/src/services/auth.ts";

import { createLogger } from "@agency_hub_core/shared";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";

const routeMocks = vi.hoisted(() => ({
  authenticateApiKeyToken: vi.fn(),
  authenticateBearerCredential: vi.fn(),
  authenticateSessionToken: vi.fn(),
  getPublicSyncHealth: vi.fn(),
  getSystemHealth: vi.fn(),
}));

vi.mock("../apps/runtime/src/services/auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof AuthServiceModule>();
  return {
    ...actual,
    authenticateApiKeyToken: routeMocks.authenticateApiKeyToken,
    authenticateBearerCredential: routeMocks.authenticateBearerCredential,
    authenticateSessionToken: routeMocks.authenticateSessionToken,
  };
});

vi.mock("../apps/runtime/src/services/health.ts", () => ({
  getPublicSyncHealth: routeMocks.getPublicSyncHealth,
  getSystemHealth: routeMocks.getSystemHealth,
}));

const { buildApiServer, resolveDashboardDistPath } = await import("../apps/runtime/src/api/server.ts");
const { SESSION_COOKIE_NAME } = await import("../apps/runtime/src/services/auth.ts");

function createRouteTestContext(input?: {
  healthSyncMonitoringToken?: string | null;
  syncSharedRateLimitEnabled?: boolean;
  ofapi?: AppContext["ofapi"];
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
      syncHttpTraceFile: null,
      fanslyDefaultDelayMs: 2500,
      fanslyDmConversationsDelayMs: 5000,
      fanslyDmMessagesDelayMs: 5000,
      followerPageDelayMs: 0,
      onlyFansDefaultDelayMs: 1000,
      transactionLookbackDays: 7,
      transactionRescanCapDays: 30,
      syncSharedRateLimitEnabled: input?.syncSharedRateLimitEnabled ?? false,
      egressPacerMode: "off" as const,
      lakeDir: "lake",
      syncPageExecutorConcurrency: 1,
      syncObservabilityRetentionDays: 30,
      healthSyncLightMaxAgeMinutes: 180,
      healthSyncFollowerMaxAgeMinutes: 1080,
      healthSyncMonitoringToken: input?.healthSyncMonitoringToken ?? null,
      telegramBotToken: null,
      telegramChatId: null,
      telegramEnabled: false,
      telegramReportHourUtc: 9,
      serviceEgressProxyUrl: null,
      serviceEgressProxyUsername: null,
      serviceEgressProxyPassword: null,
      isProduction: false,
    },
    logger: createLogger("silent"),
    pool: {} as AppContext["pool"],
    db: {} as AppContext["db"],
    ...(input?.ofapi ? { ofapi: input.ofapi } : {}),
    async close() {},
  } satisfies AppContext;
}

const ownerPrincipal = {
  authMethod: "session" as const,
  user: {
    id: 1,
    username: "owner",
    role: "owner" as const,
    mustChangePassword: false,
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
    mustChangePassword: false,
    assignedPages: [],
  },
  assignedPageIds: [],
};

describe("dashboard static route resolution", () => {
  it("finds dashboard dist from the API module path when cwd is elsewhere", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "agency-hub-static-"));
    const repoDir = path.join(tempDir, "repo");
    const dashboardDist = path.join(repoDir, "apps/dashboard/dist");
    const runtimeDist = path.join(repoDir, "apps/runtime/dist");

    try {
      await mkdir(dashboardDist, { recursive: true });
      await mkdir(runtimeDist, { recursive: true });
      await writeFile(path.join(dashboardDist, "index.html"), "<!doctype html><div id=\"root\"></div>");

      expect(resolveDashboardDistPath({
        cwd: path.join(tempDir, "outside"),
        moduleUrl: pathToFileURL(path.join(runtimeDist, "api.js")).href,
      })).toBe(dashboardDist);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

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
        contractHash: "0".repeat(64),
        capabilities: ["desktop-lifecycle-v2"],
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

  it("routes duck-typed HTTP-shaped throws through the generic 500 boundary", async () => {
    routeMocks.getSystemHealth.mockRejectedValue({
      statusCode: 418,
      error: "operator_prose",
      message: "arbitrary object text must not cross the boundary",
    });
    const server = await buildApiServer(createRouteTestContext());

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/health",
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: "internal_error",
        message: "Internal Server Error",
        statusCode: 500,
      });
    } finally {
      await server.close();
    }
  });

  it("answers a collection-policy refusal with its typed status, reason and reset advice (review #136)", async () => {
    const { OfapiCollectionRefusedError } = await import("../apps/runtime/src/services/errors.ts");
    const now = new Date("2026-09-07T10:00:00.000Z");
    routeMocks.getSystemHealth.mockRejectedValue(
      new OfapiCollectionRefusedError("daily_limit", { retryAt: new Date("2026-09-08T00:00:00.000Z"), now }),
    );
    const server = await buildApiServer(createRouteTestContext());

    try {
      const capped = await server.inject({ method: "GET", url: "/api/v1/health" });
      expect(capped.statusCode).toBe(429);
      expect(capped.headers["retry-after"]).toBe(String(14 * 3600));
      expect(capped.json()).toEqual({
        error: "ofapi_collection_refused",
        message: "OFAPI collection budget for this category is exhausted; retry after it resets",
        statusCode: 429,
        reason: "daily_limit",
        retryAfterMs: 14 * 3600 * 1000,
      });

      routeMocks.getSystemHealth.mockRejectedValue(new OfapiCollectionRefusedError("collection_off"));
      const off = await server.inject({ method: "GET", url: "/api/v1/health" });
      expect(off.statusCode).toBe(409);
      expect(off.headers["retry-after"]).toBeUndefined();
      expect(off.json()).toEqual({
        error: "ofapi_collection_refused",
        message: "OFAPI collection policy refuses this read; change the collection policy to allow it",
        statusCode: 409,
        reason: "collection_off",
        retryAfterMs: null,
      });
    } finally {
      await server.close();
    }
  });

  it("keeps Zod errors useful and bounded without echoing request values", async () => {
    const requestSecret = `sk-ant-${"s".repeat(800)}`;
    const server = await buildApiServer(createRouteTestContext());

    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          username: requestSecret,
          password: [requestSecret],
        },
      });
      const body = response.json() as {
        error: string;
        message: string;
        statusCode: number;
      };

      expect(response.statusCode).toBe(400);
      expect(body.error).toBe("Bad Request");
      expect(body.statusCode).toBe(400);
      expect(body.message.length).toBeLessThanOrEqual(512);
      expect(body.message).toContain("body/username");
      expect(body.message).toContain("body/password");
      expect(body.message).not.toContain(requestSecret);
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

describe("admin credential verification", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // The Fansly check's own path (journal, the candidate proxy, the answers) is
  // in tests/sync-onboard-live.integration.test.ts. Here: the refusals that
  // come before it — with no database (`db` is an empty stub), so nothing
  // could have been journaled or sent.

  it.each([
    ["missing", undefined],
    ["null", null],
  ])("returns 400 for a %s Fansly proxy before anything is sent", async (_label, proxy) => {
    routeMocks.authenticateSessionToken.mockResolvedValue(ownerPrincipal);
    const server = await buildApiServer(createRouteTestContext());

    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/admin/credentials/verify",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=owner-token`,
        },
        payload: {
          platform: "fansly",
          session: {
            authorization: "fansly-token",
          },
          ...(proxy === undefined ? {} : { proxy }),
        },
      });

      expect(response.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("rejects private proxy targets before verifying credentials", async () => {
    routeMocks.authenticateSessionToken.mockResolvedValue(ownerPrincipal);
    const server = await buildApiServer(createRouteTestContext());

    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/admin/credentials/verify",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=owner-token`,
        },
        payload: {
          platform: "fansly",
          session: {
            authorization: "fansly-token",
          },
          proxy: {
            url: "socks5://127.0.0.1:1080",
          },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.stringify(response.json())).toContain("Proxy host");
    } finally {
      await server.close();
    }
  });

  it("verifies OnlyFans identity against the OFAPI account list (Stage 18)", async () => {
    routeMocks.authenticateSessionToken.mockResolvedValue(ownerPrincipal);
    const listAccounts = vi.fn(async () => [{
      id: "acct_42",
      username: "@lora_of",
      onlyfansName: "lora_of",
      displayName: "Lora OF",
      avatarUrl: null,
      onlyfansUserId: null,
    }]);
    const server = await buildApiServer(createRouteTestContext({
      ofapi: { listAccounts } as unknown as AppContext["ofapi"],
    }));

    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/admin/credentials/verify",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=owner-token`,
        },
        payload: {
          platform: "onlyfans",
          username: "Lora_OF",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        valid: true,
        platform: "onlyfans",
        username: "@lora_of",
        displayName: "Lora OF",
      });
      expect(listAccounts).toHaveBeenCalledTimes(1);

      const miss = await server.inject({
        method: "POST",
        url: "/api/v1/admin/credentials/verify",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=owner-token`,
        },
        payload: {
          platform: "onlyfans",
          username: "nobody_here",
        },
      });
      expect(miss.statusCode).toBe(400);
      expect(miss.json().message).toContain("No connected OFAPI account");
    } finally {
      await server.close();
    }
  });
});

describe("auth route parsing", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("accepts lowercase bearer authorization schemes", async () => {
    // Decision 349: the request layer resolves bearers through the structured
    // credential path (principal + refusal reason).
    routeMocks.authenticateBearerCredential.mockResolvedValue({ principal: leadPrincipal, failure: null });
    const server = await buildApiServer(createRouteTestContext());

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: {
          authorization: "bearer chatter-key",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().user.username).toBe("lead");
      expect(routeMocks.authenticateBearerCredential).toHaveBeenCalledWith(
        expect.anything(),
        "chatter-key",
        { clientVersion: null },
      );
    } finally {
      await server.close();
    }
  });
});
