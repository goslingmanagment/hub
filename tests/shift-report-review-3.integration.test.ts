import { createServer } from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { shiftReportResponseSchema } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel, insertAgentKey, insertPersonLogin, insertPersonScheduleSlot, insertSaleClaim } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { refreshSaleHomes } from "../apps/runtime/src/services/sale-homes.ts";
import { readHandinVersionPosts, readShiftReportsFeed, submitShiftReport, type HandinPersonActor } from "../apps/runtime/src/services/shift-handins.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { listenOnLoopback } from "./helpers/network.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The second round of the final review of «чья продажа» and the shift report. (1) The agent's door changes nothing
// outside the key's pages and nothing about another sale: what a decision replaces and what it answers are checked in
// the transaction that writes it, and an object of another page answers as one that does not exist. (2) A hand-in
// whose wait for the ledger a decision, an agreement or a cancel fell into writes what rules after it, never the sums
// it read before; a decision «со слов» in flight does not replace the owner's newer one unnamed. (3) A cancelled
// decision takes its shares back out of the reports it settled: each gets a new version with what rules now, a day
// already paid raises the owner's matter, the claims it decided wait again. (8) Every line's page is one of its
// version's pages. (9) The owner's own decision is the owner's to change. (11) A handed-in report has one day for every
// reader. (12) A decision stays open for the person it gives the sale to; a share is its person's by any login.
// Money: required.
//
// bella really works mia-1 in the hours before now (minutes and messages), so the rule itself gives her the page's
// sales of those hours, before a decision and after its cancel.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HOUR_MS = 3_600_000;
const KEYS = { one: `${AGENT_KEY_TOKEN_PREFIX}review3-page-one-key`, two: `${AGENT_KEY_TOKEN_PREFIX}review3-page-two-key` } as const;
const WORDS = { saidBy: "владелец", saidAt: "2026-11-12", telegramUserId: 700_000_701, sourceRef: "https://t.me/c/1/30" };

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let pageOne = 0;
let pageTwo = 0;
let anna = 0;
let bella = 0;
let refs = 0;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const asSession = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asKey = (key: keyof typeof KEYS, method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${KEYS[key]}` }, ...(payload ? { payload } : {}) });

/** A shift row of a person on mia-1 that began `hoursAgo` and ran five hours: the object a report is of. */
async function shiftRow(userId: number, hoursAgo: number): Promise<number> {
  const startedAt = new Date(Date.now() - hoursAgo * HOUR_MS);
  const endedAt = new Date(startedAt.getTime() + 5 * HOUR_MS - 60_000);
  const result = await q(
    `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
     values ($1, 'closed', $2::timestamptz, $3::timestamptz, 290, 98, $4::date, $5::jsonb) returning id`,
    [userId, startedAt.toISOString(), endedAt.toISOString(), new Date(startedAt.getTime() + 3 * HOUR_MS).toISOString().slice(0, 10),
      JSON.stringify([{ pageLabel: "mia-1", activeMinutes: 290, messages: 98, salesFrom: startedAt.toISOString() }])],
  );
  return Number(result.rows[0].id);
}

/** A tip of a page `minutesAgo` before now; its home is what the rule gives it from the facts. */
async function sale(pageId: number, net: number, minutesAgo: number): Promise<number> {
  refs += 1;
  const inserted = await q(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, 'tip', 'tip', 'posted', 'ok', $3, $3, $4, $5, now() - make_interval(mins => $6), 'fansly:rest', 'USD') returning id`,
    [pageId, `tx-review3-${refs}`, net + 4_000, net, 4_000, minutesAgo],
  );
  const now = new Date();
  await refreshSaleHomes(app.db, { from: new Date(now.getTime() - 24 * HOUR_MS), to: now, now });
  return Number(inserted.rows[0].id);
}

async function homeOf(transactionId: number) {
  const row = (await q("select home, reason, shares from sale_homes where transaction_id = $1", [transactionId])).rows[0] as
    { home: string; reason: string; shares: Array<{ userId: number }> } | undefined;
  return row === undefined ? null : { home: row.home, reason: row.reason, users: row.shares.map((share) => Number(share.userId)) };
}

/** A person (anna, unless named) says «моё» of a sale in their shift's report. */
async function say(shiftId: number, transactionId: number, note: string, who = "anna") {
  const said = await asSession(who, "PUT", `/api/v1/shift-reports/${shiftId}/lines/${transactionId}`, { statement: "mine", note });
  expect(said.statusCode, said.body).toBe(200);
}

async function submit(shiftId: number, who = "anna") {
  const submitted = await asSession(who, "POST", `/api/v1/shift-reports/${shiftId}/submit`);
  expect(submitted.statusCode, submitted.body).toBe(200);
}

/** A decision «со слов» through the door: its number. */
async function decide(key: keyof typeof KEYS, body: Record<string, unknown>): Promise<{ id: number; versions: Array<{ shiftId: number; version: number }> }> {
  const said = await asKey(key, "POST", "/api/v1/agent/sale-decisions", { ...WORDS, ...body });
  expect(said.statusCode, said.body).toBe(200);
  return { id: said.json().decision.id as number, versions: said.json().versions };
}

