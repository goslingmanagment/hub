import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { shiftReportResponseSchema, type ShiftReportRow } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { runSaleClaims } from "../apps/runtime/src/services/sale-claims.ts";
import { refreshSaleHomes } from "../apps/runtime/src/services/sale-homes.ts";
import { readShiftReport, type HandinPersonActor } from "../apps/runtime/src/services/shift-handins.ts";
import { confirmShiftReport } from "../apps/runtime/src/services/shift-report-board.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";
import { handInAndConfirm, editingSession } from "./helpers/shift-report-hand-in.ts";

// The board «Отчёт», the final review's third reader. (3) A question from the draft on a sale «стык смен, решит
// владелец» makes it nobody's until it is decided: it never counts for the one who asked meanwhile. (4) Two people who
// take the same sale from a third are never both given the whole of it: one settlement per sale. (5) «Генгар молчит 10
// минут» holds: the report moves to «Подтвердите» when it is due, on read and on «Подтверждаю». (6) «Не согласен» with
// Gengar's card reaches whoever decides the sale, and the sale waits meanwhile. (7) Who decides, and who decided, is
// each sale's own. (8) A PPV row reads as the site's Wallet does: «Media Sale to …». Money: required.
//
// mia-1 is led by lena. anna works mia-1 from 30 to 25 hours ago alone; anna and bella both work it from 23 to 18 hours
// ago (a sale of those hours is «стык смен»); cora works it from 16 to 11 hours ago.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HOUR_MS = 3_600_000;
const NET = 100_000;
const REVIEWER = `${AGENT_KEY_TOKEN_PREFIX}review6-gengar-key`;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let pageOne = 0;
let modelId = 0;
const users: Record<string, number> = {};
let refs = 0;
let junctionSale = 0;
let junctionShift = 0;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const rawSession = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asSession = editingSession(rawSession);
const asReviewer = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${REVIEWER}` }, ...(payload ? { payload } : {}) });
const actorOf = (who: string): HandinPersonActor => ({ kind: "person", userId: users[who]!, role: "chatter", pageIds: [pageOne], door: "workboard" });

/** A closed shift row of a person on mia-1 from `fromHoursAgo` to `toHoursAgo` before now. */
async function shiftRow(who: string, fromHoursAgo: number, toHoursAgo: number): Promise<number> {
  const startedAt = new Date(Date.now() - fromHoursAgo * HOUR_MS);
  const endedAt = new Date(Date.now() - toHoursAgo * HOUR_MS);
  const result = await q(
    `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
     values ($1, 'closed', $2::timestamptz, $3::timestamptz, 55, 20, $4::date, $5::jsonb) returning id`,
    [users[who], startedAt.toISOString(), endedAt.toISOString(), new Date(startedAt.getTime() + 3 * HOUR_MS).toISOString().slice(0, 10),
      JSON.stringify([{ pageLabel: "mia-1", activeMinutes: 55, messages: 20, salesFrom: startedAt.toISOString() }])],
  );
  return Number(result.rows[0].id);
}

/** A sale of mia-1 of $100.000 net `minutesAgo` before now: a tip, or a PPV (`message_purchase`). */
async function sale(minutesAgo: number, kind: "tip" | "message_purchase" = "tip"): Promise<number> {
  refs += 1;
  const inserted = await q(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, $3, $7, 'posted', 'ok', $4, $4, $5, 4000, now() - make_interval(mins => $6::int), 'fansly:rest', 'USD') returning id`,
    [pageOne, `tx-review6-${refs}`, kind, NET + 4_000, NET, minutesAgo, kind],
  );
  await refreshHomes();
  return Number(inserted.rows[0].id);
}

async function refreshHomes() {
  const now = new Date();
  await refreshSaleHomes(app.db, { from: new Date(now.getTime() - 48 * HOUR_MS), to: now, now });
}

async function homeOf(transactionId: number) {
  const row = (await q("select home, shares from sale_homes where transaction_id = $1", [transactionId])).rows[0] as
    { home: string; shares: Array<{ userId: number }> } | undefined;
  return row === undefined ? null : { home: row.home, users: row.shares.map((share) => Number(share.userId)) };
}

/** What the newest version of a shift's report counts of a sale (0 — no line). */
async function counted(shiftId: number, transactionId: number): Promise<number> {
  const row = (await q(
    `select v.lines from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version where h.shift_id = $1`,
    [shiftId],
  )).rows[0] as { lines: Array<{ transactionId: number | null; amountMills: number }> } | undefined;
  return row?.lines.find((one) => one.transactionId === transactionId)?.amountMills ?? 0;
}

async function board(who: string, shiftId: number) {
  const read = await rawSession(who, "GET", `/api/v1/shift-reports/${shiftId}`);
  expect(read.statusCode, read.body).toBe(200);
  return shiftReportResponseSchema.parse(read.json()).board!;
}
const rowOf = (shown: Awaited<ReturnType<typeof board>>, transactionId: number): ShiftReportRow | undefined =>
  shown.columns.flatMap((column) => column.rows).find((row) => row.transactionId === transactionId);

