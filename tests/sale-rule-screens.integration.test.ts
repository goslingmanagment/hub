import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel, setSaleRuleSwitch } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount, type HumanAuthPrincipal } from "../apps/runtime/src/services/auth.ts";
import { computeChatterStats } from "../apps/runtime/src/services/chatter-stats.ts";
import { readShiftReportNotes } from "../apps/runtime/src/services/shift-report-notes.ts";
import { teamShiftSalesOf, teamShiftSalesRead } from "../apps/runtime/src/services/team-shift-sales.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The screens' switch to the one rule on a fixture: off, «Смены» and «Мои смены» answer as before (a junction sale
// nobody wrote to counts for both, no field of the rule appears); on from the day, the junction sale counts once — the
// owner's to decide, «вне смен» — and the team's total is every sale once; on from a later day, the day stays as it was.
// And what stands between a day's shifts by the rule and the report it is paid by (`shiftReportNotes`): a sale no line
// of the person's reports pays is said, one paid in a later report is not, and only the owner reads everyone's days.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let first = 0;
let second = 0;
const DAY = 86_400_000;
const now = new Date();
// Three Moscow days back, 10:00–14:00 and 13:00–17:00: an hour both shifts hold the page.
const day = new Date(now.getTime() + 3 * 3_600_000 - 3 * DAY).toISOString().slice(0, 10);
const msk = (time: string) => new Date(`${day}T${time}:00+03:00`);
const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);

async function shift(userId: number, from: string, to: string, base: number) {
  await q(`insert into chatter_activity_minutes (user_id, page_id, minute, input)
           select $1, $2, minute, true from generate_series($3::timestamptz, $4::timestamptz, interval '1 minute') minute`, [userId, pageId, msk(from), msk(to)]);
  // A message every four minutes, to another fan than the buyers': nobody wrote to them.
  await q(`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
           select 'fansly', $1, ($2::bigint + n)::text, '7600000099', $3, 'fansly-extension', false, false, $4::timestamptz + interval '4 minutes' * n, 'hand'
           from generate_series(0, 59) n where $4::timestamptz + interval '4 minutes' * n < $5::timestamptz`, [pageId, base, userId, msk(from), msk(to)]);
}

async function tip(ref: string, net: number, time: string) {
  const fan = Number((await q("insert into fans (platform, platform_user_id, username) values ('fansly', $1, $1) returning id", [`76000${ref}`])).rows[0].id);
  await q(`insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status, gross_amount_mills,
             source_destination_amount_mills, creator_net_amount_mills, occurred_at, source)
           values ($1, $2, $3, '7101', 'tip', 'pending', 'test', $4, $4, $4, $5, 'fansly:rest')`, [pageId, fan, `screens-${ref}`, net, msk(time)]);
}

const read = () => teamShiftSalesOf(app.db, { days: 7, until: nextDay, now, pages: "all" });

