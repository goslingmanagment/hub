import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../../client.ts";
import { witnessFor, type PlaneReadWitness } from "../agent-read-witness.ts";
import { effectiveHistoryStateSql, type ThreadHistoryState } from "./thread-chain.ts";
import { HISTORY_ITEM_OPEN_STATES } from "./work.ts";
import { jsonParam, nullableJsonParam, textArrayParam, timestampParam, toDate, toNumber, toRequiredDate } from "./values.ts";

// Fansly Sync Engine history requests (plan §4; design §2.5, §7.1): who asked
// for which chats' history, to what depth, and how far each fan got. Progress
// is never stored twice: the chain columns of page_dm_threads (0231) and the
// shared `dm-messages.history` work are the facts; these rows hold what only
// the request knows (inputs, refusals, anchors, reads spent, terminal
// counters).
//
// Lock order (design §3.7): … → page_dm_threads → sync_work →
// history_requests → history_request_items. Every writer here runs after the
// transaction's sync_work rows are locked, and locks request rows before item
// rows (`lockRequestsOfOpenItems`). A new item references its chat (FK, a key
// share on the thread row), so intake takes its chats before any sync_work
// row (`lockThreadsForHistoryItems`): a DM apply holds the chat it writes
// before the works it settles.

export const HISTORY_REQUESTER_KINDS = [
  "agent_key",
  "owner_session",
  "owner_cli",
  "legacy_hydration_wrapper",
  "switch_migration",
] as const;
export type HistoryRequesterKind = (typeof HISTORY_REQUESTER_KINDS)[number];

export const HISTORY_DEPTH_KINDS = ["all", "latest", "before_boundary"] as const;
export type HistoryDepthKind = (typeof HISTORY_DEPTH_KINDS)[number];

export const HISTORY_REQUEST_STATES = ["open", "done", "cancelled"] as const;
export type HistoryRequestState = (typeof HISTORY_REQUEST_STATES)[number];

export const HISTORY_INPUT_KINDS = ["fan_platform_user_id", "conversation_ref", "chat_url"] as const;
export type HistoryInputKind = (typeof HISTORY_INPUT_KINDS)[number];

export const HISTORY_ITEM_STATES = ["refused", "queued", "loading", "ready", "blocked", "cancelled"] as const;
export type HistoryItemState = (typeof HISTORY_ITEM_STATES)[number];
export type HistoryItemOpenState = (typeof HISTORY_ITEM_OPEN_STATES)[number];

export const HISTORY_ITEM_REFUSALS = ["not_found", "excluded", "page_erased", "duplicate"] as const;
export type HistoryItemRefusal = (typeof HISTORY_ITEM_REFUSALS)[number];

export const HISTORY_ITEM_SATISFIED_BY = ["empty_page", "latest_n", "boundary", "already_satisfied"] as const;
export type HistoryItemSatisfiedBy = (typeof HISTORY_ITEM_SATISFIED_BY)[number];

/** The registry key of the shared per-chat work every item rides on. */
export const HISTORY_WORK_RESOURCE = "dm-messages.history";

/** Limits of one request (plan §4.1). */
export const HISTORY_REQUEST_MAX_ITEMS = 1_000;
export const HISTORY_REQUEST_MAX_REASON = 1_000;
export const HISTORY_REQUEST_MAX_LATEST = 1_000_000;
export const HISTORY_INPUT_MAX_LENGTH = 300;

export type HistoryDepth =
  | { kind: "all" }
  | { kind: "latest"; count: number }
  | { kind: "before_boundary"; at: Date | null; messageRef: string | null };

export interface HistoryRequestRow {
  id: number;
  ref: string;
  pageId: number;
  pageLabel: string | null;
  requesterKind: HistoryRequesterKind;
  requesterAgentKeyId: number | null;
  requesterUserId: number | null;
  idempotencyKey: string;
  fingerprint: string;
  depth: HistoryDepth;
  reasonSha256: string;
  reasonLength: number;
  state: HistoryRequestState;
  itemsTotal: number;
  itemsTerminal: number;
  estimateAtSubmit: Record<string, unknown>;
  lastServedAt: Date | null;
  legacyHydrationRequestId: number | null;
  createdAt: Date;
  doneAt: Date | null;
  cancelledAt: Date | null;
  cancelReasonSha256: string | null;
  updatedAt: Date;
}

export interface HistoryItemAnchor {
  messageId: string;
  fixedAt: Date;
  upwardCount: number;
  chainEpoch: number;
}