async function ask(who: string, shiftId: number, transactionId: number) {
  const asked = await rawSession(who, "POST", `/api/v1/shift-reports/${shiftId}/asks`, { transactionId, statement: "mine", note: "мой фан" });
  expect(asked.statusCode, asked.body).toBe(200);
}

describe("the board «Отчёт», the final review's third reader", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    users.boss = await fixtureUserId(app, "boss");
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    modelId = model!.id;
    pageOne = (await createFanslyPage(app.db, { modelId, label: "mia-1" }))!.id;
    for (const [name, role] of [["anna", "chatter"], ["bella", "chatter"], ["cora", "chatter"], ["lena", "team_lead"]] as const) {
      await createUserAccount(app, role === "team_lead" ? { username: name, role, password: `${name}-password-for-tests` } : { username: name, role }, { source: "cli" });
      users[name] = await fixtureUserId(app, name);
      await setUserPassword(app, { userId: users[name]!, password: `${name}-password-for-tests` }, { source: "cli" });
      await assignUserToPage(app.db, users[name]!, pageOne);
    }
    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "anna", "bella", "cora", "lena"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    for (const name of ["anna", "bella", "cora", "lena"]) {
      const created = await asSession("boss", "POST", "/api/v1/admin/people", {
        code: name, displayName: name, role: name === "lena" ? "team_lead" : "chatter", state: "working",
        rights: name === "lena" ? [] : ["submits_shift"], logins: { add: [users[name]] },
      });
      expect(created.statusCode, created.body).toBe(200);
    }
    await q("update person_rights set granted_at = now() - interval '30 days'");
    // lena leads mia: two chatters' «чья продажа» is hers to decide; the pot and «стык смен» stay the owner's.
    await q("insert into team_roles (person_id, model_id, kind) select p.id, $1, 'lead' from people p where p.code = 'lena'", [modelId]);
    // The work: every minute of the hours, a message every three minutes.
    let base = 9_700_000_000;
    for (const [who, from, to] of [["anna", 30, 25], ["anna", 23, 18], ["bella", 23, 18], ["cora", 16, 11]] as const) {
      await q(
        `insert into chatter_activity_minutes (user_id, page_id, minute, input)
         select $1, $2, minute, true
         from generate_series(date_trunc('minute', now() - make_interval(hours => $3::int)), date_trunc('minute', now() - make_interval(hours => $4::int)), interval '1 minute') minute`,
        [users[who], pageOne, from, to],
      );
      await q(
        `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
         select 'fansly', $1, ($4::bigint + n)::text, '7700000088', $2, 'fansly-extension', false, false, now() - make_interval(hours => $3::int) + interval '3 minutes' * n, 'hand'
         from generate_series(0, ($3::int - $5::int) * 20 - 1) n`,
        [pageOne, users[who], from, base, to],
      );
      base += 1_000;
    }
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("keeps a sale «стык смен» nobody's while a question from the draft waits: the total does not move (3)", async (context) => {
    if (!testDb) return context.skip();
    junctionSale = await sale(20.5 * 60);
    expect(await homeOf(junctionSale)).toMatchObject({ home: "decide" });
    junctionShift = await shiftRow("anna", 23.5, 17.5);
    const before = await board("anna", junctionShift);
    await ask("anna", junctionShift, junctionSale);
    await refreshHomes();
    const after = await board("anna", junctionShift);
    expect(rowOf(after, junctionSale)?.amountMills).toBe(0);
    expect(after.totals.nowMills).toBe(before.totals.nowMills);
    expect(await homeOf(junctionSale)).toMatchObject({ home: "decide" });
    // Handed in, it still counts nothing until it is decided.
    await handInAndConfirm(asSession, "anna", junctionShift);
    await refreshHomes();
    expect(await counted(junctionShift, junctionSale)).toBe(0);
  });

  it("names each sale's own decider: the pot and «стык смен» are the owner's, and «решил …» is the decision's author (7)", async (context) => {
    if (!testDb) return context.skip();
    // anna's question on the junction sale waits for the owner, though lena leads the model.
    expect(JSON.stringify(rowOf(await board("anna", junctionShift), junctionSale))).not.toContain("lena");
    const decided = await rawSession("boss", "POST", "/api/v1/sale-disputes/decide", { transactionId: junctionSale, outcome: "first", note: "её фан" });
    expect(decided.statusCode, decided.body).toBe(200);
    const row = rowOf(await board("anna", junctionShift), junctionSale);
    expect(row?.reasonWords).toBe("решил владелец");
  });

  it("gives a sale two people took from a third to one of them, never the whole to each (4)", async (context) => {
    if (!testDb) return context.skip();
    const taken = await sale(13 * 60);
    expect(await homeOf(taken)).toMatchObject({ users: [users.cora] });
    const coras = await shiftRow("cora", 16.5, 10.5);
    await handInAndConfirm(asSession, "cora", coras);
    const annas = await shiftRow("anna", 14, 12);
    const bellas = await shiftRow("bella", 14.1, 11.9);
    for (const [who, shiftId] of [["anna", annas], ["bella", bellas]] as const) {
      await ask(who, shiftId, taken);
      await handInAndConfirm(asSession, who, shiftId);
    }
    await runSaleClaims(app);
    await runSaleClaims(app, new Date(Date.now() + 25 * HOUR_MS));
    const total = await counted(coras, taken) + await counted(annas, taken) + await counted(bellas, taken);
    expect(total).toBeLessThanOrEqual(NET);
    const states = (await q("select state from sale_claims where transaction_id = $1 and kind = 'claim' order by id", [taken])).rows.map((row) => row.state as string);
    expect(states.filter((state) => state === "agreed")).toHaveLength(1);
  });

  it("reads a PPV as the site's Wallet does: «Media Sale to» (8)", async (context) => {
    if (!testDb) return context.skip();
    const ppv = await sale(27 * 60, "message_purchase");
    const annas = await shiftRow("anna", 30.5, 24.5);
    expect(rowOf(await board("anna", annas), ppv)?.siteWords).toBe("Media Sale to");
  });

  it("moves the report to «Подтвердите» when Gengar's 10 minutes are up, on read and on «Подтверждаю» (5)", async (context) => {
    if (!testDb) return context.skip();
    await insertAgentKey(testDb.db, {
      name: "review6-gengar", keyPrefix: REVIEWER.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(REVIEWER),
      capabilities: ["review:shift_reports"] as never, pageIds: [pageOne], expiresAt: new Date(Date.now() + 30 * 86_400_000), createdBy: users.boss!,
    });
    await sale(29 * 60);
    const shift = await shiftRow("anna", 30.4, 24.6);
    const handed = await rawSession("anna", "POST", `/api/v1/shift-reports/${shift}/submit`);
    expect(handed.statusCode, handed.body).toBe(200);
    const candidateId = shiftReportResponseSchema.parse(handed.json()).board!.candidate!.id;
    expect(shiftReportResponseSchema.parse(handed.json()).board?.phase).toBe("checking");
    const later = new Date(Date.now() + 11 * 60_000);
    // Read eleven minutes later, no pass in between: the board says «Подтвердите» and «Подтверждаю» goes through.
    expect((await readShiftReport(app, actorOf("anna"), shift, later)).board?.phase).toBe("confirm");
    const answer = await confirmShiftReport(app, actorOf("anna"), { shiftId: shift, candidateId }, { now: new Date(later.getTime() + 1_000) });
    expect(answer.refused).toBeNull();
    expect(answer.confirmed).toBe(true);
  });

  it("takes «Не согласен» with Gengar's card to whoever decides the sale, and the sale waits meanwhile (6)", async (context) => {
    if (!testDb) return context.skip();
    const own = await sale(26 * 60);
    expect(await homeOf(own)).toMatchObject({ users: [users.anna] });
    const shift = await shiftRow("anna", 26.5, 25.2);
    const handed = await rawSession("anna", "POST", `/api/v1/shift-reports/${shift}/submit`);
    expect(handed.statusCode, handed.body).toBe(200);
    const candidateId = shiftReportResponseSchema.parse(handed.json()).board!.candidate!.id;
    const card = await asReviewer("POST", `/api/v1/agent/shift-reports/checks/${candidateId}`, {
      proposals: [{ transactionId: own, kind: "owner_change", to: { word: "pot" }, why: "Фан написал, что это за пост." }],
    });
    expect(card.statusCode, card.body).toBe(200);
    const proposal = Number((await q("select id from shift_handin_proposals where candidate_id = $1", [candidateId])).rows[0].id);
    expect((await board("anna", shift)).phase).toBe("confirm");
    const declined = await rawSession("anna", "POST", `/api/v1/shift-reports/${shift}/proposals/${proposal}/answer`, { answer: "decline", note: "это мой фан, писал в личку" });
    expect(declined.statusCode, declined.body).toBe(200);
    // The pot is the owner's: his matter opens with the card and anna's reason.
    const matters = (await q("select kind, owner_role, evidence from matters where state = 'open' and (evidence ->> 'transactionId')::bigint = $1", [own])).rows as
      Array<{ kind: string; owner_role: string | null; evidence: Record<string, unknown> }>;
    expect(matters.map((one) => ({ kind: one.kind, owner_role: one.owner_role }))).toContainEqual({ kind: "sale.dispute", owner_role: "owner" });
    expect(JSON.stringify(matters)).toContain("это мой фан, писал в личку");
    // Until it is decided the sale waits: «Подтверждаю» counts the rest.
    const shown = await board("anna", shift);
    expect(rowOf(shown, own)?.amountMills).toBe(0);
    const confirmed = await rawSession("anna", "POST", `/api/v1/shift-reports/${shift}/confirm`, { candidateId, seenTotalMills: shown.totals.nowMills, seenCount: shown.totals.count });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(await counted(shift, own)).toBe(0);
  });
});
