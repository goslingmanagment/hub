// The chat extension's archive feed for one conversation (H-9b): a keyset page
// reader over the database alone. No OFAPI, no read gateway, no capture or
// history work — the route that serves it (H-9c) only reads.
//
// Two sources, the same two the AI transcript reads (H-9c picks one with the
// generation's own switch, `aiTranscriptFreshUnionMode`):
//   - "archive": message_archive, the AI archive reader's rows;
//   - "union": message_archive ∪ dm_message_archive through the AI union's
//     own CTE chain (`aiTranscriptUnionCtes`), so the feed and a generation
//     resolve duplicates, tombstones and PPV state identically.
//
// Differences from the AI reads, all deliberate:
//   - a tombstoned message is a row with `deleted = true`, not a gap (a
//     feed shows that something was deleted; a prompt drops it); a
//     content-pending stub never shows;
//   - newest first by the key (event time desc nulls last, guarded-numeric
//     message id desc nulls last, message id desc) — the union's own order —
//     on BOTH sources, so a page boundary never depends on insertion order;
//   - snapshot bounds: a walk reads only rows whose id existed at its first
//     page (`message_archive.id <= archiveMaxId`, `dm_message_archive.id <=
//     dmMaxId`). Messages that arrive during the walk are newer than its key
//     anyway; the bounds keep late backfill of OLD messages out of a walk
//     already past them. Deletions and edits update rows in place, keep the
//     id and stay visible (a deletion turns the row `deleted`). A rebuild swap
//     renumbers message_archive, so the snapshot carries the archive
//     generation and the caller's cursor is bound to it.
//
// `source_account_seq` is not a usable bound: only material observations
// write it (message.received/sent rows and backfilled rows hold NULL), and a
// later re-observation of an old message advances it — bounding on it would
// drop most rows and hide every message re-observed mid-walk.
//
// The key's time travels as UTC text with microseconds: a JS Date would round
// it to milliseconds and two messages one microsecond apart would collapse
// into one page boundary.

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import { aiTranscriptUnionCtes } from "./ai-transcript-union.ts";
import { ARCHIVE_AI_TRANSCRIPT_MAX_ROWS, MESSAGE_ARCHIVE_PROJECTION } from "./message-archive.ts";

export type ConversationFeedSource = "archive" | "union";

/** No reader window exceeds the AI readers' (critic item 15); the route pages by 1–100. */
export const CONVERSATION_FEED_MAX_ROWS = ARCHIVE_AI_TRANSCRIPT_MAX_ROWS;

/** The first-page Ping summary's default window (§4.4: the Ping window). */
export const CONVERSATION_FEED_SUMMARY_DEFAULT_WINDOW = 100;
/**
 * The summary reads through the AI readers, whose window is 1500. The contract
 * accepts `summaryWindow` up to 3000, but the 3000 depth (H-6) is the full
 * Recap's alone; a feed page never makes a deep read.
 */
export const CONVERSATION_FEED_SUMMARY_MAX_WINDOW = ARCHIVE_AI_TRANSCRIPT_MAX_ROWS;

export function conversationFeedSummaryWindow(requested?: number): number {
  const window = Math.trunc(requested ?? CONVERSATION_FEED_SUMMARY_DEFAULT_WINDOW);
  return Math.max(1, Math.min(window, CONVERSATION_FEED_SUMMARY_MAX_WINDOW));
}

/** A row's place in the order. `at` is null for an undated message (they sort last). */
export interface ConversationFeedPosition {
  /** UTC event time with microseconds: `YYYY-MM-DDTHH:MM:SS.ffffffZ`. */
  at: string | null;
  /** The platform message id. */
  ref: string;
}

export const CONVERSATION_FEED_POSITION_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
export const CONVERSATION_FEED_POSITION_REF_MAX_LENGTH = 200;

export interface ConversationFeedSnapshot {
  /** Bumped by the message_archive rebuild swap (row ids change with it). */
  archiveGeneration: number;
  /** The message_archive projection's high watermark for the page. */
  archiveHighSeq: number;
  archiveMaxId: number;
  dmMaxId: number;
}

