import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findUserByUsername } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  SESSION_COOKIE_NAME,
  authenticateSessionToken,
  cleanupExpiredSessions,
  changeOwnPassword,
  createUserAccount,
  deactivateUser,
  deviceTokenAdoptionReport,
  issueChatterApiKey,
  issueDeviceToken,
  loginWithPassword,
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

/**
 * UV-001: the session plane's half of the same authority argument the block
 * above makes for device tokens.  These races live here because the harness
 * (waitForUserLockWaiters + a blocking user-row lock) and the fixtures are the
 * ones the device-token races already proved deterministic.
 */
describe("password-authority to session-login linearization (UV-001)", () => {
  type LoginOutcome =
    | { ok: true; value: Awaited<ReturnType<typeof loginWithPassword>> }
    | { ok: false; error: unknown };

  const RACER_PASSWORD = "racer-secret";

  /**
   * Counts every backend blocked on a lock in this database.  The probe above
   * matches on query text, which only sees an explicit `for update`; a login
   * that takes no user lock at all still blocks here, because inserting into
   * auth_sessions needs a KEY SHARE lock on the referenced users row that the
   * blocker's FOR UPDATE conflicts with.  Waiting on this instead keeps the
   * interleaving deterministic for both the fixed and the unfixed login path.
   */
  async function waitForBlockedBackends(db: StartedTestDatabase, minimum: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await db.pool.query<{ count: string }>(`
        select count(*)::text as count
        from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
      `);
      if (Number(result.rows[0]?.count ?? 0) >= minimum) return;
      await sleep(10);
    }
    throw new Error(`Timed out waiting for ${minimum} blocked backend(s)`);
  }

  /** Each race burns one login failure; a dedicated username per test keeps
   * the per-account backoff registry (in-memory, not reset with the db) from
   * coupling these tests to each other. */
  async function createRacer(
    setup: NonNullable<ReturnType<typeof requireSetup>>,
    username: string,
  ) {
    await createUserAccount(setup.app, {
      username,
      role: "team_lead",
      password: RACER_PASSWORD,
    }, { source: "cli" });
    const user = await findUserByUsername(setup.testDb.db, username);
    if (!user) throw new Error(`Expected fixture user ${username}`);
    return user;
  }

  /**
   * Drives exactly the reported interleaving: the boundary reaches the user
   * row lock first, the login then verifies the (still current) old password
   * and queues behind it, and the blocker commit releases both in that order.
   * The login therefore has a fully verified pre-boundary password authority
   * in hand and no session row yet — the UV-001 window.
   */
  async function raceLoginAgainstBoundary(
    setup: NonNullable<ReturnType<typeof requireSetup>>,
    userId: number,
    username: string,
    boundary: () => Promise<unknown>,
  ): Promise<LoginOutcome> {
    const blocker = await setup.testDb.pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select id from users where id = $1 for update", [userId]);
      const boundaryPromise = boundary();
      await waitForBlockedBackends(setup.testDb, 1);
      const loginPromise = loginWithPassword(setup.app, {
        username,
        password: RACER_PASSWORD,
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitForBlockedBackends(setup.testDb, 2);
      await blocker.query("commit");
      await boundaryPromise;
      return await loginPromise;
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
    }
  }

  /** Losing the race (rejected) and winning it (session created, then revoked
   * by the boundary) are both acceptable; a USABLE session is not. */
  async function expectNoUsableSession(
    setup: NonNullable<ReturnType<typeof requireSetup>>,
    userId: number,
    outcome: LoginOutcome,
  ) {
    if (outcome.ok) {
      const token = outcome.value.sessionToken;
      expect(await authenticateSessionToken(setup.app, token)).toBeNull();
      const me = await setup.server.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
      });
      expect(me.statusCode).toBe(401);
    } else {
      expect(outcome.error).toBeInstanceOf(Error);
      // The generic credential 401, not a new "authority changed" oracle.
      expect((outcome.error as Error).message).toBe("Invalid username or password");
    }

    const live = await setup.testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from auth_sessions where user_id = $1 and revoked_at is null",
      [userId],
    );
    expect(live.rows[0]?.count).toBe("0");
  }

  it("admin password reset invalidates a login that verified the old password", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const racer = await createRacer(setup, "resetracer");
    const outcome = await raceLoginAgainstBoundary(
      setup,
      racer.id,
      racer.username,
      () => setUserPassword(setup.app, {
        username: racer.username,
        password: "post-reset-secret",
      }, { source: "cli" }),
    );
    await expectNoUsableSession(setup, racer.id, outcome);
  });

  it("self-serve password change invalidates a login that verified the old password", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const racer = await createRacer(setup, "changeracer");
    const outcome = await raceLoginAgainstBoundary(
      setup,
      racer.id,
      racer.username,
      () => changeOwnPassword(setup.app, {
        userId: racer.id,
        currentPassword: RACER_PASSWORD,
        newPassword: "post-change-secret",
      }),
    );
    await expectNoUsableSession(setup, racer.id, outcome);
  });

  it("deactivation invalidates a login that verified the password", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const racer = await createRacer(setup, "deactivateracer");
    const owner = await findUserByUsername(setup.testDb.db, "owner");
    const outcome = await raceLoginAgainstBoundary(
      setup,
      racer.id,
      racer.username,
      () => deactivateUser(setup.app, { username: racer.username }, {
        source: "cli",
        actorUserId: owner!.id,
      }),
    );
    await expectNoUsableSession(setup, racer.id, outcome);
  });

  it("still revokes the sessions that already existed when the boundary commits", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const cookie = await login(setup.server, "anton", "chatter-secret");
    expect((await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie },
    })).statusCode).toBe(200);

    await setUserPassword(setup.app, {
      username: "anton",
      password: "rotated-secret",
    }, { source: "cli" });

    expect((await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie },
    })).statusCode).toBe(401);
    const revoked = await setup.testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from auth_sessions where revoked_reason = 'password_reset'",
    );
    expect(revoked.rows[0]?.count).toBe("1");
  });

  it("rejects a superseded session even if the revocation sweep never saw it", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const anton = await findUserByUsername(setup.testDb.db, "anton");
    const session = await loginWithPassword(setup.app, {
      username: "anton",
      password: "chatter-secret",
    });
    expect((await authenticateSessionToken(setup.app, session.sessionToken))?.user.username)
      .toBe("anton");

    await setUserPassword(setup.app, {
      username: "anton",
      password: "swept-past-secret",
    }, { source: "cli" });
    // Model the row the sweep missed: un-revoke it and keep the stale epoch
    // stamp, which is exactly the state a session inserted after the sweep
    // would have had before UV-001 was closed.
    await setup.testDb.pool.query(
      "update auth_sessions set revoked_at = null, revoked_reason = null where user_id = $1",
      [anton!.id],
    );

    expect(await authenticateSessionToken(setup.app, session.sessionToken)).toBeNull();
    expect((await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}` },
    })).statusCode).toBe(401);
  });

  it("leaves the ordinary post-reset login working", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await setUserPassword(setup.app, {
      username: "anton",
      password: "brand-new-secret",
    }, { source: "cli" });

    const session = await loginWithPassword(setup.app, {
      username: "anton",
      password: "brand-new-secret",
    });
    const principal = await authenticateSessionToken(setup.app, session.sessionToken);
    expect(principal?.user.username).toBe("anton");
    const me = await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ authMethod: string }>().authMethod).toBe("session");

    // The superseded password stays dead on the ordinary path too.
    await expect(loginWithPassword(setup.app, {
      username: "anton",
      password: "chatter-secret",
    })).rejects.toThrow("Invalid username or password");
  });
});

describe("device-token adoption report (D116(c) foundation, desktop D19)", () => {
  it("reports per-chatter token viability and summary counts", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const activeApp = setup.app;

    for (const username of ["tokenized", "keyonly", "staletoken", "revokedtoken", "expiredtoken"]) {
      await createUserAccount(activeApp, { username, role: "chatter" }, { source: "cli" });
    }

    // Fresh use travels the REAL producer chain: issued bearer -> /auth/me
    // (authenticateDeviceToken bumps last_used_at) -> report.
    const tokenized = await findUserByUsername(activeApp.db, "tokenized");
    const fresh = await issueDeviceToken(
      activeApp,
      { userId: tokenized!.id, label: "machine-a" },
      { source: "cli" },
    );
    const me = await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${fresh.token}` },
    });
    expect(me.statusCode).toBe(200);

    // Stale: live token whose last use predates the 14-day window.
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

    // Revoked-with-recent-use and expired-with-recent-use must NOT count:
    // "once had a working token" is exactly what the gate must not accept.
    const revoked = await findUserByUsername(activeApp.db, "revokedtoken");
    const revokedIssued = await issueDeviceToken(
      activeApp,
      { userId: revoked!.id, label: "machine-c" },
      { source: "cli" },
    );
    await setup.testDb.pool.query(
      "update device_tokens set last_used_at = now() where id = $1",
      [revokedIssued.id],
    );
    await revokeDeviceTokensForUsername(
      activeApp,
      { username: "revokedtoken" },
      { source: "cli" },
    );

    const expired = await findUserByUsername(activeApp.db, "expiredtoken");
    const expiredIssued = await issueDeviceToken(
      activeApp,
      { userId: expired!.id, label: "machine-d" },
      { source: "cli" },
    );
    await setup.testDb.pool.query(
      "update device_tokens set last_used_at = now(), expires_at = now() - interval '1 hour' where id = $1",
      [expiredIssued.id],
    );

    await issueChatterApiKey(activeApp, { username: "keyonly" }, { source: "cli" });

    // A second live-but-unused token with a LATER expiry must not leak its
    // dates into the row: both token fields describe the freshest-used token.
    await setup.testDb.pool.query(
      "update device_tokens set expires_at = now() + interval '2 days' where user_id = $1",
      [tokenized!.id],
    );
    await issueDeviceToken(
      activeApp,
      { userId: tokenized!.id, label: "machine-a-spare" },
      { source: "cli" },
    );

    const report = await deviceTokenAdoptionReport(activeApp);
    const rows = new Map(report.chatters.map((row) => [row.username, row]));
    expect(rows.get("tokenized")).toMatchObject({ hasFreshDeviceToken: true, activeApiKeys: 0 });
    const tokenizedExpiry = Date.parse(rows.get("tokenized")!.deviceTokenExpiresAt!);
    // ~2 days (the used token), never ~90 days (the unused spare).
    expect(tokenizedExpiry - Date.now()).toBeLessThan(3 * 24 * 60 * 60 * 1000);
    expect(rows.get("staletoken")).toMatchObject({ hasFreshDeviceToken: false });
    expect(rows.get("revokedtoken")).toMatchObject({
      hasFreshDeviceToken: false,
      deviceTokenLastUsedAt: null,
      deviceTokenExpiresAt: null,
    });
    expect(rows.get("expiredtoken")).toMatchObject({
      hasFreshDeviceToken: false,
      deviceTokenLastUsedAt: null,
      deviceTokenExpiresAt: null,
    });
    expect(rows.get("keyonly")).toMatchObject({ hasFreshDeviceToken: false, activeApiKeys: 1 });
    expect(rows.get("keyonly")!.apiKeyLastUsedAt).toBeNull();
    // owner and the team_lead fixture are not chatters and never appear
    expect(rows.has("owner")).toBe(false);
    expect(rows.has("anton")).toBe(false);
    expect(report.freshWindowDays).toBe(14);
    expect(report.summary).toEqual({
      activeChatters: 5,
      onFreshTokens: 1,
      withActiveApiKeys: 1,
    });

    // Deactivation removes a chatter from the denominator entirely.
    await deactivateUser(activeApp, { username: "keyonly" }, { source: "cli" });
    const after = await deviceTokenAdoptionReport(activeApp);
    expect(after.chatters.some((row) => row.username === "keyonly")).toBe(false);
    expect(after.summary.activeChatters).toBe(4);
  });

  it("returns zero counts for an empty fleet", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const report = await deviceTokenAdoptionReport(setup.app);
    expect(report.chatters).toEqual([]);
    expect(report.summary).toEqual({
      activeChatters: 0,
      onFreshTokens: 0,
      withActiveApiKeys: 0,
    });
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
