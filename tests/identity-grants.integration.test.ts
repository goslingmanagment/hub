import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  listUserPageAssignments,
  resolveGrantedPageAssignments,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import {
  authenticateDeviceToken,
  createUserAccount,
  issueChatterApiKey,
} from "../apps/runtime/src/services/auth.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Kernel Stage 22: all-roles sessions, device tokens, the append-only grant
// log, and attribution — against a live server in BOTH read paths (legacy
// assignments and the grants projection).

let testDb: StartedTestDatabase | null = null;
let app: AppContext | null = null;
let legacyServer: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let grantsServer: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let legacyUrl = "";
let grantsUrl = "";
let lanaId = 0;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) {
    return;
  }
  app = createTestAppContext(testDb);

  await createUserAccount(app, {
    username: "dima",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  await createUserAccount(app, {
    username: "anton",
    role: "chatter",
  }, { source: "cli" });
  const model = await createModel(testDb.db, { slug: "lana-model", name: "Lana Model" });
  const lana = await createFanslyPage(testDb.db, { modelId: model.id, label: "lana" });
  lanaId = lana.id;

  legacyServer = await buildApiServer(createTestAppContext(testDb));
  await legacyServer.listen({ port: 0, host: "127.0.0.1" });
  const legacyAddress = legacyServer.server.address();
  if (typeof legacyAddress === "object" && legacyAddress) {
    legacyUrl = `http://127.0.0.1:${legacyAddress.port}`;
  }
  grantsServer = await buildApiServer(createTestAppContext(testDb, { accessGrantsReadEnabled: true }));
  await grantsServer.listen({ port: 0, host: "127.0.0.1" });
  const grantsAddress = grantsServer.server.address();
  if (typeof grantsAddress === "object" && grantsAddress) {
    grantsUrl = `http://127.0.0.1:${grantsAddress.port}`;
  }
}, 120_000);

afterAll(async () => {
  await legacyServer?.close();
  await grantsServer?.close();
  await testDb?.stop();
});

function requireSetup(context: { skip: () => void }) {
  if (!legacyServer || !grantsServer) {
    context.skip();
    return null;
  }
  return true;
}

async function login(baseUrl: string, username: string, password: string) {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return response;
}

