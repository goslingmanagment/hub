import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// «Начало» of a newcomer (ecosystem plan 2026-11-12, package J): the facts the
// steps close by, each read where it already lives — the device sign-ins
// (device_tokens), the pages opened to the login (user_page_assignments), the
// first active minute in the extension (chatter_activity_minutes), the
// invitation's use (account_links) — and the one thing a person writes here:
// where their payouts go (person_payout_details, 0402). Raw SQL: the tables are
// their migrations' alone. Nothing here is deleted; clearing writes null.

type Row = Record<string, unknown>;

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}
function ids(values: readonly number[]) {
  return sql`${sql.param(values.map(String))}::bigint[]`;
}

export interface PersonStartDeviceRow {
  userId: number;
  /** What the client called itself: «Firefox · Windows · ChatGoose». */
  label: string;
  createdAt: Date;
  /** Not revoked and not expired now. */
  active: boolean;
}

/** Every device sign-in of the logins, oldest first. */
export async function listPersonStartDevices(db: Database, userIds: readonly number[]): Promise<PersonStartDeviceRow[]> {
  if (userIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select d.user_id, d.label, d.created_at, (d.revoked_at is null and d.expires_at > now()) as active
      from device_tokens d
     where d.user_id = any(${ids(userIds)})
     order by d.created_at, d.id`);
  return result.rows.map((row) => ({
    userId: Number(row.user_id),
    label: String(row.label ?? ""),
    createdAt: date(row.created_at),
    active: row.active === true,
  }));
}

export interface PersonStartPageRow {
  userId: number;
  pageId: number;
  label: string;
  platform: "fansly" | "onlyfans" | "telegram";
  modelName: string;
  assignedAt: Date;
}

/** The pages opened to the logins (access, not the registry's working pages), by model and label. */
export async function listPersonStartPages(db: Database, userIds: readonly number[]): Promise<PersonStartPageRow[]> {
  if (userIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select a.user_id, pg.id as page_id, pg.label, pg.platform, m.name as model_name, a.created_at
      from user_page_assignments a
      join pages pg on pg.id = a.platform_account_id
      join models m on m.id = pg.model_id
     where a.user_id = any(${ids(userIds)})
     order by m.name, pg.label, a.user_id`);
  return result.rows.map((row) => ({
    userId: Number(row.user_id),
    pageId: Number(row.page_id),
    label: String(row.label),
    platform: row.platform as PersonStartPageRow["platform"],
    modelName: String(row.model_name),
    assignedAt: date(row.created_at),
  }));
}

export interface PersonFirstActiveMinuteRow {
  userId: number;
  pageLabel: string;
  minute: Date;
}

/** Each login's first minute with input on a page in the extension; a login with none has no row. */
export async function listPersonFirstActiveMinutes(db: Database, userIds: readonly number[]): Promise<PersonFirstActiveMinuteRow[]> {
  if (userIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select u.id as user_id, pg.label, fm.minute
      from unnest(${ids(userIds)}) as u(id)
      cross join lateral (
        select c.page_id, c.minute from chatter_activity_minutes c
         where c.user_id = u.id and c.input
         order by c.minute limit 1
      ) fm
      join pages pg on pg.id = fm.page_id`);
  return result.rows.map((row) => ({ userId: Number(row.user_id), pageLabel: String(row.label), minute: date(row.minute) }));
}

/** When each login first used an invitation (set its password through it); a login never invited has no row. */
export async function listPersonInvitesUsed(db: Database, userIds: readonly number[]): Promise<{ userId: number; usedAt: Date }[]> {
  if (userIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select l.user_id, min(l.used_at) as used_at
      from account_links l
     where l.user_id = any(${ids(userIds)}) and l.kind = 'invite' and l.used_at is not null
     group by l.user_id`);
  return result.rows.map((row) => ({ userId: Number(row.user_id), usedAt: date(row.used_at) }));
}

export interface PersonPayoutDetailsRow {
  personId: number;
  details: string;
  updatedAt: Date;
}

/** Where the people's payouts go; a person who never wrote it, or cleared it, has no row here. Money-adjacent: see 0402. */
export async function listPersonPayoutDetails(db: Database, personIds: readonly number[]): Promise<PersonPayoutDetailsRow[]> {
  if (personIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select person_id, details, updated_at from person_payout_details
     where person_id = any(${ids(personIds)}) and details is not null`);
  return result.rows.map((row) => ({ personId: Number(row.person_id), details: String(row.details), updatedAt: date(row.updated_at) }));
}

/** Writes the person's own text (null clears it); the row stays. */
export async function upsertPersonPayoutDetails(
  db: Database,
  input: { personId: number; details: string | null; byUserId: number },
): Promise<{ before: string | null }> {
  const before = await db.execute<Row>(sql`select details from person_payout_details where person_id = ${input.personId} for update`);
  await db.execute(sql`
    insert into person_payout_details (person_id, details, updated_at, updated_by_user_id)
    values (${input.personId}, ${input.details}, now(), ${input.byUserId})
    on conflict (person_id) do update
      set details = excluded.details, updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id`);
  const row = before.rows[0];
  return { before: row === undefined || row.details === null ? null : String(row.details) };
}
