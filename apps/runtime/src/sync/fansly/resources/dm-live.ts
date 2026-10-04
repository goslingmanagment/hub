import { sql } from "drizzle-orm";

import {
  appendDomainEventsInTransaction,
  applyMessageEventsToArchive,
  isDmArchiveScopeFenced,
  listDomainEventsByDedupKeys,
  markFanslyWsHotDeletion,
  writeThreadSummaryAfterDeletion,
  type Database,
  type DomainEventInput,
} from "@agency_hub_core/db";

import type { ApplyResult, LocalApplyInput, ResourceModule } from "../../engine/resource.ts";

// `dm-live.deletions` (design §5.5, §6.3 step 4, D24; step-3 design §3.3 item
// 4): the socket said a message was deleted. The overlay's sticky mark is
// already written by the step-1 apply in the transaction that acked the frame;
// this work carries the deletion to the hot table and the archive WITHOUT a
// request, on the actor's next lap after the ack — before its HTTP gate, so no
// page hold or pacer slot delays it (ruling 9) — outside the ack transaction
// so the lock order holds (hot tables before `domain_event_seq`).
//
// Shadow (step 2): the router creates the work from real deletion frames so
// the shadow report sees the demand, and the step closes at once — a shadow
// page never writes a hot table, the archive or an event (I14).
//
// Live: a `local` step (`applyLocal`, in the commit's generation-fenced
// transaction under the erasure fence the entry declares). Per deleted
// overlay row of the work's ids: an executed erasure covering the chat (or its
// fan, or the message's sender) at the deletion's instant skips it; the page's hot rows of the message are marked
// (`markFanslyWsHotDeletion`, sticky — also when a row was marked before, as
// the retired receipt reconcile did until step 4 S4-11; the engine inserts no
// hot row since step 4 S4-13, so the rows are the ones legacy stored, and their
// frozen copy never shows a deleted message as live); one deliverable
// `message.deleted` per message (dedup `msg-deleted:fansly:<id>`), and the
// archive tombstone from the stored events (tombstone-first, sticky: a
// later REST copy hydrates the stub and keeps the tombstone). Then the stored
// window of every thread whose archive holds one of the messages is recounted
// from the archive (`writeThreadSummaryAfterDeletion`, the only engine writer
// of those columns besides the read's, I9/E7; step 4 S4-08: the page's
// readers read the archive); its head stays the conversation list's, its
// chain is not touched.
//
// Lock order: sync_pages → erasure fence → page_dm_threads (FOR UPDATE, id
// order) → page_dm_messages → domain_event_seq → message_archive → sync_work
// (the recount updates thread rows locked at the start).

/** Overlay rows one overflowed step carries at most; a full batch that
 *  carried something keeps the work open for the rest. */
export const DM_LIVE_DELETIONS_OVERFLOW_BATCH = 1_000;

interface DeletedOverlayRow {
  messageId: string;
  groupId: string | null;
  /** The sender, when the socket showed the message before deleting it. */
  senderRef: string | null;
  deletedAt: Date;
  observationId: number;
}

interface HotRow {
  id: number;
  conversationId: number;
  marked: boolean;
}

