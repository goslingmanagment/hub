import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { agentShiftReportsFeedResponseSchema, shiftReportConfirmResponseSchema, shiftReportResponseSchema } from "@agency_hub_core/contracts";
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

// The board «Отчёт», the review arena's round 2. (N1) A report that counts money only by «мимо площадки» counts money:
// a merge leaves a version with nothing under the shift that is gone, a cancel too — the ledger never sums it twice or
// keeps it for a shift that is no more. (N3) A decision or an agreement made after Gengar's card outranks the card: the
// card changes nothing of that sale, and what «Подтвердите» shows is what is signed. Money: required.
//
// anna works mia-1 from 30 to 25 hours ago (the sale of N3 is hers by the rule); bella hands shifts in on the board too.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HOUR_MS = 3_600_000;
const KEY = `${AGENT_KEY_TOKEN_PREFIX}round2-agent-key`;
const REVIEWER = `${AGENT_KEY_TOKEN_PREFIX}round2-gengar-key`;
const WORDS = { saidBy: "владелец", saidAt: "2026-11-15", telegramUserId: 700_000_901, sourceRef: "https://t.me/c/1/90" };

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let pageOne = 0;
const users: Record<string, number> = {};

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const rawSession = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asSession = editingSession(rawSession);
const asKey = (token: string, method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

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

/** The ledger's side: every version kept by id under the shift the feed served it with; a shift's report is its highest version. */
const ledger = new Map<number, { shiftId: number; version: number; total: number }>();
async function readFeed() {
  let since: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const read = await asKey(KEY, "GET", `/api/v1/agent/shift-reports?limit=500${since === undefined ? "" : `&since=${since}`}`);
    expect(read.statusCode, read.body).toBe(200);
    const feed = agentShiftReportsFeedResponseSchema.parse(read.json());
    for (const one of feed.reports) if (!ledger.has(one.id)) ledger.set(one.id, { shiftId: one.shiftId, version: one.version, total: one.totalMills });
    if (!feed.more || feed.next === since) break;
    since = feed.next;
  }
}
/** What the ledger counts for the shifts named: the sum of each shift's highest version. */
function countedByLedger(shiftIds: readonly number[]): number {
  const current = new Map<number, { version: number; total: number }>();
  for (const one of ledger.values()) {
    if (!shiftIds.includes(one.shiftId)) continue;
    const had = current.get(one.shiftId);
    if (had === undefined || one.version > had.version) current.set(one.shiftId, { version: one.version, total: one.total });
  }
  return [...current.values()].reduce((sum, one) => sum + one.total, 0);
}

/** A counted report of anna that holds only «мимо площадки» $5, confirmed by the owner. */
async function offPlatformOnly(shiftId: number): Promise<void> {
  const added = await rawSession("anna", "POST", `/api/v1/shift-reports/${shiftId}/off-platform`, { amountMills: 5_000, fromWhom: "фан", whatFor: "кастом" });
  expect(added.statusCode, added.body).toBe(200);
  await handInAndConfirm(asSession, "anna", shiftId);
  const decided = await rawSession("boss", "POST", `/api/v1/off-platform/${added.json().line.id}/decide`, { decision: "confirm", pageLabel: "mia-1" });
  expect(decided.statusCode, decided.body).toBe(200);
}

