import { sql } from "drizzle-orm";

import type { Database } from "@agency_hub_core/db";

import { loadObservationPayload } from "../payload-reader.ts";

// Where a media look finds a signed location (owner 2026-11-11, first slice):
// the newest read of the page's Fansly schedule (`GET /post/scheduled`, kind
// `posts_scheduled`). That kind is journaled verbatim — its signing tokens are
// not stripped (sync/fansly/lib/cdn-tokens.ts) — and the page's engine reads it
// hourly, so a post in the platform's schedule (by Hub or by hand) has its
// files' signed locations there with no new platform request. A post that went
// out, and a vault file, need a fresh read: the next slice adds it as a second
// source beside this one.

/** The schedule read a look trusts at most this old (the signed locations last about a week). */
const SCHEDULE_READ_MAX_AGE_DAYS = 7;
/** Fansly's attachment content types: one account media, a bundle (an album). */
const CONTENT_ACCOUNT_MEDIA = 1;
const CONTENT_BUNDLE = 2;
/** Fansly's schedule entry status of a post still waiting to go out. */
const SCHEDULED_WAITING = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((row): row is Record<string, unknown> => row !== null) : [];
}

function idOf(value: unknown): string | null {
  if (typeof value === "string" && /^[0-9]{1,24}$/.test(value)) return value;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

function posOf(row: Record<string, unknown>, fallback: number): number {
  return typeof row.pos === "number" && Number.isFinite(row.pos) ? row.pos : fallback;
}

/** Rows in their `pos` order (the served order where it is missing). */
function byPos(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row, index) => ({ row, index })).sort((a, b) => posOf(a.row, a.index) - posOf(b.row, b.index) || a.index - b.index)
    .map(({ row }) => row);
}

export type ScheduledMediaResolution =
  | {
    ok: true;
    /** The account media (its id, its owner) and its media object (`{mimetype, variants, …}`). */
    accountMediaRef: string;
    mediaRef: string;
    /** The account the file belongs to, as the read names it (null: not named). */
    ownerAccountRef: string | null;
    media: Record<string, unknown>;
  }
  /** `not_in_schedule`: no waiting entry of the post; `attachment_not_found`: the
   *  post has no file at `index`; `media_not_in_read`: the read does not carry
   *  that file (or an album before it). */
  | { ok: false; reason: "not_in_schedule" | "attachment_not_found" | "media_not_in_read" };

/**
 * The file at `index` of a post waiting in a schedule read (`GET
 * /post/scheduled`'s answer): the post template's attachments in their order,
 * an album (bundle) replaced by its files in its order; other attachments (a
 * poll, a goal) are not files. Pure.
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
  const accountMedia = new Map<string, Record<string, unknown>>();
  for (const row of records(aggregation.accountMedia)) {
    const id = idOf(row.id);
    if (id !== null) accountMedia.set(id, row);
  }
  const bundles = new Map<string, string[]>();
  for (const row of records(aggregation.accountMediaBundles)) {
    const id = idOf(row.id);
    if (id === null) continue;
    const members = Array.isArray(row.accountMediaIds)
      ? row.accountMediaIds.map(idOf)
      : byPos(records(row.bundleContent)).map((member) => idOf(member.accountMediaId));
    if (members.every((member) => member !== null)) bundles.set(id, members as string[]);
  }

  // The post's files in order; an album the read does not carry ends what can be counted.
  const files: string[] = [];
  let unknownFrom: number | null = null;
  for (const attachment of byPos(records(template.attachments))) {
    const contentId = idOf(attachment.contentId);
    const type = attachment.contentType;
    if (type === CONTENT_ACCOUNT_MEDIA && contentId !== null) {
      files.push(contentId);
    } else if (type === CONTENT_BUNDLE && contentId !== null) {
      const members = bundles.get(contentId);
      if (members === undefined) {
        unknownFrom = files.length;
        break;
      }
      files.push(...members);
    }
  }
  if (unknownFrom !== null && index >= unknownFrom) return { ok: false, reason: "media_not_in_read" };
  const accountMediaRef = files[index];
  if (accountMediaRef === undefined) return { ok: false, reason: "attachment_not_found" };
  const row = accountMedia.get(accountMediaRef);
  const media = asRecord(row?.media);
  const mediaRef = idOf(media?.id) ?? idOf(row?.mediaId);
  if (row === undefined || media === null || mediaRef === null) return { ok: false, reason: "media_not_in_read" };
  return {
    ok: true,
    accountMediaRef,
    mediaRef,
    ownerAccountRef: idOf(row.accountId) ?? idOf(media.accountId),
    media,
  };
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
