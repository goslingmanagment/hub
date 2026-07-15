import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findUserByUsername } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  authenticateSessionToken,
  cleanupExpiredSessions,
  changeOwnPassword,
  createUserAccount,
  deactivateUser,
  deviceTokenAdoptionReport,
  issueChatterApiKey,
  issueDeviceToken,
  revokeDeviceTokensForUsername,
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

async function reserve(
  activeServer: NonNullable<typeof server>,
  cookie: string,
) {
  const response = await activeServer.inject({
    method: "POST",
    url: "/api/v1/auth/device-tokens/reservations",
    headers: { cookie },
    payload: { label: "desktop-test" },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{
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
        and query ilike '%for update%'
    `);
    if (Number(result.rows[0]?.count ?? 0) >= minimum) return;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${minimum} user row-lock waiter(s)`);
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
    username: "anton",
    // Phase 2 chatter identities are API-key-only and cannot own passwords;
    // this fixture exercises cookie-session issuance/password races, so use
    // the password-bearing non-owner human role.
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
    request: {
      method: "PATCH" | "DELETE" | "POST";
      url: string;
      payload?: Record<string, unknown>;
    },
  ) {
    const pending = await reserve(
      setup.server,
      await login(setup.server, "anton", "chatter-secret"),
    );
    const ownerCookie = await login(setup.server, "owner", "owner-secret");
    const invalidated = request.payload === undefined
      ? await setup.server.inject({
          method: request.method,
          url: request.url,
          headers: { cookie: ownerCookie },
        })
      : await setup.server.inject({
          method: request.method,
          url: request.url,
          headers: { cookie: ownerCookie },
          payload: request.payload,
        });
    expect(invalidated.statusCode).toBe(200);
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
    const cookie = await login(setup.server, "anton", "chatter-secret");
    const pending = await reserve(setup.server, cookie);
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

  it("preserves the legacy immediate issuance route while activation rejects its prefix", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const cookie = await login(setup.server, "anton", "chatter-secret");
    const issued = await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens",
      headers: { cookie },
      payload: { label: "legacy-client" },
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
    await expectPendingInvalidated(setup, {
      method: "PATCH",
      url: "/api/v1/admin/users/anton/password",
      payload: { password: "new-chatter-secret" },
    });
  });

  it("invalidates pending custody on revoke-all", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await expectPendingInvalidated(setup, {
      method: "DELETE",
      url: "/api/v1/admin/users/anton/device-tokens",
    });
  });

  it("invalidates pending custody on deactivation", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await expectPendingInvalidated(setup, {
      method: "POST",
      url: "/api/v1/admin/users/anton/deactivate",
    });
  });

  it("cleans expired pending rows", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await reserve(setup.server, await login(setup.server, "anton", "chatter-secret"));
    await setup.testDb.pool.query(
      "update pending_device_tokens set expires_at = now() - interval '1 second'",
    );
    await cleanupExpiredSessions(setup.app, new Date());
    const result = await setup.testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from pending_device_tokens",
    );
    expect(result.rows[0]?.count).toBe("0");
  });

  it("recomputes expiry after a row-lock wait and refuses a token that expired while blocked", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const pending = await reserve(
      setup.server,
      await login(setup.server, "anton", "chatter-secret"),
    );
    const user = await findUserByUsername(setup.testDb.db, "anton");
    const blocker = await setup.testDb.pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select id from users where id = $1 for update", [user!.id]);
      const activation = setup.server.inject({
        method: "POST",
        url: "/api/v1/auth/device-tokens/activate",
        headers: { authorization: `Bearer ${pending.token}` },
      });
      await waitForUserLockWaiters(setup.testDb, 1);
      await blocker.query(
        "update pending_device_tokens set expires_at = now() - interval '1 second' where id = $1",
        [pending.reservationId],
      );
      await blocker.query("commit");
      expect((await activation).statusCode).toBe(401);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
    }
    const activeCount = await setup.testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from device_tokens",
    );
    expect(activeCount.rows[0]?.count).toBe("0");
  });
});

