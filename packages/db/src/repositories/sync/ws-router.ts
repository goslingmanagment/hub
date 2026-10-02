import { sql } from "drizzle-orm";
import { FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY } from "@agency_hub_core/shared";

import type { Database } from "../../client.ts";
import { capturePayloadRefFromColumns, type CapturePayloadRef } from "../capture-payloads.ts";
import type { SyncPageMode } from "./pages.ts";
import { textArrayParam } from "./values.ts";

// Fansly Sync Engine: the reads of the WebSocket demand router (design §6).
// The router turns a captured socket frame into work; these are the facts it
// needs about the page — its mode, the threads a frame names, whether a
// settled transaction is one the ledger still holds as pending, how many own
// messages became visible a moment ago — and, for a page in shadow, the
// captured receipts past its router cursor. Reads only: the router's writes
// are `upsertDemand` (sync_work) and `advanceWsRouterCursor` (sync_pages).

/** What the post-ack hook reads about the page of a receipt (no lock). */
export interface WsRoutePage {
  mode: SyncPageMode;
  registryOverrides: Record<string, unknown>;
}

/** The page's mode and overrides, or null when the page has no engine row
 *  (a Fansly page created after 0228 and not yet seen by the host). */
export async function readWsRoutePage(db: Database, pageId: number): Promise<WsRoutePage | null> {
  const result = await db.execute<{ mode: SyncPageMode; registryOverrides: Record<string, unknown> | null }>(sql`
    select mode, registry_overrides as "registryOverrides" from sync_pages where page_id = ${pageId}
  `);
  const row = result.rows[0];
  return row ? { mode: row.mode, registryOverrides: row.registryOverrides ?? {} } : null;
}

/** A thread a frame names, as the router judges it (design §6.2). */
export interface WsRouteThread {
  groupId: string;
  threadId: number;
  /** Bound to a fan (`fan_id`): only bound threads get message reads. */
  bound: boolean;
  /** Excluded from message sync (decision №8): the overlay shows it, nothing reads it. */
  excluded: boolean;
  /** The newest message REST confirmed in the thread's chain (0231). */
  headConfirmedId: string | null;
}

/** The page's threads among `groupIds` (unknown groups are absent). */
export async function loadWsRouteThreads(
  db: Database,
  input: { pageId: number; groupIds: readonly string[] },
): Promise<Map<string, WsRouteThread>> {
  const threads = new Map<string, WsRouteThread>();
  if (input.groupIds.length === 0) return threads;
  const result = await db.execute<{
    id: string;
    groupId: string;
    bound: boolean;
    excluded: boolean;
    headConfirmedId: string | null;
  }>(sql`
    select t.id::text as id,
           t.platform_conversation_id as "groupId",
           t.fan_id is not null as bound,
           coalesce(t.metadata ->> ${FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY}::text, '') <> '' as excluded,
           t.head_confirmed_id as "headConfirmedId"
      from page_dm_threads t
     where t.platform_account_id = ${input.pageId}
       and t.platform_conversation_id = any(${textArrayParam([...new Set(input.groupIds)])})
  `);
  for (const row of result.rows) {
    threads.set(row.groupId, {
      groupId: row.groupId,
      threadId: Number(row.id),
      bound: row.bound === true,
      excluded: row.excluded === true,
      headConfirmedId: row.headConfirmedId,
    });
  }
  return threads;
}

/** The ids among `transactionIds` the page's ledger holds as pending (a
 *  settlement frame of one of them makes the pending window due). */
export async function listKnownPendingTransactionIds(
  db: Database,
  input: { pageId: number; transactionIds: readonly string[] },
): Promise<Set<string>> {
  if (input.transactionIds.length === 0) return new Set();
  const result = await db.execute<{ transactionId: string }>(sql`
    select transaction_id as "transactionId"
      from transactions
     where platform_account_id = ${input.pageId}
       and transaction_id = any(${textArrayParam([...new Set(input.transactionIds)])})
       and transaction_state = 'pending'::transaction_state
  `);
  return new Set(result.rows.map((row) => row.transactionId));
}