async function ask(key: keyof typeof KEYS, body: Record<string, unknown>): Promise<number> {
  const asked = await asKey(key, "POST", "/api/v1/agent/sale-questions", {
    askedOf: "owner", people: ["anna", "bella"], question: "чья продажа?", askedAt: "2026-11-12",
    telegramUserId: WORDS.telegramUserId, sourceRef: WORDS.sourceRef, ...body,
  });
  expect(asked.statusCode, asked.body).toBe(200);
  return asked.json().question.id as number;
}

/** The newest version of a shift's report, and its line of a sale. */
async function newest(shiftId: number, transactionId: number) {
  const row = (await q(
    `select v.id, v.version, v.total_mills, v.made_for, v.day_paid, v.lines
     from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version where h.shift_id = $1`,
    [shiftId],
  )).rows[0] as { id: string; version: number; total_mills: string; made_for: Record<string, unknown> | null; day_paid: boolean | null; lines: Array<Record<string, unknown>> };
  return { ...row, line: row.lines.find((one) => one.transactionId === transactionId) };
}

/** The claims of a sale, oldest first: state, the decision that closed it, when it closed. */
const claimOf = async (transactionId: number) => (await q(
  "select id::int as id, state, decision_id::int as decision_id, closed_at from sale_claims where transaction_id = $1 order by id", [transactionId],
)).rows as Array<{ id: number; state: string; decision_id: number | null; closed_at: Date | null }>;

/** A question by its number: state and the decision that answered it. */
const questionOf = async (id: number) => (await q(
  "select state, decision_id::int as decision_id, closed_at from sale_claims where id = $1", [id],
)).rows[0] as { state: string; decision_id: number | null; closed_at: Date | null };

const decisionState = async (id: number) => (await q("select state from sale_owner_decisions where id = $1", [id])).rows[0]?.state as string | undefined;

const annaAtWorkboard = (): HandinPersonActor => ({ kind: "person", userId: anna, role: "chatter", pageIds: [pageOne], door: "workboard" });

/** A ledger that runs `onCall` each time it is asked and then answers `body` (null: it is down). */
async function fakeLedger(onCall: (call: number) => Promise<void>, body: (url: URL) => unknown = () => null) {
  let calls = 0;
  const ledger = createServer((request, response) => {
    void (async () => {
      calls += 1;
      await onCall(calls);
      const answer = body(new URL(request.url ?? "/", "http://ledger.test"));
      response.writeHead(answer === null ? 503 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer ?? { error: "down" }));
    })();
  });
  const address = await listenOnLoopback(ledger, "the fake agency ledger");
  if (!address) return null;
  const config = { ledgerUrl: app.config.ledgerUrl, ledgerPayoutsKey: app.config.ledgerPayoutsKey };
  Object.assign(app.config, { ledgerUrl: `http://${address.host}:${address.port}`, ledgerPayoutsKey: "test-review3-key" });
  return {
    calls: () => calls,
    close: async () => {
      Object.assign(app.config, config);
      await new Promise<void>((resolve) => ledger.close(() => resolve()));
    },
  };
}

