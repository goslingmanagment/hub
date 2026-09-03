import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";

/** The original governed parser's accepted set, including older revisions. */
export async function listObservedPostRefsForCapture(db: Database, pageId: number, observationId: number): Promise<string[]> {
  const result = await db.execute<{ post_ref: string }>(sql`
    select distinct post_ref from domain_events
     where account_id = ${pageId} and observation_id = ${observationId}
       and type = 'post.observed' and post_ref is not null
  `);
  return result.rows.map(row => row.post_ref);
}
