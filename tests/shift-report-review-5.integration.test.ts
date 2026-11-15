import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { agentShiftReportsFeedResponseSchema, shiftReportResponseSchema } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { runSaleClaims } from "../apps/runtime/src/services/sale-claims.ts";
import { refreshSaleHomes } from "../apps/runtime/src/services/sale-homes.ts";
import { settleGoneShifts } from "../apps/runtime/src/services/shift-handin-check.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";
import { handInAndConfirm, editingSession } from "./helpers/shift-report-hand-in.ts";

// The board's money, the final review's second reader (latent while the board is on for the test team only; each one
// would lose or double money once pay goes by the counted report). (1) A sale given to a colleague whose report is
// already counted, and lies in it as «Рядом» at $0, reaches that report: it is «после сдачи» there and «Досдать» takes
// it. (2) A new question on a claim a day of silence settled does not change its terms: the two reports never count
// more than the sale. (3) A report moved to the shift that remains after a merge never gives the ledger two current
// versions of one sale. (4) A sale of the pot is never asked between two chatters: the owner decides it. Money: required.
//
// anna really works mia-1 from 30 to 25 and from 22 to 20 hours ago (minutes and messages): the rule gives her the
// page's sales of those hours. bella hands shifts in on the board too; her shift rows cover some of those hours with no
// work of hers, so the sales lie in her reports as «Рядом».

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HOUR_MS = 3_600_000;
const NET = 100_000;
const KEY = `${AGENT_KEY_TOKEN_PREFIX}review5-ledger-key`;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let pageOne = 0;
let anna = 0;
let bella = 0;
let worked = 0;
let refs = 0;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const rawSession = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asSession = editingSession(rawSession);
const asKey = (url: string) => server!.inject({ method: "GET", url, headers: { authorization: `Bearer ${KEY}` } });

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

