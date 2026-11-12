import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel, insertPersonLogin, insertPersonRow, insertSaleDecision, setSaleRuleSwitch } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { computeChatterStats } from "../apps/runtime/src/services/chatter-stats.ts";
import { runBeforeAfter } from "../apps/runtime/src/services/sale-rule-before-after.ts";
import { computeShiftReview } from "../apps/runtime/src/services/shift-review.ts";
import { teamShiftSalesRead } from "../apps/runtime/src/services/team-shift-sales.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Whom a home credits, on a fixture with the screens' switch on: a person with two logins works under the new one,
// and the owner's decision names the old one; another person gets a sale nobody's shift held. Both land somewhere —
// the first on the person's shift, the second outside the shifts with the person's name and in the person's day — the
// same number in «Смены», in the person's statistics and in the shift review; the shifts and «вне смен» add up to
// every sale of the day.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
const pages = { main: 0, other: 0 };
const users = { oldLogin: 0, working: 0, claimant: 0 };
const DAY = 86_400_000;
const now = new Date();
// Three Moscow days back.
const day = new Date(now.getTime() + 3 * 3_600_000 - 3 * DAY).toISOString().slice(0, 10);
const msk = (time: string) => new Date(`${day}T${time}:00+03:00`);
const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
const sales = { decided: 0, held: 0, claimed: 0 };
const NET = { decided: 30_000, held: 10_000, claimed: 25_000 };

const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);

async function shift(userId: number, pageId: number, from: string, to: string, base: number) {
  await q(`insert into chatter_activity_minutes (user_id, page_id, minute, input)
           select $1, $2, minute, true from generate_series($3::timestamptz, $4::timestamptz, interval '1 minute') minute`, [userId, pageId, msk(from), msk(to)]);
  // A message every four minutes, to another fan than the buyers': nobody wrote to them.
  await q(`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
           select 'fansly', $1, ($2::bigint + n)::text, '7700000099', $3, 'fansly-extension', false, false, $4::timestamptz + interval '4 minutes' * n, 'hand'
           from generate_series(0, 59) n where $4::timestamptz + interval '4 minutes' * n < $5::timestamptz`, [pageId, base, userId, msk(from), msk(to)]);
}

async function tip(pageId: number, ref: string, net: number, time: string): Promise<number> {
  const fan = Number((await q("insert into fans (platform, platform_user_id, username) values ('fansly', $1, $1) returning id", [`77000${ref}`])).rows[0].id);
  return Number((await q(`insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
             gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source)
           values ($1, $2, $3, '7101', 'tip', 'pending', 'test', $4, $4, $4, $5, 'fansly:rest') returning id`, [pageId, fan, `credit-${ref}`, net, msk(time)])).rows[0].id);
}

async function decide(transactionId: number, pageId: number, userId: number, ruleHome: string | null) {
  await insertSaleDecision(app.db, {
    transactionId, pageId, kind: "split", shares: [{ userId, percent: 100 }], pot: null, outcome: "first", ruleHome, note: null,
    decidedByUserId: null, decidedAt: now, saidBy: null, source: "dispute", ledgerDecisionId: null, ledgerRef: null,
  }, now);
}

const sumOf = (values: readonly number[]) => values.reduce((total, one) => total + one, 0);
/** Every line of «вне смен», whatever lines there are. */
const outsideTotal = (outside: object) => sumOf(Object.entries(outside).filter(([key, value]) => key.endsWith("NetMills") && typeof value === "number").map(([, value]) => value as number));

