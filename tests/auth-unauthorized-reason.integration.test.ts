import { fixtureUserId } from "./helpers/user-identity.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createUserAccount,
  revokeDeviceTokensForUserId,
} from "../apps/runtime/src/services/auth.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Decision 349 §4.5: a 401 for a device token that MATCHED a row says why —
// token_revoked or token_expired — so the client can wipe its custody and show
// a sign-in screen instead of a permanent red line. Anything else says nothing:
// a reason on an unknown digest would be an enumeration oracle.

let testDb: StartedTestDatabase | null = null;
let app: AppContext | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

const OWNER_AUDIT = { source: "cli", actorUserId: 1 } as const;

function requireSetup(context: { skip: () => void }) {
  if (!testDb || !app || !server) {
    context.skip();
    return null;
  }
  return { testDb, app, server };
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
  app = createTestAppContext(testDb);
  server = await buildApiServer(app);
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
  await testDb?.stop();
});

describe("a device token that matched a row", () => {
  it("says token_revoked after the owner revokes it", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const device = await issueDeviceTokenForUserId(setup.app, {
      userId: await fixtureUserId(setup.app, "grisha"),
      label: "Firefox · Windows",
    }, OWNER_AUDIT);
    await revokeDeviceTokensForUserId(setup.app, { userId: await fixtureUserId(setup.app, "grisha") }, OWNER_AUDIT);

    const response = await setup.server.inject({
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
  });

  it("says token_expired once its deadline has passed", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const device = await issueDeviceTokenForUserId(setup.app, {
      userId: await fixtureUserId(setup.app, "grisha"),
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
});
