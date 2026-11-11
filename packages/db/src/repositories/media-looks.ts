import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Media looks (0371, 0372, owner 2026-11-11): an agent key's look at a file of
// its page — one image request of the page's engine (`media-look.fetch`), cut
// into frames (≤ 512 px) by the API process. A published post or a vault file
// is read first (`media-look.resolve`, 0372): the look is `resolving` until
// that read's apply names the file and queues the image request. The engine's apply leaves the fetched
// bytes on the look (`storeMediaLookSource`, transient); whoever settles the
// look next cuts them, stores the frames and drops the bytes in one
// transaction (`completeMediaLook`). Nothing here holds a URL.
//
// Retention (the nightly job, `sweepMediaLooks`): fetched bytes 15 minutes,
// frames 7 days, look rows 90 days. Our own derived pictures of the page's
// media, never a captured fact: the facts stay the schedule reads they came
// from.

/** Fetched bytes are dropped this long after they came, cut or not. */
export const MEDIA_LOOK_SOURCE_TTL_MS = 15 * 60 * 1000;
/** A look's frames are deleted this long after it was ready. */
export const MEDIA_LOOK_FRAMES_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The fetch cap (`MEDIA_DOWNLOAD_MAX_BYTES`), also the table's CHECK. */
export const MEDIA_LOOK_SOURCE_MAX_BYTES = 5 * 1024 * 1024;
/** Rows a sweep statement touches at most. */
const SWEEP_BATCH = 500;

export type MediaLookRowStatus = "resolving" | "queued" | "fetched" | "ready" | "failed" | "expired";
export type MediaLookSourceKind = "schedule_read" | "post_read" | "vault_read";
/** A look the engine may still answer: one per page at a time. */
const IN_FLIGHT = sql`('resolving', 'queued', 'fetched')`;
export type MediaLookVariant = "sprite" | "cover" | "image";
export type MediaLookRowCoverage = "per_second" | "sampled" | "cover_only" | "whole_image" | "first_frame";

export interface MediaLookRecord {
  id: number;
  pageId: number;
  agentKeyId: number | null;
  publicationId: number | null;
  /** Null for a vault file. */
  postRef: string | null;
  attachmentIndex: number | null;
  /** Null until the engine's read named the file (a published post's). */
  mediaRef: string | null;
  mediaType: "video" | "image" | null;
  variant: MediaLookVariant | null;
  status: MediaLookRowStatus;
  failure: string | null;
  sourceKind: MediaLookSourceKind;
  /** A vault file's album. */
  vaultAlbumRef: string | null;
  sourceObservationId: number | null;
  coverage: MediaLookRowCoverage | null;
  durationMs: number | null;
  frameIntervalMs: number | null;
  frameCount: number | null;
  gridCols: number | null;
  gridRows: number | null;
  cellWidth: number | null;
  cellHeight: number | null;
  requestsSent: number;
  hasSource: boolean;
  sourceExpiresAt: Date | null;
  framesExpireAt: Date | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface MediaLookFrameRecord {
  frameIndex: number;
  atMs: number | null;
  width: number;
  height: number;
  /** Only when asked for. */
  jpeg: Buffer | null;
}

type Row = Record<string, unknown>;

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function bytesOf(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value).replace(/^\\x/, ""), "hex");
}

const LOOK_COLUMNS = sql`
  l.id, l.page_id, l.agent_key_id, l.publication_id, l.post_ref, l.attachment_index, l.media_ref, l.media_type,
  l.variant, l.status, l.failure, l.source_kind, l.vault_album_ref, l.source_observation_id, l.coverage, l.duration_ms,
  l.frame_interval_ms, l.frame_count, l.grid_cols, l.grid_rows, l.cell_width, l.cell_height, l.requests_sent,
  (l.source_bytes is not null) as has_source, l.source_expires_at, l.frames_expire_at, l.created_at, l.completed_at`;

