import { sql } from "drizzle-orm";

import type { Database } from "@agency_hub_core/db";

import { loadObservationPayload } from "../payload-reader.ts";
import { asRecord, idOf, postFileOf, records, type PostFileResolution } from "./answer-files.ts";

// Where a media look finds a signed location without a request of its own
// (owner 2026-11-11): the newest read of the page's Fansly schedule (`GET
// /post/scheduled`, kind `posts_scheduled`). That kind is journaled verbatim —
// its signing tokens are not stripped (sync/fansly/lib/cdn-tokens.ts) — and the
// page's engine reads it hourly, so a post in the platform's schedule (by Hub
// or by hand) has its files' signed locations there. A post that went out, and
// a vault file, are read afresh by the page's engine (`media-look.resolve`).

/** The schedule read a look trusts at most this old (the signed locations last about a week). */
const SCHEDULE_READ_MAX_AGE_DAYS = 7;
/** Fansly's schedule entry status of a post still waiting to go out. */
const SCHEDULED_WAITING = 1;

export type ScheduledMediaResolution =
  | PostFileResolution
  /** No waiting entry of the post in the read. */
  | { ok: false; reason: "not_in_schedule" };

/**
 * The file at `index` of a post waiting in a schedule read (`GET
 * /post/scheduled`'s answer): its template's attachments with the read's
 * `aggregationData` (answer-files.ts). Pure.
 */
export function findScheduledPostMedia(body: unknown, postRef: string, index: number): ScheduledMediaResolution {
  const response = asRecord(body) ?? {};
  const entry = records(response.scheduledPosts)
    .find((candidate) => idOf(candidate.postId) === postRef && candidate.status === SCHEDULED_WAITING);
  if (entry === undefined) return { ok: false, reason: "not_in_schedule" };
  let template: Record<string, unknown>;
  if (typeof entry.postTemplate === "string") {
    try {
      template = asRecord(JSON.parse(entry.postTemplate)) ?? {};
    } catch {
      template = {};
    }
  } else {
    template = asRecord(entry.postTemplate) ?? {};
  }
  const aggregation = asRecord(response.aggregationData) ?? {};
  return postFileOf({ attachments: template.attachments, accountMedia: aggregation.accountMedia, bundles: aggregation.accountMediaBundles }, index);
}

/** The newest read of the page's Fansly schedule Hub journaled (any reader of
 *  `GET /post/scheduled`: the hourly poll, a publication's check), or null. */
export async function newestScheduleObservationId(db: Database, pageId: number): Promise<number | null> {
  const result = await db.execute<{ id: string }>(sql`
    select o.id::text as id
      from observations o
     where o.kind = 'posts_scheduled'
       and o.platform = 'fansly'
       and o.account_id = ${pageId}
       and o.received_at > clock_timestamp() - ${SCHEDULE_READ_MAX_AGE_DAYS}::integer * interval '1 day'
     order by o.received_at desc, o.id desc
     limit 1
  `);
  const row = result.rows[0];
  return row === undefined ? null : Number(row.id);
}

/** The body of a schedule read, through the payload seam (the catalog or the inline copy). */
export async function loadScheduleRead(
  app: Parameters<typeof loadObservationPayload>[0],
  observationId: number,
): Promise<unknown> {
  const read = await loadObservationPayload(app, observationId);
  return read?.payload ?? null;
}
