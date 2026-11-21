import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { shiftReportResponseSchema } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { runSaleClaims } from "../apps/runtime/src/services/sale-claims.ts";
import { refreshSaleHomes } from "../apps/runtime/src/services/sale-homes.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";
import { handInAndConfirm, editingSession } from "./helpers/shift-report-hand-in.ts";

// A take (owner, 2026-11-21): «Моя» / «Пополам с …» on a colleague's sale counts at once — no question, no day of
// silence. In the same request the sale is written to the one who said it, the colleague's handed-in report follows by
// a version, and the colleague's notice opens (three days, unanswered). «Не согласен» takes it to the decider and back
// to the rule's holder until the decision, the taker's line waiting; «Отменить» gives it back; a second person's word on
// a taken sale is the decider's and moves nothing. Money: whose report counts a sale.
//
// anna really works mia-1 from 30 to 25 hours ago (minutes and messages): the rule gives her the page's sales of those
// hours, and her report is handed in. bella and cora hand shifts in on the board too; their shift rows cover some of
// those hours with no work of theirs, so the sales lie on their boards as a colleague's («Рядом»).

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HOUR_MS = 3_600_000;
const NET = 100_000;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let pageOne = 0;
let anna = 0;
let bella = 0;
let cora = 0;
let worked = 0;
let refs = 0;
/** The first test's sale and bella's shift that took it: the second test disputes it. */
let taken = 0;
let takenBy = 0;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const rawSession = (who: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asSession = editingSession(rawSession);

/** A closed shift row of a person on mia-1 from `fromHoursAgo` to `toHoursAgo` before now. */
async function shiftRow(userId: number, fromHoursAgo: number, toHoursAgo: number): Promise<number> {
  const startedAt = new Date(Date.now() - fromHoursAgo * HOUR_MS);
  const endedAt = new Date(Date.now() - toHoursAgo * HOUR_MS);
  const result = await q(
    `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
     values ($1, 'closed', $2::timestamptz, $3::timestamptz, 55, 20, $4::date, $5::jsonb) returning id`,
    [userId, startedAt.toISOString(), endedAt.toISOString(), new Date(startedAt.getTime() + 3 * HOUR_MS).toISOString().slice(0, 10),
      JSON.stringify([{ pageLabel: "mia-1", activeMinutes: 55, messages: 20, salesFrom: startedAt.toISOString() }])],
  );
  return Number(result.rows[0].id);
}

/** A tip of mia-1 of $100.000 net `minutesAgo` before now, its home computed as the hourly job does. */
async function sale(minutesAgo: number): Promise<number> {
  refs += 1;
  const inserted = await q(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, 'tip', 'tip', 'posted', 'ok', $3, $3, $4, $5, now() - make_interval(mins => $6), 'fansly:rest', 'USD') returning id`,
    [pageOne, `tx-takes-${refs}`, NET + 4_000, NET, 4_000, minutesAgo],
  );
  const now = new Date();
  await refreshSaleHomes(app.db, { from: new Date(now.getTime() - 48 * HOUR_MS), to: now, now });
  return Number(inserted.rows[0].id);
}

/** The newest version of a shift's report: its number, why it was made, and its line of a sale. */
async function newest(shiftId: number, transactionId: number) {
  const row = (await q(
    `select v.version, v.made_for, v.lines from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version
     where h.shift_id = $1`,
    [shiftId],
  )).rows[0] as { version: number; made_for: Record<string, unknown> | null; lines: Array<Record<string, unknown>> } | undefined;
  return { version: row?.version ?? null, madeFor: row?.made_for ?? null, line: row?.lines.find((one) => one.transactionId === transactionId) ?? null };
}

async function claimOf(transactionId: number, claimantUserId: number) {
  return (await q(
    `select id::int as id, state, answer, escalated_why, origin, silence_at from sale_claims where transaction_id = $1 and claimant_user_id = $2`,
    [transactionId, claimantUserId],
  )).rows[0] as { id: number; state: string; answer: string | null; escalated_why: string | null; origin: string; silence_at: Date | null };
}

/** Whose the sale is by the rule now: the people of its home and why. */
async function homeNow(transactionId: number) {
  const row = (await q("select reason, shares from sale_homes where transaction_id = $1", [transactionId])).rows[0] as { reason: string; shares: Array<{ userId: number }> };
  return { reason: row.reason, people: row.shares.map((share) => Number(share.userId)) };
}

const matterState = async (key: string) => (await q("select state from matters where reason_key = $1", [key])).rows[0]?.state as string | undefined;

async function boardRow(who: string, shiftId: number, transactionId: number) {
  const read = await rawSession(who, "GET", `/api/v1/shift-reports/${shiftId}`);
  expect(read.statusCode, read.body).toBe(200);
  return shiftReportResponseSchema.parse(read.json()).board?.columns.flatMap((column) => column.rows).find((row) => row.transactionId === transactionId);
}

async function take(who: string, shiftId: number, body: Record<string, unknown>) {
  const said = await rawSession(who, "POST", `/api/v1/shift-reports/${shiftId}/asks`, { note: "общался я", ...body });
  expect(said.statusCode, said.body).toBe(200);
}

describe("a colleague's sale written to oneself counts at once", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    for (const name of ["anna", "bella", "cora"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
      await setUserPassword(app, { userId: await fixtureUserId(app, name), password: `${name}-password-for-tests` }, { source: "cli" });
    }
    anna = await fixtureUserId(app, "anna");
    bella = await fixtureUserId(app, "bella");
    cora = await fixtureUserId(app, "cora");
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageOne = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    for (const userId of [anna, bella, cora]) await assignUserToPage(app.db, userId, pageOne);
    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "anna", "bella", "cora"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    for (const [code, userId] of [["anna", anna], ["bella", bella], ["cora", cora]] as const) {
      const created = await asSession("boss", "POST", "/api/v1/admin/people", {
        code, displayName: code, role: "chatter", state: "working", rights: ["submits_shift"], logins: { add: [userId] },
      });
      expect(created.statusCode, created.body).toBe(200);
    }
    await q("update person_rights set granted_at = now() - interval '30 days'");
    // anna's work on mia-1: every minute of 30–25 hours ago, a message every three minutes.
    await q(
      `insert into chatter_activity_minutes (user_id, page_id, minute, input)
       select $1, $2, minute, true
       from generate_series(date_trunc('minute', now() - interval '30 hours'), date_trunc('minute', now() - interval '25 hours'), interval '1 minute') minute`,
      [anna, pageOne],
    );
    await q(
      `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
       select 'fansly', $1, (9800030000 + n)::text, '7700000088', $2, 'fansly-extension', false, false, now() - interval '30 hours' + interval '3 minutes' * n, 'hand'
       from generate_series(0, 99) n`,
      [pageOne, anna],
    );
    worked = await shiftRow(anna, 30.5, 24.5);
    await handInAndConfirm(asSession, "anna", worked);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("counts a take from the draft at once: the taker's draft, the side's handed-in report, the side's notice; no day of silence", async (context) => {
    if (!testDb) return context.skip();
    taken = await sale(29 * 60);
    await handInAndConfirm(asSession, "anna", worked);
    expect((await newest(worked, taken)).line).toMatchObject({ amountMills: NET });
    takenBy = await shiftRow(bella, 29.4, 28.6);
    await take("bella", takenBy, { transactionId: taken, statement: "mine" });

    // In the same request: settled for bella by her word alone, anna's counted report follows by a version.
    const claim = await claimOf(taken, bella);
    expect(claim).toMatchObject({ state: "agreed", answer: null, origin: "draft" });
    expect(claim.silence_at).not.toBeNull();
    const annas = await newest(worked, taken);
    expect(annas.line).toMatchObject({ amountMills: 0, disputed: false, settled: "agreed" });
    expect(annas.madeFor).toMatchObject({ kind: "claim", claimId: claim.id, outcome: "taken" });
    // The rule's home follows the take as it follows an agreement: told and not objecting, anna agrees («Смены» name no
    // difference between the rule and the two reports).
    expect(await homeNow(taken)).toEqual({ reason: "agreed", people: [bella] });
    expect(await boardRow("bella", takenBy, taken)).toMatchObject({ amountMills: NET, ticked: true, ask: { taken: true, state: "silence", answerBy: null } });
    // anna is told: her notice, and the row of her board waits for her «Понятно» or «Не согласен».
    expect(await matterState(`sale.claim:${claim.id}`)).toBe("open");
    const evidence = (await q("select evidence from matters where reason_key = $1", [`sale.claim:${claim.id}`])).rows[0].evidence as Record<string, unknown>;
    expect(evidence.answerBy).toBeUndefined();
    expect(await boardRow("anna", worked, taken)).toMatchObject({ amountMills: 0, attention: true, incoming: { taken: true, canAnswer: true, state: "settled" } });

    // bella hands in: her version counts it, settled.
    await handInAndConfirm(asSession, "bella", takenBy);
    expect((await newest(takenBy, taken)).line).toMatchObject({ amountMills: NET, disputed: false, settled: "agreed" });

    // No day of silence: a day on nothing moved and the notice is open; three days on it closes, the answer stays open.
    await runSaleClaims(app, new Date(Date.now() + 25 * HOUR_MS));
    expect(await claimOf(taken, bella)).toMatchObject({ state: "agreed", answer: null });
    expect(await matterState(`sale.claim:${claim.id}`)).toBe("open");
    await runSaleClaims(app, new Date(Date.now() + 73 * HOUR_MS));
    expect(await matterState(`sale.claim:${claim.id}`)).toBe("closed");
    expect((await newest(worked, taken)).line).toMatchObject({ amountMills: 0 });
    expect((await newest(takenBy, taken)).line).toMatchObject({ amountMills: NET });
  });

  it("brings the sale back to the rule's holder on «Не согласен»: the taker's line waits, both reports follow, the decider's matter opens", async (context) => {
    if (!testDb) return context.skip();
    const claim = await claimOf(taken, bella);
    const answered = await rawSession("anna", "POST", `/api/v1/sale-claims/${claim.id}/answer`, { answer: "disagree" });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(await claimOf(taken, bella)).toMatchObject({ state: "owner", answer: "disagree", escalated_why: "disagree" });
    // anna's report: hers by the rule again until the decision.
    const annas = await newest(worked, taken);
    expect(annas.line).toMatchObject({ amountMills: NET, disputed: false });
    expect(annas.line?.settled).toBeUndefined();
    expect(annas.madeFor).toMatchObject({ kind: "claim", outcome: "disputed" });
    // bella's report: her word waits for the decider, counting nothing, claiming the sale.
    expect((await newest(takenBy, taken)).line).toMatchObject({ amountMills: 0, disputed: true, claimedMills: NET });
    expect(await boardRow("bella", takenBy, taken)).toMatchObject({ amountMills: 0, ask: { state: "disputed" } });
    expect(await matterState(`sale.claim:${claim.id}`)).toBe("closed");
    expect((await q("select state, owner_role from matters where reason_key = $1", [`sale.dispute:${taken}`])).rows).toEqual([{ state: "open", owner_role: "owner" }]);
    // The home is the rule's own again, and the decider may leave it so («по правилу»).
    expect((await homeNow(taken)).people).toEqual([anna]);
    const window = await rawSession("boss", "GET", `/api/v1/sale-disputes/${taken}`);
    expect(window.statusCode, window.body).toBe(200);
    expect((window.json().outcomes as Array<{ outcome: string }>).map((one) => one.outcome)).toContain("rule");
  });

  it("counts a take of half at once: half in each report", async (context) => {
    if (!testDb) return context.skip();
    const shared = await sale(28 * 60);
    await handInAndConfirm(asSession, "anna", worked);
    expect((await newest(worked, shared)).line).toMatchObject({ amountMills: NET });
    const hers = await shiftRow(bella, 28.4, 27.6);
    await take("bella", hers, { transactionId: shared, statement: "share", shareWithUserId: anna });
    expect(await claimOf(shared, bella)).toMatchObject({ state: "agreed" });
    expect((await newest(worked, shared)).line).toMatchObject({ amountMills: NET / 2, settled: "agreed" });
    expect(await boardRow("bella", hers, shared)).toMatchObject({ amountMills: NET / 2, ask: { taken: true } });
    await handInAndConfirm(asSession, "bella", hers);
    expect((await newest(hers, shared)).line).toMatchObject({ amountMills: NET / 2, settled: "agreed" });
  });

  it("gives a take back on «Отменить»: the rule's holder counts it again, the taker nothing, the notice closes", async (context) => {
    if (!testDb) return context.skip();
    const back = await sale(27 * 60);
    await handInAndConfirm(asSession, "anna", worked);
    const hers = await shiftRow(bella, 27.4, 26.6);
    await take("bella", hers, { transactionId: back, statement: "mine" });
    const claim = await claimOf(back, bella);
    expect((await newest(worked, back)).line).toMatchObject({ amountMills: 0, settled: "agreed" });
    expect(await matterState(`sale.claim:${claim.id}`)).toBe("open");

    const undone = await rawSession("bella", "DELETE", `/api/v1/shift-reports/${hers}/asks/${back}`);
    expect(undone.statusCode, undone.body).toBe(200);
    expect(await claimOf(back, bella)).toMatchObject({ state: "withdrawn" });
    const annas = await newest(worked, back);
    expect(annas.line).toMatchObject({ amountMills: NET, disputed: false });
    expect(annas.line?.settled).toBeUndefined();
    expect(annas.madeFor).toMatchObject({ kind: "claim", outcome: "withdrawn" });
    expect(await boardRow("bella", hers, back)).toMatchObject({ amountMills: 0, ticked: false, ask: null });
    expect(await matterState(`sale.claim:${claim.id}`)).toBe("closed");
    expect((await homeNow(back)).people).toEqual([anna]);

    // Said again, it is a new take in the same row: counted at once, anna told again.
    await take("bella", hers, { transactionId: back, statement: "mine" });
    const again = await claimOf(back, bella);
    expect(again).toMatchObject({ id: claim.id, state: "agreed", answer: null });
    expect(again.silence_at).not.toBeNull();
    expect((await newest(worked, back)).line).toMatchObject({ amountMills: 0, settled: "agreed" });
    expect(await matterState(`sale.claim:${claim.id}`)).toBe("open");
  });

  it("sends a second person's word on a taken sale to the decider and moves nothing", async (context) => {
    if (!testDb) return context.skip();
    const twice = await sale(26 * 60);
    await handInAndConfirm(asSession, "anna", worked);
    const bellas = await shiftRow(bella, 26.4, 25.6);
    await take("bella", bellas, { transactionId: twice, statement: "mine" });
    const before = await newest(worked, twice);
    expect(before.line).toMatchObject({ amountMills: 0, settled: "agreed" });

    const coras = await shiftRow(cora, 26.3, 25.7);
    // cora's menu says the decider decides: nobody is told, nothing is written to her at once.
    const row = await boardRow("cora", coras, twice);
    expect(row?.choices?.find((one) => one.owner.kind === "me")?.asks).toMatchObject({ to: "decider" });
    await take("cora", coras, { transactionId: twice, statement: "mine" });

    expect(await claimOf(twice, cora)).toMatchObject({ state: "owner", escalated_why: "double" });
    expect(await claimOf(twice, bella)).toMatchObject({ state: "agreed", answer: null });
    // Nothing moved: anna's report has no new version, cora's word counts nothing.
    expect(await newest(worked, twice)).toMatchObject({ version: before.version, line: { amountMills: 0, settled: "agreed" } });
    expect(await boardRow("cora", coras, twice)).toMatchObject({ amountMills: 0, ask: { to: "owner" } });
    expect(await matterState(`sale.dispute:${twice}`)).toBe("open");
  });
});
