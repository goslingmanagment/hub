import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// A traffic source without links (subscribers for subscribers on a free page, 0428 counter_page_id) is measured by
// its page's own counter of new subscribers: daily_subscribers.new_subscribers, one row per page and Moscow business
// day, rewritten while the day goes on (updated_at). A day's figure is final only once its row was written after
// the day ended; before that it is what the day had brought by then.

export interface PageNewSubscribersRow {
  pageId: number;
  businessDate: string;
  newSubscribers: number;
  updatedAt: Date;
}

/** The pages' rows of the counter over Moscow days `from`…`to` (inclusive), oldest first. */
export async function listPageNewSubscriberDays(
  db: Database,
  input: { pageIds: readonly number[]; from: string; to: string },
): Promise<PageNewSubscribersRow[]> {
  if (input.pageIds.length === 0) return [];
  const result = await db.execute<{ page_id: string; business_date: string; new_subscribers: number; updated_at: Date | string }>(sql`
    select platform_account_id::text as page_id, business_date::text as business_date, new_subscribers, updated_at
      from daily_subscribers
     where platform_account_id = any(${`{${input.pageIds.map((id) => Math.trunc(id)).join(",")}}`}::bigint[])
       and business_date between ${input.from}::date and ${input.to}::date
     order by business_date, platform_account_id`);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    businessDate: row.business_date,
    newSubscribers: Number(row.new_subscribers),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  }));
}

export interface CounterDay {
  businessDate: string;
  /** The day's new subscribers; null: no row, or the day is not finished in the counter. */
  newSubscribers: number | null;
  /** An unfinished day's value so far (today, or a past day whose row was last written before the day ended). */
  partial: number | null;
}

/** One business day of the counter, given the instant the day ended and whether it is today. Pure. */
export function counterDayOf(
  row: Pick<PageNewSubscribersRow, "newSubscribers" | "updatedAt"> | undefined,
  day: { businessDate: string; endAt: Date; today: boolean },
): CounterDay {
  if (row === undefined) return { businessDate: day.businessDate, newSubscribers: null, partial: null };
  if (day.today || row.updatedAt.getTime() < day.endAt.getTime()) {
    return { businessDate: day.businessDate, newSubscribers: null, partial: row.newSubscribers };
  }
  return { businessDate: day.businessDate, newSubscribers: row.newSubscribers, partial: null };
}
