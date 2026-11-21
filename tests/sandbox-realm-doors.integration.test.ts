import { afterAll, beforeAll, describe, expect, it } from "vitest";
import argon2 from "argon2";

import { SIGNIN_CLIENTS, type ClientBootstrapResponse } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, createOnlyFansPage, insertPersonLogin, insertPersonRow, type Database } from "@agency_hub_core/db";

import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { issueAgentKey, updateAgentKeyPages } from "../apps/runtime/src/services/agent-keys.ts";
import { prepareAiGatewayStream } from "../apps/runtime/src/services/ai-gateway.ts";
import { authenticateSessionToken, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { seedSandbox, SANDBOX_CHECKER } from "../apps/runtime/src/services/sandbox/seed.ts";
import { handinActorOf } from "../apps/runtime/src/services/shift-handins.ts";
import { handInShiftReport } from "../apps/runtime/src/services/shift-report-board.ts";
import { syncShiftRowsSince } from "../apps/runtime/src/services/shift-rows.ts";
import { checkServerGrant, mintServerCode, redeemServerCode } from "../apps/runtime/src/services/signin-handoff.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// The doors of the test realm (apps/runtime/src/services/sandbox/realm.ts) one by one: the static reports' guard, the
// sign-in hand-off, every decider of whose a sale is, the writes of the test owner's table, the agent keys' grants,
// the test team's checker, the AI gateway, and the extension's door to a real site account: a stand-in page (0435).

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
    const missing = deciders(Number.MAX_SAFE_INTEGER, "∅");
    for (const [index, [method, url, body]] of deciders(ids.testSale, "test-1").entries()) {
      const answer = await call(method, url, cookie.owner, body);
      // The wall answers exactly as for a sale that does not exist (sandbox/objects.ts): no «there, but not yours». A
      // decider's 404, or the week's batch keeping nothing.
      const [missingMethod, missingUrl, missingBody] = missing[index]!;
      const absent = await call(missingMethod, missingUrl, cookie.owner, missingBody);
      const unclocked = (text: string) => text.replace(/"savedAt":"[^"]*"/u, "");
      // An answer that repeats the sale it was asked about repeats the one asked (the wall puts it back).
      const asked = unclocked(absent.body).split(String(Number.MAX_SAFE_INTEGER)).join(String(ids.testSale)).split("∅").join("test-1");
      expect(`${answer.statusCode} ${unclocked(answer.body)}`, `live owner ${method} ${url} on a test object`).toBe(`${absent.statusCode} ${asked}`);
      expect(answer.body).not.toMatch(/"kept":[1-9]/u);
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

  it("the agents' candidate checks: a live key never sees a test candidate, the checker only those", async (context) => {
    if (!server || !app || !testDb) return context.skip();
    const db = testDb.db;
    await db.execute(sql`insert into person_rights (person_id, "right", granted_at)
      select id, 'submits_shift', now() - interval '30 days' from people where code = 't-chat-2' on conflict do nothing`);
    await syncShiftRowsSince(app.db, { from: new Date(Date.now() - 2 * 86_400_000), now: new Date() });
    const [shift] = (await db.execute<{ id: string; user_id: string }>(sql`select s.id, s.user_id from shifts s join users u on u.id = s.user_id
      where u.username = 't-chat-2' and s.state = 'closed' order by s.id limit 1`)).rows;
    const principal = await authenticateSessionToken(app, (await login("t-chat-2", PASSWORDS.SANDBOX_PASSWORD_T_CHAT_2)).split("=")[1]!);
    await handInShiftReport(app, handinActorOf(principal!), { shiftId: Number(shift!.id) });
    await insertPersonRow(app.db, {
      code: "reviewer", displayName: "reviewer", kind: "agent", role: "agent", state: "working", leftOn: null, telegramUserId: null,
      telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
    });
    const { token: live } = await issueAgentKey(app, { name: "reviewer-key", agentCode: "reviewer", capabilities: ["review:shift_reports"], pageLabels: ["live-1"], expiresInDays: 30 },
      { source: "cli", actorUserId: ids.ownerId });
    const checksOf = async (key: string) => {
      const answer = await server!.inject({ method: "GET", url: "/api/v1/agent/shift-reports/checks", headers: { authorization: `Bearer ${key}` } });
      expect(answer.statusCode, answer.body).toBe(200);
      return (JSON.parse(answer.body) as { checks: Array<{ candidateId: number; shiftId: number }> }).checks;
    };
    const tested = await checksOf(ids.checkerKey);
    expect(tested.map((one) => one.shiftId)).toContain(Number(shift!.id));
    expect(await checksOf(live)).toEqual([]);
    const answer = await server.inject({
      method: "POST", url: `/api/v1/agent/shift-reports/checks/${tested[0]!.candidateId}`, headers: { authorization: `Bearer ${live}` },
      payload: { proposals: [] },
    });
    expect(answer.statusCode, answer.body).toBe(404);
  });

  it("the AI gateway refuses a test login before anything is reserved", async (context) => {
    if (!app) return context.skip();
    const principal = await authenticateSessionToken(app, cookie.tChat.split("=")[1]!);
    expect(principal).not.toBeNull();
    await expect(prepareAiGatewayStream(app, principal!, { pageLabel: "test-1", platform: "fansly" } as never)).rejects.toThrow(/ИИ тестовой команде/);
  });
});

