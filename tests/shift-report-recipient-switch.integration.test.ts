import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { shiftReportResponseSchema } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { refreshSaleHomes } from "../apps/runtime/src/services/sale-homes.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";
import { editingSession } from "./helpers/shift-report-hand-in.ts";

// The board's «пополам» and «отдать» name a colleague: a word that changes only its colleague is a new word (PR 1494
// review). From a colleague who hands in by the board to one who hands in the old way, the sale must go to the decider
// as it does on a first word, in both columns of the menu's matrix; a comment written alone keeps the word as it stands.
// Money: required.
//
// anna works mia-1 from 30 to 25 hours ago, so the rule gives her the page's sales of those hours. bella hands shifts
// in by the board; dina does not (the old way).

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
let dina = 0;
let worked = 0;
let refs = 0;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const rawSession = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asSession = editingSession(rawSession);

/** A tip of mia-1 of $100.000 net `minutesAgo` before now, its home computed as the hourly job does. */
async function sale(minutesAgo: number): Promise<number> {
  refs += 1;
  const inserted = await q(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, 'tip', 'tip', 'posted', 'ok', $3, $3, $4, $5, now() - make_interval(mins => $6), 'fansly:rest', 'USD') returning id`,
    [pageOne, `tx-switch-${refs}`, NET + 4_000, NET, 4_000, minutesAgo],
  );
  const now = new Date();
  await refreshSaleHomes(app.db, { from: new Date(now.getTime() - 48 * HOUR_MS), to: now, now });
  return Number(inserted.rows[0].id);
}

const word = (transactionId: number, body: Record<string, unknown>) => asSession("anna", "PUT", `/api/v1/shift-reports/${worked}/lines/${transactionId}`, body);

async function markOf(transactionId: number) {
  return (await q(
    `select m.statement, m.share_with_user_id::int as share_with, m.to_user_id::int as to_user, m.note from shift_handin_marks m
     join shift_handins h on h.id = m.handin_id where h.shift_id = $1 and m.transaction_id = $2`, [worked, transactionId])).rows[0];
}

/** The open questions about a sale, by whom they name. */
async function claimsOf(transactionId: number) {
  return (await q(
    "select side_user_id::int as side, state, escalated_why from sale_claims where transaction_id = $1 and state <> 'withdrawn' order by id",
    [transactionId])).rows;
}

describe("a word that changes only its colleague", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    for (const name of ["anna", "bella", "dina"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
      await setUserPassword(app, { userId: await fixtureUserId(app, name), password: `${name}-password-for-tests` }, { source: "cli" });
    }
    anna = await fixtureUserId(app, "anna");
    bella = await fixtureUserId(app, "bella");
    dina = await fixtureUserId(app, "dina");
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageOne = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    for (const userId of [anna, bella, dina]) await assignUserToPage(app.db, userId, pageOne);
    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "anna"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    // anna and bella hand their shifts in by the board; dina's switch is off.
    for (const [code, userId, rights] of [["anna", anna, ["submits_shift"]], ["bella", bella, ["submits_shift"]], ["dina", dina, []]] as const) {
      const created = await asSession("boss", "POST", "/api/v1/admin/people", {
        code, displayName: code, role: "chatter", state: "working", rights: [...rights], logins: { add: [userId] },
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
       select 'fansly', $1, (9820000000 + n)::text, '7700000088', $2, 'fansly-extension', false, false, now() - interval '30 hours' + interval '3 minutes' * n, 'hand'
       from generate_series(0, 99) n`,
      [pageOne, anna],
    );
    const startedAt = new Date(Date.now() - 30.5 * HOUR_MS);
    const endedAt = new Date(Date.now() - 24.5 * HOUR_MS);
    worked = Number((await q(
      `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
       values ($1, 'closed', $2::timestamptz, $3::timestamptz, 300, 100, $4::date, $5::jsonb) returning id`,
      [anna, startedAt.toISOString(), endedAt.toISOString(), new Date(startedAt.getTime() + 3 * HOUR_MS).toISOString().slice(0, 10),
        JSON.stringify([{ pageLabel: "mia-1", activeMinutes: 300, messages: 100, salesFrom: startedAt.toISOString() }])],
    )).rows[0].id);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("sends «пополам» to the decider when its colleague changes from one with the board to one without", async (context) => {
    if (!testDb) return context.skip();
    const shared = await sale(29 * 60);
    const first = await word(shared, { statement: "share", shareWithUserId: bella });
    expect(first.statusCode, first.body).toBe(200);
    expect(await claimsOf(shared)).toEqual([]);
    const second = await word(shared, { statement: "share", shareWithUserId: dina });
    expect(second.statusCode, second.body).toBe(200);
    expect(await markOf(shared)).toMatchObject({ statement: "share", share_with: dina });
    expect(await claimsOf(shared)).toEqual([{ side: dina, state: "owner", escalated_why: "no_side" }]);
    // The board offers the half with each colleague of the page, and says how each word is written.
    const read = shiftReportResponseSchema.parse((await rawSession("anna", "GET", `/api/v1/shift-reports/${worked}`)).json());
    const row = read.board?.columns.flatMap((column) => column.rows).find((one) => one.transactionId === shared);
    expect(row?.choices?.every((one) => one.via === "line")).toBe(true);
    expect(row?.choices?.find((one) => one.owner.kind === "share" && one.owner.userId === dina)?.asks).toMatchObject({ to: "decider" });
  });

  it("sends «отдать» to the decider when its colleague changes the same way: the person's «не моё», never a gift settled", async (context) => {
    if (!testDb) return context.skip();
    const given = await sale(28 * 60);
    const first = await word(given, { statement: "give", toUserId: bella });
    expect(first.statusCode, first.body).toBe(200);
    expect(await markOf(given)).toMatchObject({ statement: "give", to_user: bella });
    const second = await word(given, { statement: "give", toUserId: dina });
    expect(second.statusCode, second.body).toBe(200);
    expect(await markOf(given)).toMatchObject({ statement: "not_mine", to_user: null });
    expect(await claimsOf(given)).toEqual([{ side: dina, state: "owner", escalated_why: "no_side" }]);
  });

  it("writes a comment alone without touching the word or its question; a word without a comment keeps the comment", async (context) => {
    if (!testDb) return context.skip();
    const given = await sale(27 * 60);
    expect((await word(given, { statement: "give", toUserId: dina, note: "фан Дины" })).statusCode).toBe(200);
    const note = await word(given, { note: "фан Дины, договорились" });
    expect(note.statusCode, note.body).toBe(200);
    expect(await markOf(given)).toMatchObject({ statement: "not_mine", note: "фан Дины, договорились" });
    expect(await claimsOf(given)).toEqual([{ side: dina, state: "owner", escalated_why: "no_side" }]);
    expect((await word(given, { statement: "share", shareWithUserId: bella })).statusCode).toBe(200);
    expect(await markOf(given)).toMatchObject({ statement: "share", share_with: bella, note: "фан Дины, договорились" });
    expect(await claimsOf(given)).toEqual([]);
  });
});
