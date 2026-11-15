import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { saleDisputeResponseSchema, shiftReportResponseSchema, type ShiftReportRow } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { runSaleClaims } from "../apps/runtime/src/services/sale-claims.ts";
import { refreshSaleHomes } from "../apps/runtime/src/services/sale-homes.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";
import { handInAndConfirm, editingSession } from "./helpers/shift-report-hand-in.ts";

// The board «Отчёт», round 2, the third reader (N4, N5, what he did not check). (N4) «Спросить» from «Правка» of a counted
// report stands, and a word on a sale «стык смен» never makes it the asker's without a decision. (N5) The decider sees
// the card of Gengar the person disagreed with; the person's row says the owner decides a question with no other side.
// After «Не согласен» with a card, «Отменить», «Исправить» and «Сдать заново» never give the sale back without the
// decider. The losing side of a decision reads whose the sale is. Money: required.
//
// anna and bella both work mia-1 from 23 to 18 hours ago («стык смен»); bella alone from 30 to 25.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HOUR_MS = 3_600_000;
const REVIEWER = `${AGENT_KEY_TOKEN_PREFIX}round2c-gengar-key`;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let pageOne = 0;
const users: Record<string, number> = {};
let refs = 0;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const rawSession = (who: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asSession = editingSession(rawSession as never) as typeof rawSession;

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

async function sale(minutesAgo: number): Promise<number> {
  refs += 1;
  const inserted = await q(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, 'tip', 'tip', 'posted', 'ok', 104000, 104000, 100000, 4000, now() - make_interval(mins => $3::int), 'fansly:rest', 'USD') returning id`,
    [pageOne, `tx-round2c-${refs}`, minutesAgo],
  );
  await refreshHomes();
  return Number(inserted.rows[0].id);
}

async function refreshHomes() {
  const now = new Date();
  await refreshSaleHomes(app.db, { from: new Date(now.getTime() - 48 * HOUR_MS), to: now, now });
}

const homeOf = async (transactionId: number) => (await q("select home from sale_homes where transaction_id = $1", [transactionId])).rows[0]?.home as string | undefined;
const claimsOf = async (transactionId: number) => (await q("select state from sale_claims where transaction_id = $1 and kind = 'claim' order by id", [transactionId])).rows.map((row) => row.state as string);

async function rowOf(who: string, shiftId: number, transactionId: number): Promise<ShiftReportRow | undefined> {
  const read = await rawSession(who, "GET", `/api/v1/shift-reports/${shiftId}`);
  expect(read.statusCode, read.body).toBe(200);
  return shiftReportResponseSchema.parse(read.json()).board?.columns.flatMap((column) => column.rows).find((row) => row.transactionId === transactionId);
}

async function counted(shiftId: number, transactionId: number): Promise<number> {
  const row = (await q(
    `select v.lines from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version where h.shift_id = $1`,
    [shiftId],
  )).rows[0] as { lines: Array<{ transactionId: number | null; amountMills: number }> } | undefined;
  return row?.lines.find((one) => one.transactionId === transactionId)?.amountMills ?? 0;
}

describe("the board «Отчёт», round 2, the third reader", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    users.boss = await fixtureUserId(app, "boss");
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageOne = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    for (const name of ["anna", "bella"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
      users[name] = await fixtureUserId(app, name);
      await setUserPassword(app, { userId: users[name]!, password: `${name}-password-for-tests` }, { source: "cli" });
      await assignUserToPage(app.db, users[name]!, pageOne);
    }
    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "anna", "bella"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    for (const name of ["anna", "bella"]) {
      const created = await rawSession("boss", "POST", "/api/v1/admin/people", {
        code: name, displayName: name, role: "chatter", state: "working", rights: ["submits_shift"], logins: { add: [users[name]] },
      });
      expect(created.statusCode, created.body).toBe(200);
    }
    await q("update person_rights set granted_at = now() - interval '30 days'");
    let base = 9_200_000_000;
    for (const [who, from, to] of [["anna", 23, 18], ["bella", 23, 18], ["bella", 30, 25]] as const) {
      await q(
        `insert into chatter_activity_minutes (user_id, page_id, minute, input)
         select $1, $2, minute, true from generate_series(date_trunc('minute', now() - make_interval(hours => $3::int)), date_trunc('minute', now() - make_interval(hours => $4::int)), interval '1 minute') minute
         on conflict do nothing`,
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

  it("keeps a question asked from «Правка» of a counted report, and never gives a sale «стык смен» to the asker without a decision (N4)", async (context) => {
    if (!testDb) return context.skip();
    const junction = await sale(20.5 * 60);
    expect(await homeOf(junction)).toBe("decide");
    const annas = await shiftRow("anna", 23.5, 17.5);
    await handInAndConfirm(asSession, "anna", annas);
    // «Исправить», then «Моя» on the junction sale.
    expect((await rawSession("anna", "POST", `/api/v1/shift-reports/${annas}/reopen`)).statusCode).toBe(200);
    const asked = await rawSession("anna", "POST", `/api/v1/shift-reports/${annas}/asks`, { transactionId: junction, statement: "mine", note: "мой фан" });
    expect(asked.statusCode, asked.body).toBe(200);
    expect(await claimsOf(junction)).toEqual(["owner"]);
    // «Сдать заново», «Подтверждаю», the hourly homes: still the owner's to decide.
    await handInAndConfirm(asSession, "anna", annas);
    await runSaleClaims(app);
    await refreshHomes();
    expect(await claimsOf(junction)).toEqual(["owner"]);
    expect(await homeOf(junction)).toBe("decide");
    expect(await counted(annas, junction)).toBe(0);
  });

  it("says whose the sale is on the losing side's row after a decision (P3)", async (context) => {
    if (!testDb) return context.skip();
    const junction = Number((await q("select transaction_id from sale_claims where kind = 'claim' order by id limit 1")).rows[0].transaction_id);
    const annas = Number((await q("select s.id from shifts s where s.user_id = $1 order by s.started_at limit 1", [users.anna])).rows[0].id);
    const bellas = await shiftRow("bella", 23.6, 17.4);
    await handInAndConfirm(asSession, "bella", bellas);
    const decided = await rawSession("boss", "POST", "/api/v1/sale-disputes/decide", { transactionId: junction, outcome: "give", shares: [{ userId: users.bella, percent: 100 }], note: null });
    expect(decided.statusCode, decided.body).toBe(200);
    const row = await rowOf("anna", annas, junction);
    expect(row?.amountMills).toBe(0);
    expect(row?.owner.kind).not.toBe("me");
  });

  it("shows the decider Gengar's card, keeps the owner's question the owner's, and gives nothing back without the decider (N5, «Не проверено»)", async (context) => {
    if (!testDb) return context.skip();
    await insertAgentKey(testDb.db, {
      name: "round2c-gengar", keyPrefix: REVIEWER.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(REVIEWER),
      capabilities: ["review:shift_reports"] as never, pageIds: [pageOne], expiresAt: new Date(Date.now() + 30 * 86_400_000), createdBy: users.boss!,
    });
    const own = await sale(27 * 60);
    const bellas = await shiftRow("bella", 30.5, 24.5);
    const handed = await rawSession("bella", "POST", `/api/v1/shift-reports/${bellas}/submit`);
    expect(handed.statusCode, handed.body).toBe(200);
    const candidateId = shiftReportResponseSchema.parse(handed.json()).board!.candidate!.id;
    const card = await server!.inject({
      method: "POST", url: `/api/v1/agent/shift-reports/checks/${candidateId}`, headers: { authorization: `Bearer ${REVIEWER}` },
      payload: { proposals: [{ transactionId: own, kind: "owner_change", to: { word: "give", userId: users.anna }, why: "Фан писал anna, это её продажа." }] },
    });
    expect(card.statusCode, card.body).toBe(200);
    const proposal = Number((await q("select id from shift_handin_proposals where candidate_id = $1", [candidateId])).rows[0].id);
    const declined = await rawSession("bella", "POST", `/api/v1/shift-reports/${bellas}/proposals/${proposal}/answer`, { answer: "decline", note: "фан писал в личку" });
    expect(declined.statusCode, declined.body).toBe(200);
    // The decider's window carries the card and the reason.
    const window = await rawSession("boss", "GET", `/api/v1/sale-disputes/${own}`);
    expect(window.statusCode, window.body).toBe(200);
    expect(window.body).toContain("Фан писал anna, это её продажа.");
    expect(saleDisputeResponseSchema.parse(window.json()).outcomes.length).toBeGreaterThan(0);
    // The row: the decider's question (no colleague was asked).
    expect((await rowOf("bella", bellas, own))?.ask?.to).toBe("owner");
    // «Отменить» does not take the disagreement back silently; «Подтверждаю», «Исправить», «Сдать заново» keep it waiting.
    expect((await rawSession("bella", "DELETE", `/api/v1/shift-reports/${bellas}/asks/${own}`)).statusCode).toBe(409);
    const shown = shiftReportResponseSchema.parse((await rawSession("bella", "GET", `/api/v1/shift-reports/${bellas}`)).json()).board!;
    const confirmed = await rawSession("bella", "POST", `/api/v1/shift-reports/${bellas}/confirm`, { candidateId, seenTotalMills: shown.totals.nowMills, seenCount: shown.totals.count });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    await runSaleClaims(app);
    expect(await counted(bellas, own)).toBe(0);
    expect((await rawSession("bella", "POST", `/api/v1/shift-reports/${bellas}/reopen`)).statusCode).toBe(200);
    expect((await rawSession("bella", "POST", `/api/v1/shift-reports/${bellas}/submit`)).statusCode).toBe(200);
    await runSaleClaims(app);
    expect(await claimsOf(own)).toEqual(["owner"]);
    const newest = (await q(
      `select c.lines from shift_handin_candidates c join shift_handins h on h.id = c.handin_id where h.shift_id = $1 order by c.id desc limit 1`, [bellas],
    )).rows[0].lines as Array<{ transactionId: number; amountMills: number }>;
    expect(newest.find((line) => line.transactionId === own)?.amountMills).toBe(0);
  });
});
