import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { accountShiftReportResponseSchema, teamShiftExportResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, createOnlyFansPage, listSaleFacts, upsertTransaction } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { assignPageToUser, createUserAccount, setUserPassword, unassignPageFromUser } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The draft shift report (Chat Memory week 4, week-4.md §2): money. Two
// overlapping shifts on ari-1 both see the sales of the overlap; each chatter
// marks them; a confirmed report credits «моё» whole and an agreed «делим» in
// halves; two «моё» are a dispute the export leaves out until the owner splits
// it. On lilly-2: shifts across Moscow midnight, a «делим» with a partner out of
// shift, a sale that came after the confirmation, the own amount's cap and a
// page taken away.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let pageId = 0;
let lillyId = 0;
const users: Record<string, number> = {};
const cookies: Record<string, string> = {};
const sales: Record<string, string> = {};

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const HOUR = 3_600_000;

async function activityAt(user: string, page: number, from: number, to: number) {
  await q(`insert into chatter_activity_minutes (user_id, page_id, minute, input)
           select $1, $2, minute, true from generate_series($3::timestamptz, $4::timestamptz, interval '1 minute') minute`,
    [users[user], page, new Date(from).toISOString(), new Date(to).toISOString()]);
}

async function saleAt(name: string, page: number, input: { netMills: bigint; at: number; fanId: number }) {
  await upsertTransaction(app.db, {
    platformAccountId: page, source: "fansly:rest", fanId: input.fanId, transactionId: `shift-${name}`, rawType: "7001",
    canonicalType: "tip", transactionState: "posted", rawStatus: "ok", grossAmountMills: input.netMills * 5n / 4n,
    sourceDestinationAmountMills: input.netMills * 5n / 4n, creatorNetAmountMills: input.netMills, occurredAt: new Date(input.at),
  });
  sales[name] = String((await q("select id from transactions where transaction_id = $1", [`shift-${name}`])).rows[0].id);
}

async function activity(user: string, fromHoursAgo: number, toHoursAgo: number) {
  await q(`insert into chatter_activity_minutes (user_id, page_id, minute, input)
           select $1, $2, minute, true from generate_series(
             date_trunc('minute', now() - interval '1 hour' * $3), date_trunc('minute', now() - interval '1 hour' * $4), interval '1 minute') minute`,
    [users[user], pageId, fromHoursAgo, toHoursAgo]);
}

async function sale(name: string, input: { kind: "tip" | "message_purchase"; netMills: bigint; hoursAgo: number; fanId: number }) {
  await upsertTransaction(app.db, {
    platformAccountId: pageId, source: "fansly:rest", fanId: input.fanId, transactionId: `shift-${name}`, rawType: "7001",
    canonicalType: input.kind, transactionState: "posted", rawStatus: "ok", grossAmountMills: input.netMills * 5n / 4n,
    sourceDestinationAmountMills: input.netMills * 5n / 4n, creatorNetAmountMills: input.netMills, occurredAt: new Date(Date.now() - input.hoursAgo * HOUR),
  });
  sales[name] = String((await q("select id from transactions where transaction_id = $1", [`shift-${name}`])).rows[0].id);
}

const as = (user: string) => ({ cookie: cookies[user]! });
const report = async (user: string) => {
  const response = await server!.inject({ method: "GET", url: "/api/v1/account/shift-report?days=2", headers: as(user) });
  expect(response.statusCode, response.body).toBe(200);
  return accountShiftReportResponseSchema.parse(response.json());
};
const mark = (user: string, payload: object) => server!.inject({ method: "POST", url: "/api/v1/account/shift-report/marks", headers: as(user), payload });
const confirm = (user: string, startedAt: string) =>
  server!.inject({ method: "POST", url: "/api/v1/account/shift-report/confirm", headers: as(user), payload: { startedAt } });
