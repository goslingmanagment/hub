import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

/**
 * The OnlyFans feed from the chat extension on OnlyMonster ChatSpace (0341;
 * apps/runtime services/client-onlyfans-feed.ts): the stores only it reads and
 * writes. Money itself goes through the transactions repository; here are the
 * sightings that claim a row, the platform's own lifetime sums of a fan, and
 * the chat list's unread count.
 */

export type OnlyfansFeedMoneySighting = "ws" | "ledger";

/** A transactions row a sighting may claim as the same purchase. */
export interface OnlyfansFeedMoneyCandidate {
  id: number;
  transactionId: string;
  source: string;
  canonicalType: string;
  grossAmountMills: bigint;
  occurredAt: Date;
  /** A sighting of the socket already claims it. */
  claimedByWs: boolean;
  /** A sighting of the ledger already claims it. */
  claimedByLedger: boolean;
}

/** The row a sighting key already claims, or null: a sighting is applied once. */
export async function findOnlyfansFeedMoneyClaim(
  db: Database,
  input: { pageId: number; feedKey: string },
): Promise<{ transactionRowId: number } | null> {
  const result = await db.execute<{ transaction_row_id: string }>(sql`
    select transaction_row_id::text
    from onlyfans_feed_money_claims
    where platform_account_id = ${input.pageId} and feed_key = ${input.feedKey}
  `);
  const row = result.rows[0];
  return row ? { transactionRowId: Number(row.transaction_row_id) } : null;
}

/**
 * The page's active positive rows of one fan, of exactly this gross amount,
 * inside [from, to]: what a sighting may claim. The fan is named by the hub's
 * fan row or by OnlyFans' id as a writer stored it.
 */
export async function listOnlyfansFeedMoneyCandidates(
  db: Database,
  input: { pageId: number; fanId: number | null; fanRef: string; grossAmountMills: bigint; from: Date; to: Date },
): Promise<OnlyfansFeedMoneyCandidate[]> {
  const result = await db.execute<{
    id: string;
    transaction_id: string;
    source: string;
    canonical_type: string;
    gross_amount_mills: string;
    occurred_at: Date | string;
    claimed_by_ws: boolean;
    claimed_by_ledger: boolean;
  }>(sql`
    select t.id::text, t.transaction_id, t.source, t.canonical_type::text,
           t.gross_amount_mills::text, t.occurred_at,
           exists (select 1 from onlyfans_feed_money_claims c
                   where c.transaction_row_id = t.id and c.sighting = 'ws') as claimed_by_ws,
           exists (select 1 from onlyfans_feed_money_claims c
                   where c.transaction_row_id = t.id and c.sighting = 'ledger') as claimed_by_ledger
    from transactions t
    where t.platform_account_id = ${input.pageId}
      and t.is_active
      and t.gross_amount_mills = ${input.grossAmountMills}
      and t.occurred_at between ${input.from} and ${input.to}
      and (${input.fanId === null ? sql`false` : sql`t.fan_id = ${input.fanId}`}
        or t.correlation_account_id = ${input.fanRef}
        or t.sender_id = ${input.fanRef})
    order by t.occurred_at, t.id
    limit 50
  `);
  return result.rows.map((row) => ({
    id: Number(row.id),
    transactionId: row.transaction_id,
    source: row.source,
    canonicalType: row.canonical_type,
    grossAmountMills: BigInt(row.gross_amount_mills),
    occurredAt: new Date(row.occurred_at),
    claimedByWs: row.claimed_by_ws,
    claimedByLedger: row.claimed_by_ledger,
  }));
}

/** The page's row with this transaction id, or null. */
export async function findOnlyfansFeedTransactionRow(
  db: Database,
  input: { pageId: number; transactionId: string },
): Promise<{ id: number; source: string; transactionId: string; isActive: boolean } | null> {
  const result = await db.execute<{ id: string; source: string; transaction_id: string; is_active: boolean }>(sql`
    select id::text, source, transaction_id, is_active
    from transactions
    where platform_account_id = ${input.pageId} and transaction_id = ${input.transactionId}
  `);
  const row = result.rows[0];
  return row ? { id: Number(row.id), source: row.source, transactionId: row.transaction_id, isActive: row.is_active } : null;
}