export interface ConversationFeedRow {
  messageRef: string;
  occurredAt: Date | null;
  position: ConversationFeedPosition;
  textPlain: string;
  senderRole: string;
  isSentByMe: boolean;
  priceMills: string | null;
  isTip: boolean;
  tipAmountMills: string;
  mediaMetadata: Array<Record<string, unknown>> | null;
  isOpened: boolean | null;
  deleted: boolean;
}

export interface ConversationFeedPageInput {
  source: ConversationFeedSource;
  pageId: number;
  conversationRef: string;
  snapshot: Pick<ConversationFeedSnapshot, "archiveMaxId" | "dmMaxId">;
  /** Rows strictly older than this position; absent or null = from the head. */
  before?: ConversationFeedPosition | null;
  limit: number;
}

export interface ConversationFeedPage {
  /** Newest first. */
  rows: ConversationFeedRow[];
  /** The last row's position when the snapshot holds older rows; null at its end. */
  nextBefore: ConversationFeedPosition | null;
}

/**
 * The snapshot a walk is bounded by, in one statement. The maxima are global
 * (primary-key lookups): any row inserted later has a higher id.
 */
export async function readConversationFeedSnapshot(
  db: Database,
  input: { pageId: number },
): Promise<ConversationFeedSnapshot> {
  const result = await db.execute<Record<string, string>>(sql`
    select coalesce((select g.generation from archive_generation g where g.id = 1), 0)::text as archive_generation,
           coalesce((select w.high_seq from projection_seq_watermarks w
                     where w.projection = ${MESSAGE_ARCHIVE_PROJECTION}
                       and w.account_id = ${input.pageId}), 0)::text as archive_high_seq,
           coalesce((select max(ma.id) from message_archive ma), 0)::text as archive_max_id,
           coalesce((select max(d.id) from dm_message_archive d), 0)::text as dm_max_id
  `);
  const row = result.rows[0];
  return {
    archiveGeneration: Number(row?.archive_generation ?? 0),
    archiveHighSeq: Number(row?.archive_high_seq ?? 0),
    archiveMaxId: Number(row?.archive_max_id ?? 0),
    dmMaxId: Number(row?.dm_max_id ?? 0),
  };
}

const NUMERIC_REF = /^[0-9]{1,18}$/;

function assertPosition(position: ConversationFeedPosition): void {
  if (
    (position.at !== null && !CONVERSATION_FEED_POSITION_AT_PATTERN.test(position.at))
    || position.ref.length === 0
    || position.ref.length > CONVERSATION_FEED_POSITION_REF_MAX_LENGTH
  ) {
    throw new Error("conversation feed: malformed position");
  }
}

interface KeyColumns {
  time: SQL;
  numericRef: SQL;
  ref: SQL;
}

/**
 * "Strictly after `before`" in the order (time desc nulls last, numeric ref
 * desc nulls last, ref desc), expanded by hand: a row tuple compare treats
 * NULL as unknown, not as last.
 */
function olderThan(columns: KeyColumns, before: ConversationFeedPosition): SQL {
  const { time, numericRef, ref } = columns;
  const refTail = NUMERIC_REF.test(before.ref)
    ? sql`(${numericRef} is null
              or ${numericRef} < ${before.ref}::bigint
              or (${numericRef} = ${before.ref}::bigint and ${ref} < ${before.ref}))`
    : sql`(${numericRef} is null and ${ref} < ${before.ref})`;
  return before.at === null
    ? sql`(${time} is null and ${refTail})`
    : sql`(${time} is null
           or ${time} < ${before.at}::timestamptz
           or (${time} = ${before.at}::timestamptz and ${refTail}))`;
}

function orderBy(columns: KeyColumns): SQL {
  return sql`${columns.time} desc nulls last, ${columns.numericRef} desc nulls last, ${columns.ref} desc`;
}

