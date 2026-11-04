import { sql } from "drizzle-orm";

import { BUSINESS_TIME_ZONE } from "@agency_hub_core/shared";

/** The agency's time zone as an SQL literal — a code constant, never input.
 *  `timezone(${BUSINESS_TZ}, t.occurred_at)::date` is the business day of an
 *  instant; the daily rollups (revenue, spenders, followers, subscribers) are
 *  dated with it. */
export const BUSINESS_TZ = sql.raw(`'${BUSINESS_TIME_ZONE}'`);