function dateOf(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** The deleted overlay rows of the work's ids. */
async function deletedOverlayRows(tx: Database, pageId: number, ids: readonly string[]): Promise<DeletedOverlayRow[]> {
  if (ids.length === 0) return [];
  const result = await tx.execute<{
    platform_message_id: string;
    platform_conversation_id: string | null;
    sender_platform_user_id: string | null;
    deleted_at: Date | string;
    delete_observation_id: string;
  }>(sql`
    select platform_message_id, platform_conversation_id, sender_platform_user_id, deleted_at, delete_observation_id::text
      from dm_live_messages
     where page_id = ${pageId}
       and platform_message_id = any(${sql.param([...new Set(ids)])}::text[])
       and deleted_at is not null
     order by platform_message_id
  `);
  return result.rows.map((row) => ({
    messageId: row.platform_message_id,
    groupId: row.platform_conversation_id,
    senderRef: row.sender_platform_user_id,
    deletedAt: dateOf(row.deleted_at),
    observationId: Number(row.delete_observation_id),
  }));
}

/**
 * An overflowed work (more ids than the demand keeps): the subject chat's
 * deleted overlay rows (a frame without a chat: the rows without one) whose
 * deletion has not reached the archive (the store the page's readers read)
 * or the event ledger yet.
 */
async function overflowMessageIds(tx: Database, pageId: number, subject: string): Promise<string[]> {
  const chat = subject === ""
    ? sql`m.platform_conversation_id is null`
    : sql`m.platform_conversation_id = ${subject}`;
  const result = await tx.execute<{ id: string }>(sql`
    select m.platform_message_id as id
      from dm_live_messages m
     where m.page_id = ${pageId}
       and m.deleted_at is not null
       and ${chat}
       and (exists (select 1 from message_archive a
                     where a.account_id = m.page_id
                       and a.platform = 'fansly'
                       and a.message_ref = m.platform_message_id
                       and a.deleted_at is null)
            or not exists (select 1 from domain_event_keys k
                            where k.account_id = m.page_id
                              and k.dedup_key = 'msg-deleted:fansly:' || m.platform_message_id))
     order by m.platform_message_id
     limit ${DM_LIVE_DELETIONS_OVERFLOW_BATCH}
  `);
  return result.rows.map((row) => row.id);
}

/** The chats' fan refs (the thread's partner and its bound fan): a
 *  fan-scope erasure is keyed by them as well as by the chat. */
async function chatFanRefs(tx: Database, pageId: number, groupIds: readonly string[]): Promise<Map<string, string[]>> {
  const refs = new Map<string, string[]>();
  if (groupIds.length === 0) return refs;
  const result = await tx.execute<{ group_id: string; partner: string | null; fan: string | null }>(sql`
    select t.platform_conversation_id as group_id, t.partner_platform_user_id as partner, f.platform_user_id as fan
      from page_dm_threads t
      left join fans f on f.id = t.fan_id
     where t.platform_account_id = ${pageId}
       and t.platform_conversation_id = any(${sql.param([...new Set(groupIds)])}::text[])
  `);
  for (const row of result.rows) {
    const list = refs.get(row.group_id) ?? [];
    for (const ref of [row.partner, row.fan]) if (ref !== null && !list.includes(ref)) list.push(ref);
    refs.set(row.group_id, list);
  }
  return refs;
}

/** The page's hot rows of the messages, to mark: the rows legacy stored before
 *  the page went live (frozen since step 4 S4-13), so their snapshot never
 *  shows a deleted message as live. */
async function hotRowsOf(tx: Database, pageId: number, messageIds: readonly string[]): Promise<Map<string, HotRow[]>> {
  const rows = new Map<string, HotRow[]>();
  if (messageIds.length === 0) return rows;
  const result = await tx.execute<{ id: string; conversation_id: string; platform_message_id: string; marked: boolean }>(sql`
    select id::text, conversation_id::text, platform_message_id, deleted_at is not null as marked
      from page_dm_messages
     where platform_account_id = ${pageId}
       and platform_message_id = any(${sql.param([...new Set(messageIds)])}::text[])
     order by id
  `);
  for (const row of result.rows) {
    const list = rows.get(row.platform_message_id) ?? [];
    list.push({ id: Number(row.id), conversationId: Number(row.conversation_id), marked: row.marked });
    rows.set(row.platform_message_id, list);
  }
  return rows;
}

/** The threads whose archive holds one of the messages (in any state: the
 *  recount after the tombstones decides what is still stored), in id order. */
async function archiveThreadIdsOf(tx: Database, pageId: number, messageIds: readonly string[]): Promise<number[]> {
  if (messageIds.length === 0) return [];
  const result = await tx.execute<{ id: string }>(sql`
    select distinct t.id
      from message_archive a
      join page_dm_threads t
        on t.platform_account_id = a.account_id and t.platform_conversation_id = a.conversation_ref
     where a.account_id = ${pageId}
       and a.platform = 'fansly'
       and a.message_ref = any(${sql.param([...new Set(messageIds)])}::text[])
     order by t.id
  `);
  return result.rows.map((row) => Number(row.id));
}

/** Carry the work's deletions to the hot table, the event ledger and the
 *  archive (see the module header). */
export async function applyDmLiveDeletions(tx: Database, input: LocalApplyInput): Promise<ApplyResult> {
  const { pageId, work } = input;
  const overflow = work.demand.overflow === true;
  const ids = overflow ? await overflowMessageIds(tx, pageId, work.subject) : work.demand.messageIds;
  const deleted = await deletedOverlayRows(tx, pageId, ids);
  const counters: Record<string, number> = {};
  const bump = (name: string, by = 1) => {
    counters[name] = (counters[name] ?? 0) + by;
  };
  if (deleted.length < new Set(ids).size) bump("not_deleted_in_overlay", new Set(ids).size - deleted.length);

  const fanRefs = await chatFanRefs(tx, pageId, deleted.flatMap((row) => (row.groupId === null ? [] : [row.groupId])));
  const carried: DeletedOverlayRow[] = [];
  for (const row of deleted) {
    const refs = [
      ...(row.groupId === null ? [] : [row.groupId, ...(fanRefs.get(row.groupId) ?? [])]),
      ...(row.senderRef === null ? [] : [row.senderRef]),
    ];
    if (await isDmArchiveScopeFenced(tx, { pageId, platform: "fansly", refs, materialAt: row.deletedAt })) {
      bump("fenced");
      continue;
    }
    carried.push(row);
  }

  const carriedIds = carried.map((row) => row.messageId);
  const hot = await hotRowsOf(tx, pageId, carriedIds);
  const summaryThreadIds = await archiveThreadIdsOf(tx, pageId, carriedIds);
  const threadIds = [...new Set([...[...hot.values()].flat().map((row) => row.conversationId), ...summaryThreadIds])]
    .sort((a, b) => a - b);
  if (threadIds.length > 0) {
    // The DM apply holds a chat before its messages: so does this.
    await tx.execute(sql`
      select id from page_dm_threads where id = any(${sql.param(threadIds)}::bigint[]) order by id for update
    `);
  }
  for (const row of carried) {
    for (const target of hot.get(row.messageId) ?? []) {
      if (target.marked) {
        bump("hot_already_marked");
        continue;
      }
      if (await markFanslyWsHotDeletion(tx, { id: target.id, deletedAt: row.deletedAt })) bump("hot_marked");
    }
  }

  if (carried.length > 0) {
    const events: DomainEventInput[] = carried.map((row) => ({
      type: "message.deleted",
      occurredAt: row.deletedAt,
      conversationRef: row.groupId,
      messageRef: row.messageId,
      data: { source: "fansly_ws" },
      schemaVersion: 1,
      observationId: row.observationId,
      dedupKey: `msg-deleted:fansly:${row.messageId}`,
    }));
    const appended = await appendDomainEventsInTransaction(tx, pageId, events);
    bump("events_appended", appended.appended);
    // The stored rows of the keys, whoever appended them (a re-run, or the
    // same deletion carried before): tombstone-first and sticky.
    const stored = await listDomainEventsByDedupKeys(tx, pageId, events.map((event) => event.dedupKey));
    const archived = await applyMessageEventsToArchive(tx, { accountId: pageId, platform: "fansly", events: stored });
    bump("archive_tombstoned", archived.tombstoned);
  }
  // After the tombstones: the windows count what the archive still stores.
  for (const threadId of summaryThreadIds) await writeThreadSummaryAfterDeletion(tx, threadId);
  bump("windows_recomputed", summaryThreadIds.length);

  const more = overflow && ids.length >= DM_LIVE_DELETIONS_OVERFLOW_BATCH && carried.length > 0;
  return {
    work: more
      ? { satisfiesRevision: false, nextDueAt: input.now }
      : { satisfiesRevision: true, close: "done", closeReason: "ws_deletions_applied" },
    followups: [],
    counters,
  };
}

export const dmLiveDeletionsModule: ResourceModule = {
  async plan(_work, ctx) {
    if (ctx.shadow) return { kind: "done", reason: "shadow_no_writes" };
    return { kind: "local", reason: "ws_deletion" };
  },
  applyLocal: applyDmLiveDeletions,
  async apply() {
    throw new Error("dm-live.deletions makes no request: there is no answer to apply");
  },
  async shadow() {
    throw new Error("dm-live.deletions makes no request: there is no step to estimate");
  },
};
