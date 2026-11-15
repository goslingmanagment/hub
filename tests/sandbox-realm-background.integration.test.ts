import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensureFanslySyncPages,
  insertPersonLogin,
  insertPersonRow,
  listCrossPageCandidatePages,
  listDueFanFactConversations,
  listFansWaitingSince,
  listNotificationIncidentsWithPages,
  listNotificationPagingCandidates,
  listOfapiMappedPages,
  listPagesByPlatform,
  listPlatformAccounts,
  livePageArraySql,
  liveUserSql,
  testPageSql,
  testUserSql,
  type Database,
} from "@agency_hub_core/db";

import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { runCustomOrderChecks } from "../apps/runtime/src/services/custom-orders/checks.ts";
import { recordCustomOrder } from "../apps/runtime/src/services/custom-orders/index.ts";
import { runMatterChecks } from "../apps/runtime/src/services/matter-checks.ts";
import { notifyWrongTransactionsWriterIncident } from "../apps/runtime/src/services/notification-incidents.ts";
import { runNotificationPagingSweep } from "../apps/runtime/src/services/notification-paging-sweep.ts";
import { runPeopleMessages } from "../apps/runtime/src/services/people-messages/index.ts";
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

// The general proof (sweep S2, inventory in 8-docs/2026-11-13-products/results/S2-realm-sweep): whatever a background
// path lists «all» of, nothing of the test team reaches the owner's Telegram, a platform, AI money or a live matter. The
// producers run for every page alike (a test page is treated like any page), and then every table a path out of Hub
// writes is read for test pages, people and logins: the wall is where those rows are made, not in each producer.
describe("nothing of the test team leaves Hub through a background path", () => {
  it("incidents, paging, people messages, the sync host, the OnlyFans API fleet, the morning report and AI lanes", async (context) => {
    if (!withTeam) return context.skip();
    const app = createTestAppContext(withTeam);
    const db = app.db as Database;
    const pages = (await db.execute<{ id: string; label: string; platform: "fansly" | "onlyfans"; test: boolean }>(sql`
      select p.id, p.label, p.platform, m.is_test as test from pages p join models m on m.id = p.model_id order by p.id`)).rows
      .map((row) => ({ id: Number(row.id), label: row.label, platform: row.platform, test: row.test === true }));
    const testPages = pages.filter((page) => page.test);
    const testLabels = new Set(testPages.map((page) => page.label));
    const live = pages.find((page) => !page.test)!;
    expect(testPages.map((page) => page.platform).sort()).toEqual(["fansly", "onlyfans"]);
    const later = new Date(Date.now() + 2 * DAY);
    // Every page gets what the lists read: a fan who wrote last and waits (the seed writes only the model's messages).
    for (const page of pages) {
      await db.execute(sql`insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id, sender_role,
          is_sent_by_me, occurred_at, text_plain, backfill_source)
        values (${page.id}, ${page.platform}, ${`sweep-fan-${page.id}`}, ${`sweep-msg-${page.id}`}, ${`sweep-fan-${page.id}`}, 'fan',
          false, ${new Date(later.getTime() - 2 * HOUR).toISOString()}::timestamptz, 'Привет', 'sandbox')`);
    }

    // A producer of the paging pipeline fires for every page alike; the test OnlyFans page holds an account as if bound.
    for (const page of pages) {
      await notifyWrongTransactionsWriterIncident(app, {
        platformAccountId: page.id, pageLabel: page.label, platform: page.platform, attemptedWriter: "realm-sweep", assignedWriter: null,
      });
    }
    const testOnlyfans = testPages.find((page) => page.platform === "onlyfans")!;
    await db.execute(sql`update pages set ofapi_account_id = 'acct_realm_sweep' where id = ${testOnlyfans.id}`);
    await ensureFanslySyncPages(db, { createdBy: "realm-sweep" });
    await runNotificationPagingSweep(app, { now: later });
    await runPeopleMessages(app, { now: new Date(T0 + 7 * DAY + HOUR), transport: async () => { throw new Error("nothing is sent in this test"); } });

    // The live page's incident is there: the producer ran.
    const liveIncidents = await db.execute<{ n: number }>(sql`select count(*)::int as n from notification_incidents where platform_account_id = ${live.id}`);
    expect(liveIncidents.rows[0]!.n).toBe(1);
    // Every row a path out of Hub writes, read for the test realm.
    const offenders = await db.execute<{ what: string; id: string }>(sql`
      select 'incident' as what, i.id::text as id from notification_incidents i where ${testPageSql(sql`i.platform_account_id`)}
      union all select 'incident cycle', c.id::text from notification_incident_cycles c where ${testPageSql(sql`c.platform_account_id`)}
      union all select 'outbox', o.id::text from notification_delivery_outbox o join notification_incidents i on i.id = o.notification_incident_id
        where ${testPageSql(sql`i.platform_account_id`)}
      union all select 'sync page', s.page_id::text from sync_pages s where ${testPageSql(sql`s.page_id`)}
      union all select 'sync state', st.page_id::text from page_sync_states st where ${testPageSql(sql`st.page_id`)}
      union all select 'link run', r.id::text from page_link_stat_runs r where ${testPageSql(sql`r.platform_account_id`)}
      union all select 'people message', pm.id::text from people_messages pm
        where pm.recipient_user_id is not null and ${testUserSql(sql`pm.recipient_user_id`)}
      union all select 'ai usage', a.id::text from ai_usage_events a
        where ${testPageSql(sql`a.page_id`)} or (a.user_id is not null and ${testUserSql(sql`a.user_id`)})
      union all select 'live matter', m.id::text from matters m
        where not ${livePageArraySql(sql`m.page_ids`)} and (m.owner_user_id is null or ${liveUserSql(sql`m.owner_user_id`)})`);
    expect(offenders.rows).toEqual([]);

    // The lists those paths read, each the live agency's.
    expect((await listOfapiMappedPages(db)).map((page) => page.id)).not.toContain(testOnlyfans.id);
    // The sync planner's and «sync all»'s listings (catalog.ts) and the cross-page fan lists: the live agency's.
    const testIds = new Set(testPages.map((page) => page.id));
    for (const listed of [await listPagesByPlatform(db, "onlyfans"), await listPagesByPlatform(db, "fansly"), await listPlatformAccounts(db), await listCrossPageCandidatePages(db)]) {
      expect(listed.filter((page) => testIds.has(Number(page.id)))).toEqual([]);
    }
    expect((await listPlatformAccounts(db)).map((page) => Number(page.id))).toContain(live.id);
    expect((await listNotificationIncidentsWithPages(db, { limit: 500 })).items.filter((item) => item.pageLabel !== null && testLabels.has(item.pageLabel))).toEqual([]);
    expect((await listNotificationPagingCandidates(db, { resolvedSince: new Date(0) })).filter((one) => testLabels.has(one.pageLabel ?? ""))).toEqual([]);
    const waiting = await listFansWaitingSince(db, { now: later, minWaitHours: 0, maxDays: 60 });
    expect(waiting.map((row) => row.pageLabel)).toContain(live.label);
    expect(waiting.filter((row) => testLabels.has(row.pageLabel))).toEqual([]);
    const due = await listDueFanFactConversations(db, { pageIds: pages.map((page) => page.id), now: later, quietMinutes: 0, activeHours: 60 * 24, limit: 1000 });
    expect(due.filter((one) => testLabels.has(one.pageLabel))).toEqual([]);
  }, 300_000);
});
