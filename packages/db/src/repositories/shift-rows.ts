import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// A chatter's shift as a row with a stable id (0379): what chatter-shifts.ts
// computes, written by the shift-rows job (apps/runtime services/shift-rows.ts
// plans what changes, this file writes it under one lock). No screen reads it
// yet. Rows are never deleted: a shift late activity unmade is `dropped`, one
// it joined to another is `merged`, and every change after the first write is
// traced in `shift_changes`.

export type ShiftRowState = "going" | "closed" | "dropped" | "merged";
export type ShiftChangeKind = "opened" | "moved" | "closed" | "reopened" | "dropped" | "restored" | "merged";

export interface ShiftRowPage {
  pageLabel: string;
  activeMinutes: number;
  messages: number;
  /** From when the shift holds the page's sales (ISO); null — it worked the page but holds none. */
  salesFrom: string | null;
}

/** A shift as computed: what a row holds. */
export interface ShiftRowFacts {
  userId: number;
  state: "going" | "closed";
  startedAt: Date;
  /** A going shift's: the last time the job looked. */
  endedAt: Date;
  workedMinutes: number;
  messages: number;
  /** YYYY-MM-DD, Moscow. */
  reportDate: string;
  pages: ShiftRowPage[];
  pauses: Array<{ from: string; to: string }>;
}

export interface ShiftRowRecord extends Omit<ShiftRowFacts, "state"> {
  id: number;
  state: ShiftRowState;
  mergedInto: number | null;
}

/** What a sync changes: rows to open, rows that changed (`change` null — a going shift's end moved, not traced), merged, dropped. */
export interface ShiftRowsPlan {
  open: ShiftRowFacts[];
  update: Array<{ id: number; change: ShiftChangeKind | null; before: ShiftRowRecord; after: ShiftRowFacts }>;
  merge: Array<{ id: number; into: number; before: ShiftRowRecord }>;
  drop: Array<{ id: number; before: ShiftRowRecord }>;
}

export interface ShiftRowsSyncResult {
  opened: number;
  updated: number;
  traced: number;
  merged: number;
  dropped: number;
}

/** Serialises every sync of the rows: the job and a CLI run never interleave. */
const SHIFT_ROWS_LOCK = 9_037_901;

type Row = {
  id: string | number;
  user_id: string | number;
  state: ShiftRowState;
  started_at: Date | string;
  ended_at: Date | string;
  worked_minutes: number;
  messages: number;
  report_date: string | Date;
  pages: ShiftRowPage[];
  pauses: Array<{ from: string; to: string }>;
  merged_into: string | number | null;
};

const SELECT = sql`select id, user_id, state, started_at, ended_at, worked_minutes, messages, to_char(report_date, 'YYYY-MM-DD') as report_date,
  pages, pauses, merged_into from shifts`;

function recordOf(row: Row): ShiftRowRecord {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    state: row.state,
    startedAt: new Date(row.started_at),
    endedAt: new Date(row.ended_at),
    workedMinutes: Number(row.worked_minutes),
    messages: Number(row.messages),
    reportDate: String(row.report_date),
    pages: row.pages,
    pauses: row.pauses,
    mergedInto: row.merged_into === null ? null : Number(row.merged_into),
  };
}

/** A row as its trace keeps it. */
function traceOf(row: Omit<ShiftRowFacts, "userId"> | Omit<ShiftRowRecord, "id" | "userId" | "mergedInto">) {
  return {
    state: row.state,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    workedMinutes: row.workedMinutes,
    messages: row.messages,
    reportDate: row.reportDate,
    pages: row.pages,
  };
}

/** Every row of every state that ended after `endedAfter` (a going one: last looked at after it), oldest first. */
export async function listShiftRowsEndingAfter(db: Database, endedAfter: Date): Promise<ShiftRowRecord[]> {
  const result = await db.execute<Row>(sql`${SELECT} where ended_at > ${endedAfter.toISOString()}::timestamptz order by started_at, id`);
  return result.rows.map(recordOf);
}

/** The rows of shifts that began in [from, to) (of one person, when given), oldest first; dropped and merged ones too. */
export async function listShiftRows(db: Database, input: { from: Date; to: Date; userId?: number }): Promise<ShiftRowRecord[]> {
  const person = input.userId === undefined ? sql`` : sql`and user_id = ${input.userId}`;
  const result = await db.execute<Row>(sql`${SELECT}
    where started_at >= ${input.from.toISOString()}::timestamptz and started_at < ${input.to.toISOString()}::timestamptz ${person}
    order by started_at, id`);
  return result.rows.map(recordOf);
}

