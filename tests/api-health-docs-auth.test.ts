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

const { buildApiServer } = await import("../apps/runtime/src/api/server.ts");
const { SESSION_COOKIE_NAME } = await import("../apps/runtime/src/services/auth.ts");

function createRouteTestContext(input?: {
  healthSyncMonitoringToken?: string | null;
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
      onlyFansDefaultDelayMs: 1000,
      lakeDir: "lake",
      syncPageExecutorConcurrency: 1,
      syncObservabilityRetentionDays: 30,
      healthSyncLightMaxAgeMinutes: 180,
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

describe("health and docs route auth", () => {
  afterEach(() => {
    vi.clearAllMocks();
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