const moscowDay = (at: number) => new Date(at + 3 * HOUR).toISOString().slice(0, 10);
const exportOf = async (from: string, to: string, page: string) => {
  const response = await server!.inject({ method: "GET", url: `/api/v1/team/shift-reports/export?from=${from}&to=${to}`, headers: as("owner") });
  expect(response.statusCode, response.body).toBe(200);
  const body = teamShiftExportResponseSchema.parse(response.json());
  const rows = body.rows.filter((row) => row.pageLabel === page);
  const credited: Record<string, number> = {};
  for (const row of rows) credited[row.username] = (credited[row.username] ?? 0) + row.creditedMills;
  return { body, credited };
};
const exportRows = async () => {
  const { body, credited } = await exportOf(moscowDay(Date.now() - 24 * HOUR), moscowDay(Date.now()), "ari-1");
  return { disputedOpen: body.disputedOpen, credited };
};

describe("the draft shift report", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    for (const [username, role] of [["owner", "owner"], ["nikita", "chatter"], ["vanya", "chatter"], ["kolya", "chatter"], ["petya", "chatter"]] as const) {
      await createUserAccount(app, role === "owner" ? { username, role, password: `${username}-password-for-tests` } : { username, role }, { source: "cli" });
      users[username] = await fixtureUserId(app, username);
      if (role !== "owner") await setUserPassword(app, { userId: users[username]!, password: `${username}-password-for-tests` }, { source: "cli" });
    }
    const ari = await createModel(app.db, { slug: "ari", name: "Ari" });
    pageId = (await createFanslyPage(app.db, { modelId: ari!.id, label: "ari-1" }))!.id;
    for (const user of ["nikita", "vanya"]) await assignPageToUser(app, { userId: users[user]!, pageLabel: "ari-1" }, { source: "cli" });
    const lilly = await createModel(app.db, { slug: "lilly", name: "Lilly" });
    lillyId = (await createFanslyPage(app.db, { modelId: lilly!.id, label: "lilly-2" }))!.id;
    for (const user of ["kolya", "petya"]) await assignPageToUser(app, { userId: users[user]!, pageLabel: "lilly-2" }, { source: "cli" });
    const fanId = Number((await q("insert into fans (platform, platform_user_id, username) values ('fansly', '7100000001', 'bigtipper') returning id")).rows[0].id);

    // Никита 6–3 hours ago, Ваня 4–2 hours ago: they overlap 4–3 hours ago.
    await activity("nikita", 6, 3);
    await activity("vanya", 4, 2);
    await sale("early", { kind: "tip", netMills: 80_000n, hoursAgo: 5, fanId });
    await sale("ppv", { kind: "message_purchase", netMills: 20_000n, hoursAgo: 3.5, fanId });
    await sale("late", { kind: "tip", netMills: 10_000n, hoursAgo: 3.2, fanId });
    // Ваня wrote to the fan before the PPV sale.
    await q(`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at)
             values ('fansly', $1, '9600000001', '7100000001', $2, 'fansly-extension', true, true, now() - interval '3.6 hours')`, [pageId, users.vanya]);

    server = await buildApiServer(app);
    await server.ready();
    for (const user of ["owner", "nikita", "vanya", "kolya", "petya"]) {
      const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: user, password: `${user}-password-for-tests` } });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      cookies[user] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
    }
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("credits marks of confirmed shifts and keeps a dispute out of the export until the owner splits it", async (context) => {
    if (!testDb || !server) return context.skip();
    const nikita = await report("nikita");
    expect(nikita.shifts).toHaveLength(1);
    const shift = nikita.shifts[0]!;
    expect(shift.sales.map((one) => one.saleRef)).toEqual([sales.early, sales.ppv, sales.late]);
    expect(shift.sales[1]!.writers).toEqual([{ username: "vanya", messages: 1 }]);
    expect(nikita.teammates.map((one) => one.username)).toEqual(["vanya"]);
    // The overlap's sales are in Ваня's shift too.
    expect((await report("vanya")).shifts[0]!.sales.map((one) => one.saleRef)).toEqual([sales.ppv, sales.late]);

    expect((await mark("nikita", { saleRef: sales.early, mark: "mine" })).statusCode).toBe(200);
    expect((await confirm("nikita", shift.startedAt)).json()).toMatchObject({ reason: "unmarked" });
    expect((await mark("nikita", { saleRef: sales.ppv, mark: "share" })).statusCode).toBe(400);
    expect((await mark("nikita", { saleRef: sales.ppv, mark: "share", shareWithUserId: users.vanya })).statusCode).toBe(200);
    expect((await mark("nikita", { saleRef: sales.late, mark: "mine" })).statusCode).toBe(200);
    // 80 + half of 20 + 10.
    expect((await report("nikita")).shifts[0]!.creditedMills).toBe(100_000);
    expect((await confirm("nikita", shift.startedAt)).json()).toMatchObject({ changed: true });
    expect((await confirm("nikita", shift.startedAt)).json()).toMatchObject({ changed: false });
    expect((await mark("nikita", { saleRef: sales.late, mark: "not_mine" })).json()).toMatchObject({ reason: "confirmed" });

    const vanya = (await report("vanya")).shifts[0]!;
    await mark("vanya", { saleRef: sales.ppv, mark: "share", shareWithUserId: users.nikita });
    await mark("vanya", { saleRef: sales.late, mark: "mine", amountMills: 9_000 });
    expect((await confirm("vanya", vanya.startedAt)).json()).toMatchObject({ changed: true });

    // Both said «моё» on the late tip: out of the export, Никита 80 + 10, Ваня 10.
    expect(await exportRows()).toEqual({ disputedOpen: 1, credited: { nikita: 90_000, vanya: 10_000 } });
    const disputes = await server.inject({ method: "GET", url: "/api/v1/team/shift-reports/disputes", headers: as("owner") });
    expect(disputes.json().disputes).toEqual([expect.objectContaining({ saleRef: sales.late, reason: "two_mine", resolution: null })]);

    const resolve = (user: string, shares: object[], saleRef = sales.late) => server!.inject({
      method: "POST", url: `/api/v1/team/shift-reports/disputes/${saleRef}`, headers: as(user), payload: { shares },
    });
    expect((await resolve("vanya", [{ userId: users.vanya, percent: 100 }])).statusCode).toBe(403);
    expect((await resolve("owner", [{ userId: users.vanya, percent: 60 }])).statusCode).toBe(400);
    expect((await resolve("owner", [{ userId: users.vanya, percent: 100 }], sales.ppv)).json()).toMatchObject({ reason: "not_disputed" });
    expect((await resolve("owner", [{ userId: users.vanya, percent: 100 }])).statusCode).toBe(200);
    // The owner's split counts the late tip's net to Ваня.
    expect(await exportRows()).toEqual({ disputedOpen: 0, credited: { nikita: 90_000, vanya: 20_000 } });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("pays each sale once across midnight, a «делим» with a partner out of shift, a late sale, and only on the pages one works", async (context) => {
    if (!testDb || !server) return context.skip();
    // A Moscow midnight at least three hours ago: Коля 23:00–01:00, Петя 00:00–02:00.
    let midnight = Math.floor((Date.now() + 3 * HOUR) / (24 * HOUR)) * 24 * HOUR - 3 * HOUR;
    if (Date.now() - midnight < 3 * HOUR) midnight -= 24 * HOUR;
    const fanId = Number((await q("insert into fans (platform, platform_user_id, username) values ('fansly', '7100000002', 'nightowl') returning id")).rows[0].id);
    await activityAt("kolya", lillyId, midnight - HOUR, midnight + HOUR);
    await activityAt("petya", lillyId, midnight, midnight + 2 * HOUR);
    await saleAt("night-both", lillyId, { netMills: 100_000n, at: midnight + 30 * 60_000, fanId });
    await saleAt("night-before", lillyId, { netMills: 40_000n, at: midnight - 30 * 60_000, fanId });
    const [dayBefore, dayAfter] = [moscowDay(midnight - HOUR), moscowDay(midnight)];
    const lillyReport = async (user: string) => (await server!.inject({ method: "GET", url: "/api/v1/account/shift-report?days=3", headers: as(user) }))
      .json() as { shifts: Array<{ startedAt: string; pages: string[]; pending: number }>; sharedWithMe: Array<{ saleRef: string }> };
    const shiftOf = async (user: string) => (await lillyReport(user)).shifts.find((one) => one.pages.includes("lilly-2"))!;

    // Both «моё» on the tip after midnight; Коля shares the one before it with Петя, who agrees from «С тобой делят».
    await mark("kolya", { saleRef: sales["night-both"], mark: "mine" });
    await mark("petya", { saleRef: sales["night-both"], mark: "mine" });
    expect((await mark("kolya", { saleRef: sales["night-before"], mark: "share", shareWithUserId: users.petya })).statusCode).toBe(200);
    expect((await lillyReport("petya")).sharedWithMe.map((one) => one.saleRef)).toEqual([sales["night-before"]]);
    expect((await mark("petya", { saleRef: sales["night-before"], mark: "share", shareWithUserId: users.kolya })).statusCode).toBe(200);
    expect((await confirm("kolya", (await shiftOf("kolya")).startedAt)).json()).toMatchObject({ changed: true });
    expect((await confirm("petya", (await shiftOf("petya")).startedAt)).json()).toMatchObject({ changed: true });
    const split = await server.inject({
      method: "POST", url: `/api/v1/team/shift-reports/disputes/${sales["night-both"]}`, headers: as("owner"),
      payload: { shares: [{ userId: users.kolya, percent: 50 }, { userId: users.petya, percent: 50 }] },
    });
    expect(split.statusCode, split.body).toBe(200);

    // A tip that synced after both confirmed: Коля marks it (not above its net) and confirms again.
    await saleAt("night-late", lillyId, { netMills: 10_000n, at: midnight + 45 * 60_000, fanId });
    expect((await shiftOf("kolya")).pending).toBe(1);
    expect((await mark("kolya", { saleRef: sales["night-late"], mark: "mine", amountMills: 10_001 })).json()).toMatchObject({ reason: "amount_above_net" });
    expect((await mark("kolya", { saleRef: sales["night-late"], mark: "mine" })).statusCode).toBe(200);
    expect((await confirm("kolya", (await shiftOf("kolya")).startedAt)).json()).toMatchObject({ changed: true });
    expect((await mark("kolya", { saleRef: sales["night-late"], mark: "not_mine" })).json()).toMatchObject({ reason: "confirmed" });

    // The day of Коля's shift holds all three; the day after holds none of them — nothing is paid twice.
    expect((await exportOf(dayBefore, dayBefore, "lilly-2")).credited).toEqual({ kolya: 50_000 + 20_000 + 10_000, petya: 50_000 + 20_000 });
    expect((await exportOf(dayAfter, dayAfter, "lilly-2")).credited).toEqual({});

    // Taken off lilly-2, Петя no longer sees its shifts or marks its sales.
    await unassignPageFromUser(app, { userId: users.petya!, pageLabel: "lilly-2" }, { source: "cli" });
    expect((await lillyReport("petya")).shifts).toEqual([]);
    expect((await mark("petya", { saleRef: sales["night-late"], mark: "mine" })).statusCode).toBe(404);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  async function chatterOn(username: string, pages: string[]) {
    await createUserAccount(app, { username, role: "chatter" }, { source: "cli" });
    users[username] = await fixtureUserId(app, username);
    await setUserPassword(app, { userId: users[username]!, password: `${username}-password-for-tests` }, { source: "cli" });
    for (const pageLabel of pages) await assignPageToUser(app, { userId: users[username]!, pageLabel }, { source: "cli" });
    const login = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: `${username}-password-for-tests` } });
    const header = login.headers["set-cookie"];
    cookies[username] = String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
  }

  it("keeps a sale on one day whoever confirms first, and lists the later shift holding it until it is confirmed", async (context) => {
    if (!testDb || !server) return context.skip();
    // A Moscow midnight M at least 14 hours ago. A: M−0:04 … M+12:53; B: M+5:46 … M+8:33 inside it; a tip at M+6:30
    // that B marks «моё» and A «не моё». The tip's day is A's: the day before M, in both orders.
    let midnight = Math.floor((Date.now() + 3 * HOUR) / (24 * HOUR)) * 24 * HOUR - 3 * HOUR;
    while (Date.now() - midnight < 14 * HOUR) midnight -= 24 * HOUR;
    const [dayBefore, dayAfter] = [moscowDay(midnight - HOUR), moscowDay(midnight)];
    const MIN = 60_000;
    const shiftOf = async (user: string, page: string) => ((await server!.inject({ method: "GET", url: "/api/v1/account/shift-report?days=3", headers: as(user) }))
      .json() as { shifts: Array<{ startedAt: string; pages: string[] }> }).shifts.find((one) => one.pages.includes(page))!;
    const run = async (order: "a-first" | "b-first", n: number) => {
      const label = `order-${n}`;
      const model = await createModel(app.db, { slug: label, name: label });
      const page = (await createFanslyPage(app.db, { modelId: model!.id, label }))!.id;
      const [a, b] = [`a${n}`, `b${n}`];
      await chatterOn(a, [label]);
      await chatterOn(b, [label]);
      await activityAt(a, page, midnight - 4 * MIN, midnight + 12 * HOUR + 53 * MIN);
      await activityAt(b, page, midnight + 5 * HOUR + 46 * MIN, midnight + 8 * HOUR + 33 * MIN);
      const fanId = Number((await q(`insert into fans (platform, platform_user_id, username) values ('fansly', $1, $2) returning id`, [`72000000${n}`, `fan${n}`])).rows[0].id);
      await saleAt(label, page, { netMills: 40_000n, at: midnight + 6 * HOUR + 30 * MIN, fanId });
      await mark(a, { saleRef: sales[label], mark: "not_mine" });
      await mark(b, { saleRef: sales[label], mark: "mine" });
      const unconfirmedOf = async (day: string) => (await exportOf(day, day, label)).body.unconfirmed
        .filter((shift) => shift.username === a || shift.username === b).map((shift) => shift.username);
      const first = order === "a-first" ? a : b;
      const second = order === "a-first" ? b : a;
      expect((await confirm(first, (await shiftOf(first, label)).startedAt)).json()).toMatchObject({ changed: true });
      // Before the second confirmation: nothing on the day after; the day before names the unconfirmed shift.
      expect((await exportOf(dayAfter, dayAfter, label)).credited).toEqual({});
      expect(await unconfirmedOf(dayBefore)).toEqual([second]);
      expect((await exportOf(dayBefore, dayBefore, label)).credited).toEqual(order === "a-first" ? {} : { [b]: 40_000 });
      expect((await confirm(second, (await shiftOf(second, label)).startedAt)).json()).toMatchObject({ changed: true });
      // After both: the same exports, whatever the order.
      expect((await exportOf(dayBefore, dayBefore, label)).credited).toEqual({ [b]: 40_000 });
      expect((await exportOf(dayAfter, dayAfter, label)).credited).toEqual({});
      expect(await unconfirmedOf(dayBefore)).toEqual([]);
    };
    await run("a-first", 1);
    await run("b-first", 2);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("credits a confirmed shift in the cabinet only on the pages the chatter still works", async (context) => {
    if (!testDb || !server) return context.skip();
    const model = await createModel(app.db, { slug: "two-pages", name: "Two pages" });
    const [one, two] = [
      (await createFanslyPage(app.db, { modelId: model!.id, label: "page-one" }))!.id,
      (await createFanslyPage(app.db, { modelId: model!.id, label: "page-two" }))!.id,
    ];
    await chatterOn("sasha", ["page-one", "page-two"]);
    const start = Date.now() - 5 * HOUR;
    for (const page of [one, two]) await activityAt("sasha", page, start, start + 2 * HOUR);
    const fanId = Number((await q("insert into fans (platform, platform_user_id, username) values ('fansly', '7200000099', 'both') returning id")).rows[0].id);
    await saleAt("page-one-tip", one, { netMills: 10_000n, at: start + HOUR, fanId });
    await saleAt("page-two-tip", two, { netMills: 30_000n, at: start + HOUR, fanId });
    for (const name of ["page-one-tip", "page-two-tip"]) await mark("sasha", { saleRef: sales[name], mark: "mine" });
    const shift = async () => ((await server!.inject({ method: "GET", url: "/api/v1/account/shift-report?days=2", headers: as("sasha") }))
      .json() as { shifts: Array<{ startedAt: string; creditedMills: number }> }).shifts[0]!;
    expect((await confirm("sasha", (await shift()).startedAt)).json()).toMatchObject({ changed: true });
    expect((await shift()).creditedMills).toBe(40_000);
    await unassignPageFromUser(app, { userId: users.sasha!, pageLabel: "page-two" }, { source: "cli" });
    expect((await shift()).creditedMills).toBe(10_000);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("pairs two OnlyFans purchases of one price with their own PPVs and authors", async (context) => {
    if (!testDb || !server) return context.skip();
    // Unlocks at T (Ваня's PPV) and T+1:00 (Никита's), both $10; purchases at T+0:20 and T+0:25. Each nearest-in-time
    // pick would give both purchases Ваня's message; one to one, the second is Никита's.
    const model = await createModel(app.db, { slug: "of-pair", name: "OF pair" });
    const page = (await createOnlyFansPage(app.db, { modelId: model!.id, label: "of-pair" }))!.id;
    const fanId = Number((await q("insert into fans (platform, platform_user_id, username) values ('onlyfans', '600001', 'twin') returning id")).rows[0].id);
    const thread = Number((await q(
      `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id, stored_message_count,
         message_coverage_status, last_message_at, oldest_stored_message_id, newest_stored_message_id)
       values ($1, $2, '600001', '600001', 2, 'complete', now() - interval '1 hour', '7100000001', '7100000002') returning id`, [page, fanId])).rows[0].id);
    const unlockAt = Date.now() - HOUR;
    for (const [ref, author, offset] of [["7100000001", "vanya", 0], ["7100000002", "nikita", 60_000]] as const) {
      await q(`insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, price_mills)
               values ($1, 'onlyfans', '600001', $2, 'model', true, $3, 'ppv', 10000)`, [page, ref, new Date(unlockAt - 2 * HOUR)]);
      await q(`insert into page_dm_messages (conversation_id, platform_account_id, platform_message_id, sender_platform_user_id, sender_role, created_at,
                 content, purchased_at)
               values ($1, $2, $3, '1', 'model', $4, 'ppv', $5)`, [thread, page, ref, new Date(unlockAt - 2 * HOUR), new Date(unlockAt + offset)]);
      await q(`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at)
               values ('onlyfans', $1, $2, '600001', $3, 'chatspace-extension', true, true, $4)`, [page, ref, users[author], new Date(unlockAt - 2 * HOUR)]);
    }
    const ids: number[] = [];
    for (const [id, offset] of [["of-pair-1", 20_000], ["of-pair-2", 25_000]] as const) {
      await upsertTransaction(app.db, {
        platformAccountId: page, source: "ofapi:webhook", fanId, transactionId: id, rawType: "message",
        canonicalType: "message_purchase", transactionState: "posted", rawStatus: "ok", grossAmountMills: 10_000n,
        sourceDestinationAmountMills: 10_000n, creatorNetAmountMills: 8_000n, occurredAt: new Date(unlockAt + offset),
      });
      ids.push(Number((await q("select id from transactions where transaction_id = $1", [id])).rows[0].id));
    }
    const facts = await listSaleFacts(app.db, { transactionIds: ids });
    expect(ids.map((id) => facts.find((fact) => fact.transactionId === id)?.ppvSender?.username)).toEqual(["vanya", "nikita"]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