/**
 * The shift a person's address names by an instant (`/shifts/:userId/:start`): the row of theirs that held `at`, or
 * whose start was `at` before it moved; a merged row resolves to the one it joined. Null — none.
 */
export async function findShiftRowAt(db: Database, input: { userId: number; at: Date }): Promise<ShiftRowRecord | null> {
  const at = input.at.toISOString();
  const result = await db.execute<Row>(sql`${SELECT}
    where user_id = ${input.userId}
      and ((started_at <= ${at}::timestamptz and ended_at >= ${at}::timestamptz)
        or exists (select 1 from shift_changes c where c.shift_id = shifts.id and (c.before ->> 'startedAt')::timestamptz = ${at}::timestamptz))
    order by (state in ('going', 'closed')) desc, id
    limit 1`);
  let row = result.rows[0] === undefined ? null : recordOf(result.rows[0]);
  for (let hops = 0; row !== null && row.mergedInto !== null && hops < 10; hops += 1) {
    const next = await db.execute<Row>(sql`${SELECT} where id = ${row.mergedInto}`);
    row = next.rows[0] === undefined ? null : recordOf(next.rows[0]);
  }
  return row;
}

/**
 * One sync of the rows: under one lock, the rows that ended after `endedAfter` are read, `plan` says what changes, and
 * it is written with its trace, in one transaction.
 */
export async function syncShiftRows(
  db: Database,
  input: { endedAfter: Date; now: Date; plan: (existing: ShiftRowRecord[]) => ShiftRowsPlan },
): Promise<ShiftRowsSyncResult> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(${SHIFT_ROWS_LOCK})`);
    const plan = input.plan(await listShiftRowsEndingAfter(tx, input.endedAfter));
    const now = input.now.toISOString();
    const result: ShiftRowsSyncResult = { opened: 0, updated: 0, traced: 0, merged: 0, dropped: 0 };
    const trace = async (shiftId: number, change: ShiftChangeKind, before: unknown, after: unknown) => {
      await tx.execute(sql`insert into shift_changes (shift_id, changed_at, change, before, after)
        values (${shiftId}, ${now}::timestamptz, ${change}, ${before === null ? null : JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb)`);
      result.traced += 1;
    };
    for (const one of plan.merge) {
      await tx.execute(sql`update shifts set state = 'merged', merged_into = ${one.into}, updated_at = ${now}::timestamptz where id = ${one.id}`);
      await trace(one.id, "merged", traceOf(one.before), { ...traceOf(one.before), state: "merged", mergedInto: one.into });
      result.merged += 1;
    }
    for (const one of plan.drop) {
      await tx.execute(sql`update shifts set state = 'dropped', updated_at = ${now}::timestamptz where id = ${one.id}`);
      await trace(one.id, "dropped", traceOf(one.before), { ...traceOf(one.before), state: "dropped" });
      result.dropped += 1;
    }
    for (const one of plan.update) {
      const after = one.after;
      await tx.execute(sql`update shifts set
          state = ${after.state}, merged_into = null, started_at = ${after.startedAt.toISOString()}::timestamptz,
          ended_at = ${after.endedAt.toISOString()}::timestamptz, worked_minutes = ${after.workedMinutes}, messages = ${after.messages},
          report_date = ${after.reportDate}::date, pages = ${JSON.stringify(after.pages)}::jsonb, pauses = ${JSON.stringify(after.pauses)}::jsonb,
          closed_at = case when ${after.state} = 'closed' then coalesce(closed_at, ${now}::timestamptz) else null end,
          updated_at = ${now}::timestamptz
        where id = ${one.id}`);
      result.updated += 1;
      if (one.change !== null) await trace(one.id, one.change, traceOf(one.before), traceOf(after));
    }
    for (const after of plan.open) {
      const inserted = await tx.execute<{ id: string | number }>(sql`insert into shifts
          (user_id, state, started_at, ended_at, worked_minutes, messages, report_date, pages, pauses, opened_at, closed_at, updated_at)
        values (${after.userId}, ${after.state}, ${after.startedAt.toISOString()}::timestamptz, ${after.endedAt.toISOString()}::timestamptz,
          ${after.workedMinutes}, ${after.messages}, ${after.reportDate}::date, ${JSON.stringify(after.pages)}::jsonb,
          ${JSON.stringify(after.pauses)}::jsonb, ${now}::timestamptz, ${after.state === "closed" ? now : null}::timestamptz, ${now}::timestamptz)
        returning id`);
      await trace(Number(inserted.rows[0]!.id), "opened", null, traceOf(after));
      result.opened += 1;
    }
    return result;
  });
}
