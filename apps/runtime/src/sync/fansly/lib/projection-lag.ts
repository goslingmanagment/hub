import { sql } from "drizzle-orm";

import type { Database } from "@agency_hub_core/db";

// Walks that plan from a projection (the catalog's album list and its
// hydration queue, design §5.17; content map gap 3) wait until the projection
// has caught up with what they depend on, instead of re-reading a list that
// does not yet show the answer just applied. Read-only.

/**
 * Whether the page has events of `eventTypes` (of one observation, when
 * given) that `projection` has not projected yet: above its watermark of the
 * page. The range above a healthy watermark is the last minute or so of the
 * page's events, read through the `(account_id, account_seq)` index.
 */
export async function projectionBehind(
  db: Database,
  input: { pageId: number; projection: string; eventTypes: readonly string[]; observationId?: number | null },
): Promise<boolean> {
  const observation = input.observationId === undefined || input.observationId === null
    ? sql``
    : sql`and de.observation_id = ${input.observationId}`;
  const result = await db.execute<{ behind: boolean }>(sql`
    select exists (
      select 1
        from domain_events de
       where de.account_id = ${input.pageId}
         and de.account_seq > coalesce((
           select w.high_seq from projection_seq_watermarks w
            where w.projection = ${input.projection} and w.account_id = ${input.pageId}
         ), 0)
         and de.type = any(${sql.param([...input.eventTypes])}::text[])
         ${observation}
    ) as behind
  `);
  return result.rows[0]?.behind === true;
}
