import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

import type { Database } from "../client.ts";

// The test realm (0414): a model and a person can be test; a page is test through its model, a login through its
// person. These are the database half of the wall; what it means for a principal, a feed or a routine is decided in
// apps/runtime/src/services/sandbox/realm.ts, which every reader goes through.
//
// The conditions below are written so a row WITHOUT a page (or a person, or a login) stays live: an owner's
// unscoped read keeps every row it reads today (deleted and inactive pages included) and loses only test rows.

type Column = SQLWrapper | SQL;

/** True for a row whose page is not a test page (a null page is live). */
export function livePageSql(pageId: Column): SQL {
  return sql`not exists (select 1 from pages realm_p join models realm_m on realm_m.id = realm_p.model_id
    where realm_p.id = ${pageId} and realm_m.is_test)`;
}

/** True for a row whose page is a test page. */
export function testPageSql(pageId: Column): SQL {
  return sql`exists (select 1 from pages realm_p join models realm_m on realm_m.id = realm_p.model_id
    where realm_p.id = ${pageId} and realm_m.is_test)`;
}

/** True for a row whose model is not a test model. */
export function liveModelSql(modelId: Column): SQL {
  return sql`not exists (select 1 from models realm_m where realm_m.id = ${modelId} and realm_m.is_test)`;
}

/** True for a row whose person is not a test person (no person: live). */
export function livePersonSql(personId: Column): SQL {
  return sql`not exists (select 1 from people realm_pe where realm_pe.id = ${personId} and realm_pe.is_test)`;
}

/** True for a row whose login (users.id) is not a test person's (a login without a person is live). */
export function liveUserSql(userId: Column): SQL {
  return sql`not exists (select 1 from person_logins realm_pl join people realm_pe on realm_pe.id = realm_pl.person_id
    where realm_pl.user_id = ${userId} and realm_pe.is_test)`;
}

/** True for a row whose login is a test person's. */
export function testUserSql(userId: Column): SQL {
  return sql`exists (select 1 from person_logins realm_pl join people realm_pe on realm_pe.id = realm_pl.person_id
    where realm_pl.user_id = ${userId} and realm_pe.is_test)`;
}

/** True for a `bigint[]` of pages with no test page in it (empty: live). */
export function livePageArraySql(pageIds: Column): SQL {
  return sql`not exists (select 1 from unnest(${pageIds}) as realm_page_id
    join pages realm_p on realm_p.id = realm_page_id join models realm_m on realm_m.id = realm_p.model_id
    where realm_m.is_test)`;
}

function ids(rows: Array<Record<string, unknown>>, key = "id"): number[] {
  return rows.map((row) => Number(row[key]));
}

/** Every test page, deleted ones included. */
export async function listTestPageIds(db: Database): Promise<number[]> {
  const result = await db.execute(sql`select p.id from pages p join models m on m.id = p.model_id where m.is_test order by p.id`);
  return ids(result.rows as Array<Record<string, unknown>>);
}

/** Every live page, deleted and inactive ones included. */
export async function listLivePageIds(db: Database): Promise<number[]> {
  const result = await db.execute(sql`select p.id from pages p join models m on m.id = p.model_id where not m.is_test order by p.id`);
  return ids(result.rows as Array<Record<string, unknown>>);
}

/** Every test login (users.id of a test person). */
export async function listTestUserIds(db: Database): Promise<number[]> {
  const result = await db.execute(sql`select pl.user_id from person_logins pl join people pe on pe.id = pl.person_id
    where pe.is_test order by pl.user_id`);
  return ids(result.rows as Array<Record<string, unknown>>, "user_id");
}

/** Every test person. */
export async function listTestPersonIds(db: Database): Promise<number[]> {
  const result = await db.execute(sql`select id from people where is_test order by id`);
  return ids(result.rows as Array<Record<string, unknown>>);
}

