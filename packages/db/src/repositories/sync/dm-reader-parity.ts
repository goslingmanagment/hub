import { sql } from "drizzle-orm";
import { FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY } from "@agency_hub_core/shared";

import type { Database } from "../../client.ts";
import { archiveSenderRole, archiveStoredMessageSql, archiveThreadRowsFromSql } from "../dm-archive-store.ts";
import { textArrayParam, toDate } from "./values.ts";

// Step 4, S4-06 (owner decision №11): the read-only reads of the DM reader
// parity (`pnpm cli sync dm-reader-parity`, apps/runtime/src/sync/parity/).
// The parity calls the real readers both ways (page_dm_messages and the
// message_archive variants S4-08 serves from); these reads only pick the
// sample and look up the facts that classify a difference. Nothing here
// writes; the caller runs each read in a READ ONLY transaction.

/** A thread the parity samples, with its stored count (the summary column). */
export interface DmParityThread {
  threadId: number;
  conversationRef: string;
  isVisible: boolean;
  storedMessageCount: number;
}

/** Why a lifetime sample thread is in the sample (design S4-06). */
export type DmParitySpecialReason = "deletion" | "tip" | "ppv" | "reply" | "exclusion";

export interface DmParitySpecialThread extends DmParityThread {
  reasons: DmParitySpecialReason[];
}

/** A thread whose live rows differ between the stores: hot rows the
 *  archive does not hold live, and archive rows the hot table does not. */
export interface DmParityPresenceThread extends DmParityThread {
  hotOnly: number;
  archiveOnly: number;
}

type ThreadRow = {
  thread_id: string;
  conversation_ref: string;
  is_visible: boolean;
  stored_message_count: number | string;
};

function threadOf(row: ThreadRow): DmParityThread {
  return {
    threadId: Number(row.thread_id),
    conversationRef: row.conversation_ref,
    isVisible: row.is_visible === true,
    storedMessageCount: Number(row.stored_message_count),
  };
}

const THREAD_COLUMNS = sql`t.id::text as thread_id, t.platform_conversation_id as conversation_ref,
  t.is_visible, t.stored_message_count`;

/** The page's platform as the archive spells it. */
function pagePlatformSql(pageId: number) {
  return sql`(select p.platform::text from pages p where p.id = ${pageId})`;
}

/** Threads with activity since `since`: a new head or a written summary
 *  (the thread row), a new archive message, or a new overlay row; the most
 *  recent first, at most `limit`. */
export async function listDmParityActiveThreads(
  db: Database,
  input: { pageId: number; since: Date; limit: number },
): Promise<DmParityThread[]> {
  const result = await db.execute<ThreadRow>(sql`
    with recent as (
      select t.id
        from page_dm_threads t
       where t.platform_account_id = ${input.pageId}
         and (t.last_message_at >= ${input.since} or t.updated_at >= ${input.since})
      union
      select t.id
        from message_archive ma
        join page_dm_threads t
          on t.platform_account_id = ma.account_id and t.platform_conversation_id = ma.conversation_ref
       where ma.account_id = ${input.pageId}
         and ma.platform = ${pagePlatformSql(input.pageId)}
         and ma.occurred_at >= ${input.since}
      union
      select t.id
        from dm_live_messages l
        join page_dm_threads t
          on t.platform_account_id = l.page_id and t.platform_conversation_id = l.platform_conversation_id
       where l.page_id = ${input.pageId}
         and l.first_visible_at >= ${input.since}
    )
    select ${THREAD_COLUMNS}
      from page_dm_threads t
      join recent r on r.id = t.id
     order by greatest(t.last_message_at, t.updated_at) desc nulls last, t.id
     limit ${input.limit}
  `);
  return result.rows.map(threadOf);
}

/** A random sample of the page's visible threads with stored messages,
 *  stratified by stored count: `quotas[i]` threads from bucket i of
 *  1–25, 26–100, 101–1000, >1000. */
export async function listDmParityStratifiedThreads(
  db: Database,
  input: { pageId: number; quotas: readonly [number, number, number, number] },
): Promise<DmParityThread[]> {
  const result = await db.execute<ThreadRow>(sql`
    select thread_id, conversation_ref, is_visible, stored_message_count
      from (
        select ${THREAD_COLUMNS},
               row_number() over (partition by b.bucket order by random()) as rn,
               b.bucket
          from page_dm_threads t
          cross join lateral (
            select case when t.stored_message_count <= 25 then 1
                        when t.stored_message_count <= 100 then 2
                        when t.stored_message_count <= 1000 then 3
                        else 4 end as bucket
          ) b
         where t.platform_account_id = ${input.pageId}
           and t.is_visible = true
           and t.stored_message_count > 0
      ) s
     where s.rn <= (${sql.param([...input.quotas])}::int[])[s.bucket]
     order by s.bucket, s.thread_id::bigint
  `);
  return result.rows.map(threadOf);
}

