import { createServer } from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { shiftReportResponseSchema, shiftReportsListResponseSchema } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { reportSums } from "../apps/runtime/src/services/sale-claim-rules.ts";
import { readShiftReportsFeed } from "../apps/runtime/src/services/shift-handins.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { listenOnLoopback } from "./helpers/network.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Review of the shift report (R2-a, R2-c). Money: after the owner decides a dispute (or the other side agrees), the
// claimant's later hand-ins count exactly their share by it — settled, never disputed — whatever their old «моё» says;
// the ledger's feed serves the same. Rights: a reader of one page of a two-page report sees its sums — the body, the
// totals and the history — of that page alone, with no «мимо площадки». And the owner's decision asks the ledger
// whether a day is paid before it locks any report, never under the lock.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let pageOne = 0;
let pageTwo = 0;
let anna = 0;
let bella = 0;
let shiftClaims = 0;
let shiftTwoPages = 0;
let shiftB = 0;
let refs = 0;

const asSession = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });

async function insertShift(userId: number, pages: string[], startedAt: Date, endedAt: Date): Promise<number> {
  const result = await testDb!.pool.query(
    `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
     values ($1, 'closed', $2::timestamptz, $3::timestamptz, 300, 200, $4::date, $5::jsonb) returning id`,
    [userId, startedAt.toISOString(), endedAt.toISOString(), new Date(startedAt.getTime() + 3 * 3_600_000).toISOString().slice(0, 10),
      JSON.stringify(pages.map((pageLabel) => ({ pageLabel, activeMinutes: 300, messages: 100, salesFrom: startedAt.toISOString() })))],
  );
  return Number(result.rows[0].id);
}