/** A tip of mia-1 of $100.000 net `minutesAgo` before now; `postTip` — a tip under a post (the pot's by the rule). */
async function sale(minutesAgo: number, postTip = false): Promise<number> {
  refs += 1;
  const ref = `tx-review5-${refs}`;
  const inserted = await q(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency, correlation_id)
     values ($1, $2, 'tip', 'tip', 'posted', 'ok', $3, $3, $4, $5, now() - make_interval(mins => $6), 'fansly:rest', 'USD', $7) returning id, occurred_at`,
    [pageOne, ref, NET + 4_000, NET, 4_000, minutesAgo, postTip ? `post-tip-${ref}` : null],
  );
  if (postTip) {
    await q(
      `insert into creator_post_tips (account_id, platform, platform_post_id, platform_tip_id, tip_sender_platform_user_id, post_tip_amount_mills,
         occurred_at, first_observed_at, last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
       values ($1, 'fansly', 'post-review5', $2, '7700000099', $3, $4, $4, $4, repeat('d', 64), 1, 1, $5)`,
      [pageOne, `post-tip-${ref}`, NET + 4_000, inserted.rows[0].occurred_at, refs],
    );
  }
  await refreshHomes();
  return Number(inserted.rows[0].id);
}

/** The homes of the last two days computed again and written, as the hourly job does. */
async function refreshHomes() {
  const now = new Date();
  await refreshSaleHomes(app.db, { from: new Date(now.getTime() - 48 * HOUR_MS), to: now, now });
}

async function homeOf(transactionId: number) {
  const row = (await q("select home, shares from sale_homes where transaction_id = $1", [transactionId])).rows[0] as
    { home: string; shares: Array<{ userId: number; shiftId: number | null }> } | undefined;
  return row === undefined ? null : { home: row.home, users: row.shares.map((share) => Number(share.userId)) };
}

/** The newest version of a shift's report, and what its line of a sale counts (0 — no line). */
async function counted(shiftId: number, transactionId: number): Promise<number> {
  const row = (await q(
    `select v.lines from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version where h.shift_id = $1`,
    [shiftId],
  )).rows[0] as { lines: Array<{ transactionId: number | null; amountMills: number }> } | undefined;
  return row?.lines.find((one) => one.transactionId === transactionId)?.amountMills ?? 0;
}

async function boardRow(who: string, shiftId: number, transactionId: number) {
  const read = await rawSession(who, "GET", `/api/v1/shift-reports/${shiftId}`);
  expect(read.statusCode, read.body).toBe(200);
  return shiftReportResponseSchema.parse(read.json()).board?.columns.flatMap((column) => column.rows).find((row) => row.transactionId === transactionId);
}

async function ask(who: string, shiftId: number, body: Record<string, unknown>) {
  return rawSession(who, "POST", `/api/v1/shift-reports/${shiftId}/asks`, body);
}

describe("the board's money, the final review's second reader", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    for (const name of ["anna", "bella"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
      await setUserPassword(app, { userId: await fixtureUserId(app, name), password: `${name}-password-for-tests` }, { source: "cli" });
    }
    anna = await fixtureUserId(app, "anna");
    bella = await fixtureUserId(app, "bella");
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageOne = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    await assignUserToPage(app.db, anna, pageOne);
    await assignUserToPage(app.db, bella, pageOne);
    await insertAgentKey(testDb.db, {
      name: "review5-ledger", keyPrefix: KEY.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(KEY),
      capabilities: ["read:team", "read:money"] as never, pageIds: [pageOne],
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
    for (const [code, userId] of [["anna", anna], ["bella", bella]] as const) {
      const created = await asSession("boss", "POST", "/api/v1/admin/people", {
        code, displayName: code, role: "chatter", state: "working", rights: ["submits_shift"], logins: { add: [userId] },
      });
      expect(created.statusCode, created.body).toBe(200);
    }
    await q("update person_rights set granted_at = now() - interval '30 days'");
    // anna's work on mia-1: every minute of 30–25 and 22–20 hours ago, a message every three minutes.
    for (const [from, to] of [[30, 25], [22, 20]] as const) {
      await q(
        `insert into chatter_activity_minutes (user_id, page_id, minute, input)
         select $1, $2, minute, true
         from generate_series(date_trunc('minute', now() - make_interval(hours => $3::int)), date_trunc('minute', now() - make_interval(hours => $4::int)), interval '1 minute') minute`,
        [anna, pageOne, from, to],
      );
      await q(
        `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
         select 'fansly', $1, ($4::bigint + n)::text, '7700000088', $2, 'fansly-extension', false, false, now() - make_interval(hours => $3::int) + interval '3 minutes' * n, 'hand'
         from generate_series(0, ($3::int - $5::int) * 20 - 1) n`,
        [pageOne, anna, from, 9_800_000_000 + from * 1_000, to],
      );
    }
    worked = await shiftRow(anna, 30.5, 24.5);
    await handInAndConfirm(asSession, "anna", worked);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("brings a sale given to a colleague whose report is counted into that report: «после сдачи», and «Досдать» takes it (1)", async (context) => {
    if (!testDb) return context.skip();
    const given = await sale(29.5 * 60);
    expect(await homeOf(given)).toMatchObject({ home: "shift", users: [anna] });
    // bella's shift row covers the sale's hour with no work of hers: the sale lies in her counted report «Рядом», at $0.
    const hers = await shiftRow(bella, 30.4, 28.6);
    await handInAndConfirm(asSession, "bella", hers);
    expect((await q(
      `select count(*)::int as n from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version,
         jsonb_array_elements(v.lines) line where h.shift_id = $1 and (line ->> 'transactionId')::bigint = $2`, [hers, given])).rows[0].n).toBe(1);
    expect(await counted(hers, given)).toBe(0);
    // anna gives it to bella and confirms: by the rule the sale is bella's now.
    const word = await asSession("anna", "PUT", `/api/v1/shift-reports/${worked}/lines/${given}`, { statement: "give", toUserId: bella });
    expect(word.statusCode, word.body).toBe(200);
    await handInAndConfirm(asSession, "anna", worked);
    await refreshHomes();
    expect(await homeOf(given)).toMatchObject({ users: [bella] });
    expect(await counted(worked, given)).toBe(0);
    // bella's board says it came after the hand-in; «Досдать» takes it; then it counts once, in her report.
    expect(await boardRow("bella", hers, given)).toMatchObject({ late: true });
    const resent = await rawSession("bella", "POST", `/api/v1/shift-reports/${hers}/resend`, { transactionIds: [given] });
    expect(resent.statusCode, resent.body).toBe(200);
    expect(await counted(hers, given)).toBe(NET);
  });

  it("does not let a new question change the terms of a claim a day of silence settled: the reports never count more than the sale (2)", async (context) => {
    if (!testDb) return context.skip();
    const shared = await sale(28 * 60);
    const hers = await shiftRow(bella, 28.5, 27.2);
    // bella asks «пополам» from her draft, hands in; anna's report holds the sale; anna says nothing for a day.
    const asked = await ask("bella", hers, { transactionId: shared, statement: "share", shareWithUserId: anna, note: "вели фана вместе" });
    expect(asked.statusCode, asked.body).toBe(200);
    await handInAndConfirm(asSession, "bella", hers);
    await handInAndConfirm(asSession, "anna", worked);
    await runSaleClaims(app, new Date(Date.now() + 25 * HOUR_MS));
    expect((await q("select state from sale_claims where transaction_id = $1", [shared])).rows).toEqual([{ state: "agreed" }]);
    expect(await counted(worked, shared)).toBe(NET / 2);
    expect(await counted(hers, shared)).toBe(NET / 2);
    // «Исправить», then «Моя» on the same sale.
    expect((await rawSession("bella", "POST", `/api/v1/shift-reports/${hers}/reopen`)).statusCode).toBe(200);
    const again = await ask("bella", hers, { transactionId: shared, statement: "mine", note: "это мой фан" });
    if (again.statusCode === 200) await handInAndConfirm(asSession, "bella", hers);
    expect(await counted(worked, shared) + await counted(hers, shared)).toBeLessThanOrEqual(NET);
    expect(again.statusCode, again.body).toBe(409);
  });

  it("never asks a sale of the pot between two chatters: it is the owner's, and nobody's «Согласен» or silence settles it (4)", async (context) => {
    if (!testDb) return context.skip();
    const pot = await sale(26.5 * 60, true);
    expect(await homeOf(pot)).toMatchObject({ home: "pot" });
    const hers = await shiftRow(bella, 27.0, 25.8);
    for (const [who, shiftId] of [["anna", worked], ["bella", hers]] as const) {
      const said = await ask(who, shiftId, { transactionId: pot, statement: "mine", note: "мой фан" });
      expect(said.statusCode, said.body).toBe(200);
      await handInAndConfirm(asSession, who, shiftId);
    }
    await runSaleClaims(app);
    const claims = (await q("select state from sale_claims where transaction_id = $1 and kind = 'claim'", [pot])).rows as Array<{ state: string }>;
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.filter((claim) => claim.state !== "owner")).toEqual([]);
    // A day later nothing settled it between them.
    await runSaleClaims(app, new Date(Date.now() + 25 * HOUR_MS));
    expect(await counted(worked, pot) + await counted(hers, pot)).toBe(0);
  });

  it("gives the ledger one current version of a sale when the report's shift is merged into another after the hand-in (3)", async (context) => {
    if (!testDb) return context.skip();
    const merged = await sale(21 * 60);
    // anna's work of 22–20 hours ago: two shift rows of it; the one handed in is then joined into the other.
    const gone = await shiftRow(anna, 22.5, 19.5);
    await handInAndConfirm(asSession, "anna", gone);
    // The ledger's side: every version kept by id under the shift the feed served it with; a shift's report is its
    // highest version (ledger internal/reports/hub.go).
    const ledger = new Map<number, { shiftId: number; version: number; amount: number }>();
    const readFeed = async () => {
      let since: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const read = await asKey(`/api/v1/agent/shift-reports?limit=500${since === undefined ? "" : `&since=${since}`}`);
        expect(read.statusCode, read.body).toBe(200);
        const feed = agentShiftReportsFeedResponseSchema.parse(read.json());
        for (const one of feed.reports) {
          if (ledger.has(one.id)) continue;
          const amount = one.lines.filter((line) => line.transactionId === merged).reduce((sum, line) => sum + line.amountMills, 0);
          ledger.set(one.id, { shiftId: one.shiftId, version: one.version, amount });
        }
        if (!feed.more || feed.next === since) break;
        since = feed.next;
      }
    };
    const countedByLedger = () => {
      const current = new Map<number, { version: number; amount: number }>();
      for (const one of ledger.values()) {
        const had = current.get(one.shiftId);
        if (had === undefined || one.version > had.version) current.set(one.shiftId, { version: one.version, amount: one.amount });
      }
      return [...current.values()].reduce((sum, one) => sum + one.amount, 0);
    };
    await readFeed();
    expect(countedByLedger()).toBe(NET);
    // The row handed in is joined into the other; the report moves there and is handed in again.
    const kept = await shiftRow(anna, 22.6, 19.4);
    await q("update shifts set state = 'merged', merged_into = $2 where id = $1", [gone, kept]);
    await settleGoneShifts(app, new Date());
    expect((await q("select shift_id::int as shift_id from shift_handins where shift_id in ($1, $2)", [gone, kept])).rows).toEqual([{ shift_id: kept }]);
    await handInAndConfirm(asSession, "anna", kept);
    await readFeed();
    expect(countedByLedger()).toBe(NET);
  });
});