/** Every thread of the page with a deletion, a tip, a PPV, a reply ref (in
 *  either store) or a message-sync exclusion, over its whole history. */
export async function listDmParitySpecialThreads(
  db: Database,
  input: { pageId: number },
): Promise<DmParitySpecialThread[]> {
  const result = await db.execute<ThreadRow & {
    deletion: boolean;
    tip: boolean;
    ppv: boolean;
    reply: boolean;
    exclusion: boolean;
  }>(sql`
    with hot as (
      select m.conversation_id as thread_id,
             bool_or(m.deleted_at is not null) as deletion,
             bool_or(m.total_tip_amount_cents > 0) as tip,
             bool_or(m.purchased_at is not null) as ppv,
             bool_or(m.in_reply_to_message_id is not null) as reply
        from page_dm_messages m
       where m.platform_account_id = ${input.pageId}
       group by 1
    ), archived as (
      select t.id as thread_id,
             bool_or(ma.deleted_at is not null) as deletion,
             bool_or(ma.is_tip or ma.tip_amount_mills > 0) as tip,
             bool_or(ma.price_mills > 0 or ma.is_opened is not null) as ppv,
             bool_or(ma.in_reply_to_ref is not null) as reply
        from message_archive ma
        join page_dm_threads t
          on t.platform_account_id = ma.account_id and t.platform_conversation_id = ma.conversation_ref
       where ma.account_id = ${input.pageId}
         and ma.platform = ${pagePlatformSql(input.pageId)}
       group by 1
    ), flagged as (
      select ${THREAD_COLUMNS},
             coalesce(h.deletion, false) or coalesce(a.deletion, false) as deletion,
             coalesce(h.tip, false) or coalesce(a.tip, false) as tip,
             coalesce(h.ppv, false) or coalesce(a.ppv, false) as ppv,
             coalesce(h.reply, false) or coalesce(a.reply, false) as reply,
             coalesce(btrim(t.metadata ->> ${FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY}), '') <> '' as exclusion
        from page_dm_threads t
        left join hot h on h.thread_id = t.id
        left join archived a on a.thread_id = t.id
       where t.platform_account_id = ${input.pageId}
    )
    select * from flagged
     where deletion or tip or ppv or reply or exclusion
     order by thread_id::bigint
  `);
  return result.rows.map((row) => ({
    ...threadOf(row),
    reasons: (["deletion", "tip", "ppv", "reply", "exclusion"] as const).filter((reason) => row[reason] === true),
  }));
}

/** Threads with an unconfirmed, undeleted overlay row right now. */
export async function listDmParityPendingOverlayThreads(
  db: Database,
  input: { pageId: number },
): Promise<DmParityThread[]> {
  const result = await db.execute<ThreadRow>(sql`
    select distinct ${THREAD_COLUMNS}
      from dm_live_messages l
      join page_dm_threads t
        on t.platform_account_id = l.page_id and t.platform_conversation_id = l.platform_conversation_id
     where l.page_id = ${input.pageId}
       and l.confirmed_at is null
       and l.deleted_at is null
     order by 1
  `);
  return result.rows.map(threadOf);
}

/** Every thread of the page whose live rows differ between the stores (the
 *  №11 archive-only threads among them), with the counts of each side. */
