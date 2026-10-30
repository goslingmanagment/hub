import { capturePayloadRefFromColumns } from "@agency_hub_core/db";
import { sql } from "drizzle-orm";

import type { AppContext } from "../bootstrap.ts";
import { applyPageProfile } from "../sync/fansly/resources/account.ts";
import { isCapturePayloadUnavailable, resolveCapturePayloadRow } from "./payload-reader.ts";

// `fansly:profile-backfill` (0337): the page profile out of every `/account/me`
// answer already in the journal (kind `account_me`, since 2026-07: the engine's
// polls and the page browser's site). The same apply as the hourly poll
// (`applyPageProfile`): idempotent and order-free, so a run can be repeated or
// stopped at any point. Reads only; Fansly is never asked.

const BATCH = 500;

export interface PageProfileBackfillResult {
  pageId: number;
  read: number;
  applied: number;
  /** Answers naming no account or another one, or whose body the payload
   *  store cannot give. */
  skipped: number;
}

export async function backfillFanslyPageProfile(
  app: Pick<AppContext, "db" | "logger">,
  input: { pageId: number; onBatch?: (progress: PageProfileBackfillResult) => void },
): Promise<PageProfileBackfillResult> {
  const result: PageProfileBackfillResult = { pageId: input.pageId, read: 0, applied: 0, skipped: 0 };
  const page = await app.db.execute<{ own_ref: string | null }>(sql`
    select external_page_id as own_ref from pages where id = ${input.pageId}
  `);
  // The poll writes a profile only after the answer proved the page's identity;
  // an old answer for another account (a page re-bound) is not this page's.
  const ownRef = page.rows[0]?.own_ref ?? null;
  if (ownRef === null) throw new Error(`Page ${input.pageId} has no Fansly account id`);
  let afterId = 0;
  for (;;) {
    const rows = await app.db.execute<{
      id: string;
      received_at: Date;
      payload: unknown;
      bucket: string | null;
      object_id: string | null;
    }>(sql`
      select o.id::text as id, o.received_at, o.payload,
             to_char(o.payload_bucket_month, 'YYYY-MM-DD') as bucket, o.payload_object_id::text as object_id
        from observations o
       where o.kind = 'account_me' and o.account_id = ${input.pageId} and o.id > ${afterId}
       order by o.id
       limit ${BATCH}
    `);
    if (rows.rows.length === 0) break;
    for (const row of rows.rows) {
      const id = Number(row.id);
      afterId = id;
      result.read += 1;
      let payload: unknown;
      try {
        payload = (await resolveCapturePayloadRow(app, "observation", id, {
          payload: row.payload,
          payloadRef: capturePayloadRefFromColumns(row.bucket, row.object_id),
        })).payload;
      } catch (error) {
        if (!isCapturePayloadUnavailable(error)) throw error;
        result.skipped += 1;
        continue;
      }
      const accountRef = (payload as { account?: { id?: unknown } } | null)?.account?.id;
      if (accountRef !== ownRef) {
        result.skipped += 1;
        continue;
      }
      const receivedAt = row.received_at instanceof Date ? row.received_at : new Date(String(row.received_at));
      const applied = await applyPageProfile(app.db, { pageId: input.pageId, response: payload, observation: { id, receivedAt } });
      if (applied) result.applied += 1;
      else result.skipped += 1;
    }
    input.onBatch?.(result);
  }
  return result;
}
