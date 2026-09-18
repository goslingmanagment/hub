import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFanslyPage, createModel, findUserById, insertAiUsageEvents,
  listChatterUsageSummary, listUserUsageReport,
} from "@agency_hub_core/db";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createAccountLinkForUserId, createInvite, inspectAccountLink, redeemAccountLink,
} from "../apps/runtime/src/services/account-links.ts";
import {
  assignPageToUser, changeOwnPassword, createUserAccount, deactivateUser, deleteUser, grantModelToUser,
  issueDeviceTokenWithPassword, loginWithPassword, reactivateUser, setUserPassword,
} from "../apps/runtime/src/services/auth.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;
let app: AppContext | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let ownerId = 0;
let pageId = 0;
const OLD_PASSWORD = "original-horse-battery-17";
const NEW_PASSWORD = "replacement-horse-battery-29";
const audit = () => ({ source: "cli", actorUserId: ownerId });

function requireSetup(context: { skip: () => void }) {
  if (!testDb || !app || !server) { context.skip(); return null; }
  return { testDb, app, server };
}

async function cookieFor(activeServer: NonNullable<typeof server>, username: string, password: string) {
  const response = await activeServer.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password } });
  expect(response.statusCode).toBe(200);
  const cookie = response.headers["set-cookie"];
  return (Array.isArray(cookie) ? cookie[0]! : String(cookie)).split(";")[0]!;
}

async function seedSpend(db: StartedTestDatabase, userId: number, costMicroUsd: number) {
  await insertAiUsageEvents(db.db, {
    userId,
    events: [{
      clientEventId: "same-client-event",
      feature: "fast-reply", model: "fixture-model", provider: "anthropic",
      pageId, inputTokens: 100, outputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 0,
      costMicroUsd, costApproximate: false, quotaAccepted: true, gatewayOutcome: "completed",
      isCacheHit: false, isRegeneration: false, completedAt: new Date("2026-09-15T12:00:00Z"),
    }],
  });
}

async function waitForUserLockWaiters(db: StartedTestDatabase, minimum: number) {
  await expect.poll(async () => {
    const result = await db.pool.query<{ count: string }>(`
      select count(*)::text as count from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and query ~* 'for (no key )?update'
    `);
    return Number(result.rows[0]?.count ?? 0);
  }, { timeout: 5_000, interval: 10 }).toBeGreaterThanOrEqual(minimum);
}

async function authoritySnapshot(db: StartedTestDatabase, userId: number) {
  const rows: Record<string, unknown[]> = {};
  for (const table of [
    "api_keys", "device_tokens", "pending_device_tokens", "auth_sessions",
    "account_links", "access_grants", "user_page_assignments",
  ]) {
    rows[table] = (await db.pool.query(`select * from ${table} where user_id = $1`, [userId])).rows;
  }
  return { user: await findUserById(db.db, userId), rows };
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
  const owner = await createUserAccount(app, { username: "owner", role: "owner", password: "owner-secret" }, { source: "cli" });
  ownerId = owner!.id;
  const model = await createModel(testDb.db, { slug: "lora-model", name: "Lora" });
  const page = await createFanslyPage(testDb.db, { modelId: model!.id, label: "lora-fansly" });
  pageId = page!.id;
});

afterAll(async () => { await server?.close(); await testDb?.stop(); });

