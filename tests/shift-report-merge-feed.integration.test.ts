import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { agentShiftReportsFeedResponseSchema } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { refreshSaleHomes } from "../apps/runtime/src/services/sale-homes.ts";
import { settleGoneShifts } from "../apps/runtime/src/services/shift-handin-check.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";
import { handInAndConfirm, editingSession } from "./helpers/shift-report-hand-in.ts";

// A shift row merged into another after its report was handed in (final review of the «Отчёт» board, finding 3): the
// report moves to the shift that remains, and the ledger — which keeps every version under the shift the feed names
// and takes a shift's highest version as its report (ledger internal/reports/hub.go) — still counts each sale once.
// Money: required.
//
// anna really works mia-1 from 22 to 20 hours ago (minutes and messages): the rule gives her the page's sales of those
// hours.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const HOUR_MS = 3_600_000;
const NET = 100_000;
const KEY = `${AGENT_KEY_TOKEN_PREFIX}merge-feed-ledger-key`;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let pageOne = 0;
let anna = 0;

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const rawSession = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });
const asSession = editingSession(rawSession);
const asKey = (url: string) => server!.inject({ method: "GET", url, headers: { authorization: `Bearer ${KEY}` } });

/** A closed shift row of anna on mia-1 from `fromHoursAgo` to `toHoursAgo` before now. */
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

describe("a report whose shift is merged after the hand-in", () => {
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
      name: "merge-feed-ledger", keyPrefix: KEY.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(KEY),
      capabilities: ["read:team", "read:money"] as never, pageIds: [pageOne],
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
    // anna's work on mia-1: every minute from 22 to 20 hours ago, a message every three minutes.
    await q(
      `insert into chatter_activity_minutes (user_id, page_id, minute, input)
       select $1, $2, minute, true
       from generate_series(date_trunc('minute', now() - interval '22 hours'), date_trunc('minute', now() - interval '20 hours'), interval '1 minute') minute`,
      [anna, pageOne],
    );
    await q(
      `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
       select 'fansly', $1, (9900000000 + n)::text, '7700000088', $2, 'fansly-extension', false, false, now() - interval '22 hours' + interval '3 minutes' * n, 'hand'
       from generate_series(0, 39) n`,
      [pageOne, anna],
    );
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("gives the ledger one current version of a sale when the report's shift is merged into another after the hand-in (3)", async (context) => {
    if (!testDb) return context.skip();
    const inserted = await q(
      `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
         gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
       values ($1, 'tx-merge-feed-1', 'tip', 'tip', 'posted', 'ok', $2, $2, $3, 4000, now() - interval '21 hours', 'fansly:rest', 'USD') returning id`,
      [pageOne, NET + 4_000, NET],
    );
    const sale = Number(inserted.rows[0].id);
    const now = new Date();
    await refreshSaleHomes(app.db, { from: new Date(now.getTime() - 48 * HOUR_MS), to: now, now });
    // anna's work of 22–20 hours ago: the shift row handed in; the row it is joined into comes with the merge.
    const gone = await shiftRow(22.5, 19.5);
    await handInAndConfirm(asSession, "anna", gone);
    const home = (await q("select home, reason, shares from sale_homes where transaction_id = $1", [sale])).rows[0];
    const counted = (await q(
      `select v.lines from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version where h.shift_id = $1`, [gone],
    )).rows[0]?.lines as Array<{ transactionId: number; amountMills: number }> | undefined;
    expect(counted?.find((line) => line.transactionId === sale)?.amountMills, JSON.stringify({ home, counted })).toBe(NET);

    // The ledger's side: every version kept by id under the shift the feed served it with; a shift's report is its
    // highest version.
    const ledger = new Map<number, { shiftId: number; version: number; amount: number }>();
    const readFeed = async () => {
      let since: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const read = await asKey(`/api/v1/agent/shift-reports?limit=500${since === undefined ? "" : `&since=${since}`}`);
        expect(read.statusCode, read.body).toBe(200);
        const feed = agentShiftReportsFeedResponseSchema.parse(read.json());
        for (const one of feed.reports) {
          if (ledger.has(one.id)) continue;
          const amount = one.lines.filter((line) => line.transactionId === sale).reduce((sum, line) => sum + line.amountMills, 0);
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

    // Merged: the report moves to the shift that remains; the ledger reads; anna hands it in again; the ledger reads.
    const kept = await shiftRow(22.6, 19.4);
    await q("update shifts set state = 'merged', merged_into = $2 where id = $1", [gone, kept]);
    await settleGoneShifts(app, new Date());
    expect((await q("select shift_id::int as shift_id from shift_handins where shift_id in ($1, $2)", [gone, kept])).rows).toEqual([{ shift_id: kept }]);
    await readFeed();
    expect(countedByLedger()).toBe(NET);
    await handInAndConfirm(asSession, "anna", kept);
    await readFeed();
    expect(countedByLedger()).toBe(NET);
  });
});
