import { afterAll, beforeAll, describe, expect, it } from "vitest";
import argon2 from "argon2";

import { SIGNIN_CLIENTS } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, insertPersonLogin, insertPersonRow, type Database } from "@agency_hub_core/db";

import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { issueAgentKey, updateAgentKeyPages } from "../apps/runtime/src/services/agent-keys.ts";
import { prepareAiGatewayStream } from "../apps/runtime/src/services/ai-gateway.ts";
import { authenticateSessionToken, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { seedSandbox, SANDBOX_CHECKER } from "../apps/runtime/src/services/sandbox/seed.ts";
import { checkServerGrant, mintServerCode, redeemServerCode } from "../apps/runtime/src/services/signin-handoff.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// The doors of the test realm (apps/runtime/src/services/sandbox/realm.ts) one by one: the static reports' guard, the
// sign-in hand-off, every decider of whose a sale is, the writes of the test owner's table, the agent keys' grants,
// the test team's checker and the AI gateway.

const PASSWORDS = {
  SANDBOX_PASSWORD_T_OWNER: "sandbox-owner-1",
  SANDBOX_PASSWORD_T_LEAD: "sandbox-lead-1",
  SANDBOX_PASSWORD_T_CHAT_1: "sandbox-chat-1",
  SANDBOX_PASSWORD_T_CHAT_2: "sandbox-chat-2",
};

let testDb: StartedTestDatabase | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let app: ReturnType<typeof createTestAppContext> | null = null;
const cookie = { owner: "", chatter: "", tOwner: "", tChat: "" };
const ids = { liveSale: 0, testSale: 0, ownerId: 0, checkerKey: "" };

async function login(username: string, password: string): Promise<string> {
  const response = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password } });
  expect(response.statusCode, `login ${username}`).toBe(200);
  const header = response.headers["set-cookie"];
  return String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
}

