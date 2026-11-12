import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { shiftReportResponseSchema } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel, insertAgentKey, linkSaleDecision, type Database } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { refreshSaleHomes } from "../apps/runtime/src/services/sale-homes.ts";
import { submitShiftReport, type HandinPersonActor } from "../apps/runtime/src/services/shift-handins.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The third round of the final review of «чья продажа» and the shift report. (1) A «долёт» stays in its own report:
// the shift handed in again keeps the line, and a cancelled decision brings the report back to what the «долёт»
// counts — only ANOTHER report of the person takes it out of a draft. (2) Two hand-ins of one person in flight never
// both take one «долёт»: a hand-in reads the facts it writes in its own transaction, in the settlements' turn. (3) A
// «Привязать» that ties nothing (the decision was cancelled meanwhile) leaves the sale's active decision as it is.
// Money: required.
//
// anna really worked mia-1 from 30 to 25 hours ago (minutes and messages) and handed that shift in before any sale of
// those hours reached Hub. By the rule such a sale is hers, of a shift whose report does not hold it: a «долёт» for
// each of her later shifts, until a report of hers holds it.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HOUR_MS = 3_600_000;
const NET = 100_000;
const KEY = `${AGENT_KEY_TOKEN_PREFIX}review4-page-one-key`;
const WORDS = { saidBy: "владелец", saidAt: "2026-11-12", telegramUserId: 700_000_801, sourceRef: "https://t.me/c/1/40" };

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let pageOne = 0;
let anna = 0;
let worked = 0;
let refs = 0;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const asSession = (who: string, method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asKey = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${KEY}` }, ...(payload ? { payload } : {}) });

/** A closed shift row of anna on mia-1 from `fromHoursAgo` to `toHoursAgo` before now: the object a report is of. */
async function shiftRow(fromHoursAgo: number, toHoursAgo: number): Promise<number> {
  const startedAt = new Date(Date.now() - fromHoursAgo * HOUR_MS);
  const endedAt = new Date(Date.now() - toHoursAgo * HOUR_MS);
  const result = await q(
    `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
     values ($1, 'closed', $2::timestamptz, $3::timestamptz, 55, 20, $4::date, $5::jsonb) returning id`,
    [anna, startedAt.toISOString(), endedAt.toISOString(), new Date(startedAt.getTime() + 3 * HOUR_MS).toISOString().slice(0, 10),
      JSON.stringify([{ pageLabel: "mia-1", activeMinutes: 55, messages: 20, salesFrom: startedAt.toISOString() }])],
  );
  return Number(result.rows[0].id);
}

/** A tip of mia-1 of $100.000 net `minutesAgo` before now — in anna's worked hours; its home is what the rule gives it. */
async function sale(minutesAgo: number): Promise<number> {
  refs += 1;
  const inserted = await q(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, 'tip', 'tip', 'posted', 'ok', $3, $3, $4, $5, now() - make_interval(mins => $6), 'fansly:rest', 'USD') returning id`,
    [pageOne, `tx-review4-${refs}`, NET + 4_000, NET, 4_000, minutesAgo],
  );
  const now = new Date();
  await refreshSaleHomes(app.db, { from: new Date(now.getTime() - 48 * HOUR_MS), to: now, now });
  return Number(inserted.rows[0].id);
}

async function homeOf(transactionId: number) {
  const row = (await q("select home, reason, shares from sale_homes where transaction_id = $1", [transactionId])).rows[0] as
    { home: string; reason: string; shares: Array<{ userId: number; shiftId: number | null }> } | undefined;
  return row === undefined ? null : { home: row.home, reason: row.reason, shares: row.shares.map((share) => ({ userId: Number(share.userId), shiftId: share.shiftId })) };
}

async function submit(shiftId: number) {
  const submitted = await asSession("anna", "POST", `/api/v1/shift-reports/${shiftId}/submit`);
  expect(submitted.statusCode, submitted.body).toBe(200);
}

/** A decision «со слов» through the agent's door: its number and the report versions it made. */
async function decide(body: Record<string, unknown>): Promise<{ id: number; versions: Array<{ shiftId: number; version: number }> }> {
  const said = await asKey("POST", "/api/v1/agent/sale-decisions", { ...WORDS, ...body });
  expect(said.statusCode, said.body).toBe(200);
  return { id: said.json().decision.id as number, versions: said.json().versions };
}

