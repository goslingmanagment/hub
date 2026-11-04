import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The reads of a chatter's statistics (the cabinet's «Статистика»,
// apps/runtime services/chatter-stats.ts): their first minute in the
// extension, their own messages, and who is there to show. Database only; the
// rest is the repositories of the shifts (chatter-activity.ts), the sales
// (shift-reports.ts) and «Продажи» (team-sales.ts).

/** The first minute Hub has of the person in the extension; null — none. */
export async function findFirstChatterActivity(db: Database, userId: number): Promise<Date | null> {
  const result = await db.execute<{ first: Date | string | null }>(sql`
    select min(minute) as first from chatter_activity_minutes where user_id = ${userId}`);
  const first = result.rows[0]?.first ?? null;
  return first === null ? null : new Date(first);
}

/** Everyone's first minute Hub has in the extension, by user id. */
export async function listFirstChatterActivities(db: Database): Promise<Map<number, Date>> {
  const result = await db.execute<{ user_id: string | number; first: Date | string }>(sql`
    select user_id, min(minute) as first from chatter_activity_minutes group by user_id`);
  return new Map(result.rows.map((row) => [Number(row.user_id), new Date(row.first)]));
}

export interface AuthoredSendRow {
  pageId: number;
  fanRef: string;
  at: Date;
  /** A price in the archive, else the client's own flag (it cannot see a Fansly price). */
  priced: boolean;
  /** How the text was written (0305); null — a client older than the field. */
  composedWith: string | null;
}

/** The person's own messages on the pages in [from, to) (client_send_attributions), oldest first. */
export async function listAuthoredSends(
  db: Database,
  input: { userId: number; pageIds: readonly number[]; from: Date; to: Date },
): Promise<AuthoredSendRow[]> {
  if (input.pageIds.length === 0) return [];
  const result = await db.execute<{
    page_id: string | number; fan_ref: string; observed_at: Date | string; priced: boolean; composed_with: string | null;
  }>(sql`
    select a.page_id, a.fan_ref, a.observed_at, coalesce(m.price_mills > 0, a.priced) as priced, a.composed_with
    from client_send_attributions a
    left join message_archive m on m.account_id = a.page_id and m.platform = a.platform and m.message_ref = a.platform_message_id
    where a.user_id = ${input.userId} and a.page_id = any(${sql.param(input.pageIds.map(String))}::bigint[])
      and a.observed_at >= ${input.from.toISOString()}::timestamptz and a.observed_at < ${input.to.toISOString()}::timestamptz
    order by a.observed_at`);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    fanRef: row.fan_ref,
    at: new Date(row.observed_at),
    priced: row.priced,
    composedWith: row.composed_with,
  }));
}

/**
 * The people active in the extension on the pages (`all` — any page) in
 * [from, to), those who wrote the most first: the first of them is who a view
 * shows by default, and it should be someone who works.
 */
export async function listActivePeople(
  db: Database,
  input: { pages: "all" | readonly number[]; from: Date; to: Date },
): Promise<Array<{ userId: number; username: string }>> {
  if (input.pages !== "all" && input.pages.length === 0) return [];
  const pageFilter = input.pages === "all"
    ? sql`true`
    : sql`m.page_id = any(${sql.param(input.pages.map(String))}::bigint[])`;
  const from = input.from.toISOString();
  const to = input.to.toISOString();
  const result = await db.execute<{ user_id: string | number; username: string }>(sql`
    with active as (
      select distinct m.user_id
      from chatter_activity_minutes m
      where m.input and ${pageFilter} and m.minute >= ${from}::timestamptz and m.minute < ${to}::timestamptz
    )
    select u.id as user_id, u.username
    from active
    join users u on u.id = active.user_id
    left join lateral (
      select count(*) as sends from client_send_attributions a
      where a.user_id = u.id and a.observed_at >= ${from}::timestamptz and a.observed_at < ${to}::timestamptz
    ) written on true
    order by written.sends desc, u.username`);
  return result.rows.map((row) => ({ userId: Number(row.user_id), username: row.username }));
}
