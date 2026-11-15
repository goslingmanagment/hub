import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, insertPersonLogin, insertPersonRow, type Database } from "@agency_hub_core/db";

import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { runCustomOrderChecks } from "../apps/runtime/src/services/custom-orders/checks.ts";
import { recordCustomOrder } from "../apps/runtime/src/services/custom-orders/index.ts";
import { runMatterChecks } from "../apps/runtime/src/services/matter-checks.ts";
import { runPeopleStartTick } from "../apps/runtime/src/services/people/start-tick.ts";
import { runSaleClaims } from "../apps/runtime/src/services/sale-claims.ts";
import { refreshSaleHomes } from "../apps/runtime/src/services/sale-homes.ts";
import { seedSandbox } from "../apps/runtime/src/services/sandbox/seed.ts";
import { runShiftReportMatters } from "../apps/runtime/src/services/shift-handin-matters.ts";
import { handinActorOf } from "../apps/runtime/src/services/shift-handins.ts";
import { confirmShiftReport, handInShiftReport, runShiftReportBoardPass } from "../apps/runtime/src/services/shift-report-board.ts";
import type { HumanAuthPrincipal } from "../apps/runtime/src/services/auth.ts";
import { syncShiftRowsSince } from "../apps/runtime/src/services/shift-rows.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// The background passes that mix rows by a shared key (a day, a week, «every newcomer», one lead for every model, the
// owner's counts) never let the test team into the live agency's matters (sandbox/realm.ts). Two databases with the
// same live agency, one with the test team (its shifts with «сдаёт смену» on and nothing handed in, its sales nobody
// wrote for, its orders, its newcomer), the same passes on the same frozen clock — the day's close, the silent day,
// 48 hours, the week's turn — and the live realm's matters are the same in both.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 10, 21, 30); // a Moscow day's close (00:30 MSK)
const CLOCK = [T0, T0 + DAY, T0 + 2 * DAY, T0 + 7 * DAY];

let plain: StartedTestDatabase | null = null;
let withTeam: StartedTestDatabase | null = null;