/** A sighting claims a row: false when the key or the row's slot for its kind is taken already. */
export async function insertOnlyfansFeedMoneyClaim(
  db: Database,
  input: { pageId: number; feedKey: string; sighting: OnlyfansFeedMoneySighting; transactionRowId: number; observationId: number | null },
): Promise<boolean> {
  const result = await db.execute(sql`
    insert into onlyfans_feed_money_claims (platform_account_id, feed_key, sighting, transaction_row_id, observation_id)
    values (${input.pageId}, ${input.feedKey}, ${input.sighting}, ${input.transactionRowId}, ${input.observationId})
    on conflict do nothing
    returning feed_key
  `);
  return result.rows.length > 0;
}

/**
 * The ledger's own figures replace the socket's estimate on the row the socket
 * wrote for the same purchase: its net and its status. Only a `chatspace:ws`
 * row is ever touched here.
 */
export async function refineOnlyfansFeedWsTransaction(
  db: Database,
  input: { rowId: number; creatorNetAmountMills: bigint; rawStatus: string; sourceObservationId: number | null },
): Promise<void> {
  await db.execute(sql`
    update transactions set
      creator_net_amount_mills = ${input.creatorNetAmountMills},
      raw_status = ${input.rawStatus},
      source_updated_at = now(),
      source_observation_id = coalesce(source_observation_id, ${input.sourceObservationId})
    where id = ${input.rowId} and source = 'chatspace:ws'
  `);
}

/** The fan's lifetime sums by type as OnlyFans counts them; an older reading never replaces a newer one. */
export async function setPageFanPlatformSpend(
  db: Database,
  input: { fanId: number; pageId: number; spend: Record<string, number | null>; observedAt: Date },
): Promise<void> {
  await db.execute(sql`
    update page_fans set
      platform_spend = ${JSON.stringify(input.spend)}::jsonb,
      platform_spend_observed_at = ${input.observedAt}
    where fan_id = ${input.fanId} and platform_account_id = ${input.pageId}
      and (platform_spend_observed_at is null or platform_spend_observed_at <= ${input.observedAt})
  `);
}

/**
 * The chat list's unread count of a chat, as OnlyFans counts it, on the chat
 * the hub holds: it wins over the count the live messages kept (as the REST
 * chat-list reconcile's does). A chat the hub does not hold yet is left alone:
 * its last message makes it.
 */
export async function setPageDmConversationUnreadCount(
  db: Database,
  input: { pageId: number; fanRef: string; unreadCount: number },
): Promise<boolean> {
  const result = await db.execute(sql`
    update page_dm_threads set
      unread_count = ${input.unreadCount},
      last_unread_message_id = case when ${input.unreadCount} = 0 then null else last_unread_message_id end,
      updated_at = now()
    where platform_account_id = ${input.pageId}
      and platform_conversation_id = ${input.fanRef}
      and unread_count is distinct from ${input.unreadCount}
    returning id
  `);
  return result.rows.length > 0;
}

/** The transaction id of a row of the page, or null. */
export async function getOnlyfansFeedTransactionId(db: Database, rowId: number): Promise<string | null> {
  const result = await db.execute<{ transaction_id: string }>(sql`
    select transaction_id from transactions where id = ${rowId}
  `);
  return result.rows[0]?.transaction_id ?? null;
}

/**
 * The page's transactions writer becomes `chatspace` (the OnlyFans feed's
 * cutoff): the writer before it, or null when the page is not an OnlyFans page.
 */
export async function setOnlyfansFeedTransactionsWriter(
  db: Database,
  pageId: number,
): Promise<{ previousWriter: string | null } | null> {
  const result = await db.execute<{ previous_writer: string | null }>(sql`
    update pages p set transactions_writer = 'chatspace'
    from (select id, transactions_writer from pages where id = ${pageId} for update) before
    where p.id = before.id and p.platform = 'onlyfans'
    returning before.transactions_writer as previous_writer
  `);
  const row = result.rows[0];
  return row ? { previousWriter: row.previous_writer } : null;
}