function eventTimeKey(time: SQL): SQL {
  return sql`to_char(${time} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

function archivePageQuery(input: ConversationFeedPageInput, limit: number): SQL {
  const columns: KeyColumns = {
    time: sql`ma.occurred_at`,
    numericRef: sql`(case when ma.message_ref ~ '^[0-9]{1,18}$' then ma.message_ref::bigint end)`,
    ref: sql`ma.message_ref`,
  };
  const older = input.before ? sql`
      and ${olderThan(columns, input.before)}` : sql``;
  return sql`
    select ma.message_ref,
           ma.occurred_at as event_time,
           ${eventTimeKey(columns.time)} as event_time_key,
           ma.text_plain,
           ma.sender_role,
           ma.is_sent_by_me,
           ma.price_mills::text as price_mills,
           ma.is_tip,
           ma.tip_amount_mills::text as tip_amount_mills,
           ma.media_metadata,
           ma.is_opened,
           (ma.deleted_at is not null) as deleted
    from message_archive ma
    where ma.account_id = ${input.pageId}
      and ma.conversation_ref = ${input.conversationRef}
      and ma.content_pending = false
      and ma.id <= ${input.snapshot.archiveMaxId}${older}
    order by ${orderBy(columns)}
    limit ${limit + 1}
  `;
}

function unionPageQuery(input: ConversationFeedPageInput, limit: number): SQL {
  const columns: KeyColumns = {
    time: sql`u.event_time`,
    numericRef: sql`(case when u.message_ref ~ '^[0-9]{1,18}$' then u.message_ref::bigint end)`,
    ref: sql`u.message_ref`,
  };
  const ctes = aiTranscriptUnionCtes(
    { pageId: input.pageId, conversationRef: input.conversationRef },
    { bounds: input.snapshot, tombstones: "flag" },
  );
  const older = input.before ? sql`
    where ${olderThan(columns, input.before)}` : sql``;
  return sql`
    with ${ctes}
    select u.message_ref,
           u.event_time,
           ${eventTimeKey(columns.time)} as event_time_key,
           u.text_plain,
           u.sender_role,
           u.is_sent_by_me,
           u.price_mills::text as price_mills,
           u.is_tip,
           u.tip_amount_mills::text as tip_amount_mills,
           u.media_metadata,
           u.is_opened,
           u.deleted
    from upgraded u${older}
    order by ${orderBy(columns)}
    limit ${limit + 1}
  `;
}

function buildPageQuery(input: ConversationFeedPageInput): { query: SQL; limit: number } {
  if (input.before) {
    assertPosition(input.before);
  }
  if (!Number.isFinite(input.limit)) {
    throw new Error("conversation feed: limit must be a number");
  }
  const limit = Math.max(1, Math.min(Math.trunc(input.limit), CONVERSATION_FEED_MAX_ROWS));
  // One extra row says whether an older page exists, so the last page never
  // hands out a cursor that leads to an empty one.
  const query = input.source === "union" ? unionPageQuery(input, limit) : archivePageQuery(input, limit);
  return { query, limit };
}

function mapRow(row: Record<string, unknown>): ConversationFeedRow {
  const messageRef = String(row.message_ref);
  return {
    messageRef,
    occurredAt: row.event_time == null ? null : new Date(row.event_time as string | Date),
    position: { at: row.event_time_key == null ? null : String(row.event_time_key), ref: messageRef },
    textPlain: String(row.text_plain ?? ""),
    senderRole: String(row.sender_role),
    isSentByMe: row.is_sent_by_me === true,
    priceMills: row.price_mills == null ? null : String(row.price_mills),
    isTip: row.is_tip === true,
    tipAmountMills: String(row.tip_amount_mills ?? "0"),
    mediaMetadata: (row.media_metadata as Array<Record<string, unknown>> | null) ?? null,
    isOpened: row.is_opened == null ? null : row.is_opened === true,
    deleted: row.deleted === true,
  };
}

export async function listConversationFeedPage(
  db: Database,
  input: ConversationFeedPageInput,
): Promise<ConversationFeedPage> {
  const { query, limit } = buildPageQuery(input);
  const result = await db.execute<Record<string, unknown>>(query);
  const rows = result.rows.map(mapRow);
  if (rows.length <= limit) {
    return { rows, nextBefore: null };
  }
  const page = rows.slice(0, limit);
  return { rows: page, nextBefore: page.at(-1)?.position ?? null };
}

/** Perf-gate seam: EXPLAIN over the exact statement the reader runs. */
export async function explainConversationFeedPage(
  db: Database,
  input: ConversationFeedPageInput,
): Promise<string> {
  const { query } = buildPageQuery(input);
  const result = await db.execute<{ "QUERY PLAN": string }>(sql`explain (format text) ${query}`);
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}