async function seedLiveAgency(testDb: StartedTestDatabase) {
  const app = createTestAppContext(testDb);
  const db = app.db as Database;
  const owner = await createUserAccount(app, { username: "dima", role: "owner", password: "owner-secret-1" }, { source: "cli" });
  const ownerPerson = await insertPersonRow(db, {
    code: "dima", displayName: "Owner", kind: "human", role: "owner", state: "working", leftOn: null, telegramUserId: null,
    telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
  });
  await insertPersonLogin(db, { personId: ownerPerson.id, userId: owner.id, linkedByUserId: null });
  const model = await createModel(db, { slug: "lana", name: "Lana" });
  const page = await createFanslyPage(db, { modelId: model.id, label: "live-1" });
  const chatter = await createUserAccount(app, { username: "anton", role: "chatter" }, { source: "cli" });
  const person = await insertPersonRow(db, {
    code: "anton", displayName: "Anton", kind: "human", role: "chatter", state: "working", leftOn: null, telegramUserId: 4242,
    telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
  });
  await insertPersonLogin(db, { personId: person.id, userId: chatter.id, linkedByUserId: null });
  await db.execute(sql`insert into user_page_assignments (user_id, platform_account_id) values (${chatter.id}, ${page.id})`);
  await db.execute(sql`insert into person_working_pages (person_id, page_id, position) values (${person.id}, ${page.id}, 0)`);
  await db.execute(sql`insert into person_rights (person_id, "right", granted_at) values (${person.id}, 'submits_shift', ${new Date(T0 - 30 * DAY).toISOString()}::timestamptz)`);
  // A live newcomer: the owner's «Начало» matters.
  await insertPersonRow(db, {
    code: "newbie", displayName: "Newbie", kind: "human", role: "chatter", state: "invited", leftOn: null, telegramUserId: null,
    telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
  });
  // A live shift the day before T0, handed in: that day is complete; a tip nobody wrote for in it.
  const start = T0 - 20 * HOUR;
  await db.execute(sql`insert into chatter_activity_minutes (user_id, page_id, minute, input)
    select ${chatter.id}, ${page.id}, m, true from generate_series(${new Date(start).toISOString()}::timestamptz,
      ${new Date(start + 3 * HOUR).toISOString()}::timestamptz, interval '1 minute') m`);
  const [fan] = (await db.execute<{ id: string }>(sql`insert into fans (platform, platform_user_id, username) values ('fansly', '100000000000000001', 'live_fan') returning id`)).rows;
  await db.execute(sql`insert into page_fans (fan_id, platform_account_id) values (${fan!.id}, ${page.id})`);
  for (let index = 0; index < 70; index += 1) {
    await db.execute(sql`insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, conversation_ref, user_id,
      source, priced, with_media, observed_at) values ('fansly', ${page.id}, ${String(500000 + index)}, '100000000000000001',
      '100000000000000001', ${chatter.id}, 'fansly-extension', false, false, ${new Date(start + (index + 1) * 2 * 60_000).toISOString()}::timestamptz)`);
  }
  const [other] = (await db.execute<{ id: string }>(sql`insert into fans (platform, platform_user_id, username) values ('fansly', '100000000000000002', 'quiet_fan') returning id`)).rows;
  await db.execute(sql`insert into page_fans (fan_id, platform_account_id) values (${other!.id}, ${page.id})`);
  await db.execute(sql`insert into transactions (platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
    gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, is_active)
    values (${page.id}, ${other!.id}, 'live-nobody', 'tip', 'tip', 'posted', 'posted', 30000, 30000, 24000,
      ${new Date(start + 2 * HOUR).toISOString()}::timestamptz, 'fansly:rest', true)`);
  await syncShiftRowsSince(db, { from: new Date(T0 - 3 * DAY), now: new Date(T0 - HOUR) });
  const [shift] = (await db.execute<{ id: string; report_date: string }>(sql`select id, report_date::text from shifts order by id limit 1`)).rows;
  await db.execute(sql`insert into shift_handins (shift_id, user_id, person_id, report_date, state, current_version, submitted_at)
    values (${shift!.id}, ${chatter.id}, ${person.id}, ${shift!.report_date}::date, 'submitted', 1, ${new Date(T0 - 2 * HOUR).toISOString()}::timestamptz)`);
  // A live order paid long ago: the lead's and the owner's customs matters.
  await recordCustomOrder(app, {
    pageId: page.id, fanId: Number(fan!.id), buyer: null, conversationRef: null, card: { task: "Live order" }, deadlineOn: "2026-11-01",
    acceptedByUserId: chatter.id, origin: "workboard", state: "paid", actor: { door: "workboard", userId: chatter.id }, now: new Date(T0 - 10 * DAY),
    createdAt: new Date(T0 - 10 * DAY),
  });
}

async function seedTestTeam(testDb: StartedTestDatabase) {
  const app = createTestAppContext(testDb);
  // The team's day: shifts, sales of every kind, orders, matters — on the frozen clock.
  await seedSandbox(app, { scenarios: ["shift", "customs", "matters"], env: {}, now: new Date(T0 - 12 * HOUR), printCheckerKey: true });
  // «Сдаёт смену» on for the test chatters since before their shifts, nothing handed in.
  await app.db.execute(sql`insert into person_rights (person_id, "right", granted_at)
    select id, 'submits_shift', ${new Date(T0 - 30 * DAY).toISOString()}::timestamptz from people where is_test and role = 'chatter'
    on conflict do nothing`);
}

async function runPasses(testDb: StartedTestDatabase, between?: (at: number) => Promise<void>) {
  const app = createTestAppContext(testDb);
  const ledgerAway: typeof fetch = async () => { throw new Error("no ledger in this test"); };
  for (const at of CLOCK) {
    const now = new Date(at);
    await syncShiftRowsSince(app.db, { from: new Date(at - 3 * DAY), now });
    await refreshSaleHomes(app.db, { from: new Date(at - 9 * DAY), to: now, now });
    await between?.(at);
    await runShiftReportBoardPass(app, now);
    await runShiftReportMatters(app, now);
    await runSaleClaims(app, now);
    await runPeopleStartTick(app, now);
    await runCustomOrderChecks(app, now);
    await runMatterChecks(app, { now, fetchImpl: ledgerAway });
  }
}