describe("«чья продажа» and the shift report, the final review's second round", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    for (const name of ["anna", "bella"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
      await setUserPassword(app, { userId: await fixtureUserId(app, name), password: `${name}-password-for-tests` }, { source: "cli" });
    }
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageOne = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    pageTwo = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-2" }))!.id;
    for (const name of ["anna", "bella"]) await assignUserToPage(app.db, await fixtureUserId(app, name), pageOne);
    const owner = await fixtureUserId(app, "boss");
    for (const [name, pages] of [["one", [pageOne]], ["two", [pageTwo]]] as const) {
      await insertAgentKey(testDb.db, {
        name: `review3-${name}`, keyPrefix: KEYS[name].slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(KEYS[name]),
        capabilities: ["write:shift_reports", "read:team", "read:money"] as never, pageIds: [...pages],
        expiresAt: new Date(Date.now() + 30 * 86_400_000), createdBy: owner,
      });
    }
    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "anna", "bella"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    for (const code of ["anna", "bella"]) {
      const created = await asSession("boss", "POST", "/api/v1/admin/people", {
        code, displayName: code, role: "chatter", state: "working", rights: ["submits_shift"], logins: { add: [await fixtureUserId(app, code)] },
      });
      expect(created.statusCode, created.body).toBe(200);
    }
    await q("update person_rights set granted_at = now() - interval '30 days'");
    anna = await fixtureUserId(app, "anna");
    bella = await fixtureUserId(app, "bella");
    // bella's work on mia-1: every minute of the five hours before now, a message every three minutes.
    await q(
      `insert into chatter_activity_minutes (user_id, page_id, minute, input)
       select $1, $2, minute, true
       from generate_series(date_trunc('minute', now() - interval '5 hours'), date_trunc('minute', now() - interval '5 minutes'), interval '1 minute') minute`,
      [bella, pageOne],
    );
    await q(
      `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
       select 'fansly', $1, (9800000000 + n)::text, '7700000099', $2, 'fansly-extension', false, false, now() - interval '5 hours' + interval '3 minutes' * n, 'hand'
       from generate_series(0, 97) n`,
      [pageOne, bella],
    );
    // Her shift's row over those hours: the rule's share names it, and a claim against her opens her report at the sale.
    await shiftRow(bella, 5);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("gives bella's hours on mia-1 to bella by the rule itself", async (context) => {
    if (!testDb) return context.skip();
    expect(await homeOf(await sale(pageOne, 3_000, 90))).toEqual({ home: "shift", reason: "holder", users: [bella] });
    expect(await homeOf(await sale(pageOne, 3_000, 9 * 60))).toMatchObject({ home: "nobody" });
  });

  it("refuses a decision that replaces or answers what is of another page or about another sale (1)", async (context) => {
    if (!testDb) return context.skip();
    // mia-1: a decision of one sale, a question about another.
    const decided = await sale(pageOne, 9_000, 9 * 60);
    const first = (await decide("one", { transactionId: decided, kind: "owner", shares: [{ person: "anna", percent: 100 }] })).id;
    const about = await sale(pageOne, 8_000, 9 * 60 + 5);
    const question = await ask("one", { transactionId: about });
    const state = async () => ({
      decision: await decisionState(first),
      question: await questionOf(question),
      onPageTwo: (await q("select count(*)::int as n from sale_owner_decisions where page_id = $1", [pageTwo])).rows[0].n,
      ofOther: (await q("select count(*)::int as n from sale_owner_decisions where transaction_id not in ($1, $2)", [decided, about])).rows[0].n,
    });
    const untouched = { decision: "active", question: { state: "owner", decision_id: null, closed_at: null }, onPageTwo: 0, ofOther: 0 };
    expect(await state()).toEqual(untouched);

    // A key of mia-2 alone decides on its own page and names them: the answers of numbers that do not exist.
    const own = { pageLabel: "mia-2", fanRef: "fan-of-two", kind: "owner", shares: [{ person: "anna", percent: 100 }], ...WORDS };
    const refusals: Array<[number, string, string]> = [];
    for (const naming of [{ supersedes: first }, { supersedes: 999_999 }, { answers: question }, { answers: 999_999 }]) {
      const refused = await asKey("two", "POST", "/api/v1/agent/sale-decisions", { ...own, ...naming });
      refusals.push([refused.statusCode, refused.json().reason, refused.json().message]);
    }
    expect(refusals.map(([status, reason]) => [status, reason])).toEqual([[409, "not_active"], [409, "not_active"], [409, "question_closed"], [409, "question_closed"]]);
    expect(refusals[0]).toEqual(refusals[1]);
    expect(refusals[2]).toEqual(refusals[3]);
    expect(await state()).toEqual(untouched);

    // The key of mia-1 itself: a decision on another sale replaces and answers neither.
    const other = await sale(pageOne, 7_000, 9 * 60 + 10);
    for (const naming of [{ supersedes: first }, { answers: question }]) {
      const refused = await asKey("one", "POST", "/api/v1/agent/sale-decisions", { transactionId: other, kind: "exclude", ...WORDS, ...naming });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().reason).toBe("other_sale");
    }
    expect(await state()).toEqual(untouched);

    // With no sale named: the words of the same page and fan are replaced, another fan's are not.
    const words = (await decide("one", { pageLabel: "mia-1", fanRef: "fan-seven", kind: "owner", shares: [{ person: "anna", percent: 100 }] })).id;
    const otherFan = await asKey("one", "POST", "/api/v1/agent/sale-decisions", { pageLabel: "mia-1", fanRef: "fan-eight", kind: "exclude", supersedes: words, ...WORDS });
    expect([otherFan.statusCode, otherFan.json().reason]).toEqual([409, "other_sale"]);
    expect(await decisionState(words)).toBe("active");
    await decide("one", { pageLabel: "mia-1", fanRef: "fan-seven", kind: "exclude", supersedes: words });
    expect(await decisionState(words)).toBe("superseded");

    // Its own sale's decision is replaced and its question answered as before.
    await decide("one", { transactionId: decided, kind: "exclude", supersedes: first });
    expect(await decisionState(first)).toBe("superseded");
    const answer = (await decide("one", { transactionId: about, kind: "owner", shares: [{ person: "bella", percent: 100 }], answers: question })).id;
    expect(await questionOf(question)).toMatchObject({ state: "decided", decision_id: answer });
  });

  it("lets no key cancel, mark, answer or close what names no page (1)", async (context) => {
    if (!testDb) return context.skip();
    // Carried over from the ledger with a page Hub does not know: nobody's to change through a key.
    const decision = Number((await q(
      `insert into sale_owner_decisions (transaction_id, page_id, kind, shares, outcome, decided_at, said_by, source, ledger_decision_id, ledger_ref, needs_link)
       values (null, null, 'split', $1::jsonb, 'imported', now(), 'владелец', 'ledger', 9001, '{"pageLabel":"gone-1","fanRef":"fan-x"}'::jsonb, true) returning id`,
      [JSON.stringify([{ userId: anna, percent: 100 }])],
    )).rows[0].id);
    const question = (await insertSaleClaim(app.db, {
      transactionId: null, pageId: null, kind: "imported", claimantUserId: null, claimantHandinId: null, claimantVersion: null, statement: null,
      shareWithUserId: null, claimantNote: null, claimedAt: new Date(), sideUserId: null, sideShiftId: null, state: "owner",
      escalatedAt: new Date(), escalatedWhy: "imported", ledgerQuestionId: 9002, question: "чья продажа?", ledgerRef: { pageLabel: "gone-1" },
    }, new Date()))!.id;
    const said = { telegramUserId: WORDS.telegramUserId, sourceRef: WORDS.sourceRef };
    for (const key of ["one", "two"] as const) {
      const statuses = [
        await asKey(key, "POST", "/api/v1/agent/sale-decisions/cancel", { decisionId: decision, note: "ошибка", ...said }),
        await asKey(key, "POST", "/api/v1/agent/sale-decisions/applied", { decisionId: decision, person: "anna", reportDate: "2026-11-12" }),
        await asKey(key, "POST", "/api/v1/agent/sale-questions/answer", { questionId: question, answer: "её", ...said }),
        await asKey(key, "POST", "/api/v1/agent/sale-questions/close", { questionId: question, note: "не нужно", ...said }),
      ].map((answer) => answer.statusCode);
      expect(statuses, key).toEqual([404, 404, 404, 404]);
    }
    expect((await q("select state, applied_at from sale_owner_decisions where id = $1", [decision])).rows[0]).toEqual({ state: "active", applied_at: null });
    expect((await q("select state, answer_text, close_note from sale_claims where id = $1", [question])).rows[0]).toEqual({ state: "owner", answer_text: null, close_note: null });
  });

  it("hands in what was decided while the hand-in waited for the ledger, not what it read before (2)", async (context) => {
    if (!testDb) return context.skip();
    // A report handed in with a disputed «моё»; anna hands in again, and while that waits the owner decides «пополам».
    const shift = await shiftRow(anna, 30);
    const disputed = await sale(pageOne, 16_001, 60);
    await say(shift, disputed, "мой фан");
    await submit(shift);
    expect((await newest(shift, disputed)).line).toMatchObject({ amountMills: 0, claimedMills: 16_001, disputed: true });
    await submitShiftReport(app, annaAtWorkboard(), { shiftId: shift }, {
      dayPaid: async () => {
        const decided = await asSession("boss", "POST", "/api/v1/sale-disputes/decide", { transactionId: disputed, outcome: "half" });
        expect(decided.statusCode, decided.body).toBe(200);
        return null;
      },
    });
    const half = Math.min(anna, bella) === anna ? 8_001 : 8_000;
    const after = await newest(shift, disputed);
    expect(after.version).toBe(3);
    expect(after.line).toMatchObject({ amountMills: half, disputed: false, settled: "owner" });
    expect(after.line).not.toHaveProperty("claimedMills");
    const fed = (await readShiftReportsFeed(app, { pageIds: [pageOne], limit: 500 })).reports.filter((one) => one.shiftId === shift).at(-1)!;
    expect(fed).toMatchObject({ version: 3, totalMills: 8_000 });
    expect((await claimOf(disputed)).map((claim) => claim.state)).toEqual(["decided"]);

    // A first hand-in: the draft read a disputed «моё», and while it waited the sale was decided «со слов».
    const fresh = await shiftRow(anna, 54);
    const said = await sale(pageOne, 12_000, 65);
    await say(fresh, said, "мой");
    await submitShiftReport(app, annaAtWorkboard(), { shiftId: fresh }, {
      dayPaid: async () => {
        await decide("one", { transactionId: said, kind: "owner", shares: [{ person: "bella", percent: 100 }] });
        return null;
      },
    });
    const first = await newest(fresh, said);
    expect(first.version).toBe(1);
    expect(first.line).toMatchObject({ amountMills: 0, disputed: false, settled: "owner" });
    // A decided sale is not contested again by a hand-in.
    expect(await claimOf(said)).toEqual([]);

    // A decision cancelled while the hand-in waited: what it gave is not handed in.
    const third = await shiftRow(anna, 78);
    const given = await sale(pageOne, 14_000, 70);
    await say(third, given, "мой");
    await submit(third);
    const decision = (await decide("one", { transactionId: given, kind: "owner", shares: [{ person: "anna", percent: 100 }] })).id;
    expect((await newest(third, given)).line).toMatchObject({ amountMills: 14_000, settled: "owner" });
    await submitShiftReport(app, annaAtWorkboard(), { shiftId: third }, {
      dayPaid: async () => {
        const cancelled = await asKey("one", "POST", "/api/v1/agent/sale-decisions/cancel", { decisionId: decision, note: "ошибка", telegramUserId: WORDS.telegramUserId, sourceRef: WORDS.sourceRef });
        expect(cancelled.statusCode, cancelled.body).toBe(200);
        return null;
      },
    });
    const back = await newest(third, given);
    expect(back.line).toMatchObject({ amountMills: 0, disputed: true, claimedMills: 14_000 });
    expect(back.line).not.toHaveProperty("settled");
    expect(Number(back.total_mills)).toBe(0);
  });

  it("refuses a decision «со слов» on a sale decided while it waited for the ledger: it replaces nothing it did not name (1, 2)", async (context) => {
    if (!testDb) return context.skip();
    const shift = await shiftRow(anna, 102);
    const disputed = await sale(pageOne, 10_000, 75);
    await say(shift, disputed, "мой");
    await submit(shift);
    // The ledger answers slowly: while the door's decision waits for it, another decision of the sale is recorded.
    let between: number | null = null;
    const ledger = await fakeLedger(async (call) => {
      if (call === 1) between = (await decide("one", { transactionId: disputed, kind: "owner", shares: [{ person: "anna", percent: 100 }] })).id;
    });
    if (!ledger) return context.skip();
    let said: Awaited<ReturnType<typeof asKey>>;
    try {
      said = await asKey("one", "POST", "/api/v1/agent/sale-decisions", { transactionId: disputed, kind: "owner", shares: [{ person: "bella", percent: 100 }], ...WORDS });
    } finally {
      await ledger.close();
    }
    expect(ledger.calls()).toBeGreaterThan(0);
    expect(between).not.toBeNull();
    expect([said.statusCode, said.json().reason], said.body).toEqual([409, "decision_exists"]);
    // The decision made in between stands, and anna's report with it.
    expect((await q("select id::int as id, state from sale_owner_decisions where transaction_id = $1 order by id", [disputed])).rows).toEqual([{ id: between, state: "active" }]);
    expect((await newest(shift, disputed)).line).toMatchObject({ amountMills: 10_000, disputed: false, settled: "owner" });
  });

  it("leaves the owner's own decision to the owner: a key neither cancels nor replaces it (9)", async (context) => {
    if (!testDb) return context.skip();
    const shift = await shiftRow(anna, 198);
    const disputed = await sale(pageOne, 13_000, 105);
    await say(shift, disputed, "мой");
    await submit(shift);
    const decided = await asSession("boss", "POST", "/api/v1/sale-disputes/decide", { transactionId: disputed, outcome: "first" });
    expect(decided.statusCode, decided.body).toBe(200);
    const owners = Number((await q("select id from sale_owner_decisions where transaction_id = $1 and state = 'active'", [disputed])).rows[0].id);
    const said = { telegramUserId: WORDS.telegramUserId, sourceRef: WORDS.sourceRef };
    const refusals = [
      await asKey("one", "POST", "/api/v1/agent/sale-decisions/cancel", { decisionId: owners, note: "ошибка", ...said }),
      await asKey("one", "POST", "/api/v1/agent/sale-decisions", { transactionId: disputed, kind: "exclude", supersedes: owners, ...WORDS }),
      await asKey("one", "POST", "/api/v1/agent/sale-decisions", { transactionId: disputed, kind: "exclude", ...WORDS }),
    ];
    for (const refused of refusals) {
      expect([refused.statusCode, refused.json().reason], refused.body).toEqual([409, "owner_decision"]);
      expect(refused.json().message).toContain("Workboard");
    }
    expect((await q("select id::int as id, state, source from sale_owner_decisions where transaction_id = $1 order by id", [disputed])).rows).toEqual([{ id: owners, state: "active", source: "dispute" }]);
    expect((await newest(shift, disputed)).line).toMatchObject({ amountMills: 13_000, settled: "owner" });
    expect((await newest(shift, disputed)).version).toBe(2);
  });

  it("keeps a decision open for the person it gives the sale to while only someone else's report holds the line (12)", async (context) => {
    if (!testDb) return context.skip();
    // anna's report holds the sale (her «моё»); the decision gives it whole to bella, whose reports do not hold it.
    const shift = await shiftRow(anna, 222);
    const disputed = await sale(pageOne, 9_500, 110);
    await say(shift, disputed, "мой");
    await submit(shift);
    const whole = await decide("one", { transactionId: disputed, kind: "owner", shares: [{ person: "bella", percent: 100 }] });
    const listed = async () => ((await asKey("one", "GET", "/api/v1/agent/sale-decisions?open=true")).json().decisions as Array<{ id: number; status: string; statusWords: string }>)
      .find((one) => one.id === whole.id);
    expect(await listed()).toMatchObject({ status: "open" });
    expect((await listed())!.statusWords).toContain("ждёт отчёта: bella");
    // Taken into bella's post: it leaves the open list.
    expect((await asKey("one", "POST", "/api/v1/agent/sale-decisions/applied", { decisionId: whole.id, person: "bella", reportDate: "2026-11-12" })).statusCode).toBe(200);
    expect(await listed()).toBeUndefined();
    // A decision whose every share is in a report handed in Hub is held, as before.
    const other = await sale(pageOne, 9_600, 115);
    await say(shift, other, "мой");
    await submit(shift);
    const own = await asKey("one", "POST", "/api/v1/agent/sale-decisions", { transactionId: other, kind: "owner", shares: [{ person: "anna", percent: 100 }], ...WORDS });
    expect(own.json().decision).toMatchObject({ status: "held" });
  });

  it("brings the reports a cancelled decision settled back to what rules now, and its claim back to the side (3)", async (context) => {
    if (!testDb) return context.skip();
    const shift = await shiftRow(anna, 126);
    const disputed = await sale(pageOne, 16_000, 80);
    await say(shift, disputed, "мой фан");
    await submit(shift);
    const [claim] = await claimOf(disputed);
    expect(claim).toMatchObject({ state: "asked" });
    const matter = async () => (await q("select state from matters where reason_key = $1", [`sale.claim:${claim!.id}`])).rows[0]?.state as string | undefined;
    expect(await matter()).toBe("open");

    // Decided «со слов»: anna's whole. Her report follows, the claim is decided, the home is the decision's.
    const decision = await decide("one", { transactionId: disputed, kind: "owner", shares: [{ person: "anna", percent: 100 }] });
    expect(decision.versions).toEqual([{ shiftId: shift, version: 2 }]);
    expect((await newest(shift, disputed)).line).toMatchObject({ amountMills: 16_000, disputed: false, settled: "owner" });
    expect(await claimOf(disputed)).toEqual([expect.objectContaining({ state: "decided", decision_id: decision.id })]);
    expect(await matter()).toBe("closed");
    expect(await homeOf(disputed)).toMatchObject({ reason: "owner_split", users: [anna] });

    // Cancelled: the report gets a version with what rules now — bella's sale by the rule, anna's «моё» claiming it.
    const cancelled = await asKey("one", "POST", "/api/v1/agent/sale-decisions/cancel", { decisionId: decision.id, note: "ошибка", telegramUserId: WORDS.telegramUserId, sourceRef: WORDS.sourceRef });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().decision).toMatchObject({ id: decision.id, status: "cancelled" });
    expect(cancelled.json().versions).toEqual([{ shiftId: shift, version: 3 }]);
    const back = await newest(shift, disputed);
    expect(back).toMatchObject({ version: 3, made_for: { kind: "decision", decisionId: decision.id, transactionId: disputed, outcome: "cancelled" } });
    expect(back.line).toMatchObject({ amountMills: 0, disputed: true, claimedMills: 16_000 });
    expect(back.line).not.toHaveProperty("settled");
    expect(Number(back.total_mills)).toBe(0);
    // It is what a hand-in now would write: her draft says the same of the sale.
    const draft = shiftReportResponseSchema.parse((await asSession("anna", "GET", `/api/v1/shift-reports/${shift}`)).json());
    expect(draft.view!.lines.find((line) => line.transactionId === disputed)).toMatchObject({ amountMills: 0, claimedMills: 16_000, disputed: true });
    expect(draft.latest).toMatchObject({ version: 3, madeFor: "решение о продаже отменено" });
    // The ledger's feed serves it as the report's newest version.
    const fed = (await readShiftReportsFeed(app, { pageIds: [pageOne], limit: 500 })).reports.filter((one) => one.shiftId === shift).at(-1)!;
    expect(fed).toMatchObject({ version: 3, totalMills: 0, madeFor: { kind: "decision", decisionId: decision.id, outcome: "cancelled" } });
    // The home is the rule's again, and the claim waits for bella again, her matter open.
    expect(await homeOf(disputed)).toEqual({ home: "shift", reason: "holder", users: [bella] });
    expect(await claimOf(disputed)).toEqual([expect.objectContaining({ id: claim!.id, state: "asked", decision_id: null, closed_at: null })]);
    expect(await matter()).toBe("open");

    // The owner decides the dispute anew: bella's.
    const again = await asSession("boss", "POST", "/api/v1/sale-disputes/decide", { transactionId: disputed, outcome: "second" });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().versions).toEqual([{ shiftId: shift, version: 4 }]);
    expect((await newest(shift, disputed)).line).toMatchObject({ amountMills: 0, disputed: false, settled: "owner" });

    // A question the cancelled decision answered is open again.
    const about = await sale(pageOne, 5_000, 85);
    const question = await ask("one", { transactionId: about });
    const answer = (await decide("one", { transactionId: about, kind: "exclude", answers: question })).id;
    expect(await questionOf(question)).toMatchObject({ state: "decided", decision_id: answer });
    expect((await asKey("one", "POST", "/api/v1/agent/sale-decisions/cancel", { decisionId: answer, note: "ошибка", telegramUserId: WORDS.telegramUserId, sourceRef: WORDS.sourceRef })).statusCode).toBe(200);
    expect(await questionOf(question)).toEqual({ state: "owner", decision_id: null, closed_at: null });
  });

  it("keeps a new decision's shares when it replaces another: the reports follow the one that rules (3)", async (context) => {
    if (!testDb) return context.skip();
    const shift = await shiftRow(anna, 150);
    const disputed = await sale(pageOne, 20_000, 95);
    await say(shift, disputed, "мой");
    await submit(shift);
    const first = await decide("one", { transactionId: disputed, kind: "owner", shares: [{ person: "anna", percent: 100 }] });
    expect((await newest(shift, disputed)).line).toMatchObject({ amountMills: 20_000, settled: "owner" });
    const second = await decide("one", { transactionId: disputed, kind: "split", shares: [{ person: "anna", percent: 50 }, { person: "bella", percent: 50 }], supersedes: first.id });
    expect(second.versions).toEqual([{ shiftId: shift, version: 3 }]);
    expect((await newest(shift, disputed)).line).toMatchObject({ amountMills: 10_000, settled: "owner" });
    // The replacement cancelled: nothing rules but the rule — the first decision does not come back.
    const cancelled = await asKey("one", "POST", "/api/v1/agent/sale-decisions/cancel", { decisionId: second.id, note: "ошибка", telegramUserId: WORDS.telegramUserId, sourceRef: WORDS.sourceRef });
    expect(cancelled.json().versions).toEqual([{ shiftId: shift, version: 4 }]);
    expect(await decisionState(first.id)).toBe("superseded");
    expect((await newest(shift, disputed)).line).toMatchObject({ amountMills: 0, disputed: true, claimedMills: 20_000 });
    // The claim the first decision closed waits again as well: nothing decides the sale now.
    expect((await claimOf(disputed)).map((claim) => [claim.state, claim.decision_id])).toEqual([["asked", null]]);
  });

  it("raises the owner's matter when a cancel changes a report of a day the ledger paid (3)", async (context) => {
    if (!testDb) return context.skip();
    const shift = await shiftRow(anna, 174);
    const disputed = await sale(pageOne, 11_000, 100);
    await say(shift, disputed, "мой");
    await submit(shift);
    const decision = await decide("one", { transactionId: disputed, kind: "owner", shares: [{ person: "anna", percent: 100 }] });
    const day = (await q("select to_char(report_date, 'YYYY-MM-DD') as day from shift_handins where shift_id = $1", [shift])).rows[0].day as string;
    // The ledger paid anna's day in full.
    const ledger = await fakeLedger(async () => undefined, (url) => (url.pathname !== "/v1/payouts" ? null : {
      from: day, to: day, accrualFrom: "2026-11-02", generatedAt: new Date().toISOString(),
      people: [{
        slug: "anna", name: "anna", aliases: [], status: "active", days: [{ date: day, model: "mia", amountMicros: 11_000_000, worked: true, source: "hub" }],
        accruedMicros: 11_000_000, paidMicros: 11_000_000, balanceMicros: 0, toPayMicros: 0, oldestUnpaidDate: null, unpaidDays: [],
      }],
      checks: { stale: false, lastSheetsCollectAt: null, lastRebuildAt: null },
    }));
    if (!ledger) return context.skip();
    try {
      const cancelled = await asKey("one", "POST", "/api/v1/agent/sale-decisions/cancel", { decisionId: decision.id, note: "ошибка", telegramUserId: WORDS.telegramUserId, sourceRef: WORDS.sourceRef });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      expect(cancelled.json().versions).toEqual([{ shiftId: shift, version: 3 }]);
    } finally {
      await ledger.close();
    }
    const back = await newest(shift, disputed);
    expect(back).toMatchObject({ version: 3, day_paid: true });
    expect((await q("select state, owner_role, money from matters where reason_key = $1", [`shift.report.after_paid:${back.id}`])).rows).toEqual([
      { state: "open", owner_role: "owner", money: true },
    ]);
  });

  it("gives a decided share to its person whichever login their report is under (12)", async (context) => {
    if (!testDb) return context.skip();
    // bella has a second login, and her report under it holds her sale; the claim names the login she works under.
    await createUserAccount(app, { username: "bella-two", role: "chatter" }, { source: "cli" });
    const two = await fixtureUserId(app, "bella-two");
    await setUserPassword(app, { userId: two, password: "bella-two-password-for-tests" }, { source: "cli" });
    await insertPersonLogin(app.db, { personId: Number((await q("select person_id from person_logins where user_id = $1", [bella])).rows[0].person_id), userId: two, linkedByUserId: null });
    await assignUserToPage(app.db, two, pageOne);
    const login = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "bella-two", password: "bella-two-password-for-tests" } });
    const header = login.headers["set-cookie"];
    cookies["bella-two"] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    const hers = await shiftRow(two, 246);
    const sold = await sale(pageOne, 15_000, 120);
    await say(hers, sold, "мой фан", "bella-two");
    await submit(hers, "bella-two");
    expect((await newest(hers, sold)).line).toMatchObject({ amountMills: 15_000, disputed: false });
    // anna claims it; bella, under her working login, does not agree: the owner's dispute is anna against that login.
    const shift = await shiftRow(anna, 270);
    await say(shift, sold, "мой");
    await submit(shift);
    const claim = Number((await q("select id from sale_claims where transaction_id = $1 and side_user_id = $2", [sold, bella])).rows[0].id);
    const disagreed = await asSession("bella", "POST", `/api/v1/sale-claims/${claim}/answer`, { answer: "disagree", note: "фан мой" });
    expect(disagreed.statusCode, disagreed.body).toBe(200);
    // The owner: bella's. Her report keeps the sale under whichever login it was handed in; anna's counts nothing.
    const decided = await asSession("boss", "POST", "/api/v1/sale-disputes/decide", { transactionId: sold, outcome: "second" });
    expect(decided.statusCode, decided.body).toBe(200);
    expect((await q("select shares from sale_owner_decisions where transaction_id = $1 and state = 'active'", [sold])).rows[0].shares).toEqual([{ userId: bella, percent: 100 }]);
    expect((await newest(hers, sold)).line).toMatchObject({ amountMills: 15_000, disputed: false });
    expect((await newest(shift, sold)).line).toMatchObject({ amountMills: 0, disputed: false, settled: "owner" });
  });

  it("reads a handed-in report on one day everywhere, whatever the shift's day became after (11)", async (context) => {
    if (!testDb) return context.skip();
    // A shift that began at 23:00 and was handed in at 00:50, its day then the 8th; it went on to 01:10 and its day became the 9th.
    const shift = Number((await q(
      `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
       values ($1, 'closed', '2026-11-08T23:00:00+03:00', '2026-11-09T00:50:00+03:00', 110, 40, '2026-11-08', $2::jsonb) returning id`,
      [anna, JSON.stringify([{ pageLabel: "mia-1", activeMinutes: 110, messages: 40, salesFrom: "2026-11-08T20:00:00.000Z" }])],
    )).rows[0].id);
    const added = await asSession("anna", "POST", `/api/v1/shift-reports/${shift}/off-platform`, { amountMills: 20_000, fromWhom: "фан", whatFor: "кастом" });
    expect(added.statusCode, added.body).toBe(200);
    await submit(shift);
    await q("update shifts set ended_at = '2026-11-09T01:10:00+03:00', report_date = '2026-11-09' where id = $1", [shift]);
    const fed = async () => (await readShiftReportsFeed(app, { pageIds: [pageOne], limit: 500 })).reports.filter((one) => one.shiftId === shift).at(-1)!;
    expect((await fed()).reportDate).toBe("2026-11-08");
    // The post and the copy to «Отчётность» name the day the feed names.
    const report = shiftReportResponseSchema.parse((await asSession("anna", "GET", `/api/v1/shift-reports/${shift}`)).json());
    expect(report.posts[0]!.text).toContain("Дата: 08.11.2026");
    expect(report.shift.reportDate).toBe("2026-11-08");
    expect((await readHandinVersionPosts(app, { shiftId: shift, version: 1 }))?.reportDate).toBe("2026-11-08");
    // The owner confirms «мимо площадки»: the ledger is asked about the report's day, and the system's version stays on it.
    const asked: string[] = [];
    const ledger = await fakeLedger(async () => undefined, (url) => {
      asked.push(`${url.searchParams.get("from")}..${url.searchParams.get("to")}`);
      return null;
    });
    if (!ledger) return context.skip();
    try {
      const confirmed = await asSession("boss", "POST", `/api/v1/off-platform/${added.json().line.id}/decide`, { decision: "confirm", pageLabel: "mia-1" });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(asked).toEqual(["2026-11-08..2026-11-08"]);
      expect(await fed()).toMatchObject({ version: 2, reportDate: "2026-11-08" });
      // anna hands in again: the ledger is asked about the day the report is on; the new version takes the shift's day now.
      asked.length = 0;
      await submit(shift);
      expect(asked).toEqual(["2026-11-08..2026-11-08"]);
    } finally {
      await ledger.close();
    }
    expect(await fed()).toMatchObject({ version: 3, reportDate: "2026-11-09" });
    expect((await readHandinVersionPosts(app, { shiftId: shift, version: 3 }))?.reportDate).toBe("2026-11-09");
    expect((await readHandinVersionPosts(app, { shiftId: shift, version: 1 }))?.reportDate).toBe("2026-11-08");
  });

  it("names the page of a «Рядом» line the shift did not hold among the version's pages, not among the post's accounts (8)", async (context) => {
    if (!testDb) return context.skip();
    // anna's schedule puts her on mia-2 as well for the hours of a shift that held mia-1 alone; mia-2 had a sale then.
    const startedAt = Date.now() - 60 * HOUR_MS;
    const minute = Math.floor(((startedAt + 3 * HOUR_MS) % (24 * HOUR_MS)) / 60_000);
    const from = (minute - 60 + 1440) % 1440;
    await insertPersonScheduleSlot(app.db, {
      personId: Number((await q("select person_id from person_logins where user_id = $1", [anna])).rows[0].person_id),
      pageId: pageTwo, startMinute: from, endMinute: (from + 480) % 1440, weekdays: null, validFrom: null, createdByUserId: null,
    });
    const shift = await shiftRow(anna, 60);
    const near = await sale(pageTwo, 4_000, 58 * 60);
    await submit(shift);
    expect((await newest(shift, near)).line).toMatchObject({ group: "near", pageLabel: "mia-2", amountMills: 0 });
    // Every line's page is one of the version's pages, with nothing where nothing is counted: the ledger's own check.
    const fed = (await readShiftReportsFeed(app, { pageIds: [pageOne, pageTwo], limit: 500 })).reports.filter((one) => one.shiftId === shift).at(-1)!;
    expect(fed.lines.map((line) => line.pageLabel)).toEqual(["mia-2"]);
    expect(fed.pages).toEqual([{ pageLabel: "mia-1", amountMills: 0 }, { pageLabel: "mia-2", amountMills: 0 }]);
    expect(fed.totalMills).toBe(0);
    // The post lists the person's accounts as before.
    const report = shiftReportResponseSchema.parse((await asSession("anna", "GET", `/api/v1/shift-reports/${shift}`)).json());
    expect(report.posts[0]!.text).toContain("mia-1 - $0.00");
    expect(report.posts[0]!.text).not.toContain("mia-2");
  });
});
