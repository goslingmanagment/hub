import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";

import { teamShiftReportsResponseSchema, type TeamShiftReportsResponse } from "@agency_hub_core/contracts";
import {
  assignUserToPage,
  createFanslyPage,
  createModel,
  ensureHandin,
  insertHandinVersion,
  insertPersonLogin,
  insertPersonRow,
  type Database,
  type HandinVersionLine,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// «Смены → Отчёты» (`teamShiftReports`): who sees whose report, and how much of it. The owner reads every team's
// reports whole; a team lead and a chatter only the shifts on their teams' pages, a report that holds another team's
// page cut to theirs (its sum too, «мимо площадки» never); one's own shift whole; someone of no team nothing; a device
// token is no team reader. Money-adjacent: whose money a reader sees.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const URL = "/api/v1/team/shift-reports?days=7&until=2026-11-12";

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const cookies: Record<string, string> = {};
const ids: Record<string, number> = {};
let deviceToken = "";

async function insertShift(userId: number, pages: string[], startedAt: string, endedAt: string): Promise<number> {
  const result = await testDb!.pool.query(
    `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages, pauses)
     values ($1, 'closed', $2::timestamptz, $3::timestamptz, 400, 300, $4::date, $5::jsonb, '[]'::jsonb) returning id`,
    [userId, startedAt, endedAt, startedAt.slice(0, 10),
      JSON.stringify(pages.map((pageLabel) => ({ pageLabel, activeMinutes: 200, messages: 150, salesFrom: startedAt })))],
  );
  return Number(result.rows[0].id);
}

function line(transactionId: number, pageLabel: string, amountMills: number, at: string): HandinVersionLine {
  return {
    transactionId, offPlatformId: null, group: "mine", pageLabel, kind: "message_purchase", occurredAt: at, netMills: amountMills,
    rule: { home: "shift", reason: "ppv_sender", shareMills: amountMills, toUserId: null, senderUserId: null },
    alreadyIn: null, statement: null, shareWithUserId: null, note: null, amountMills, added: false, disputed: false,
  };
}

const read = (who: string) => server!.inject({ method: "GET", url: URL, headers: { cookie: cookies[who]! } });

async function reportsOf(who: string): Promise<TeamShiftReportsResponse> {
  const response = await read(who);
  expect(response.statusCode, `${who}: ${response.body}`).toBe(200);
  return teamShiftReportsResponseSchema.parse(response.json());
}

describe("«Смены → Отчёты»: whose reports a reader sees, and how much of each", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    const db = app.db as Database;
    await createUserAccount(app, { username: "olga", role: "owner", password: "olga-password-for-tests" }, { source: "cli" });
    await createUserAccount(app, { username: "lena", role: "team_lead", password: "lena-password-for-tests" }, { source: "cli" });
    for (const name of ["anna", "boris", "cora", "stas"]) {
      await createUserAccount(app, { username: name, role: "chatter" }, { source: "cli" });
      await setUserPassword(app, { userId: await fixtureUserId(app, name), password: `${name}-password-for-tests` }, { source: "cli" });
    }
    for (const name of ["olga", "lena", "anna", "boris", "cora", "stas"]) ids[name] = await fixtureUserId(app, name);
    const alfa = await createModel(db, { slug: "alfa", name: "Alfa" });
    const bravo = await createModel(db, { slug: "bravo", name: "Bravo" });
    const alfa1 = (await createFanslyPage(db, { modelId: alfa!.id, label: "alfa-1" }))!.id;
    // A page of Alfa no login was granted: Anna works it by her team.
    await createFanslyPage(db, { modelId: alfa!.id, label: "alfa-2" });
    const bravo1 = (await createFanslyPage(db, { modelId: bravo!.id, label: "bravo-1" }))!.id;
    // Logins' own pages; the teams come from the people's working pages and Lena's record «ведёт команду» of Alfa.
    for (const [name, page] of [["anna", alfa1], ["boris", bravo1], ["cora", alfa1], ["cora", bravo1]] as const) {
      await assignUserToPage(db, ids[name]!, page);
    }
    const person = async (code: string, userId: number, pages: number[]) => {
      const row = await insertPersonRow(db, {
        code, displayName: code, kind: "human", role: "chatter", state: "working", leftOn: null, telegramUserId: null,
        telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
      });
      await insertPersonLogin(db, { personId: row.id, userId, linkedByUserId: null });
      for (const [position, page] of pages.entries()) await db.execute(sql`insert into person_working_pages (person_id, page_id, position) values (${row.id}, ${page}, ${position})`);
      return row.id;
    };
    await person("anna", ids.anna!, [alfa1]);
    await person("boris", ids.boris!, [bravo1]);
    await person("cora", ids.cora!, [alfa1, bravo1]);
    const lena = await person("lena", ids.lena!, []);
    await db.execute(sql`insert into team_roles (person_id, model_id, kind) values (${lena}, ${alfa!.id}, 'lead')`);

    // Cora's shift held a page of each team; its report: $40 on alfa-1, $60 on bravo-1, and $5 «мимо площадки» the
    // owner confirmed on alfa-1 — what the person and the owner see, never a colleague.
    const cora = await insertShift(ids.cora!, ["alfa-1", "bravo-1"], "2026-11-10T12:00:00Z", "2026-11-10T19:00:00Z");
    const handin = await ensureHandin(db, { shiftId: cora, userId: ids.cora!, personId: null, reportDate: "2026-11-10" });
    await insertHandinVersion(db, {
      handin, door: "workboard", actorUserId: ids.cora!, agentKeyId: null, telegramMessageRef: null, telegramSenderId: null,
      totalMills: 105_000,
      pages: [{ pageLabel: "alfa-1", amountMills: 45_000 }, { pageLabel: "bravo-1", amountMills: 60_000 }],
      lines: [line(9001, "alfa-1", 40_000, "2026-11-10T13:00:00Z"), line(9002, "bravo-1", 60_000, "2026-11-10T15:00:00Z")],
      offPlatform: [{ id: 1, amountMills: 5_000, fromWhom: "фан", whatFor: "кастом", state: "confirmed", pageLabel: "alfa-1" }],
      comment: "", modelComments: {}, dayPaid: null, ruleVersion: "test", reportDate: "2026-11-10", at: new Date("2026-11-10T19:10:00Z"),
    });
    ids.coraShift = cora;
    ids.borisShift = await insertShift(ids.boris!, ["bravo-1"], "2026-11-11T12:00:00Z", "2026-11-11T19:00:00Z");
    ids.annaShift = await insertShift(ids.anna!, ["alfa-2"], "2026-11-11T08:00:00Z", "2026-11-11T11:00:00Z");

    server = await buildApiServer(app);
    await server.ready();
    for (const name of ["olga", "lena", "anna", "boris", "stas"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: name, password: `${name}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[name] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
    deviceToken = (await issueDeviceTokenForUserId(app, { userId: ids.anna!, label: "ext", clientProfile: "chat-extension" })).token;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("gives the owner every team's reports, each whole", async (context) => {
    if (!testDb) return context.skip();
    const answer = await reportsOf("olga");
    expect(answer.reports.map((report) => report.shiftId).sort()).toEqual([ids.coraShift, ids.borisShift, ids.annaShift].sort());
    const cora = answer.reports.find((report) => report.shiftId === ids.coraShift)!;
    expect(cora.report).toMatchObject({ source: "version", number: 1, totalMills: 105_000, cut: false });
    expect(cora.report?.pages).toEqual([{ pageLabel: "alfa-1", amountMills: 45_000 }, { pageLabel: "bravo-1", amountMills: 60_000 }]);
    expect(cora.report?.parts).toMatchObject({ count: 2, mills: 100_000, byKind: { ppv: 100_000, tip: 0, subscription: 0, post: 0 } });
    expect(cora.pages).toEqual(["alfa-1", "bravo-1"]);
    // Nothing handed in: no report, no draft of anyone's.
    expect(answer.reports.find((report) => report.shiftId === ids.borisShift)).toMatchObject({ report: null, draftTotalMills: null, own: false });
    expect(answer.totals).toMatchObject({ shifts: 3, handedIn: 1, reportedMills: 105_000 });
  });

  it("gives a team lead their team's shifts only, a shared report cut to their pages, «мимо площадки» left out", async (context) => {
    if (!testDb) return context.skip();
    const answer = await reportsOf("lena");
    expect(answer.reports.map((report) => report.shiftId).sort()).toEqual([ids.coraShift, ids.annaShift].sort());
    const cora = answer.reports.find((report) => report.shiftId === ids.coraShift)!;
    expect(cora.report).toMatchObject({ totalMills: 40_000, cut: true, pages: [{ pageLabel: "alfa-1", amountMills: 40_000 }] });
    expect(cora.report?.parts.sales.map((sale) => sale.pageLabel)).toEqual(["alfa-1"]);
    expect(cora.pages).toEqual(["alfa-1"]);
    expect(answer.totals.reportedMills).toBe(40_000);
    expect(JSON.stringify(answer)).not.toContain("bravo-1");
  });

  it("gives a chatter their teams' shifts, a colleague's report cut to their pages, their own whole", async (context) => {
    if (!testDb) return context.skip();
    const anna = await reportsOf("anna");
    expect(anna.reports.map((report) => report.shiftId).sort()).toEqual([ids.coraShift, ids.annaShift].sort());
    expect(anna.reports.find((report) => report.shiftId === ids.coraShift)?.report).toMatchObject({ totalMills: 40_000, cut: true });
    expect(anna.reports.find((report) => report.shiftId === ids.annaShift)).toMatchObject({ own: true });
    const boris = await reportsOf("boris");
    expect(boris.reports.map((report) => report.shiftId).sort()).toEqual([ids.coraShift, ids.borisShift].sort());
    expect(boris.reports.find((report) => report.shiftId === ids.coraShift)?.report).toMatchObject({ totalMills: 60_000, cut: true, pages: [{ pageLabel: "bravo-1", amountMills: 60_000 }] });
    expect(JSON.stringify(boris)).not.toContain("alfa-");
  });

  it("gives someone of no team nothing, refuses a device token, and keeps a page asked for to that page", async (context) => {
    if (!testDb) return context.skip();
    const stranger = await reportsOf("stas");
    expect(stranger.reports).toEqual([]);
    expect(stranger.people).toEqual([]);
    const device = await server!.inject({ method: "GET", url: URL, headers: { authorization: `Bearer ${deviceToken}` } });
    expect([401, 403]).toContain(device.statusCode);
    // A page of another team is refused; the owner's page filter cuts the report to that page.
    expect((await server!.inject({ method: "GET", url: `${URL}&pageLabel=bravo-1`, headers: { cookie: cookies.anna! } })).statusCode).toBe(403);
    const page = await server!.inject({ method: "GET", url: `${URL}&pageLabel=alfa-1`, headers: { cookie: cookies.olga! } });
    expect(page.statusCode, page.body).toBe(200);
    const onPage = teamShiftReportsResponseSchema.parse(page.json());
    expect(onPage.reports.map((report) => report.shiftId)).toEqual([ids.coraShift]);
    expect(onPage.reports[0]?.report).toMatchObject({ totalMills: 40_000, cut: true });
  });
});
