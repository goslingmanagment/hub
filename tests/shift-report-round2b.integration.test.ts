import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { shiftReportResponseSchema } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel, insertAgentKey, insertSaleClaim } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { runSaleClaims } from "../apps/runtime/src/services/sale-claims.ts";
import { refreshSaleHomes } from "../apps/runtime/src/services/sale-homes.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { waitForRowLockWait } from "./helpers/lock-waits.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";
import { handInAndConfirm, editingSession } from "./helpers/shift-report-hand-in.ts";

// The board «Отчёт», round 2, the second reader. (B5) The old «после сдачи» counter counts a sale the counted report
// holds only as a $0 line with nothing on it, as the board does. (B4) A phase is moved only from the phase it was read
// in: «Досдать» that lost the race to «Исправить» makes nothing. (B3) A sale two people hold in halves, taken by a
// third, is never counted for more than itself. (B1) A sale of the pot is never settled between two chatters, its home
// stored or not. (B2) «Не согласен» with Gengar's «это ваше» says «не моё», with the reason. Money: required.
//
// bella works mia-1 from 30 to 25 hours ago; anna from 23 to 18. The others' shift rows cover those hours with no work.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HOUR_MS = 3_600_000;
const NET = 100_000;
const REVIEWER = `${AGENT_KEY_TOKEN_PREFIX}round2b-gengar-key`;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let pageOne = 0;
const users: Record<string, number> = {};
let refs = 0;
let given = 0;
let bellasShift = 0;

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

