import { fixtureUserId } from "./helpers/user-identity.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findUserByUsername } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createAccountLinkForUserId } from "../apps/runtime/src/services/account-links.ts";
import {
  createUserAccount,
  issueChatterApiKey,
  issueDeviceTokenForUserId,
  setUserPassword,
} from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Decision 349 §4.4: the cabinet's own two operations ("sign out this device",
// "sign out on all devices") and the owner's two ("revoke this sign-in",
// "terminate all access"), each doing exactly what its name says — no more and
// no less.

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

function sessionCookieFrom(response: {
  headers: Record<string, string | string[] | number | undefined>;
}) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || typeof value !== "string") throw new Error("Expected a session cookie");
  return value.split(";")[0]!;
}

async function login(
  activeServer: NonNullable<typeof server>,
  username: string,
  password: string,
) {
  const response = await activeServer.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return sessionCookieFrom(response);
}

async function countRows(db: StartedTestDatabase, sql: string) {
  const result = await db.pool.query<{ count: string }>(sql);
  return Number(result.rows[0]?.count ?? "-1");
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  app = createTestAppContext(testDb, { authPolicyEnforcement: "enforce" });
  server = await buildApiServer(app);
}, 120_000);

beforeEach(async () => {
  if (!testDb || !app) return;
  await resetIntegrationDatabase(testDb.pool);
  await createUserAccount(app, {
    username: "owner",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
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

describe("the cabinet's device list", () => {
  it("shows the caller's live devices and nobody else's", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const firefox = await issueDeviceTokenForUserId(setup.app, {
      userId: await fixtureUserId(setup.app, "grisha"),
      label: "Firefox · Windows",
    }, OWNER_AUDIT);
    const desktop = await issueDeviceTokenForUserId(setup.app, {
      userId: await fixtureUserId(setup.app, "grisha"),
      label: "Desktop · kevin",
    }, OWNER_AUDIT);
    await issueDeviceTokenForUserId(setup.app, {
      userId: await fixtureUserId(setup.app, "owner"),
      label: "Firefox · macOS",
    }, OWNER_AUDIT);

    const cookie = await login(setup.server, "grisha", "chatter-secret-1");
    const response = await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/devices",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const devices = response.json<Array<{ label: string; lastClientVersion: string | null }>>();
    expect(devices.map((device) => device.label).sort())
      .toEqual(["Desktop · kevin", "Firefox · Windows"]);
    expect(devices.every((device) => device.lastClientVersion === null)).toBe(true);
    // The raw bearer is never echoed back into a listing — only the short
    // display prefix the owner's console shows.
    const listed = JSON.stringify(devices);
    expect(listed).not.toContain(firefox.token);
    expect(listed).not.toContain(desktop.token);
  });

  it("hides a device that has been revoked", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const kept = await issueDeviceTokenForUserId(setup.app, {
      userId: await fixtureUserId(setup.app, "grisha"),
      label: "Firefox · Windows",
    }, OWNER_AUDIT);
    const doomed = await issueDeviceTokenForUserId(setup.app, {
      userId: await fixtureUserId(setup.app, "grisha"),
      label: "Desktop · kevin",
    }, OWNER_AUDIT);
    const cookie = await login(setup.server, "grisha", "chatter-secret-1");

    const revoked = await setup.server.inject({
      method: "DELETE",
      url: `/api/v1/auth/devices/${doomed.id}`,
      headers: { cookie },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ revoked: true });

    const devices = (await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/devices",
      headers: { cookie },
    })).json<Array<{ id: number }>>();
    expect(devices.map((device) => device.id)).toEqual([kept.id]);

    // The revoked bearer stops working; the other one keeps working.
    expect((await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${doomed.token}` },
    })).statusCode).toBe(401);
    expect((await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${kept.token}` },
    })).statusCode).toBe(200);
  });

  it("404s somebody else's device instead of confirming it exists", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const ownerDevice = await issueDeviceTokenForUserId(setup.app, {
      userId: await fixtureUserId(setup.app, "owner"),
      label: "Firefox · macOS",
    }, OWNER_AUDIT);
    const cookie = await login(setup.server, "grisha", "chatter-secret-1");

    const response = await setup.server.inject({
      method: "DELETE",
      url: `/api/v1/auth/devices/${ownerDevice.id}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect((await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${ownerDevice.token}` },
    })).statusCode).toBe(200);
  });

  it("refuses a bearer credential on the cabinet routes — they are cookie-only", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await createUserAccount(setup.app, { username: "vera", role: "chatter" }, { source: "cli" });
    const apiKey = (await issueChatterApiKey(setup.app, { userId: await fixtureUserId(setup.app, "vera") }, OWNER_AUDIT)).key;
    const device = await issueDeviceTokenForUserId(setup.app, {
      userId: await fixtureUserId(setup.app, "grisha"),
      label: "Firefox · Windows",
    }, OWNER_AUDIT);

    for (const bearer of [apiKey, device.token]) {
      const response = await setup.server.inject({
        method: "GET",
        url: "/api/v1/auth/devices",
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(response.statusCode).toBe(403);
    }
  });
});

