import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { ppvBoughtSql, seenMessageSql } from "./shift-sql.ts";

// The stored numbers of closed shifts (0417 `shift_numbers`, products package N). What a row holds is
// apps/runtime services/chatter-numbers.ts `shiftNumbersOf`'s answer, written by the job team.shift-numbers; this file
// only stores, finds and marks. Raw SQL: the table is defined by its migration alone. Database only.

export interface StoredShiftNumbers {
  userId: number;
  startedAt: Date;
  endedAt: Date;
  workedMinutes: number;
  revision: number;
  key: string;
  inputsMark: string;
  /** The ShiftNumbersRow as written (chatter-numbers.ts). */
  numbers: Record<string, unknown>;
  computedAt: Date;
}

type Stamp = Date | string;
type Num = string | number;

/** The stored rows of these logins' shifts that began in [from, to). */
export async function listStoredShiftNumbers(
  db: Database,
  input: { userIds: readonly number[]; from: Date; to: Date },
): Promise<StoredShiftNumbers[]> {
  if (input.userIds.length === 0) return [];
  const result = await db.execute<{
    user_id: Num; started_at: Stamp; ended_at: Stamp; worked_minutes: Num; revision: Num; key: string; inputs_mark: string;
    numbers: Record<string, unknown>; computed_at: Stamp;
  }>(sql`
    select user_id, started_at, ended_at, worked_minutes, revision, key, inputs_mark, numbers, computed_at
      from shift_numbers
     where user_id = any(${sql.param(input.userIds.map(String))}::bigint[])
       and started_at >= ${input.from.toISOString()}::timestamptz and started_at < ${input.to.toISOString()}::timestamptz`);
  return result.rows.map((row) => ({
    userId: Number(row.user_id),
    startedAt: new Date(row.started_at),
    endedAt: new Date(row.ended_at),
    workedMinutes: Number(row.worked_minutes),
    revision: Number(row.revision),
    key: row.key,
    inputsMark: row.inputs_mark,
    numbers: row.numbers,
    computedAt: new Date(row.computed_at),
  }));
}

/** Writes a closed shift's numbers over whatever its start held. One short statement: no transaction is held. */
export async function upsertShiftNumbers(db: Database, row: Omit<StoredShiftNumbers, "computedAt">, now: Date): Promise<void> {
  await db.execute(sql`
    insert into shift_numbers (user_id, started_at, ended_at, worked_minutes, revision, key, inputs_mark, numbers, computed_at)
    values (${row.userId}, ${row.startedAt.toISOString()}::timestamptz, ${row.endedAt.toISOString()}::timestamptz, ${row.workedMinutes},
      ${row.revision}, ${row.key}, ${row.inputsMark}, ${JSON.stringify(row.numbers)}::jsonb, ${now.toISOString()}::timestamptz)
    on conflict (user_id, started_at) do update set
      ended_at = excluded.ended_at, worked_minutes = excluded.worked_minutes, revision = excluded.revision, key = excluded.key,
      inputs_mark = excluded.inputs_mark, numbers = excluded.numbers, computed_at = excluded.computed_at`);
}

/**
 * A cheap mark of the facts a shift's numbers are read from (`readShiftNumbers`): the page messages of its window and
 * the wait horizon before it (with their deletions and pending contents), the author reports there, the priced
 * messages of the window bought since, the purchases of the window, the login's AI texts. Any of them moving — a late
 * author report, a late message, a PPV bought days later — changes the mark, and the row is recomputed. A superset:
 * a change that moves no number only costs a recomputation. The shadow check (`compareShiftNumbers`) is the proof.
 */
export async function shiftInputsMark(
  db: Database,
  input: { userId: number; pageIds: readonly number[]; start: Date; end: Date; horizonHours: number; aiLookbackMinutes: number; deletedUnseenSeconds: number },
): Promise<string> {
  if (input.pageIds.length === 0) return "none";
  const pages = sql`${sql.param(input.pageIds.map(String))}::bigint[]`;
  const from = sql`${input.start.toISOString()}::timestamptz`;
  const to = sql`${input.end.toISOString()}::timestamptz + interval '1 millisecond'`;
  const horizon = sql`${from} - make_interval(hours => ${input.horizonHours})`;
  const result = await db.execute<{ mark: string }>(sql`
    select concat_ws('/',
      (select concat_ws('.', count(*), count(*) filter (where m.deleted_at is not null), count(*) filter (where m.content_pending),
          count(*) filter (where ${seenMessageSql("m", input.deletedUnseenSeconds)}))
         from message_archive m
        where m.account_id = any(${pages}) and m.occurred_at > ${horizon} and m.occurred_at < ${to}),
      (select concat_ws('.', count(*), count(distinct a.user_id))
         from client_send_attributions a
        where a.page_id = any(${pages}) and a.observed_at > ${horizon} - interval '1 hour' and a.observed_at < ${to} + interval '1 hour'),
      (select count(*) from message_archive p
        where p.account_id = any(${pages}) and p.occurred_at >= ${from} and p.occurred_at < ${to} and p.is_sent_by_me and p.price_mills > 0
          and ${ppvBoughtSql({ pageId: "p.account_id", platform: "p.platform", ref: "p.message_ref", conv: "p.conversation_ref", at: "p.occurred_at" })}),
      (select count(*) from transactions t
        where t.platform_account_id = any(${pages}) and t.is_active and t.occurred_at >= ${from} and t.occurred_at < ${to}),
      (select count(*) from ai_generation_content g
        where g.user_id = ${input.userId} and g.page_id = any(${pages})
          and g.created_at >= ${from} - make_interval(mins => ${input.aiLookbackMinutes}) and g.created_at < ${to})
    ) as mark`);
  return result.rows[0]?.mark ?? "none";
}

/** Each login's person (`person_logins`), a disabled or deleted login too: a person's old shifts stay theirs. */
export async function listPersonLoginsOf(db: Database, userIds?: readonly number[]): Promise<Array<{ userId: number; personId: number }>> {
  const result = await db.execute<{ user_id: Num; person_id: Num }>(userIds === undefined
    ? sql`select user_id, person_id from person_logins`
    : sql`select user_id, person_id from person_logins where user_id = any(${sql.param(userIds.map(String))}::bigint[])`);
  return result.rows.map((row) => ({ userId: Number(row.user_id), personId: Number(row.person_id) }));
}
