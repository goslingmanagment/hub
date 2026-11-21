import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, insertPersonLogin, insertPersonRow, type Database } from "@agency_hub_core/db";

import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import { createUserAccount, type HumanAuthPrincipal } from "../apps/runtime/src/services/auth.ts";
import { recordCustomOrder } from "../apps/runtime/src/services/custom-orders/index.ts";
import { executeSandboxRemoval, planSandboxRemoval } from "../apps/runtime/src/services/sandbox/remove.ts";
import { seedSandbox } from "../apps/runtime/src/services/sandbox/seed.ts";
import { handinActorOf } from "../apps/runtime/src/services/shift-handins.ts";
import { confirmShiftReport, handInShiftReport, runShiftReportBoardPass } from "../apps/runtime/src/services/shift-report-board.ts";
import { syncShiftRowsSince } from "../apps/runtime/src/services/shift-rows.ts";
import { answerQuestion, askTeamQuestion } from "../apps/runtime/src/services/team-questions.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// `sandbox:remove --execute` (the owner's word, services/sandbox/remove.ts) takes the WHOLE test team — its handed-in
// reports too, which no one else may ever delete (0400, 0412; 0425 lets the removal take a test person's rows only) —
// and nothing of the live agency beside it. The test team did everything it can: every seed scenario, a report handed
// in on the board and counted, a swap answered «Можно», a question, all on a stand-in of the live page too (0435); the
// live agency has the same beside it.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 10, 21, 30); // a Moscow day's close (00:30 MSK)

let testDb: StartedTestDatabase | null = null;
const live = { userId: 0, pageId: 0, questionId: 0 };

type Row = Record<string, unknown>;

function principalOf(user: { id: number; username: string; role: string }, pageIds: number[], test: boolean): HumanAuthPrincipal {
  return {
    authMethod: "session",
    user: { id: user.id, username: user.username, role: user.role, assignedPages: [], mustChangePassword: false },
    assignedPageIds: pageIds,
    ...(test ? { sandbox: { test: true, testPageIds: pageIds, livePageIds: null } } : {}),
  } as unknown as HumanAuthPrincipal;
}

async function loginOf(db: Database, username: string) {
  const [row] = (await db.execute<{ id: string; role: string }>(sql`select id, role from users where username = ${username}`)).rows;
  return { id: Number(row!.id), username, role: String(row!.role) };
}

