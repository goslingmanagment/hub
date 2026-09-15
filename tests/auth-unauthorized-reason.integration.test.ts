import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createUserAccount,
  issueChatterApiKey,
  issueDeviceTokenForUsername,
  revokeDeviceTokensForUsername,
} from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Decision 347 §4.5: a 401 for a device token that MATCHED a row says why —
// token_revoked or token_expired — so the client can wipe its custody and show
// a sign-in screen instead of a permanent red line. Anything else says nothing:
// a reason on an unknown digest would be an enumeration oracle.

let testDb: StartedTestDatabase | null = null;
let app: AppContext | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let loggingServer: Awaited<ReturnType<typeof buildApiServer>> | null = null;

const OWNER_AUDIT = { source: "cli", actorUserId: 1 } as const;

function requireSetup(context: { skip: () => void }) {
  if (!testDb || !app || !server || !loggingServer) {
    context.skip();
    return null;
  }
  return { testDb, app, server, loggingServer };
}

async function expireToken(db: StartedTestDatabase, deviceTokenId: number) {
  await db.pool.query(
    "update device_tokens set expires_at = now() - interval '1 minute' where id = $1",
    [deviceTokenId],
  );
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  app = createTestAppContext(testDb, { authPolicyEnforcement: "enforce" });
  server = await buildApiServer(app);
  // The same body must come out of the in-handler guards, which are still the
  // deciding layer wherever policy enforcement is only logging (#143).
  loggingServer = await buildApiServer(createTestAppContext(testDb, {
    authPolicyEnforcement: "log",
  }));
}, 120_000);

beforeEach(async () => {
  if (!testDb || !app) return;
  await resetIntegrationDatabase(testDb.pool);
  await createUserAccount(app, {
    username: "grisha",
    role: "team_lead",
    password: "chatter-secret-1",
  }, { source: "cli" });
});

afterAll(async () => {
  await server?.close();
  await loggingServer?.close();
  await testDb?.stop();
});

describe("a device token that matched a row", () => {
  it("says token_revoked after the owner revokes it — through the policy layer and the handler guard alike", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const device = await issueDeviceTokenForUsername(setup.app, {
      username: "grisha",
      label: "Firefox · Windows",
    }, OWNER_AUDIT);
    await revokeDeviceTokensForUsername(setup.app, { username: "grisha" }, OWNER_AUDIT);

    for (const activeServer of [setup.server, setup.loggingServer]) {
      const response = await activeServer.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: { authorization: `Bearer ${device.token}` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: "unauthorized",
        statusCode: 401,
        reason: "token_revoked",
      });
    }
  });

  it("says token_expired once its deadline has passed", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const device = await issueDeviceTokenForUsername(setup.app, {
      username: "grisha",
      label: "Firefox · Windows",
    }, OWNER_AUDIT);
    await expireToken(setup.testDb, device.id);

    const response = await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${device.token}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ reason?: string }>().reason).toBe("token_expired");
  });

  it("carries the reason on an ordinary domain route too, not just on /auth/me", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const device = await issueDeviceTokenForUsername(setup.app, {
      username: "grisha",
      label: "Firefox · Windows",
    }, OWNER_AUDIT);
    await revokeDeviceTokensForUsername(setup.app, { username: "grisha" }, OWNER_AUDIT);

    const response = await setup.server.inject({
      method: "GET",
      url: "/api/v1/pages",
      headers: { authorization: `Bearer ${device.token}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ reason?: string }>().reason).toBe("token_revoked");
  });
});

describe("everything else stays silent", () => {
  it("gives NO reason for a digest that matches nothing", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const response = await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: "Bearer agency_hub_device_this-token-never-existed" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "unauthorized",
      message: expect.any(String),
      statusCode: 401,
    });
    expect(response.json<{ reason?: string }>().reason).toBeUndefined();
  });

  it("gives NO reason for a missing credential or a dead cookie session", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    for (const headers of [{}, { cookie: "agency_hub_core_session=not-a-session" }]) {
      const response = await setup.server.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json<{ reason?: string }>().reason).toBeUndefined();
    }
  });

  it("gives NO reason for a revoked API key — that lane has no self-healing contract", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await createUserAccount(setup.app, { username: "vera", role: "chatter" }, { source: "cli" });
    const apiKey = (await issueChatterApiKey(setup.app, { username: "vera" }, OWNER_AUDIT)).key;
    await setup.testDb.pool.query("update api_keys set revoked_at = now()");

    const response = await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ reason?: string }>().reason).toBeUndefined();
  });
});

describe("the cabinet is cookie-only", () => {
  it("answers 403, not 401, for a live device token on an any-session route", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const device = await issueDeviceTokenForUsername(setup.app, {
      username: "grisha",
      label: "Firefox · Windows",
    }, OWNER_AUDIT);

    const response = await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/devices",
      headers: { authorization: `Bearer ${device.token}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ reason?: string }>().reason).toBeUndefined();
  });
});
