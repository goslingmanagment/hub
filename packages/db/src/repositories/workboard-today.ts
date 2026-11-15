import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

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
}

/** The comments left for the next shift on reports of shifts ended since `since`, of logins other than `exceptUserIds`. */
export async function listHandoverComments(db: Database, input: { since: Date; exceptUserIds: readonly number[]; limit: number }): Promise<HandoverRow[]> {
  const result = await db.execute<Row>(sql`select s.id, s.user_id, u.username, s.state, s.started_at, s.ended_at, s.worked_minutes,
      to_char(s.report_date, 'YYYY-MM-DD') as report_date, s.pages, h.comment
    from shift_handins h join shifts s on s.id = h.shift_id join users u on u.id = s.user_id
    where s.state in ('going', 'closed') and s.ended_at >= ${input.since.toISOString()}::timestamptz
      and btrim(h.comment) <> '' and not (s.user_id = any(${ids(input.exceptUserIds)}))
    order by s.ended_at desc, s.id desc
    limit ${input.limit}`);
  return result.rows.map((row) => ({ shift: shiftOf(row), comment: String(row.comment) }));
}

/** The starts of the logins' shifts with a note on their review (a lead's or the owner's): «Новички». */
export async function listNotedShiftStarts(db: Database, userIds: readonly number[]): Promise<Array<{ userId: number; startedAt: Date }>> {
  if (userIds.length === 0) return [];
  const result = await db.execute<Row>(sql`select distinct s.user_id, s.started_at
    from review_notes n join shifts s on s.id = n.shift_id
    where s.user_id = any(${ids(userIds)})`);
  return result.rows.map((row) => ({ userId: Number(row.user_id), startedAt: date(row.started_at) }));
}