/** A closed shift handed in on the board, past the check, confirmed: a counted version. */
async function countReport(db: Database, principal: HumanAuthPrincipal) {
  const app = createTestAppContext(testDb!);
  const [shift] = (await db.execute<{ id: string }>(sql`select id from shifts where user_id = ${principal.user.id} and state = 'closed' order by id limit 1`)).rows;
  const shiftId = Number(shift!.id);
  const actor = handinActorOf(principal);
  await handInShiftReport(app, actor, { shiftId }, new Date(T0));
  await runShiftReportBoardPass(app, new Date(T0 + 11 * 60_000));
  const [candidate] = (await db.execute<{ id: string }>(sql`select c.id from shift_handin_candidates c join shift_handins h on h.id = c.handin_id
    where h.shift_id = ${shiftId} order by c.id desc limit 1`)).rows;
  await confirmShiftReport(app, actor, { shiftId, candidateId: Number(candidate!.id) }, { now: new Date(T0 + 12 * 60_000), dayPaid: async () => null });
  const [versions] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from shift_handin_versions v join shift_handins h on h.id = v.handin_id
    where h.shift_id = ${shiftId}`)).rows;
  expect(versions!.n).toBeGreaterThan(0);
}

async function seedLive(db: Database) {
  const app = createTestAppContext(testDb!);
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
    code: "anton", displayName: "Anton", kind: "human", role: "chatter", state: "working", leftOn: null, telegramUserId: null,
    telegramHandle: null, reportTag: null, onboarding: [], note: null, importNotes: [], origin: "owner", createdByUserId: null,
  });
  await insertPersonLogin(db, { personId: person.id, userId: chatter.id, linkedByUserId: null });
  await db.execute(sql`insert into user_page_assignments (user_id, platform_account_id) values (${chatter.id}, ${page.id})`);
  await db.execute(sql`insert into person_working_pages (person_id, page_id, position) values (${person.id}, ${page.id}, 0)`);
  await db.execute(sql`insert into person_rights (person_id, "right", granted_at) values (${person.id}, 'submits_shift', ${new Date(T0 - 30 * DAY).toISOString()}::timestamptz)`);
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
  await recordCustomOrder(app, {
    pageId: page.id, fanId: Number(fan!.id), buyer: null, conversationRef: null, card: { task: "Live order" }, deadlineOn: "2026-11-20",
    acceptedByUserId: chatter.id, origin: "workboard", state: "paid", actor: { door: "workboard", userId: chatter.id }, now: new Date(T0 - 2 * DAY),
    createdAt: new Date(T0 - 2 * DAY),
  });
  live.userId = chatter.id;
  live.pageId = page.id;
}

/** Everything of the live agency the removal must not touch, as rows. */
async function liveSnapshot(db: Database): Promise<string> {
  const read = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows;
  return JSON.stringify(({
    models: await read(sql`select id, slug from models where not is_test order by id`),
    pages: await read(sql`select id, label from pages where id = ${live.pageId}`),
    people: await read(sql`select id, code from people where not is_test order by id`),
    logins: await read(sql`select pl.user_id, pl.person_id from person_logins pl join people pe on pe.id = pl.person_id where not pe.is_test order by pl.user_id`),
    shifts: await read(sql`select id, state from shifts where user_id = ${live.userId} order by id`),
    handins: await read(sql`select id, shift_id, state, current_version from shift_handins where user_id = ${live.userId} order by id`),
    versions: await read(sql`select v.id, v.version from shift_handin_versions v join shift_handins h on h.id = v.handin_id where h.user_id = ${live.userId} order by v.id`),
    candidates: await read(sql`select c.id from shift_handin_candidates c join shift_handins h on h.id = c.handin_id where h.user_id = ${live.userId} order by c.id`),
    orders: await read(sql`select id, state from custom_orders where page_id = ${live.pageId} order by id`),
    orderEvents: await read(sql`select id, event from object_events where object_type = 'custom_order' and object_id in (
      select id::text from custom_orders where page_id = ${live.pageId}) order by id`),
    questions: await read(sql`select id, state from team_questions where page_id = ${live.pageId} order by id`),
    sends: await read(sql`select count(*)::int as n from client_send_attributions where page_id = ${live.pageId}`),
    fans: await read(sql`select id from fans where username = 'live_fan'`),
  }), (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  const app = createTestAppContext(testDb);
  const db = app.db as Database;
  await seedLive(db);
  await seedSandbox(app, {
    scenarios: ["shift", "customs", "matters", "publications"], env: {}, now: new Date(T0 - 12 * HOUR), printCheckerKey: true, standIn: ["live-1"],
  });
  await db.execute(sql`insert into person_rights (person_id, "right", granted_at)
    select id, 'submits_shift', ${new Date(T0 - 30 * DAY).toISOString()}::timestamptz from people where is_test and role = 'chatter'
    on conflict do nothing`);
  await syncShiftRowsSince(db, { from: new Date(T0 - 3 * DAY), now: new Date(T0) });

  const testPages = (await db.execute<{ id: string }>(sql`select p.id from pages p join models m on m.id = p.model_id where m.is_test order by p.id`)).rows.map((row) => Number(row.id));
  // Both realms hand a report in and have it counted.
  const anton = principalOf(await loginOf(db, "anton"), [live.pageId], false);
  await countReport(db, anton);
  const tChat = principalOf(await loginOf(db, "t-chat-2"), testPages, true);
  await countReport(db, tChat);

  // Both realms ask a question; the test team also asks a swap, answered «Можно» (the day's schedule lines).
  live.questionId = (await askTeamQuestion(app, anton, { pageLabel: "live-1", kind: "custom_price", text: "Сколько за кастом?", door: "workboard" }, new Date(T0))).question.id;
  const tAsker = principalOf(await loginOf(db, "t-chat-1"), testPages, true);
  await askTeamQuestion(app, tAsker, { pageLabel: "test-1", kind: "custom_price", text: "Сколько за кастом?", door: "workboard" }, new Date(T0));
  const swap = await askTeamQuestion(app, tAsker, {
    pageLabel: "test-1", kind: "swap", text: "Не выйду, выйдет второй", door: "workboard",
    swap: { date: "2026-11-12", pageLabels: ["test-1"], start: "16:00", end: "23:00", coverPersonCode: "t-chat-2" },
  }, new Date(T0));
  const decider = swap.question.decider.kind === "owner" ? "t-owner" : "t-lead";
  await answerQuestion(app, principalOf(await loginOf(db, decider), testPages, true), swap.question.id, { answer: "yes" }, new Date(T0 + HOUR));
}, 600_000);

afterAll(async () => {
  await testDb?.stop();
});

describe("sandbox:remove takes the whole test team and nothing live", () => {
  it("the removal's setting opens no live report: deleting a live version or candidate still raises", async (context) => {
    if (!testDb) return context.skip();
    for (const table of ["shift_handin_versions", "shift_handin_candidates"]) {
      const client = await testDb.pool.connect();
      try {
        await client.query("begin");
        await client.query("select set_config('agency_hub.sandbox_remove', 'test_realm', true)");
        await expect(client.query(`delete from ${table} where handin_id in (select id from shift_handins where user_id = $1)`, [live.userId]))
          .rejects.toThrow(/immutable|never deleted/u);
      } finally {
        await client.query("rollback");
        client.release();
      }
    }
    // Without the setting, a test person's report is refused too: the setting is the removal's alone.
    const client = await testDb.pool.connect();
    try {
      await client.query("begin");
      await expect(client.query(`delete from shift_handin_versions where handin_id in (select h.id from shift_handins h
        join person_logins pl on pl.user_id = h.user_id join people pe on pe.id = pl.person_id where pe.is_test)`)).rejects.toThrow(/immutable/u);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("--execute leaves nothing of the test realm, and every live row as it was", async (context) => {
    if (!testDb) return context.skip();
    const db = testDb.db as Database;
    const read = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows;
    const ids = {
      pages: (await read(sql`select p.id from pages p join models m on m.id = p.model_id where m.is_test`)).map((row) => String(row.id)),
      users: (await read(sql`select pl.user_id as id from person_logins pl join people pe on pe.id = pl.person_id where pe.is_test`)).map((row) => String(row.id)),
      matters: (await read(sql`select m.id from matters m where m.page_ids && (select array_agg(p.id) from pages p join models mo on mo.id = p.model_id where mo.is_test)
        or m.owner_user_id in (select pl.user_id from person_logins pl join people pe on pe.id = pl.person_id where pe.is_test)`)).map((row) => String(row.id)),
      orders: (await read(sql`select o.id from custom_orders o join pages p on p.id = o.page_id join models m on m.id = p.model_id where m.is_test`)).map((row) => String(row.id)),
      handins: (await read(sql`select h.id from shift_handins h join person_logins pl on pl.user_id = h.user_id join people pe on pe.id = pl.person_id where pe.is_test`)).map((row) => String(row.id)),
    };
    // The test team did all of it.
    const did = (await read(sql`select
        (select count(*)::int from shift_handin_versions v where v.handin_id::text = any(${sql.param(ids.handins)}::text[])) as versions,
        (select count(*)::int from shift_handin_candidates c where c.handin_id::text = any(${sql.param(ids.handins)}::text[])) as candidates,
        (select count(*)::int from team_questions q where q.page_id::text = any(${sql.param(ids.pages)}::text[])) as questions,
        (select count(*)::int from person_schedule_slots s where s.question_id is not null and s.page_id::text = any(${sql.param(ids.pages)}::text[])) as swap_lines,
        (select count(*)::int from publications pu where pu.page_id::text = any(${sql.param(ids.pages)}::text[])) as publications,
        (select count(*)::int from agent_keys k where k.page_ids && ${`{${ids.pages.join(",")}}`}::bigint[]) as keys`))[0]!;
    expect(did).toMatchObject({ questions: 2, keys: 1 });
    expect(Number(did.versions)).toBeGreaterThan(0);
    expect(Number(did.candidates)).toBeGreaterThan(0);
    expect(Number(did.swap_lines)).toBeGreaterThan(0);
    expect(Number(did.publications)).toBeGreaterThan(0);
    expect(ids.matters.length).toBeGreaterThan(0);
    expect(ids.orders.length).toBeGreaterThan(0);
    // The live page has a stand-in, and the day's sales are on it.
    const [standIn] = await read(sql`select p.id::text as id, (select count(*)::int from transactions t where t.platform_account_id = p.id) as sales
      from pages p where p.stands_in_for_page_id = ${live.pageId}`);
    expect(ids.pages).toContain(standIn!.id);
    expect(Number(standIn!.sales)).toBeGreaterThan(0);

    const before = await liveSnapshot(db);
    const plan = await planSandboxRemoval(db);
    expect(plan.modelId).not.toBeNull();
    await executeSandboxRemoval(db, { confirmModelId: plan.modelId! });
    expect(await liveSnapshot(db)).toEqual(before);

    // Nothing of the test realm is left: no model, page, person; no row naming a test page (with or without a foreign
    // key), a test login (by every foreign key to users: the login rows themselves stay as released tombstones), or the
    // test team's agent key; no history of a test object.
    expect(await read(sql`select id from models where is_test`)).toEqual([]);
    expect(await read(sql`select id from people where is_test`)).toEqual([]);
    expect(await read(sql`select id from pages where id::text = any(${sql.param(ids.pages)}::text[])`)).toEqual([]);
    expect(await read(sql`select id from users where id::text = any(${sql.param(ids.users)}::text[]) and deleted_at is null`)).toEqual([]);
    const columns = (await read(sql`
      select c.table_name, c.column_name, c.data_type,
        exists (select 1 from pg_constraint k join pg_class cl on cl.oid = k.conrelid join pg_class tg on tg.oid = k.confrelid
          join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
          where k.contype = 'f' and cl.relname = c.table_name and a.attname = c.column_name and tg.relname = 'users') as to_users
      from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.table_name not in ('users')
        and (c.column_name in ('page_id', 'platform_account_id', 'page_ids') or c.column_name like '%user_id'
          or (c.column_name = 'account_id' and c.table_name in ('message_archive', 'creator_post_tips', 'projection_seq_watermarks', 'page_fan_identities')))`))
      .map((row) => ({ table: String(row.table_name), column: String(row.column_name), array: row.data_type === "ARRAY", toUsers: row.to_users === true }));
    const left: string[] = [];
    for (const one of columns) {
      const isUser = one.column.endsWith("user_id");
      if (isUser && !one.toUsers && one.table !== "voice_notes") continue;
      const wanted = isUser ? ids.users : ids.pages;
      if (wanted.length === 0) continue;
      const where = one.array
        ? `"${one.column}" && array[${wanted.join(",")}]::bigint[]`
        : `"${one.column}"::text in (${wanted.map((id) => `'${id}'`).join(",")})`;
      const [found] = (await testDb.pool.query<{ n: number }>(`select count(*)::int as n from "${one.table}" where ${where}`)).rows;
      if (found!.n > 0) left.push(`${one.table}.${one.column}: ${found!.n}`);
    }
    expect(left).toEqual([]);
    const history = await read(sql`select object_type, object_id from object_events where
      (object_type = 'matter' and object_id = any(${sql.param(ids.matters)}::text[])) or (object_type = 'custom_order' and object_id = any(${sql.param(ids.orders)}::text[]))
      or (object_type = 'shift_report' and object_id = any(${sql.param(ids.handins)}::text[]))`);
    expect(history).toEqual([]);
    expect(await read(sql`select id from agent_keys where page_ids && ${`{${ids.pages.join(",")}}`}::bigint[]`)).toEqual([]);
    expect(await read(sql`select id from pages where stands_in_for_page_id is not null`)).toEqual([]);
    // The live question is still the live owner's to answer.
    expect(await read(sql`select id from team_questions where id = ${live.questionId} and state = 'open'`)).toHaveLength(1);
  }, 600_000);
});