/** A sale of a page `minutesAgo` before now and its home: bella's shift, or nobody's. */
async function sale(pageId: number, net: number, minutesAgo: number, home: "bella" | "nobody"): Promise<number> {
  refs += 1;
  const inserted = await testDb!.pool.query(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, 'tip', 'tip', 'posted', 'ok', $3, $3, $4, $5, now() - make_interval(mins => $6), 'fansly:rest', 'USD')
     returning id, occurred_at`,
    [pageId, `tx-review-${refs}`, net + 4_000, net, 4_000, minutesAgo],
  );
  const id = Number(inserted.rows[0].id);
  const shares = home === "nobody" ? [] : [{ userId: bella, workRef: null, shiftId: shiftB, percent: 100, mills: net }];
  await testDb!.pool.query(
    `insert into sale_homes (transaction_id, page_id, occurred_at, net_mills, home, reason, shares, rule_version, computed_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, 'test', now())`,
    [id, pageId, inserted.rows[0].occurred_at, net, home === "nobody" ? "nobody" : "shift", home === "nobody" ? "no_holder" : "holder", JSON.stringify(shares)],
  );
  return id;
}

async function submit(shiftId: number) {
  const submitted = await asSession("anna", "POST", `/api/v1/shift-reports/${shiftId}/submit`);
  expect(submitted.statusCode, submitted.body).toBe(200);
}

/** The newest version of a shift's report, and its line of a sale. */
async function newest(shiftId: number, transactionId: number) {
  const row = (await testDb!.pool.query(
    `select v.id, v.version, v.total_mills, v.pages, v.lines, v.off_platform
     from shift_handins h join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version where h.shift_id = $1`,
    [shiftId],
  )).rows[0] as { id: string; version: number; total_mills: string; pages: Array<{ pageLabel: string }>; lines: Array<Record<string, unknown>>; off_platform: Array<{ amountMills: number; state: string; pageLabel?: string | null }> };
  return { ...row, line: row.lines.find((one) => one.transactionId === transactionId) };
}

describe("the shift report after a settled claim, and a reader of one page", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    await createUserAccount(app, { username: "lead", role: "team_lead", password: "lead-password-for-tests" }, { source: "cli" });
    for (const name of ["anna", "bella", "cora"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
      await setUserPassword(app, { userId: await fixtureUserId(app, name), password: `${name}-password-for-tests` }, { source: "cli" });
    }
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageOne = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    pageTwo = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-2" }))!.id;
    for (const [name, page] of [["anna", pageOne], ["anna", pageTwo], ["bella", pageOne], ["cora", pageTwo], ["lead", pageOne]] as const) {
      await assignUserToPage(app.db, await fixtureUserId(app, name), page);
    }
    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "lead", "anna", "bella", "cora"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    for (const code of ["anna", "bella", "cora"]) {
      const created = await asSession("boss", "POST", "/api/v1/admin/people", {
        code, displayName: code, role: "chatter", state: "working", rights: ["submits_shift"], logins: { add: [await fixtureUserId(app, code)] },
      });
      expect(created.statusCode, created.body).toBe(200);
    }
    await testDb.pool.query("update person_rights set granted_at = now() - interval '30 days'");
    anna = await fixtureUserId(app, "anna");
    bella = await fixtureUserId(app, "bella");
    const now = Date.now();
    // bella held mia-1 in the last hours; anna's two shifts of yesterday: one for the claims, one on both pages.
    shiftB = await insertShift(bella, ["mia-1"], new Date(now - 5 * 3_600_000), new Date(now - 10 * 60_000));
    shiftClaims = await insertShift(anna, ["mia-1"], new Date(now - 30 * 3_600_000), new Date(now - 25 * 3_600_000));
    shiftTwoPages = await insertShift(anna, ["mia-1", "mia-2"], new Date(now - 50 * 3_600_000), new Date(now - 45 * 3_600_000));
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("counts exactly the decided share on every later hand-in, settled, and the feed serves that (R2-a)", async (context) => {
    if (!testDb) return context.skip();
    const net = 16_001;
    const low = Math.min(anna, bella);
    const expected = { first: net, second: 0, half: anna === low ? 8_001 : 8_000, nobody: 0 } as const;
    const pick = (line: Record<string, unknown> | undefined) => ({ amountMills: line?.amountMills, disputed: line?.disputed, settled: line?.settled ?? null });
    const seen: Array<{ outcome: string; decided: unknown; again: unknown; fed: unknown; total: boolean; reopened: number }> = [];
    for (const outcome of ["first", "second", "half", "nobody"] as const) {
      // anna says «моё» on bella's sale and hands in: a claim against bella.
      const id = await sale(pageOne, net, 60, "bella");
      const said = await asSession("anna", "PUT", `/api/v1/shift-reports/${shiftClaims}/lines/${id}`, { statement: "mine", note: `моё: ${outcome}` });
      expect(said.statusCode, said.body).toBe(200);
      await submit(shiftClaims);
      expect((await newest(shiftClaims, id)).line).toMatchObject({ amountMills: 0, claimedMills: net, disputed: true });
      // The owner decides; the system's version gives anna what the decision gives her.
      const decided = await asSession("boss", "POST", "/api/v1/sale-disputes/decide", { transactionId: id, outcome });
      expect(decided.statusCode, decided.body).toBe(200);
      const afterDecision = pick((await newest(shiftClaims, id)).line);
      // anna edits the comment and hands in again.
      expect((await asSession("anna", "PUT", `/api/v1/shift-reports/${shiftClaims}/comment`, { comment: `после решения: ${outcome}` })).statusCode).toBe(200);
      await submit(shiftClaims);
      const again = await newest(shiftClaims, id);
      // The ledger's feed: the newest version of the report as it is.
      const feed = await readShiftReportsFeed(app, { pageIds: [pageOne, pageTwo], limit: 500 });
      const served = feed.reports.filter((one) => one.shiftId === shiftClaims).at(-1)!;
      expect(served.id).toBe(Number(again.id));
      expect(served.totalMills).toBe(Number(again.total_mills));
      seen.push({
        outcome,
        decided: afterDecision,
        again: pick(again.line),
        fed: pick(served.lines.find((one) => one.transactionId === id) as Record<string, unknown> | undefined),
        // The version's sums are its lines'.
        total: Number(again.total_mills) === reportSums(again.lines as never, again.pages.map((page) => page.pageLabel), again.off_platform).totalMills,
        // No dispute opened again by the hand-in.
        reopened: (await testDb.pool.query("select count(*)::int as n from sale_claims where transaction_id = $1 and state in ('asked', 'owner')", [id])).rows[0].n,
      });
    }
    expect(seen).toEqual((["first", "second", "half", "nobody"] as const).map((outcome) => {
      const settled = { amountMills: expected[outcome], disputed: false, settled: "owner" };
      return { outcome, decided: settled, again: settled, fed: settled, total: true, reopened: 0 };
    }));
  });

  it("counts exactly the agreed share on a later hand-in", async (context) => {
    if (!testDb) return context.skip();
    const id = await sale(pageOne, 20_000, 70, "bella");
    expect((await asSession("anna", "PUT", `/api/v1/shift-reports/${shiftClaims}/lines/${id}`, { statement: "mine", note: "мой постоянный" })).statusCode).toBe(200);
    await submit(shiftClaims);
    const claimId = Number((await testDb.pool.query("select id from sale_claims where transaction_id = $1", [id])).rows[0].id);
    const agreed = await asSession("bella", "POST", `/api/v1/sale-claims/${claimId}/answer`, { answer: "agree" });
    expect(agreed.statusCode, agreed.body).toBe(200);
    await submit(shiftClaims);
    expect((await newest(shiftClaims, id)).line).toMatchObject({ amountMills: 20_000, disputed: false, settled: "agreed" });
  });

  it("shows a reader of one page of a two-page report that page's sums alone: body, totals, history and list (R2-c)", async (context) => {
    if (!testDb) return context.skip();
    const one = await sale(pageOne, 10_000, 80, "nobody");
    const two = await sale(pageTwo, 6_000, 90, "nobody");
    for (const id of [one, two]) {
      expect((await asSession("anna", "PUT", `/api/v1/shift-reports/${shiftTwoPages}/lines/${id}`, { statement: "mine", note: "ничья, моя" })).statusCode).toBe(200);
    }
    const added = await asSession("anna", "POST", `/api/v1/shift-reports/${shiftTwoPages}/off-platform`, { amountMills: 50_000, fromWhom: "фан", whatFor: "кастом" });
    expect(added.statusCode, added.body).toBe(200);
    await submit(shiftTwoPages);
    const confirmed = await asSession("boss", "POST", `/api/v1/off-platform/${added.json().line.id}/decide`, { decision: "confirm", pageLabel: "mia-1" });
    expect(confirmed.statusCode, confirmed.body).toBe(200);

    // The owner: the whole report, «мимо площадки» in it.
    const whole = shiftReportResponseSchema.parse((await asSession("boss", "GET", `/api/v1/shift-reports/${shiftTwoPages}`)).json());
    expect(whole.latest).toMatchObject({ version: 2, totalMills: 66_000 });
    expect(whole.versions.map((version) => version.totalMills)).toEqual([66_000, 16_000]);

    const day = new Date(Date.now() - 50 * 3_600_000 + 3 * 3_600_000).toISOString().slice(0, 10);
    for (const [who, visible] of [["lead", 10_000], ["cora", 6_000]] as const) {
      const read = await asSession(who, "GET", `/api/v1/shift-reports/${shiftTwoPages}`);
      expect(read.statusCode, `${who}: ${read.body}`).toBe(200);
      const report = shiftReportResponseSchema.parse(read.json());
      expect(report.view?.totalMills, who).toBe(visible);
      expect(report.view?.offPlatform, who).toEqual([]);
      expect(report.latest, who).toMatchObject({ version: 2, totalMills: visible, madeFor: null });
      expect(report.versions.map((version) => [version.totalMills, version.madeFor]), who).toEqual([[visible, null], [visible, null]]);
      const list = shiftReportsListResponseSchema.parse((await asSession(who, "GET", `/api/v1/shift-reports?userId=${anna}&from=${day}&to=${day}`)).json());
      expect(list.shifts.find((shift) => shift.shiftId === shiftTwoPages)?.totalMills, who).toBe(visible);
    }
  });
  it("asks the ledger whether the day is paid before it locks the report, never under the lock", async (context) => {
    if (!testDb || !server) return context.skip();
    const id = await sale(pageOne, 12_000, 100, "bella");
    expect((await asSession("anna", "PUT", `/api/v1/shift-reports/${shiftClaims}/lines/${id}`, { statement: "mine", note: "моё" })).statusCode).toBe(200);
    await submit(shiftClaims);
    // A ledger that, each time it is asked, checks whether anna's report is locked at that moment.
    const underLock: string[] = [];
    const ledger = createServer((request, response) => {
      void (async () => {
        const probe = await testDb!.pool.connect();
        try {
          await probe.query("begin");
          await probe.query("select id from shift_handins where shift_id = $1 for update nowait", [shiftClaims]);
        } catch {
          underLock.push(request.url ?? "");
        } finally {
          await probe.query("rollback").catch(() => undefined);
          probe.release();
        }
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "down" }));
      })();
    });
    const address = await listenOnLoopback(ledger, "the fake agency ledger");
    if (!address) return context.skip();
    const config = { ledgerUrl: app.config.ledgerUrl, ledgerPayoutsKey: app.config.ledgerPayoutsKey };
    Object.assign(app.config, { ledgerUrl: `http://${address.host}:${address.port}`, ledgerPayoutsKey: "test-review-key" });
    try {
      const decided = await asSession("boss", "POST", "/api/v1/sale-disputes/decide", { transactionId: id, outcome: "half" });
      expect(decided.statusCode, decided.body).toBe(200);
      expect(decided.json().versions).toHaveLength(1);
    } finally {
      Object.assign(app.config, config);
      await new Promise<void>((resolve) => ledger.close(() => resolve()));
    }
    expect(underLock).toEqual([]);
  });
});