describe("legacy/admin issuance authority races", () => {
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
      const issuePromise = issueDeviceToken(setup.app, {
        userId: user!.id,
        label: "racing-legacy-client",
      }, { source: "cli" });
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
    await exerciseRace(setup, () => revokeDeviceTokensForUsername(
      setup.app,
      { username: "anton" },
      { source: "cli" },
    ));
  });

  it("cannot mint after password reset linearizes first", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await exerciseRace(setup, () => setUserPassword(setup.app, {
      username: "anton",
      password: "post-race-secret",
    }, { source: "cli" }));
  });

  it("cannot mint after deactivation linearizes first", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const owner = await findUserByUsername(setup.testDb.db, "owner");
    await exerciseRace(setup, () => deactivateUser(
      setup.app,
      { username: "anton" },
      { source: "cli", actorUserId: owner!.id },
    ));
  });

  it("self-serve issuance revalidates a preverified session after logout", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const cookie = await login(setup.server, "anton", "chatter-secret");
    const sessionToken = cookie.slice(cookie.indexOf("=") + 1);
    // Model the exact route race without an artificial user-row blocker: auth
    // middleware has already accepted this session, logout then commits, and
    // the issuance service must reject the stale captured session id.
    const preverified = await authenticateSessionToken(setup.app, sessionToken);
    expect(preverified?.authMethod).toBe("session");
    if (!preverified || preverified.authSessionId === undefined) {
      throw new Error("Expected a preverified session principal");
    }
    const logout = await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(200);
    await expect(issueDeviceToken(setup.app, {
      userId: preverified.user.id,
      authSessionId: preverified.authSessionId,
      label: "self-serve-race",
    }, {
      source: "api",
      actorUserId: preverified.user.id,
    })).rejects.toThrow(/Session is no longer eligible/);
    const count = await setup.testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from device_tokens where revoked_at is null",
    );
    expect(count.rows[0]?.count).toBe("0");
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

describe("device-token adoption report (D116(c) gate, desktop D19)", () => {
  it("reports per-chatter freshness and gates on every active chatter", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const activeApp = setup.app;

    await createUserAccount(activeApp, { username: "tokenized", role: "chatter" }, { source: "cli" });
    await createUserAccount(activeApp, { username: "keyonly", role: "chatter" }, { source: "cli" });
    await createUserAccount(activeApp, { username: "staletoken", role: "chatter" }, { source: "cli" });

    const tokenized = await findUserByUsername(activeApp.db, "tokenized");
    const fresh = await issueDeviceToken(
      activeApp,
      { userId: tokenized!.id, label: "machine-a" },
      { source: "cli" },
    );
    await setup.testDb.pool.query(
      "update device_tokens set last_used_at = now() where id = $1",
      [fresh.id],
    );

    const stale = await findUserByUsername(activeApp.db, "staletoken");
    const staleIssued = await issueDeviceToken(
      activeApp,
      { userId: stale!.id, label: "machine-b" },
      { source: "cli" },
    );
    await setup.testDb.pool.query(
      "update device_tokens set last_used_at = now() - interval '20 days' where id = $1",
      [staleIssued.id],
    );

    await issueChatterApiKey(activeApp, { username: "keyonly" }, { source: "cli" });

    const report = await deviceTokenAdoptionReport(activeApp);
    const rows = new Map(report.chatters.map((row) => [row.username, row]));
    expect(rows.get("tokenized")).toMatchObject({ hasFreshDeviceToken: true, activeApiKeys: 0 });
    expect(rows.get("staletoken")).toMatchObject({ hasFreshDeviceToken: false });
    expect(rows.get("keyonly")).toMatchObject({ hasFreshDeviceToken: false, activeApiKeys: 1 });
    // owner and the team_lead fixture are not chatters and never appear
    expect(rows.has("owner")).toBe(false);
    expect(rows.has("anton")).toBe(false);
    expect(report.freshWindowDays).toBe(14);
    expect(report.gate.allActiveChattersOnFreshTokens).toBe(false);

    // Disabling the laggards flips the gate: only ACTIVE chatters count.
    await deactivateUser(activeApp, { username: "keyonly" }, { source: "cli" });
    await deactivateUser(activeApp, { username: "staletoken" }, { source: "cli" });
    const after = await deviceTokenAdoptionReport(activeApp);
    expect(after.chatters.map((row) => row.username)).toEqual(["tokenized"]);
    expect(after.gate.allActiveChattersOnFreshTokens).toBe(true);
  });

  it("is owner-only over HTTP", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const response = await setup.server.inject({
      method: "GET",
      url: "/api/v1/admin/device-token-adoption",
      headers: { cookie: await login(setup.server, "anton", "chatter-secret") },
    });
    expect(response.statusCode).toBe(403);
    const ok = await setup.server.inject({
      method: "GET",
      url: "/api/v1/admin/device-token-adoption",
      headers: { cookie: await login(setup.server, "owner", "owner-secret") },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ freshWindowDays: number }>().freshWindowDays).toBe(14);
  });
});
