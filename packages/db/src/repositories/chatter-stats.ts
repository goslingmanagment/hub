import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The reads of a chatter's statistics (the cabinet's «Статистика»,
// apps/runtime services/chatter-stats.ts): their first minute in the
// extension, their own messages, who else was in their shift on a page when a
// sale came, and who is there to show. Database only; the rest is the
// repositories of the shifts (chatter-activity.ts), the sales
// (shift-reports.ts) and «Продажи» (team-sales.ts).

const MINUTES_BEFORE_SALE_OPEN = 2;
const MINUTES_AFTER_SALE_OPEN = 1;

/** The first minute Hub has of the person in the extension; null — none. */
export async function findFirstChatterActivity(db: Database, userId: number): Promise<Date | null> {
  const result = await db.execute<{ first: Date | string | null }>(sql`
    select min(minute) as first from chatter_activity_minutes where user_id = ${userId}`);
  const first = result.rows[0]?.first ?? null;
  return first === null ? null : new Date(first);
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
 * Who else was in their own shift on the sale's page when it came: someone
 * else had the page open in the extension around the sale's minute and was
 * active on one of `scopePageIds` within the hour before it — the shift's rule
 * (services/chatter-shifts.ts: a shift ends after an hour without activity).
 */
export async function listSaleCompanions(
  db: Database,
  input: { userId: number; scopePageIds: readonly number[]; sales: ReadonlyArray<{ transactionId: number; pageId: number; at: Date }> },
): Promise<Array<{ transactionId: number; userId: number; username: string }>> {
  if (input.sales.length === 0 || input.scopePageIds.length === 0) return [];
  const result = await db.execute<{ transaction_id: string | number; user_id: string | number; username: string }>(sql`
    select s.id as transaction_id, o.user_id, u.username
    from unnest(
      ${sql.param(input.sales.map((sale) => String(sale.transactionId)))}::bigint[],
      ${sql.param(input.sales.map((sale) => String(sale.pageId)))}::bigint[],
      ${sql.param(input.sales.map((sale) => sale.at.toISOString()))}::timestamptz[]
    ) as s(id, page_id, at)
    join lateral (
      select distinct o.user_id
      from chatter_activity_minutes o
      where o.page_id = s.page_id and o.user_id <> ${input.userId}
        and o.minute >= date_trunc('minute', s.at) - make_interval(mins => ${MINUTES_BEFORE_SALE_OPEN})
        and o.minute <= date_trunc('minute', s.at) + make_interval(mins => ${MINUTES_AFTER_SALE_OPEN})
        and exists (
          select 1 from chatter_activity_minutes i
          where i.user_id = o.user_id and i.input
            and i.page_id = any(${sql.param(input.scopePageIds.map(String))}::bigint[])
            and i.minute > s.at - interval '60 minutes' and i.minute <= s.at
        )
    ) o on true
    join users u on u.id = o.user_id
    order by s.id, u.username`);
  return result.rows.map((row) => ({ transactionId: Number(row.transaction_id), userId: Number(row.user_id), username: row.username }));
}

/** The people active in the extension on the pages (`all` — any page) in [from, to), by name. */
export async function listActivePeople(
  db: Database,
  input: { pages: "all" | readonly number[]; from: Date; to: Date },
): Promise<Array<{ userId: number; username: string }>> {
  if (input.pages !== "all" && input.pages.length === 0) return [];
  const pageFilter = input.pages === "all"
    ? sql`true`
    : sql`m.page_id = any(${sql.param(input.pages.map(String))}::bigint[])`;
  const result = await db.execute<{ user_id: string | number; username: string }>(sql`
    select distinct m.user_id, u.username
    from chatter_activity_minutes m join users u on u.id = m.user_id
    where m.input and ${pageFilter}
      and m.minute >= ${input.from.toISOString()}::timestamptz and m.minute < ${input.to.toISOString()}::timestamptz
    order by u.username`);
  return result.rows.map((row) => ({ userId: Number(row.user_id), username: row.username }));
}