/** Whether the login is a test person's. */
export async function isTestUser(db: Database, userId: number): Promise<boolean> {
  const result = await db.execute(sql`select ${testUserSql(sql`${userId}::bigint`)} as test`);
  return (result.rows[0] as { test?: boolean } | undefined)?.test === true;
}

/** Whether the page is a test page. */
export async function isTestPage(db: Database, pageId: number): Promise<boolean> {
  const result = await db.execute(sql`select ${testPageSql(sql`${pageId}::bigint`)} as test`);
  return (result.rows[0] as { test?: boolean } | undefined)?.test === true;
}

/** Whether the person is a test person. */
export async function isTestPerson(db: Database, personId: number): Promise<boolean> {
  const result = await db.execute(sql`select exists (select 1 from people where id = ${personId} and is_test) as test`);
  return (result.rows[0] as { test?: boolean } | undefined)?.test === true;
}

/** Whether a shift is a test person's (null: no such shift). */
export async function isTestShift(db: Database, shiftId: number): Promise<boolean | null> {
  const result = await db.execute(sql`select ${testUserSql(sql`s.user_id`)} as test from shifts s where s.id = ${shiftId}`);
  const row = result.rows[0] as { test?: boolean } | undefined;
  return row === undefined ? null : row.test === true;
}

/** Which of these sales are of test pages. */
export async function listTestTransactionIds(db: Database, transactionIds: readonly number[]): Promise<number[]> {
  if (transactionIds.length === 0) return [];
  const result = await db.execute(sql`select t.id from transactions t
    where t.id = any(${sql.param(transactionIds.map(String))}::bigint[]) and ${testPageSql(sql`t.platform_account_id`)}`);
  return ids(result.rows as Array<Record<string, unknown>>);
}

/** The test team as «Система → Состояние» names it: how many people, when one of them last worked (null: never). */
export async function readSandboxSummary(db: Database): Promise<{ people: number; lastWorkedAt: Date | null } | null> {
  const result = await db.execute(sql`
    select (select count(*)::int from people where is_test) as people,
      (select max(m.minute) from chatter_activity_minutes m where ${testUserSql(sql`m.user_id`)}) as last_worked`);
  const row = result.rows[0] as { people: number; last_worked: Date | string | null } | undefined;
  if (row === undefined || Number(row.people) === 0) return null;
  return { people: Number(row.people), lastWorkedAt: row.last_worked === null ? null : new Date(row.last_worked) };
}

/** Whether an off-platform line (a report's money outside the platforms) is a test person's (null: no such line). */
export async function isTestOffPlatformLine(db: Database, id: number): Promise<boolean | null> {
  const result = await db.execute(sql`select ${testUserSql(sql`o.user_id`)} as test from off_platform_sales o where o.id = ${id}`);
  const row = result.rows[0] as { test?: boolean } | undefined;
  return row === undefined ? null : row.test === true;
}

/** Whether a page (by label) is a test page (null: no such page). */
export async function isTestPageLabel(db: Database, label: string): Promise<boolean | null> {
  const result = await db.execute(sql`select ${testPageSql(sql`p.id`)} as test from pages p where p.label = ${label}`);
  const row = result.rows[0] as { test?: boolean } | undefined;
  return row === undefined ? null : row.test === true;
}

/** The test team's owner by name (the decider of a test shift's dispute): a test person of the owner's role with a login. */
export async function findTestOwnerLogin(db: Database): Promise<{ userId: number; name: string } | null> {
  const result = await db.execute(sql`select pl.user_id, pe.display_name from person_logins pl join people pe on pe.id = pl.person_id
    join users u on u.id = pl.user_id where pe.is_test and pe.role = 'owner' and u.deleted_at is null order by pl.user_id limit 1`);
  const row = result.rows[0] as { user_id: number | string; display_name: string } | undefined;
  return row === undefined ? null : { userId: Number(row.user_id), name: row.display_name };
}
