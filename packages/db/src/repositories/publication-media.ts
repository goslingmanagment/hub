import { sql } from "drizzle-orm";

import { PUBLICATION_ACTIVE_STATUSES } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";

// The media a page can publish, for the agents who draft (wall posts, plan PR
// 10, spec §7): each file with when it last went out on the page and the live
// publication that uses it closest to the planned time — the same facts the
// repeat check reads (readPublicationMediaHistory), for a whole page of files
// in one statement.

export type PublicationPageMediaType = "image" | "video" | "audio";

export interface PublicationPageMediaRecord {
  mediaRef: string;
  type: PublicationPageMediaType | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  byteSize: number | null;
  filename: string | null;
  /** When the platform says the file was made; Fansly only. */
  createdAt: Date | null;
  /** The newest post of the page carrying the file. */
  lastPostedAt: Date | null;
  lastPostRef: string | null;
  /** The live publication of the page with this file closest in time to `at`. */
  nearestPublicationId: number | null;
  nearestPublicationAt: Date | null;
  nearestPublicationStatus: string | null;
}

type Row = Record<string, unknown>;

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`publication media: expected a safe integer, got ${String(value)}`);
  }
  return parsed;
}

function nullableDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(String(value));
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * The files a page can publish, one row per file:
 * - Fansly: the media Hub collected for the page (`creator_raw_media`), the
 *   set the draft check accepts;
 * - OnlyFans: the vault of the page's current OnlyFansAPI account
 *   (`ofapi_media_catalog`), ready, without an error and viewable — the only
 *   files OnlyFansAPI will post. It knows no mime type, no byte size and no
 *   creation time.
 */
function pageFiles(pageId: number, platform: string) {
  if (platform === "onlyfans") {
    return sql`
      select c.media_ref, nullif(c.mime_type, '') as mime_type,
             c.width, c.height,
             case when c.duration > 0 then round(c.duration * 1000)::bigint end as duration_ms,
             nullif(c.byte_size, 0) as byte_size, c.filename,
             null::timestamptz as created_at,
             case c.provider_type when 'photo' then 'image' when 'video' then 'video' when 'audio' then 'audio' end
               as media_type
        from pages pg
        join ofapi_media_catalog c on c.page_id = pg.id and c.account_id = pg.ofapi_account_id
       where pg.id = ${pageId} and c.material_kind = 'vault'
         and c.is_ready is true and c.has_error is not true and c.can_view is not false
    `;
  }
  return sql`
    select m.media_ref, m.mime_type,
           coalesce(m.original_width, m.width) as width, coalesce(m.original_height, m.height) as height,
           nullif(m.duration_ms, 0) as duration_ms, null::bigint as byte_size, m.filename,
           m.created_at_platform as created_at,
           case
             when m.mime_type like 'image/%' then 'image'
             when m.mime_type like 'video/%' then 'video'
             when m.mime_type like 'audio/%' then 'audio'
             when m.media_type = 1 then 'image'
             when m.media_type = 2 then 'video'
           end as media_type
      from creator_raw_media m
     where m.page_id = ${pageId}
  `;
}

/**
 * What a post's attachment names for each file. OnlyFans: the vault media id
 * itself. Fansly: an offer (accountMedia) that wraps the file, or a bundle of
 * such offers (the same walk as readPublicationMediaHistory and the
 * `post_attachments` dataset's main role).
 */
function attachmentIds(pageId: number, platform: string) {
  if (platform === "onlyfans") {
    return sql`select s.media_ref, s.media_ref as content_id from slice s`;
  }
  return sql`
    select o.media_ref, o.media_offer_ref as content_id
      from creator_media o
     where o.page_id = ${pageId} and o.media_ref in (select media_ref from slice)
    union all
    select o.media_ref, b.bundle_ref
      from creator_media o
      join (select b.bundle_ref, member.ref
              from creator_media_bundles b
              cross join unnest(b.member_refs) as member(ref)
             where b.page_id = ${pageId}) b on b.ref = o.media_offer_ref
     where o.page_id = ${pageId} and o.media_ref in (select media_ref from slice)
  `;
}