describe("sandbox:seed --print-invite [code]", () => {
  it("mints a link of a test login where Hub «Люди» would send it: ContentOps for t-km, Workboard's name for t-new", async (context) => {
    if (!app) return context.skip();
    const km = await seedSandbox(app, { scenarios: [], env: PASSWORDS, printInvite: "t-km" });
    expect(km.invite).toMatch(/^https:\/\/contentops\.gosling-agency\.ru\/join#.+/);
    const fresh = await seedSandbox(app, { scenarios: [], env: PASSWORDS, printInvite: true });
    expect(fresh.invite).toMatch(/^https:\/\/workboard\.gosling-agency\.ru\/join#.+/);
    // A login with a password gets a new password's link, as «Сбросить пароль ссылкой» gives.
    await seedSandbox(app, { scenarios: [], env: PASSWORDS, printInvite: "t-chat-1" });
    const kinds = await (app.db as Database).execute<{ username: string; kind: string }>(sql`
      select u.username, l.kind from account_links l join users u on u.id = l.user_id
       where u.username in ('t-km', 't-new', 't-chat-1') and l.used_at is null and l.revoked_at is null order by u.username`);
    expect(kinds.rows).toEqual([
      { username: "t-chat-1", kind: "password_reset" },
      { username: "t-km", kind: "invite" },
      { username: "t-new", kind: "invite" },
    ]);
  });

  it("refuses a code that is not a test login, before making any link", async (context) => {
    if (!app) return context.skip();
    await expect(seedSandbox(app, { scenarios: [], env: PASSWORDS, printInvite: "live-chatter" })).rejects.toThrow(/not a login of the test team/);
    await expect(seedSandbox(app, { scenarios: [], env: PASSWORDS, printInvite: "nobody" })).rejects.toThrow(/not a login of the test team/);
  });
});

describe("stand-in pages (0435)", () => {
  const LIVE_FANSLY_ACCOUNT = "412345678901234567";
  const LIVE_ONLYFANS_ACCOUNT = "312345678";
  /** An invented OnlyMonster account: the owner's ChatSpace binding of the live OnlyFans page. */
  const HOST_ACCOUNT = "onlymonster:10001";
  const tokens = { anton: "", owner: "", tChat: "" };
  const before: { chatter: ClientBootstrapResponse | null; owner: ClientBootstrapResponse | null; proxies: unknown } = { chatter: null, owner: null, proxies: null };
  let seeded: Awaited<ReturnType<typeof seedSandbox>> | null = null;

  const userOf = async (username: string) => Number((await app!.db.execute<{ id: string }>(sql`select id from users where username = ${username}`)).rows[0]!.id);
  const tokenOf = async (username: string) => (await issueDeviceTokenForUserId(app!, { userId: await userOf(username), label: "extension" })).token;
  const get = (url: string, token: string) => server!.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}`, "x-client-version": "chat-extension/3.30.0" } });
  const bootstrap = async (token: string) => {
    const answer = await get("/api/v1/client/bootstrap", token);
    expect(answer.statusCode, answer.body).toBe(200);
    return { ...(answer.json() as ClientBootstrapResponse), issuedAt: "" };
  };
  const proxies = async (token: string) => {
    const answer = await get("/api/v1/client/fansly-proxies", token);
    expect(answer.statusCode, answer.body).toBe(200);
    return { ...(answer.json() as { proxies: Array<Record<string, unknown>> }), serverNow: "" };
  };

  beforeAll(async () => {
    if (!server || !app || !testDb) return;
    const db = app.db as Database;
    // The live pages' accounts on their sites, an OnlyFans page beside the Fansly one, the Fansly page's proxy, the
    // owner's ChatSpace binding of the OnlyFans one, and switches on, so an unbound page would read `binding_missing`.
    const [lana] = (await db.execute<{ id: string }>(sql`select id from models where slug = 'lana'`)).rows;
    const liveOf = await createOnlyFansPage(db, { modelId: Number(lana!.id), label: "live-of" });
    await db.execute(sql`update pages set external_page_id = ${LIVE_FANSLY_ACCOUNT} where label = 'live-1'`);
    await db.execute(sql`update pages set external_page_id = ${LIVE_ONLYFANS_ACCOUNT}, display_name = 'Lana OF' where id = ${liveOf.id}`);
    const [live1] = (await db.execute<{ id: string }>(sql`select id from pages where label = 'live-1'`)).rows;
    await saveProxy(app, Number(live1!.id), { url: "socks5://203.0.113.10:12324", username: "live-user", password: "live-pass" });
    await db.execute(sql`insert into user_page_assignments (user_id, platform_account_id) values (${await userOf("anton")}, ${liveOf.id})`);
    const patched = await call("PATCH", "/api/v1/admin/config", cookie.owner, { patches: [
      { key: "chatExtensionEnabled", value: true },
      { key: "chatExtensionFeatures", value: JSON.stringify({ "*": { fanPanel: true, ofFeed: true }, "live-1": { fanPanel: true }, "test-live-1": { fanPanel: true }, "test-live-of": { fanPanel: true } }) },
      { key: "chatExtensionHostBindings", value: JSON.stringify({ [HOST_ACCOUNT]: "live-of" }) },
    ] });
    expect(patched.statusCode, patched.body).toBe(200);
    tokens.anton = await tokenOf("anton");
    tokens.owner = (await issueDeviceTokenForUserId(app, { userId: ids.ownerId, label: "extension" })).token;
    before.chatter = await bootstrap(tokens.anton);
    before.owner = await bootstrap(tokens.owner);
    before.proxies = await proxies(tokens.anton);
    seeded = await seedSandbox(app, { scenarios: [], env: PASSWORDS, standIn: ["live-1", "live-of"] });
    tokens.tChat = await tokenOf("t-chat-1");
  }, 300_000);

  it("a test chatter's extension gets the live page's account on its stand-in; a live login's bootstrap is as it was", async (context) => {
    if (!server || !app || !testDb || seeded === null) return context.skip();
    expect(seeded.standIns.map((one) => [one.label, one.standsInFor.label])).toEqual([["test-live-1", "live-1"], ["test-live-of", "live-of"]]);
    expect(before.chatter!.pages.find((page) => page.pageLabel === "live-of")?.platformAccountId).toBe(LIVE_ONLYFANS_ACCOUNT);

    // A live login's bootstrap is exactly what it was: no stand-in in it, nothing of its pages changed.
    expect({ chatter: await bootstrap(tokens.anton), owner: await bootstrap(tokens.owner) }).toEqual({ chatter: before.chatter, owner: before.owner });
    expect(before.owner!.pages.map((page) => page.pageLabel).filter((label) => label.startsWith("test-"))).toEqual([]);

    // The test chatter's: each stand-in carries its live page's account and is bound; the owner's ChatSpace binding of
    // the live page points at the stand-in; the live pages themselves are not there.
    const test = await bootstrap(tokens.tChat);
    const page = (label: string) => test.pages.find((one) => one.pageLabel === label);
    expect(page("test-live-1")).toMatchObject({ platform: "fansly", platformAccountId: LIVE_FANSLY_ACCOUNT, features: { fanPanel: { available: true } } });
    expect(page("test-live-of")).toMatchObject({
      platform: "onlyfans", platformAccountId: LIVE_ONLYFANS_ACCOUNT, title: "Lana OF (тест)", features: { fanPanel: { available: true } },
    });
    expect(page("test-of")).toMatchObject({ platformAccountId: null, features: { fanPanel: { available: false, reason: "binding_missing" } } });
    // A stand-in reads its own row alone: what `"*"` switches on for every OnlyFans page (the feed) stays off on it.
    expect(page("test-live-of")?.features.ofFeed).toMatchObject({ available: false, reason: "flag_off" });
    expect(test.bindingsByHost).toEqual({ [HOST_ACCOUNT]: page("test-live-of")!.pageId });
    expect(test.pages.map((one) => one.pageLabel).filter((label) => !label.startsWith("test-"))).toEqual([]);
    // The stand-in's own account stays empty: nothing syncs it, and the OnlyFans feed's account check still refuses it.
    const own = await app.db.execute<{ external_page_id: string | null }>(sql`select external_page_id from pages where label in ('test-live-1', 'test-live-of')`);
    expect(own.rows.map((row) => row.external_page_id)).toEqual([null, null]);
  });

  it("a Fansly stand-in's tab leaves through its live page's proxy; the live chatter's proxies are as they were", async (context) => {
    if (!server || seeded === null) return context.skip();
    expect(await proxies(tokens.anton)).toEqual(before.proxies);
    const test = await proxies(tokens.tChat);
    expect(test.proxies.map((one) => [one.pageLabel, one.platformAccountId, one.host, one.port])).toEqual([
      ["test-live-1", LIVE_FANSLY_ACCOUNT, "203.0.113.10", 12324],
    ]);
  });

  it("a test login reads nothing of a real fan through its stand-in; the live chatter still gets the fan's marks", async (context) => {
    if (!server || !app || seeded === null) return context.skip();
    const db = app.db as Database;
    // A real fan of the live Fansly page: in its «Бомж» list, with money there.
    const REAL_FAN = "410000000000000077";
    const [live1] = (await db.execute<{ id: string }>(sql`select id from pages where label = 'live-1'`)).rows;
    const [fan] = (await db.execute<{ id: string }>(sql`insert into fans (platform, platform_user_id, username, first_seen_at)
      values ('fansly', ${REAL_FAN}, 'real_fan', now()) returning id`)).rows;
    await db.execute(sql`insert into page_fans (fan_id, platform_account_id) values (${fan!.id}, ${live1!.id})`);
    await db.execute(sql`insert into page_fan_lists (page_id, list_ref, label, list_type, item_count, observation_id, captured_at)
      values (${live1!.id}, '101', 'Бомж', 1, 1, 0, now())`);
    await db.execute(sql`insert into page_fan_list_members (page_id, list_ref, fan_id, first_seen_at, last_seen_at, last_seen_generation, is_active)
      values (${live1!.id}, '101', ${fan!.id}, now(), now(), 1, true)`);
    await db.execute(sql`insert into fan_spend_lifetime (platform_account_id, fan_id, gross_amount_mills, creator_net_amount_mills, last_transaction_at)
      values (${live1!.id}, ${fan!.id}, 50000, 40000, now())`);
    const marks = (token: string, label: string) => get(`/api/v1/client/pages/${label}/fans/${REAL_FAN}/marks?username=real_fan`, token);
    const otherPages = (token: string, label: string) => server!.inject({
      method: "POST", url: `/api/v1/client/pages/${label}/other-pages`, headers: { authorization: `Bearer ${token}`, "x-client-version": "chat-extension/3.30.0" },
      payload: { fanRefs: [REAL_FAN] },
    });

    const live = await marks(tokens.anton, "live-1");
    expect(live.statusCode, live.body).toBe(200);
    expect((live.json() as { lists: Array<{ pageLabel: string }> }).lists.map((list) => list.pageLabel)).toEqual(["live-1"]);

    const test = await marks(tokens.tChat, "test-live-1");
    expect(test.statusCode, test.body).toBe(200);
    expect(test.json()).toMatchObject({ pageLabel: "test-live-1", lists: [], blocklist: [] });
    expect(test.json()).not.toHaveProperty("otherPages");
    const testOther = await otherPages(tokens.tChat, "test-live-1");
    expect(testOther.statusCode, testOther.body).toBe(200);
    expect(testOther.json()).toEqual({ pageLabel: "test-live-1", fans: [] });
  });

  it("the database refuses a stand-in that is live, of a test page, of another platform, of itself, or a second one", async (context) => {
    if (!testDb || seeded === null) return context.skip();
    const id = async (label: string) => Number(((await testDb!.pool.query("select id from pages where label = $1", [label])).rows[0] as { id: string }).id);
    const [live1, liveOf, test1, testOf, standIn] = (await Promise.all(["live-1", "live-of", "test-1", "test-of", "test-live-1"].map(id))) as [number, number, number, number, number];
    const standsIn = (pageId: number, target: number) => testDb!.pool.query("update pages set stands_in_for_page_id = $2 where id = $1", [pageId, target]);
    await expect(standsIn(liveOf, live1)).rejects.toThrow(/is live/u);
    await expect(standsIn(test1, standIn)).rejects.toThrow(/cannot stand in for the test page/u);
    await expect(standsIn(testOf, live1)).rejects.toThrow(/another platform/u);
    await expect(standsIn(test1, test1)).rejects.toThrow(/itself/u);
    await expect(standsIn(test1, live1)).rejects.toThrow(/pages_stands_in_for_uniq/u);
    // A seed asked for a test page, or a page that is not there, writes nothing.
    await expect(seedSandbox(app!, { scenarios: [], env: PASSWORDS, standIn: ["test-1"] })).rejects.toThrow(/is a test page/u);
    await expect(seedSandbox(app!, { scenarios: [], env: PASSWORDS, standIn: ["nowhere"] })).rejects.toThrow(/No live page/u);
  });
});
