import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { clientMattersResponseSchema, mattersListResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, listMatterChecks } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { runMattersMirror } from "../apps/runtime/src/services/matters-mirror.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// A chatter's post in «Отчётность» the ledger cannot accrue for a reason its
// author can fix (`report.post_fix`, ecosystem K follow-up): it waits for the
// author's own chatter login and for nobody else's session; it never carries a
// sum (a chatter's session never gets money); a person without a chatter login
// gets none; it closes itself when the ledger no longer flags the post; a ledger
// that does not answer leaves it «не проверено» and open.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const AUDIT = { source: "cli" } as const;
const PASSWORDS = { boss: "boss-secret", alice: "alice-secret", bob: "bob-secret" } as const;
let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const users: Record<string, number> = {};
const cookies: Record<string, string> = {};
let aliceToken = "";
let shiftId = 0;

const START = new Date("2026-11-12T12:00:00.000Z");
const SUM_MICROS = 123_450_000;

interface Post { id: number; person: string | null; date: string | null; flags: string[] }

/** The ledger as the mirror reads it: the reports, the report days, the flagged posts and the payouts. */
function ledger(posts: readonly Post[], options: { down?: boolean } = {}): typeof fetch {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return (async (input: string | URL | Request) => {
    if (options.down) return json({ error: "down" }, 503);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const window = { from: url.searchParams.get("from") ?? "2026-10-13", to: url.searchParams.get("to") ?? "2026-11-12" };
    if (url.pathname === "/v1/reports") return json({ ...window, reports: [] });
    if (url.pathname === "/v1/report-days") return json({ ...window, days: [] });
    if (url.pathname === "/v1/report-posts") {
      return json({
        ...window,
        posts: posts.map((post) => ({
          id: post.id, peer: "-1001", topic: 16, msg_id: post.id, posted_at: `${post.date ?? "2026-11-11"}T23:30:00+03:00`, sender: "Отправитель",
          tag: "#tag", person: post.person, model: "Lora", report_date: post.date, total_micros: SUM_MICROS, pages_micros: SUM_MICROS - 1_000_000,
          flags: post.flags, current: true, pages: [{ name: "Lora 1", page_label: "lora-1", page: "lora-1", in_shift: true, amount_micros: SUM_MICROS }],
        })),
      });
    }
    if (url.pathname === "/v1/payouts") {
      return json({
        ...window, accrualFrom: "2026-09-01", generatedAt: START.toISOString(), people: [], reportsFrom: "2026-11-09",
        checks: { stale: false, lastSheetsCollectAt: null, lastRebuildAt: null },
      });
    }
    if (url.pathname === "/v1/questions") return json({ questions: [] });
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
}

const fixable: Post[] = [
  { id: 701, person: "alice", date: "2026-11-10", flags: ["sum_mismatch"] },
  // Before the day the reports accrue from: the sheets paid it, nothing to fix.
  { id: 702, person: "alice", date: "2026-11-05", flags: ["sum_mismatch"] },
  // A person with no chatter login: nobody to tell.
  { id: 703, person: "nolog", date: null, flags: ["no_date"] },
  // What the author cannot fix (the ledger's setting): not theirs.
  { id: 704, person: "alice", date: "2026-11-11", flags: ["unknown_page"] },
  { id: 705, person: "alice", date: "2026-11-11", flags: ["duplicate"] },
];

async function open(prefix: string) {
  return (await testDb!.pool.query(
    "select reason_key, owner_user_id, owner_role, money, title, evidence::text as evidence, link from matters where state = 'open' and reason_key like $1 order by reason_key",
    [`${prefix}%`],
  )).rows;
}

describe("report.post_fix: the author's own post to fix", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    Object.assign(app.config, { ledgerUrl: "https://ledger.test", ledgerPayoutsKey: "test-payouts-key" });
    await createUserAccount(app, { username: "boss", role: "owner", password: PASSWORDS.boss }, AUDIT);
    for (const name of ["alice", "bob"] as const) {
      await createUserAccount(app, { username: name, role: "chatter" }, AUDIT);
      await setUserPassword(app, { userId: await fixtureUserId(app, name), password: PASSWORDS[name] }, AUDIT);
    }
    for (const name of ["boss", "alice", "bob"]) users[name] = await fixtureUserId(app, name);
    const model = await createModel(app.db, { slug: "lora", name: "Lora" });
    await createFanslyPage(app.db, { modelId: model!.id, label: "lora-1" });
    for (const name of ["alice", "bob"]) await assignPageToUser(app, { userId: users[name]!, pageLabel: "lora-1" }, AUDIT);
    for (const [code, userId] of [["alice", users.alice], ["bob", users.bob], ["nolog", null]] as const) {
      const person = await testDb.pool.query(
        "insert into people (code, display_name, kind, role, state, origin) values ($1, $1, 'human', 'chatter', 'working', 'owner') returning id", [code],
      );
      if (userId !== null) await testDb.pool.query("insert into person_logins (user_id, person_id) values ($1, $2)", [userId, person.rows[0].id]);
    }
    const shift = await testDb.pool.query(
      `insert into shifts (user_id, state, started_at, ended_at, worked_minutes, messages, report_date)
       values ($1, 'closed', '2026-11-10T15:00:00Z', '2026-11-10T23:00:00Z', 480, 120, '2026-11-10') returning id`, [users.alice],
    );
    shiftId = Number(shift.rows[0].id);

    server = await buildApiServer(app);
    await server.ready();
    for (const name of ["boss", "alice", "bob"] as const) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: name, password: PASSWORDS[name] } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[name] = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
    }
    aliceToken = (await issueDeviceTokenForUserId(app, { userId: users.alice!, label: "alice client" })).token;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("opens one matter per fixable post of the accrued days for the author's chatter login, never with a sum", async (context) => {
    if (!testDb) return context.skip();
    const tally = await runMattersMirror(app, { now: START, fetchImpl: ledger(fixable) });
    expect(tally.answered).toContain("report.post_fix");
    const rows = await open("report.post_fix:");
    expect(rows.map((row) => [row.reason_key, Number(row.owner_user_id), row.owner_role, row.money])).toEqual([
      ["report.post_fix:701", users.alice, null, false],
      ["report.post_fix:705", users.alice, null, false],
    ]);
    expect(rows[0].title).toContain("Отчёт за 10 нояб. не начислен");
    expect(rows[0].link).toBe(`/workboard/my/shifts/${shiftId}`);
    expect(rows[1].link).toBe("/workboard/my/shifts");
    // No sum anywhere a chatter reads: neither the post's total, nor its lines.
    for (const row of rows) {
      const text = `${row.title as string} ${row.evidence as string}`;
      for (const forbidden of ["123", "122", "Micros", "Mills", "micros", "mills", "$"]) expect(text).not.toContain(forbidden);
    }
  });

  it("reaches the author's session and the author's icon, and nobody else's session", async (context) => {
    if (!testDb) return context.skip();
    const keys = async (who: string) => mattersListResponseSchema.parse((await server!.inject({
      method: "GET", url: "/api/v1/matters?kind=report.post_fix", headers: { cookie: cookies[who]! },
    })).json()).matters.map((one) => [one.key, one.mine] as const).sort();
    expect(await keys("alice")).toEqual([["report.post_fix:701", true], ["report.post_fix:705", true]]);
    expect(await keys("bob")).toEqual([]);
    // The owner reads them as oversight: they wait for the author, not for him.
    expect(await keys("boss")).toEqual([["report.post_fix:701", false], ["report.post_fix:705", false]]);
    const client = clientMattersResponseSchema.parse((await server!.inject({
      method: "GET", url: "/api/v1/client/matters", headers: { authorization: `Bearer ${aliceToken}` },
    })).json());
    expect(client.count).toBe(2);
  });

  it("closes when the ledger no longer flags the post; a ledger that does not answer leaves it open and «не проверено»", async (context) => {
    if (!testDb) return context.skip();
    const later = new Date(START.getTime() + 6 * 60_000);
    await runMattersMirror(app, { now: later, fetchImpl: ledger(fixable.filter((post) => post.id !== 701)) });
    const closed = await testDb.pool.query("select state, closed_how from matters where reason_key = 'report.post_fix:701'");
    expect(closed.rows[0]).toEqual({ state: "closed", closed_how: "cause_gone" });
    expect((await open("report.post_fix:")).map((row) => row.reason_key)).toEqual(["report.post_fix:705"]);

    const down = new Date(START.getTime() + 12 * 60_000);
    const tally = await runMattersMirror(app, { now: down, fetchImpl: ledger([], { down: true }) });
    expect(tally.failed).toContain("report.post_fix");
    expect((await open("report.post_fix:")).map((row) => row.reason_key)).toEqual(["report.post_fix:705"]);
    const check = (await listMatterChecks(app.db)).find((one) => one.kind === "report.post_fix");
    expect(check?.error).not.toBeNull();
    expect(check?.attemptedAt.getTime()).toBeGreaterThan(check?.answeredAt?.getTime() ?? 0);
  });
});
