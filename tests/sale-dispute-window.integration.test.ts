import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { saleDisputeResponseSchema, shiftReportResponseSchema, type SaleDisputeResponse } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { runSaleClaims } from "../apps/runtime/src/services/sale-claims.ts";
import { refreshSaleHomes } from "../apps/runtime/src/services/sale-homes.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";
import { handInAndConfirm, editingSession, insertReviewerAgentKey } from "./helpers/shift-report-hand-in.ts";

// The decider's window of a disputed sale (review round 2, the third reader: N1–N3). A button names the person it gives
// the sale to, and the decision gives it to that person — whoever asked first, in whatever order the database keeps the
// questions. The sides are one computation for the window and the decision: everyone who asked, whoever holds the sale
// by the rule now, whoever's counted report counts it. A sale «стык смен» may go to either shift or in halves; a sale of
// the pot may stay in the pot. Money: required.
//
// anna and bella both work mia-1 from 23 to 18 hours ago (a sale of those hours is «стык смен»); cora from 30 to 25.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HOUR_MS = 3_600_000;
const NET = 100_000;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let pageOne = 0;
const users: Record<string, number> = {};
let refs = 0;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const rawSession = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asSession = editingSession(rawSession);

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

async function sale(minutesAgo: number, postTip = false): Promise<number> {
  refs += 1;
  const ref = `tx-window-${refs}`;
  const inserted = await q(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency, correlation_id)
     values ($1, $2, 'tip', 'tip', 'posted', 'ok', $3, $3, $4, 4000, now() - make_interval(mins => $5::int), 'fansly:rest', 'USD', $6) returning id, occurred_at`,
    [pageOne, ref, NET + 4_000, NET, minutesAgo, postTip ? `post-tip-${ref}` : null],
  );
  if (postTip) {
    await q(
      `insert into creator_post_tips (account_id, platform, platform_post_id, platform_tip_id, tip_sender_platform_user_id, post_tip_amount_mills,
         occurred_at, first_observed_at, last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
       values ($1, 'fansly', 'post-window', $2, '7700000099', $3, $4, $4, $4, repeat('f', 64), 1, 1, $5)`,
      [pageOne, `post-tip-${ref}`, NET + 4_000, inserted.rows[0].occurred_at, refs],
    );
  }
  const now = new Date();
  await refreshSaleHomes(app.db, { from: new Date(now.getTime() - 48 * HOUR_MS), to: now, now });
  return Number(inserted.rows[0].id);
}

async function ask(who: string, shiftId: number, transactionId: number) {
  const asked = await rawSession(who, "POST", `/api/v1/shift-reports/${shiftId}/asks`, { transactionId, statement: "mine", note: "мой фан" });
  expect(asked.statusCode, asked.body).toBe(200);
}

async function windowOf(transactionId: number): Promise<SaleDisputeResponse> {
  const read = await rawSession("boss", "GET", `/api/v1/sale-disputes/${transactionId}`);
  expect(read.statusCode, read.body).toBe(200);
  return saleDisputeResponseSchema.parse(read.json());
}

/** Presses a button of the window as Workboard does: what the button carries, nothing else. */
async function press(transactionId: number, shown: SaleDisputeResponse, button: SaleDisputeResponse["outcomes"][number]) {
  const carried = button as typeof button & { shares?: Array<{ userId: number; percent: number }> };
  const pressed = await rawSession("boss", "POST", "/api/v1/sale-disputes/decide", {
    transactionId, outcome: button.outcome, note: null,
    ...(carried.shares !== undefined && carried.shares.length > 0 ? { shares: carried.shares, seenSides: shown.parties.map((one) => one.userId) } : {}),
  });
  expect(pressed.statusCode, pressed.body).toBe(200);
}

const decisionOf = async (transactionId: number) => (await q(
  "select kind, shares, pot from sale_owner_decisions where transaction_id = $1 and state = 'active'", [transactionId],
)).rows[0] as { kind: string; shares: Array<{ userId: number; percent: number }>; pot: string | null } | undefined;

async function counted(shiftId: number, transactionId: number): Promise<number> {
  const row = (await q(
    `select v.lines from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version where h.shift_id = $1`,
    [shiftId],
  )).rows[0] as { lines: Array<{ transactionId: number | null; amountMills: number }> } | undefined;
  return row?.lines.find((one) => one.transactionId === transactionId)?.amountMills ?? 0;
}

describe("the decider's window of a disputed sale", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    users.boss = await fixtureUserId(app, "boss");
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageOne = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    for (const name of ["anna", "bella", "cora"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
      users[name] = await fixtureUserId(app, name);
      await setUserPassword(app, { userId: users[name]!, password: `${name}-password-for-tests` }, { source: "cli" });
      await assignUserToPage(app.db, users[name]!, pageOne);
    }
    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "anna", "bella", "cora"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    for (const name of ["anna", "bella", "cora"]) {
      const created = await asSession("boss", "POST", "/api/v1/admin/people", {
        code: name, displayName: name, role: "chatter", state: "working", rights: ["submits_shift"], logins: { add: [users[name]] },
      });
      expect(created.statusCode, created.body).toBe(200);
    }
    await q("update person_rights set granted_at = now() - interval '30 days'");
    let base = 9_300_000_000;
    for (const [who, from, to] of [["anna", 23, 18], ["bella", 23, 18], ["cora", 30, 25]] as const) {
      await q(
        `insert into chatter_activity_minutes (user_id, page_id, minute, input)
         select $1, $2, minute, true from generate_series(date_trunc('minute', now() - make_interval(hours => $3::int)), date_trunc('minute', now() - make_interval(hours => $4::int)), interval '1 minute') minute`,
        [users[who], pageOne, from, to],
      );
      await q(
        `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
         select 'fansly', $1, ($4::bigint + n)::text, '7700000088', $2, 'fansly-extension', false, false, now() - make_interval(hours => $3::int) + interval '3 minutes' * n, 'hand'
         from generate_series(0, 99) n`,
        [pageOne, users[who], from, base],
      );
      base += 1_000;
    }
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("gives the sale to the person its button names when two asked about one pot sale (N1)", async (context) => {
    if (!testDb) return context.skip();
    const pot = await sale(14 * 60, true);
    // anna asks first, bella second: both questions are the owner's (the pot's).
    await ask("anna", await shiftRow("anna", 14.5, 13.5), pot);
    await ask("bella", await shiftRow("bella", 14.6, 13.4), pot);
    const shown = await windowOf(pot);
    expect(shown.parties.map((one) => one.userId).sort()).toEqual([users.anna, users.bella].sort());
    const annas = shown.outcomes.find((one) => one.label === "anna: целиком");
    expect(annas).toBeDefined();
    await press(pot, shown, annas!);
    expect((await decisionOf(pot))?.shares).toEqual([{ userId: users.anna, percent: 100 }]);
  });

  it("accepts only one concurrent decision or dismissal for an open question", async (context) => {
    if (!testDb) return context.skip();
    const transactionId = await sale(10 * 60);
    await q(`insert into sale_claims (transaction_id, page_id, kind, state, asked_of, question, claimed_at)
      values ($1, $2, 'question', 'owner', 'owner', 'Fixture question', now())`, [transactionId, pageOne]);
    const decide = (outcome: string) => rawSession("boss", "POST", "/api/v1/sale-disputes/decide", { transactionId, outcome, note: null });
    const results = await Promise.all([decide("dismiss"), decide("nobody")]);
    expect(results.map((one) => one.statusCode).sort(), results.map((one) => one.body).join("\n")).toEqual([200, 409]);
    expect((await q("select state from sale_claims where transaction_id = $1", [transactionId])).rows).toEqual([{ state: "decided" }]);
  });

  it("lets a sale of the pot stay in the pot (N2)", async (context) => {
    if (!testDb) return context.skip();
    const pot = await sale(12 * 60, true);
    await ask("anna", await shiftRow("anna", 12.5, 11.5), pot);
    const shown = await windowOf(pot);
    const stays = shown.outcomes.find((one) => one.label === "Остаётся в общаке");
    expect(stays).toBeDefined();
    await press(pot, shown, stays!);
    expect(await decisionOf(pot)).toMatchObject({ kind: "pot" });
  });

  it("keeps a submitted mine statement on a junction in the owner's dispute queue", async (context) => {
    if (!testDb) return context.skip();
    const junction = await sale(20 * 60);
    const shift = await shiftRow("anna", 23.5, 17.5);
    const word = await asSession("anna", "PUT", `/api/v1/shift-reports/${shift}/lines/${junction}`, { statement: "mine", note: "fixture claim" });
    expect(word.statusCode, word.body).toBe(200);
    await handInAndConfirm(asSession, "anna", shift);
    await runSaleClaims(app);
    expect(await counted(shift, junction)).toBe(0);
    expect((await windowOf(junction)).claims).toContainEqual(expect.objectContaining({ state: "owner", statement: "mine" }));
  });

  it("lets a sale «стык смен» go to the other shift or in halves (N2)", async (context) => {
    if (!testDb) return context.skip();
    const junction = await sale(20.5 * 60);
    const annas = await shiftRow("anna", 23.5, 17.5);
    const bellas = await shiftRow("bella", 23.6, 17.4);
    await ask("anna", annas, junction);
    await handInAndConfirm(asSession, "anna", annas);
    await handInAndConfirm(asSession, "bella", bellas);
    const shown = await windowOf(junction);
    expect(shown.outcomes.map((one) => one.label)).toContain("bella: целиком");
    const halves = shown.outcomes.find((one) => one.label.startsWith("Пополам"));
    expect(halves).toBeDefined();
    await press(junction, shown, halves!);
    expect((await decisionOf(junction))?.shares.map((one) => one.percent)).toEqual([50, 50]);
    expect(await counted(annas, junction) + await counted(bellas, junction)).toBe(NET);
  });

  it("knows who holds the sale after the first of two takers settled with the holder (N3)", async (context) => {
    if (!testDb) return context.skip();
    const taken = await sale(27 * 60);
    const coras = await shiftRow("cora", 30.5, 24.5);
    await handInAndConfirm(asSession, "cora", coras);
    const annas = await shiftRow("anna", 28, 26);
    const bellas = await shiftRow("bella", 28.1, 25.9);
    for (const [who, shiftId] of [["anna", annas], ["bella", bellas]] as const) {
      await ask(who, shiftId, taken);
      await handInAndConfirm(asSession, who, shiftId);
    }
    await runSaleClaims(app);
    const toCora = (await q("select id::int as id from sale_claims where transaction_id = $1 and claimant_user_id = $2", [taken, users.anna])).rows[0].id as number;
    expect((await rawSession("cora", "POST", `/api/v1/sale-claims/${toCora}/answer`, { answer: "agree" })).statusCode).toBe(200);
    expect(await counted(annas, taken)).toBe(NET);
    // bella's question is the decider's now: the window names anna, who holds it, and can leave it with her.
    const shown = await windowOf(taken);
    expect(shown.parties.map((one) => one.userId)).toContain(users.anna);
    const annasButton = shown.outcomes.find((one) => one.label === "anna: целиком");
    expect(annasButton).toBeDefined();
    await press(taken, shown, annasButton!);
    expect([await counted(annas, taken), await counted(bellas, taken), await counted(coras, taken)]).toEqual([NET, 0, 0]);
  });

  // Round 3 (1): «Оставить по правилу» after a settlement — the sale was a take (counted for the one who said it at
  // once), the side said «Не согласен» — puts every report holding the sale back to what the rule gives its person, once.
  it("leaves the reports as the rule has them after «Оставить по правилу» of a sale a take had settled (round 3, 1)", async (context) => {
    if (!testDb) return context.skip();
    const ruled = await sale(29.5 * 60);
    const coras = Number((await q("select id from shifts where user_id = $1 order by started_at limit 1", [users.cora])).rows[0].id);
    const annas = await shiftRow("anna", 29.8, 29.2);
    await ask("anna", annas, ruled);
    await handInAndConfirm(asSession, "anna", annas);
    await handInAndConfirm(asSession, "cora", coras);
    await runSaleClaims(app);
    expect([await counted(annas, ruled), await counted(coras, ruled)]).toEqual([NET, 0]);
    const claimId = Number((await q("select id from sale_claims where transaction_id = $1 and claimant_user_id = $2", [ruled, users.anna])).rows[0].id);
    const disagreed = await rawSession("cora", "POST", `/api/v1/sale-claims/${claimId}/answer`, { answer: "disagree", note: "мой фан" });
    expect(disagreed.statusCode, disagreed.body).toBe(200);
    const shown = await windowOf(ruled);
    const rule = shown.outcomes.find((one) => one.label === "Оставить по правилу");
    expect(rule).toBeDefined();
    await press(ruled, shown, rule!);
    // The rule gives it to cora whole: her report counts it, anna's nothing — and cora's next hand-in does not double it.
    expect([await counted(annas, ruled), await counted(coras, ruled)]).toEqual([0, NET]);
    await handInAndConfirm(asSession, "cora", coras);
    expect(await counted(annas, ruled) + await counted(coras, ruled)).toBe(NET);
  });

  it("only closes the questions by «Оставить по правилу» when no report was settled (round 3, 1)", async (context) => {
    if (!testDb) return context.skip();
    const plain = await sale(29.3 * 60);
    const annas = Number((await q("select id from shifts where user_id = $1 and started_at < now() - interval '29 hours' order by started_at desc limit 1", [users.anna])).rows[0].id);
    expect((await rawSession("anna", "POST", `/api/v1/shift-reports/${annas}/reopen`)).statusCode).toBe(200);
    await ask("anna", annas, plain);
    const claimId = Number((await q("select id from sale_claims where transaction_id = $1", [plain])).rows[0].id);
    expect((await rawSession("cora", "POST", `/api/v1/sale-claims/${claimId}/answer`, { answer: "disagree", note: "мой фан" })).statusCode).toBe(200);
    const versions = async () => Number((await q("select count(*)::int as n from shift_handin_versions")).rows[0].n);
    const before = await versions();
    const shown = await windowOf(plain);
    await press(plain, shown, shown.outcomes.find((one) => one.label === "Оставить по правилу")!);
    expect(await versions()).toBe(before);
    expect((await q("select state from sale_claims where id = $1", [claimId])).rows[0].state).toBe("decided");
  });

  // Round 3 (2): a sale with a decided question and a new one — the window's button is the decision's. The earlier asker
  // was decided against (her report counts nothing): the window still names her, by her decided question.
  it("accepts the window's button on a sale with an earlier decided question and a new one (round 3, 2)", async (context) => {
    if (!testDb) return context.skip();
    const contested = await sale(29.6 * 60);
    const annas = Number((await q("select id from shifts where user_id = $1 and started_at < now() - interval '29 hours' order by started_at desc limit 1", [users.anna])).rows[0].id);
    const coras = Number((await q("select id from shifts where user_id = $1 order by started_at limit 1", [users.cora])).rows[0].id);
    await ask("anna", annas, contested);
    await handInAndConfirm(asSession, "anna", annas);
    await handInAndConfirm(asSession, "cora", coras);
    await runSaleClaims(app);
    const annasClaim = Number((await q("select id from sale_claims where transaction_id = $1 and claimant_user_id = $2", [contested, users.anna])).rows[0].id);
    expect((await rawSession("cora", "POST", `/api/v1/sale-claims/${annasClaim}/answer`, { answer: "disagree", note: "мой фан" })).statusCode).toBe(200);
    const first = await windowOf(contested);
    await press(contested, first, first.outcomes.find((one) => one.label === "cora: целиком")!);
    expect(await counted(annas, contested)).toBe(0);
    // A third person says «моё» now: on a decided sale it is the decider's at once (one take per sale), nobody is told.
    const bellas = await shiftRow("bella", 29.9, 29.1);
    await ask("bella", bellas, contested);
    expect((await q("select state, escalated_why from sale_claims where transaction_id = $1 and claimant_user_id = $2", [contested, users.bella])).rows)
      .toEqual([{ state: "owner", escalated_why: "double" }]);
    const shown = await windowOf(contested);
    expect(shown.parties.map((one) => one.userId)).toContain(users.anna);
    const bellasButton = shown.outcomes.find((one) => one.label === "bella: целиком");
    expect(bellasButton).toBeDefined();
    await press(contested, shown, bellasButton!);
    expect((await decisionOf(contested))?.shares).toEqual([{ userId: users.bella, percent: 100 }]);
  });

  // Round 3 (1), the other order: the person said «Не согласен» to Gengar's card, her line waited and was counted at $0;
  // «Оставить по правилу» gives her what the rule gives — the sale whole — in her counted report. (Last: a reviewing key
  // makes every later hand-in wait for its check.)
  it("gives the person her sale back in her counted report after «Оставить по правилу» of a card she disagreed with (round 3, 1)", async (context) => {
    if (!testDb) return context.skip();
    const reviewer = `${AGENT_KEY_TOKEN_PREFIX}window-gengar-key`;
    await insertReviewerAgentKey(testDb.db, {
      name: "window-gengar", token: reviewer, pageIds: [pageOne], createdBy: users.boss!,
    });
    const own = await sale(28.5 * 60);
    const coras = Number((await q("select id from shifts where user_id = $1 order by started_at limit 1", [users.cora])).rows[0].id);
    expect((await rawSession("cora", "POST", `/api/v1/shift-reports/${coras}/reopen`)).statusCode).toBe(200);
    const handed = await rawSession("cora", "POST", `/api/v1/shift-reports/${coras}/submit`);
    expect(handed.statusCode, handed.body).toBe(200);
    const candidateId = shiftReportResponseSchema.parse(handed.json()).board!.candidate!.id;
    const card = await server!.inject({
      method: "POST", url: `/api/v1/agent/shift-reports/checks/${candidateId}`, headers: { authorization: `Bearer ${reviewer}` },
      payload: { proposals: [{ transactionId: own, kind: "owner_change", to: { word: "give", userId: users.anna }, why: "Фан писал anna." }] },
    });
    expect(card.statusCode, card.body).toBe(200);
    const proposal = Number((await q("select id from shift_handin_proposals where candidate_id = $1", [candidateId])).rows[0].id);
    expect((await rawSession("cora", "POST", `/api/v1/shift-reports/${coras}/proposals/${proposal}/answer`, { answer: "decline", note: "это мой фан" })).statusCode).toBe(200);
    const board = shiftReportResponseSchema.parse((await rawSession("cora", "GET", `/api/v1/shift-reports/${coras}`)).json()).board!;
    expect(board.phase).toBe("confirm");
    const confirmed = await rawSession("cora", "POST", `/api/v1/shift-reports/${coras}/confirm`, { candidateId, seenTotalMills: board.totals.nowMills, seenCount: board.totals.count });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(await counted(coras, own)).toBe(0);
    // The decider: «Оставить по правилу» — the rule gives it to cora whole.
    const shown = await windowOf(own);
    const rule = shown.outcomes.find((one) => one.label === "Оставить по правилу");
    expect(rule).toBeDefined();
    expect(rule!.gives.find((one) => one.userId === users.cora)?.mills).toBe(NET);
    await press(own, shown, rule!);
    expect(await counted(coras, own)).toBe(NET);
    expect((await q("select state from sale_claims where transaction_id = $1 and claimant_user_id = $2", [own, users.cora])).rows.map((row) => row.state)).toEqual(["decided"]);
  });
});

