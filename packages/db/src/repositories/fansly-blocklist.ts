import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Fan marks (0325): the posts of the Telegram group FANSLY BLOCKLIST that name
// a fansly.com profile, and the reader's place in the group's history. The
// reader (apps/runtime/src/services/fansly-blocklist/reader.ts) writes them;
// `clientFanMarks` finds a fan's posts by his username.

export interface FanslyBlocklistReaderState {
  chatId: number;
  /** The newest message read. */
  headMessageId: number | null;
  /** The oldest message read: the backfill goes on below it. */
  tailMessageId: number | null;
  backfillDoneAt: Date | null;
  /** The last run that read the group to its newest message. */
  readAt: Date | null;
  floodUntil: Date | null;
  messagesRead: number;
}

type StateRow = {
  chat_id: string | number; head_message_id: string | number | null; tail_message_id: string | number | null;
  backfill_done_at: Date | string | null; read_at: Date | string | null; flood_until: Date | string | null;
  messages_read: string | number;
};

const num = (value: string | number | null) => (value === null ? null : Number(value));
const date = (value: Date | string | null) => (value === null ? null : new Date(value));
const isoOrNull = (value: Date | null) => (value === null ? null : value.toISOString());

export async function getFanslyBlocklistReaderState(db: Database, chatId: number): Promise<FanslyBlocklistReaderState | null> {
  const result = await db.execute<StateRow>(sql`
    select chat_id, head_message_id, tail_message_id, backfill_done_at, read_at, flood_until, messages_read
    from fansly_blocklist_reader where chat_id = ${chatId}`);
  const row = result.rows[0];
  return row === undefined ? null : {
    chatId: Number(row.chat_id),
    headMessageId: num(row.head_message_id),
    tailMessageId: num(row.tail_message_id),
    backfillDoneAt: date(row.backfill_done_at),
    readAt: date(row.read_at),
    floodUntil: date(row.flood_until),
    messagesRead: Number(row.messages_read),
  };
}

export async function saveFanslyBlocklistReaderState(db: Database, state: FanslyBlocklistReaderState): Promise<void> {
  await db.execute(sql`
    insert into fansly_blocklist_reader
      (chat_id, head_message_id, tail_message_id, backfill_done_at, read_at, flood_until, messages_read, updated_at)
    values (${state.chatId}, ${state.headMessageId}, ${state.tailMessageId}, ${isoOrNull(state.backfillDoneAt)}::timestamptz,
      ${isoOrNull(state.readAt)}::timestamptz, ${isoOrNull(state.floodUntil)}::timestamptz, ${state.messagesRead}, now())
    on conflict (chat_id) do update set
      head_message_id = excluded.head_message_id,
      tail_message_id = excluded.tail_message_id,
      backfill_done_at = excluded.backfill_done_at,
      read_at = excluded.read_at,
      flood_until = excluded.flood_until,
      messages_read = excluded.messages_read,
      updated_at = now()`);
}

/** The newest successful run of any reader (null: never). */
export async function latestFanslyBlocklistReadAt(db: Database): Promise<Date | null> {
  const result = await db.execute<{ at: Date | string | null }>(sql`select max(read_at) as at from fansly_blocklist_reader`);
  return date(result.rows[0]?.at ?? null);
}

/** One message as read: the profiles it names (none — it is kept only if already stored). */
export interface FanslyBlocklistMessageInput {
  messageId: number;
  postedAt: Date;
  editedAt: Date | null;
  authorName: string | null;
  text: string;
  /** `key`: the handle lowercased. */
  handles: ReadonlyArray<{ key: string; handle: string }>;
}

/**
 * Store what one read returned. A message that names a profile is stored (or
 * refreshed: its text, edit and handles as read now, not deleted); one that
 * names none is stored only if it was before (an edit took its links away:
 * its text is refreshed and its handles are no longer current). Returns the posts written.
 */