describe("the board «Отчёт», the review arena's round 2", () => {
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
    await insertAgentKey(testDb.db, {
      name: "round2-agent", keyPrefix: KEY.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(KEY),
      capabilities: ["write:shift_reports", "read:team", "read:money"] as never, pageIds: [pageOne],
      expiresAt: new Date(Date.now() + 30 * 86_400_000), createdBy: users.boss!,
    });
    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "anna", "bella"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    for (const name of ["anna", "bella"]) {
      const created = await asSession("boss", "POST", "/api/v1/admin/people", {
        code: name, displayName: name, role: "chatter", state: "working", rights: ["submits_shift"], logins: { add: [users[name]] },
      });
      expect(created.statusCode, created.body).toBe(200);
    }
    await q("update person_rights set granted_at = now() - interval '30 days'");
    await q(
      `insert into chatter_activity_minutes (user_id, page_id, minute, input)
       select $1, $2, minute, true from generate_series(date_trunc('minute', now() - interval '30 hours'), date_trunc('minute', now() - interval '25 hours'), interval '1 minute') minute`,
      [users.anna, pageOne],
    );
    await q(
      `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
       select 'fansly', $1, (9500000000 + n)::text, '7700000088', $2, 'fansly-extension', false, false, now() - interval '30 hours' + interval '3 minutes' * n, 'hand'
       from generate_series(0, 99) n`,
      [pageOne, users.anna],
    );
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("leaves nothing counted under a shift merged away when its report held only «мимо площадки» (N1)", async (context) => {
    if (!testDb) return context.skip();
    const gone = await shiftRow("anna", 12, 10);
    await offPlatformOnly(gone);
    await readFeed();
    expect(countedByLedger([gone])).toBe(5_000);
    // «Исправить», the shifts merge, the report is handed in again under the shift that remains and signed.
    expect((await rawSession("anna", "POST", `/api/v1/shift-reports/${gone}/reopen`)).statusCode).toBe(200);
    const kept = await shiftRow("anna", 12.1, 9.9);
    await q("update shifts set state = 'merged', merged_into = $2 where id = $1", [gone, kept]);
    await settleGoneShifts(app, new Date());
    await handInAndConfirm(asSession, "anna", kept);
    await readFeed();
    expect(countedByLedger([gone, kept])).toBe(5_000);
  });

  it("leaves nothing counted under a cancelled shift whose report held only «мимо площадки» (N1, the cancel)", async (context) => {
    if (!testDb) return context.skip();
    const dropped = await shiftRow("anna", 8, 6);
    await offPlatformOnly(dropped);
    await readFeed();
    expect(countedByLedger([dropped])).toBe(5_000);
    await q("update shifts set state = 'dropped' where id = $1", [dropped]);
    await settleGoneShifts(app, new Date());
    await readFeed();
    expect(countedByLedger([dropped])).toBe(0);
  });

  it("never lets Gengar's card change a sale decided since: the board and «Подтверждаю» sign the decision (N3)", async (context) => {
    if (!testDb) return context.skip();
    await insertAgentKey(testDb.db, {
      name: "round2-gengar", keyPrefix: REVIEWER.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(REVIEWER),
      capabilities: ["review:shift_reports"] as never, pageIds: [pageOne], expiresAt: new Date(Date.now() + 30 * 86_400_000), createdBy: users.boss!,
    });
    const inserted = await q(
      `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
         gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
       values ($1, 'tx-round2-1', 'tip', 'tip', 'posted', 'ok', 11000, 11000, 10000, 1000, now() - interval '28 hours', 'fansly:rest', 'USD') returning id`,
      [pageOne],
    );
    const sale = Number(inserted.rows[0].id);
    const now = new Date();
    await refreshSaleHomes(app.db, { from: new Date(now.getTime() - 48 * HOUR_MS), to: now, now });
    const shift = await shiftRow("anna", 30.5, 24.5);
    const handed = await rawSession("anna", "POST", `/api/v1/shift-reports/${shift}/submit`);
    expect(handed.statusCode, handed.body).toBe(200);
    const candidateId = shiftReportResponseSchema.parse(handed.json()).board!.candidate!.id;
    // Gengar: «пополам с bella» (anna −$5).
    const card = await asKey(REVIEWER, "POST", `/api/v1/agent/shift-reports/checks/${candidateId}`, {
      proposals: [{ transactionId: sale, kind: "owner_change", to: { word: "share", userId: users.bella }, why: "Вели фана вдвоём." }],
    });
    expect(card.statusCode, card.body).toBe(200);
    // Then the owner decides: the whole sale is bella's.
    const decided = await asKey(KEY, "POST", "/api/v1/agent/sale-decisions", { ...WORDS, transactionId: sale, kind: "owner", shares: [{ person: "bella", percent: 100 }] });
    expect(decided.statusCode, decided.body).toBe(200);
    // What «Подтвердите» shows is the decision (anna $0), and that is what is signed.
    const read = await rawSession("anna", "GET", `/api/v1/shift-reports/${shift}`);
    const shown = shiftReportResponseSchema.parse(read.json()).board!;
    expect(shown.phase).toBe("confirm");
    const row = shown.columns.flatMap((column) => column.rows).find((one) => one.transactionId === sale);
    expect(row?.amountMills).toBe(0);
    const pressed = await rawSession("anna", "POST", `/api/v1/shift-reports/${shift}/confirm`, { candidateId, seenTotalMills: shown.totals.nowMills, seenCount: shown.totals.count });
    expect(pressed.statusCode, pressed.body).toBe(200);
    expect(shiftReportConfirmResponseSchema.parse(pressed.json())).toMatchObject({ confirmed: true, refused: null });
    await runSaleClaims(app);
    const line = (await q(
      `select line from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version,
         jsonb_array_elements(v.lines) line where h.shift_id = $1 and (line ->> 'transactionId')::bigint = $2`, [shift, sale],
    )).rows[0]?.line as { amountMills: number; settled?: string } | undefined;
    expect(line).toMatchObject({ amountMills: 0, settled: "owner" });
    // The card was not taken as anna's word: no «пополам» was written on her behalf.
    expect((await q("select statement from shift_handin_marks m join shift_handins h on h.id = m.handin_id where h.shift_id = $1 and m.transaction_id = $2", [shift, sale])).rows
      .map((one) => one.statement)).not.toContain("share");
  });
});
