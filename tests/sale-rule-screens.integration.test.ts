import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel, setSaleRuleSwitch } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { computeChatterStats } from "../apps/runtime/src/services/chatter-stats.ts";
import { teamShiftSalesOf, teamShiftSalesRead } from "../apps/runtime/src/services/team-shift-sales.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The screens' switch to the one rule on a fixture: off, «Смены» and «Мои смены» answer as before (a junction sale
// nobody wrote to counts for both, no field of the rule appears); on from the day, the junction sale counts once — the
// owner's to decide, «вне смен» — and the team's total is every sale once; on from a later day, the day stays as it was.

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
});