/**
 * One page of a page's publishable media, newest first, with each file's last
 * post on the page and its nearest live publication (spec §7, §8.1 "Повтор").
 *
 * Newest first is by the platform's media id, longest then greatest: Fansly
 * ids are snowflakes and OnlyFans ids grow with each upload, so the order is
 * upload order on both (checked on prod 2026-10-23 against Fansly's own
 * creation time), and it needs no time OnlyFans does not give.
 *
 * Set-based: the page's slice is cut first (at most `limit` files), then one
 * probe of the GIN index on `creator_posts.attachment_refs` per attachment id
 * of that slice. The `offset 0` keeps the probe a parameterised index scan:
 * flattened, the planner preferred walking every post of the page against
 * every id (lora-2: 105 ms for 200 files; lora-of, 23k posts, would be
 * seconds). With it, 200 files cost ~30 ms on lora-2 and ~4 ms on lora-of.
 */
export async function listPublicationPageMedia(db: Database, input: {
  pageId: number;
  platform: string;
  /** The planned publish time: the nearest live publication is measured from it. */
  at: Date;
  type: PublicationPageMediaType | null;
  /** Keyset: the last media ref of the previous page (exclusive). */
  afterMediaRef: string | null;
  limit: number;
}): Promise<PublicationPageMediaRecord[]> {
  const typeFilter = input.type === null ? sql`true` : sql`f.media_type = ${input.type}`;
  const after = input.afterMediaRef === null
    ? sql`true`
    : sql`(length(f.media_ref), f.media_ref collate "C") < (length(${input.afterMediaRef}::text), ${input.afterMediaRef}::text collate "C")`;
  const result = await db.execute<Row>(sql`
    with files as (${pageFiles(input.pageId, input.platform)}),
    slice as (
      select f.* from files f
       where ${typeFilter} and ${after}
       order by length(f.media_ref) desc, f.media_ref collate "C" desc
       limit ${input.limit}
    ),
    attachment_ids as (${attachmentIds(input.pageId, input.platform)}),
    last_post as (
      select distinct on (a.media_ref) a.media_ref, hit.published_at, hit.platform_post_id
        from attachment_ids a
        cross join lateral (
          select cp.published_at, cp.platform_post_id
            from creator_posts cp
           where cp.account_id = ${input.pageId}
             and cp.attachment_refs @> jsonb_build_array(jsonb_build_object('contentId', a.content_id))
          offset 0
        ) hit
       order by a.media_ref, hit.published_at desc, hit.platform_post_id desc
    ),
    nearest as (
      select distinct on (pm.platform_media_ref) pm.platform_media_ref as media_ref,
             p.id, p.publish_at, p.status
        from publication_media pm
        join publications p on p.id = pm.publication_id
       where pm.role = 'media' and pm.platform_media_ref in (select media_ref from slice)
         and p.page_id = ${input.pageId}
         and p.status = any(${sql.param([...PUBLICATION_ACTIVE_STATUSES])}::text[])
       order by pm.platform_media_ref, abs(extract(epoch from p.publish_at - ${input.at}::timestamptz)), p.id
    )
    select s.media_ref, s.media_type, s.mime_type, s.width, s.height, s.duration_ms, s.byte_size, s.filename,
           s.created_at, l.published_at as last_posted_at, l.platform_post_id as last_post_ref,
           n.id as nearest_publication_id, n.publish_at as nearest_publication_at,
           n.status as nearest_publication_status
      from slice s
      left join last_post l on l.media_ref = s.media_ref
      left join nearest n on n.media_ref = s.media_ref
     order by length(s.media_ref) desc, s.media_ref collate "C" desc
  `);
  return result.rows.map((row) => ({
    mediaRef: String(row.media_ref),
    type: (row.media_type as PublicationPageMediaType | null) ?? null,
    mimeType: nullableString(row.mime_type),
    width: nullableNumber(row.width),
    height: nullableNumber(row.height),
    durationMs: nullableNumber(row.duration_ms),
    byteSize: nullableNumber(row.byte_size),
    filename: nullableString(row.filename),
    createdAt: nullableDate(row.created_at),
    lastPostedAt: nullableDate(row.last_posted_at),
    lastPostRef: nullableString(row.last_post_ref),
    nearestPublicationId: nullableNumber(row.nearest_publication_id),
    nearestPublicationAt: nullableDate(row.nearest_publication_at),
    nearestPublicationStatus: nullableString(row.nearest_publication_status),
  }));
}