export async function listDmParityPresenceThreads(
  db: Database,
  input: { pageId: number },
): Promise<DmParityPresenceThread[]> {
  const result = await db.execute<ThreadRow & { hot_only: number | string; archive_only: number | string }>(sql`
    with hot_only as (
      select m.conversation_id as thread_id, count(*) as n
        from page_dm_messages m
        join page_dm_threads t on t.id = m.conversation_id
       where m.platform_account_id = ${input.pageId}
         and m.deleted_at is null
         and not exists (
           select 1 from message_archive ma
            where ma.account_id = m.platform_account_id
              and ma.platform = ${pagePlatformSql(input.pageId)}
              and ma.message_ref = m.platform_message_id
              and ma.conversation_ref = t.platform_conversation_id
              and ${archiveStoredMessageSql("ma")}
         )
       group by 1
    ), archive_only as (
      select t.id as thread_id, count(*) as n
        from message_archive ma
        join page_dm_threads t
          on t.platform_account_id = ma.account_id and t.platform_conversation_id = ma.conversation_ref
       where ma.account_id = ${input.pageId}
         and ma.platform = ${pagePlatformSql(input.pageId)}
         and ${archiveStoredMessageSql("ma")}
         and not exists (
           select 1 from page_dm_messages m
            where m.conversation_id = t.id
              and m.platform_message_id = ma.message_ref
              and m.deleted_at is null
         )
       group by 1
    )
    select ${THREAD_COLUMNS},
           coalesce(h.n, 0) as hot_only,
           coalesce(a.n, 0) as archive_only
      from page_dm_threads t
      left join hot_only h on h.thread_id = t.id
      left join archive_only a on a.thread_id = t.id
     where t.platform_account_id = ${input.pageId}
       and (h.thread_id is not null or a.thread_id is not null)
     order by t.id
  `);
  return result.rows.map((row) => ({
    ...threadOf(row),
    hotOnly: Number(row.hot_only),
    archiveOnly: Number(row.archive_only),
  }));
}

/** The message ids of one thread that only one store holds live. */
export async function diffDmParityThreadRows(
  db: Database,
  threadId: number,
): Promise<{ hotOnly: string[]; archiveOnly: string[] }> {
  const result = await db.execute<{ ref: string; in_hot: boolean }>(sql`
    with hot as (
      select m.platform_message_id as ref
        from page_dm_messages m
       where m.conversation_id = ${threadId}
         and m.deleted_at is null
    ), archived as (
      select ma.message_ref as ref
        from ${archiveThreadRowsFromSql(threadId)}
         and ${archiveStoredMessageSql("ma")}
    )
    select coalesce(h.ref, a.ref) as ref, h.ref is not null as in_hot
      from hot h
      full join archived a on a.ref = h.ref
     where h.ref is null or a.ref is null
     order by 1
  `);
  return {
    hotOnly: result.rows.filter((row) => row.in_hot === true).map((row) => row.ref),
    archiveOnly: result.rows.filter((row) => row.in_hot !== true).map((row) => row.ref),
  };
}

/** Where the hot table holds a message of the page, relative to one chat. */
export type DmParityHotState = "absent" | "live" | "deleted" | "other_conversation";
/** Where the archive holds it: `not_stored` is a row the readers do not
 *  count (a content-pending stub or an undated row). */
export type DmParityArchiveState = "absent" | "live" | "deleted" | "not_stored" | "other_conversation";

export interface DmParityRefState {
  ref: string;
  hot: DmParityHotState;
  archive: DmParityArchiveState;
  /** The chat each store files it under, when that is not the asked one. */
  hotConversationRef: string | null;
  archiveConversationRef: string | null;
}

/** Each message's state in both stores (by the page's message id), as seen
 *  from the chat `conversationRef`. */
export async function readDmParityRefStates(
  db: Database,
  input: { pageId: number; conversationRef: string; refs: readonly string[] },
): Promise<Map<string, DmParityRefState>> {
  const states = new Map<string, DmParityRefState>();
  if (input.refs.length === 0) return states;
  const result = await db.execute<{
    ref: string;
    hot_deleted: boolean | null;
    hot_conversation_ref: string | null;
    archive_found: boolean;
    archive_deleted: boolean | null;
    archive_stored: boolean | null;
    archive_conversation_ref: string | null;
  }>(sql`
    select r.ref,
           h.deleted as hot_deleted,
           h.conversation_ref as hot_conversation_ref,
           ma.id is not null as archive_found,
           ma.deleted_at is not null as archive_deleted,
           (ma.content_pending = false and ma.occurred_at is not null) as archive_stored,
           ma.conversation_ref as archive_conversation_ref
      from unnest(${textArrayParam([...new Set(input.refs)])}) as r(ref)
      left join lateral (
        select m.deleted_at is not null as deleted, t.platform_conversation_id as conversation_ref
          from page_dm_messages m
          join page_dm_threads t on t.id = m.conversation_id
         where m.platform_account_id = ${input.pageId}
           and m.platform_message_id = r.ref
         order by (t.platform_conversation_id = ${input.conversationRef}) desc, m.id
         limit 1
      ) h on true
      left join message_archive ma
        on ma.account_id = ${input.pageId}
       and ma.platform = ${pagePlatformSql(input.pageId)}
       and ma.message_ref = r.ref
  `);
  for (const row of result.rows) {
    const hotElsewhere = row.hot_conversation_ref !== null && row.hot_conversation_ref !== input.conversationRef;
    const archiveElsewhere = row.archive_found && row.archive_conversation_ref !== input.conversationRef;
    states.set(row.ref, {
      ref: row.ref,
      hot: row.hot_deleted === null ? "absent" : hotElsewhere ? "other_conversation" : row.hot_deleted ? "deleted" : "live",
      archive: !row.archive_found
        ? "absent"
        : archiveElsewhere
          ? "other_conversation"
          : row.archive_deleted
            ? "deleted"
            : row.archive_stored ? "live" : "not_stored",
      hotConversationRef: hotElsewhere ? row.hot_conversation_ref : null,
      archiveConversationRef: archiveElsewhere ? row.archive_conversation_ref : null,
    });
  }
  return states;
}

