import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { liveUserSql, testUserSql } from "./realm.ts";
import { modelCommentsOf } from "./shift-handins.ts";

// Workboard «Сегодня» (products package W): reads only, over the shift rows (`shifts`, 0379), the reports handed in
// (`shift_handins`, 0400) and a lead's notes (`review_notes`, 0415). Which pages a viewer may see is the caller's
// (services/teams.ts); these name pages by their labels, as a shift row keeps them.

type Row = Record<string, unknown>;

const date = (value: unknown) => (value instanceof Date ? value : new Date(String(value)));
const ids = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;

function labelsOf(value: unknown): string[] {
  const list: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(list)) return [];
  return list.flatMap((page) => (typeof page === "object" && page !== null && typeof (page as { pageLabel?: unknown }).pageLabel === "string" ? [(page as { pageLabel: string }).pageLabel] : []));
}

export interface TodayShiftRow {
  id: number;
  userId: number;
  username: string;
  state: "going" | "closed";
  startedAt: Date;
  endedAt: Date;
  workedMinutes: number;
  reportDate: string;
  pageLabels: string[];
}

function shiftOf(row: Row): TodayShiftRow {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    username: String(row.username ?? ""),
    state: row.state as TodayShiftRow["state"],
    startedAt: date(row.started_at),
    endedAt: date(row.ended_at),
    workedMinutes: Number(row.worked_minutes),
    reportDate: String(row.report_date),
    pageLabels: labelsOf(row.pages),
  };
}

const SHIFT_SELECT = sql`select s.id, s.user_id, u.username, s.state, s.started_at, s.ended_at, s.worked_minutes,
  to_char(s.report_date, 'YYYY-MM-DD') as report_date, s.pages
  from shifts s join users u on u.id = s.user_id`;

/** The shifts going on now (every login): «Сейчас на смене». */
export async function listGoingShifts(db: Database): Promise<TodayShiftRow[]> {
  const result = await db.execute<Row>(sql`${SHIFT_SELECT} where s.state = 'going' order by s.started_at, s.id`);
  return result.rows.map(shiftOf);
}

/** The closed shifts of a report date with no note on their review yet: «Разборы». */
export async function listUnnotedShiftsOf(db: Database, reportDate: string): Promise<TodayShiftRow[]> {
  const result = await db.execute<Row>(sql`${SHIFT_SELECT}
    where s.state = 'closed' and s.report_date = ${reportDate}::date
      and not exists (select 1 from review_notes n where n.shift_id = s.id)
    order by s.started_at, s.id`);
  return result.rows.map(shiftOf);
}

export interface HandoverRow {
  shift: TodayShiftRow;
  comment: string;
  /** Each model's own comment (0432); which of them the reader reads is the caller's (`modelComment`). */
  modelComments: Record<string, string>;
}

/**
 * The comments left for the next shift on reports of shifts ended since `since` on any of `pageLabels`, of logins other
 * than `exceptUserIds`, of one realm (0414): cut in the query, then limited — never the agency's latest cut afterwards.
 * A report counts when its general comment or a model's own is not empty.
 */
export async function listHandoverComments(db: Database, input: {
  since: Date; exceptUserIds: readonly number[]; pageLabels: readonly string[]; realm: "live" | "test"; limit: number;
}): Promise<HandoverRow[]> {
  if (input.pageLabels.length === 0) return [];
  const realm = input.realm === "test" ? testUserSql(sql`s.user_id`) : liveUserSql(sql`s.user_id`);
  const result = await db.execute<Row>(sql`select s.id, s.user_id, u.username, s.state, s.started_at, s.ended_at, s.worked_minutes,
      to_char(s.report_date, 'YYYY-MM-DD') as report_date, s.pages, h.comment, h.model_comments
    from shift_handins h join shifts s on s.id = h.shift_id join users u on u.id = s.user_id
    where s.state in ('going', 'closed') and s.ended_at >= ${input.since.toISOString()}::timestamptz
      and (btrim(h.comment) <> '' or exists (select 1 from jsonb_each_text(h.model_comments) as own where btrim(own.value) <> '')) and not (s.user_id = any(${ids(input.exceptUserIds)})) and ${realm}
      and exists (select 1 from jsonb_array_elements(s.pages) as shift_page
                   where shift_page->>'pageLabel' = any(${sql.param([...input.pageLabels])}::text[]))
    order by s.ended_at desc, s.id desc
    limit ${input.limit}`);
  return result.rows.map((row) => ({ shift: shiftOf(row), comment: String(row.comment), modelComments: modelCommentsOf(row.model_comments) }));
}

/** The starts of the logins' shifts with a note on their review (a lead's or the owner's): «Новички». */
export async function listNotedShiftStarts(db: Database, userIds: readonly number[]): Promise<Array<{ userId: number; startedAt: Date }>> {
  if (userIds.length === 0) return [];
  const result = await db.execute<Row>(sql`select distinct s.user_id, s.started_at
    from review_notes n join shifts s on s.id = n.shift_id
    where s.user_id = any(${ids(userIds)})`);
  return result.rows.map((row) => ({ userId: Number(row.user_id), startedAt: date(row.started_at) }));
}