function cookieOf(response: Response) {
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

async function get(baseUrl: string, path: string, headers: Record<string, string>) {
  return fetch(`${baseUrl}${path}`, { headers });
}

describe("Stage 22 identity", () => {
  it("chatter password login works; must_change_password gates everything but the auth surface", async (context) => {
    if (!requireSetup(context)) return;

    const ownerCookie = cookieOf(await login(legacyUrl, "dima", "owner-secret"));

    // Owner sets the chatter's password with the must-change flag (invite v1).
    const setResponse = await fetch(`${legacyUrl}/api/v1/admin/users/anton/password`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ password: "first-secret-1", mustChangePassword: true }),
    });
    expect(setResponse.status).toBe(200);

    const chatterLogin = await login(legacyUrl, "anton", "first-secret-1");
    expect(chatterLogin.status).toBe(200);
    const chatterCookie = cookieOf(chatterLogin);
    const loginBody = await chatterLogin.json() as { user: { mustChangePassword: boolean } };
    expect(loginBody.user.mustChangePassword).toBe(true);

    // Everything but the self-serve auth surface is gated…
    const blocked = await get(legacyUrl, "/api/v1/pages", { cookie: chatterCookie });
    expect(blocked.status).toBe(403);
    // …while me stays reachable.
    const me = await get(legacyUrl, "/api/v1/auth/me", { cookie: chatterCookie });
    expect(me.status).toBe(200);

    // Change the password: sessions are revoked; the new credential logs in
    // clean and the gate is gone.
    const change = await fetch(`${legacyUrl}/api/v1/auth/change-password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: chatterCookie },
      body: JSON.stringify({ currentPassword: "first-secret-1", newPassword: "chosen-secret-1" }),
    });
    expect(change.status).toBe(200);
    expect((await get(legacyUrl, "/api/v1/auth/me", { cookie: chatterCookie })).status).toBe(401);

    const relogin = await login(legacyUrl, "anton", "chosen-secret-1");
    expect(relogin.status).toBe(200);
    const freshCookie = cookieOf(relogin);
    const pages = await get(legacyUrl, "/api/v1/pages", { cookie: freshCookie });
    expect(pages.status).toBe(200);

    // The dashboard stays owner/team_lead: a chatter SESSION cannot read
    // dashboard-gated routes even without the must-change gate.
    const dashboard = await get(legacyUrl, "/api/v1/models", { cookie: freshCookie });
    expect(dashboard.status).toBe(403);
  });

  it("device tokens: issue via session, dual-accepted beside api keys, revoke → 401, expire → 401", async (context) => {
    if (!requireSetup(context)) return;

    const chatterCookie = cookieOf(await login(legacyUrl, "anton", "chosen-secret-1"));
    const issued = await fetch(`${legacyUrl}/api/v1/auth/device-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: chatterCookie },
      body: JSON.stringify({ label: "antons-macbook" }),
    });
    expect(issued.status).toBe(200);
    const deviceToken = (await issued.json() as { token: string }).token;
    expect(deviceToken.startsWith("agency_hub_device_")).toBe(true);

    // Grant the page through the normal admin route so both credentials see it.
    const ownerCookie = cookieOf(await login(legacyUrl, "dima", "owner-secret"));
    await fetch(`${legacyUrl}/api/v1/admin/users/anton/pages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ pageLabel: "lana" }),
    });
    const apiKey = (await issueChatterApiKey(app!, { username: "anton" }, { source: "cli" })).key;

    // Parallel acceptance: SAME user, api key AND device token, one run.
    const viaKey = await get(legacyUrl, "/api/v1/auth/me", { authorization: `Bearer ${apiKey}` });
    expect(viaKey.status).toBe(200);
    expect((await viaKey.json() as { authMethod: string }).authMethod).toBe("api_key");

    const viaDevice = await get(legacyUrl, "/api/v1/auth/me", { authorization: `Bearer ${deviceToken}` });
    expect(viaDevice.status).toBe(200);
    expect((await viaDevice.json() as { authMethod: string }).authMethod).toBe("device_token");

    // Device tokens ride kind:"apiKey" routes (the additive vocabulary rule).
    const subscribers = await get(legacyUrl, "/api/v1/pages/lana/subscribers", {
      authorization: `Bearer ${deviceToken}`,
    });
    expect(subscribers.status).toBe(200);

    // Expiry: an expired row stops authenticating (clock via direct update).
    await testDb!.pool.query(
      "update device_tokens set expires_at = now() - interval '1 minute' where label = 'antons-macbook'",
    );
    // Decision 347: the lane answers with a principal OR a structured refusal;
    // an expired row yields no principal and the reason the client heals on.
    expect(await authenticateDeviceToken(app!, deviceToken)).toEqual({
      principal: null,
      failure: { reason: "token_expired" },
    });
    await testDb!.pool.query(
      "update device_tokens set expires_at = now() + interval '1 day' where label = 'antons-macbook'",
    );

    // Admin revoke-all: device 401s, the api key keeps working (independent kinds).
    const revoke = await fetch(`${legacyUrl}/api/v1/admin/users/anton/device-tokens`, {
      method: "DELETE",
      headers: { cookie: ownerCookie },
    });
    expect(revoke.status).toBe(200);
    expect((await get(legacyUrl, "/api/v1/auth/me", { authorization: `Bearer ${deviceToken}` })).status).toBe(401);
    expect((await get(legacyUrl, "/api/v1/auth/me", { authorization: `Bearer ${apiKey}` })).status).toBe(200);
  });

  it("grants: parity with assignments, model-scope reaches FUTURE pages, revoke-all → 403", async (context) => {
    if (!requireSetup(context)) return;

    // Parity: for every user the grants projection equals the assignment set.
    const antonId = (await testDb!.pool.query("select id from users where username = 'anton'")).rows[0].id as number;
    const [assignments, granted] = await Promise.all([
      listUserPageAssignments(testDb!.db, antonId),
      resolveGrantedPageAssignments(testDb!.db, antonId),
    ]);
    expect(granted.map((row) => row.pageId).sort()).toEqual(assignments.map((row) => row.pageId).sort());
    expect(granted).toEqual(assignments);

    // Model-scope grant expands to pages created AFTER the grant.
    const ownerCookie = cookieOf(await login(grantsUrl, "dima", "owner-secret"));
    await createUserAccount(app!, { username: "vera", role: "chatter" }, { source: "cli" });
    const grant = await fetch(`${grantsUrl}/api/v1/admin/users/vera/models`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ modelSlug: "lana-model" }),
    });
    expect(grant.status).toBe(200);

    const veraKey = (await issueChatterApiKey(app!, { username: "vera" }, { source: "cli" })).key;
    // Existing page of the model: visible through the grants read path.
    expect((await get(grantsUrl, "/api/v1/pages/lana/subscribers", { authorization: `Bearer ${veraKey}` })).status).toBe(200);
    // …and on the LEGACY read path it is NOT (no assignment row exists) —
    // the read-path flip is exactly what turns model grants on.
    expect((await get(legacyUrl, "/api/v1/pages/lana/subscribers", { authorization: `Bearer ${veraKey}` })).status).toBe(403);

    // A page born after the grant is covered with no further admin action.
    await createFanslyPage(testDb!.db, { modelId: (await testDb!.pool.query(
      "select id from models where slug = 'lana-model'",
    )).rows[0].id as number, label: "lana2" });
    expect((await get(grantsUrl, "/api/v1/pages/lana2/subscribers", { authorization: `Bearer ${veraKey}` })).status).toBe(200);

    // Revoke the model grant: every page of it goes dark (deny wins).
    const revoke = await fetch(`${grantsUrl}/api/v1/admin/users/vera/models/lana-model`, {
      method: "DELETE",
      headers: { cookie: ownerCookie },
    });
    expect(revoke.status).toBe(200);
    expect((await get(grantsUrl, "/api/v1/pages/lana/subscribers", { authorization: `Bearer ${veraKey}` })).status).toBe(403);
    expect((await get(grantsUrl, "/api/v1/pages/lana2/subscribers", { authorization: `Bearer ${veraKey}` })).status).toBe(403);

    // The history answers "who had access": the revoked grant is stamped, not gone.
    const history = await get(grantsUrl, "/api/v1/admin/users/vera/grants", { cookie: ownerCookie });
    expect(history.status).toBe(200);
    const { grants } = await history.json() as { grants: Array<{ scopeType: string; scopeLabel: string | null; revokedAt: string | null }> };
    const modelGrant = grants.find((row) => row.scopeType === "model");
    expect(modelGrant).toBeDefined();
    expect(modelGrant!.scopeLabel).toBe("lana-model");
    expect(modelGrant!.revokedAt).not.toBeNull();
  });

  it("unassign stamps the grant instead of losing history; both read paths agree after", async (context) => {
    if (!requireSetup(context)) return;

    const ownerCookie = cookieOf(await login(legacyUrl, "dima", "owner-secret"));
    const unassign = await fetch(`${legacyUrl}/api/v1/admin/users/anton/pages/lana`, {
      method: "DELETE",
      headers: { cookie: ownerCookie },
    });
    expect(unassign.status).toBe(200);

    const rows = await testDb!.pool.query(
      `select revoked_at from access_grants g
       join users u on u.id = g.user_id
       where u.username = 'anton' and g.scope_type = 'page' and g.scope_id = $1
       order by g.granted_at desc limit 1`,
      [lanaId],
    );
    expect(rows.rows[0].revoked_at).not.toBeNull();

    const antonId = (await testDb!.pool.query("select id from users where username = 'anton'")).rows[0].id as number;
    const [assignments, granted] = await Promise.all([
      listUserPageAssignments(testDb!.db, antonId),
      resolveGrantedPageAssignments(testDb!.db, antonId),
    ]);
    expect(assignments).toEqual([]);
    expect(granted).toEqual([]);
  });

  it("attributes workboard contacts and snoozes to the acting human", async (context) => {
    if (!requireSetup(context)) return;

    // Seed a fan on lana so the snooze insert-select matches.
    const fan = await testDb!.pool.query(
      `insert into fans (platform, platform_user_id) values ('fansly', 'fan-attr-1') returning id`,
    );
    const fanId = Number(fan.rows[0].id);
    await testDb!.pool.query(
      "insert into page_fans (fan_id, platform_account_id) values ($1, $2)",
      [fanId, lanaId],
    );

    const ownerCookie = cookieOf(await login(legacyUrl, "dima", "owner-secret"));
    const contact = await fetch(`${legacyUrl}/api/v1/pages/lana/workboard/v2/contact`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ fanId, action: "handled", wasProductive: false }),
    });
    expect(contact.status).toBe(200);
    const snooze = await fetch(`${legacyUrl}/api/v1/pages/lana/workboard/v2/snooze`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ fanId, days: 7 }),
    });
    expect(snooze.status).toBe(200);

    const ownerId = (await testDb!.pool.query("select id from users where username = 'dima'")).rows[0].id as number;
    const contactRow = await testDb!.pool.query(
      "select acted_by_user_id from workboard_contact_log where fan_id = $1 order by id desc limit 1",
      [fanId],
    );
    expect(Number(contactRow.rows[0].acted_by_user_id)).toBe(Number(ownerId));
    const snoozeRow = await testDb!.pool.query(
      "select created_by_user_id from workboard_snoozes where fan_id = $1",
      [fanId],
    );
    expect(Number(snoozeRow.rows[0].created_by_user_id)).toBe(Number(ownerId));
  });
});
