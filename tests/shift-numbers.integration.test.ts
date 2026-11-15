import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, upsertTransaction } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { numbersOf, readJobNumbers, readTeamChatterNumbers, teamShiftJobs } from "../apps/runtime/src/services/chatter-numbers.ts";
import { compareShiftNumbers, refreshShiftNumbers, storedRowsFor } from "../apps/runtime/src/services/shift-numbers.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// The stored numbers of closed shifts (0417 `shift_numbers`, products package N): a row is what the live count
// (`readShiftNumbers`) gives for the shift, written by the same function; a late author report rewrites it, a merged
// shift is counted again, a whose-sale decision moves nothing; the owner's switch reads the table and answers the
// same; a person with two logins is one line.

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let page = 0;
let nina = 0;
let ninaNew = 0;
let fanTransaction = 0;
const MIN = 60_000;
const start = new Date(Math.floor((Date.now() - 14 * 60 * MIN) / MIN) * MIN);
const minute = (offset: number) => new Date(start.getTime() + offset * MIN);
const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const OWNER = () => ({ authMethod: "session", user: { id: nina, role: "owner" } }) as never;

const minutes = (user: number, fromMin: number, toMin: number) => q(
  `insert into chatter_activity_minutes (user_id, page_id, minute, input)
   select $1, $2, minute, true from generate_series($3::timestamptz, $4::timestamptz, interval '1 minute') minute
   on conflict do nothing`,
  [user, page, minute(fromMin), minute(toMin)]);
const sends = (user: number, firstRef: number, count: number, fromMin: number) => q(
  `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
   select 'fansly', $1, ($2::bigint + n)::text, '7950000001', $3, 'fansly-extension', false, false, $4::timestamptz + interval '1 minute' * n, 'hand'
   from generate_series(0, $5::int - 1) n`, [page, firstRef, user, minute(fromMin), count]);
const archive = (chat: string, ref: string, fromFan: boolean, offset: number, fan: string) => q(
  `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain,
     media_metadata, message_type, fan_native_id)
   values ($1, 'fansly', $2, $3, $4, $5, $6, 'hello there friend', '[]'::jsonb, 1, $7)`,
  [page, chat, ref, fromFan ? "fan" : "model", !fromFan, minute(offset), fromFan ? fan : null]);
const authored = (user: number, ref: string, offset: number, fan: string) => q(
  `insert into client_send_attributions (platform, page_id, platform_message_id, conversation_ref, fan_ref, user_id, source, priced, with_media, observed_at, composed_with)
   values ('fansly', $1, $2, $3, $4, $5, 'fansly-extension', false, false, $6, 'hand')`, [page, ref, `88${fan}`, fan, user, minute(offset)]);

const window = () => ({ from: new Date(start.getTime() - 60 * MIN), to: new Date(), now: new Date() });

/** Every closed shift's stored numbers against its live count, as the reads show them (`numbersOf`). */
async function storedEqualsLive(): Promise<number> {
  const found = await teamShiftJobs(app, { ...window(), scope: "all" });
  const closed = { jobs: found.jobs.filter((job) => !job.shift.ongoing), openings: found.openings };
  const stored = await storedRowsFor(app, closed);
  for (const [job, row] of stored) {
    const live = await readJobNumbers(app, job, closed.openings);
    expect(numbersOf([{ row, workedMinutes: 0 }])).toEqual(numbersOf([{ row: live, workedMinutes: 0 }]));
  }
  return stored.size;
}

function setSwitch(on: boolean) {
  (app.config as { teamNumbersFromTable?: boolean }).teamNumbersFromTable = on;
}

async function teamAnswer(on: boolean) {
  setSwitch(on);
  const answer = await readTeamChatterNumbers(app, OWNER(), { from: window().from.toISOString(), to: new Date().toISOString(), pageScope: undefined });
  setSwitch(false);
  return { ...answer, serverNow: null, to: null };
}

