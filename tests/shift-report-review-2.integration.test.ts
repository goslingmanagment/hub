import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { shiftReportResponseSchema } from "@agency_hub_core/contracts";
import { assignUserToPage, createFanslyPage, createModel } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { readShiftReportsFeed } from "../apps/runtime/src/services/shift-handins.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Review round 2b of the shift report. (1) A report's date is the shift's date when it is handed in, not the date of
// its first mark: a night shift that crossed into the next day after the first mark is reported — and fed to the
// ledger — on the next day. (2) «Моё» on a sale the rule gives to someone else is NOT paid to both while it waits: the
// claimant's line says what is claimed and counts nothing in the page sums and the total until the claim is settled;
// the settlement's new version brings the settled share. Money: required.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
let pageOne = 0;
let anna = 0;
let bella = 0;
let shiftB = 0;
let refs = 0;

const asSession = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  server!.inject({ method, url, headers: { cookie: cookies[who]! }, ...(payload ? { payload } : {}) });

async function insertShift(userId: number, startedAt: Date, endedAt: Date, reportDate: string): Promise<number> {
  const result = await testDb!.pool.query(
    `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages)
     values ($1, 'closed', $2::timestamptz, $3::timestamptz, 300, 200, $4::date, $5::jsonb) returning id`,
    [userId, startedAt.toISOString(), endedAt.toISOString(), reportDate, JSON.stringify([{ pageLabel: "mia-1", activeMinutes: 300, messages: 100, salesFrom: startedAt.toISOString() }])],
  );
  return Number(result.rows[0].id);
}