function lookOf(row: Row): MediaLookRecord {
  return {
    id: Number(row.id),
    pageId: Number(row.page_id),
    agentKeyId: nullableNumber(row.agent_key_id),
    publicationId: nullableNumber(row.publication_id),
    postRef: (row.post_ref as string | null) ?? null,
    attachmentIndex: nullableNumber(row.attachment_index),
    mediaRef: (row.media_ref as string | null) ?? null,
    mediaType: (row.media_type as MediaLookRecord["mediaType"]) ?? null,
    variant: (row.variant as MediaLookVariant | null) ?? null,
    status: row.status as MediaLookRowStatus,
    failure: (row.failure as string | null) ?? null,
    sourceKind: row.source_kind as MediaLookSourceKind,
    vaultAlbumRef: (row.vault_album_ref as string | null) ?? null,
    sourceObservationId: nullableNumber(row.source_observation_id),
    coverage: (row.coverage as MediaLookRowCoverage | null) ?? null,
    durationMs: nullableNumber(row.duration_ms),
    frameIntervalMs: nullableNumber(row.frame_interval_ms),
    frameCount: nullableNumber(row.frame_count),
    gridCols: nullableNumber(row.grid_cols),
    gridRows: nullableNumber(row.grid_rows),
    cellWidth: nullableNumber(row.cell_width),
    cellHeight: nullableNumber(row.cell_height),
    requestsSent: Number(row.requests_sent ?? 0),
    hasSource: row.has_source === true,
    sourceExpiresAt: nullableDate(row.source_expires_at),
    framesExpireAt: nullableDate(row.frames_expire_at),
    createdAt: date(row.created_at),
    completedAt: nullableDate(row.completed_at),
  };
}

/** What a new look is about: chosen before anything is written — all of it
 *  for a look from the schedule's read (`queued`), its target alone for one
 *  the engine reads first (`resolving`). */
export interface NewMediaLook {
  pageId: number;
  agentKeyId: number | null;
  status: "queued" | "resolving";
  sourceKind: MediaLookSourceKind;
  publicationId: number | null;
  postRef: string | null;
  attachmentIndex: number | null;
  vaultAlbumRef: string | null;
  mediaRef: string | null;
  mediaType: "video" | "image" | null;
  variant: MediaLookVariant | null;
  sourceObservationId: number | null;
  coverage: MediaLookRowCoverage | null;
  durationMs: number | null;
  frameIntervalMs: number | null;
  frameCount: number | null;
  gridCols: number | null;
  gridRows: number | null;
  cellWidth: number | null;
  cellHeight: number | null;
}

/** The page's looks that count against its daily cap today (UTC): the ones
 *  that sent a request, and the one still in flight (it may yet send). */
function countedTodaySql(pageId: number) {
  return sql`
    select count(*)::int as n from media_looks
     where page_id = ${pageId}
       and created_at >= date_trunc('day', clock_timestamp() at time zone 'UTC') at time zone 'UTC'
       and (requests_sent > 0 or status in ${IN_FLIGHT})`;
}

export async function countMediaLooksToday(db: Database, pageId: number): Promise<number> {
  const result = await db.execute<{ n: number }>(countedTodaySql(pageId));
  return Number(result.rows[0]?.n ?? 0);
}

export type MediaLookCreateResult =
  | { kind: "created"; look: MediaLookRecord; usedToday: number }
  /** Another look of the page is in flight: one at a time per page. */
  | { kind: "in_flight"; lookId: number }
  /** The page's looks that sent a request today reached the limit. */
  | { kind: "daily_limit"; usedToday: number };

/**
 * A new look, under the page's caps, atomically: one transaction under a
 * per-page advisory lock checks that no look of the page is in flight and that
 * today's looks are under `dailyLimit`, then writes the look `queued` — before
 * any work is queued. The partial unique index is the in-flight check's
 * backstop.
 */