/** The live realm's matters: every one not waiting for a test login, as a person reads it (no ids, no clock fields). */
async function liveMatters(testDb: StartedTestDatabase): Promise<string[]> {
  const result = await testDb.db.execute<Record<string, unknown>>(sql`
    select m.reason_key, m.kind, m.state, m.closed_how, m.title, m.owner_role, u.username as owner, m.page_ids, m.evidence
    from matters m left join users u on u.id = m.owner_user_id
    where m.owner_user_id is null or not exists (
      select 1 from person_logins pl join people pe on pe.id = pl.person_id where pl.user_id = m.owner_user_id and pe.is_test)
    order by m.reason_key`);
  return result.rows.map((row) => JSON.stringify(row));
}

beforeAll(async () => {
  plain = await startIntegrationTestDatabase();
  withTeam = await startIntegrationTestDatabase();
  if (!plain || !withTeam) return;
  await seedLiveAgency(plain);
  await seedLiveAgency(withTeam);
  await seedTestTeam(withTeam);
}, 300_000);

afterAll(async () => {
  await plain?.stop();
  await withTeam?.stop();
});

describe("background passes keep the test team out of the live agency's matters", () => {
  it("the day's close, the silent day, 48 hours and the week's turn open the same live matters", async (context) => {
    if (!plain || !withTeam) return context.skip();
    await runPasses(plain);
    // The test team's report goes the whole way on the same clock: drafted and handed in at the day's close
    // («Проверка»), past the check by the silent day («Подтвердите»), confirmed («Учтён»).
    const app = createTestAppContext(withTeam);
    const [user] = (await withTeam.db.execute<{ id: string }>(sql`select id from users where username = 't-chat-2'`)).rows;
    const testPages = (await withTeam.db.execute<{ id: string }>(sql`select p.id from pages p join models m on m.id = p.model_id where m.is_test`)).rows.map((row) => Number(row.id));
    const principal = {
      authMethod: "session", user: { id: Number(user!.id), username: "t-chat-2", role: "chatter", assignedPages: [], mustChangePassword: false },
      assignedPageIds: testPages, sandbox: { test: true, testPageIds: testPages, livePageIds: null },
    } as HumanAuthPrincipal;
    const actor = handinActorOf(principal);
    let shiftId = 0;
    const phase = async () => String((await withTeam!.db.execute<{ phase: string }>(sql`select phase from shift_handins where shift_id = ${shiftId}`)).rows[0]?.phase ?? "draft");
    const seen: string[] = [];
    await runPasses(withTeam, async (at) => {
      if (at === CLOCK[0]) {
        const [shift] = (await withTeam!.db.execute<{ id: string }>(sql`select id from shifts where user_id = ${user!.id} and state = 'closed' order by id limit 1`)).rows;
        shiftId = Number(shift!.id);
        seen.push(await phase());
        await handInShiftReport(app, actor, { shiftId }, new Date(at));
        seen.push(await phase());
      }
      if (at === CLOCK[1]) {
        // The minute pass of the silent day: the checker never answered, ten minutes are long gone.
        await runShiftReportBoardPass(app, new Date(at));
        seen.push(await phase());
        const [candidate] = (await withTeam!.db.execute<{ id: string }>(sql`select c.id from shift_handin_candidates c join shift_handins h on h.id = c.handin_id
          where h.shift_id = ${shiftId} order by c.id desc limit 1`)).rows;
        await confirmShiftReport(app, actor, { shiftId, candidateId: Number(candidate!.id) }, { now: new Date(at), dayPaid: async () => null });
        seen.push(await phase());
      }
    });
    expect(seen).toEqual(["draft", "checking", "confirm", "counted"]);
    const live = await liveMatters(plain);
    expect(live.length).toBeGreaterThan(0);
    expect(await liveMatters(withTeam)).toEqual(live);
    // The test team's own matters exist and wait for test people by name (never a role).
    const test = await withTeam.db.execute<{ owner_role: string | null; owner_user_id: string | null }>(sql`
      select owner_role, owner_user_id from matters m where exists (
        select 1 from person_logins pl join people pe on pe.id = pl.person_id where pl.user_id = m.owner_user_id and pe.is_test)
        or exists (select 1 from unnest(m.page_ids) p join pages pg on pg.id = p join models mo on mo.id = pg.model_id where mo.is_test)`);
    expect(test.rows.length).toBeGreaterThan(0);
    expect(test.rows.every((row) => row.owner_role === null && row.owner_user_id !== null)).toBe(true);
  }, 600_000);
});
