import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { assignUserToPage, createFanslyPage, createModel, insertAgentKey, recordAgentKeyUse } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { introspectAgentKey, issueOwnerAgentKey, replaceAgentKey, updateAgentKeyCapabilities } from "../apps/runtime/src/services/agent-keys.ts";
import { AGENT_KEY_TOKEN_PREFIX, authenticateAgentKey, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { setPersonPayTerm } from "../apps/runtime/src/services/people/index.ts";
import { runSaleClaims } from "../apps/runtime/src/services/sale-claims.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { waitForRowLockWait } from "./helpers/lock-waits.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { editingSession, handInAndConfirm, insertReviewerAgentKey } from "./helpers/shift-report-hand-in.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The owner's agent door (payouts plan 2026-11-24, §1.8, H9), on a real database and the real server: its key reaches
// its own route and no other; a call is the owner's reason, then the table, then the audit, then the arguments; a read
// writes nothing but its audit row; a decision is the owner's, names the key and the owner it acts for, and the bot
// door cannot change it even with the owner's Telegram id; a person is read without money and changed by a narrow
// list; the key is issued by the server alone and is nobody's for another service. Synthetic people, pages and sums.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const AUDIT = { source: "cli" } as const;
const OWNER_TG = 700_000_901;
const SENDER_B = 700_000_902;
const WRITER = `${AGENT_KEY_TOKEN_PREFIX}owner-door-writer`;
const SERVICE = `${AGENT_KEY_TOKEN_PREFIX}owner-door-introspect`;
const TEST_OWNER_KEY = `${AGENT_KEY_TOKEN_PREFIX}owner-door-test-owner`;
const WHY = "сверяю спорную продажу";

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let ownerKey = "";
let ownerKeyId = 0;
let boss = 0;
let anna = 0;
let bella = 0;
let pageOne = 0;
let shiftA = 0;
let shiftB = 0;
let shiftR = 0;

const call = (op: string, args: Record<string, unknown>, options: { why?: string | null; key?: string } = {}) => {
  const why = options.why === undefined ? WHY : options.why;
  return server!.inject({
    method: "POST",
    url: "/api/v1/owner-agent/call",
    headers: { authorization: `Bearer ${options.key ?? ownerKey}`, ...(why === null ? {} : { "x-hub-owner-reason": encodeURIComponent(why) }) },
    payload: { op, args },
  });
};
const rawSession = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asSession = editingSession(rawSession);
const asWriter = (url: string, payload: Record<string, unknown>) =>
  server!.inject({ method: "POST", url, headers: { authorization: `Bearer ${WRITER}` }, payload });

const count = async (sql: string, params: unknown[] = []) => Number((await testDb!.pool.query<{ n: string }>(sql, params)).rows[0]!.n);
const calls = () => count("select count(*) as n from audit_events where event_type = 'owner_agent.call'");

async function insertShift(userId: number, startedAt: string, endedAt: string): Promise<number> {
  const result = await testDb!.pool.query(
    `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
     values ($1, 'closed', $2::timestamptz, $3::timestamptz, 400, 300, $4::date, $5::jsonb) returning id`,
    [userId, startedAt, endedAt, startedAt.slice(0, 10), JSON.stringify([{ pageLabel: "mia-1", activeMinutes: 400, messages: 300, salesFrom: startedAt }])],
  );
  return Number(result.rows[0].id);
}

/** A sale of mia-1 an hour ago whose home by the rule is bella's shift (written by hand, as sale-claims tests do). */
async function bellasSale(ref: string, net: number): Promise<number> {
  const inserted = await testDb!.pool.query(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, 'subscription', 'subscription', 'posted', 'ok', $3, $3, $4, $5, now() - interval '1 hour', 'fansly:rest', 'USD')
     returning id`,
    [pageOne, ref, net + 4_000, net, 4_000],
  );
  const id = Number(inserted.rows[0].id);
  await testDb!.pool.query(
    `insert into sale_homes (transaction_id, page_id, occurred_at, net_mills, home, reason, shares, rule_version, computed_at)
     select t.id, t.platform_account_id, t.occurred_at, t.creator_net_amount_mills, 'shift', 'holder',
            jsonb_build_array(jsonb_build_object('userId', $2::bigint, 'workRef', null, 'shiftId', $3::bigint, 'percent', 100, 'mills', t.creator_net_amount_mills)),
            'test', now()
     from transactions t where t.id = $1`,
    [id, bella, shiftB],
  );
  return id;
}

/** Everything a read must leave as it was: the reports, their versions, candidates, proposals, claims, history, matters. */
async function snapshot() {
  const rows = async (table: string) => (await testDb!.pool.query(`select to_jsonb(t) as row from ${table} t order by 1`)).rows.map((one) => JSON.stringify(one.row)).sort();
  return {
    handins: await rows("shift_handins"),
    versions: await rows("shift_handin_versions"),
    candidates: await rows("shift_handin_candidates"),
    proposals: await rows("shift_handin_proposals"),
    claims: await rows("sale_claims"),
    decisions: await rows("sale_owner_decisions"),
    events: await rows("object_events"),
    matters: await rows("matters"),
  };
}

describe("the owner's agent door", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, AUDIT);
    await createUserAccount(app, { username: "tboss", role: "owner", password: "tboss-password-for-tests" }, AUDIT);
    for (const name of ["anna", "bella", "vera"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, AUDIT);
      await setUserPassword(app, { userId: await fixtureUserId(app, name), password: `${name}-password-for-tests` }, AUDIT);
    }
    boss = await fixtureUserId(app, "boss");
    anna = await fixtureUserId(app, "anna");
    bella = await fixtureUserId(app, "bella");
    // vera's login is a content manager's.
    await testDb.pool.query("update users set role = 'content_manager' where id = $1", [await fixtureUserId(app, "vera")]);
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageOne = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    await createFanslyPage(app.db, { modelId: model!.id, label: "mia-2" });
    for (const name of ["anna", "bella"]) await assignUserToPage(app.db, await fixtureUserId(app, name), pageOne);

    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "anna", "bella"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    const person = async (code: string, body: Record<string, unknown>) => {
      const created = await asSession("boss", "POST", "/api/v1/admin/people", { code, displayName: code, state: "working", ...body });
      expect(created.statusCode, created.body).toBe(200);
    };
    await person("boss", { role: "owner", telegram: { userId: OWNER_TG }, logins: { add: [boss] } });
    await person("anna", { role: "chatter", rights: ["submits_shift"], logins: { add: [anna] } });
    await person("bella", { role: "chatter", rights: ["submits_shift"], telegram: { userId: SENDER_B }, logins: { add: [bella] } });
    await person("vera", { role: "content_manager", logins: { add: [await fixtureUserId(app, "vera")] } });
    await testDb.pool.query("update person_rights set granted_at = '2026-11-01T00:00:00Z'");
    // The test team's owner: a login of the test realm (0414).
    const tPerson = (await testDb.pool.query<{ id: string }>(
      "insert into people (code, display_name, role, state, is_test) values ('t-boss', 'Тест', 'owner', 'working', true) returning id",
    )).rows[0]!.id;
    await testDb.pool.query("insert into person_logins (user_id, person_id) values ($1, $2)", [await fixtureUserId(app, "tboss"), tPerson]);
    await setPersonPayTerm(app, "anna", { modelSlug: "mia", validFrom: "2026-11-01", shareBasisPoints: 2_500, fixPerShiftMills: 7_000 }, AUDIT);

    // The claims pass only sees recent reports. The sale added by hand comes after this shift.
    const shiftStart = Date.now() - 2 * 86_400_000;
    shiftA = await insertShift(anna, new Date(shiftStart).toISOString(), new Date(shiftStart + 8 * 3_600_000).toISOString());
    shiftB = await insertShift(bella, "2026-11-10T07:00:00Z", "2026-11-10T15:00:00Z");
    shiftR = await insertShift(anna, "2026-11-11T15:00:00Z", "2026-11-11T23:00:00Z");

    const issued = await issueOwnerAgentKey(app, { name: "owner-desk-test", ownerLogin: "boss", expiresInDays: 30 }, { source: "cli", actorUserId: boss });
    ownerKey = issued.token;
    ownerKeyId = issued.key.id;
    for (const [token, name, capabilities, pages] of [
      [WRITER, "owner-door-writer", ["write:shift_reports"], [pageOne]],
      [SERVICE, "owner-door-introspect", ["introspect:agent_keys"], [pageOne]],
    ] as const) {
      await insertAgentKey(testDb.db, {
        name, keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(token),
        capabilities: [...capabilities], pageIds: [...pages], expiresAt: new Date(Date.now() + 30 * 86_400_000), createdBy: boss,
      });
    }
    // A key acting as the test team's owner, written past the issuer (which refuses it): the door refuses it too.
    await insertAgentKey(testDb.db, {
      name: "owner-door-test-owner", keyPrefix: TEST_OWNER_KEY.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(TEST_OWNER_KEY),
      capabilities: ["act:owner"], pageIds: [], expiresAt: new Date(Date.now() + 30 * 86_400_000), createdBy: boss,
      actsAsUserId: await fixtureUserId(app, "tboss"),
    });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("applies a split independently for each recipient through the owner's door", async (context) => {
    if (!testDb) return context.skip();
    const transactionId = await bellasSale("fixture-delivery-split", 1234);
    const decided = await call("sale.decide", { transactionId, kind: "split", shares: [
      { person: "anna", percent: 50 }, { person: "bella", percent: 50 },
    ], note: "split fixture" });
    expect(decided.statusCode, decided.body).toBe(200);
    const decisionId = decided.json().result.decision.id as number;
    const receipt = { decisionId, person: "anna", reportDate: "2026-11-24" };
    const bot = await asWriter("/api/v1/agent/sale-decisions/applied", receipt);
    expect([bot.statusCode, bot.json().reason]).toEqual([409, "owner_decision"]);
    await testDb.pool.query("alter table audit_events add constraint fixture_reject_receipt check (event_type <> 'sale.decision_applied') not valid");
    try {
      expect((await call("sale.applied", receipt)).statusCode).toBe(500);
    } finally {
      await testDb.pool.query("alter table audit_events drop constraint fixture_reject_receipt");
    }
    const first = await call("sale.applied", receipt);
    expect(first.statusCode, first.body).toBe(200);
    expect((await call("sale.applied", receipt)).statusCode).toBe(409);
    const audit = await testDb.pool.query(
      "select actor_user_id::int as owner, source, metadata from audit_events where event_type = 'sale.decision_applied' and metadata->>'decisionId' = $1",
      [String(decisionId)],
    );
    expect(audit.rows).toMatchObject([{ owner: boss, source: "owner_agent", metadata: {
      ...receipt, recipientUserId: anna, agentKeyId: ownerKeyId, onBehalfOfUserId: boss, reason: WHY,
    } }]);
    const state = await testDb.pool.query("select recipient_user_id::int as recipient, state from sale_decision_deliveries where decision_id = $1", [decisionId]);
    expect(state.rows).toEqual(expect.arrayContaining([{ recipient: anna, state: "applied" }, { recipient: bella, state: "pending" }]));
    const waiting = await rawSession("boss", "GET", "/api/v1/sale-nobody");
    expect(waiting.json().waitingDecisions.find((one: { decisionId: number }) => one.decisionId === decisionId).recipients)
      .toEqual([expect.objectContaining({ userId: bella })]);
    expect((await call("sale.applied", { ...receipt, person: "bella" })).statusCode).toBe(200);
    const closed = await testDb.pool.query("select applied_at from sale_owner_decisions where id = $1", [decisionId]);
    expect(closed.rows[0].applied_at).not.toBeNull();
  });

  it("is issued by the server alone, for a live owner, holding act:owner and nothing else", async (context) => {
    if (!testDb) return context.skip();
    const row = await testDb.pool.query("select capabilities, page_ids, acts_as_user_id from agent_keys where id = $1", [ownerKeyId]);
    expect(row.rows[0]).toMatchObject({ capabilities: ["act:owner"], page_ids: [] });
    expect(Number(row.rows[0].acts_as_user_id)).toBe(boss);
    await expect(issueOwnerAgentKey(app, { name: "t-desk", ownerLogin: "tboss", expiresInDays: 30 }, AUDIT)).rejects.toThrow(/test team/);
    await expect(issueOwnerAgentKey(app, { name: "a-desk", ownerLogin: "anna", expiresInDays: 30 }, AUDIT)).rejects.toThrow(/not an active owner/);
    // The table refuses an act:owner key with another capability, and any other key naming an owner.
    const refused = (capabilities: string[], actsAsUserId?: number) => insertAgentKey(testDb!.db, {
      name: `bad-${capabilities.join("-")}-${actsAsUserId ?? 0}`, keyPrefix: "agency_hub_agent_bad", keyDigest: sha256Hex(`bad-${capabilities.join()}-${actsAsUserId ?? 0}`),
      capabilities, pageIds: [], expiresAt: new Date(Date.now() + 86_400_000), createdBy: boss, ...(actsAsUserId === undefined ? {} : { actsAsUserId }),
    });
    await expect(refused(["act:owner", "read:team"], boss)).rejects.toThrow(/no other capability/);
    await expect(refused(["act:owner"])).rejects.toThrow(/names the owner/);
    await expect(refused(["read:team"], boss)).rejects.toThrow(/names the owner/);

    // The dashboard's paths refuse it: issued, granted, changed, replaced (409); another service never sees it active.
    const issuedHere = await server!.inject({
      method: "POST", url: "/api/v1/agent/keys", headers: { cookie: cookies.boss! },
      payload: { name: "owner-desk-2", capabilities: ["act:owner"], pageLabels: ["mia-1"] },
    });
    expect(issuedHere.statusCode, issuedHere.body).toBe(409);
    expect(issuedHere.json().reason).toBe("owner_agent_key");
    await expect(updateAgentKeyCapabilities(app, { id: ownerKeyId, capabilities: ["read:team"] }, AUDIT)).rejects.toMatchObject({ statusCode: 409 });
    await expect(replaceAgentKey(app, { id: ownerKeyId, name: "owner-desk-next", expiresInDays: 30 }, AUDIT)).rejects.toMatchObject({ statusCode: 409 });
    const replacedHere = await server!.inject({
      method: "POST", url: `/api/v1/agent/keys/${ownerKeyId}/replace`, headers: { cookie: cookies.boss! }, payload: { name: "owner-desk-next" },
    });
    expect(replacedHere.statusCode, replacedHere.body).toBe(409);
    expect((await introspectAgentKey(app, sha256Hex(ownerKey))).active).toBe(false);
    const introspected = await server!.inject({
      method: "POST", url: "/api/v1/agent/keys/introspect", headers: { authorization: `Bearer ${SERVICE}` }, payload: { keyDigest: sha256Hex(ownerKey) },
    });
    expect(introspected.statusCode, introspected.body).toBe(200);
    expect(introspected.json().active).toBe(false);
    // The owner's listing names it as it is.
    const listed = await server!.inject({ method: "GET", url: "/api/v1/agent/keys", headers: { cookie: cookies.boss! } });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().find((key: { id: number }) => key.id === ownerKeyId)).toMatchObject({ capabilities: ["act:owner"], agent: null });
  });

  it("keeps the issued deadline and records only authenticated uses of an owner key", async (context) => {
    if (!testDb) return context.skip();
    const name = "fixture-owner";
    await createUserAccount(app, { username: name, role: "owner", password: "fixture-owner-password" }, AUDIT);
    const owner = await fixtureUserId(app, name);
    const { token, key } = await issueOwnerAgentKey(app, { name: "fixture-week", ownerLogin: name, expiresInDays: 7 }, AUDIT);
    const state = async () => (await testDb!.pool.query("select last_used_at, expires_at from agent_keys where id = $1", [key.id])).rows[0];
    const before = await state();
    expect(before.last_used_at).toBeNull();
    for (const [role, disabled] of [["owner", true], ["chatter", false]] as const) {
      await testDb.pool.query("update users set role = $2, disabled_at = case when $3 then now() end where id = $1", [owner, role, disabled]);
      expect(await authenticateAgentKey(app, token)).toBeNull();
      expect(await state()).toEqual(before);
    }
    await testDb.pool.query("update users set role = 'owner' where id = $1", [owner]);
    expect(await authenticateAgentKey(app, token)).toMatchObject({ kind: "owner_agent", agentKeyId: key.id });
    const used = await state();
    expect(used.last_used_at).toBeInstanceOf(Date);
    expect(used.expires_at).toEqual(before.expires_at);
    expect(await recordAgentKeyUse(app.db, { id: key.id, now: before.expires_at })).toBeNull();
    expect(await state()).toEqual(used);

    const request = { method: "POST" as const, url: "/api/v1/owner-agent/call", payload: { op: "people.show", args: { code: "boss" } } };
    const remaining = [];
    for (const authorization of [`Bearer ${token}`, `  bEaReR   ${token}  `]) {
      const response = await server!.inject({ ...request, headers: { authorization, "x-hub-owner-reason": "fixture" } });
      expect(response.statusCode, response.body).toBe(200);
      remaining.push(Number(response.headers["x-ratelimit-remaining"]));
    }
    expect(remaining[0]).toBeGreaterThan(0);
    expect(remaining[1]).toBe(remaining[0]! - 1);
    const last = await state();
    await testDb.pool.query("update users set disabled_at = now(), deleted_at = now(), password_hash = null where id = $1", [owner]);
    expect(await authenticateAgentKey(app, token)).toBeNull();
    expect(await state()).toEqual(last);
  });

  it("reaches its own route alone: every other route of the server refuses it", async (context) => {
    if (!testDb) return context.skip();
    const admitted: string[] = [];
    for (const row of server!.routePolicyTable) {
      if (row.auth === null || row.auth.kind === "public" || row.auth.kind === "hmac" || row.routeKey === "ownerAgentCall") continue;
      const url = row.url.replace(/:([A-Za-z]+)/g, (_, name: string) => (name === "pageLabel" ? "mia-1" : "1"));
      const answer = await server!.inject({
        method: row.method as "GET", url, headers: { authorization: `Bearer ${ownerKey}` },
        ...(row.method === "GET" || row.method === "DELETE" ? {} : { payload: {} }),
      });
      if (answer.statusCode !== 403) admitted.push(`${row.method} ${row.url} ${answer.statusCode}`);
    }
    expect(admitted).toEqual([]);
    // …and its own route refuses a person, an agent key, nobody, and a key acting as the test team's owner.
    const own = { method: "POST" as const, url: "/api/v1/owner-agent/call", payload: { op: "people.show", args: { code: "anna" } } };
    const reason = { "x-hub-owner-reason": "x" };
    expect((await server!.inject({ ...own, headers: { cookie: cookies.boss!, ...reason } })).statusCode).toBe(403);
    expect((await server!.inject({ ...own, headers: { authorization: `Bearer ${WRITER}`, ...reason } })).statusCode).toBe(403);
    expect((await server!.inject({ ...own, headers: reason })).statusCode).toBe(401);
    expect((await call("people.show", { code: "anna" }, { key: TEST_OWNER_KEY })).statusCode).toBe(401);
    // Swagger is the owner's session's, never this key's.
    expect((await server!.inject({ method: "GET", url: "/documentation/json", headers: { authorization: `Bearer ${ownerKey}` } })).statusCode).toBe(403);
  });

  it("takes the reason first, then the table, then writes the audit, then reads the arguments", async (context) => {
    if (!testDb) return context.skip();
    const before = await calls();
    for (const why of [null, "", "   ", "я".repeat(501), "fixture\u0000reason", "fixture\u200breason"]) {
      const refused = await call("people.show", { code: "anna" }, { why });
      expect(refused.statusCode, `${String(why).slice(0, 10)}: ${refused.body}`).toBe(400);
      expect(refused.json().reason).toBe("owner_reason");
    }
    for (const op of ["people.delete", "agentKeyCreate", "adminPersonPayTermSet", "__proto__", "toString"]) {
      expect((await call(op, {})).statusCode, op).toBe(403);
    }
    expect(await calls()).toBe(before);

    // Arguments the operation does not name: the audit row is written (the call happened), nothing else runs.
    const extra = await call("people.edit", { code: "anna", displayName: "Анна", anything: 1 });
    expect(extra.statusCode, extra.body).toBe(400);
    expect(await calls()).toBe(before + 1);
    // What the door never takes (a right), anywhere in the arguments: 403 before the schema, the audit row alone (H10).
    const never = await call("people.edit", { code: "anna", displayName: "Анна", rights: ["submits_shift"] });
    expect(never.statusCode, never.body).toBe(403);
    expect(await calls()).toBe(before + 2);
    const person = await testDb.pool.query("select display_name from people where code = 'anna'");
    expect(person.rows[0].display_name).toBe("anna");

    const shown = await call("people.show", { code: "anna" });
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.headers["cache-control"]).toBe("no-store");
    const audit = await testDb.pool.query(
      "select actor_user_id, source, metadata from audit_events where event_type = 'owner_agent.call' order by id desc limit 1",
    );
    expect(Number(audit.rows[0].actor_user_id)).toBe(boss);
    expect(audit.rows[0]).toMatchObject({ source: "owner_agent", metadata: { op: "people.show", keyName: "owner-desk-test", reason: WHY, actorAgentKeyId: ownerKeyId } });
  });

  it("reads a person without money, and changes only the fields of its list", async (context) => {
    if (!testDb) return context.skip();
    const shown = await call("people.show", { code: "anna" });
    expect(shown.statusCode, shown.body).toBe(200);
    const person = shown.json().result.person as Record<string, unknown>;
    expect(person).toMatchObject({ code: "anna", role: "chatter" });
    for (const field of ["payTerms", "payoutDetails", "agentKeys", "proposals"]) expect(person, field).not.toHaveProperty(field);
    expect(shown.body).not.toMatch(/shareBasisPoints|fixPerShiftMills|payoutDetails|payTerms/);
    expect((await call("people.show", { code: "t-boss" })).statusCode).toBe(404);

    const edited = await call("people.edit", { code: "anna", displayName: "Анна К.", note: "ведёт mia-1" });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().result.person).toMatchObject({ displayName: "Анна К.", note: "ведёт mia-1" });
    const audit = await testDb.pool.query("select actor_user_id, metadata from audit_events where event_type = 'person.updated' order by id desc limit 1");
    expect(Number(audit.rows[0].actor_user_id)).toBe(boss);
    expect(audit.rows[0].metadata).toMatchObject({ code: "anna", actorAgentKeyId: ownerKeyId });

    // Never the door's (H10: 403 at any depth, before the schema); a field it does not name is the schema's 400.
    for (const args of [{ rights: ["submits_shift"] }, { payTerms: [] }, { role: "team_lead" }, { logins: { add: [boss] } }, { telegram: { userId: 5 } }]) {
      expect((await call("people.edit", { code: "anna", ...args })).statusCode, JSON.stringify(args)).toBe(403);
    }
    expect((await call("people.edit", { code: "anna", kind: "agent" })).statusCode).toBe(400);
    // A content manager's working pages open ContentOps: the owner's own word, never the door's.
    const pages = await call("people.edit", { code: "vera", workingPageLabels: ["mia-1"] });
    expect(pages.statusCode, pages.body).toBe(409);
    expect(pages.json().reason).toBe("content_manager_pages");
    expect((await testDb.pool.query("select count(*)::int as n from person_working_pages w join people p on p.id = w.person_id where p.code = 'vera'")).rows[0].n).toBe(0);
    expect((await call("people.edit", { code: "vera", displayName: "Вера" })).statusCode).toBe(200);
    const pagesOfAnna = await call("people.edit", { code: "anna", workingPageLabels: ["mia-1"] });
    expect(pagesOfAnna.statusCode, pagesOfAnna.body).toBe(200);
  });

  it("protects access by registry and login role, including a change committed while the edit waits", async (context) => {
    if (!testDb) return context.skip();
    const issued = await issueOwnerAgentKey(app, { name: "fixture-people", ownerLogin: "boss", expiresInDays: 7 }, AUDIT);
    const edit = (code: string, fields: Record<string, unknown>) => call("people.edit", { code, ...fields }, { key: issued.token });
    await testDb.pool.query(`insert into people (code, display_name, role, state, left_on) values
      ('fixture-manager', 'Fixture manager', 'content_manager', 'left', current_date),
      ('fixture-owner', 'Fixture owner', 'owner', 'working', null),
      ('fixture-race', 'Fixture race', 'chatter', 'working', null)`);
    // These two records exercise a protected login on a registry record of a different role.
    await testDb.pool.query("update people set role = 'chatter' where code in ('boss', 'vera')");
    try {
      for (const code of ["fixture-owner", "boss"]) {
        expect((await edit(code, { note: "fixture" })).statusCode).toBe(409);
      }
      for (const code of ["fixture-manager", "vera"]) {
        for (const patch of [{ leftOn: null }, { state: "working" }, { workingPageLabels: [] }]) {
          expect((await edit(code, patch)).statusCode).toBe(409);
        }
        expect((await edit(code, { note: "fixture" })).statusCode).toBe(200);
      }
    } finally {
      await testDb.pool.query("update people set role = 'owner' where code = 'boss'");
      await testDb.pool.query("update people set role = 'content_manager' where code = 'vera'");
    }
    const writer = await testDb.pool.connect();
    try {
      await writer.query("begin");
      await writer.query("update people set role = 'content_manager' where code = 'fixture-race'");
      const waiting = edit("fixture-race", { state: "left" }).then((response) => response);
      await waitForRowLockWait(testDb.pool, ["%from people p%for update%"], { blocked: waiting });
      await writer.query("commit");
      expect((await waiting).statusCode).toBe(409);
    } finally {
      await writer.query("rollback");
      writer.release();
    }
    expect((await testDb.pool.query("select state from people where code = 'fixture-race'")).rows[0].state).toBe("working");
  });

  it("reads stored shift reports and writes nothing but its audit rows", async (context) => {
    if (!testDb) return context.skip();
    // anna's report counted once, then handed in again with Gengar expected: it waits in «Проверка» — what a board
    // read checks and moves on.
    await handInAndConfirm(asSession, "anna", shiftR);
    const reviewer = await insertReviewerAgentKey(testDb.db, { name: "owner-door-reviewer", token: `${AGENT_KEY_TOKEN_PREFIX}owner-door-reviewer`, pageIds: [pageOne], createdBy: boss });
    expect((await asSession("anna", "POST", `/api/v1/shift-reports/${shiftR}/reopen`)).statusCode).toBe(200);
    const handed = await asSession("anna", "POST", `/api/v1/shift-reports/${shiftR}/submit`);
    expect(handed.statusCode, handed.body).toBe(200);
    // Gengar's ten minutes are up: a board read now moves the report to «Подтвердите». The door's reads must not.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 11 * 60_000));

    const before = await snapshot();
    const audits = await calls();
    const observations = await count("select count(*) as n from observations");

    const listed = await call("shiftReport.list", { person: "anna", from: "2026-11-11", to: "2026-11-11" });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().result).toMatchObject({ person: { code: "anna" }, shifts: [{ shiftId: shiftR, state: "submitted", version: 1, phase: "checking" }] });
    const shown = await call("shiftReport.show", { shiftId: shiftR });
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json().result).toMatchObject({ state: "submitted", phase: "checking", view: { source: "version", version: 1 }, latest: { version: 1 } });
    expect((await call("shiftReport.show", { shiftId: shiftR, version: 1 })).statusCode).toBe(200);
    expect((await call("shiftReport.show", { shiftId: shiftR, version: 9 })).statusCode).toBe(404);
    const versions = await call("shiftReport.versions", { shiftId: shiftR });
    expect(versions.statusCode, versions.body).toBe(200);
    expect(versions.json().result.versions).toHaveLength(1);

    expect(await snapshot()).toEqual(before);
    expect(await calls()).toBe(audits + 5);
    expect(await count("select count(*) as n from observations")).toBe(observations + 5);
    // The same report read on the board does what is due: the phase moves.
    await asSession("anna", "GET", `/api/v1/shift-reports/${shiftR}`);
    expect((await testDb.pool.query("select phase from shift_handins where shift_id = $1", [shiftR])).rows[0].phase).toBe("confirm");
    vi.useRealTimers();
    // Gengar goes: the hand-ins below do not wait for a check.
    await testDb.pool.query("update agent_keys set revoked_at = now() where id = $1", [reviewer.agentKeyId]);
  });

  it("decides a sale as the owner, naming the key; the bot door cannot change that word, even with the owner's Telegram id", async (context) => {
    if (!testDb) return context.skip();
    // anna takes bella's sale in her handed-in report: her report holds it.
    const sale = await bellasSale("tx-owner-door-1", 12_000);
    const said = await asSession("anna", "PUT", `/api/v1/shift-reports/${shiftA}/lines/${sale}`, { statement: "mine", note: "чат вела я" });
    expect(said.statusCode, said.body).toBe(200);
    await handInAndConfirm(asSession, "anna", shiftA);
    await runSaleClaims(app);
    const held = await testDb.pool.query(
      `select line from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version
         cross join lateral jsonb_array_elements(v.lines) line where h.shift_id = $1 and (line ->> 'transactionId')::bigint = $2`,
      [shiftA, sale],
    );
    expect(held.rows[0].line).toMatchObject({ amountMills: 12_000 });

    const shown = await call("sale.show", { transactionId: sale });
    expect(shown.statusCode, shown.body).toBe(200);
    // (The take moved the sale's home by the rule, which this file's world cannot compute: no shares to show.)
    expect(shown.json().result).toMatchObject({ sale: { transactionId: sale, netMills: 12_000 }, decisions: [], openDispute: false });
    expect(shown.json().result.claims).toEqual([expect.objectContaining({ kind: "claim", state: "agreed", claimant: "anna", side: "bella", statement: "mine" })]);

    const decided = await call("sale.decide", { transactionId: sale, kind: "owner", shares: [{ person: "bella", percent: 100 }], note: "чат вела bella" });
    expect(decided.statusCode, decided.body).toBe(200);
    const decision = decided.json().result.decision as { id: number; source: string };
    expect(decision.source).toBe("agent");
    expect(decided.json().result.versions).toEqual([expect.objectContaining({ shiftId: shiftA })]);

    const row = await testDb.pool.query("select source, decided_by_user_id, agent_key_id, said_by_telegram_id from sale_owner_decisions where id = $1", [decision.id]);
    expect(row.rows[0]).toMatchObject({ source: "agent", said_by_telegram_id: null });
    expect([Number(row.rows[0].decided_by_user_id), Number(row.rows[0].agent_key_id)]).toEqual([boss, ownerKeyId]);
    // The report's new version is the owner's own Workboard one; its history names the key and the owner it acts for.
    const version = await testDb.pool.query(
      `select v.door, v.actor_user_id, v.agent_key_id from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version
        where h.shift_id = $1`, [shiftA],
    );
    expect(version.rows[0]).toMatchObject({ door: "workboard", agent_key_id: null });
    expect(Number(version.rows[0].actor_user_id)).toBe(boss);
    const event = await testDb.pool.query(
      "select actor_user_id, actor_agent_key_id, on_behalf_of_user_id, door from object_events where event = 'shift_report.settled' order by id desc limit 1",
    );
    expect(event.rows[0]).toMatchObject({ actor_user_id: null, door: "api" });
    expect([Number(event.rows[0].actor_agent_key_id), Number(event.rows[0].on_behalf_of_user_id)]).toEqual([ownerKeyId, boss]);

    // The bot door: neither a stranger's message nor the owner's own Telegram id changes a decision the owner made.
    for (const sender of [SENDER_B, OWNER_TG]) {
      const cancel = await asWriter("/api/v1/agent/sale-decisions/cancel", { decisionId: decision.id, note: "передумали", telegramUserId: sender, sourceRef: "https://t.me/c/1/90" });
      expect(cancel.statusCode, cancel.body).toBe(409);
      expect(cancel.json().reason).toBe("owner_decision");
      const replace = await asWriter("/api/v1/agent/sale-decisions", {
        transactionId: sale, kind: "owner", shares: [{ person: "anna", percent: 100 }], saidBy: "владелец", saidAt: "2026-11-24",
        supersedes: decision.id, telegramUserId: sender, sourceRef: "https://t.me/c/1/91",
      });
      expect(replace.statusCode, replace.body).toBe(409);
      expect(replace.json().reason).toBe("owner_decision");
    }

    // The door: a sale with an active decision names it; then it replaces it.
    const again = await call("sale.decide", { transactionId: sale, kind: "exclude", note: "никому" });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().reason).toBe("decision_exists");
    const replaced = await call("sale.decide", { transactionId: sale, kind: "exclude", note: "никому", supersedes: decision.id });
    expect(replaced.statusCode, replaced.body).toBe(200);
    const cancelled = await call("sale.cancel", { decisionId: replaced.json().result.decision.id, note: "по правилу" });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().result.decision.status).toBe("cancelled");
  });

  it("keeps the owner's word said in Telegram to the bot door's rule, and leaves an open dispute to Workboard", async (context) => {
    if (!testDb) return context.skip();
    // A decision recorded from the owner's own message (no signed-in decider): his message through the bot door changes it.
    const said = await bellasSale("tx-owner-door-2", 8_000);
    const recorded = await asWriter("/api/v1/agent/sale-decisions", {
      transactionId: said, kind: "owner", shares: [{ person: "bella", percent: 100 }], saidBy: "владелец", saidAt: "2026-11-24",
      telegramUserId: OWNER_TG, sourceRef: "https://t.me/c/1/92",
    });
    expect(recorded.statusCode, recorded.body).toBe(200);
    const byStranger = await asWriter("/api/v1/agent/sale-decisions/cancel", { decisionId: recorded.json().decision.id, note: "x", telegramUserId: SENDER_B, sourceRef: "https://t.me/c/1/93" });
    expect(byStranger.statusCode).toBe(409);
    const byOwner = await asWriter("/api/v1/agent/sale-decisions/cancel", { decisionId: recorded.json().decision.id, note: "передумал", telegramUserId: OWNER_TG, sourceRef: "https://t.me/c/1/94" });
    expect(byOwner.statusCode, byOwner.body).toBe(200);

    // An open question of the sale: the door does not decide over it; it closes it once.
    const disputed = await bellasSale("tx-owner-door-3", 5_000);
    const asked = await asWriter("/api/v1/agent/sale-questions", {
      transactionId: disputed, askedOf: "owner", people: ["anna", "bella"], question: "Чья продажа?", askedAt: "2026-11-24",
      telegramUserId: SENDER_B, sourceRef: "https://t.me/c/1/95",
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const questionId = asked.json().question.id as number;
    const refused = await call("sale.decide", { transactionId: disputed, kind: "owner", shares: [{ person: "anna", percent: 100 }], note: "моё слово" });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().reason).toBe("open_dispute");
    expect(await count("select count(*) as n from sale_owner_decisions where transaction_id = $1", [disputed])).toBe(0);
    expect((await call("sale.show", { transactionId: disputed })).json().result.openDispute).toBe(true);
    await testDb.pool.query("alter table audit_events add constraint fixture_close_audit check (event_type <> 'sale.question_closed') not valid");
    try {
      expect((await call("sale.close", { questionId, note: "fixture" })).statusCode).toBe(500);
      expect((await testDb.pool.query("select closed_at from sale_claims where id = $1", [questionId])).rows[0].closed_at).toBeNull();
    } finally {
      await testDb.pool.query("alter table audit_events drop constraint fixture_close_audit");
    }
    const closed = await call("sale.close", { questionId, note: "разобрались сами" });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().result.question.status).toBe("closed");
    const closeAudit = await testDb.pool.query("select metadata from audit_events where event_type = 'sale.question_closed'");
    expect(closeAudit.rows).toEqual([{ metadata: expect.objectContaining({ questionId, agentKeyId: ownerKeyId, onBehalfOfUserId: boss, reason: WHY }) }]);
    const twice = await call("sale.close", { questionId, note: "ещё раз" });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().reason).toBe("question_closed");
    // A person the shares name must be a live person of the registry.
    const stranger = await call("sale.decide", { transactionId: disputed, kind: "owner", shares: [{ person: "t-boss", percent: 100 }], note: "x" });
    expect(stranger.statusCode, stranger.body).toBe(400);
  });

  it("manages live Workboard pots (list, create, show, update, preview, post, reverse, close) with pure reads, live isolation, and audit", async (context) => {
    if (!testDb) return context.skip();
    // Turn pots switch on and insert a pot sale on mia-1 + a test-realm pot that must stay invisible (404).
    await testDb.pool.query(
      "insert into pots_switch (id, pots_from, set_by, set_at) values (true, '2026-11-18', 'test', now()) on conflict (id) do update set pots_from = '2026-11-18'",
    );
    const tModel = Number((await testDb.pool.query("insert into models (slug, name, is_test) values ('sandbox-door-m', 'Sandbox Door', true) returning id")).rows[0].id);
    const tPage = (await createFanslyPage(app.db, { modelId: tModel, label: "test-door-1" }))!.id;
    await testDb.pool.query(
      `insert into pots (code, name, model_id, page_ids, intake_reasons, opens_on, participants_mode, participants, formula, auto_post, state)
       values ('test-door-pot', 'Test Door Pot', $1, array[$2]::bigint[], array[]::text[], '2026-11-18',
         'listed', '[]'::jsonb, '{"kind":"equal","params":{}}'::jsonb, false, 'open')`,
      [tModel, tPage],
    );

    const potSale = Number((await testDb.pool.query(
      `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
         gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
       values ($1, 'tx-owner-door-pot-1', 'tip', 'tip', 'posted', 'ok', 60000, 60000, 60000, 0, '2026-11-20T12:00:00+03:00', 'fansly:rest', 'USD')
       returning id`,
      [pageOne],
    )).rows[0].id);
    await testDb.pool.query(
      `insert into sale_homes (transaction_id, page_id, occurred_at, net_mills, home, reason, pot, shares, rule_version, computed_at)
       values ($1, $2, '2026-11-20T12:00:00+03:00', 60000, 'pot', 'decision', 'door-event', '[]'::jsonb, 'test', now())`,
      [potSale, pageOne],
    );

    // 1. pot.create (live model + page label) + audit provenance
    const created = await call("pot.create", {
      code: "door-event",
      name: "Door Event",
      modelSlug: "mia",
      pageLabels: ["mia-1"],
      intakeReasons: [],
      opensOn: "2026-11-18",
      closesOn: null,
      participantsMode: "listed",
      participants: [
        { personCode: "anna", fromDay: "2026-11-18", toDay: null },
        { personCode: "bella", fromDay: "2026-11-18", toDay: null },
      ],
      formula: { kind: "equal", params: {} },
      autoPost: false,
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().result.pot).toMatchObject({ code: "door-event", balanceMills: 60_000, state: "open" });

    const createAudit = await testDb.pool.query(
      "select actor_user_id, source, metadata from audit_events where event_type = 'pot.created' order by id desc limit 1",
    );
    expect(Number(createAudit.rows[0].actor_user_id)).toBe(boss);
    expect(createAudit.rows[0]).toMatchObject({ source: "owner_agent", metadata: { code: "door-event", actorAgentKeyId: ownerKeyId } });

    // 2. pot.update
    const updated = await call("pot.update", { code: "door-event", name: "Door Event Updated" });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().result.pot.name).toBe("Door Event Updated");

    // 3. Pure reads (pot.list, pot.show, pot.preview) write NOTHING to pot_distributions or matters, and never see test pots!
    const distCountBefore = await count("select count(*) as n from pot_distributions");
    const mattersBefore = await count("select count(*) as n from matters");
    const listed = await call("pot.list", {});
    expect(listed.statusCode, listed.body).toBe(200);
    const listCodes = (listed.json().result.pots as Array<{ code: string }>).map((p) => p.code);
    expect(listCodes).toContain("door-event");
    expect(listCodes).not.toContain("test-door-pot");
    expect(listed.json().result).not.toHaveProperty("legacyArchive");

    const shown = await call("pot.show", { code: "door-event" });
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json().result.pot.balanceMills).toBe(60_000);
    expect((await call("pot.show", { code: "test-door-pot" })).statusCode).toBe(404);

    const previewed = await call("pot.preview", { code: "door-event", day: "2026-11-20" });
    expect(previewed.statusCode, previewed.body).toBe(200);
    expect(previewed.json().result).toMatchObject({
      baseMills: 60_000,
      error: null,
      lines: [
        { personCode: "anna", baseMills: 30_000 },
        { personCode: "bella", baseMills: 30_000 },
      ],
    });
    expect(await count("select count(*) as n from pot_distributions")).toBe(distCountBefore);
    expect(await count("select count(*) as n from matters")).toBe(mattersBefore);

    // 4. pot.post -> writes distribution + audit provenance
    await testDb.pool.query("alter table audit_events add constraint fixture_post_audit check (event_type <> 'pot.distribution_posted') not valid");
    try {
      const failed = await call("pot.post", { code: "door-event", day: "2026-11-20" });
      expect(failed.statusCode).toBe(500);
      expect(await count("select count(*) as n from pot_distributions")).toBe(distCountBefore);
    } finally {
      await testDb.pool.query("alter table audit_events drop constraint fixture_post_audit");
    }
    const postingKey = await issueOwnerAgentKey(app, { name: "fixture-post", ownerLogin: "boss", expiresInDays: 7 }, AUDIT);
    const posted = await call("pot.post", { code: "door-event", day: "2026-11-20" }, { key: postingKey.token });
    expect(posted.statusCode, posted.body).toBe(200);
    const distId = posted.json().result.distribution.id as number;
    expect(posted.json().result.distribution.baseMills).toBe(60_000);

    const attribution = await testDb.pool.query("select agent_key_id::int as key, posted_by_user_id::int as owner from pot_distributions where id = $1", [distId]);
    expect(attribution.rows).toEqual([{ key: postingKey.key.id, owner: boss }]);

    // 5. pot.reverse -> reverses distribution + audit provenance
    const reversed = await call("pot.reverse", { distributionId: distId, reason: "перерасчёт владельца" });
    expect(reversed.statusCode, reversed.body).toBe(200);
    expect(reversed.json().result.distribution.reversedReason).toBe("перерасчёт владельца");

    // 6. pot.close -> closes live pot; test pot returns 404
    expect((await call("pot.close", { code: "test-door-pot" })).statusCode).toBe(404);
    const closedPot = await call("pot.close", { code: "door-event" });
    expect(closedPot.statusCode, closedPot.body).toBe(200);
    expect(closedPot.json().result.pot.state).toBe("closed");

    // Verify all pot write audit events recorded owner + key provenance
    const potAuditTypes = (await testDb.pool.query(
      "select event_type, source, actor_user_id, metadata from audit_events where event_type like 'pot.%' order by id asc",
    )).rows;
    expect(potAuditTypes.map((r) => r.event_type)).toEqual([
      "pot.created", "pot.updated", "pot.distribution_posted", "pot.distribution_reversed", "pot.closed",
    ]);
    for (const row of potAuditTypes) {
      expect(row.source).toBe("owner_agent");
      expect(Number(row.actor_user_id)).toBe(boss);
      const keyId = row.event_type === "pot.distribution_posted" ? postingKey.key.id : ownerKeyId;
      expect(row.metadata).toMatchObject({ agentKeyId: keyId, actorAgentKeyId: keyId, onBehalfOfUserId: boss, reason: WHY });
    }
    await testDb.pool.query("delete from agent_keys where id = $1", [postingKey.key.id]);
    const detached = await testDb.pool.query("select agent_key_id, reversed_at from pot_distributions where id = $1", [distId]);
    expect(detached.rows).toEqual([{ agent_key_id: null, reversed_at: expect.any(Date) }]);
  });

  it("attributes a sale added to a previously submitted report to the owner key", async (context) => {
    if (!testDb) return context.skip();
    const shift = await insertShift(anna, "2026-11-15T07:00:00Z", "2026-11-15T15:00:00Z");
    const report = await handInAndConfirm(asSession, "anna", shift);
    const transactionId = await bellasSale("fixture-added-line", 400);
    await testDb.pool.query("update transactions set occurred_at = $1 where id = $2", [`${report.shift.reportDate}T12:00:00Z`, transactionId]);
    const { token, key } = await issueOwnerAgentKey(app, { name: "fixture-delivery", ownerLogin: "boss", expiresInDays: 7 }, AUDIT);
    const result = await call("sale.decide", { transactionId, kind: "owner", shares: [{ person: "anna", percent: 100 }], note: "fixture" }, { key: token });
    expect(result.statusCode, result.body).toBe(200);
    const event = await testDb.pool.query(`select e.door, e.actor_agent_key_id::int as key, e.on_behalf_of_user_id::int as owner, e.changes->>'reason' as reason
      from object_events e join shift_handins h on e.object_id = h.id::text where h.shift_id = $1 and e.event = 'shift_report.settled'
      and e.changes->>'transactionId' = $2`, [shift, String(transactionId)]);
    expect(event.rows).toEqual([{ door: "api", key: key.id, owner: boss, reason: WHY }]);
  });
});
