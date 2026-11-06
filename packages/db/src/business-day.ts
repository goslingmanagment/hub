import { sql, type SQL } from "drizzle-orm";

import { BUSINESS_TIME_ZONE, parseBusinessDate, toBusinessDate, UTC_TIME_ZONE } from "@agency_hub_core/shared";

/** The agency's time zone as an SQL literal — a code constant, never input.
 *  `timezone(${BUSINESS_TZ}, t.occurred_at)::date` is the business day of an
 *  instant; the daily rollups (revenue, spenders, followers, subscribers) are
 *  dated with it. */
export const BUSINESS_TZ = sql.raw(`'${BUSINESS_TIME_ZONE}'`);

/** The first of the last 30 business dates at `now`, today (the business day
 *  of `now`, not the UTC one) among them: «за 30 дней» of the fan card,
 *  «Онлайн» and the fan queues, as the page's Spenders stats count it. */
export function firstOfLast30BusinessDates(now: Date): string {
  const { year, month, day } = parseBusinessDate(toBusinessDate(now, BUSINESS_TIME_ZONE));
  return toBusinessDate(new Date(Date.UTC(year, month - 1, day - 29)), UTC_TIME_ZONE);
}

/** `businessDate` (a rollup's `business_date`) is one of the last 30 business
 *  dates at `now`, today among them. The one definition of the window: every
 *  «30 days» sum over `fan_spend_daily` reads it, so the fan card and the lists
 *  cannot drift apart again (review 2026-10-25: «>= - 30» took 31 dates; the
 *  session's UTC date took a 32nd from 21:00 UTC). */
export function inLast30BusinessDates(businessDate: SQL, now: Date): SQL {
  return sql`${businessDate} >= ${firstOfLast30BusinessDates(now)}::date`;
}