const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, who: string, payload?: unknown) =>
  server!.inject({ method, url, headers: who === "" ? {} : { cookie: who }, ...(payload === undefined ? {} : { payload: payload as object }) });

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  app = createTestAppContext(testDb);
  const db = app.db as Database;
  const owner = await createUserAccount(app, { username: "dima", role: "owner", password: "owner-secret-1" }, { source: "cli" });
  ids.ownerId = owner.id;
  const ownerPerson = await insertPersonRow(db, {
    code: "dima", displayName: "Owner", kind: "human", role: "owner", state: "working", leftOn: null, telegramUserId: null,
    telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
  });
  await insertPersonLogin(db, { personId: ownerPerson.id, userId: owner.id, linkedByUserId: null });
  const model = await createModel(db, { slug: "lana", name: "Lana" });
  const page = await createFanslyPage(db, { modelId: model.id, label: "live-1" });
  const chatter = await createUserAccount(app, { username: "anton", role: "chatter" }, { source: "cli" });
  await db.execute(sql`update users set password_hash = ${await argon2.hash("chatter-secret-1", { type: argon2.argon2id })} where id = ${chatter.id}`);
  const person = await insertPersonRow(db, {
    code: "live-chatter", displayName: "Anton", kind: "human", role: "chatter", state: "working", leftOn: null, telegramUserId: null,
    telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
  });
  await insertPersonLogin(db, { personId: person.id, userId: chatter.id, linkedByUserId: null });
  await db.execute(sql`insert into user_page_assignments (user_id, platform_account_id) values (${chatter.id}, ${page.id})`);
  const [live] = (await db.execute<{ id: string }>(sql`insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type,
    transaction_state, raw_status, gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, is_active)
    values (${page.id}, 'live-1', 'tip', 'tip', 'posted', 'posted', 20000, 20000, 16000, now() - interval '1 day', 'fansly:rest', true) returning id`)).rows;
  ids.liveSale = Number(live!.id);

  const seeded = await seedSandbox(app, { scenarios: ["shift"], env: PASSWORDS, printCheckerKey: true });
  ids.checkerKey = seeded.checkerKey ?? "";
  const [test] = (await db.execute<{ id: string }>(sql`select id from transactions where source = 'sandbox' order by id limit 1`)).rows;
  ids.testSale = Number(test!.id);

  server = await buildApiServer(createTestAppContext(testDb));
  cookie.owner = await login("dima", "owner-secret-1");
  cookie.chatter = await login("anton", "chatter-secret-1");
  cookie.tOwner = await login("t-owner", PASSWORDS.SANDBOX_PASSWORD_T_OWNER);
  cookie.tChat = await login("t-chat-1", PASSWORDS.SANDBOX_PASSWORD_T_CHAT_1);
}, 300_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("the doors of the test realm", () => {
  it("the static reports' guard: 204 for a live person, 401 with no sign-in, 403 for the test team; auth/me answers both", async (context) => {
    if (!server) return context.skip();
    expect((await call("GET", "/api/v1/auth/static-reports", cookie.owner)).statusCode).toBe(204);
    expect((await call("GET", "/api/v1/auth/static-reports", cookie.chatter)).statusCode).toBe(204);
    expect((await call("GET", "/api/v1/auth/static-reports", "")).statusCode).toBe(401);
    expect((await call("GET", "/api/v1/auth/static-reports", cookie.tChat)).statusCode).toBe(403);
    expect((await call("GET", "/api/v1/auth/static-reports", cookie.tOwner)).statusCode).toBe(403);
    expect((await call("GET", "/api/v1/auth/me", cookie.tChat)).statusCode).toBe(200);
  });

  it("the sign-in hand-off takes a test person only to ContentOps, and never as the owner", async (context) => {
    if (!server || !app || !testDb) return context.skip();
    const sessionOf = async (username: string) => (await testDb!.db.execute<{ id: string; user_id: string }>(sql`
      select s.id, s.user_id from auth_sessions s join users u on u.id = s.user_id where u.username = ${username} and s.revoked_at is null
      order by s.id desc limit 1`)).rows[0]!;
    const tOwner = await sessionOf("t-owner");
    for (const client of SIGNIN_CLIENTS) {
      const code = await mintServerCode(app, { sessionId: Number(tOwner.id), userId: Number(tOwner.user_id), client, next: "/" });
      if (client === "contentops") {
        const redeemed = await redeemServerCode(app, { client, code }, { source: "test" });
        expect(redeemed.owner).toBe(false);
        const check = await checkServerGrant(app, { client, grant: redeemed.grant });
        expect(check.active && check.owner).toBe(false);
        expect(check.active).toBe(true);
      } else {
        await expect(redeemServerCode(app, { client, code }, { source: "test" })).rejects.toThrow(/cannot be redeemed/);
      }
    }
    // The live owner is still the owner everywhere.
    const owner = await sessionOf("dima");
    const code = await mintServerCode(app, { sessionId: Number(owner.id), userId: Number(owner.user_id), client: "taskindex", next: "/" });
    expect((await redeemServerCode(app, { client: "taskindex", code }, { source: "test" })).owner).toBe(true);
  });

  it("every decider of whose a sale is refuses an object of the other realm, for the live owner and the test owner", async (context) => {
    if (!server) return context.skip();
    const deciders = (sale: number, page: string) => [
      ["GET", `/api/v1/sale-disputes/${sale}`, undefined],
      ["POST", "/api/v1/sale-disputes/decide", { transactionId: sale, outcome: "dismiss" }],
      ["POST", "/api/v1/sale-disputes/decide", { transactionId: sale, outcome: "nobody" }],
      ["POST", "/api/v1/sale-disputes/decide", { transactionId: sale, outcome: "first" }],
      ["POST", "/api/v1/sale-nobody/keep", { week: "2026-11-09", transactionIds: [sale] }],
      ["POST", "/api/v1/sale-decisions/1/link", { transactionId: sale }],
      ["POST", "/api/v1/off-platform/1/decide", { decision: "confirm", pageLabel: page }],
    ] as const;
    for (const [method, url, body] of deciders(ids.testSale, "test-1")) {
      const answer = await call(method, url, cookie.owner, body);
      expect(answer.statusCode, `live owner ${method} ${url} on a test object: ${answer.body}`).toBe(404);
      // The refusal is the wall's (sandbox/realm.ts requireDecidedOfRealm), not a missing object.
      expect(answer.body).toMatch(/"message":"(The sale was not found|Not found)"/);
    }
    for (const [method, url, body] of deciders(ids.liveSale, "live-1")) {
      const answer = await call(method, url, cookie.tOwner, body);
      expect([403, 404], `test owner ${method} ${url} on a live object: ${answer.body}`).toContain(answer.statusCode);
    }
    // The pot (and every decision «со слов») comes through the agents' door: a live key on a test sale, the test team's
    // checker on a live sale, are refused.
    await insertPersonRow(app!.db, {
      code: "gengar", displayName: "gengar", kind: "agent", role: "agent", state: "working", leftOn: null, telegramUserId: null,
      telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
    });
    const { token } = await issueAgentKey(app!, { name: "gengar-key", agentCode: "gengar", capabilities: ["write:shift_reports"], pageLabels: ["live-1"], expiresInDays: 30 },
      { source: "cli", actorUserId: ids.ownerId });
    const pot = (sale: number) => ({ transactionId: sale, kind: "pot", pot: "general", saidBy: "владелец", saidAt: "2026-11-10", telegramUserId: 1, sourceRef: "m-1" });
    for (const [key, sale] of [[token, ids.testSale], [ids.checkerKey, ids.liveSale]] as const) {
      const answer = await server!.inject({ method: "POST", url: "/api/v1/agent/sale-decisions", headers: { authorization: `Bearer ${key}` }, payload: pot(sale) });
      expect([403, 404], `pot «со слов» across the wall: ${answer.body}`).toContain(answer.statusCode);
    }
  });

  it("the test owner's writes act on the test team and are refused on the live agency", async (context) => {
    if (!server || !testDb) return context.skip();
    const created = await call("POST", "/api/v1/admin/people", cookie.tOwner, { code: "t-extra", displayName: "Тест: ещё один", role: "chatter" });
    expect(created.statusCode, created.body).toBe(200);
    const [born] = (await testDb.db.execute<{ is_test: boolean }>(sql`select is_test from people where code = 't-extra'`)).rows;
    expect(born!.is_test).toBe(true);
    expect((await call("PATCH", "/api/v1/admin/people/t-chat-2", cookie.tOwner, { note: "проверка" })).statusCode).toBe(200);
    expect((await call("PATCH", "/api/v1/admin/people/live-chatter", cookie.tOwner, { note: "x" })).statusCode).toBe(404);
    expect((await call("GET", "/api/v1/admin/people/live-chatter", cookie.tOwner)).statusCode).toBe(404);
    expect((await call("POST", "/api/v1/admin/people", cookie.tOwner, { code: "t-thief", displayName: "x", role: "chatter", logins: ["anton"] })).statusCode).toBe(400);
    // The live owner's same writes on the test team are refused.
    expect((await call("PATCH", "/api/v1/admin/people/t-chat-2", cookie.owner, { note: "x" })).statusCode).toBe(404);
    expect((await call("GET", "/api/v1/admin/people/t-chat-2", cookie.owner)).statusCode).toBe(404);
    // A device is the session person's own: the test owner cannot revoke a live person's.
    const [device] = (await testDb.db.execute<{ id: string }>(sql`select d.id from device_tokens d join users u on u.id = d.user_id where u.username = 'anton' limit 1`)).rows;
    if (device) expect([403, 404]).toContain((await call("DELETE", `/api/v1/auth/devices/${device.id}`, cookie.tOwner)).statusCode);
  });

  it("a live key never takes a test page, the checker never a live one, and the checker reads only the test team", async (context) => {
    if (!server || !app || !testDb) return context.skip();
    await insertPersonRow(app.db, {
      code: "ledger", displayName: "ledger", kind: "agent", role: "agent", state: "working", leftOn: null, telegramUserId: null,
      telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
    });
    await expect(issueAgentKey(app, { name: "mixed", agentCode: "ledger", capabilities: ["read:team"], pageLabels: ["live-1", "test-1"], expiresInDays: 30 },
      { source: "cli", actorUserId: ids.ownerId })).rejects.toThrow();
    const { key } = await issueAgentKey(app, { name: "ledger-key", agentCode: "ledger", capabilities: ["read:team"], pageLabels: ["live-1"], expiresInDays: 30 },
      { source: "cli", actorUserId: ids.ownerId });
    await expect(updateAgentKeyPages(app, { id: key.id, add: ["test-1"], remove: [] }, { source: "cli", actorUserId: ids.ownerId })).rejects.toThrow();
    const [checker] = (await testDb.db.execute<{ id: string }>(sql`select a.id from agent_keys a join person_agent_keys k on k.agent_key_id = a.id
      join people p on p.id = k.person_id where p.code = ${SANDBOX_CHECKER.code} and a.revoked_at is null`)).rows;
    await expect(updateAgentKeyPages(app, { id: Number(checker!.id), add: ["live-1"], remove: [] }, { source: "cli", actorUserId: ids.ownerId })).rejects.toThrow();

    expect(ids.checkerKey).toMatch(/^agency_hub_agent_/);
    const people = await server.inject({ method: "GET", url: "/api/v1/agent/people", headers: { authorization: `Bearer ${ids.checkerKey}` } });
    expect(people.statusCode, people.body).toBe(200);
    const codes = (JSON.parse(people.body) as { people: Array<{ code: string }> }).people.map((one) => one.code);
    expect(codes).toContain("t-chat-1");
    expect(codes).not.toContain("live-chatter");
    expect(codes).not.toContain("dima");
    const sales = await server.inject({
      method: "POST", url: "/api/v1/agent/team/sales", headers: { authorization: `Bearer ${ids.checkerKey}` },
      payload: { from: new Date(Date.now() - 2 * 86_400_000).toISOString(), to: new Date().toISOString() },
    });
    expect(sales.statusCode, sales.body).toBe(200);
    expect(sales.body).toContain("t-chat-1");
    expect(sales.body).not.toContain("anton");
  });

  it("the AI gateway refuses a test login before anything is reserved", async (context) => {
    if (!app) return context.skip();
    const principal = await authenticateSessionToken(app, cookie.tChat.split("=")[1]!);
    expect(principal).not.toBeNull();
    await expect(prepareAiGatewayStream(app, principal!, { pageLabel: "test-1", platform: "fansly" } as never)).rejects.toThrow(/ИИ тестовой команде/);
  });
});
