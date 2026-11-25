import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { assignUserToPage, createFanslyPage, createModel, insertAgentKey, insertSaleDecision, openMatter } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { issueOwnerAgentKey } from "../apps/runtime/src/services/agent-keys.ts";
import { publishAgentReport } from "../apps/runtime/src/services/agent-reports.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, principalOfLogin, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { recordCustomOrder } from "../apps/runtime/src/services/custom-orders/index.ts";
import { linkUnlinkedDecision, readUnlinkedDecisions } from "../apps/runtime/src/services/sale-claims.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { editingSession } from "./helpers/shift-report-hand-in.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The owner's agent door, part 2 (payouts plan 2026-11-24, §1.8, H10), on a real database and the real server: what
// the door never takes — at any depth of the arguments, a payment step of a custom included — is 403 with nothing but
// the call's audit row and no money moved; customs are read and stepped as the owner on the board, never a payment or
// a price, and a finding that names a sale is never recorded or linked here (409); a matter closes through its kind's
// own writer and is commented in its history; «Обучение» is approved; a swap is approved and taken back; a decision
// carried over from the ledger is tied to its sale. Every write names the key and the owner it acts for. Synthetic
// people, pages and sums.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const AUDIT = { source: "cli" } as const;
const WRITER = `${AGENT_KEY_TOKEN_PREFIX}owner-door-2-writer`;
const WHY = "разбираю дела недели";
const DAY_MS = 86_400_000;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let ownerKey = "";
let ownerKeyId = 0;
let writerKeyId = 0;
let boss = 0;
let anna = 0;
let bella = 0;
let tboss = 0;
let pageOne = 0;
let testPage = 0;
let shiftB = 0;

const call = (op: string, args: Record<string, unknown>) => server!.inject({
  method: "POST",
  url: "/api/v1/owner-agent/call",
  headers: { authorization: `Bearer ${ownerKey}`, "x-hub-owner-reason": encodeURIComponent(WHY) },
  payload: { op, args },
});
const rawSession = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asSession = editingSession(rawSession);

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const count = async (text: string, values: unknown[] = []) => Number((await q(text, values)).rows[0]!.n);
const calls = () => count("select count(*) as n from audit_events where event_type = 'owner_agent.call'");
/** The history row a write of the door left last on an object: the key, the owner on whose behalf, door api, no person. */
const lastEvent = async (objectType: string, objectId: number | string) => (await q(
  `select event, door, actor_user_id, actor_agent_key_id, on_behalf_of_user_id from object_events
    where object_type = $1 and object_id = $2 order by id desc limit 1`, [objectType, String(objectId)],
)).rows[0];
const expectDoorEvent = (row: Record<string, unknown> | undefined, event: string) => {
  expect(row).toMatchObject({ event, door: "api", actor_user_id: null });
  expect([Number(row!.actor_agent_key_id), Number(row!.on_behalf_of_user_id)]).toEqual([ownerKeyId, boss]);
};

/** Everything money a refusal must leave as it was: the customs' payments, prices and words, decisions, pay terms. */
async function money() {
  const rows = async (table: string) => (await q(`select to_jsonb(t) as row from ${table} t`)).rows.map((one) => JSON.stringify(one.row)).sort();
  return {
    payments: await rows("custom_order_payments"),
    orders: await rows("custom_orders"),
    decisions: await rows("sale_owner_decisions"),
    terms: await rows("person_pay_terms"),
    people: await rows("people"),
    events: await count("select count(*) as n from object_events"),
  };
}

async function insertShift(userId: number, startedAt: string, endedAt: string): Promise<number> {
  const result = await q(
    `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
     values ($1, 'closed', $2::timestamptz, $3::timestamptz, 400, 300, $4::date, $5::jsonb) returning id`,
    [userId, startedAt, endedAt, startedAt.slice(0, 10), JSON.stringify([{ pageLabel: "mia-1", activeMinutes: 400, messages: 300, salesFrom: startedAt }])],
  );
  return Number(result.rows[0].id);
}