/** Whether each thread has a live row in either store (a coverage recheck). */
export async function readDmParityThreadPresence(
  db: Database,
  threadIds: readonly number[],
): Promise<Map<number, { hot: boolean; archive: boolean }>> {
  const presence = new Map<number, { hot: boolean; archive: boolean }>();
  if (threadIds.length === 0) return presence;
  const result = await db.execute<{ thread_id: string; hot: boolean; archive: boolean }>(sql`
    select t.id::text as thread_id,
           exists (select 1 from page_dm_messages m where m.conversation_id = t.id and m.deleted_at is null) as hot,
           exists (
             select 1 from message_archive ma
              join pages p on p.id = t.platform_account_id
              where ma.account_id = t.platform_account_id
                and ma.platform = p.platform::text
                and ma.conversation_ref = t.platform_conversation_id
                and ${archiveStoredMessageSql("ma")}
           ) as archive
      from page_dm_threads t
     where t.id = any(${textArrayParam(threadIds.map(String))}::bigint[])
  `);
  for (const row of result.rows) presence.set(Number(row.thread_id), { hot: row.hot === true, archive: row.archive === true });
  return presence;
}

/** The page's conversation coverage (`getPageDmSyncCoverage`'s
 *  `previewReadyConversationCount`: visible fan threads with stored
 *  messages) counted three ways, and the threads where they disagree. */
export interface DmParityCoverage {
  columnReady: number;
  hotReady: number;
  archiveReady: number;
  differing: Array<{
    threadId: number;
    conversationRef: string;
    columnReady: boolean;
    hotReady: boolean;
    archiveReady: boolean;
  }>;
}

export async function readDmParityCoverage(
  db: Database,
  input: { pageId: number },
): Promise<DmParityCoverage> {
  const result = await db.execute<{
    column_ready: number;
    hot_ready: number;
    archive_ready: number;
    differing: Array<{
      thread_id: number;
      conversation_ref: string;
      column_ready: boolean;
      hot_ready: boolean;
      archive_ready: boolean;
    }>;
  }>(sql`
    with x as (
      select t.id as thread_id,
             t.platform_conversation_id as conversation_ref,
             t.stored_message_count > 0 as column_ready,
             exists (select 1 from page_dm_messages m where m.conversation_id = t.id and m.deleted_at is null) as hot_ready,
             exists (
               select 1 from message_archive ma
                where ma.account_id = t.platform_account_id
                  and ma.platform = ${pagePlatformSql(input.pageId)}
                  and ma.conversation_ref = t.platform_conversation_id
                  and ${archiveStoredMessageSql("ma")}
             ) as archive_ready
        from page_dm_threads t
       where t.platform_account_id = ${input.pageId}
         and t.is_visible = true
         and t.fan_id is not null
    )
    select count(*) filter (where column_ready)::int as column_ready,
           count(*) filter (where hot_ready)::int as hot_ready,
           count(*) filter (where archive_ready)::int as archive_ready,
           coalesce(
             json_agg(json_build_object(
               'thread_id', thread_id, 'conversation_ref', conversation_ref, 'column_ready', column_ready,
               'hot_ready', hot_ready, 'archive_ready', archive_ready
             ) order by thread_id) filter (where column_ready <> archive_ready or hot_ready <> archive_ready),
             '[]'::json
           ) as differing
      from x
  `);
  const row = result.rows[0];
  return {
    columnReady: Number(row?.column_ready ?? 0),
    hotReady: Number(row?.hot_ready ?? 0),
    archiveReady: Number(row?.archive_ready ?? 0),
    differing: (row?.differing ?? []).map((item) => ({
      threadId: Number(item.thread_id),
      conversationRef: item.conversation_ref,
      columnReady: item.column_ready === true,
      hotReady: item.hot_ready === true,
      archiveReady: item.archive_ready === true,
    })),
  };
}

