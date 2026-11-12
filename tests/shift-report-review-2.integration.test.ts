import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { shiftReportResponseSchema } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel, insertAgentKey, insertSaleClaim } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { readAgentTeamSales } from "../apps/runtime/src/services/agent-team-sales.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { applyImport, planImport } from "../apps/runtime/src/services/sale-claims-import.ts";
import { runSaleClaims } from "../apps/runtime/src/services/sale-claims.ts";
import { readShiftReportsFeed } from "../apps/runtime/src/services/shift-handins.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Review round 2b of the shift report. (1) A report's date is the shift's date when it is handed in, not the date of
// its first mark: a night shift that crossed into the next day after the first mark is reported — and fed to the
// ledger — on the next day. (2) «Моё» on a sale the rule gives to someone else is NOT paid to both while it waits: the
// claimant's line says what is claimed and counts nothing in the page sums and the total until the claim is settled;
// the settlement's new version brings the settled share. (3) «Чья продажа» «со слов» has one home, Hub: a decision
// recorded through the agent's door behaves as the owner's decision of a dispute, reaches the ledger's facts, renders as
// the agent's memory file; an import copies no fan's name; a question nobody answered says so in its title. (4) The
// ledger's feed says which versions it held back for the key's pages. Money: required.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let pageOne = 0;
let pageTwo = 0;
let anna = 0;
let bella = 0;
let shiftB = 0;
let refs = 0;

const asSession = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const GENGAR = `${AGENT_KEY_TOKEN_PREFIX}review2-gengar-key`;
const asAgent = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${GENGAR}` }, ...(payload ? { payload } : {}) });
const SAID = { telegramUserId: 700_000_501, sourceRef: "https://t.me/c/1/2" };

async function insertShift(userId: number, startedAt: Date, endedAt: Date, reportDate: string): Promise<number> {
  const result = await testDb!.pool.query(
    `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
     values ($1, 'closed', $2::timestamptz, $3::timestamptz, 300, 200, $4::date, $5::jsonb) returning id`,
    [userId, startedAt.toISOString(), endedAt.toISOString(), reportDate, JSON.stringify([{ pageLabel: "mia-1", activeMinutes: 300, messages: 100, salesFrom: startedAt.toISOString() }])],
  );
  return Number(result.rows[0].id);
}

/** A sale of mia-1 `minutesAgo` before now and its home: bella's shift, or nobody's. */
async function sale(net: number, minutesAgo: number, home: "bella" | "nobody"): Promise<number> {
  refs += 1;
  const inserted = await testDb!.pool.query(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, 'tip', 'tip', 'posted', 'ok', $3, $3, $4, $5, now() - make_interval(mins => $6), 'fansly:rest', 'USD')
     returning id, occurred_at`,
    [pageOne, `tx-review2-${refs}`, net + 4_000, net, 4_000, minutesAgo],
  );
  const id = Number(inserted.rows[0].id);
  const shares = home === "nobody" ? [] : [{ userId: bella, workRef: null, shiftId: shiftB, percent: 100, mills: net }];
  await testDb!.pool.query(
    `insert into sale_homes (transaction_id, page_id, occurred_at, net_mills, home, reason, shares, rule_version, computed_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, 'test', now())`,
    [id, pageOne, inserted.rows[0].occurred_at, net, home === "nobody" ? "nobody" : "shift", home === "nobody" ? "no_holder" : "holder", JSON.stringify(shares)],
  );
  return id;
}

async function submit(shiftId: number) {
  const submitted = await asSession("anna", "POST", `/api/v1/shift-reports/${shiftId}/submit`);
  expect(submitted.statusCode, submitted.body).toBe(200);
  return shiftReportResponseSchema.parse(submitted.json());
}

/** The newest version the ledger's feed serves of a shift's report. */
async function fed(shiftId: number) {
  const feed = await readShiftReportsFeed(app, { pageIds: [pageOne], limit: 500 });
  return feed.reports.filter((one) => one.shiftId === shiftId).at(-1)!;
}