/** A decision cancelled through the agent's door: the report versions it made. */
async function cancel(decisionId: number): Promise<Array<{ shiftId: number; version: number }>> {
  const cancelled = await asKey("POST", "/api/v1/agent/sale-decisions/cancel", { decisionId, note: "ошибка", telegramUserId: WORDS.telegramUserId, sourceRef: WORDS.sourceRef });
  expect(cancelled.statusCode, cancelled.body).toBe(200);
  return cancelled.json().versions;
}

/** The newest version of a shift's report, and its line of a sale. */
async function newest(shiftId: number, transactionId: number) {
  const row = (await q(
    `select v.version, v.total_mills::int as total, v.made_for, v.lines
     from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version where h.shift_id = $1`,
    [shiftId],
  )).rows[0] as { version: number; total: number; made_for: Record<string, unknown> | null; lines: Array<Record<string, unknown>> };
  return { ...row, line: row.lines.find((one) => one.transactionId === transactionId) };
}

const decisionState = async (id: number) => (await q("select state from sale_owner_decisions where id = $1", [id])).rows[0]?.state as string | undefined;

const annaAtWorkboard = (): HandinPersonActor => ({ kind: "person", userId: anna, role: "chatter", pageIds: [pageOne], door: "workboard" });

describe("«чья продажа» and the shift report, the final review's third round", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    await createUserAccount(app, { username: "anna", role: "chatter" }, { source: "cli" });
    anna = await fixtureUserId(app, "anna");
    await setUserPassword(app, { userId: anna, password: "anna-password-for-tests" }, { source: "cli" });
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageOne = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    await assignUserToPage(app.db, anna, pageOne);
    await insertAgentKey(testDb.db, {
      name: "review4-one", keyPrefix: KEY.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(KEY),
      capabilities: ["write:shift_reports", "read:team", "read:money"] as never, pageIds: [pageOne],
      expiresAt: new Date(Date.now() + 30 * 86_400_000), createdBy: await fixtureUserId(app, "boss"),
    });
    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "anna"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    const created = await asSession("boss", "POST", "/api/v1/admin/people", {
      code: "anna", displayName: "anna", role: "chatter", state: "working", rights: ["submits_shift"], logins: { add: [anna] },
    });
    expect(created.statusCode, created.body).toBe(200);
    await q("update person_rights set granted_at = now() - interval '30 days'");
    // anna's work on mia-1: every minute from 30 to 25 hours ago, a message every three minutes.
    await q(
      `insert into chatter_activity_minutes (user_id, page_id, minute, input)
       select $1, $2, minute, true
       from generate_series(date_trunc('minute', now() - interval '30 hours'), date_trunc('minute', now() - interval '25 hours'), interval '1 minute') minute`,
      [anna, pageOne],
    );
    await q(
      `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
       select 'fansly', $1, (9700000000 + n)::text, '7700000088', $2, 'fansly-extension', false, false, now() - interval '30 hours' + interval '3 minutes' * n, 'hand'
       from generate_series(0, 97) n`,
      [pageOne, anna],
    );
    // That shift's row, around the work so the rule's share names it — handed in now, before any sale of its hours.
    worked = await shiftRow(30.5, 24.5);
    await submit(worked);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("keeps a «долёт» in its report when the shift is handed in again (1)", async (context) => {
    if (!testDb) return context.skip();
    const late = await sale(27 * 60);
    // By the rule it is anna's, of the shift she handed in before it came: a «долёт» for a later shift of hers.
    expect(await homeOf(late)).toEqual({ home: "shift", reason: "holder", shares: [{ userId: anna, shiftId: worked }] });
    const shift = await shiftRow(20, 19);
    await submit(shift);
    const first = await newest(shift, late);
    expect(first.line).toMatchObject({ group: "mine", added: true, amountMills: NET, alreadyIn: null });
    expect(first).toMatchObject({ version: 1, total: NET });

    // Handed in again: the report's own «долёт» is still its line and counts the same.
    await submit(shift);
    const again = await newest(shift, late);
    expect(again.line).toMatchObject({ group: "mine", added: true, amountMills: NET, alreadyIn: null });
    expect(again).toMatchObject({ version: 2, total: NET });
    // Her screen says the same of it, and offers nothing new to hand in.
    const report = shiftReportResponseSchema.parse((await asSession("anna", "GET", `/api/v1/shift-reports/${shift}`)).json());
    expect(report.view!.lines.find((line) => line.transactionId === late)).toMatchObject({ added: true, amountMills: NET, alreadyIn: null });
    expect(report.afterSubmission).toBeNull();
  });

  it("brings a report's «долёт» back when the decision that took it away is cancelled (1)", async (context) => {
    if (!testDb) return context.skip();
    const late = await sale(27 * 60 - 5);
    const shift = await shiftRow(18, 17);
    await submit(shift);
    expect((await newest(shift, late)).line).toMatchObject({ added: true, amountMills: NET });
    // The owner's «никому», recorded through the door: the report counts nothing of the sale.
    const decision = await decide({ transactionId: late, kind: "exclude" });
    expect(decision.versions).toEqual([{ shiftId: shift, version: 2 }]);
    expect((await newest(shift, late)).line).toMatchObject({ amountMills: 0, disputed: false, settled: "owner" });

    // Cancelled: the report goes back to what rules now — the «долёт» it held, whole.
    expect(await cancel(decision.id)).toEqual([{ shiftId: shift, version: 3 }]);
    const back = await newest(shift, late);
    expect(back.line).toMatchObject({ group: "mine", added: true, amountMills: NET, disputed: false });
    expect(back.line).not.toHaveProperty("settled");
    expect(back).toMatchObject({ version: 3, total: NET, made_for: { kind: "decision", decisionId: decision.id, transactionId: late, outcome: "cancelled" } });
  });

  it("counts a «долёт» in one report only when two hand-ins of the person run at once (2)", async (context) => {
    if (!testDb) return context.skip();
    const late = await sale(27 * 60 - 10);
    const first = await shiftRow(16, 15);
    const second = await shiftRow(14, 13);
    // The hand-in of one shift waits for the ledger; meanwhile her other shift is handed in and takes the «долёт».
    await submitShiftReport(app, annaAtWorkboard(), { shiftId: first }, {
      dayPaid: async () => {
        await submit(second);
        return null;
      },
    });
    const [waited, between] = [await newest(first, late), await newest(second, late)];
    // The sale counts once: the report that was written first holds it, the one that waited does not take it again.
    expect(Number(waited.line?.amountMills ?? 0) + Number(between.line?.amountMills ?? 0)).toBe(NET);
    expect(between.line).toMatchObject({ added: true, amountMills: NET, alreadyIn: null });
    expect(waited.line).toBeUndefined();
    expect([waited.total, between.total]).toEqual([0, NET]);
  });

  it("changes nothing when «Привязать» ties a decision that is no longer active: the sale keeps its own (3)", async (context) => {
    if (!testDb) return context.skip();
    const sold = await sale(27 * 60 - 15);
    const shift = await shiftRow(12, 11);
    await submit(shift);
    // The sale's own decision, «никому»: active, and the report follows it.
    const ruling = await decide({ transactionId: sold, kind: "exclude" });
    expect(await newest(shift, sold)).toMatchObject({ version: 2, line: expect.objectContaining({ amountMills: 0, settled: "owner" }) });
    // Words that named no sale wait to be tied to one — and are cancelled through the agent's door before the owner ties them.
    const words = await decide({ pageLabel: "mia-1", fanRef: "fan-nine", kind: "owner", shares: [{ person: "anna", percent: 100 }] });
    expect((await q("select needs_link, state from sale_owner_decisions where id = $1", [words.id])).rows).toEqual([{ needs_link: true, state: "active" }]);
    await cancel(words.id);

    // In the write's own transaction — the cancel fell into «Привязать»'s wait for the ledger — nothing is written.
    const tied = await app.db.transaction(async (tx) => linkSaleDecision(tx as unknown as Database, { id: words.id, transactionId: sold, pageId: pageOne, at: new Date() }));
    expect(tied).toBe(false);
    expect(await decisionState(ruling.id)).toBe("active");
    // And «Привязать» refuses it before it writes: there is no such decision waiting for a sale.
    const refused = await asSession("boss", "POST", `/api/v1/sale-decisions/${words.id}/link`, { transactionId: sold });
    expect(refused.statusCode, refused.body).toBe(404);
    expect((await q("select id::int as id, state, transaction_id::int as sale from sale_owner_decisions where id = any($1::bigint[]) order by id", [[ruling.id, words.id]])).rows).toEqual([
      { id: ruling.id, state: "active", sale: sold },
      { id: words.id, state: "cancelled", sale: null },
    ]);
    expect(await newest(shift, sold)).toMatchObject({ version: 2, line: expect.objectContaining({ amountMills: 0, settled: "owner" }) });
  });
});
