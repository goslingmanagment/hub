import { sql } from "drizzle-orm";

import {
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
  type FanslyDmMessageSyncExcludedReason,
} from "@agency_hub_core/shared";

import type { Database } from "../../client.ts";
import { addSyncPageLiftedDmExclusion, removeSyncPageLiftedDmExclusion, type SyncPageMode } from "./pages.ts";
import { textArrayParam, toDate } from "./values.ts";

// Owner decision №8 (plan §9а, step-3 design S3-06): the chats the legacy
// engine excluded from message sync (`page_dm_threads.metadata.
// messageSyncExcludedReason`) are probed on a live page, and where the API
// serves them the owner lifts the exclusion PER PAGE (`sync_pages.
// lifted_dm_exclusions`, 0235): the lift clears the reason from the page's
// bound threads in the same transaction, and the engine's conversation list no
// longer assigns a lifted reason to a bound thread. An unbound thread keeps
// its reason — the engine reads no unbound chat either way — until something
// binds its fan. `unlift` only takes the reason off the page's list: the next
// list pass assigns it again.

/** The reasons a page can lift (the 0235 CHECK). Nothing assigns the
 *  unresolvable one any more (arena "vanished chat", R4: a lookup miss excludes
 *  no chat); it stays for the rows and recorded probes written before. */
export const SYNC_LIFTABLE_DM_EXCLUSIONS = [
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_MISSING_FROM_AGGREGATION_ACCOUNTS,
  FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_PARTNER_UNRESOLVABLE_FROM_ACCOUNT_LOOKUP,
] as const satisfies readonly FanslyDmMessageSyncExcludedReason[];

export function isLiftableDmExclusion(value: string): value is FanslyDmMessageSyncExcludedReason {
  return (SYNC_LIFTABLE_DM_EXCLUSIONS as readonly string[]).includes(value);
}

/** One chat of a page excluded for a reason, as the probe samples it. */
export interface ExcludedDmThreadSample {
  threadId: number;
  platformConversationId: string;
  fanId: number;
  lastMessageAt: Date | null;
}

/**
 * The probe's sample (design S3-06 item 3): the page's bound, visible chats
 * excluded for `reason`, the most recently active first. An unbound chat is
 * never sampled — a lift would not apply to it.
 */
export async function sampleExcludedDmThreads(
  db: Database,
  input: { pageId: number; reason: FanslyDmMessageSyncExcludedReason; limit: number },
): Promise<ExcludedDmThreadSample[]> {
  const result = await db.execute<{
    threadId: string;
    platformConversationId: string;
    fanId: string;
    lastMessageAt: Date | string | null;
  }>(sql`
    select t.id::text as "threadId", t.platform_conversation_id as "platformConversationId",
           t.fan_id::text as "fanId", t.last_message_at as "lastMessageAt"
      from page_dm_threads t
     where t.platform_account_id = ${input.pageId}
       and t.fan_id is not null
       and t.is_visible
       and t.metadata ->> ${FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY}::text = ${input.reason}
     order by t.last_message_at desc nulls last, t.id desc
     limit ${Math.max(0, Math.trunc(input.limit))}
  `);
  return result.rows.map((row) => ({
    threadId: Number(row.threadId),
    platformConversationId: row.platformConversationId,
    fanId: Number(row.fanId),
    lastMessageAt: toDate(row.lastMessageAt),
  }));
}

/** How many of a page's threads carry `reason`: bound (a lift clears them) and unbound (kept). */
export async function countExcludedDmThreads(
  db: Database,
  input: { pageId: number; reason: FanslyDmMessageSyncExcludedReason },
): Promise<{ bound: number; unbound: number }> {
  const result = await db.execute<{ bound: number | string; unbound: number | string }>(sql`
    select count(*) filter (where t.fan_id is not null)::int as bound,
           count(*) filter (where t.fan_id is null)::int as unbound
      from page_dm_threads t
     where t.platform_account_id = ${input.pageId}
       and t.metadata ->> ${FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY}::text = ${input.reason}
  `);
  const row = result.rows[0];
  return { bound: Number(row?.bound ?? 0), unbound: Number(row?.unbound ?? 0) };
}

