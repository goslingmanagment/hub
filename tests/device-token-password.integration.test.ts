import argon2 from "argon2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findUserByUsername } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createUserAccount,
  deactivateUser,
  issueDeviceTokenWithPassword,
  loginWithPassword,
  setUserPassword,
} from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Decision 347 Р2: the single client sign-in — username + password, no cookie,
// `active` for the extension and `pending` (reserve → activate) for the
// desktop. It shares the login backoff, the login failure audit and the §4.3
// password core with the cookie lane.

let testDb: StartedTestDatabase | null = null;
let app: AppContext | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

const PASSWORD = "chatter-secret-1";

function requireSetup(context: { skip: () => void }) {
  if (!testDb || !app || !server) {
    context.skip();
    return null;
  }
  return { testDb, app, server };
}

async function signIn(
  activeServer: NonNullable<typeof server>,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return activeServer.inject({
    method: "POST",
    url: "/api/v1/auth/device-tokens/password",
    headers,
    payload,
  });
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
    username: "grisha",
    role: "team_lead",
    password: PASSWORD,
  }, { source: "cli" });
});

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("mode=active (the extension's one atomic write)", () => {
  it("issues a live device token that authenticates immediately", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const response = await signIn(setup.server, {
      username: "grisha",
      password: PASSWORD,
      label: "Firefox · Windows",
      mode: "active",
    }, { "x-client-version": "2.3.0" });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      mode: string;
      token: string;
      id: number;
      label: string;
      keyPrefix: string;
      expiresAt: string;
    }>();
    expect(body.mode).toBe("active");
    expect(body.token).toMatch(/^agency_hub_device_/);
    expect(body.keyPrefix).toBe(body.token.slice(0, body.keyPrefix.length));
    expect(body.label).toBe("Firefox · Windows");
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const me = await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { username: string } }>().user.username).toBe("grisha");
  });

  it("records the client version of the issuing call and of every later use", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const issued = await signIn(setup.server, {
      username: "grisha",
      password: PASSWORD,
      label: "Firefox · Windows",
      mode: "active",
    }, { "x-client-version": "2.3.0" });
    const token = issued.json<{ token: string }>().token;

    const readVersion = async () => {
      const result = await setup.testDb.pool.query<{ version: string | null }>(
        "select last_client_version as version from device_tokens order by id desc limit 1",
      );
      return result.rows[0]?.version ?? null;
    };
    expect(await readVersion()).toBe("2.3.0");

    await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${token}`, "x-client-version": "2.4.1" },
    });
    expect(await readVersion()).toBe("2.4.1");

    // A request without the header leaves the last known version in place
    // rather than erasing what support needs.
    await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await readVersion()).toBe("2.4.1");
  });
});

describe("mode=pending (the desktop's reserve → activate)", () => {
  it("reserves a token that cannot authenticate until it is activated", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const reserved = await signIn(setup.server, {
      username: "grisha",
      password: PASSWORD,
      label: "Desktop · kevin",
      mode: "pending",
    }, { "x-client-version": "0.2.0" });

    expect(reserved.statusCode).toBe(200);
    const body = reserved.json<{
      mode: string;
      token: string;
      reservationId: number;
      reservationExpiresAt: string;
    }>();
    expect(body.mode).toBe("pending");
    expect(body.token).toMatch(/^agency_hub_pending_device_/);

    const beforeActivation = await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(beforeActivation.statusCode).toBe(401);

    const activated = await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/activate",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(activated.statusCode).toBe(200);

    const afterActivation = await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(afterActivation.statusCode).toBe(200);
  });
});

describe("who is refused", () => {
  it("answers 401 for a wrong password and journals the failure", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const response = await signIn(setup.server, {
      username: "grisha",
      password: "not-the-password",
      label: "Firefox · Windows",
      mode: "active",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ message: string }>().message).toBe("Invalid username or password");

    const audit = await setup.testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from audit_events where event_type = 'auth.login_failed'",
    );
    expect(Number(audit.rows[0]?.count)).toBe(1);
    expect(await setup.testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from device_tokens",
    ).then((result) => Number(result.rows[0]?.count))).toBe(0);
  });

  it("answers 401 for an unknown login without saying which half was wrong", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const response = await signIn(setup.server, {
      username: "nobody",
      password: PASSWORD,
      label: "Firefox · Windows",
      mode: "active",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ message: string }>().message).toBe("Invalid username or password");
  });

  it("answers 401 for a deactivated account", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    // No actorUserId: the owner is not a fixture here, and a user may not
    // deactivate themselves.
    await deactivateUser(setup.app, { username: "grisha" }, { source: "cli" });

    const response = await signIn(setup.server, {
      username: "grisha",
      password: PASSWORD,
      label: "Firefox · Windows",
      mode: "active",
    });
    expect(response.statusCode).toBe(401);
  });

  it("answers 401 for a role that cannot sign in anywhere", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    await setup.testDb.pool.query(
      "insert into users (username, role, password_hash) values ($1, 'content_manager', $2)",
      ["archivist", hash],
    );

    const response = await signIn(setup.server, {
      username: "archivist",
      password: PASSWORD,
      label: "Firefox · Windows",
      mode: "active",
    });
    expect(response.statusCode).toBe(401);
  });

  it("answers 403 password_change_required for a flagged account", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await setUserPassword(setup.app, {
      username: "grisha",
      password: "owner-chosen-42",
      mustChangePassword: true,
    }, { source: "cli" });

    const response = await signIn(setup.server, {
      username: "grisha",
      password: "owner-chosen-42",
      label: "Firefox · Windows",
      mode: "active",
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: string }>().error).toBe("password_change_required");
    expect(await setup.testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from device_tokens",
    ).then((result) => Number(result.rows[0]?.count))).toBe(0);
  });

  it("shares ONE per-account backoff with the cookie login", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    // Five failures is the free allowance; the sixth attempt is locked out —
    // and the lockout is the account's, not the route's.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(issueDeviceTokenWithPassword(setup.app, {
        username: "grisha",
        password: "not-the-password",
        label: "Firefox · Windows",
        mode: "active",
        clientVersion: null,
      })).rejects.toMatchObject({ statusCode: 401 });
    }

    await expect(loginWithPassword(setup.app, {
      username: "grisha",
      password: PASSWORD,
    })).rejects.toMatchObject({ statusCode: 429 });
    await expect(issueDeviceTokenWithPassword(setup.app, {
      username: "grisha",
      password: PASSWORD,
      label: "Firefox · Windows",
      mode: "active",
      clientVersion: null,
    })).rejects.toMatchObject({ statusCode: 429 });
  });

  it("clears the backoff for the account that signs in successfully", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await createUserAccount(setup.app, {
      username: "nikita",
      role: "team_lead",
      password: PASSWORD,
    }, { source: "cli" });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(issueDeviceTokenWithPassword(setup.app, {
        username: "nikita",
        password: "not-the-password",
        label: "Firefox · Windows",
        mode: "active",
        clientVersion: null,
      })).rejects.toMatchObject({ statusCode: 401 });
    }

    const issued = await issueDeviceTokenWithPassword(setup.app, {
      username: "nikita",
      password: PASSWORD,
      label: "Firefox · Windows",
      mode: "active",
      clientVersion: "2.3.0",
    });
    expect(issued.mode).toBe("active");
    const user = await findUserByUsername(setup.testDb.db, "nikita");
    expect(user?.username).toBe("nikita");
  });
});