describe("sign out on all devices (self)", () => {
  it("drops every device and every OTHER session, keeping the one asking", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const device = await issueDeviceTokenForUserId(setup.app, {
      userId: await fixtureUserId(setup.app, "grisha"),
      label: "Firefox · Windows",
    }, OWNER_AUDIT);
    const staleCookie = await login(setup.server, "grisha", "chatter-secret-1");
    const cookie = await login(setup.server, "grisha", "chatter-secret-1");

    const response = await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/devices/revoke-all",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deviceTokens: 1, sessions: 1 });

    // The caller's own session survives — signing out everywhere must not
    // throw the person out of the page they clicked it on.
    expect((await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/devices",
      headers: { cookie },
    })).statusCode).toBe(200);
    expect((await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: staleCookie },
    })).statusCode).toBe(401);
    expect((await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${device.token}` },
    })).statusCode).toBe(401);

    // Sessions and API keys of OTHER people are untouched.
    expect(await countRows(
      setup.testDb,
      "select count(*)::text as count from auth_sessions where revoked_at is null",
    )).toBe(1);
  });
});

describe("the owner's revocations", () => {
  it("revokes exactly one sign-in", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const first = await issueDeviceTokenForUserId(setup.app, {
      userId: await fixtureUserId(setup.app, "grisha"),
      label: "Firefox · Windows",
    }, OWNER_AUDIT);
    const second = await issueDeviceTokenForUserId(setup.app, {
      userId: await fixtureUserId(setup.app, "grisha"),
      label: "Desktop · kevin",
    }, OWNER_AUDIT);
    const ownerCookie = await login(setup.server, "owner", "owner-secret");

    const response = await setup.server.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/by-id/${await fixtureUserId(app!, "grisha")}/device-tokens/${first.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revoked: true });

    expect((await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${first.token}` },
    })).statusCode).toBe(401);
    expect((await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${second.token}` },
    })).statusCode).toBe(200);

    const unknown = await setup.server.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/by-id/${await fixtureUserId(app!, "grisha")}/device-tokens/999999`,
      headers: { cookie: ownerCookie },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("terminates devices, sessions, keys and links — and leaves the password alone", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await createUserAccount(setup.app, { username: "vera", role: "chatter" }, { source: "cli" });
    await setUserPassword(setup.app, {
      userId: await fixtureUserId(setup.app, "vera"),
      password: "chatter-secret-2",
    }, OWNER_AUDIT);
    const apiKey = (await issueChatterApiKey(setup.app, { userId: await fixtureUserId(setup.app, "vera") }, OWNER_AUDIT)).key;
    const device = await issueDeviceTokenForUserId(setup.app, {
      userId: await fixtureUserId(setup.app, "vera"),
      label: "Firefox · Windows",
    }, OWNER_AUDIT);
    await createAccountLinkForUserId(setup.app, {
      userId: await fixtureUserId(setup.app, "vera"),
      kind: "password_reset",
    }, OWNER_AUDIT);
    const veraCookie = await login(setup.server, "vera", "chatter-secret-2");
    const ownerCookie = await login(setup.server, "owner", "owner-secret");

    const response = await setup.server.inject({
      method: "POST",
      url: `/api/v1/admin/users/by-id/${await fixtureUserId(app!, "vera")}/terminate-access`,
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      deviceTokens: 1,
      sessions: 1,
      apiKeys: 1,
      links: 1,
    });

    expect((await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${device.token}` },
    })).statusCode).toBe(401);
    expect((await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${apiKey}` },
    })).statusCode).toBe(401);
    expect((await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: veraCookie },
    })).statusCode).toBe(401);

    // The account is neither disabled nor re-passworded: a fresh login works.
    const relogin = await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "vera", password: "chatter-secret-2" },
    });
    expect(relogin.statusCode).toBe(200);
    const user = await findUserByUsername(setup.testDb.db, "vera");
    expect(user?.disabledAt).toBeNull();
  });

  it("refuses to terminate an owner's own access", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const ownerCookie = await login(setup.server, "owner", "owner-secret");

    const response = await setup.server.inject({
      method: "POST",
      url: `/api/v1/admin/users/by-id/${await fixtureUserId(app!, "owner")}/terminate-access`,
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(400);
  });
});