/** A sale of mia-1 `minutesAgo` before now and its home: bella's shift, or nobody's. */
async function sale(net: number, minutesAgo: number, home: "bella" | "nobody"): Promise<number> {
  refs += 1;
  const inserted = await testDb!.pool.query(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
       gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, platform_fee_mills, occurred_at, source, currency)
     values ($1, $2, 'tip', 'tip', 'posted', 'ok', $3, $3, $4, $5, now() - make_interval(mins => $6), 'fansly:rest', 'USD')
     returning id, occurred_at`,
    [pageOne, `tx-review2-${refs}`, net + 4_000, net, 4_000, minutesAgo],
  );
  const id = Number(inserted.rows[0].id);
  const shares = home === "nobody" ? [] : [{ userId: bella, workRef: null, shiftId: shiftB, percent: 100, mills: net }];
  await testDb!.pool.query(
    `insert into sale_homes (transaction_id, page_id, occurred_at, net_mills, home, reason, shares, rule_version, computed_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, 'test', now())`,
    [id, pageOne, inserted.rows[0].occurred_at, net, home === "nobody" ? "nobody" : "shift", home === "nobody" ? "no_holder" : "holder", JSON.stringify(shares)],
  );
  return id;
}

async function submit(shiftId: number) {
  const submitted = await asSession("anna", "POST", `/api/v1/shift-reports/${shiftId}/submit`);
  expect(submitted.statusCode, submitted.body).toBe(200);
  return shiftReportResponseSchema.parse(submitted.json());
}

/** The newest version the ledger's feed serves of a shift's report. */
async function fed(shiftId: number) {
  const feed = await readShiftReportsFeed(app, { pageIds: [pageOne], limit: 500 });
  return feed.reports.filter((one) => one.shiftId === shiftId).at(-1)!;
}

describe("the shift report, review round 2b", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-password-for-tests" }, { source: "cli" });
    for (const name of ["anna", "bella"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
      await setUserPassword(app, { userId: await fixtureUserId(app, name), password: `${name}-password-for-tests` }, { source: "cli" });
    }
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    pageOne = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-1" }))!.id;
    for (const name of ["anna", "bella"]) await assignUserToPage(app.db, await fixtureUserId(app, name), pageOne);
    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["boss", "anna", "bella"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    for (const code of ["anna", "bella"]) {
      const created = await asSession("boss", "POST", "/api/v1/admin/people", {
        code, displayName: code, role: "chatter", state: "working", rights: ["submits_shift"], logins: { add: [await fixtureUserId(app, code)] },
      });
      expect(created.statusCode, created.body).toBe(200);
    }
    await testDb.pool.query("update person_rights set granted_at = now() - interval '30 days'");
    anna = await fixtureUserId(app, "anna");
    bella = await fixtureUserId(app, "bella");
    const now = Date.now();
    shiftB = await insertShift(bella, new Date(now - 5 * 3_600_000), new Date(now - 10 * 60_000), new Date(now).toISOString().slice(0, 10));
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("dates a night shift's report by the shift at hand-in, not by its first mark (1)", async (context) => {
    if (!testDb) return context.skip();
    // A night shift begun 22:30 Moscow; its first word at 23:40, while the shift was still the day it began.
    const day = "2026-11-08";
    const night = await insertShift(anna, new Date(`${day}T22:30:00+03:00`), new Date(`${day}T23:40:00+03:00`), day);
    expect((await asSession("anna", "PUT", `/api/v1/shift-reports/${night}/comment`, { comment: "ночь" })).statusCode).toBe(200);
    // The shift ran to 03:00: by the ledger's rule its report date is the next day now.
    await testDb.pool.query("update shifts set ended_at = $2::timestamptz, report_date = '2026-11-09' where id = $1", [night, "2026-11-09T03:00:00+03:00"]);
    await submit(night);
    expect((await fed(night)).reportDate).toBe("2026-11-09");
    const handin = await testDb.pool.query("select to_char(report_date, 'YYYY-MM-DD') as day from shift_handins where shift_id = $1", [night]);
    expect(handin.rows[0].day).toBe("2026-11-09");
    const list = await asSession("anna", "GET", "/api/v1/shift-reports?from=2026-11-08&to=2026-11-09");
    expect(list.json().shifts.find((one: { shiftId: number }) => one.shiftId === night)).toMatchObject({ reportDate: "2026-11-09", state: "submitted" });
  });

  it("counts a disputed «моё» nowhere until it is settled, and says what is claimed (2)", async (context) => {
    if (!testDb) return context.skip();
    const shift = await insertShift(anna, new Date(Date.now() - 30 * 3_600_000), new Date(Date.now() - 25 * 3_600_000), new Date(Date.now() - 27 * 3_600_000).toISOString().slice(0, 10));
    const own = await sale(10_000, 50, "nobody");
    const disputed = await sale(16_001, 60, "bella");
    for (const [id, note] of [[own, "ничья, моя"], [disputed, "мой фан"]] as const) {
      expect((await asSession("anna", "PUT", `/api/v1/shift-reports/${shift}/lines/${id}`, { statement: "mine", note })).statusCode).toBe(200);
    }
    // The draft: the line stays, says the claim, counts nothing.
    const draft = shiftReportResponseSchema.parse((await asSession("anna", "GET", `/api/v1/shift-reports/${shift}`)).json()).view!;
    expect(draft.lines.find((line) => line.transactionId === disputed)).toMatchObject({ amountMills: 0, claimedMills: 16_001, disputed: true });
    expect(draft.totalMills).toBe(10_000);

    const handed = await submit(shift);
    expect(handed.latest?.totalMills).toBe(10_000);
    expect(handed.posts.map((post) => post.text).join("\n")).toContain("Спорно, ждёт решения: $16.00");
    // The ledger reads the same: the page is its counted lines, the disputed line counts nothing and says the claim.
    const first = await fed(shift);
    expect(first.totalMills).toBe(10_000);
    expect(first.pages).toEqual([{ pageLabel: "mia-1", amountMills: 10_000 }]);
    expect(first.lines.find((line) => line.transactionId === disputed)).toMatchObject({ amountMills: 0, claimedMills: 16_001, disputed: true });
    // The claim stands on it: bella is asked.
    const claim = await testDb.pool.query("select state from sale_claims where transaction_id = $1", [disputed]);
    expect(claim.rows).toEqual([{ state: "asked" }]);

    // The owner gives it to anna: the settlement's version brings it.
    const decided = await asSession("boss", "POST", "/api/v1/sale-disputes/decide", { transactionId: disputed, outcome: "first" });
    expect(decided.statusCode, decided.body).toBe(200);
    const settled = await fed(shift);
    expect(settled.totalMills).toBe(26_000);
    expect(settled.lines.find((line) => line.transactionId === disputed)).toMatchObject({ amountMills: 16_001, disputed: false, settled: "owner" });
  });
});