describe("the screens' switch to the one rule", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    const model = await createModel(app.db, { slug: "screens", name: "Screens" });
    pageId = (await createFanslyPage(app.db, { modelId: model!.id, label: "screens-a" }))!.id;
    await createUserAccount(app, { username: "screens-first", role: "chatter" }, { source: "cli" });
    await createUserAccount(app, { username: "screens-second", role: "chatter" }, { source: "cli" });
    first = await fixtureUserId(app, "screens-first");
    second = await fixtureUserId(app, "screens-second");
    await shift(first, "10:00", "14:00", 9_600_000_000);
    await shift(second, "13:00", "17:00", 9_600_001_000);
    await tip("1", 10_000, "11:00");
    await tip("2", 30_000, "13:30");
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("answers as before while it is off", async (context) => {
    if (!testDb) return context.skip();
    const off = await read();
    const byUser = new Map(off.chatters.map((one) => [one.userId, one]));
    expect(byUser.get(first)).toMatchObject({ salesNetMills: 40_000, overlapNetMills: 30_000 });
    expect(byUser.get(second)).toMatchObject({ salesNetMills: 30_000, overlapNetMills: 30_000 });
    expect(off.team.salesNetMills).toBe(40_000);
    // Not one field of the rule: the answer is the old one, byte for byte.
    const text = JSON.stringify(off);
    for (const key of ["ruleFrom", "potNetMills", "waitingNetMills", "decideNetMills", "\"home\""]) expect(text).not.toContain(key);
    expect(JSON.stringify((await teamShiftSalesRead(app.db, { days: 7, until: nextDay, now, pages: "all", rule: null })).response)).toBe(text);
    const stats = await computeChatterStats(app.db, { userId: first, username: "screens-first", pages: [{ pageId, label: "screens-a", platform: "fansly" }], days: 7, until: nextDay, now });
    expect(stats.totals).toMatchObject({ salesNetMills: 40_000, overlapNetMills: 30_000 });
    expect(JSON.stringify(stats)).not.toContain("ruleFrom");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("counts the junction sale once from the switch's day, and leaves the days before it alone", async (context) => {
    if (!testDb) return context.skip();
    const off = await read();
    // From the day after: this day is before the switch, its money as before.
    await setSaleRuleSwitch(app.db, { screensFrom: nextDay, setBy: "test", at: now });
    const later = await read();
    expect(later.ruleFrom).toBe(nextDay);
    expect(later.chatters).toEqual(off.chatters);
    expect(later.team).toEqual(off.team);
    expect(later.shifts).toEqual(off.shifts);

    await setSaleRuleSwitch(app.db, { screensFrom: day, setBy: "test", at: now });
    const on = await read();
    const byUser = new Map(on.chatters.map((one) => [one.userId, one]));
    // No slot, nobody of the holders wrote to the fan: the owner decides; counted for nobody yet, never for both.
    expect(byUser.get(first)).toMatchObject({ salesNetMills: 10_000, overlapNetMills: 0 });
    expect(byUser.get(second)).toMatchObject({ salesNetMills: 0, overlapNetMills: 0 });
    expect(on.team.salesNetMills).toBe(10_000);
    expect(on.outside).toMatchObject({ decideNetMills: 30_000, nobodyNetMills: 0, potNetMills: 0 });
    expect(on.outside.sales).toEqual([expect.objectContaining({ netMills: 30_000, home: "decide" })]);
    expect(on.team.salesNetMills + (on.outside.decideNetMills ?? 0)).toBe(40_000);
    const stats = await computeChatterStats(app.db, { userId: first, username: "screens-first", pages: [{ pageId, label: "screens-a", platform: "fansly" }], days: 7, until: nextDay, now });
    expect(stats.totals).toMatchObject({ salesNetMills: 10_000, overlapNetMills: 0 });
    expect(stats.ruleFrom).toBe(day);
    await setSaleRuleSwitch(app.db, { screensFrom: null, setBy: "test", at: now });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("says what stands between a day's shifts and its report: a sale in no report, never one paid later; a chatter their own", async (context) => {
    if (!testDb) return context.skip();
    Object.assign(app.config, { ledgerUrl: "https://ledger.test", ledgerPayoutsKey: "test-payouts-key" });
    const saleId = Number((await q("select id from transactions where transaction_id = 'screens-1'")).rows[0].id);
    const session = (id: number, username: string, role: string, extra: object = {}) => ({
      authMethod: "session", authSessionId: 1, user: { id, username, role }, assignedPageIds: [pageId], ...extra,
    }) as unknown as HumanAuthPrincipal;
    // The owner reads everyone's days: whose login it is does not matter.
    const owner = session(first + second + 1_000, "screens-owner", "owner");
    // A line of a saved breakdown, as the ledger's GET /v1/reports serves it.
    const line = (ref: string | null, netMills: number, what = "") => ({
      n: null, transaction_ref: ref, page: "screens-a", fan_ref: "", fan_name: "", kind: "tip", occurred_at: null, net_micros: netMills * 1000,
      counted: true, added: what !== "", what, flags: null, notes: null, ppv_author: "", ppv_sent_at: "",
    });
    const report = (id: number, reportDate: string, lines: Array<ReturnType<typeof line>>, postedMills?: number) => {
      const total = lines.reduce((sum, one) => sum + one.net_micros, 0);
      return {
        id, person: "first", hub_username: "screens-first", hub_user_id: first, chatter: "first", report_date: reportDate,
        window_from: `${reportDate}T10:00:00+03:00`, window_to: `${reportDate}T14:00:00+03:00`, cut_at: `${reportDate}T13:50:00+03:00`,
        version: 1, versions: 1, status: "posted", source: "agent", total_micros: total, created_at: `${reportDate}T14:05:00+03:00`, posted_at: null,
        pages: [{ page: "screens-a", model: "", amount_micros: total, posted_micros: postedMills === undefined ? total : postedMills * 1000, post_state: "posted_equal" }],
        lines,
      };
    };
    const asked: string[] = [];
    const ledger = (reports: unknown[]): typeof fetch => (async (input: URL) => {
      const url = new URL(String(input));
      asked.push(`${url.pathname} ${url.searchParams.get("from")}…${url.searchParams.get("to")}`);
      const window = { from: url.searchParams.get("from"), to: url.searchParams.get("to") };
      // The drafts alone: the pay base comes from their pages; the posts are not open to Hub's key here.
      const body = url.pathname === "/v1/reports" ? { ...window, reports } : url.pathname === "/v1/report-days" ? { ...window, days: null } : null;
      return new Response(JSON.stringify(body ?? { error: "no" }), { status: body === null ? 404 : 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const notes = (principal: HumanAuthPrincipal, reports: unknown[]) =>
      readShiftReportNotes(app, principal, { query: { days: 7, until: nextDay }, pageScope: undefined }, { fetchImpl: ledger(reports), now });

    // Off: no day has a note, and the ledger is not asked.
    expect(await notes(owner, [])).toMatchObject({ ruleFrom: null, notes: [] });
    expect(asked).toEqual([]);

    await setSaleRuleSwitch(app.db, { screensFrom: day, setBy: "test", at: now });
    // The day's report was cut before the sale: it is the first chatter's by the rule and in no report of theirs.
    const cut = await notes(owner, [report(1, day, [])]);
    expect(cut.ruleFrom).toBe(day);
    expect(cut.notes).toEqual([{
      userIds: [first], reportDate: day,
      unreported: { count: 1, mills: 10_000, sales: [{ saleId, occurredAt: msk("11:00").toISOString(), pageLabel: "screens-a", kind: "tip", netMills: 10_000 }] },
      byWordsMills: 0, postApartMills: 0, sumOnlyMills: null,
    }]);
    // The reports are read from 2 days before the shown days to 8 after them, in one window.
    const shownFrom = new Date(Date.parse(`${nextDay}T00:00:00Z`) - 6 * DAY).toISOString().slice(0, 10);
    const around = (from: string, days: number) => new Date(Date.parse(`${from}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
    expect(asked.filter((one) => one.startsWith("/v1/reports "))).toEqual([`/v1/reports ${around(shownFrom, -2)}…${around(nextDay, 8)}`]);

    // Paid in the next day's report as «долёт» — by the platform's reference, by Hub's id, or in words: nothing to say.
    expect((await notes(owner, [report(1, day, []), report(2, nextDay, [line("screens-1", 10_000, "долёт")])])).notes).toEqual([]);
    expect((await notes(owner, [report(1, day, []), report(2, nextDay, [line(String(saleId), 10_000, "долёт")])])).notes).toEqual([]);
    expect((await notes(owner, [report(1, day, []), report(2, nextDay, [line(null, 10_000, "долёт: тип 11:00")])])).notes).toEqual([]);
    // In the report itself, with an amount by word beside it and a post changed by hand.
    const full = await notes(owner, [report(1, day, [line("screens-1", 10_000), line(null, 12_000, "перевод мимо площадки")], 37_000)]);
    expect(full.notes).toEqual([{
      userIds: [first], reportDate: day, unreported: { count: 0, mills: 0, sales: [] }, byWordsMills: 12_000, postApartMills: 15_000, sumOnlyMills: null,
    }]);

    // A chatter reads their own days alone, whoever the reports are of; so does a team lead (people's reports from the
    // ledger are the owner's); a narrow session reads as a chatter whatever the role.
    expect((await notes(session(first, "screens-first", "chatter"), [report(1, day, [])])).notes).toEqual(cut.notes);
    expect((await notes(session(second, "screens-second", "chatter"), [report(1, day, [])])).notes).toEqual([]);
    expect((await notes(session(second, "screens-second", "team_lead"), [report(1, day, [])])).notes).toEqual([]);
    expect((await notes(session(first, "screens-first", "team_lead"), [report(1, day, [])])).notes).toEqual(cut.notes);
    expect((await notes(session(second, "screens-second", "owner", { narrowDeviceTokenId: 7 }), [report(1, day, [])])).notes).toEqual([]);
    // The ledger away: nothing is known of the days, said as such.
    await expect(readShiftReportNotes(app, owner, { query: { days: 7, until: nextDay }, pageScope: undefined }, {
      fetchImpl: (async () => new Response("{}", { status: 502 })) as unknown as typeof fetch, now,
    })).rejects.toThrow(/ledger/i);
    await setSaleRuleSwitch(app.db, { screensFrom: null, setBy: "test", at: now });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
