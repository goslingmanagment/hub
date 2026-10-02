import { sql } from "drizzle-orm";

import type { Database } from "../../client.ts";
import { toDate, toRequiredDate } from "./values.ts";

// Fansly Sync Engine (owner decision №17, design S3-04): the transient handoff
// of chat media bytes from the `sync` process to the AI describer (0234). On a
// page the engine owns, the CDN download is a request of the page's actor
// (`media-download.fetch`); its apply stores the bytes here and names the row
// in the work's result. The describer, in the worker, reads the bytes and
// deletes the row in the same statement (`consumeSyncMediaHandoff`); a row
// nobody consumed is deleted once it expires (24 h). A transient buffer, not a
// captured fact: the captured facts are the description and the media
// metadata observation.

/** An unconsumed handoff row is deleted after this long. */
export const SYNC_MEDIA_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;
/** The download cap (`MEDIA_DOWNLOAD_MAX_BYTES`), also the table's CHECK. */
export const SYNC_MEDIA_HANDOFF_MAX_BYTES = 5 * 1024 * 1024;
/** Expired rows deleted per statement of a sweep. */
export const SYNC_MEDIA_HANDOFF_SWEEP_BATCH = 500;

export interface StoredSyncMediaHandoff {
  id: number;
  byteCount: number;
  expiresAt: Date;
}

/**
 * Store one downloaded file for the describer (the media-download apply, in
 * its fenced transaction). Null when the description row is gone (an erasure
 * removed it since the describer asked): nothing is stored for nobody.
 */
export async function storeSyncMediaHandoff(
  db: Database,
  input: { pageId: number; descriptionId: number; workId: number; contentType: string | null; bytes: Buffer },
): Promise<StoredSyncMediaHandoff | null> {
  if (input.bytes.length > SYNC_MEDIA_HANDOFF_MAX_BYTES) {
    throw new RangeError(`A media handoff holds at most ${SYNC_MEDIA_HANDOFF_MAX_BYTES} bytes (got ${input.bytes.length})`);
  }
  const result = await db.execute<{ id: string; byteCount: number; expiresAt: Date | string }>(sql`
    insert into sync_media_handoff (page_id, description_id, work_id, content_type, byte_count, bytes, expires_at)
    select ${input.pageId}::bigint, d.id, ${input.workId}::bigint, ${input.contentType}::text,
           ${input.bytes.length}::integer, ${input.bytes}::bytea,
           clock_timestamp() + ${SYNC_MEDIA_HANDOFF_TTL_MS}::double precision * interval '1 millisecond'
      from ai_media_descriptions d
     where d.id = ${input.descriptionId}
       and d.page_id = ${input.pageId}
       for key share of d
    returning id::text as id, byte_count as "byteCount", expires_at as "expiresAt"
  `);
  const row = result.rows[0];
  return row ? { id: Number(row.id), byteCount: Number(row.byteCount), expiresAt: toRequiredDate(row.expiresAt) } : null;
}

export interface ConsumedSyncMediaHandoff {
  bytes: Buffer;
  contentType: string | null;
  createdAt: Date | null;
}

/**
 * The describer's read: the bytes of one handoff row, deleted in the same
 * statement — whoever reads them consumes them, so a second reader (a retry
 * after a lost lease) finds nothing and downloads again. Null when the row is
 * gone (consumed, expired, erased) or belongs to another page or description.
 */
export async function consumeSyncMediaHandoff(
  db: Database,
  input: { pageId: number; descriptionId: number; handoffId: number },
): Promise<ConsumedSyncMediaHandoff | null> {
  const result = await db.execute<{ bytes: Buffer | string; contentType: string | null; createdAt: Date | string | null }>(sql`
    delete from sync_media_handoff
     where id = ${input.handoffId}
       and page_id = ${input.pageId}
       and description_id = ${input.descriptionId}
       and expires_at > clock_timestamp()
    returning bytes, content_type as "contentType", created_at as "createdAt"
  `);
  const row = result.rows[0];
  if (!row) return null;
  const bytes = Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(String(row.bytes).replace(/^\\x/, ""), "hex");
  return { bytes, contentType: row.contentType, createdAt: toDate(row.createdAt) };
}

/**
 * The expiry sweep: rows nobody consumed within their 24 h (the nightly
 * retention job for every page; each new download for its own page). Batched
 * by the expiry index. Returns how many rows it deleted.
 */
export async function deleteExpiredSyncMediaHandoff(
  db: Database,
  input: { pageId?: number; batchRows?: number; maxBatches?: number } = {},
): Promise<number> {
  const batchRows = Math.max(1, input.batchRows ?? SYNC_MEDIA_HANDOFF_SWEEP_BATCH);
  const maxBatches = Math.max(1, input.maxBatches ?? 100);
  const pageFilter = input.pageId === undefined ? sql`` : sql`and h.page_id = ${input.pageId}`;
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await db.execute<{ n: string }>(sql`
      with doomed as (
        select h.id from sync_media_handoff h
         where h.expires_at <= clock_timestamp() ${pageFilter}
         order by h.expires_at
         limit ${batchRows}
      ), removed as (
        delete from sync_media_handoff h using doomed where h.id = doomed.id returning 1
      )
      select count(*)::text as n from removed
    `);
    const n = Number(result.rows[0]?.n ?? 0);
    deleted += n;
    if (n < batchRows) break;
  }
  return deleted;
}