describe("whom a home credits", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    const model = await createModel(app.db, { slug: "credit", name: "Credit" });
    pages.main = (await createFanslyPage(app.db, { modelId: model!.id, label: "credit-a" }))!.id;
    pages.other = (await createFanslyPage(app.db, { modelId: model!.id, label: "credit-b" }))!.id;
    for (const [key, username] of [["oldLogin", "credit-old"], ["working", "credit-new"], ["claimant", "credit-claimant"]] as const) {
      await createUserAccount(app, { username, role: "chatter" }, { source: "cli" });
      users[key] = await fixtureUserId(app, username);
    }
    // One person, two logins: the old one no longer works, the new one does.
    const person = await insertPersonRow(app.db, {
      code: "credit-person", displayName: "Credit Person", kind: "human", role: "chatter", state: "working", leftOn: null, telegramUserId: null,
      telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
    });
    await insertPersonLogin(app.db, { personId: person.id, userId: users.oldLogin, linkedByUserId: null });
    await insertPersonLogin(app.db, { personId: person.id, userId: users.working, linkedByUserId: null });

    await shift(users.working, pages.main, "10:00", "14:00", 9_700_000_000);
    // The claimant's shift that day is on the other page, later: it holds nothing of the main page's.
    await shift(users.claimant, pages.other, "18:00", "22:00", 9_700_001_000);
    sales.held = await tip(pages.main, "1", NET.held, "11:00");
    sales.decided = await tip(pages.main, "2", NET.decided, "12:00");
    sales.claimed = await tip(pages.main, "3", NET.claimed, "17:00");
    // The owner gives the sale the working login's shift held to the person's OLD login.
    await decide(sales.decided, pages.main, users.oldLogin, "shift");
    // A sale nobody's shift held, the owner gives to the claimant: theirs whole, on no work.
    await decide(sales.claimed, pages.main, users.claimant, "nobody");
    await setSaleRuleSwitch(app.db, { screensFrom: day, setBy: "test", at: now });
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("lands a decision naming the person's other login on the shift the person worked", async (context) => {
    if (!testDb) return context.skip();
    const read = await teamShiftSalesRead(app.db, { days: 7, until: nextDay, now, pages: "all" });
    const shiftOf = read.response.shifts.find((one) => one.userId === users.working)!;
    expect(shiftOf.salesNetMills).toBe(NET.held + NET.decided);
    const stats = await computeChatterStats(app.db, {
      userId: users.working, username: "credit-new", pages: [{ pageId: pages.main, label: "credit-a", platform: "fansly" }], days: 7, until: nextDay, now,
    });
    expect(stats.totals.salesNetMills).toBe(NET.held + NET.decided);
    const review = await computeShiftReview(app, { userId: users.working, at: msk("11:30").toISOString() });
    expect(review.review.shift.salesNetMills).toBe(NET.held + NET.decided);
    expect(review.review.sales.find((one) => one.saleRef === String(sales.decided))).toMatchObject({ verdict: "mine" });
    // The old login has no row: nothing of it is its own.
    expect(read.response.chatters.some((one) => one.userId === users.oldLogin)).toBe(false);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps a decision to a person with no shift then: outside the shifts with their name, and in their day", async (context) => {
    if (!testDb) return context.skip();
    const read = await teamShiftSalesRead(app.db, { days: 7, until: nextDay, now, pages: "all" });
    const { response } = read;
    const claimant = response.chatters.find((one) => one.userId === users.claimant);
    expect(claimant).toMatchObject({ salesNetMills: NET.claimed });
    expect(claimant!.daily.find((one) => one.date === day)?.salesNetMills).toBe(NET.claimed);
    expect(response.outside.sales).toContainEqual(expect.objectContaining({ netMills: NET.claimed, visitBy: "credit-claimant" }));
    // Every sale of the day once: the shifts' money and «вне смен».
    expect(response.team.salesNetMills + outsideTotal(response.outside)).toBe(NET.held + NET.decided + NET.claimed);

    const stats = await computeChatterStats(app.db, {
      userId: users.claimant, username: "credit-claimant", pages: [{ pageId: pages.main, label: "credit-a", platform: "fansly" }, { pageId: pages.other, label: "credit-b", platform: "fansly" }],
      days: 7, until: nextDay, now,
    });
    expect(stats.totals.salesNetMills).toBe(NET.claimed);
    expect(stats.daily.find((one) => one.date === day)?.salesNetMills).toBe(claimant!.daily.find((one) => one.date === day)?.salesNetMills);

    // The claimant's shift that day: not its money, but the person's day shows it.
    const review = await computeShiftReview(app, { userId: users.claimant, at: msk("19:30").toISOString() });
    expect(review.review.shift.salesNetMills).toBe(0);
    const daySales = (review.review as { withoutShiftSales?: Array<{ netMills: number; holderName: string | null }> }).withoutShiftSales ?? [];
    expect(daySales).toEqual([expect.objectContaining({ netMills: NET.claimed, verdict: "none", holderName: "credit-claimant" })]);
    expect(review.review.shift.salesNetMills + sumOf(daySales.map((one) => one.netMills))).toBe(stats.daily.find((one) => one.date === day)?.salesNetMills);
    expect(response.outside).toMatchObject({ personNetMills: NET.claimed, decideNetMills: 0, nobodyNetMills: 0 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("says so in «было и стало»: the shift keeps what it had, the claimant's day gains, the rule places every sale", async (context) => {
    if (!testDb) return context.skip();
    const report = await runBeforeAfter(app.db, { first: day, last: day, screensFrom: day, live: false, now });
    const dayOf = (userId: number) => report.days.find((one) => one.userId === userId && one.day === day);
    // The old count gave the working login's shift both sales it held; the rule gives it the same, by the person.
    expect(dayOf(users.working)).toMatchObject({ beforeMills: NET.held + NET.decided, afterMills: NET.held + NET.decided });
    expect(dayOf(users.claimant)).toMatchObject({ beforeMills: 0, afterMills: NET.claimed, ruleMills: NET.claimed });
    expect(report.team).toMatchObject({ beforeMills: NET.held + NET.decided, afterMills: NET.held + NET.decided });
    expect(report.outside.after).toMatchObject({ person: NET.claimed });
    expect(report.unplaced).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