export async function createMediaLookGuarded(
  db: Database,
  input: NewMediaLook & { dailyLimit: number },
): Promise<MediaLookCreateResult> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`media_look:${input.pageId}`}, 0))`);
    const flying = await tx.execute<{ id: string }>(sql`
      select id::text as id from media_looks where page_id = ${input.pageId} and status in ${IN_FLIGHT} limit 1
    `);
    if (flying.rows[0] !== undefined) return { kind: "in_flight", lookId: Number(flying.rows[0].id) };
    const used = Number((await tx.execute<{ n: number }>(countedTodaySql(input.pageId))).rows[0]?.n ?? 0);
    if (used >= input.dailyLimit) return { kind: "daily_limit", usedToday: used };
    const inserted = await tx.execute<Row>(sql`
      insert into media_looks as l (
        page_id, agent_key_id, publication_id, post_ref, attachment_index, vault_album_ref, media_ref, media_type, variant,
        status, source_kind, source_observation_id, coverage, duration_ms, frame_interval_ms, frame_count,
        grid_cols, grid_rows, cell_width, cell_height
      ) values (
        ${input.pageId}, ${input.agentKeyId}, ${input.publicationId}, ${input.postRef}, ${input.attachmentIndex},
        ${input.vaultAlbumRef}, ${input.mediaRef}, ${input.mediaType}, ${input.variant}, ${input.status}, ${input.sourceKind},
        ${input.sourceObservationId}, ${input.coverage}, ${input.durationMs}, ${input.frameIntervalMs}, ${input.frameCount},
        ${input.gridCols}, ${input.gridRows}, ${input.cellWidth}, ${input.cellHeight}
      )
      returning ${LOOK_COLUMNS}
    `);
    return { kind: "created", look: lookOf(inserted.rows[0]!), usedToday: used + 1 };
  });
}

/** One look of the page, or null (none, or another page's). */
export async function getMediaLook(db: Database, input: { pageId: number; lookId: number }): Promise<MediaLookRecord | null> {
  const result = await db.execute<Row>(sql`
    select ${LOOK_COLUMNS} from media_looks l where l.id = ${input.lookId} and l.page_id = ${input.pageId}
  `);
  const row = result.rows[0];
  return row === undefined ? null : lookOf(row);
}

/** The page's looks still in flight (resolving, queued, or fetched and not cut yet). */
export async function listUnsettledMediaLooks(db: Database, pageId: number): Promise<MediaLookRecord[]> {
  const result = await db.execute<Row>(sql`
    select ${LOOK_COLUMNS} from media_looks l where l.page_id = ${pageId} and l.status in ${IN_FLIGHT} order by l.id
  `);
  return result.rows.map(lookOf);
}

/** The newest ready look of the same file and variant whose frames are still kept: a cached answer. */
export async function findFreshMediaLook(
  db: Database,
  input: { pageId: number; mediaRef: string; variant: MediaLookVariant },
): Promise<MediaLookRecord | null> {
  const result = await db.execute<Row>(sql`
    select ${LOOK_COLUMNS} from media_looks l
     where l.page_id = ${input.pageId} and l.media_ref = ${input.mediaRef} and l.variant = ${input.variant}
       and l.status = 'ready' and l.frames_expire_at > clock_timestamp()
     order by l.id desc
     limit 1
  `);
  const row = result.rows[0];
  return row === undefined ? null : lookOf(row);
}

/** Whether a look of this file found its thumbnail sheet uncuttable (its
 *  size did not match its grid): the next look of it takes the cover. */
export async function mediaLookSpriteFailed(db: Database, input: { pageId: number; mediaRef: string }): Promise<boolean> {
  const result = await db.execute<{ found: boolean }>(sql`
    select exists(
      select 1 from media_looks
       where page_id = ${input.pageId} and media_ref = ${input.mediaRef} and variant = 'sprite'
         and failure = 'sprite_geometry_mismatch'
    ) as found
  `);
  return result.rows[0]?.found === true;
}

export async function listMediaLookFrames(
  db: Database,
  input: { lookId: number; withJpeg: boolean },
): Promise<MediaLookFrameRecord[]> {
  const jpeg = input.withJpeg ? sql`jpeg` : sql`null::bytea as jpeg`;
  const result = await db.execute<Row>(sql`
    select frame_index, at_ms, width, height, ${jpeg} from media_look_frames where look_id = ${input.lookId} order by frame_index
  `);
  return result.rows.map((row) => ({
    frameIndex: Number(row.frame_index),
    atMs: nullableNumber(row.at_ms),
    width: Number(row.width),
    height: Number(row.height),
    jpeg: row.jpeg === null || row.jpeg === undefined ? null : bytesOf(row.jpeg),
  }));
}

/**
 * The engine's apply (`media-look.fetch`, in its transaction): the fetched
 * bytes onto a look still `queued` on this page, `fetched`, for 15 minutes.
 * False when the look is gone or no longer waits (erased, settled): nothing is
 * stored for nobody. The page's bytes left uncut past their time go first.
 */
export async function storeMediaLookSource(
  db: Database,
  input: { pageId: number; lookId: number; contentType: string | null; bytes: Buffer },
): Promise<boolean> {
  if (input.bytes.length > MEDIA_LOOK_SOURCE_MAX_BYTES) {
    throw new RangeError(`A media look holds at most ${MEDIA_LOOK_SOURCE_MAX_BYTES} bytes (got ${input.bytes.length})`);
  }
  await dropExpiredMediaLookSources(db, { pageId: input.pageId });
  const result = await db.execute<{ id: string }>(sql`
    update media_looks
       set status = 'fetched', source_content_type = ${input.contentType}, source_bytes = ${input.bytes}::bytea,
           source_expires_at = clock_timestamp() + ${MEDIA_LOOK_SOURCE_TTL_MS}::double precision * interval '1 millisecond',
           updated_at = clock_timestamp()
     where id = ${input.lookId} and page_id = ${input.pageId} and status = 'queued'
    returning id::text as id
  `);
  return result.rows.length > 0;
}

/** The fetched bytes of a look, while they are kept. */
export async function readMediaLookSource(
  db: Database,
  input: { lookId: number },
): Promise<{ bytes: Buffer; contentType: string | null } | null> {
  const result = await db.execute<Row>(sql`
    select source_bytes, source_content_type from media_looks
     where id = ${input.lookId} and status = 'fetched' and source_bytes is not null and source_expires_at > clock_timestamp()
  `);
  const row = result.rows[0];
  return row === undefined ? null : { bytes: bytesOf(row.source_bytes), contentType: (row.source_content_type as string | null) ?? null };
}

/** A `media-look.fetch` work of a look, as its settle reads it. */
export interface MediaLookWorkFacts {
  workId: number;
  closed: boolean;
  result: unknown;
  closeReason: string | null;
  /** Its attempts that may have left (every outcome but a send refused before it left). */
  requestsSent: number;
}

/** The newest work of `resource` for `subject` on the page, with the requests it sent. */
export async function mediaLookWorkFacts(
  db: Database,
  input: { pageId: number; resource: string; subject: string },
): Promise<MediaLookWorkFacts | null> {
  const result = await db.execute<Row>(sql`
    select w.id::text as id, (w.closed_at is not null) as closed, w.result, w.close_reason,
           (select count(*)::int from sync_attempts a
             where a.page_id = w.page_id and a.work_id = w.id and not a.shadow
               and a.outcome not in ('aborted_before_send', 'shadow')) as sent
      from sync_work w
     where w.page_id = ${input.pageId} and w.resource = ${input.resource} and w.subject = ${input.subject} and not w.shadow
     order by w.id desc
     limit 1
  `);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    workId: Number(row.id),
    closed: row.closed === true,
    result: row.result ?? null,
    closeReason: (row.close_reason as string | null) ?? null,
    requestsSent: Number(row.sent ?? 0),
  };
}

export interface MediaLookCut {
  coverage: MediaLookRowCoverage;
  gridCols: number | null;
  gridRows: number | null;
  frames: Array<{ index: number; atMs: number | null; width: number; height: number; jpeg: Buffer }>;
}

/**
 * A fetched look, cut: its frames written, its bytes dropped, `ready` for 7
 * days — one transaction, and only from `fetched` (a look another caller
 * finished meanwhile is left as it is: false).
 */
export async function completeMediaLook(
  db: Database,
  input: { pageId: number; lookId: number; requestsSent: number; cut: MediaLookCut },
): Promise<boolean> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const updated = await tx.execute<{ id: string }>(sql`
      update media_looks
         set status = 'ready', failure = null, coverage = ${input.cut.coverage}, frame_count = ${input.cut.frames.length},
             grid_cols = coalesce(${input.cut.gridCols}::smallint, grid_cols), grid_rows = coalesce(${input.cut.gridRows}::smallint, grid_rows),
             requests_sent = ${input.requestsSent}, source_bytes = null, source_content_type = null, source_expires_at = null,
             frames_expire_at = clock_timestamp() + ${MEDIA_LOOK_FRAMES_TTL_MS}::double precision * interval '1 millisecond',
             completed_at = clock_timestamp(), updated_at = clock_timestamp()
       where id = ${input.lookId} and page_id = ${input.pageId} and status = 'fetched'
      returning id::text as id
    `);
    if (updated.rows.length === 0) return false;
    for (const frame of input.cut.frames) {
      await tx.execute(sql`
        insert into media_look_frames (look_id, page_id, frame_index, at_ms, width, height, jpeg)
        values (${input.lookId}, ${input.pageId}, ${frame.index}, ${frame.atMs}, ${frame.width}, ${frame.height}, ${frame.jpeg}::bytea)
      `);
    }
    return true;
  });
}

/** A look that ends without frames: `failure` a closed code, its bytes dropped.
 *  Only from a status still in flight; false when it had settled already. */
export async function failMediaLook(
  db: Database,
  input: { pageId: number; lookId: number; failure: string; requestsSent: number },
): Promise<boolean> {
  const result = await db.execute<{ id: string }>(sql`
    update media_looks
       set status = 'failed', failure = ${input.failure}, requests_sent = ${input.requestsSent},
           source_bytes = null, source_content_type = null, source_expires_at = null,
           completed_at = clock_timestamp(), updated_at = clock_timestamp()
     where id = ${input.lookId} and page_id = ${input.pageId} and status in ${IN_FLIGHT}
    returning id::text as id
  `);
  return result.rows.length > 0;
}

/** What the engine's read of a post or a vault page made of a look: its file,
 *  what is fetched of it and how it is cut. */
export interface MediaLookResolved {
  mediaRef: string;
  mediaType: "video" | "image";
  variant: MediaLookVariant;
  coverage: MediaLookRowCoverage;
  durationMs: number | null;
  frameIntervalMs: number | null;
  frameCount: number | null;
  gridCols: number | null;
  gridRows: number | null;
  cellWidth: number | null;
  cellHeight: number | null;
}

/**
 * The read's apply (`media-look.resolve`, in its transaction): a look still
 * `resolving` names its file and goes `queued` for its image request. False
 * when the look is gone or no longer resolving: nothing is queued for it.
 */
export async function markMediaLookResolved(
  db: Database,
  input: { pageId: number; lookId: number; resolved: MediaLookResolved },
): Promise<boolean> {
  const r = input.resolved;
  const result = await db.execute<{ id: string }>(sql`
    update media_looks
       set status = 'queued', media_ref = ${r.mediaRef}, media_type = ${r.mediaType}, variant = ${r.variant},
           coverage = ${r.coverage}, duration_ms = ${r.durationMs}, frame_interval_ms = ${r.frameIntervalMs},
           frame_count = ${r.frameCount}, grid_cols = ${r.gridCols}, grid_rows = ${r.gridRows},
           cell_width = ${r.cellWidth}, cell_height = ${r.cellHeight}, updated_at = clock_timestamp()
     where id = ${input.lookId} and page_id = ${input.pageId} and status = 'resolving'
    returning id::text as id
  `);
  return result.rows.length > 0;
}

/** A published post Hub has among this page's own posts: the files its
 *  attachments name, in order (an album's files in its order), as the media
 *  plane knows them — null for a file the plane has not linked. Null: Hub has
 *  not seen the post on this page. */
export async function pagePostFileRefs(
  db: Database,
  input: { pageId: number; postRef: string },
): Promise<Array<string | null> | null> {
  const post = await db.execute<{ attachment_refs: unknown }>(sql`
    select attachment_refs from creator_posts where account_id = ${input.pageId} and platform_post_id = ${input.postRef}
  `);
  if (post.rows.length === 0) return null;
  const attachments = Array.isArray(post.rows[0]!.attachment_refs) ? post.rows[0]!.attachment_refs as unknown[] : [];
  const ordered = attachments
    .map((raw, order) => ({ raw: (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>, order }))
    .sort((a, b) => (Number(a.raw.pos ?? a.order) - Number(b.raw.pos ?? b.order)) || a.order - b.order);
  const offers: Array<string | null> = [];
  for (const { raw } of ordered) {
    const contentId = typeof raw.contentId === "string" ? raw.contentId : typeof raw.contentId === "number" ? String(raw.contentId) : null;
    if (contentId === null) continue;
    if (raw.contentType === 1) {
      offers.push(contentId);
    } else if (raw.contentType === 2) {
      const bundle = await db.execute<{ member_refs: string[] | null }>(sql`
        select member_refs from creator_media_bundles where page_id = ${input.pageId} and bundle_ref = ${contentId} limit 1
      `);
      const members = bundle.rows[0]?.member_refs;
      // An album the plane does not hold: what follows cannot be counted.
      if (!Array.isArray(members)) {
        offers.push(null);
        break;
      }
      offers.push(...members);
    }
  }
  const files: Array<string | null> = [];
  for (const offer of offers) {
    if (offer === null) {
      files.push(null);
      continue;
    }
    const media = await db.execute<{ media_ref: string | null }>(sql`
      select media_ref from creator_media where page_id = ${input.pageId} and media_offer_ref = ${offer} limit 1
    `);
    files.push(media.rows[0]?.media_ref ?? null);
  }
  return files;
}

/** A file of the page's own account in its media plane and its creator vault:
 *  its mime type and the vault membership a read pages through (the newest
 *  album that still holds it, by the membership's own id). Null: not the
 *  page's own file, or not in its vault. */
export async function pageVaultFile(
  db: Database,
  input: { pageId: number; mediaRef: string; ownAccountRef: string },
): Promise<{ mimeType: string | null; albumRef: string; memberRef: string } | "not_own" | "not_in_vault"> {
  const raw = await db.execute<{ owner_account_ref: string | null; mime_type: string | null }>(sql`
    select owner_account_ref, mime_type from creator_raw_media where page_id = ${input.pageId} and media_ref = ${input.mediaRef} limit 1
  `);
  const file = raw.rows[0];
  if (file === undefined || file.owner_account_ref !== input.ownAccountRef) return "not_own";
  const member = await db.execute<{ album_ref: string; member_ref: string }>(sql`
    select album_ref, member_ref from creator_vault_album_members
     where page_id = ${input.pageId} and vault_kind = 'creator' and media_ref = ${input.mediaRef}
       and member_ref is not null and missing_since is null
     order by last_observed_at desc, album_ref
     limit 1
  `);
  const row = member.rows[0];
  return row === undefined ? "not_in_vault" : { mimeType: file.mime_type, albumRef: row.album_ref, memberRef: row.member_ref };
}

/** Fetched bytes past their 15 minutes, cut or not: dropped (the look then
 *  fails when settled). Of one page (each new fetch of it), or of every page. */
export async function dropExpiredMediaLookSources(db: Database, input: { pageId?: number } = {}): Promise<number> {
  const pageFilter = input.pageId === undefined ? sql`` : sql`and page_id = ${input.pageId}`;
  const result = await db.execute<{ n: number }>(sql`
    with dropped as (
      update media_looks set source_bytes = null, source_content_type = null, updated_at = clock_timestamp()
       where id in (
         select id from media_looks
          where source_bytes is not null and source_expires_at <= clock_timestamp() ${pageFilter}
          order by source_expires_at
          limit ${SWEEP_BATCH}
       )
      returning 1
    )
    select count(*)::int as n from dropped
  `);
  return Number(result.rows[0]?.n ?? 0);
}

export interface MediaLookSweep {
  sourcesDropped: number;
  framesDeleted: number;
  looksExpired: number;
  looksDeleted: number;
}

/**
 * The nightly retention of media looks (beside the engine's media handoff):
 * fetched bytes past their 15 minutes dropped, frames past their 7 days
 * deleted (the look `expired`), look rows past their 90 days deleted. Batched.
 */
export async function sweepMediaLooks(db: Database, input: { maxBatches?: number } = {}): Promise<MediaLookSweep> {
  const maxBatches = Math.max(1, input.maxBatches ?? 100);
  const out: MediaLookSweep = { sourcesDropped: 0, framesDeleted: 0, looksExpired: 0, looksDeleted: 0 };
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const dropped = await dropExpiredMediaLookSources(db);
    out.sourcesDropped += dropped;
    if (dropped < SWEEP_BATCH) break;
  }
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await db.execute<{ looks: number; frames: number }>(sql`
      with doomed as (
        select id from media_looks
         where status = 'ready' and frames_expire_at <= clock_timestamp()
         order by frames_expire_at
         limit ${SWEEP_BATCH}
      ), frames as (
        delete from media_look_frames f using doomed where f.look_id = doomed.id returning 1
      ), looks as (
        update media_looks l set status = 'expired', updated_at = clock_timestamp() from doomed where l.id = doomed.id returning 1
      )
      select (select count(*)::int from looks) as looks, (select count(*)::int from frames) as frames
    `);
    const looks = Number(result.rows[0]?.looks ?? 0);
    out.looksExpired += looks;
    out.framesDeleted += Number(result.rows[0]?.frames ?? 0);
    if (looks < SWEEP_BATCH) break;
  }
  for (let batch = 0; batch < maxBatches; batch += 1) {
    // Frames go with their look (the FK cascades); a look in flight is never old enough.
    const result = await db.execute<{ n: number }>(sql`
      with doomed as (
        select id from media_looks
         where expires_at <= clock_timestamp() and status not in ${IN_FLIGHT}
         order by expires_at
         limit ${SWEEP_BATCH}
      ), removed as (
        delete from media_looks l using doomed where l.id = doomed.id returning 1
      )
      select count(*)::int as n from removed
    `);
    const n = Number(result.rows[0]?.n ?? 0);
    out.looksDeleted += n;
    if (n < SWEEP_BATCH) break;
  }
  return out;
}