describe("immutable user identities and reusable logins", () => {
  it("allows concurrent owner grants whose audit actors reference each other's locked identities", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const secondOwner = await createUserAccount(setup.app, {
      username: "second-owner", role: "owner", password: OLD_PASSWORD,
    }, audit());
    const blocker = await setup.testDb.pool.connect();
    const outcomes: Array<Promise<PromiseSettledResult<unknown>>> = [];
    // Hold both real service transactions after their user lock and before
    // grant FK checks. This makes the conflicting actor references deterministic.
    await setup.testDb.pool.query(`
      create function pause_identity_grant() returns trigger language plpgsql as $$ begin
        perform pg_advisory_xact_lock_shared(9101501);
        return new;
      end $$;
      create trigger pause_identity_grant before insert on access_grants
        for each row execute function pause_identity_grant();
    `);
    try {
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(9101501)");
      for (const [userId, actorUserId] of [[ownerId, secondOwner.id], [secondOwner.id, ownerId]]) {
        outcomes.push(grantModelToUser(setup.app, { userId: userId!, modelSlug: "lora-model" }, {
          source: "cli", actorUserId: actorUserId!,
        }).then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        ));
      }
      await expect.poll(async () => {
        const result = await setup.testDb.pool.query<{ count: string }>(`
          select count(*)::text as count from pg_stat_activity
          where datname = current_database() and wait_event = 'advisory'
            and query ilike 'insert into "access_grants"%'
        `);
        return Number(result.rows[0]?.count ?? 0);
      }, { timeout: 5_000, interval: 10 }).toBe(2);
      await blocker.query("commit");
      expect(await Promise.all(outcomes)).toEqual([
        { status: "fulfilled", value: { ok: true } },
        { status: "fulfilled", value: { ok: true } },
      ]);
      const grants = await setup.testDb.pool.query("select user_id, granted_by from access_grants order by user_id");
      expect(grants.rows).toEqual([
        { user_id: BigInt(ownerId), granted_by: BigInt(secondOwner.id) },
        { user_id: BigInt(secondOwner.id), granted_by: BigInt(ownerId) },
      ]);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
      await Promise.all(outcomes);
      await setup.testDb.pool.query("drop trigger pause_identity_grant on access_grants; drop function pause_identity_grant()");
    }
  });

  it("retires the original identity without transferring access, links or history to its reused login", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const original = await createInvite(setup.app, { username: "Nikita", pageLabels: ["lora-fansly"] }, audit());
    const originalId = original.user.id;
    await redeemAccountLink(setup.app, { token: original.link.token, password: OLD_PASSWORD });
    await grantModelToUser(setup.app, { userId: originalId, modelSlug: "lora-model" }, audit());
    const originalCookie = await cookieFor(setup.server, "nikita", OLD_PASSWORD);
    const ownerCookie = await cookieFor(setup.server, "owner", "owner-secret");
    const device = await issueDeviceTokenForUserId(setup.app, { userId: originalId, label: "old Firefox" }, audit());
    const pendingResponse = await setup.server.inject({
      method: "POST", url: "/api/v1/auth/device-tokens/password",
      payload: { username: "NIKITA", password: OLD_PASSWORD, label: "old Desktop", mode: "pending" },
    });
    expect(pendingResponse.statusCode).toBe(200);
    const pending = pendingResponse.json<{ token: string }>();
    const oldReset = await createAccountLinkForUserId(setup.app, { userId: originalId, kind: "password_reset" }, audit());
    await seedSpend(setup.testDb, originalId, 1100);

    const removed = await setup.server.inject({
      method: "DELETE", url: `/api/v1/admin/users/by-id/${originalId}`, headers: { cookie: ownerCookie },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ ok: true, revokedDeviceTokens: 1 });
    const replacement = await createInvite(setup.app, { username: "nIKITA", pageLabels: [] }, audit());
    const replacementId = replacement.user.id;
    expect(replacementId).not.toBe(originalId);
    expect(replacement.user.assignedPages).toEqual([]);
    expect(await inspectAccountLink(setup.app, oldReset.token)).toEqual({ state: "revoked" });
    await expect(redeemAccountLink(setup.app, { token: oldReset.token, password: NEW_PASSWORD })).rejects.toMatchObject({ statusCode: 409 });
    await redeemAccountLink(setup.app, { token: replacement.link.token, password: NEW_PASSWORD });

    for (const headers of [
      { cookie: originalCookie },
      { authorization: `Bearer ${device.token}` },
    ]) {
      expect((await setup.server.inject({ method: "GET", url: "/api/v1/auth/me", headers })).statusCode).toBe(401);
    }
    expect((await setup.server.inject({
      method: "POST", url: "/api/v1/auth/device-tokens/activate", headers: { authorization: `Bearer ${pending.token}` },
    })).statusCode).toBe(401);
    await expect(loginWithPassword(setup.app, { username: "nikita", password: OLD_PASSWORD })).rejects.toMatchObject({ statusCode: 401 });

    // Every stale owner control addresses the original ID, never a newly
    // resolved username. Each operation must refuse the deleted identity.
    for (const request of [
      { method: "PATCH", suffix: "/password", payload: { password: "stale-admin-password" } },
      { method: "POST", suffix: "/pages", payload: { pageLabel: "lora-fansly" } },
      { method: "POST", suffix: "/models", payload: { modelSlug: "lora-model" } },
      { method: "POST", suffix: "/reactivate", payload: {} },
      { method: "POST", suffix: "/links", payload: { kind: "password_reset" } },
      { method: "POST", suffix: "/terminate-access", payload: {} },
    ] as const) {
      expect((await setup.server.inject({
        method: request.method, url: `/api/v1/admin/users/by-id/${originalId}${request.suffix}`,
        headers: { cookie: ownerCookie }, payload: request.payload,
      })).statusCode).toBe(404);
    }
    const replacementLogin = await loginWithPassword(setup.app, { username: "NIKITA", password: NEW_PASSWORD });
    expect(replacementLogin.user.id).toBe(replacementId);
    expect(replacementLogin.user.assignedPages).toEqual([]);
    const newGrants = await setup.testDb.pool.query("select id from access_grants where user_id = $1", [replacementId]);
    expect(newGrants.rows).toEqual([]);
    const oldGrants = await setup.testDb.pool.query<{ revoked_at: Date; revoked_by: string }>(
      "select revoked_at, revoked_by from access_grants where user_id = $1", [originalId],
    );
    expect(oldGrants.rows).toHaveLength(2);
    for (const grant of oldGrants.rows) {
      expect(grant.revoked_at).toBeInstanceOf(Date);
      expect(Number(grant.revoked_by)).toBe(ownerId);
    }
    const oldRow = await findUserById(setup.testDb.db, originalId);
    expect(oldRow?.username).toBe("Nikita");
    expect(oldRow?.deletedAt).toBeInstanceOf(Date);
    const history = await setup.testDb.pool.query("select target_user_id from audit_events where event_type = 'user.deleted'");
    expect(history.rows.map((row) => Number(row.target_user_id))).toEqual([originalId]);
    const listed = await setup.server.inject({ method: "GET", url: "/api/v1/admin/users", headers: { cookie: ownerCookie } });
    expect(listed.json<Array<{ id: number }>>().some((user) => user.id === originalId)).toBe(false);
    expect(listed.json<Array<{ id: number }>>().some((user) => user.id === replacementId)).toBe(true);

    await seedSpend(setup.testDb, replacementId, 2700);
    const range = { from: new Date("2026-09-15T00:00:00Z"), toExclusive: new Date("2026-09-16T00:00:00Z") };
    const report = await listChatterUsageSummary(setup.testDb.db, range);
    expect(report.find((row) => row.userId === originalId)).toMatchObject({ totalGenerations: 1, cost: { microUsd: 1100 } });
    expect(report.find((row) => row.userId === replacementId)).toMatchObject({ totalGenerations: 1, cost: { microUsd: 2700 } });
    const own = await listUserUsageReport(setup.testDb.db, { ...range, userId: replacementId, timeZone: "UTC" });
    expect(own.row).toMatchObject({ totalGenerations: 1, cost: { microUsd: 2700 } });
  });

  it("refuses every retired username route even when the login is a valid numeric user ID", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const numeric = await createInvite(setup.app, { username: String(ownerId), pageLabels: [] }, audit());
    const cookie = await cookieFor(setup.server, "owner", "owner-secret");
    for (const [method, suffix, payload] of [
      ["PATCH", "/password", { password: "not-the-owner-password" }],
      ["POST", "/pages", { pageLabel: "lora-fansly" }],
      ["DELETE", "/pages/lora-fansly", undefined],
      ["GET", "/api-keys", undefined], ["POST", "/api-keys", {}], ["DELETE", "/api-keys", undefined],
      ["POST", "/deactivate", {}], ["POST", "/reactivate", {}],
      ["GET", "/device-tokens", undefined], ["POST", "/device-tokens", { label: "must not issue" }],
      ["DELETE", "/device-tokens", undefined], ["DELETE", "/device-tokens/1", undefined],
      ["PATCH", "/device-tokens/1/harvest-capability", { machineId: null }],
      ["POST", "/models", { modelSlug: "lora-model" }], ["DELETE", "/models/lora-model", undefined],
      ["GET", "/grants", undefined], ["GET", "/links", undefined],
      ["POST", "/links", { kind: "invite" }], ["POST", "/links/1/revoke", {}],
      ["POST", "/terminate-access", {}], ["DELETE", "", undefined],
    ] as const) {
      const response = await setup.server.inject({
        method, url: `/api/v1/admin/users/${numeric.user.username}${suffix}`, headers: { cookie },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, `${method} ${suffix}`).toBe(404);
    }
    const current = await setup.server.inject({ method: "GET", url: `/api/v1/admin/users/by-id/${numeric.user.id}/links`, headers: { cookie } });
    expect(current.statusCode).toBe(200);
    expect((await loginWithPassword(setup.app, { username: "owner", password: "owner-secret" })).user.id).toBe(ownerId);
  });

  it("protects owner and self identities, and releases a disabled login only after permanent deletion", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const ownerCookie = await cookieFor(setup.server, "owner", "owner-secret");
    expect((await setup.server.inject({
      method: "DELETE", url: `/api/v1/admin/users/by-id/${ownerId}`, headers: { cookie: ownerCookie },
    })).statusCode).toBe(400);
    const lead = await createUserAccount(setup.app, { username: "lead", role: "team_lead", password: OLD_PASSWORD }, audit());
    const leadCookie = await cookieFor(setup.server, "lead", OLD_PASSWORD);
    const invited = await createInvite(setup.app, { username: "Nikita", pageLabels: [] }, audit());
    expect((await setup.server.inject({
      method: "DELETE", url: `/api/v1/admin/users/by-id/${invited.user.id}`, headers: { cookie: leadCookie },
    })).statusCode).toBe(403);
    await expect(deleteUser(setup.app, { userId: lead!.id }, { source: "cli", actorUserId: lead!.id }))
      .rejects.toMatchObject({ statusCode: 400 });
    await deactivateUser(setup.app, { userId: invited.user.id }, audit());
    await expect(createInvite(setup.app, { username: "nIKITA", pageLabels: [] }, audit()))
      .rejects.toMatchObject({ statusCode: 400 });
    await deleteUser(setup.app, { userId: invited.user.id }, audit());
    const replacement = await createUserAccount(setup.app, { username: "nIKITA", role: "chatter" }, audit());
    expect(replacement!.id).not.toBe(invited.user.id);
    await expect(reactivateUser(setup.app, { userId: invited.user.id }, audit()))
      .rejects.toMatchObject({ statusCode: 404 });
    expect((await findUserById(setup.testDb.db, lead!.id))?.deletedAt).toBeNull();
    expect((await findUserById(setup.testDb.db, ownerId))?.deletedAt).toBeNull();
  });

  it("rolls back all deletion effects if the final audit insert fails", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const invited = await createInvite(setup.app, { username: "Nikita", pageLabels: ["lora-fansly"] }, audit());
    const userId = invited.user.id;
    await redeemAccountLink(setup.app, { token: invited.link.token, password: OLD_PASSWORD });
    await cookieFor(setup.server, "Nikita", OLD_PASSWORD);
    await issueDeviceTokenForUserId(setup.app, { userId, label: "existing device" }, audit());
    const pending = await setup.server.inject({
      method: "POST", url: "/api/v1/auth/device-tokens/password",
      payload: { username: "Nikita", password: OLD_PASSWORD, label: "pending device", mode: "pending" },
    });
    expect(pending.statusCode).toBe(200);
    await createAccountLinkForUserId(setup.app, { userId, kind: "password_reset" }, audit());
    const before = await authoritySnapshot(setup.testDb, userId);
    await setup.testDb.pool.query(`
      create function reject_identity_delete_audit() returns trigger language plpgsql as $$ begin
        if new.event_type = 'user.deleted' then raise exception 'delete audit refused'; end if;
        return new;
      end $$;
      create trigger reject_identity_delete_audit before insert on audit_events
        for each row execute function reject_identity_delete_audit();
    `);
    try {
      await expect(deleteUser(setup.app, { userId }, audit()))
        .rejects.toMatchObject({ cause: { message: "delete audit refused" } });
      expect(await authoritySnapshot(setup.testDb, userId)).toEqual(before);
      await expect(createInvite(setup.app, { username: "nikita", pageLabels: [] }, audit()))
        .rejects.toMatchObject({ statusCode: 400 });
    } finally {
      await setup.testDb.pool.query("drop trigger reject_identity_delete_audit on audit_events; drop function reject_identity_delete_audit()");
    }
    await expect(deleteUser(setup.app, { userId }, audit())).resolves.toMatchObject({ ok: true });
  });

  it("rejects an in-flight self password change across disable and restore even when the hash is unchanged", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const invited = await createInvite(setup.app, { username: "Nikita", pageLabels: [] }, audit());
    const userId = invited.user.id;
    await redeemAccountLink(setup.app, { token: invited.link.token, password: OLD_PASSWORD });
    const before = await findUserById(setup.testDb.db, userId);
    const blocker = await setup.testDb.pool.connect();
    const observed: Array<Promise<{ ok: true } | { ok: false; error: unknown }>> = [];
    const observe = (promise: Promise<unknown>) => {
      const outcome = promise.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
      observed.push(outcome);
      return outcome;
    };
    try {
      await blocker.query("begin");
      await blocker.query("select id from users where id = $1 for update", [userId]);
      const disabled = observe(deactivateUser(setup.app, { userId }, audit()));
      await waitForUserLockWaiters(setup.testDb, 1);
      const restored = observe(reactivateUser(setup.app, { userId }, audit()));
      await waitForUserLockWaiters(setup.testDb, 2);
      const changed = observe(changeOwnPassword(setup.app, { userId, currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }));
      await waitForUserLockWaiters(setup.testDb, 3);
      await blocker.query("commit");
      expect(await disabled).toEqual({ ok: true });
      expect(await restored).toEqual({ ok: true });
      expect(await changed).toMatchObject({ ok: false, error: { statusCode: 401 } });
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
      await Promise.all(observed);
    }
    const after = await findUserById(setup.testDb.db, userId);
    expect(after?.passwordHash).toBe(before?.passwordHash);
    expect(after?.disabledAt).toBeNull();
    expect(after!.deviceTokenEpoch).toBeGreaterThan(before!.deviceTokenEpoch);
    expect((await loginWithPassword(setup.app, { username: "Nikita", password: OLD_PASSWORD })).user.id).toBe(userId);
  });

  it.for([
    "page grant", "model grant", "device token", "link creation", "link redemption",
    "password reset", "password login", "restore",
  ] as const)("refuses racing %s after deletion obtains the user lock first", async (operation, context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const invited = await createInvite(setup.app, { username: "Nikita", pageLabels: [] }, audit());
    const userId = invited.user.id;
    await redeemAccountLink(setup.app, { token: invited.link.token, password: OLD_PASSWORD });
    const resetLink = await createAccountLinkForUserId(setup.app, { userId, kind: "password_reset" }, audit());
    if (operation === "restore") await deactivateUser(setup.app, { userId }, audit());
    const race = (): Promise<unknown> => {
      switch (operation) {
        case "page grant": return assignPageToUser(setup.app, { userId, pageLabel: "lora-fansly" }, audit());
        case "model grant": return grantModelToUser(setup.app, { userId, modelSlug: "lora-model" }, audit());
        // Decision 369 left one way to mint a bearer: username + password. It
        // re-reads the identity under the lock, which is what must refuse here.
        case "device token": return issueDeviceTokenWithPassword(setup.app, {
          username: "nikita", password: OLD_PASSWORD, label: "racing device",
          mode: "active", clientVersion: null,
        });
        case "link creation": return createAccountLinkForUserId(setup.app, { userId, kind: "password_reset" }, audit());
        case "link redemption": return redeemAccountLink(setup.app, { token: resetLink.token, password: NEW_PASSWORD });
        case "password reset": return setUserPassword(setup.app, { userId, password: NEW_PASSWORD }, audit());
        case "password login": return loginWithPassword(setup.app, { username: "nikita", password: OLD_PASSWORD });
        case "restore": return reactivateUser(setup.app, { userId }, audit());
      }
    };
    const blocker = await setup.testDb.pool.connect();
    const observed: Array<Promise<{ ok: true } | { ok: false; error: unknown }>> = [];
    const observe = (promise: Promise<unknown>) => {
      const outcome = promise.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
      observed.push(outcome);
      return outcome;
    };
    try {
      await blocker.query("begin");
      await blocker.query("select id from users where id = $1 for update", [userId]);
      const deletion = observe(deleteUser(setup.app, { userId }, audit()));
      await waitForUserLockWaiters(setup.testDb, 1);
      const contender = observe(race());
      await waitForUserLockWaiters(setup.testDb, 2);
      await blocker.query("commit");
      expect(await deletion).toEqual({ ok: true });
      expect(await contender).toMatchObject({ ok: false, error: { statusCode: expect.any(Number) } });
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
      await Promise.all(observed);
    }
    const deleted = await findUserById(setup.testDb.db, userId);
    expect(deleted?.deletedAt).toBeInstanceOf(Date);
    expect(deleted?.passwordHash).toBeNull();
    if (operation === "restore") expect(deleted?.disabledAt).toBeInstanceOf(Date);
    for (const table of ["api_keys", "device_tokens", "auth_sessions", "account_links", "access_grants"]) {
      const active = await setup.testDb.pool.query(
        `select id from ${table} where user_id = $1 and revoked_at is null${table === "account_links" ? " and used_at is null" : ""}`,
        [userId],
      );
      expect(active.rows, table).toEqual([]);
    }
    const replacement = await createInvite(setup.app, { username: "NIKITA", pageLabels: [] }, audit());
    expect(replacement.user.id).not.toBe(userId);
    expect(replacement.user.assignedPages).toEqual([]);
  });
});