/** A sale of a page an hour ago whose home by the rule is bella's shift (written by hand, as sale-claims tests do). */
async function sale(ref: string, net: number, pageId = pageOne): Promise<number> {
  const inserted = await q(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, 'tip', 'tip', 'posted', 'ok', $3, $3, $4, $5, now() - interval '1 hour', 'fansly:rest', 'USD')
     returning id`,
    [pageId, ref, net + 4_000, net, 4_000],
  );
  const id = Number(inserted.rows[0].id);
  await q(
    `insert into sale_homes (transaction_id, page_id, occurred_at, net_mills, home, reason, shares, rule_version, computed_at)
     select t.id, t.platform_account_id, t.occurred_at, t.creator_net_amount_mills, 'shift', 'holder',
            jsonb_build_array(jsonb_build_object('userId', $2::bigint, 'workRef', null, 'shiftId', $3::bigint, 'percent', 100, 'mills', t.creator_net_amount_mills)),
            'test', now()
     from transactions t where t.id = $1`,
    [id, bella, shiftB],
  );
  return id;
}

const order = (pageId: number, card: Record<string, unknown>) => recordCustomOrder(app, {
  pageId, fanId: null, buyer: "fan-one", conversationRef: null, card, deadlineOn: null, acceptedByUserId: null, origin: "workboard",
  priceMills: 100_000, personFields: ["priceMills"], actor: { door: "workboard", userId: boss },
});

describe("the owner's agent door, part 2", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, AUDIT);
    await createUserAccount(app, { username: "tboss", role: "owner", password: "tboss-password-for-tests" }, AUDIT);
    for (const name of ["anna", "bella"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, AUDIT);
      await setUserPassword(app, { userId: await fixtureUserId(app, name), password: `${name}-password-for-tests` }, AUDIT);
    }
    boss = await fixtureUserId(app, "boss");
    anna = await fixtureUserId(app, "anna");
    bella = await fixtureUserId(app, "bella");
    tboss = await fixtureUserId(app, "tboss");
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageOne = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    // The test realm's page: its model is a test model (0414).
    const testModel = Number((await q("insert into models (slug, name, is_test) values ('t-mia', 'T Mia', true) returning id")).rows[0].id);
    testPage = (await createFanslyPage(app.db, { modelId: testModel, label: "t-mia-1" }))!.id;
    for (const user of [anna, bella]) await assignUserToPage(app.db, user, pageOne);

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
    await person("boss", { role: "owner", logins: { add: [boss] } });
    await person("anna", { role: "chatter", logins: { add: [anna] } });
    await person("bella", { role: "chatter", logins: { add: [bella] } });
    const tPerson = (await q("insert into people (code, display_name, role, state, is_test) values ('t-boss', 'Тест', 'owner', 'working', true) returning id")).rows[0]!.id;
    await q("insert into person_logins (user_id, person_id) values ($1, $2)", [tboss, tPerson]);
    // anna and bella work mia-1; anna's standing slot is 16:00–00:00 every day.
    for (const code of ["anna", "bella"]) {
      await q("insert into person_working_pages (person_id, page_id, position) select id, $2, 0 from people where code = $1", [code, pageOne]);
    }
    await q("insert into person_schedule_slots (person_id, page_id, start_minute, end_minute, valid_from) select id, null, 960, 0, '2026-01-01' from people where code = 'anna'");

    shiftB = await insertShift(bella, "2026-11-10T07:00:00Z", "2026-11-10T15:00:00Z");
    const issued = await issueOwnerAgentKey(app, { name: "owner-desk-2", ownerLogin: "boss", expiresInDays: 30 }, { source: "cli", actorUserId: boss });
    ownerKey = issued.token;
    ownerKeyId = issued.key.id;
    await insertAgentKey(testDb.db, {
      name: "owner-door-2-writer", keyPrefix: WRITER.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(WRITER),
      capabilities: ["write:matters"], pageIds: [pageOne], expiresAt: new Date(Date.now() + 30 * DAY_MS), createdBy: boss,
    });
    writerKeyId = Number((await q("select id from agent_keys where name = 'owner-door-2-writer'")).rows[0].id);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("refuses what it never takes at any depth of the arguments: 403, the audit row alone, no money moved", async (context) => {
    if (!testDb) return context.skip();
    const id = await order(pageOne, { task: "Ролик", price: "100$ тир", notes: "до пятницы" });
    const code = `K-${id}`;
    const before = await money();
    const audits = await calls();
    const refused: Array<[string, Record<string, unknown>]> = [
      // A custom's payment, its undoing, the owner's word on it, its cancel (it gives its sales back), its price.
      ["custom.step", { code, step: { action: "payment", transactionRef: "1" } }],
      ["custom.step", { code, step: { action: "unpay", transactionRef: "1" } }],
      ["custom.step", { code, step: { action: "paid_word", word: { kind: "gift" } } }],
      ["custom.step", { code, step: { action: "cancel" } }],
      ["custom.step", { code, step: { action: "edit", card: { price: "200$" } } }],
      ["custom.step", { code, step: { action: "edit", card: { notes: "x" }, priceMills: 5 } }],
      ["custom.step", { code, step: { action: "hold", reason: "ждём", PaidWord: { kind: "gift" } } }],
      ["customFinding.answer", { findingId: 1, step: { action: "record", card: { task: "x" }, price_mills: 5 } }],
      // A person's rights, pay terms, payout details, a proposal — however deep, whichever operation.
      ["people.edit", { code: "anna", schedule: { from: "2026-12-01", slot: null, rights: ["submits_shift"] } }],
      ["people.edit", { code: "anna", onboarding: [{ step: "x", payout_details: { card: "0000" } }] }],
      ["people.edit", { code: "anna", note: "x", payTerms: [] }],
      ["swap.approve", { questionId: 1, proposal: { change: { rights: ["sees_own_pay"] } } }],
      ["matter.comment", { key: "agent.ask:1", text: "x", deep: [[{ inner: { payment: 1 } }]] }],
    ];
    for (const [op, args] of refused) {
      const answer = await call(op, args);
      expect(answer.statusCode, `${op} ${JSON.stringify(args)}: ${answer.body}`).toBe(403);
    }
    expect(await calls()).toBe(audits + refused.length);
    expect(await money()).toEqual(before);
    expect((await q("select note from people where code = 'anna'")).rows[0].note).toBeNull();
    // Not a never-field, not the operation's: the strict schema's 400.
    expect((await call("custom.step", { code, step: { action: "hold", reason: "ждём", extra: 1 } })).statusCode).toBe(400);
    expect(await money()).toEqual(before);
  });

  it("reads and steps an order as the owner on the board, never its price; a test page's order does not exist", async (context) => {
    if (!testDb) return context.skip();
    const id = await order(pageOne, { task: "Ролик", price: "100$ тир", notes: "до пятницы" });
    const code = `K-${id}`;
    const events = await count("select count(*) as n from object_events");
    const shown = await call("custom.show", { code });
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json().result).toMatchObject({ order: { code, state: "recorded" } });
    const board = await call("custom.board", { pageLabel: "mia-1" });
    expect(board.statusCode, board.body).toBe(200);
    expect(board.json().result.viewer).toMatchObject({ owner: true });
    expect(await count("select count(*) as n from object_events")).toBe(events);

    const held = await call("custom.step", { code, step: { action: "hold", reason: "ждём реквизит" } });
    expect(held.statusCode, held.body).toBe(200);
    expect(held.json().result).toMatchObject({ changed: true, detail: { order: { code } } });
    expectDoorEvent(await lastEvent("custom_order", id), "custom_order.hold");
    // The same step again changes nothing.
    expect((await call("custom.step", { code, step: { action: "hold", reason: "ждём реквизит" } })).json().result.changed).toBe(false);

    // An edit is the card's changed fields: «Оплата» and the agreed total stay as they were.
    const edited = await call("custom.step", { code, step: { action: "edit", card: { notes: "к субботе", urgency: null } } });
    expect(edited.statusCode, edited.body).toBe(200);
    const row = (await q("select card, price_mills, person_fields from custom_orders where id = $1", [id])).rows[0];
    expect(row.card).toMatchObject({ task: "Ролик", price: "100$ тир", notes: "к субботе" });
    expect(Number(row.price_mills)).toBe(100_000);
    expect(row.person_fields).toEqual(expect.arrayContaining(["notes"]));
    expectDoorEvent(await lastEvent("custom_order", id), "custom_order.edited");

    const checked = await call("custom.step", { code, step: { action: "checked" } });
    expect(checked.statusCode, checked.body).toBe(200);
    expect((await q("select state from custom_orders where id = $1", [id])).rows[0].state).toBe("checked");

    // The test realm's order reads as one that does not exist.
    const testOrder = `K-${await order(testPage, { task: "Тест" })}`;
    expect((await call("custom.show", { code: testOrder })).statusCode).toBe(404);
    expect((await call("custom.step", { code: testOrder, step: { action: "hold", reason: "x" } })).statusCode).toBe(404);
  });

  it("never records or links a finding that names a sale (it would pay the order): 409, nothing written", async (context) => {
    if (!testDb) return context.skip();
    const id = await order(pageOne, { task: "Ролик по находке" });
    const tip = await sale("tx-owner-door-2-finding", 40_000);
    const finding = async (source: string, ref: string) => Number((await q(
      `insert into custom_findings (source, ref, page_id, amount_mills, quote, happened_at)
       values ($1, $2, $3, 40000, 'на кастом', now() - interval '1 hour') returning id`,
      [source, ref, pageOne],
    )).rows[0].id);
    const ofSale = await finding("sale", String(tip));
    const ofLine = await finding("shift_report", String(tip));
    const before = await money();
    const orders = await count("select count(*) as n from custom_orders");
    for (const findingId of [ofSale, ofLine]) {
      for (const step of [{ action: "link", code: `K-${id}` }, { action: "record", card: { task: "Ролик" } }]) {
        const answer = await call("customFinding.answer", { findingId, step });
        expect(answer.statusCode, answer.body).toBe(409);
        expect(answer.json().reason).toBe("finding_pays");
      }
    }
    expect(await money()).toEqual(before);
    expect(await count("select count(*) as n from custom_orders")).toBe(orders);
    expect((await q("select status from custom_findings where id = any($1::bigint[])", [[ofSale, ofLine]])).rows.map((one) => one.status)).toEqual(["open", "open"]);

    // A finding of no sale (a card in the work chat): dismissed as the owner, by the door.
    const card = await finding("work_chat", "https://t.me/c/1234567890/77");
    const listed = await call("customFinding.list", {});
    expect(listed.statusCode, listed.body).toBe(200);
    const dismissed = await call("customFinding.answer", { findingId: card, step: { action: "dismiss", reason: "not_custom" } });
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    expect(dismissed.json().result.finding).toMatchObject({ status: "dismissed", dismissReason: "not_custom" });
    expectDoorEvent(await lastEvent("custom_finding", card), "custom_finding.dismissed");
  });

  it("closes an agent's matter by its writer, leaves any other to its kind's service, and comments any", async (context) => {
    if (!testDb) return context.skip();
    const open = (key: string, source: "agent" | "server", owner: { role: "owner" } | { userId: number }) => openMatter(app.db, {
      key, kind: key.slice(0, key.indexOf(":")), source, title: "Вопрос владельцу", object: null, pageIds: [], owner, money: false, evidence: {}, link: null,
    }, source === "agent" ? { door: "api", agentKeyId: writerKeyId } : { door: "system" });
    const agents = (await open("agent.ask:1", "agent", { role: "owner" })).matter;
    const servers = (await open("question.asked:999", "server", { role: "owner" })).matter;
    await open("agent.ask:2", "agent", { userId: tboss });

    const listed = await call("matter.list", { state: "open" });
    expect(listed.statusCode, listed.body).toBe(200);
    const keys = (listed.json().result.matters as Array<{ key: string }>).map((one) => one.key);
    expect(keys).toEqual(expect.arrayContaining(["agent.ask:1", "question.asked:999"]));
    expect(keys).not.toContain("agent.ask:2");

    const commented = await call("matter.comment", { key: "question.asked:999", text: "посмотрю вечером" });
    expect(commented.statusCode, commented.body).toBe(200);
    expectDoorEvent(await lastEvent("matter", servers.id), "matter.comment");

    const kept = await call("matter.close", { key: "question.asked:999", how: "resolved" });
    expect(kept.statusCode, kept.body).toBe(409);
    expect(kept.json().reason).toBe("matter_kind_service");
    expect((await q("select state from matters where id = $1", [servers.id])).rows[0].state).toBe("open");

    const closed = await call("matter.close", { key: "agent.ask:1", how: "resolved", note: "решили" });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().result).toMatchObject({ matter: { key: "agent.ask:1", state: "closed" }, transition: "closed" });
    expectDoorEvent(await lastEvent("matter", agents.id), "matter.closed");
    expect((await call("matter.close", { key: "agent.ask:1", how: "resolved" })).json().result.transition).toBe("unchanged");

    // The test realm's matter does not exist here.
    expect((await call("matter.close", { key: "agent.ask:2", how: "resolved" })).statusCode).toBe(404);
    expect((await call("matter.comment", { key: "agent.ask:2", text: "x" })).statusCode).toBe(404);
  });

  it("approves a page of «Обучение» for the team, naming the key", async (context) => {
    if (!testDb) return context.skip();
    await publishAgentReport(app, { slug: "chatter-job", body: { title: "Инструкция чаттера", section: "learn", body: "## Смена\n" }, agentKeyId: writerKeyId });
    const listed = await call("learn.list", {});
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().result).toMatchObject({ canApprove: true, pages: [{ slug: "chatter-job", approved: false }] });
    expect((await call("learn.show", { slug: "chatter-job" })).json().result.page).toMatchObject({ body: "## Смена\n" });

    const approved = await call("learn.approve", { slug: "chatter-job", approved: true });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().result.page).toMatchObject({ slug: "chatter-job", approved: true });
    const audit = await q("select actor_user_id, source, metadata from audit_events where event_type = 'learn_page.approval' order by id desc limit 1");
    expect(Number(audit.rows[0].actor_user_id)).toBe(boss);
    expect(audit.rows[0]).toMatchObject({ source: "owner_agent", metadata: { slug: "chatter-job", approved: true, actorAgentKeyId: ownerKeyId } });
    // The team reads it now.
    const pages = await rawSession("anna", "GET", "/api/v1/learn");
    expect(pages.json().pages.map((page: { slug: string }) => page.slug)).toEqual(["chatter-job"]);

    const before = await count("select count(*) as n from audit_events where event_type = 'learn_page.approval'");
    expect((await call("learn.approve", { slug: "no-such-page", approved: true })).statusCode).toBe(404);
    expect(await count("select count(*) as n from audit_events where event_type = 'learn_page.approval'")).toBe(before);
  });

  it("approves a swap and takes it back as the owner; the persons' history names the key", async (context) => {
    if (!testDb) return context.skip();
    const day = new Date(Date.now() + 3 * 3_600_000 + 2 * DAY_MS).toISOString().slice(0, 10);
    const asked = await rawSession("anna", "POST", "/api/v1/team/questions", {
      pageLabel: "mia-1", kind: "swap", text: "Не выйду, Белла выйдет", swap: { date: day, pageLabels: ["mia-1"], start: "16:00", end: "00:00", coverPersonCode: "bella" },
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const questionId = asked.json().question.id as number;
    const other = await rawSession("anna", "POST", "/api/v1/team/questions", { pageLabel: "mia-1", kind: "late", text: "Опоздаю на час" });
    expect(other.statusCode, other.body).toBe(200);
    const notSwap = await call("swap.approve", { questionId: other.json().question.id });
    expect(notSwap.statusCode, notSwap.body).toBe(409);
    expect(notSwap.json().reason).toBe("not_swap");
    expect((await call("swap.approve", { questionId: 999_999 })).statusCode).toBe(404);

    const approved = await call("swap.approve", { questionId, text: "ок" });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().result.question).toMatchObject({ state: "answered", answer: "yes", swap: { approved: true } });
    expect((await q("select kind from person_schedule_slots where question_id = $1 order by kind", [questionId])).rows.map((one) => one.kind)).toEqual(["cover", "off"]);
    const audits = async (eventType: string) => (await q("select actor_user_id, source, metadata from audit_events where event_type = $1 order by id", [eventType])).rows;
    const made = await audits("person.schedule_swap");
    expect(made).toHaveLength(2);
    for (const row of made) {
      expect(Number(row.actor_user_id)).toBe(boss);
      expect(row).toMatchObject({ source: "owner_agent", metadata: { questionId, actorAgentKeyId: ownerKeyId } });
    }
    expect((await call("swap.list", {})).json().result.swaps.map((one: { questionId: number }) => one.questionId)).toEqual([questionId]);

    const revoked = await call("swap.revoke", { questionId });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json().result.question.swap).toMatchObject({ approved: false, revoked: true });
    const taken = await audits("person.schedule_swap_revoked");
    expect(taken).toHaveLength(2);
    expect(taken[0]).toMatchObject({ source: "owner_agent", metadata: { questionId, actorAgentKeyId: ownerKeyId } });
    expect((await call("swap.revoke", { questionId })).statusCode).toBe(409);
  });

  it("ties a decision carried over from the ledger to its sale of the live agency, naming the key", async (context) => {
    if (!testDb) return context.skip();
    const decision = (await insertSaleDecision(app.db, {
      transactionId: null, pageId: null, kind: "split", shares: [{ userId: anna, percent: 100 }], pot: null, outcome: "imported", ruleHome: null,
      note: "чат вела anna", decidedByUserId: null, decidedAt: new Date(), saidBy: "владелец", source: "ledger", ledgerDecisionId: 900_001,
      ledgerRef: { pageLabel: "mia-1", fanRef: "fan-one", netMills: 30_000, occurredAt: new Date(Date.now() - 3_600_000).toISOString() },
    }, new Date()))!;
    expect(decision).toMatchObject({ needsLink: true });
    const imported = async (pageId: number | null, pageLabel: string) => (await insertSaleDecision(app.db, {
      transactionId: null, pageId, kind: "nobody", shares: [], pot: null, outcome: "imported", ruleHome: null,
      note: "fixture", decidedByUserId: null, decidedAt: new Date(), saidBy: null, source: "ledger", ledgerDecisionId: null, ledgerRef: { pageLabel },
    }, new Date()))!;
    const label = (await q("select label from pages where id = $1", [testPage])).rows[0].label as string;
    const testByLabel = await imported(null, label);
    const testById = await imported(testPage, "fixture-obsolete-label");
    const testOwner = (await principalOfLogin(app, tboss))!;
    expect((await readUnlinkedDecisions(app, testOwner)).decisions.map((row) => row.id).sort()).toEqual([testById.id, testByLabel.id].sort());
    const listed = await call("decision.unlinked", {});
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().result.decisions.map((one: { id: number }) => one.id)).toEqual([decision.id]);

    // A sale of the test realm does not exist here; the decision still waits.
    const testSale = await sale("tx-owner-door-2-test", 30_000, testPage);
    expect((await call("decision.link", { decisionId: decision.id, transactionId: testSale })).statusCode).toBe(404);
    expect((await q("select transaction_id from sale_owner_decisions where id = $1", [decision.id])).rows[0].transaction_id).toBeNull();

    const liveSale = await sale("tx-owner-door-2-link", 30_000);
    expect((await call("decision.link", { decisionId: testByLabel.id, transactionId: liveSale })).statusCode).toBe(404);
    await expect(linkUnlinkedDecision(app, testOwner, { decisionId: testByLabel.id, transactionId: liveSale })).rejects.toMatchObject({ statusCode: 404 });
    await expect(linkUnlinkedDecision(app, testOwner, { decisionId: decision.id, transactionId: testSale })).rejects.toMatchObject({ statusCode: 404 });
    const disputed = await sale("fixture-open-claim", 200);
    await q("insert into sale_claims (transaction_id, page_id, kind, state, claimed_at) values ($1, $2, 'imported', 'owner', now())", [disputed, pageOne]);
    const blocked = await call("decision.link", { decisionId: decision.id, transactionId: disputed });
    expect([blocked.statusCode, blocked.json().reason]).toEqual([409, "open_dispute"]);
    expect((await q("select state, decision_id from sale_claims where transaction_id = $1", [disputed])).rows).toEqual([{ state: "owner", decision_id: null }]);
    const linked = await call("decision.link", { decisionId: decision.id, transactionId: liveSale });
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json().result.linked).toBe(true);
    const row = (await q("select transaction_id, needs_link from sale_owner_decisions where id = $1", [decision.id])).rows[0];
    expect([Number(row.transaction_id), row.needs_link]).toEqual([liveSale, false]);
    const second = await imported(pageOne, "fixture-obsolete-label");
    const replaced = await call("decision.link", { decisionId: second.id, transactionId: liveSale });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json().result.linked).toBe(true);
    expect((await q("select state, needs_link from sale_owner_decisions where id = $1", [second.id])).rows).toEqual([{ state: "active", needs_link: false }]);
    expect((await q("select state from sale_owner_decisions where id = $1", [decision.id])).rows).toEqual([{ state: "superseded" }]);
    expect((await q("select id::int from sale_owner_decisions where transaction_id = $1 and state = 'active'", [liveSale])).rows).toEqual([{ id: second.id }]);
    expect((await call("decision.link", { decisionId: second.id, transactionId: liveSale })).statusCode).toBe(404);
  });
});