/** The feed's money records of a page journaled since a time, oldest first, a page at a time. */
export async function listOnlyfansFeedMoneyObservations(
  db: Database,
  input: { pageId: number; since: Date; after: { receivedAt: Date; id: number } | null; limit: number },
): Promise<Array<{ id: number; receivedAt: Date; payload: unknown }>> {
  const result = await db.execute<{ id: string; received_at: Date | string; payload: unknown }>(sql`
    select id::text, received_at, payload
    from observations
    where source = 'client_capture'
      and kind = 'client.onlyfans_feed.v1'
      and account_id = ${input.pageId}
      and received_at >= ${input.since}
      and payload -> 'record' ->> 'kind' in ('ppv', 'tip', 'ledger')
      ${input.after === null ? sql`` : sql`and (received_at, id) > (${input.after.receivedAt}, ${input.after.id})`}
    order by received_at, id
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({ id: Number(row.id), receivedAt: new Date(row.received_at), payload: row.payload }));
}

export interface OnlyfansFeedPollLease {
  granted: boolean;
  holder: "server" | "tab" | null;
  nextAt: Date;
  cursors: { subscribers: string | null; ledger: string | null };
}

/**
 * The page's poll, asked for by `userId` at `now` (0342): the agency's always-on tab (`server`) while it asked within
 * `serverHoldMs`, else the first that asks once `nextAt` passed; granted — the next one comes `everyMs` later. One
 * row a page, locked for the decision.
 */
export async function takeOnlyfansFeedPoll(
  db: Database,
  input: { pageId: number; userId: number; server: boolean; now: Date; everyMs: number; serverHoldMs: number },
): Promise<OnlyfansFeedPollLease> {
  await db.execute(sql`
    insert into onlyfans_feed_poll_leases (platform_account_id, next_at) values (${input.pageId}, ${input.now})
    on conflict (platform_account_id) do nothing
  `);
  const [row] = (await db.execute<{
    user_id: string | null; server: boolean; next_at: Date | string; server_seen_at: Date | string | null;
    subscribers_cursor: string | null; ledger_cursor: string | null;
  }>(sql`
    select user_id::text, server, next_at, server_seen_at, subscribers_cursor, ledger_cursor
    from onlyfans_feed_poll_leases where platform_account_id = ${input.pageId} for update
  `)).rows;
  const nextAt = new Date(row!.next_at);
  const serverSeen = row!.server_seen_at === null ? null : new Date(row!.server_seen_at);
  const serverPresent = serverSeen !== null && input.now.getTime() - serverSeen.getTime() <= input.serverHoldMs;
  const due = input.now.getTime() >= nextAt.getTime();
  const granted = due && (input.server || !serverPresent);
  const cursors = { subscribers: row!.subscribers_cursor, ledger: row!.ledger_cursor };
  if (!granted) {
    if (input.server) {
      await db.execute(sql`update onlyfans_feed_poll_leases set server_seen_at = ${input.now}, updated_at = now() where platform_account_id = ${input.pageId}`);
    }
    return { granted: false, holder: row!.user_id === null ? null : row!.server ? "server" : "tab", nextAt, cursors };
  }
  const next = new Date(input.now.getTime() + input.everyMs);
  await db.execute(sql`
    update onlyfans_feed_poll_leases set
      user_id = ${input.userId}, server = ${input.server}, granted_at = ${input.now}, next_at = ${next},
      server_seen_at = case when ${input.server} then ${input.now} else server_seen_at end,
      updated_at = now()
    where platform_account_id = ${input.pageId}
  `);
  return { granted: true, holder: input.server ? "server" : "tab", nextAt: next, cursors };
}

/** The newest item of a list the feed brought moves forward, by the item's own time; an older one changes nothing. */
export async function advanceOnlyfansFeedPollCursor(
  db: Database,
  input: { pageId: number; list: "subscribers" | "ledger"; ref: string; at: Date },
): Promise<void> {
  const column = input.list === "subscribers" ? sql.raw("subscribers_cursor") : sql.raw("ledger_cursor");
  const columnAt = input.list === "subscribers" ? sql.raw("subscribers_cursor_at") : sql.raw("ledger_cursor_at");
  await db.execute(sql`
    insert into onlyfans_feed_poll_leases (platform_account_id, ${column}, ${columnAt}) values (${input.pageId}, ${input.ref}, ${input.at})
    on conflict (platform_account_id) do update set ${column} = excluded.${column}, ${columnAt} = excluded.${columnAt}, updated_at = now()
    where onlyfans_feed_poll_leases.${columnAt} is null or onlyfans_feed_poll_leases.${columnAt} < excluded.${columnAt}
  `);
}