export interface HistoryItemRow {
  id: number;
  requestId: number;
  pageId: number;
  ordinal: number;
  inputKind: HistoryInputKind;
  inputRef: string;
  fanPlatformUserId: string | null;
  fanId: number | null;
  threadId: number | null;
  conversationRef: string | null;
  state: HistoryItemState;
  refusal: HistoryItemRefusal | null;
  excludedReason: string | null;
  workId: number | null;
  anchor: HistoryItemAnchor | null;
  estimateReadsMin: number | null;
  estimateReads: number | null;
  readsSpent: number;
  lastServedAt: Date | null;
  satisfiedAt: Date | null;
  satisfiedBy: HistoryItemSatisfiedBy | null;
  satisfiedOldestId: string | null;
  satisfiedCount: number | null;
  final: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

/** An open item with what its request asks (the satisfaction rules read it). */
export interface OpenHistoryItem extends HistoryItemRow {
  depth: HistoryDepth;
  requestCreatedAt: Date;
}

type RequestSqlRow = {
  id: string;
  ref: string;
  pageId: string;
  pageLabel: string | null;
  requesterKind: HistoryRequesterKind;
  requesterAgentKeyId: string | null;
  requesterUserId: string | null;
  idempotencyKey: string;
  fingerprint: string;
  depthKind: HistoryDepthKind;
  depthN: number | null;
  depthBoundaryAt: Date | string | null;
  depthBoundaryMessageRef: string | null;
  reasonSha256: string;
  reasonLength: number;
  state: HistoryRequestState;
  itemsTotal: number;
  itemsTerminal: number;
  estimateAtSubmit: Record<string, unknown> | null;
  lastServedAt: Date | string | null;
  legacyHydrationRequestId: string | null;
  createdAt: Date | string;
  doneAt: Date | string | null;
  cancelledAt: Date | string | null;
  cancelReasonSha256: string | null;
  updatedAt: Date | string;
};

const requestColumns = sql`
  r.id::text as id,
  r.request_ref::text as ref,
  r.page_id::text as "pageId",
  p.label as "pageLabel",
  r.requester_kind as "requesterKind",
  r.requester_agent_key_id::text as "requesterAgentKeyId",
  r.requester_user_id::text as "requesterUserId",
  r.idempotency_key::text as "idempotencyKey",
  r.request_fingerprint as fingerprint,
  r.depth_kind as "depthKind",
  r.depth_n as "depthN",
  r.depth_boundary_at as "depthBoundaryAt",
  r.depth_boundary_message_ref as "depthBoundaryMessageRef",
  r.reason_sha256 as "reasonSha256",
  r.reason_length as "reasonLength",
  r.state,
  r.items_total as "itemsTotal",
  r.items_terminal as "itemsTerminal",
  r.estimate_at_submit as "estimateAtSubmit",
  r.last_served_at as "lastServedAt",
  r.legacy_hydration_request_id::text as "legacyHydrationRequestId",
  r.created_at as "createdAt",
  r.done_at as "doneAt",
  r.cancelled_at as "cancelledAt",
  r.cancel_reason_sha256 as "cancelReasonSha256",
  r.updated_at as "updatedAt"
`;

function depthOf(row: { depthKind: HistoryDepthKind; depthN: number | null; depthBoundaryAt: Date | string | null; depthBoundaryMessageRef: string | null }): HistoryDepth {
  switch (row.depthKind) {
    case "all":
      return { kind: "all" };
    case "latest":
      return { kind: "latest", count: Number(row.depthN) };
    case "before_boundary":
      return { kind: "before_boundary", at: toDate(row.depthBoundaryAt), messageRef: row.depthBoundaryMessageRef };
  }
}

function normalizeRequestRow(row: RequestSqlRow): HistoryRequestRow {
  return {
    id: Number(row.id),
    ref: row.ref,
    pageId: Number(row.pageId),
    pageLabel: row.pageLabel,
    requesterKind: row.requesterKind,
    requesterAgentKeyId: toNumber(row.requesterAgentKeyId),
    requesterUserId: toNumber(row.requesterUserId),
    idempotencyKey: row.idempotencyKey,
    fingerprint: row.fingerprint,
    depth: depthOf(row),
    reasonSha256: row.reasonSha256,
    reasonLength: Number(row.reasonLength),
    state: row.state,
    itemsTotal: Number(row.itemsTotal),
    itemsTerminal: Number(row.itemsTerminal),
    estimateAtSubmit: row.estimateAtSubmit ?? {},
    lastServedAt: toDate(row.lastServedAt),
    legacyHydrationRequestId: toNumber(row.legacyHydrationRequestId),
    createdAt: toRequiredDate(row.createdAt),
    doneAt: toDate(row.doneAt),
    cancelledAt: toDate(row.cancelledAt),
    cancelReasonSha256: row.cancelReasonSha256,
    updatedAt: toRequiredDate(row.updatedAt),
  };
}

type ItemSqlRow = {
  id: string;
  requestId: string;
  pageId: string;
  ordinal: number;
  inputKind: HistoryInputKind;
  inputRef: string;
  fanPlatformUserId: string | null;
  fanId: string | null;
  threadId: string | null;
  conversationRef: string | null;
  state: HistoryItemState;
  refusal: HistoryItemRefusal | null;
  excludedReason: string | null;
  workId: string | null;
  anchorMessageId: string | null;
  anchorFixedAt: Date | string | null;
  anchorUpwardCount: string | null;
  anchorChainEpoch: number | null;
  estimateReadsMin: number | null;
  estimateReads: number | null;
  readsSpent: number;
  lastServedAt: Date | string | null;
  satisfiedAt: Date | string | null;
  satisfiedBy: HistoryItemSatisfiedBy | null;
  satisfiedOldestId: string | null;
  satisfiedCount: number | null;
  final: Record<string, unknown> | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

const itemColumns = sql`
  i.id::text as id,
  i.request_id::text as "requestId",
  i.page_id::text as "pageId",
  i.ordinal,
  i.input_kind as "inputKind",
  i.input_ref as "inputRef",
  i.fan_platform_user_id as "fanPlatformUserId",
  i.fan_id::text as "fanId",
  i.thread_id::text as "threadId",
  i.conversation_ref as "conversationRef",
  i.state,
  i.refusal,
  i.excluded_reason as "excludedReason",
  i.work_id::text as "workId",
  i.anchor_message_id as "anchorMessageId",
  i.anchor_fixed_at as "anchorFixedAt",
  i.anchor_upward_count::text as "anchorUpwardCount",
  i.anchor_chain_epoch as "anchorChainEpoch",
  i.estimate_reads_min as "estimateReadsMin",
  i.estimate_reads as "estimateReads",
  i.reads_spent as "readsSpent",
  i.last_served_at as "lastServedAt",
  i.satisfied_at as "satisfiedAt",
  i.satisfied_by as "satisfiedBy",
  i.satisfied_oldest_id as "satisfiedOldestId",
  i.satisfied_count as "satisfiedCount",
  i.final,
  i.created_at as "createdAt",
  i.updated_at as "updatedAt"
`;

function normalizeItemRow(row: ItemSqlRow): HistoryItemRow {
  const anchorFixedAt = toDate(row.anchorFixedAt);
  return {
    id: Number(row.id),
    requestId: Number(row.requestId),
    pageId: Number(row.pageId),
    ordinal: Number(row.ordinal),
    inputKind: row.inputKind,
    inputRef: row.inputRef,
    fanPlatformUserId: row.fanPlatformUserId,
    fanId: toNumber(row.fanId),
    threadId: toNumber(row.threadId),
    conversationRef: row.conversationRef,
    state: row.state,
    refusal: row.refusal,
    excludedReason: row.excludedReason,
    workId: toNumber(row.workId),
    anchor: row.anchorMessageId !== null && anchorFixedAt !== null && row.anchorUpwardCount !== null && row.anchorChainEpoch !== null
      ? {
        messageId: row.anchorMessageId,
        fixedAt: anchorFixedAt,
        upwardCount: Number(row.anchorUpwardCount),
        chainEpoch: Number(row.anchorChainEpoch),
      }
      : null,
    estimateReadsMin: toNumber(row.estimateReadsMin),
    estimateReads: toNumber(row.estimateReads),
    readsSpent: Number(row.readsSpent),
    lastServedAt: toDate(row.lastServedAt),
    satisfiedAt: toDate(row.satisfiedAt),
    satisfiedBy: row.satisfiedBy,
    satisfiedOldestId: row.satisfiedOldestId,
    satisfiedCount: toNumber(row.satisfiedCount),
    final: row.final,
    createdAt: toRequiredDate(row.createdAt),
    updatedAt: toRequiredDate(row.updatedAt),
  };
}

type OpenItemSqlRow = ItemSqlRow & {
  depthKind: HistoryDepthKind;
  depthN: number | null;
  depthBoundaryAt: Date | string | null;
  depthBoundaryMessageRef: string | null;
  requestCreatedAt: Date | string;
};

function normalizeOpenItemRow(row: OpenItemSqlRow): OpenHistoryItem {
  return { ...normalizeItemRow(row), depth: depthOf(row), requestCreatedAt: toRequiredDate(row.requestCreatedAt) };
}

const openItemColumns = sql`${itemColumns},
  r.depth_kind as "depthKind",
  r.depth_n as "depthN",
  r.depth_boundary_at as "depthBoundaryAt",
  r.depth_boundary_message_ref as "depthBoundaryMessageRef",
  r.created_at as "requestCreatedAt"`;

const OPEN_STATES = sql.raw(`(${HISTORY_ITEM_OPEN_STATES.map((state) => `'${state}'`).join(", ")})`);

function idsParam(ids: readonly number[]): SQL {
  return sql`${sql.param([...new Set(ids)].map(String))}::bigint[]`;
}

// ── requests ──────────────────────────────────────────────────────────────────

export interface InsertHistoryRequestInput {
  pageId: number;
  requesterKind: HistoryRequesterKind;
  requesterAgentKeyId: number | null;
  requesterUserId: number | null;
  idempotencyKey: string;
  fingerprint: string;
  depth: HistoryDepth;
  reasonSha256: string;
  reasonLength: number;
  itemsTotal: number;
  estimateAtSubmit: Record<string, unknown>;
  legacyHydrationRequestId?: number | null;
}

/** A new open request with a fresh ref. The idempotency index may refuse it
 *  (23505): the caller then reads the request that won. */
export async function insertHistoryRequest(db: Database, input: InsertHistoryRequestInput): Promise<HistoryRequestRow> {
  const depth = input.depth;
  const result = await db.execute<RequestSqlRow>(sql`
    with inserted as (
      insert into history_requests (
        request_ref, page_id, requester_kind, requester_agent_key_id, requester_user_id, idempotency_key,
        request_fingerprint, depth_kind, depth_n, depth_boundary_at, depth_boundary_message_ref, reason_sha256,
        reason_length, items_total, estimate_at_submit, legacy_hydration_request_id
      ) values (
        gen_random_uuid(), ${input.pageId}::bigint, ${input.requesterKind}, ${input.requesterAgentKeyId}::bigint,
        ${input.requesterUserId}::bigint, ${input.idempotencyKey}::uuid, ${input.fingerprint}, ${depth.kind},
        ${depth.kind === "latest" ? depth.count : null}::integer,
        ${timestampParam(depth.kind === "before_boundary" ? depth.at : null)},
        ${depth.kind === "before_boundary" ? depth.messageRef : null}::text,
        ${input.reasonSha256}, ${input.reasonLength}::integer, ${input.itemsTotal}::integer,
        ${jsonParam(input.estimateAtSubmit)}, ${input.legacyHydrationRequestId ?? null}::bigint
      )
      returning *
    )
    select ${requestColumns} from inserted r join pages p on p.id = r.page_id
  `);
  const row = result.rows[0];
  if (!row) throw new Error("history_requests insert returned no row");
  return normalizeRequestRow(row);
}

export async function findHistoryRequestByIdempotency(
  db: Database,
  input: { requesterKind: HistoryRequesterKind; requesterAgentKeyId: number | null; requesterUserId: number | null; idempotencyKey: string },
): Promise<HistoryRequestRow | null> {
  const result = await db.execute<RequestSqlRow>(sql`
    select ${requestColumns}
      from history_requests r
      join pages p on p.id = r.page_id
     where r.requester_kind = ${input.requesterKind}
       and coalesce(r.requester_agent_key_id, 0) = ${input.requesterAgentKeyId ?? 0}::bigint
       and coalesce(r.requester_user_id, 0) = ${input.requesterUserId ?? 0}::bigint
       and r.idempotency_key = ${input.idempotencyKey}::uuid
  `);
  const row = result.rows[0];
  return row ? normalizeRequestRow(row) : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One request by its public ref (null for an unknown or malformed ref). */
export async function getHistoryRequestByRef(
  db: Database,
  ref: string,
  options: { forUpdate?: boolean } = {},
): Promise<HistoryRequestRow | null> {
  if (!UUID.test(ref)) return null;
  const result = await db.execute<RequestSqlRow>(sql`
    select ${requestColumns}
      from history_requests r
      join pages p on p.id = r.page_id
     where r.request_ref = ${ref}::uuid
     ${options.forUpdate === true ? sql`for update of r` : sql``}
  `);
  const row = result.rows[0];
  return row ? normalizeRequestRow(row) : null;
}

export async function getHistoryRequestsByIds(db: Database, ids: readonly number[]): Promise<HistoryRequestRow[]> {
  if (ids.length === 0) return [];
  const result = await db.execute<RequestSqlRow>(sql`
    select ${requestColumns}
      from history_requests r
      join pages p on p.id = r.page_id
     where r.id = any(${idsParam(ids)})
     order by r.id
  `);
  return result.rows.map(normalizeRequestRow);
}

/**
 * Requests newest first by id, over a keyset (the agent list, design §7.4):
 * of these pages, optionally of one state, below `beforeId` (the previous
 * page's last id) and at or below `maxId` (the traversal's frozen high water,
 * so a request filed mid-walk never joins a later page).
 */
export async function listHistoryRequestsKeyset(
  db: Database,
  input: { pageIds: readonly number[]; state?: HistoryRequestState; beforeId?: number; maxId?: number; limit: number },
): Promise<HistoryRequestRow[]> {
  if (input.pageIds.length === 0) return [];
  const filters: SQL[] = [sql`r.page_id = any(${idsParam(input.pageIds)})`];
  if (input.state !== undefined) filters.push(sql`r.state = ${input.state}`);
  if (input.beforeId !== undefined) filters.push(sql`r.id < ${input.beforeId}`);
  if (input.maxId !== undefined) filters.push(sql`r.id <= ${input.maxId}`);
  const result = await db.execute<RequestSqlRow>(sql`
    select ${requestColumns}
      from history_requests r
      join pages p on p.id = r.page_id
     where ${sql.join(filters, sql` and `)}
     order by r.id desc
     limit ${Math.max(1, Math.min(1_000, input.limit))}
  `);
  return result.rows.map(normalizeRequestRow);
}

/** How many requests `listHistoryRequestsKeyset` would walk in total (no
 *  `beforeId`): the list's exact `matchedInScope`. */
export async function countHistoryRequests(
  db: Database,
  input: { pageIds: readonly number[]; state?: HistoryRequestState; maxId?: number },
): Promise<number> {
  if (input.pageIds.length === 0) return 0;
  const filters: SQL[] = [sql`r.page_id = any(${idsParam(input.pageIds)})`];
  if (input.state !== undefined) filters.push(sql`r.state = ${input.state}`);
  if (input.maxId !== undefined) filters.push(sql`r.id <= ${input.maxId}`);
  const result = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from history_requests r where ${sql.join(filters, sql` and `)}
  `);
  return Number(result.rows[0]?.n ?? 0);
}

/** The newest request id of these pages (the agent list's frozen high water). */
export async function readHistoryRequestsHighWater(db: Database, pageIds: readonly number[]): Promise<number> {
  if (pageIds.length === 0) return 0;
  const result = await db.execute<{ maxId: string | null }>(sql`
    select max(r.id)::text as "maxId" from history_requests r where r.page_id = any(${idsParam(pageIds)})
  `);
  return Number(result.rows[0]?.maxId ?? 0);
}

/** Requests newest first, optionally of one page and state. */
export async function listHistoryRequests(
  db: Database,
  input: { pageId?: number; state?: HistoryRequestState; limit?: number; offset?: number } = {},
): Promise<HistoryRequestRow[]> {
  const filters: SQL[] = [sql`true`];
  if (input.pageId !== undefined) filters.push(sql`r.page_id = ${input.pageId}`);
  if (input.state !== undefined) filters.push(sql`r.state = ${input.state}`);
  const result = await db.execute<RequestSqlRow>(sql`
    select ${requestColumns}
      from history_requests r
      join pages p on p.id = r.page_id
     where ${sql.join(filters, sql` and `)}
     order by r.created_at desc, r.id desc
     limit ${Math.max(1, Math.min(1_000, input.limit ?? 50))}
    offset ${Math.max(0, input.offset ?? 0)}
  `);
  return result.rows.map(normalizeRequestRow);
}

/** A page's open requests in the requests class's round-robin order, each
 *  with whether a fan of it can be read now (open, due, unbroken work). */
export async function listOpenRequestsForPage(
  db: Database,
  input: { pageId: number; now?: Date | null },
): Promise<Array<{ id: number; ref: string; runnable: boolean }>> {
  const now = input.now === undefined || input.now === null ? sql`clock_timestamp()` : sql`${input.now}::timestamptz`;
  const result = await db.execute<{ id: string; ref: string; runnable: boolean }>(sql`
    select r.id::text as id, r.request_ref::text as ref,
           exists (
             select 1
               from history_request_items i
               join sync_work w on w.id = i.work_id
              where i.request_id = r.id
                and i.state in ${OPEN_STATES}
                and w.state = 'open'
                and w.due_at <= ${now}
                and (w.breaker_until is null or w.breaker_until <= ${now})
           ) as runnable
      from history_requests r
     where r.page_id = ${input.pageId}
       and r.state = 'open'
     order by r.last_served_at nulls first, r.id
  `);
  return result.rows.map((row) => ({ id: Number(row.id), ref: row.ref, runnable: row.runnable === true }));
}

/** The admission stamps the request and the fan whose turn it is (tx 1,
 *  after the work row; design §3.7.1): the round-robin instants, the read on
 *  the fan, and its first read moves it to `loading`. */
export async function markHistoryTurnServed(
  db: Database,
  input: { requestId: number; itemId: number },
): Promise<boolean> {
  await db.execute(sql`
    update history_requests
       set last_served_at = clock_timestamp(), updated_at = clock_timestamp()
     where id = ${input.requestId} and state = 'open'
  `);
  const result = await db.execute(sql`
    update history_request_items
       set last_served_at = clock_timestamp(),
           reads_spent = reads_spent + 1,
           state = case when state in ('queued', 'blocked') then 'loading' else state end,
           updated_at = clock_timestamp()
     where id = ${input.itemId}
       and request_id = ${input.requestId}
       and state in ${OPEN_STATES}
  `);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Re-count the terminal items of these requests; a request with no open item
 * left is `done` (an erased fan's items are gone, so "no open item" — not a
 * count — decides). Cancelled requests stay cancelled. Returns the ids that
 * became done.
 */
export async function refreshHistoryRequestCompletion(db: Database, requestIds: readonly number[]): Promise<number[]> {
  const ids = [...new Set(requestIds)].sort((a, b) => a - b);
  if (ids.length === 0) return [];
  const result = await db.execute<{ id: string; done: boolean }>(sql`
    update history_requests r
       set items_terminal = c.terminal,
           state = case when r.state = 'open' and c.open = 0 then 'done' else r.state end,
           done_at = case when r.state = 'open' and c.open = 0 then clock_timestamp() else r.done_at end,
           updated_at = clock_timestamp()
      from (
        select x.id,
               (select count(*)::int from history_request_items i
                 where i.request_id = x.id and i.state in ('ready', 'refused', 'cancelled')) as terminal,
               (select count(*)::int from history_request_items i
                 where i.request_id = x.id and i.state in ${OPEN_STATES}) as open
          from unnest(${idsParam(ids)}) as x(id)
      ) c
     where r.id = c.id
    returning r.id::text as id, (r.state = 'done' and c.open = 0) as done
  `);
  return result.rows.filter((row) => row.done === true).map((row) => Number(row.id));
}

/** Cancel an open request (its items are cancelled by the caller first). */
export async function markHistoryRequestCancelled(
  db: Database,
  input: { requestId: number; reasonSha256: string | null },
): Promise<boolean> {
  const result = await db.execute(sql`
    update history_requests r
       set state = 'cancelled',
           cancelled_at = clock_timestamp(),
           cancel_reason_sha256 = ${input.reasonSha256}::text,
           items_terminal = (select count(*)::int from history_request_items i
                              where i.request_id = r.id and i.state in ('ready', 'refused', 'cancelled')),
           updated_at = clock_timestamp()
     where r.id = ${input.requestId}
       and r.state = 'open'
  `);
  return (result.rowCount ?? 0) > 0;
}

// ── items ─────────────────────────────────────────────────────────────────────

export interface NewHistoryItem {
  ordinal: number;
  inputKind: HistoryInputKind;
  inputRef: string;
  fanPlatformUserId: string | null;
  fanId: number | null;
  threadId: number | null;
  conversationRef: string | null;
  state: HistoryItemState;
  refusal: HistoryItemRefusal | null;
  excludedReason: string | null;
  workId: number | null;
  anchor: Omit<HistoryItemAnchor, "fixedAt"> | null;
  estimateReadsMin: number | null;
  estimateReads: number | null;
  satisfiedBy: HistoryItemSatisfiedBy | null;
  satisfiedOldestId: string | null;
  satisfiedCount: number | null;
  final: Record<string, unknown> | null;
}

export async function insertHistoryItems(
  db: Database,
  input: { requestId: number; pageId: number; items: readonly NewHistoryItem[] },
): Promise<HistoryItemRow[]> {
  if (input.items.length === 0) return [];
  const rows = input.items.map((item) => ({
    ordinal: item.ordinal,
    input_kind: item.inputKind,
    input_ref: item.inputRef,
    fan_platform_user_id: item.fanPlatformUserId,
    fan_id: item.fanId,
    thread_id: item.threadId,
    conversation_ref: item.conversationRef,
    state: item.state,
    refusal: item.refusal,
    excluded_reason: item.excludedReason,
    work_id: item.workId,
    anchor_message_id: item.anchor?.messageId ?? null,
    anchor_upward_count: item.anchor?.upwardCount ?? null,
    anchor_chain_epoch: item.anchor?.chainEpoch ?? null,
    estimate_reads_min: item.estimateReadsMin,
    estimate_reads: item.estimateReads,
    satisfied_by: item.satisfiedBy,
    satisfied_oldest_id: item.satisfiedOldestId,
    satisfied_count: item.satisfiedCount,
    final: item.final,
  }));
  const result = await db.execute<ItemSqlRow>(sql`
    with inserted as (
      insert into history_request_items (
        request_id, page_id, ordinal, input_kind, input_ref, fan_platform_user_id, fan_id, thread_id,
        conversation_ref, state, refusal, excluded_reason, work_id, anchor_message_id, anchor_fixed_at,
        anchor_upward_count, anchor_chain_epoch, estimate_reads_min, estimate_reads, satisfied_at, satisfied_by,
        satisfied_oldest_id, satisfied_count, final
      )
      select ${input.requestId}::bigint, ${input.pageId}::bigint, x.ordinal, x.input_kind, x.input_ref,
             x.fan_platform_user_id, x.fan_id, x.thread_id, x.conversation_ref, x.state, x.refusal, x.excluded_reason,
             x.work_id, x.anchor_message_id,
             case when x.anchor_message_id is not null then clock_timestamp() end,
             x.anchor_upward_count, x.anchor_chain_epoch, x.estimate_reads_min, x.estimate_reads,
             case when x.state = 'ready' then clock_timestamp() end, x.satisfied_by, x.satisfied_oldest_id,
             x.satisfied_count, x.final
        from jsonb_to_recordset(${jsonParam(rows)}) as x(
          ordinal integer, input_kind text, input_ref text, fan_platform_user_id text, fan_id bigint, thread_id bigint,
          conversation_ref text, state text, refusal text, excluded_reason text, work_id bigint,
          anchor_message_id text, anchor_upward_count bigint, anchor_chain_epoch integer, estimate_reads_min integer,
          estimate_reads integer, satisfied_by text, satisfied_oldest_id text, satisfied_count integer, final jsonb)
       order by x.ordinal
      returning *
    )
    select ${itemColumns} from inserted i order by i.ordinal
  `);
  return result.rows.map(normalizeItemRow);
}

/** A request's items in ordinal order, after `afterOrdinal` (paging). */
export async function listHistoryItems(
  db: Database,
  input: { requestId: number; afterOrdinal?: number | null; limit?: number; states?: readonly HistoryItemState[] },
): Promise<HistoryItemRow[]> {
  const filters: SQL[] = [sql`i.request_id = ${input.requestId}`];
  if (input.afterOrdinal !== undefined && input.afterOrdinal !== null) filters.push(sql`i.ordinal > ${input.afterOrdinal}`);
  if (input.states !== undefined) filters.push(sql`i.state = any(${textArrayParam(input.states)})`);
  const result = await db.execute<ItemSqlRow>(sql`
    select ${itemColumns}
      from history_request_items i
     where ${sql.join(filters, sql` and `)}
     order by i.ordinal
     limit ${Math.max(1, Math.min(HISTORY_REQUEST_MAX_ITEMS, input.limit ?? 200))}
  `);
  return result.rows.map(normalizeItemRow);
}

export interface HistoryItemCounts {
  byState: Record<HistoryItemState, number>;
  readsSpent: number;
}

/** Items by state and reads spent, per request. */
export async function countHistoryItems(db: Database, requestIds: readonly number[]): Promise<Map<number, HistoryItemCounts>> {
  const counts = new Map<number, HistoryItemCounts>();
  if (requestIds.length === 0) return counts;
  const result = await db.execute<{ requestId: string; state: HistoryItemState; n: number; reads: string }>(sql`
    select i.request_id::text as "requestId", i.state, count(*)::int as n, sum(i.reads_spent)::text as reads
      from history_request_items i
     where i.request_id = any(${idsParam(requestIds)})
     group by i.request_id, i.state
  `);
  for (const id of requestIds) {
    counts.set(id, {
      byState: Object.fromEntries(HISTORY_ITEM_STATES.map((state) => [state, 0])) as Record<HistoryItemState, number>,
      readsSpent: 0,
    });
  }
  for (const row of result.rows) {
    const entry = counts.get(Number(row.requestId))!;
    entry.byState[row.state] = Number(row.n);
    entry.readsSpent += Number(row.reads ?? 0);
  }
  return counts;
}

/** Open items of a request (cancel), of chats, or of a work row, with what
 *  their requests ask. `lock` takes their rows FOR UPDATE in id order — call
 *  `lockRequestsOfOpenItems` first (requests before items, §3.7) and pass the
 *  ids it locked as `requestIds`: an item of a request filed after that lock
 *  is not this transaction's to write. */
export async function listOpenHistoryItems(
  db: Database,
  input: {
    requestId?: number;
    threadIds?: readonly number[];
    workId?: number;
    requestIds?: readonly number[];
    lock?: boolean;
  },
): Promise<OpenHistoryItem[]> {
  const filters: SQL[] = [sql`i.state in ${OPEN_STATES}`];
  if (input.requestId !== undefined) filters.push(sql`i.request_id = ${input.requestId}`);
  if (input.threadIds !== undefined) filters.push(sql`i.thread_id = any(${idsParam(input.threadIds)})`);
  if (input.workId !== undefined) filters.push(sql`i.work_id = ${input.workId}`);
  if (filters.length === 1) throw new Error("listOpenHistoryItems needs a request, a thread or a work");
  if (input.requestIds !== undefined) filters.push(sql`i.request_id = any(${idsParam(input.requestIds)})`);
  const result = await db.execute<OpenItemSqlRow>(sql`
    select ${openItemColumns}
      from history_request_items i
      join history_requests r on r.id = i.request_id
     where ${sql.join(filters, sql` and `)}
     order by i.id
     ${input.lock === true ? sql`for update of i` : sql``}
  `);
  return result.rows.map(normalizeOpenItemRow);
}

/** Lock (in id order) the requests that have open items on this chat or work:
 *  every writer of items takes the request rows first (§3.7). Returns their ids. */
export async function lockRequestsOfOpenItems(
  db: Database,
  input: { threadIds?: readonly number[]; workIds?: readonly number[] },
): Promise<number[]> {
  const threads = input.threadIds ?? [];
  const works = input.workIds ?? [];
  if (threads.length === 0 && works.length === 0) return [];
  const result = await db.execute<{ id: string }>(sql`
    select r.id::text as id
      from history_requests r
     where r.id in (
       select i.request_id
         from history_request_items i
        where i.state in ${OPEN_STATES}
          and (i.thread_id = any(${idsParam(threads)}) or i.work_id = any(${idsParam(works)})))
     order by r.id
       for update of r
  `);
  return result.rows.map((row) => Number(row.id));
}

/** Take the chats new items will reference (`for key share`, id order) —
 *  before any sync_work row (§3.7: page_dm_threads before sync_work). The
 *  items' foreign key takes the same lock at insert, too late in the order:
 *  a DM apply holds the chat it writes and then the chat's work. */
export async function lockThreadsForHistoryItems(db: Database, threadIds: readonly number[]): Promise<void> {
  const ids = [...new Set(threadIds)].sort((a, b) => a - b);
  if (ids.length === 0) return;
  await db.execute(sql`
    select t.id from page_dm_threads t
     where t.id = any(${idsParam(ids)})
     order by t.id
       for key share of t
  `);
}

/** Which of these work rows still carry an open item. */
export async function workIdsWithOpenHistoryItems(db: Database, workIds: readonly number[]): Promise<Set<number>> {
  if (workIds.length === 0) return new Set();
  const result = await db.execute<{ workId: string }>(sql`
    select distinct i.work_id::text as "workId"
      from history_request_items i
     where i.work_id = any(${idsParam(workIds)})
       and i.state in ${OPEN_STATES}
  `);
  return new Set(result.rows.map((row) => Number(row.workId)));
}

/** Fix the anchor of open items (§7.1.4): the chain head the depth counts
 *  from, with the chain's upward count and epoch at that moment. */
export async function setHistoryItemAnchors(
  db: Database,
  input: { itemIds: readonly number[]; anchor: Omit<HistoryItemAnchor, "fixedAt"> | null },
): Promise<number> {
  if (input.itemIds.length === 0) return 0;
  const anchor = input.anchor;
  const result = await db.execute(sql`
    update history_request_items
       set anchor_message_id = ${anchor?.messageId ?? null}::text,
           anchor_fixed_at = case when ${anchor !== null} then clock_timestamp() end,
           anchor_upward_count = ${anchor?.upwardCount ?? null}::bigint,
           anchor_chain_epoch = ${anchor?.chainEpoch ?? null}::integer,
           updated_at = clock_timestamp()
     where id = any(${idsParam(input.itemIds)})
       and state in ${OPEN_STATES}
  `);
  return result.rowCount ?? 0;
}

/** Open items become ready (§7.1.6). */
export async function markHistoryItemsReady(
  db: Database,
  items: ReadonlyArray<{
    itemId: number;
    satisfiedBy: HistoryItemSatisfiedBy;
    satisfiedOldestId: string | null;
    satisfiedCount: number | null;
    final: Record<string, unknown>;
  }>,
): Promise<number> {
  if (items.length === 0) return 0;
  const rows = items.map((item) => ({
    id: item.itemId,
    satisfied_by: item.satisfiedBy,
    satisfied_oldest_id: item.satisfiedOldestId,
    satisfied_count: item.satisfiedCount,
    final: item.final,
  }));
  const result = await db.execute(sql`
    update history_request_items i
       set state = 'ready',
           satisfied_at = clock_timestamp(),
           satisfied_by = x.satisfied_by,
           satisfied_oldest_id = x.satisfied_oldest_id,
           satisfied_count = x.satisfied_count,
           final = x.final,
           updated_at = clock_timestamp()
      from jsonb_to_recordset(${jsonParam(rows)})
        as x(id bigint, satisfied_by text, satisfied_oldest_id text, satisfied_count integer, final jsonb)
     where i.id = x.id
       and i.state in ${OPEN_STATES}
  `);
  return result.rowCount ?? 0;
}

/** Open items end without being satisfied: cancelled (a cancelled request,
 *  a work that ended for another reason) or refused after intake (the chat
 *  was deleted or excluded since). */
export async function endHistoryItems(
  db: Database,
  input: {
    itemIds: readonly number[];
    state: "cancelled" | "refused";
    refusal?: HistoryItemRefusal | null;
    excludedReason?: string | null;
    final: Record<string, unknown>;
  },
): Promise<number> {
  if (input.itemIds.length === 0) return 0;
  if ((input.state === "refused") !== (input.refusal !== undefined && input.refusal !== null)) {
    throw new Error("a refused item carries its refusal, and only a refused one");
  }
  const result = await db.execute(sql`
    update history_request_items
       set state = ${input.state},
           refusal = ${input.refusal ?? null}::text,
           excluded_reason = coalesce(${input.excludedReason ?? null}::text, excluded_reason),
           final = ${nullableJsonParam(input.final)},
           updated_at = clock_timestamp()
     where id = any(${idsParam(input.itemIds)})
       and state in ${OPEN_STATES}
  `);
  return result.rowCount ?? 0;
}

// ── the chats a request names ─────────────────────────────────────────────────

/** What a request needs to know of a chat: identity, exclusion, the proven
 *  chain (0231) and the legacy stored window (ETA inputs: thread columns
 *  only, design §7.2). */
export interface HistoryThreadFacts {
  threadId: number;
  pageId: number;
  groupId: string;
  fanId: number | null;
  fanPlatformUserId: string | null;
  partnerPlatformUserId: string | null;
  metadata: Record<string, unknown>;
  isVisible: boolean;
  lastMessageAt: Date | null;
  headConfirmedId: string | null;
  headConfirmedAt: Date | null;
  contiguousOldestId: string | null;
  contiguousOldestAt: Date | null;
  contiguousCount: number;
  chainUpwardCount: number;
  chainEpoch: number;
  historyState: ThreadHistoryState;
  effectiveHistoryState: ThreadHistoryState;
  historyProof: "empty_page" | null;
  storedMessageCount: number;
  newestStoredMessageId: string | null;
  oldestStoredMessageId: string | null;
}

type ThreadFactsSqlRow = {
  threadId: string;
  pageId: string;
  groupId: string;
  fanId: string | null;
  fanPlatformUserId: string | null;
  partnerPlatformUserId: string | null;
  metadata: Record<string, unknown> | null;
  isVisible: boolean;
  lastMessageAt: Date | string | null;
  headConfirmedId: string | null;
  headConfirmedAt: Date | string | null;
  contiguousOldestId: string | null;
  contiguousOldestAt: Date | string | null;
  contiguousCount: number;
  chainUpwardCount: string;
  chainEpoch: number;
  historyState: ThreadHistoryState;
  effectiveHistoryState: ThreadHistoryState;
  historyProof: string | null;
  storedMessageCount: number;
  newestStoredMessageId: string | null;
  oldestStoredMessageId: string | null;
};

const threadFactsColumns = sql`
  t.id::text as "threadId",
  t.platform_account_id::text as "pageId",
  t.platform_conversation_id as "groupId",
  t.fan_id::text as "fanId",
  f.platform_user_id as "fanPlatformUserId",
  t.partner_platform_user_id as "partnerPlatformUserId",
  t.metadata,
  t.is_visible as "isVisible",
  t.last_message_at as "lastMessageAt",
  t.head_confirmed_id as "headConfirmedId",
  t.head_confirmed_at as "headConfirmedAt",
  t.contiguous_oldest_id as "contiguousOldestId",
  t.contiguous_oldest_at as "contiguousOldestAt",
  t.contiguous_count as "contiguousCount",
  t.chain_upward_count::text as "chainUpwardCount",
  t.chain_epoch as "chainEpoch",
  t.history_state as "historyState",
  ${effectiveHistoryStateSql("t")} as "effectiveHistoryState",
  t.history_proof as "historyProof",
  t.stored_message_count as "storedMessageCount",
  t.newest_stored_message_id as "newestStoredMessageId",
  t.oldest_stored_message_id as "oldestStoredMessageId"
`;

function normalizeThreadFacts(row: ThreadFactsSqlRow): HistoryThreadFacts {
  return {
    threadId: Number(row.threadId),
    pageId: Number(row.pageId),
    groupId: row.groupId,
    fanId: toNumber(row.fanId),
    fanPlatformUserId: row.fanPlatformUserId,
    partnerPlatformUserId: row.partnerPlatformUserId,
    metadata: row.metadata ?? {},
    isVisible: row.isVisible === true,
    lastMessageAt: toDate(row.lastMessageAt),
    headConfirmedId: row.headConfirmedId,
    headConfirmedAt: toDate(row.headConfirmedAt),
    contiguousOldestId: row.contiguousOldestId,
    contiguousOldestAt: toDate(row.contiguousOldestAt),
    contiguousCount: Number(row.contiguousCount),
    chainUpwardCount: Number(row.chainUpwardCount),
    chainEpoch: Number(row.chainEpoch),
    historyState: row.historyState,
    effectiveHistoryState: row.effectiveHistoryState,
    // `first_second` is never written (owner decision №3): no proof.
    historyProof: row.historyProof === "empty_page" ? "empty_page" : null,
    storedMessageCount: Number(row.storedMessageCount),
    newestStoredMessageId: row.newestStoredMessageId,
    oldestStoredMessageId: row.oldestStoredMessageId,
  };
}

export interface HistoryThreadCandidates {
  /** Visible chats by Fansly group id. */
  byGroupId: Map<string, HistoryThreadFacts>;
  /** Visible chats of each fan id (by the bound fan, or the chat partner). */
  byFanRef: Map<string, HistoryThreadFacts[]>;
}

/**
 * The visible chats a request's inputs can name, in two set-based reads
 * (design §7.1.2): by conversation (the page × group unique index), and by
 * fan (fans(platform, platform_user_id) → the page × fan index, or the chat
 * partner). Choosing among several chats of one fan is the caller's.
 */
export async function findHistoryThreadCandidates(
  db: Database,
  input: { pageId: number; groupIds: readonly string[]; fanRefs: readonly string[] },
  planeReads?: PlaneReadWitness[],
): Promise<HistoryThreadCandidates> {
  const byGroupId = new Map<string, HistoryThreadFacts>();
  const byFanRef = new Map<string, HistoryThreadFacts[]>();
  const groupIds = [...new Set(input.groupIds)];
  if (groupIds.length > 0) {
    const result = await db.execute<ThreadFactsSqlRow>(sql`
      select ${threadFactsColumns}
        from page_dm_threads t
        left join fans f on f.id = t.fan_id
       where t.platform_account_id = ${input.pageId}
         and t.platform_conversation_id = any(${textArrayParam(groupIds)})
         and t.is_visible
    `);
    for (const row of result.rows) byGroupId.set(row.groupId, normalizeThreadFacts(row));
    planeReads?.push(witnessFor("page_dm_threads"));
  }
  const fanRefs = [...new Set(input.fanRefs)];
  if (fanRefs.length > 0) {
    const result = await db.execute<ThreadFactsSqlRow & { fanRef: string }>(sql`
      select x.fan_ref as "fanRef", ${threadFactsColumns}
        from (
          select f2.platform_user_id as fan_ref, t2.id as thread_id
            from fans f2
            join page_dm_threads t2 on t2.platform_account_id = ${input.pageId} and t2.fan_id = f2.id
           where f2.platform = 'fansly'
             and f2.platform_user_id = any(${textArrayParam(fanRefs)})
          union
          select t3.partner_platform_user_id as fan_ref, t3.id as thread_id
            from page_dm_threads t3
           where t3.platform_account_id = ${input.pageId}
             and t3.partner_platform_user_id = any(${textArrayParam(fanRefs)})
        ) x
        join page_dm_threads t on t.id = x.thread_id
        left join fans f on f.id = t.fan_id
       where t.is_visible
    `);
    for (const row of result.rows) {
      const list = byFanRef.get(row.fanRef) ?? [];
      list.push(normalizeThreadFacts(row));
      byFanRef.set(row.fanRef, list);
    }
    planeReads?.push(witnessFor("page_dm_threads"));
  }
  return { byGroupId, byFanRef };
}

/**
 * The request facts of chats by id (views, the satisfaction hook). A reader
 * that reports what it read (the agent plane's envelope) passes `planeReads`:
 * it receives the `page_dm_threads` witness when, and only when, the
 * statement ran.
 */
export async function readHistoryThreadFacts(
  db: Database,
  threadIds: readonly number[],
  planeReads?: PlaneReadWitness[],
): Promise<Map<number, HistoryThreadFacts>> {
  const facts = new Map<number, HistoryThreadFacts>();
  if (threadIds.length === 0) return facts;
  const result = await db.execute<ThreadFactsSqlRow>(sql`
    select ${threadFactsColumns}
      from page_dm_threads t
      left join fans f on f.id = t.fan_id
     where t.id = any(${idsParam(threadIds)})
  `);
  for (const row of result.rows) facts.set(Number(row.threadId), normalizeThreadFacts(row));
  planeReads?.push(witnessFor("page_dm_threads"));
  return facts;
}

/** An executed (not dry-run) page- or model-scope erasure covers the page
 *  (its plan's resolved page ids; labels are mutable). */
export async function isPageErased(db: Database, pageId: number): Promise<boolean> {
  const result = await db.execute<{ erased: boolean }>(sql`
    select exists (
      select 1 from erasure_log e
       where e.dry_run = false
         and e.scope_type in ('page', 'model')
         and e.plan->'resolvedPageIds' @> to_jsonb(${pageId}::bigint)
    ) as erased
  `);
  return result.rows[0]?.erased === true;
}

/** How fresh a live socket must have guarded its connection to count as open
 *  (the fast lane's precedent). */
export const HISTORY_ANCHOR_SOCKET_FRESH_MS = 30_000;

/** The page's current WebSocket connection, when it is open, verified and
 *  fresh: a head confirmed after `verifiedAt` has seen every message since
 *  (no gap), so it can anchor a request without a read (§7.1.4). */
export async function readOpenVerifiedWsConnection(
  db: Database,
  pageId: number,
): Promise<{ verifiedAt: Date } | null> {
  const result = await db.execute<{ verifiedAt: Date | string | null; open: boolean }>(sql`
    select c.verified_at as "verifiedAt",
           (c.closed_at is null and c.verified_at is not null
             and c.last_guard_at > clock_timestamp() - ${HISTORY_ANCHOR_SOCKET_FRESH_MS} * interval '1 millisecond') as open
      from fansly_ws_connections c
     where c.page_id = ${pageId}
     order by c.started_at desc
     limit 1
  `);
  const row = result.rows[0];
  const verifiedAt = toDate(row?.verifiedAt);
  return row?.open === true && verifiedAt !== null ? { verifiedAt } : null;
}