/** One hot row and the archive row with its message id (the `--full` scan). */
export interface DmParityFullRow {
  hotId: number;
  pageId: number;
  threadId: number;
  conversationRef: string;
  ref: string;
  hot: {
    deleted: boolean;
    senderRole: string;
    senderId: string | null;
    createdAt: Date;
    content: string;
    tipCents: number;
    opened: boolean;
  };
  archive: {
    conversationRef: string | null;
    deleted: boolean;
    stored: boolean;
    /** As the archive readers serve it (a hot-table role). */
    senderRole: string;
    senderId: string | null;
    occurredAt: Date | null;
    textPlain: string;
    tipMills: string;
    isOpened: boolean | null;
  } | null;
}

/** The next `limit` hot rows of the pages after hot id `afterId`, each
 *  with its archive row (by the page's message id). */
export async function listDmParityFullRows(
  db: Database,
  input: { pageIds: readonly number[]; afterId: number; limit: number },
): Promise<DmParityFullRow[]> {
  if (input.pageIds.length === 0) return [];
  const result = await db.execute<{
    hot_id: string;
    page_id: string;
    thread_id: string;
    conversation_ref: string;
    ref: string;
    hot_deleted: boolean;
    hot_role: string;
    hot_sender: string | null;
    hot_at: Date | string;
    hot_content: string;
    hot_tip_cents: number;
    hot_opened: boolean;
    archive_found: boolean;
    archive_conversation_ref: string | null;
    archive_deleted: boolean;
    archive_stored: boolean;
    archive_role: string | null;
    archive_sender: string | null;
    archive_at: Date | string | null;
    archive_text: string | null;
    archive_tip_mills: string | null;
    archive_opened: boolean | null;
  }>(sql`
    select m.id::text as hot_id,
           m.platform_account_id::text as page_id,
           t.id::text as thread_id,
           t.platform_conversation_id as conversation_ref,
           m.platform_message_id as ref,
           m.deleted_at is not null as hot_deleted,
           m.sender_role::text as hot_role,
           m.sender_platform_user_id as hot_sender,
           m.created_at as hot_at,
           m.content as hot_content,
           m.total_tip_amount_cents as hot_tip_cents,
           m.purchased_at is not null as hot_opened,
           ma.id is not null as archive_found,
           ma.conversation_ref as archive_conversation_ref,
           ma.deleted_at is not null as archive_deleted,
           (ma.content_pending = false and ma.occurred_at is not null) as archive_stored,
           ma.sender_role as archive_role,
           case when ma.is_sent_by_me then p.external_page_id
                else coalesce(ma.fan_native_id, t.partner_platform_user_id) end as archive_sender,
           ma.occurred_at as archive_at,
           ma.text_plain as archive_text,
           ma.tip_amount_mills::text as archive_tip_mills,
           ma.is_opened as archive_opened
      from page_dm_messages m
      join page_dm_threads t on t.id = m.conversation_id
      join pages p on p.id = m.platform_account_id
      left join message_archive ma
        on ma.account_id = m.platform_account_id
       and ma.platform = p.platform::text
       and ma.message_ref = m.platform_message_id
     where m.platform_account_id = any(${textArrayParam(input.pageIds.map(String))}::bigint[])
       and m.id > ${input.afterId}
     order by m.id
     limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    hotId: Number(row.hot_id),
    pageId: Number(row.page_id),
    threadId: Number(row.thread_id),
    conversationRef: row.conversation_ref,
    ref: row.ref,
    hot: {
      deleted: row.hot_deleted === true,
      senderRole: row.hot_role,
      senderId: row.hot_sender,
      createdAt: toDate(row.hot_at) as Date,
      content: row.hot_content,
      tipCents: Number(row.hot_tip_cents),
      opened: row.hot_opened === true,
    },
    archive: row.archive_found
      ? {
        conversationRef: row.archive_conversation_ref,
        deleted: row.archive_deleted === true,
        stored: row.archive_stored === true,
        senderRole: archiveSenderRole(row.archive_role),
        senderId: row.archive_sender,
        occurredAt: toDate(row.archive_at),
        textPlain: row.archive_text ?? "",
        tipMills: row.archive_tip_mills ?? "0",
        isOpened: row.archive_opened,
      }
      : null,
  }));
}