export async function upsertFanslyBlocklistMessages(
  db: Database,
  input: { chatId: number; readAt: Date; messages: readonly FanslyBlocklistMessageInput[] },
): Promise<number> {
  const messages = [...new Map(input.messages.map((message) => [message.messageId, message])).values()];
  if (messages.length === 0) return 0;
  const at = sql`${input.readAt.toISOString()}::timestamptz`;
  const ids = sql.param(messages.map((message) => String(message.messageId)));
  const rows = sql`unnest(
      ${ids}::bigint[],
      ${sql.param(messages.map((message) => message.postedAt.toISOString()))}::timestamptz[],
      ${sql.param(messages.map((message) => isoOrNull(message.editedAt)))}::timestamptz[],
      ${sql.param(messages.map((message) => message.authorName))}::text[],
      ${sql.param(messages.map((message) => message.text))}::text[],
      ${sql.param(messages.map((message) => message.handles.length > 0))}::boolean[]
    ) as m(message_id, posted_at, edited_at, author_name, text, named)`;
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const written = await tx.execute(sql`
      insert into fansly_blocklist_posts (chat_id, message_id, posted_at, edited_at, author_name, text, deleted_at, first_read_at, read_at)
      select ${input.chatId}, m.message_id, m.posted_at, m.edited_at, m.author_name, m.text, null, ${at}, ${at}
      from ${rows}
      where m.named or exists (
        select 1 from fansly_blocklist_posts p where p.chat_id = ${input.chatId} and p.message_id = m.message_id)
      on conflict (chat_id, message_id) do update set
        posted_at = excluded.posted_at,
        edited_at = excluded.edited_at,
        author_name = excluded.author_name,
        text = excluded.text,
        deleted_at = null,
        read_at = excluded.read_at`);
    // What the posts name now replaces what they named: a handle an edit took away stays, not current.
    await tx.execute(sql`
      update fansly_blocklist_handles set is_current = false
      where chat_id = ${input.chatId} and message_id = any(${ids}::bigint[]) and is_current`);
    const handles = messages.flatMap((message) => [...new Map(message.handles.map((one) => [one.key, one])).values()]
      .map((one) => ({ messageId: message.messageId, ...one })));
    if (handles.length > 0) {
      await tx.execute(sql`
        insert into fansly_blocklist_handles (chat_id, message_id, handle_key, handle)
        select ${input.chatId}, h.message_id, h.handle_key, h.handle
        from unnest(
          ${sql.param(handles.map((one) => String(one.messageId)))}::bigint[],
          ${sql.param(handles.map((one) => one.key))}::text[],
          ${sql.param(handles.map((one) => one.handle))}::text[]
        ) as h(message_id, handle_key, handle)
        on conflict (chat_id, message_id, handle_key) do update set handle = excluded.handle, is_current = true`);
    }
    return written.rowCount ?? 0;
  });
}

/**
 * A re-read of the messages `fromMessageId`..`toMessageId` returned only
 * `presentIds`: the stored posts in that range it did not return are gone
 * from the group. Returns how many it marked.
 */
export async function markFanslyBlocklistPostsDeleted(
  db: Database,
  input: { chatId: number; fromMessageId: number; toMessageId: number; presentIds: readonly number[]; at: Date },
): Promise<number> {
  const result = await db.execute(sql`
    update fansly_blocklist_posts set deleted_at = ${input.at.toISOString()}::timestamptz
    where chat_id = ${input.chatId} and deleted_at is null
      and message_id between ${input.fromMessageId} and ${input.toMessageId}
      and not (message_id = any(${sql.param(input.presentIds.map(String))}::bigint[]))`);
  return result.rowCount ?? 0;
}

export interface FanslyBlocklistMatchRow {
  chatId: number;
  messageId: number;
  postedAt: Date;
  authorName: string | null;
  text: string;
  /** The handle as the post wrote it. */
  handle: string;
}

/** The posts not gone that name any of `handleKeys` (lowercase), newest first, at most `limit`. */
export async function findFanslyBlocklistPosts(
  db: Database,
  input: { handleKeys: readonly string[]; limit: number },
): Promise<FanslyBlocklistMatchRow[]> {
  const keys = [...new Set(input.handleKeys)];
  if (keys.length === 0) return [];
  const result = await db.execute<{
    chat_id: string | number; message_id: string | number; posted_at: Date | string; author_name: string | null;
    text: string; handle: string;
  }>(sql`
    select * from (
      select distinct on (p.chat_id, p.message_id) p.chat_id, p.message_id, p.posted_at, p.author_name, p.text, h.handle
      from fansly_blocklist_handles h
      join fansly_blocklist_posts p on p.chat_id = h.chat_id and p.message_id = h.message_id
      where h.handle_key = any(${sql.param(keys)}::text[]) and h.is_current and p.deleted_at is null
      order by p.chat_id, p.message_id, h.handle
    ) found
    order by posted_at desc, message_id desc
    limit ${input.limit}`);
  return result.rows.map((row) => ({
    chatId: Number(row.chat_id),
    messageId: Number(row.message_id),
    postedAt: new Date(row.posted_at),
    authorName: row.author_name,
    text: row.text,
    handle: row.handle,
  }));
}