describe("the shift report, review round 2b", () => {
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
    await insertAgentKey(testDb.db, {
      name: "review2-gengar", keyPrefix: GENGAR.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(GENGAR),
      capabilities: ["write:shift_reports", "read:team", "read:money"] as never, pageIds: [pageOne],
      expiresAt: new Date(Date.now() + 30 * 86_400_000), createdBy: await fixtureUserId(app, "boss"),
    });
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
    await testDb.pool.query("update person_rights set granted_at = now() - interval '30 days'");
    anna = await fixtureUserId(app, "anna");
    bella = await fixtureUserId(app, "bella");
    const now = Date.now();
    shiftB = await insertShift(bella, new Date(now - 5 * 3_600_000), new Date(now - 10 * 60_000), new Date(now).toISOString().slice(0, 10));
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("dates a night shift's report by the shift at hand-in, not by its first mark (1)", async (context) => {
    if (!testDb) return context.skip();
    // A night shift begun 22:30 Moscow; its first word at 23:40, while the shift was still the day it began.
    const day = "2026-11-08";
    const night = await insertShift(anna, new Date(`${day}T22:30:00+03:00`), new Date(`${day}T23:40:00+03:00`), day);
    expect((await asSession("anna", "PUT", `/api/v1/shift-reports/${night}/comment`, { comment: "ночь" })).statusCode).toBe(200);
    // The shift ran to 03:00: by the ledger's rule its report date is the next day now.
    await testDb.pool.query("update shifts set ended_at = $2::timestamptz, report_date = '2026-11-09' where id = $1", [night, "2026-11-09T03:00:00+03:00"]);
    await submit(night);
    expect((await fed(night)).reportDate).toBe("2026-11-09");
    const handin = await testDb.pool.query("select to_char(report_date, 'YYYY-MM-DD') as day from shift_handins where shift_id = $1", [night]);
    expect(handin.rows[0].day).toBe("2026-11-09");
    const list = await asSession("anna", "GET", "/api/v1/shift-reports?from=2026-11-08&to=2026-11-09");
    expect(list.json().shifts.find((one: { shiftId: number }) => one.shiftId === night)).toMatchObject({ reportDate: "2026-11-09", state: "submitted" });
  });

  it("counts a disputed «моё» nowhere until it is settled, and says what is claimed (2)", async (context) => {
    if (!testDb) return context.skip();
    const shift = await insertShift(anna, new Date(Date.now() - 30 * 3_600_000), new Date(Date.now() - 25 * 3_600_000), new Date(Date.now() - 27 * 3_600_000).toISOString().slice(0, 10));
    const own = await sale(10_000, 50, "nobody");
    const disputed = await sale(16_001, 60, "bella");
    for (const [id, note] of [[own, "ничья, моя"], [disputed, "мой фан"]] as const) {
      expect((await asSession("anna", "PUT", `/api/v1/shift-reports/${shift}/lines/${id}`, { statement: "mine", note })).statusCode).toBe(200);
    }
    // The draft: the line stays, says the claim, counts nothing.
    const draft = shiftReportResponseSchema.parse((await asSession("anna", "GET", `/api/v1/shift-reports/${shift}`)).json()).view!;
    expect(draft.lines.find((line) => line.transactionId === disputed)).toMatchObject({ amountMills: 0, claimedMills: 16_001, disputed: true });
    expect(draft.totalMills).toBe(10_000);

    const handed = await submit(shift);
    expect(handed.latest?.totalMills).toBe(10_000);
    expect(handed.posts.map((post) => post.text).join("\n")).toContain("Спорно, ждёт решения: $16.00");
    // The ledger reads the same: the page is its counted lines, the disputed line counts nothing and says the claim.
    const first = await fed(shift);
    expect(first.totalMills).toBe(10_000);
    expect(first.pages).toEqual([{ pageLabel: "mia-1", amountMills: 10_000 }]);
    expect(first.lines.find((line) => line.transactionId === disputed)).toMatchObject({ amountMills: 0, claimedMills: 16_001, disputed: true });
    // The claim stands on it: bella is asked.
    const claim = await testDb.pool.query("select state from sale_claims where transaction_id = $1", [disputed]);
    expect(claim.rows).toEqual([{ state: "asked" }]);

    // The owner gives it to anna: the settlement's version brings it.
    const decided = await asSession("boss", "POST", "/api/v1/sale-disputes/decide", { transactionId: disputed, outcome: "first" });
    expect(decided.statusCode, decided.body).toBe(200);
    const settled = await fed(shift);
    expect(settled.totalMills).toBe(26_000);
    expect(settled.lines.find((line) => line.transactionId === disputed)).toMatchObject({ amountMills: 16_001, disputed: false, settled: "owner" });
  });
  it("records a decision «со слов» as the owner's own: the reports, the claim, the matter, the ledger's facts (3b, 5)", async (context) => {
    if (!testDb) return context.skip();
    const shift = await insertShift(anna, new Date(Date.now() - 54 * 3_600_000), new Date(Date.now() - 49 * 3_600_000), new Date(Date.now() - 51 * 3_600_000).toISOString().slice(0, 10));
    const disputed = await sale(20_000, 70, "bella");
    expect((await asSession("anna", "PUT", `/api/v1/shift-reports/${shift}/lines/${disputed}`, { statement: "mine", note: "мой фан" })).statusCode).toBe(200);
    await submit(shift);
    expect((await testDb.pool.query("select state from sale_claims where transaction_id = $1", [disputed])).rows).toEqual([{ state: "asked" }]);
    // The owner said it in the chat: anna's. Gengar records it through the door.
    const said = await asAgent("POST", "/api/v1/agent/sale-decisions", {
      transactionId: disputed, kind: "owner", shares: [{ person: "anna", percent: 100 }], saidBy: "владелец", saidAt: "2026-11-12", note: "фан её", ...SAID,
    });
    expect(said.statusCode, said.body).toBe(200);
    expect(said.json().decision).toMatchObject({ kind: "owner", source: "agent", status: "held", transactionId: disputed });
    // Exactly as the owner's decision of the dispute: the report's new version, the claim decided, its matter closed.
    const line = (await fed(shift)).lines.find((one) => one.transactionId === disputed);
    expect(line).toMatchObject({ amountMills: 20_000, disputed: false, settled: "owner" });
    expect((await testDb.pool.query("select state, decision_id is not null as decided from sale_claims where transaction_id = $1", [disputed])).rows).toEqual([{ state: "decided", decided: true }]);
    expect((await testDb.pool.query("select state from matters where kind = 'sale.claim' and evidence ->> 'transactionId' = $1", [String(disputed)])).rows).toEqual([{ state: "closed" }]);
    // A second decision on the sale must name the first.
    expect((await asAgent("POST", "/api/v1/agent/sale-decisions", {
      transactionId: disputed, kind: "exclude", saidBy: "владелец", saidAt: "2026-11-12", ...SAID,
    })).json().reason).toBe("decision_exists");

    // A nobody's sale given to anna «со слов»: the ledger's facts carry it as the owner's split.
    const nobody = await sale(9_000, 75, "nobody");
    expect((await asAgent("POST", "/api/v1/agent/sale-decisions", {
      transactionId: nobody, kind: "owner", shares: [{ person: "anna", percent: 100 }], saidBy: "Аня и Боря", saidAt: "2026-11-12", ...SAID,
    })).statusCode).toBe(200);
    const excluded = await sale(5_000, 80, "nobody");
    expect((await asAgent("POST", "/api/v1/agent/sale-decisions", { transactionId: excluded, kind: "exclude", saidBy: "владелец", saidAt: "2026-11-12", ...SAID })).statusCode).toBe(200);
    const facts = await readAgentTeamSales(app.db, { from: new Date(Date.now() - 3 * 3_600_000), to: new Date(), now: new Date(), pages: [{ id: pageOne, label: "mia-1" }] });
    const factOf = (id: number) => facts.sales.find((one) => one.transactionRef === String(id));
    expect(factOf(nobody)?.resolution).toEqual([{ userId: anna, percent: 100 }]);
    expect(factOf(nobody)?.decision).toEqual({ kind: "split", pot: null });
    expect(factOf(excluded)).toMatchObject({ resolution: null, decision: { kind: "nobody", pot: null } });

    // The memory file's list: what the ledger's --md gave, no fan's name copied.
    const md = await asAgent("GET", "/api/v1/agent/sale-decisions?format=md");
    expect(md.statusCode, md.body).toBe(200);
    expect(md.json().markdown).toContain(`Продажа ${nobody}, нетто $9.00`);
    expect(md.json().markdown).toContain("Вся продажа — anna. Источник: Аня и Боря, 2026-11-12, https://t.me/c/1/2. Статус: открыто, ждёт отчёта.");
    expect(md.json().markdown).toContain("Не считается никому");
  });

  it("imports no fan's name, and titles a question nobody answered as one (3c, 6)", async (context) => {
    if (!testDb) return context.skip();
    const id = await sale(7_000, 90, "nobody");
    const rows = (columns: string[], values: unknown[][]) => ({ columns, rows: values });
    const plan = await planImport(app.db, {
      decisions: rows(["id", "page_label", "fan_ref", "fan_name", "transaction_ref", "net_micros", "kind", "shares", "said_by", "said_at", "note", "status"],
        [[901, "mia-1", "fan-ref-1", "Имя Фана", String(id), 7_000_000, "owner", JSON.stringify([{ person: "anna", percent: 100 }]), "владелец", "2026-11-11", "Имя Фана купил", "open"]]),
      questions: rows(["id", "page_label", "fan_ref", "fan_name", "transaction_ref", "net_micros", "question", "asked_of", "who", "asked_at", "status"], []),
    });
    await applyImport(app.db, plan, new Date());
    await applyImport(app.db, plan, new Date());
    const imported = await testDb.pool.query("select ledger_ref from sale_owner_decisions where ledger_decision_id = 901");
    expect(imported.rows).toHaveLength(1);
    expect(JSON.stringify(imported.rows[0].ledger_ref)).not.toContain("Имя Фана");

    // A question asked of the chatters on the 5th that nobody answered: the owner's, titled as what it is.
    const asked = await sale(16_000, 95, "bella");
    await insertSaleClaim(app.db, {
      transactionId: asked, pageId: pageOne, kind: "imported", claimantUserId: anna, claimantHandinId: null, claimantVersion: null, statement: null,
      shareWithUserId: null, claimantNote: null, claimedAt: new Date("2026-11-05T12:00:00+03:00"), sideUserId: bella, sideShiftId: null,
      state: "owner", escalatedAt: new Date(), escalatedWhy: "imported", ledgerQuestionId: 77, question: "Имя Фана купил ппв: чья?",
      whoText: "anna и bella", ledgerRef: { pageLabel: "mia-1", askedOf: "chatters" },
    }, new Date());
    await runSaleClaims(app);
    const title = (await testDb.pool.query("select title from matters where reason_key = $1", [`sale.dispute:${asked}`])).rows[0].title as string;
    expect(title).toMatch(/^Вопрос чаттерам без ответа с 5 нояб\.: mia-1, \$16\.00, /u);
    expect(title).toContain("anna и bella");
    expect(title).not.toContain("Имя Фана");
  });

  it("lists a version held back for the key's pages on every read, and serves it once the key may read it (4)", async (context) => {
    if (!testDb) return context.skip();
    const key = Number((await testDb.pool.query("select id from agent_keys where name = 'review2-gengar'")).rows[0].id);
    const shift = await insertShift(anna, new Date(Date.now() - 80 * 3_600_000), new Date(Date.now() - 75 * 3_600_000), new Date(Date.now() - 77 * 3_600_000).toISOString().slice(0, 10));
    const start = (await readShiftReportsFeed(app, { pageIds: [pageOne], limit: 500, agentKeyId: key })).next;
    // A version with a line of mia-2, a page the ledger's key does not hold.
    const handin = await testDb.pool.query(
      `insert into shift_handins (shift_id, user_id, person_id, report_date, state, current_version, submitted_at)
       values ($1, $2, (select person_id from person_logins where user_id = $2), current_date, 'submitted', 1, now()) returning id`,
      [shift, anna],
    );
    const version = Number((await testDb.pool.query(
      `insert into shift_handin_versions (handin_id, version, door, actor_user_id, total_mills, lines, rule_version)
       values ($1, 1, 'workboard', $2, 1000, $3::jsonb, 'test') returning id`,
      [handin.rows[0].id, anna, JSON.stringify([{
        transactionId: 1, offPlatformId: null, group: "mine", pageLabel: "mia-2", kind: "tip", occurredAt: null, netMills: 1000,
        rule: { home: "shift", reason: "holder", shareMills: 1000, toUserId: null, senderUserId: null }, alreadyIn: null,
        statement: null, shareWithUserId: null, note: null, amountMills: 1000, added: false, disputed: false,
      }])],
    )).rows[0].id);
    const first = await readShiftReportsFeed(app, { pageIds: [pageOne], since: start, limit: 500, agentKeyId: key });
    expect(first.reports.some((one) => one.id === version)).toBe(false);
    expect(first.held).toEqual([expect.objectContaining({ id: version, shiftId: shift, person: "anna", reason: "page_outside_key", pageLabels: ["mia-2"] })]);
    const place = first.held[0]!.seq;
    expect(place).toBeGreaterThan(Number(start));
    // The cursor passed it: it is still listed on the next read.
    const second = await readShiftReportsFeed(app, { pageIds: [pageOne], since: first.next, limit: 500, agentKeyId: key });
    expect(second.held.map((one) => one.id)).toEqual([version]);
    // The key may read mia-2 now: served once, at its own place, the cursor not moved back.
    const third = await readShiftReportsFeed(app, { pageIds: [pageOne, pageTwo], since: second.next, limit: 500, agentKeyId: key });
    expect(third.reports.map((one) => [one.id, one.seq])).toEqual([[version, place]]);
    expect(third.held).toEqual([]);
    expect(third.next).toBe(second.next);
    expect((await readShiftReportsFeed(app, { pageIds: [pageOne, pageTwo], since: third.next, limit: 500, agentKeyId: key })).reports).toEqual([]);
  });
});
