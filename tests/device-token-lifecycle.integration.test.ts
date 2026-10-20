import { fixtureUserId } from "./helpers/user-identity.ts";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findUserByUsername } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  changeOwnPassword,
  createUserAccount,
  issueDeviceTokenWithPassword,
  revokeDeviceTokensForUserId,
  setUserPassword,
} from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;
let app: AppContext | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

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
  if (!value || typeof value !== "string") throw new Error("Expected session cookie");
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

/** Decision 370: the desktop reserves by password, never from a cookie. */
async function reserve(activeServer: NonNullable<typeof server>) {
  const response = await activeServer.inject({
    method: "POST",
    url: "/api/v1/auth/device-tokens/password",
    payload: {
      username: "anton",
      password: "chatter-secret",
      label: "desktop-test",
      mode: "pending",
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{
    mode: "pending";
    token: string;
    reservationId: number;
    label: string;
    keyPrefix: string;
    reservationExpiresAt: string;
  }>();
}

async function waitForUserLockWaiters(
  db: StartedTestDatabase,
  minimum: number,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await db.pool.query<{ count: string }>(`
      select count(*)::text as count
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and query ~* 'for (no key )?update'
    `);
    if (Number(result.rows[0]?.count ?? 0) >= minimum) return;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${minimum} user row-lock waiter(s)`);
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
    username: "owner",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  await createUserAccount(app, {
    username: "anton",
    // This fixture signs devices in by password and races that against the
    // credential boundaries, so it needs a non-owner human role that can hold
    // a password without redeeming an invite link.
    role: "team_lead",
    password: "chatter-secret",
  }, { source: "cli" });
});

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("pending device-token activation protocol", () => {
  async function expectPendingInvalidated(
    setup: NonNullable<ReturnType<typeof requireSetup>>,
    boundary: (ownerCookie: string) => Promise<void>,
  ) {
    const pending = await reserve(setup.server);
    const ownerCookie = await login(setup.server, "owner", "owner-secret");
    await boundary(ownerCookie);
    expect((await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/activate",
      headers: { authorization: `Bearer ${pending.token}` },
    })).statusCode).toBe(401);
    const pendingCount = await setup.testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from pending_device_tokens",
    );
    expect(pendingCount.rows[0]?.count).toBe("0");
  }

  it("keeps a reservation outside ordinary auth, then activates idempotently", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const pending = await reserve(setup.server);
    expect(pending.token).toMatch(/^agency_hub_pending_device_/);

    const beforeActivation = await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${pending.token}` },
    });
    expect(beforeActivation.statusCode).toBe(401);

    const activate = () => setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/activate",
      headers: { authorization: `Bearer ${pending.token}` },
    });
    const [first, retry] = await Promise.all([activate(), activate()]);
    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(first.json()).not.toHaveProperty("token");

    const afterActivation = await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${pending.token}` },
    });
    expect(afterActivation.statusCode).toBe(200);
    const counts = await setup.testDb.pool.query<{
      active: string;
      pending: string;
    }>(`
      select
        (select count(*) from device_tokens where revoked_at is null)::text as active,
        (select count(*) from pending_device_tokens)::text as pending
    `);
    expect(counts.rows[0]).toEqual({ active: "1", pending: "0" });
  });

  it("issues an active token directly while activation rejects its prefix", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const issued = await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/password",
      payload: {
        username: "anton",
        password: "chatter-secret",
        label: "extension-client",
        mode: "active",
      },
    });
    expect(issued.statusCode).toBe(200);
    const body = issued.json<{ token: string }>();
    expect(body.token).toMatch(/^agency_hub_device_/);
    expect((await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/activate",
      headers: { authorization: `Bearer ${body.token}` },
    })).statusCode).toBe(401);
    expect((await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${body.token}` },
    })).statusCode).toBe(200);
  });

  it("invalidates pending custody on password reset", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    // Decision 370: an owner resets by link or CLI; both run this primitive.
    await expectPendingInvalidated(setup, async () => {
      await setUserPassword(setup.app, {
        userId: await fixtureUserId(setup.app, "anton"),
        password: "new-chatter-secret",
      }, { source: "cli" });
    });
  });

  it("invalidates pending custody on revoke-all", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await expectPendingInvalidated(setup, async (ownerCookie) => {
      const response = await setup.server.inject({
        method: "DELETE",
        url: `/api/v1/admin/users/by-id/${await fixtureUserId(setup.app, "anton")}/device-tokens`,
        headers: { cookie: ownerCookie },
      });
      expect(response.statusCode).toBe(200);
    });
  });
});

describe("password sign-in authority races", () => {
  async function exerciseRace(
    setup: NonNullable<ReturnType<typeof requireSetup>>,
    boundary: () => Promise<unknown>,
  ) {
    const user = await findUserByUsername(setup.testDb.db, "anton");
    const blocker = await setup.testDb.pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select id from users where id = $1 for update", [user!.id]);
      const boundaryPromise = boundary();
      await waitForUserLockWaiters(setup.testDb, 1);
      // §4.3: the password was verified against the row as it stood BEFORE the
      // boundary committed. Re-reading the authority under the lock is what
      // stops this request from minting a token the boundary just outlawed.
      const issuePromise = issueDeviceTokenWithPassword(setup.app, {
        username: "anton",
        password: "chatter-secret",
        label: "racing-client",
        mode: "active",
        clientVersion: null,
      });
      const issueOutcome = issuePromise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitForUserLockWaiters(setup.testDb, 2);
      await blocker.query("commit");
      await boundaryPromise;
      expect((await issueOutcome).ok).toBe(false);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
    }
    const count = await setup.testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from device_tokens where revoked_at is null",
    );
    expect(count.rows[0]?.count).toBe("0");
  }

  it("cannot mint after revoke-all linearizes first", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await exerciseRace(setup, async () => revokeDeviceTokensForUserId(
      setup.app,
      { userId: await fixtureUserId(setup.app, "anton") },
      { source: "cli" },
    ));
  });

  it("only the first of two preverified self-password changes can commit", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const user = await findUserByUsername(setup.testDb.db, "anton");
    const blocker = await setup.testDb.pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select id from users where id = $1 for update", [user!.id]);
      const first = changeOwnPassword(setup.app, {
        userId: user!.id,
        currentPassword: "chatter-secret",
        newPassword: "first-new-secret",
      });
      await waitForUserLockWaiters(setup.testDb, 1);
      const second = changeOwnPassword(setup.app, {
        userId: user!.id,
        currentPassword: "chatter-secret",
        newPassword: "second-new-secret",
      });
      const secondOutcome = second.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitForUserLockWaiters(setup.testDb, 2);
      await blocker.query("commit");
      await expect(first).resolves.toEqual({ ok: true });
      const outcome = await secondOutcome;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toBeInstanceOf(Error);
        expect((outcome.error as Error).message).toMatch(/authority changed/);
      }
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
    }
    expect((await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "anton", password: "first-new-secret" },
    })).statusCode).toBe(200);
    expect((await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "anton", password: "second-new-secret" },
    })).statusCode).toBe(401);
  });
});