describe("stored shift numbers", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "nina", role: "chatter" }, { source: "cli" });
    await createUserAccount(app, { username: "nina2", role: "chatter" }, { source: "cli" });
    nina = await fixtureUserId(app, "nina");
    ninaNew = await fixtureUserId(app, "nina2");
    // One person, two logins: an old one and a new one.
    const person = Number((await q(
      "insert into people (code, display_name, role, state) values ('nina', 'Nina', 'chatter', 'working') returning id")).rows[0].id);
    await q("insert into person_logins (user_id, person_id) values ($1, $3), ($2, $3)", [nina, ninaNew, person]);
    const model = await createModel(app.db, { slug: "numbers-model", name: "Numbers model" });
    page = (await createFanslyPage(app.db, { modelId: model!.id, label: "numbers-1" }))!.id;
    const fanId = Number((await q("insert into fans (platform, platform_user_id, username) values ('fansly', '7950000002', 'sam') returning id")).rows[0].id);

    // Shift A (old login): 0–179; shift B (old login): 260–439, apart by more than an hour of silence.
    await minutes(nina, 0, 179);
    await sends(nina, 9950000000, 60, 0);
    await minutes(nina, 260, 439);
    await sends(nina, 9951000000, 60, 260);
    // Shift C (new login): 520–699.
    await minutes(ninaNew, 520, 699);
    await sends(ninaNew, 9952000000, 60, 520);
    // In shift A a fan wrote and Nina answered 5 minutes later; the fan wrote again and the page answered (no author yet).
    await archive("88795000002", "9953000001", true, 30, "7950000002");
    await archive("88795000002", "9953000002", false, 35, "7950000002");
    await authored(nina, "9953000002", 35, "7950000002");
    await archive("88795000002", "9953000003", true, 60, "7950000002");
    await archive("88795000002", "9953000004", false, 70, "7950000002");
    // The fan bought in shift A.
    await upsertTransaction(app.db, {
      platformAccountId: page, source: "fansly:rest", fanId, transactionId: "numbers-tip", rawType: "7001",
      canonicalType: "tip", transactionState: "posted", rawStatus: "ok", grossAmountMills: 10_000n,
      sourceDestinationAmountMills: 10_000n, creatorNetAmountMills: 8_000n, occurredAt: minute(80),
    });
    fanTransaction = Number((await q("select id from transactions where transaction_id = 'numbers-tip'")).rows[0].id);
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("stores each closed shift as the live count gives it", async (context) => {
    if (!testDb) return context.skip();
    const first = await refreshShiftNumbers(app, { from: window().from, now: new Date() });
    expect(first).toMatchObject({ closed: 3, written: 3, kept: 0 });
    expect(await storedEqualsLive()).toBe(3);
    // Nothing moved: the next pass keeps every row.
    expect(await refreshShiftNumbers(app, { from: window().from, now: new Date() })).toMatchObject({ written: 0, kept: 3 });
    expect(await compareShiftNumbers(app, { from: window().from, now: new Date() })).toMatchObject({ compared: 3, differ: 0, missing: 0 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rewrites a shift whose author report came late, and the check sees the difference until then", async (context) => {
    if (!testDb) return context.skip();
    const before = (await teamAnswer(false)).chatters[0]!.shifts.find((shift) => shift.startedAt === minute(0).toISOString())!;
    await authored(nina, "9953000004", 70, "7950000002");
    const after = (await teamAnswer(false)).chatters[0]!.shifts.find((shift) => shift.startedAt === minute(0).toISOString())!;
    expect(after.numbers.messages).toBe(before.numbers.messages + 1);
    expect(await compareShiftNumbers(app, { from: window().from, now: new Date() })).toMatchObject({ compared: 3, differ: 1 });
    // The report lies in the wait horizon of the later shifts too: the mark is a superset, they are counted again as well.
    expect((await refreshShiftNumbers(app, { from: window().from, now: new Date() })).written).toBeGreaterThanOrEqual(1);
    expect(await storedEqualsLive()).toBe(3);
    expect(await compareShiftNumbers(app, { from: window().from, now: new Date() })).toMatchObject({ compared: 3, differ: 0 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("moves no number when a decision moves the shift's sale", async (context) => {
    if (!testDb) return context.skip();
    await q(`insert into sale_homes (transaction_id, page_id, occurred_at, net_mills, home, reason, rule_version, computed_at)
             values ($1, $2, $3, 8000, 'shift', 'held', 'test', now())`, [fanTransaction, page, minute(80)]);
    await q("update sale_homes set home = 'nobody', reason = 'owner decision' where transaction_id = $1", [fanTransaction]);
    expect(await refreshShiftNumbers(app, { from: window().from, now: new Date() })).toMatchObject({ written: 0, kept: 3 });
    expect(await compareShiftNumbers(app, { from: window().from, now: new Date() })).toMatchObject({ differ: 0 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reads the table with the switch on and answers as the live count does; one line a person", async (context) => {
    if (!testDb) return context.skip();
    const off = await teamAnswer(false);
    expect(off.chatters).toHaveLength(1);
    expect(off.chatters[0]).toMatchObject({ userId: nina, userIds: [nina, ninaNew] });
    expect(off.chatters[0]!.shifts.map((shift) => shift.userId).sort()).toEqual([nina, nina, ninaNew].sort());
    expect(await teamAnswer(true)).toEqual(off);
    // The switch on reads the stored row: a row changed by hand shows, and the check names it.
    await q("update shift_numbers set numbers = jsonb_set(numbers, '{messages}', '999') where user_id = $1 and started_at = $2", [nina, minute(260)]);
    const on = await teamAnswer(true);
    expect(on.chatters[0]!.shifts.find((shift) => shift.startedAt === minute(260).toISOString())!.numbers.messages).toBe(999);
    const check = await compareShiftNumbers(app, { from: window().from, now: new Date() });
    expect(check).toMatchObject({ differ: 1 });
    expect(check.first[0]).toContain("messages");
    // A row of another revision is counted again.
    await q("update shift_numbers set revision = 0 where user_id = $1 and started_at = $2", [nina, minute(260)]);
    expect(await teamAnswer(true)).toEqual(off);
    expect(await refreshShiftNumbers(app, { from: window().from, now: new Date() })).toMatchObject({ written: 1 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("counts a merged shift again", async (context) => {
    if (!testDb) return context.skip();
    // Late activity fills the silence between A and B: one shift 0–439.
    await minutes(nina, 180, 259);
    const off = await teamAnswer(false);
    expect(off.chatters[0]!.shifts.filter((shift) => shift.userId === nina)).toHaveLength(1);
    // The stored row of A is of a shift that ended earlier: not used, the switch on still answers the same.
    expect(await teamAnswer(true)).toEqual(off);
    expect(await refreshShiftNumbers(app, { from: window().from, now: new Date() })).toMatchObject({ closed: 2, written: 1, kept: 1 });
    expect(await storedEqualsLive()).toBe(2);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