export type LiftSyncDmExclusionResult =
  | {
    kind: "lifted";
    /** The reason was not on the page's list before. */
    added: boolean;
    /** The page's list after the lift. */
    lifted: string[];
    /** Bound threads whose reason this lift cleared. */
    threadsLifted: number;
    /** Unbound threads of the reason, left excluded. */
    unboundKept: number;
  }
  /** The page is not live (or has no sync_pages row): nothing written. */
  | { kind: "not_live"; mode: SyncPageMode | null };

/**
 * Lift one exclusion reason on a live page (`sync excluded lift`): the page's
 * list gains the reason (idempotent) and the page's bound threads lose it, in
 * the caller's transaction. Lock order: the `sync_pages` row first (it waits
 * for an apply of the page's actor in flight, so the next list apply reads
 * the new list), then the threads.
 */
export async function liftSyncDmExclusion(
  db: Database,
  input: { pageId: number; reason: FanslyDmMessageSyncExcludedReason },
): Promise<LiftSyncDmExclusionResult> {
  if (!isLiftableDmExclusion(input.reason)) throw new Error(`Not a liftable DM exclusion: ${input.reason}`);
  const page = await addSyncPageLiftedDmExclusion(db, input);
  if (page === null) return { kind: "not_live", mode: await readMode(db, input.pageId) };
  const threads = await db.execute<{ id: string }>(sql`
    update page_dm_threads t
       set metadata = t.metadata - ${FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY}::text,
           updated_at = clock_timestamp()
     where t.platform_account_id = ${input.pageId}
       and t.fan_id is not null
       and t.metadata ->> ${FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY}::text = ${input.reason}
    returning t.id::text as id
  `);
  const kept = await countExcludedDmThreads(db, input);
  return {
    kind: "lifted",
    added: page.added,
    lifted: page.lifted,
    threadsLifted: threads.rows.length,
    unboundKept: kept.unbound,
  };
}

/**
 * Take a reason off a page's lifted list (`sync excluded unlift`), in any
 * mode. The threads are not touched: the page's next conversation list pass
 * assigns the reason again. Null: the page has no sync_pages row.
 */
export async function unliftSyncDmExclusion(
  db: Database,
  input: { pageId: number; reason: FanslyDmMessageSyncExcludedReason },
): Promise<{ removed: boolean; lifted: string[]; mode: SyncPageMode } | null> {
  if (!isLiftableDmExclusion(input.reason)) throw new Error(`Not a liftable DM exclusion: ${input.reason}`);
  return removeSyncPageLiftedDmExclusion(db, input);
}

/**
 * How many of `messageIds` (a probe's page of one chat) the socket overlay
 * showed first (`dm_live_messages`): the probe's evidence that what the API
 * serves is the chat the socket saw.
 */
export async function countDmLiveMessagesOfChat(
  db: Database,
  input: { pageId: number; platformConversationId: string; messageIds: readonly string[] },
): Promise<number> {
  const ids = [...new Set(input.messageIds)];
  if (ids.length === 0) return 0;
  const result = await db.execute<{ n: number | string }>(sql`
    select count(*)::int as n
      from dm_live_messages l
     where l.page_id = ${input.pageId}
       and l.platform_conversation_id = ${input.platformConversationId}
       and l.platform_message_id = any(${textArrayParam(ids)})
  `);
  return Number(result.rows[0]?.n ?? 0);
}

async function readMode(db: Database, pageId: number): Promise<SyncPageMode | null> {
  const result = await db.execute<{ mode: SyncPageMode }>(sql`select mode from sync_pages where page_id = ${pageId}`);
  return result.rows[0]?.mode ?? null;
}