/** A tip of mia-1, $100.000 net, `minutesAgo` before now; `postTip` — under a post (the pot's); `store` — its home written. */
async function sale(minutesAgo: number, options: { postTip?: boolean; store?: boolean } = {}): Promise<number> {
  refs += 1;
  const ref = `tx-round2b-${refs}`;
  const inserted = await q(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency, correlation_id)
     values ($1, $2, 'tip', 'tip', 'posted', 'ok', $3, $3, $4, 4000, now() - make_interval(mins => $5::int), 'fansly:rest', 'USD', $6) returning id, occurred_at`,
    [pageOne, ref, NET + 4_000, NET, minutesAgo, options.postTip ? `post-tip-${ref}` : null],
  );
  if (options.postTip) {
    await q(
      `insert into creator_post_tips (account_id, platform, platform_post_id, platform_tip_id, tip_sender_platform_user_id, post_tip_amount_mills,
         occurred_at, first_observed_at, last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
       values ($1, 'fansly', 'post-round2b', $2, '7700000099', $3, $4, $4, $4, repeat('e', 64), 1, 1, $5)`,
      [pageOne, `post-tip-${ref}`, NET + 4_000, inserted.rows[0].occurred_at, refs],
    );
  }
  if (options.store !== false) await refreshHomes();
  return Number(inserted.rows[0].id);
}

async function refreshHomes() {
  const now = new Date();
  await refreshSaleHomes(app.db, { from: new Date(now.getTime() - 48 * HOUR_MS), to: now, now });
}

async function counted(shiftId: number, transactionId: number): Promise<number> {
  const row = (await q(
    `select v.lines from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version where h.shift_id = $1`,
    [shiftId],
  )).rows[0] as { lines: Array<{ transactionId: number | null; amountMills: number }> } | undefined;
  return row?.lines.find((one) => one.transactionId === transactionId)?.amountMills ?? 0;
}

async function ask(who: string, shiftId: number, body: Record<string, unknown>) {
  const asked = await rawSession(who, "POST", `/api/v1/shift-reports/${shiftId}/asks`, { note: "мой фан", ...body });
  expect(asked.statusCode, asked.body).toBe(200);
}

const claimOf = async (transactionId: number, claimantUserId: number) => (await q(
  "select id::int as id, state, statement, claimant_note from sale_claims where transaction_id = $1 and claimant_user_id = $2 and kind = 'claim' order by id", [transactionId, claimantUserId],
)).rows as Array<{ id: number; state: string; statement: string | null; claimant_note: string | null }>;

describe("the board «Отчёт», round 2, the second reader", () => {
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
    let base = 9_400_000_000;
    for (const [who, from, to] of [["bella", 30, 25], ["anna", 23, 18]] as const) {
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

  it("counts «после сдачи» a sale the counted report holds only as a $0 line with nothing on it (B5)", async (context) => {
    if (!testDb) return context.skip();
    given = await sale(20.5 * 60);
    bellasShift = await shiftRow("bella", 21, 20);
    await handInAndConfirm(asSession, "bella", bellasShift);
    expect(await counted(bellasShift, given)).toBe(0);
    const annas = await shiftRow("anna", 23.5, 17.5);
    const word = await asSession("anna", "PUT", `/api/v1/shift-reports/${annas}/lines/${given}`, { statement: "give", toUserId: users.bella });
    expect(word.statusCode, word.body).toBe(200);
    await handInAndConfirm(asSession, "anna", annas);
    await refreshHomes();
    const read = await rawSession("bella", "GET", `/api/v1/shift-reports/${bellasShift}`);
    expect(shiftReportResponseSchema.parse(read.json()).afterSubmission).toMatchObject({ count: 1, mills: NET });
  });

  it("makes nothing by «Досдать» that lost the race to «Исправить» (B4)", async (context) => {
    if (!testDb) return context.skip();
    const versions = async () => Number((await q("select count(*)::int as n from shift_handin_versions v join shift_handins h on h.id = v.handin_id where h.shift_id = $1", [bellasShift])).rows[0].n);
    const before = await versions();
    const meanwhile = await testDb.pool.connect();
    try {
      await meanwhile.query("begin");
      await meanwhile.query("select id from shift_handins where shift_id = $1 for update", [bellasShift]);
      const resend = rawSession("bella", "POST", `/api/v1/shift-reports/${bellasShift}/resend`, { transactionIds: [given] });
      await waitForRowLockWait(testDb.pool, ["%shift_handins%for update%"], { blocked: resend });
      // «Исправить» wins: the report is in «Правка» before «Досдать» gets the report.
      await meanwhile.query("update shift_handins set phase = 'fixing', fixing_from = 'counted', phase_at = now() where shift_id = $1", [bellasShift]);
      await meanwhile.query("commit");
      const answer = await resend;
      expect(answer.statusCode, answer.body).toBe(409);
    } finally {
      await meanwhile.query("rollback").catch(() => undefined);
      meanwhile.release();
    }
    expect(await versions()).toBe(before);
    expect((await q("select phase from shift_handins where shift_id = $1", [bellasShift])).rows[0].phase).toBe("fixing");
  });

  it("never counts a sale two people hold in halves for more than itself when a third takes it (B3)", async (context) => {
    if (!testDb) return context.skip();
    const halves = await sale(27 * 60);
    const bellas = await shiftRow("bella", 30.5, 24.5);
    const coras = await shiftRow("cora", 27.5, 26.5);
    // cora asks «пополам с bella», bella agrees: 50/50.
    await ask("cora", coras, { transactionId: halves, statement: "share", shareWithUserId: users.bella });
    await handInAndConfirm(asSession, "cora", coras);
    await handInAndConfirm(asSession, "bella", bellas);
    await runSaleClaims(app);
    const coraClaim = (await claimOf(halves, users.cora!))[0]!;
    expect((await rawSession("bella", "POST", `/api/v1/sale-claims/${coraClaim.id}/answer`, { answer: "agree" })).statusCode).toBe(200);
    expect(await counted(bellas, halves) + await counted(coras, halves)).toBe(NET);
    // anna takes it «моя»; bella agrees to her.
    const annas = await shiftRow("anna", 27.4, 26.6);
    await ask("anna", annas, { transactionId: halves, statement: "mine" });
    await handInAndConfirm(asSession, "anna", annas);
    await runSaleClaims(app);
    const toBella = (await q("select id::int as id from sale_claims where transaction_id = $1 and claimant_user_id = $2 and side_user_id = $3", [halves, users.anna, users.bella])).rows[0].id as number;
    const agreed = await rawSession("bella", "POST", `/api/v1/sale-claims/${toBella}/answer`, { answer: "agree" });
    expect([200, 409]).toContain(agreed.statusCode);
    await runSaleClaims(app);
    expect(await counted(bellas, halves) + await counted(coras, halves) + await counted(annas, halves)).toBeLessThanOrEqual(NET);
  });

  it("never settles a sale of the pot between two chatters, its home stored or not (B1)", async (context) => {
    if (!testDb) return context.skip();
    // A tip under a post: the pot's. Its home is not stored yet (the hourly job has not run).
    const pot = await sale(14 * 60, { postTip: true, store: false });
    expect((await q("select count(*)::int as n from sale_homes where transaction_id = $1", [pot])).rows[0].n).toBe(0);
    const handin = Number((await q("select h.id from shift_handins h join shifts s on s.id = h.shift_id where s.user_id = $1 limit 1", [users.anna])).rows[0].id);
    // A question about it standing between anna and bella.
    const claim = await insertSaleClaim(app.db, {
      transactionId: pot, pageId: pageOne, kind: "claim", claimantVersion: null, statement: "mine", shareWithUserId: null, claimantNote: "мой фан",
      claimedAt: new Date(), sideShiftId: null, state: "asked", escalatedAt: null, escalatedWhy: null,
      claimantUserId: users.anna!, claimantHandinId: handin, sideUserId: users.bella!, origin: "draft",
    }, new Date());
    const claimId = (claim as { id: number } | null)?.id ?? Number((await q("select id from sale_claims where transaction_id = $1", [pot])).rows[0].id);
    const answered = await rawSession("bella", "POST", `/api/v1/sale-claims/${claimId}/answer`, { answer: "agree" });
    expect(answered.statusCode, answered.body).toBe(409);
    await runSaleClaims(app, new Date(Date.now() + 25 * HOUR_MS));
    expect((await q("select state from sale_claims where id = $1", [claimId])).rows[0].state).toBe("owner");
  });

  it("files «не моё» with the reason when the person says «Не согласен» to Gengar's «это ваше» (B2)", async (context) => {
    if (!testDb) return context.skip();
    await insertAgentKey(testDb.db, {
      name: "round2b-gengar", keyPrefix: REVIEWER.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(REVIEWER),
      capabilities: ["review:shift_reports"] as never, pageIds: [pageOne], expiresAt: new Date(Date.now() + 30 * 86_400_000), createdBy: users.boss!,
    });
    const theirs = await sale(29 * 60);
    const annas = await shiftRow("anna", 30.4, 28.6);
    const handed = await rawSession("anna", "POST", `/api/v1/shift-reports/${annas}/submit`);
    expect(handed.statusCode, handed.body).toBe(200);
    const candidateId = shiftReportResponseSchema.parse(handed.json()).board!.candidate!.id;
    const card = await server!.inject({
      method: "POST", url: `/api/v1/agent/shift-reports/checks/${candidateId}`, headers: { authorization: `Bearer ${REVIEWER}` },
      payload: { proposals: [{ transactionId: theirs, kind: "owner_change", to: { word: "mine" }, why: "Фан писал anna." }] },
    });
    expect(card.statusCode, card.body).toBe(200);
    const proposal = Number((await q("select id from shift_handin_proposals where candidate_id = $1", [candidateId])).rows[0].id);
    const declined = await rawSession("anna", "POST", `/api/v1/shift-reports/${annas}/proposals/${proposal}/answer`, { answer: "decline", note: "это фан bella, я только ответила" });
    expect(declined.statusCode, declined.body).toBe(200);
    await runSaleClaims(app);
    // anna refuses the sale Gengar gives her: her word to the decider is «не моё», never «моё», and the reason is there.
    const claims = await claimOf(theirs, users.anna!);
    expect(claims.map((one) => one.statement)).not.toContain("mine");
    expect(claims.map((one) => one.claimant_note)).toContain("это фан bella, я только ответила");
    const matter = (await q("select evidence from matters where state = 'open' and kind = 'sale.dispute' and (evidence ->> 'transactionId')::bigint = $1", [theirs])).rows[0];
    expect(JSON.stringify(matter?.evidence ?? {})).toContain("это фан bella, я только ответила");
  });
});