/**
 * Distinct chats in which an own message of the page became visible within
 * the last `windowMs` (the overlay, design §6.2 broadcast fallback; served by
 * `dm_live_messages_first_visible`). Inside the post-ack hook the frame's own
 * overlay rows are already written, so they count.
 */
export async function countRecentOwnLiveChats(
  db: Database,
  input: { pageId: number; windowMs: number },
): Promise<number> {
  const result = await db.execute<{ n: string }>(sql`
    select count(distinct platform_conversation_id)::text as n
      from dm_live_messages
     where page_id = ${input.pageId}
       and is_sent_by_page
       and first_visible_at > clock_timestamp() - ${input.windowMs}::double precision * interval '1 millisecond'
  `);
  return Number(result.rows[0]?.n ?? 0);
}

/** One captured receipt past the shadow router's cursor. */
export interface WsRouterReceipt {
  observationId: number;
  receivedAt: Date;
  /** The page's own Fansly account id the frame was captured under. */
  ownRef: string | null;
  /** Older than the routing horizon: passed over, its body not read. */
  stale: boolean;
  /** The raw observation is gone (erased, tiered away). */
  missing: boolean;
  payload: unknown;
  payloadRef: CapturePayloadRef | null;
}

/**
 * The page's captured receipts after `after` (observation id order, at most
 * `limit`), whatever their live state: the shadow router reads, it never
 * acks. The observation is joined on its partition key, as the live apply
 * does; a receipt received more than `horizonMs` ago comes back `stale`
 * without its body.
 */
export async function listWsRouterReceipts(
  db: Database,
  input: { pageId: number; after: number; limit: number; horizonMs: number },
): Promise<WsRouterReceipt[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) throw new Error(`limit must be positive, received ${input.limit}`);
  const result = await db.execute<{
    observationId: string;
    receivedAt: Date | string;
    stale: boolean;
    found: boolean;
    ownRef: string | null;
    payload: unknown;
    bucket: string | null;
    objectId: string | null;
  }>(sql`
    select r.observation_id::text as "observationId",
           r.received_at as "receivedAt",
           r.received_at <= clock_timestamp() - ${input.horizonMs}::double precision * interval '1 millisecond' as stale,
           o.id is not null as found,
           o.native_account_ref as "ownRef",
           case when r.received_at > clock_timestamp() - ${input.horizonMs}::double precision * interval '1 millisecond'
             then o.payload end as payload,
           to_char(o.payload_bucket_month, 'YYYY-MM-DD') as bucket,
           o.payload_object_id::text as "objectId"
      from fansly_ws_decode_receipts r
      left join observations o on o.id = r.observation_id and o.received_at = r.received_at
     where r.page_id = ${input.pageId}
       and r.observation_id > ${input.after}::bigint
     order by r.observation_id
     limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    observationId: Number(row.observationId),
    receivedAt: new Date(row.receivedAt),
    ownRef: row.ownRef,
    stale: row.stale === true,
    missing: row.found !== true,
    payload: row.payload,
    payloadRef: capturePayloadRefFromColumns(row.bucket, row.objectId),
  }));
}

/**
 * Where a shadow router that never ran starts: the page's newest receipt
 * received more than `horizonMs` ago (0 without one). Everything captured
 * before that is history, never demand; the receipts of the horizon are
 * routed. One scan of the page's receipts, once per page.
 */
export async function wsRouterStartCursor(
  db: Database,
  input: { pageId: number; horizonMs: number },
): Promise<number> {
  const result = await db.execute<{ id: string | null }>(sql`
    select max(observation_id)::text as id
      from fansly_ws_decode_receipts
     where page_id = ${input.pageId}
       and received_at <= clock_timestamp() - ${input.horizonMs}::double precision * interval '1 millisecond'
  `);
  return Number(result.rows[0]?.id ?? 0);
}
