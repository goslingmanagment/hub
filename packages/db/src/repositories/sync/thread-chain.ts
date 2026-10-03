import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../../client.ts";
import { type CapturePayloadRef, capturePayloadRefFromColumns } from "../capture-payloads.ts";
import { archiveStoredMessageSql, archiveThreadRowsFromSql } from "../dm-archive-store.ts";
import type { DmLiveReaderStore } from "./live-messages.ts";
import { holdsSyncSwitchCapability, type SyncPageMode, type SyncSwitchCapability } from "./pages.ts";
import { textArrayParam, toDate, toRequiredDate } from "./values.ts";

// Fansly Sync Engine (plan §6.2, §6.3; design §2.3, §8): the contiguous-chain
// coverage of a DM thread, and the engine's bridge to the legacy coverage
// columns.
//
// I9 — two column groups, two writers, no overlap:
//   chain columns (0231: head_confirmed_*, contiguous_*, chain_*, history_*)
//       written ONLY by `writeThreadChain` — by the engine's DM apply in the
//       transaction of the messages, or by the journal rebuild in its own
//       short transaction (`writeRebuiltThreadChain`);
//   legacy coverage columns (stored_*, message_coverage_status,
//       message_backfill_complete, last_message_sync_at, last_fan/model_*)
//       written by the engine ONLY through `syncLegacyThreadSummary` (a read
//       stored rows) and `syncLegacyThreadSummaryAfterDeletion` (a socket
//       deletion marked one), which refuse a thread whose page is not
//       `handover`/`live` — on every other page they belong to the legacy
//       engine.
// Neither writer touches the other group (nor `updated_at`, for the chain
// writer), so a rebuild on a legacy page changes nothing a legacy reader sees.

export const THREAD_HISTORY_STATES = ["none", "unverified", "partial", "complete"] as const;
export type ThreadHistoryState = (typeof THREAD_HISTORY_STATES)[number];

/** `first_second` is reserved (owner decision №3) and never written. */
export const THREAD_HISTORY_PROOFS = ["empty_page", "first_second"] as const;
export type ThreadHistoryProof = (typeof THREAD_HISTORY_PROOFS)[number];

export const THREAD_CHAIN_SOURCES = ["journal_rebuild", "engine"] as const;
export type ThreadChainSource = (typeof THREAD_CHAIN_SOURCES)[number];

/** The audit event a `--write` run of `sync chain rebuild` leaves per page. */
export const SYNC_CHAIN_REBUILD_AUDIT_EVENT = "admin.sync_chain_rebuild";

/** The page that proved `complete`: an engine observation or a legacy
 *  journal row. */
export type ThreadChainProofWitness =
  | { kind: "observation"; observationId: number; receivedAt: Date }
  | { kind: "raw"; rawPayloadId: number };

/** The chain columns of one thread (the pure fold's `ThreadChain`). */
export interface ThreadChainState {
  epoch: number;
  state: ThreadHistoryState;
  headId: string | null;
  headAt: Date | null;
  oldestId: string | null;
  oldestCreatedAtMs: number | null;
  count: number;
  upwardCount: number;
  proof: "empty_page" | null;
  proofWitness: ThreadChainProofWitness | null;
  provenAt: Date | null;
}

export interface ThreadChainRow {
  threadId: number;
  pageId: number;
  groupId: string;
  chain: ThreadChainState;
  source: ThreadChainSource | null;
  journalWatermark: number;
  /** `history_state` corrected for messages legacy stored after 0231's
   *  marking (`effectiveHistoryStateSql`). */
  effectiveHistoryState: ThreadHistoryState;
  storedMessageCount: number;
  messageCoverageStatus: "pending_backfill" | "partial_window" | "complete";
}

/** A chain that cannot be stored as given (a caller bug, never data). */
export class ThreadChainInvalidError extends Error {
  constructor(threadId: number, problem: string) {
    super(`Thread ${threadId}: chain cannot be written: ${problem}`);
    this.name = "ThreadChainInvalidError";
  }
}

/** `syncLegacyThreadSummary` on a thread whose page the legacy engine owns. */
export class LegacyThreadSummaryRefusedError extends Error {
  readonly threadId: number;
  readonly mode: SyncPageMode | null;

  constructor(threadId: number, mode: SyncPageMode | null, exists: boolean) {
    super(
      exists
        ? `Thread ${threadId}: the engine writes legacy coverage columns only on a page in handover or live `
          + `(the page is ${mode === null ? "without a sync_pages row" : `'${mode}'`})`
        : `Thread ${threadId}: no such thread`,
    );
    this.name = "LegacyThreadSummaryRefusedError";
    this.threadId = threadId;
    this.mode = mode;
  }
}

/** A rebuild write refused by the page mode (the engine is the chain writer). */
export class ThreadChainRebuildModeError extends Error {
  readonly pageId: number;
  readonly mode: SyncPageMode;

  constructor(pageId: number, mode: SyncPageMode) {
    super(
      `Page ${pageId} is '${mode}': the Fansly Sync Engine is the only chain writer there; `
        + "the journal rebuild runs on 'off' and 'shadow' pages (and the switch's own final pass)",
    );
    this.name = "ThreadChainRebuildModeError";
    this.pageId = pageId;
    this.mode = mode;
  }
}

const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * The effective history state of a thread (§2.3): 0231 marked threads with
 * stored messages `unverified` once; legacy keeps storing messages afterwards,
 * so every reader (ETA, `hub threads`, request views, `explainWork`) reads this
 * fragment instead of the column.
 */
export function effectiveHistoryStateSql(threadAlias = "page_dm_threads"): SQL {
  if (!SQL_IDENTIFIER.test(threadAlias)) throw new Error(`Not a SQL alias: ${threadAlias}`);
  const alias = sql.raw(threadAlias);
  return sql`(case when ${alias}.history_state = 'none' and ${alias}.stored_message_count > 0
    then 'unverified' else ${alias}.history_state end)`;
}

const DECIMAL_ID = /^[0-9]{1,30}$/;

function assertWritableChain(threadId: number, chain: ThreadChainState): void {
  const fail = (problem: string) => {
    throw new ThreadChainInvalidError(threadId, problem);
  };
  if (!(THREAD_HISTORY_STATES as readonly string[]).includes(chain.state)) fail(`unknown state ${String(chain.state)}`);
  if (!Number.isSafeInteger(chain.epoch) || chain.epoch < 0) fail("epoch must be a non-negative integer");
  if (!Number.isSafeInteger(chain.count) || chain.count < 0) fail("count must be a non-negative integer");
  if (!Number.isSafeInteger(chain.upwardCount) || chain.upwardCount < 0) fail("upwardCount must be a non-negative integer");
  if ((chain.headId === null) !== (chain.count === 0)) fail("a head id exists exactly when the chain has messages");
  if ((chain.headId === null) !== (chain.oldestId === null)) fail("head and oldest ids are set together");
  for (const id of [chain.headId, chain.oldestId]) {
    if (id !== null && !DECIMAL_ID.test(id)) fail(`bad message id ${id}`);
  }
  if (chain.headId !== null && chain.headAt === null) fail("a confirmed head needs its capture time");
  if (chain.oldestCreatedAtMs !== null && !Number.isFinite(chain.oldestCreatedAtMs)) fail("oldest createdAt is not a time");
  const complete = chain.state === "complete";
  if (complete !== (chain.proof !== null)) fail("a proof exists exactly when the chain is complete");
  if (complete !== (chain.proofWitness !== null) || complete !== (chain.provenAt !== null)) {
    fail("a complete chain carries its proving page and time, and only it");
  }
  if (chain.headId !== null && (chain.state === "none" || chain.state === "unverified")) {
    fail(`a chain with messages cannot be '${chain.state}'`);
  }
  if (chain.headId === null && chain.state === "partial") fail("a partial chain has a head");
}

/**
 * THE single writer of a thread's chain columns (I9). Writes only those
 * columns, `chain_source`, and — when given — raises the journal watermark;
 * never a legacy column, never `updated_at`. Runs inside the caller's
 * transaction (engine: the DM apply; rebuild: `writeRebuiltThreadChain`).
 * Returns the epoch the thread had, so the caller can clear request anchors
 * of a replaced chain (§7.1.6).
 */
export async function writeThreadChain(
  tx: Database,
  threadId: number,
  input: { chain: ThreadChainState; source: ThreadChainSource; journalWatermark?: number },
): Promise<{ previousEpoch: number; epochChanged: boolean }> {
  const { chain } = input;
  assertWritableChain(threadId, chain);
  if (!(THREAD_CHAIN_SOURCES as readonly string[]).includes(input.source)) {
    throw new ThreadChainInvalidError(threadId, `unknown source ${String(input.source)}`);
  }
  if (input.journalWatermark !== undefined
    && (!Number.isSafeInteger(input.journalWatermark) || input.journalWatermark < 0)) {
    throw new ThreadChainInvalidError(threadId, "journal watermark must be a non-negative integer");
  }
  const witness = chain.proofWitness;
  const result = await tx.execute<{ previousEpoch: number }>(sql`
    with previous as (
      select id, chain_epoch from page_dm_threads where id = ${threadId} for update
    )
    update page_dm_threads t
       set head_confirmed_id = ${chain.headId},
           head_confirmed_at = ${chain.headAt}::timestamptz,
           contiguous_oldest_id = ${chain.oldestId},
           contiguous_oldest_at = ${chain.oldestCreatedAtMs === null ? null : new Date(chain.oldestCreatedAtMs)}::timestamptz,
           contiguous_count = ${chain.count},
           chain_upward_count = ${chain.upwardCount},
           chain_epoch = ${chain.epoch},
           history_state = ${chain.state},
           history_proof = ${chain.proof},
           history_proven_at = ${chain.provenAt}::timestamptz,
           history_proof_observation_id = ${witness?.kind === "observation" ? witness.observationId : null}::bigint,
           history_proof_observation_received_at = ${witness?.kind === "observation" ? witness.receivedAt : null}::timestamptz,
           history_proof_raw_payload_id = ${witness?.kind === "raw" ? witness.rawPayloadId : null}::bigint,
           chain_source = ${input.source},
           chain_journal_watermark = greatest(t.chain_journal_watermark, ${input.journalWatermark ?? 0}::bigint)
      from previous
     where t.id = previous.id
    returning previous.chain_epoch as "previousEpoch"
  `);
  const row = result.rows[0];
  if (!row) throw new ThreadChainInvalidError(threadId, "no such thread");
  const previousEpoch = Number(row.previousEpoch);
  return { previousEpoch, epochChanged: previousEpoch !== chain.epoch };
}

type ThreadChainSqlRow = {
  threadId: string;
  pageId: string;
  groupId: string;
  headConfirmedId: string | null;
  headConfirmedAt: Date | string | null;
  contiguousOldestId: string | null;
  contiguousOldestAt: Date | string | null;
  contiguousCount: number;
  chainUpwardCount: string;
  chainEpoch: number;
  historyState: ThreadHistoryState;
  historyProof: ThreadHistoryProof | null;
  historyProvenAt: Date | string | null;
  historyProofObservationId: string | null;
  historyProofObservationReceivedAt: Date | string | null;
  historyProofRawPayloadId: string | null;
  chainSource: ThreadChainSource | null;
  chainJournalWatermark: string;
  effectiveHistoryState: ThreadHistoryState;
  storedMessageCount: number;
  messageCoverageStatus: ThreadChainRow["messageCoverageStatus"];
};

const threadChainColumns = sql`
  t.id::text as "threadId",
  t.platform_account_id::text as "pageId",
  t.platform_conversation_id as "groupId",
  t.head_confirmed_id as "headConfirmedId",
  t.head_confirmed_at as "headConfirmedAt",
  t.contiguous_oldest_id as "contiguousOldestId",
  t.contiguous_oldest_at as "contiguousOldestAt",
  t.contiguous_count as "contiguousCount",
  t.chain_upward_count::text as "chainUpwardCount",
  t.chain_epoch as "chainEpoch",
  t.history_state as "historyState",
  t.history_proof as "historyProof",
  t.history_proven_at as "historyProvenAt",
  t.history_proof_observation_id::text as "historyProofObservationId",
  t.history_proof_observation_received_at as "historyProofObservationReceivedAt",
  t.history_proof_raw_payload_id::text as "historyProofRawPayloadId",
  t.chain_source as "chainSource",
  t.chain_journal_watermark::text as "chainJournalWatermark",
  ${effectiveHistoryStateSql("t")} as "effectiveHistoryState",
  t.stored_message_count as "storedMessageCount",
  t.message_coverage_status::text as "messageCoverageStatus"
`;

function proofWitnessOf(row: ThreadChainSqlRow): ThreadChainProofWitness | null {
  if (row.historyProofObservationId !== null && row.historyProofObservationReceivedAt !== null) {
    return {
      kind: "observation",
      observationId: Number(row.historyProofObservationId),
      receivedAt: toRequiredDate(row.historyProofObservationReceivedAt),
    };
  }
  if (row.historyProofRawPayloadId !== null) {
    return { kind: "raw", rawPayloadId: Number(row.historyProofRawPayloadId) };
  }
  return null;
}

function normalizeThreadChainRow(row: ThreadChainSqlRow): ThreadChainRow {
  const contiguousOldestAt = toDate(row.contiguousOldestAt);
  return {
    threadId: Number(row.threadId),
    pageId: Number(row.pageId),
    groupId: row.groupId,
    chain: {
      epoch: Number(row.chainEpoch),
      state: row.historyState,
      headId: row.headConfirmedId,
      headAt: toDate(row.headConfirmedAt),
      oldestId: row.contiguousOldestId,
      oldestCreatedAtMs: contiguousOldestAt === null ? null : contiguousOldestAt.getTime(),
      count: Number(row.contiguousCount),
      upwardCount: Number(row.chainUpwardCount),
      // `first_second` is never written (decision №3); read as no proof.
      proof: row.historyProof === "empty_page" ? "empty_page" : null,
      proofWitness: proofWitnessOf(row),
      provenAt: toDate(row.historyProvenAt),
    },
    source: row.chainSource,
    journalWatermark: Number(row.chainJournalWatermark),
    effectiveHistoryState: row.effectiveHistoryState,
    storedMessageCount: Number(row.storedMessageCount),
    messageCoverageStatus: row.messageCoverageStatus,
  };
}

export async function readThreadChain(db: Database, threadId: number): Promise<ThreadChainRow | null> {
  const result = await db.execute<ThreadChainSqlRow>(sql`
    select ${threadChainColumns} from page_dm_threads t where t.id = ${threadId}
  `);
  const row = result.rows[0];
  return row ? normalizeThreadChainRow(row) : null;
}

/** Every thread of a page with its chain (the rebuild loads them once), or
 *  one thread. */
export async function listPageThreadChains(
  db: Database,
  input: { pageId: number; threadId?: number },
): Promise<ThreadChainRow[]> {
  const threadFilter = input.threadId === undefined ? sql`` : sql`and t.id = ${input.threadId}`;
  const result = await db.execute<ThreadChainSqlRow>(sql`
    select ${threadChainColumns}
      from page_dm_threads t
     where t.platform_account_id = ${input.pageId}
       ${threadFilter}
     order by t.id
  `);
  return result.rows.map(normalizeThreadChainRow);
}

/**
 * Drop a thread's chain (a new epoch, nothing proven): the state goes back to
 * `unverified` when the hub holds messages of the thread, else `none`.
 * Request anchors of the old epoch are then cleared by the caller (§7.1.6).
 */
export async function resetThreadChain(tx: Database, threadId: number): Promise<{ epoch: number } | null> {
  const result = await tx.execute<{ epoch: number }>(sql`
    update page_dm_threads t
       set head_confirmed_id = null,
           head_confirmed_at = null,
           contiguous_oldest_id = null,
           contiguous_oldest_at = null,
           contiguous_count = 0,
           chain_upward_count = 0,
           chain_epoch = t.chain_epoch + 1,
           history_state = case when t.stored_message_count > 0 then 'unverified' else 'none' end,
           history_proof = null,
           history_proven_at = null,
           history_proof_observation_id = null,
           history_proof_observation_received_at = null,
           history_proof_raw_payload_id = null,
           chain_source = null,
           chain_journal_watermark = 0
     where t.id = ${threadId}
    returning t.chain_epoch as epoch
  `);
  const row = result.rows[0];
  return row ? { epoch: Number(row.epoch) } : null;
}

// ── stored facts (read only) ──────────────────────────────────────────────────

const NUMERIC_MESSAGE_ID = sql.raw(`'^[0-9]{1,30}$'`);

/** The fold's `StoredFacts` (§8.1): non-deleted stored messages of the thread
 *  and the oldest of them by snowflake. Read only for empty pages.
 *  `store: "message_archive"` reads the thread's stored archive messages
 *  instead (dm-archive-store.ts). */
export async function readThreadStoredFacts(
  db: Database,
  threadId: number,
  options: { store?: DmLiveReaderStore } = {},
): Promise<{ nonDeletedCount: number; oldestNonDeletedId: string | null }> {
  const result = await db.execute<{ nonDeletedCount: number; oldestNonDeletedId: string | null }>(
    options.store === "message_archive"
      ? sql`
    select count(*)::int as "nonDeletedCount",
           min(case when ma.message_ref ~ ${NUMERIC_MESSAGE_ID} then ma.message_ref::numeric end)::text
             as "oldestNonDeletedId"
      from ${archiveThreadRowsFromSql(threadId)}
       and ${archiveStoredMessageSql("ma")}
  `
      : sql`
    select count(*)::int as "nonDeletedCount",
           min(case when m.platform_message_id ~ ${NUMERIC_MESSAGE_ID} then m.platform_message_id::numeric end)::text
             as "oldestNonDeletedId"
      from page_dm_messages m
     where m.conversation_id = ${threadId}
       and m.deleted_at is null
  `,
  );
  const row = result.rows[0];
  return { nonDeletedCount: Number(row?.nonDeletedCount ?? 0), oldestNonDeletedId: row?.oldestNonDeletedId ?? null };
}

/** For each probe, how many non-deleted stored messages of the thread are
 *  older (by snowflake) than `beforeId` — the end-rule checks of §8.3. */
export async function countStoredMessagesOlderThan(
  db: Database,
  probes: readonly { threadId: number; beforeId: string }[],
): Promise<number[]> {
  if (probes.length === 0) return [];
  for (const probe of probes) {
    if (!DECIMAL_ID.test(probe.beforeId)) throw new Error(`Not a message id: ${probe.beforeId}`);
  }
  const result = await db.execute<{ ord: string; olderCount: number }>(sql`
    select p.ord::text as ord,
           (select count(*)::int
              from page_dm_messages m
             where m.conversation_id = p.thread_id
               and m.deleted_at is null
               and m.platform_message_id ~ ${NUMERIC_MESSAGE_ID}
               and m.platform_message_id::numeric < p.before_id::numeric) as "olderCount"
      from unnest(
             ${textArrayParam(probes.map((probe) => String(probe.threadId)))}::bigint[],
             ${textArrayParam(probes.map((probe) => probe.beforeId))}
           ) with ordinality as p(thread_id, before_id, ord)
     order by p.ord
  `);
  const counts = new Array<number>(probes.length).fill(0);
  for (const row of result.rows) counts[Number(row.ord) - 1] = Number(row.olderCount);
  return counts;
}

/** The legacy stored-window columns of a page's threads, in id order after
 *  `afterThreadId` (`sync chain check-window` compares them with the window
 *  recomputed from the rows). */
export interface ThreadStoredWindowColumns {
  threadId: number;
  groupId: string;
  storedMessageCount: number;
  newestStoredMessageId: string | null;
  oldestStoredMessageId: string | null;
  lastFanMessageAt: Date | null;
  lastModelMessageAt: Date | null;
}

export async function listThreadStoredWindows(
  db: Database,
  input: { pageId: number; threadId?: number; afterThreadId: number; limit: number },
): Promise<ThreadStoredWindowColumns[]> {
  const threadFilter = input.threadId === undefined ? sql`` : sql`and t.id = ${input.threadId}`;
  const result = await db.execute<{
    threadId: string;
    groupId: string;
    storedMessageCount: number;
    newestStoredMessageId: string | null;
    oldestStoredMessageId: string | null;
    lastFanMessageAt: Date | string | null;
    lastModelMessageAt: Date | string | null;
  }>(sql`
    select t.id::text as "threadId",
           t.platform_conversation_id as "groupId",
           t.stored_message_count as "storedMessageCount",
           t.newest_stored_message_id as "newestStoredMessageId",
           t.oldest_stored_message_id as "oldestStoredMessageId",
           t.last_fan_message_at as "lastFanMessageAt",
           t.last_model_message_at as "lastModelMessageAt"
      from page_dm_threads t
     where t.platform_account_id = ${input.pageId}
       and t.id > ${input.afterThreadId}
       ${threadFilter}
     order by t.id
     limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    threadId: Number(row.threadId),
    groupId: row.groupId,
    storedMessageCount: Number(row.storedMessageCount),
    newestStoredMessageId: row.newestStoredMessageId,
    oldestStoredMessageId: row.oldestStoredMessageId,
    lastFanMessageAt: toDate(row.lastFanMessageAt),
    lastModelMessageAt: toDate(row.lastModelMessageAt),
  }));
}

// ── the legacy journal (read only) ────────────────────────────────────────────

export interface LegacyDmJournalRow {
  id: number;
  requestParams: unknown;
  /** Inline body; null for pointer-only rows (resolve through the payload seam). */
  payload: unknown;
  payloadRef: CapturePayloadRef | null;
  capturedAt: Date;
}

/**
 * `/message` pages of the legacy journal (`sync_raw_payloads`, endpoint and
 * kind `dm_messages`) of one page in id order after `afterId` — the rebuild's
 * source (§8.2). Uses the partial index on `id` of exactly these rows.
 */
export async function listLegacyDmJournalRows(
  db: Database,
  input: { pageId: number; afterId: number; limit: number; groupId?: string; since?: Date },
): Promise<LegacyDmJournalRow[]> {
  const groupFilter = input.groupId === undefined ? sql`` : sql`and rp.request_params->>'groupId' = ${input.groupId}`;
  const sinceFilter = input.since === undefined ? sql`` : sql`and rp.captured_at >= ${input.since}::timestamptz`;
  const result = await db.execute<{
    id: string;
    requestParams: unknown;
    payload: unknown;
    payloadBucketMonth: string | null;
    payloadObjectId: string | null;
    capturedAt: Date | string;
  }>(sql`
    select rp.id::text as id,
           rp.request_params as "requestParams",
           rp.response_payload as payload,
           to_char(rp.payload_bucket_month, 'YYYY-MM-DD') as "payloadBucketMonth",
           rp.payload_object_id::text as "payloadObjectId",
           rp.captured_at as "capturedAt"
      from sync_raw_payloads rp
     where rp.endpoint = 'dm_messages'
       and rp.payload_kind = 'dm_messages'
       and rp.page_id = ${input.pageId}
       and rp.id > ${input.afterId}
       ${groupFilter}
       ${sinceFilter}
     order by rp.id
     limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    id: Number(row.id),
    requestParams: row.requestParams,
    payload: row.payload,
    payloadRef: capturePayloadRefFromColumns(row.payloadBucketMonth, row.payloadObjectId),
    capturedAt: toRequiredDate(row.capturedAt),
  }));
}

// ── the rebuild's write ───────────────────────────────────────────────────────

export type RebuiltThreadChainWrite =
  | { kind: "written"; epochChanged: boolean }
  | { kind: "skipped"; reason: "engine_owned" | "concurrent_write" | "thread_missing" };

/**
 * One rebuilt thread in one short transaction (§8.2): the page row first
 * (lock order; `for share` holds the mode still), then the thread row
 * `for update`, and only then the checks — an engine chain is never
 * overwritten, and a thread another run wrote since this one read it is
 * skipped. A page in `handover`/`live` refuses (the engine is the chain
 * writer there), except `handover` with the switch's own capability.
 */
export async function writeRebuiltThreadChain(
  db: Database,
  input: {
    pageId: number;
    threadId: number;
    chain: ThreadChainState;
    /** The thread's watermark when the run read it. */
    expectedWatermark: number;
    /** The journal id the run folded this thread through. */
    journalWatermark: number;
    handoverCapability?: SyncSwitchCapability;
  },
): Promise<RebuiltThreadChainWrite> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const page = await tx.execute<{ mode: SyncPageMode }>(sql`
      select mode from sync_pages where page_id = ${input.pageId} for share
    `);
    const mode = page.rows[0]?.mode ?? "off";
    const allowed = mode === "off" || mode === "shadow"
      || (mode === "handover" && holdsSyncSwitchCapability(input.handoverCapability, input.pageId));
    if (!allowed) throw new ThreadChainRebuildModeError(input.pageId, mode);

    const locked = await tx.execute<{ chainSource: ThreadChainSource | null; watermark: string }>(sql`
      select chain_source as "chainSource", chain_journal_watermark::text as watermark
        from page_dm_threads
       where id = ${input.threadId} and platform_account_id = ${input.pageId}
         for update
    `);
    const row = locked.rows[0];
    if (!row) return { kind: "skipped", reason: "thread_missing" };
    if (row.chainSource === "engine") return { kind: "skipped", reason: "engine_owned" };
    if (Number(row.watermark) !== input.expectedWatermark) return { kind: "skipped", reason: "concurrent_write" };
    const written = await writeThreadChain(tx, input.threadId, {
      chain: input.chain,
      source: "journal_rebuild",
      journalWatermark: input.journalWatermark,
    });
    return { kind: "written", epochChanged: written.epochChanged };
  });
}

export interface ChainRebuildRunRecord {
  auditEventId: number;
  createdAt: Date;
  /** The journal id the run scanned through. */
  throughRawId: number;
}

/** The latest page-wide `--write` rebuild of the page that reached the end of
 *  the journal: an incremental run starts after it, and the step-3 switch
 *  requires one (D21). */
export async function getLatestCompletedChainRebuild(
  db: Database,
  pageId: number,
): Promise<ChainRebuildRunRecord | null> {
  const result = await db.execute<{ id: string; createdAt: Date | string; throughRawId: string }>(sql`
    select a.id::text as id, a.created_at as "createdAt", a.metadata->>'throughRawId' as "throughRawId"
      from audit_events a
     where a.event_type = ${SYNC_CHAIN_REBUILD_AUDIT_EVENT}
       and a.platform_account_id = ${pageId}
       and a.metadata->>'scope' = 'page'
       and a.metadata->>'completed' = 'true'
       and a.metadata->>'throughRawId' ~ '^[0-9]+$'
     order by a.id desc
     limit 1
  `);
  const row = result.rows[0];
  return row
    ? { auditEventId: Number(row.id), createdAt: toRequiredDate(row.createdAt), throughRawId: Number(row.throughRawId) }
    : null;
}

// ── legacy coverage columns on engine-owned pages ─────────────────────────────

export interface LegacySummaryInsertedRow {
  platformMessageId: string;
  createdAt: Date;
  senderRole: "fan" | "model" | "system" | "unknown";
}

function extremeId(ids: readonly string[], pick: "max" | "min"): string | null {
  let best: { id: string; value: bigint } | null = null;
  for (const id of ids) {
    if (!DECIMAL_ID.test(id)) continue;
    const value = BigInt(id);
    if (best === null || (pick === "max" ? value > best.value : value < best.value)) best = { id, value };
  }
  return best?.id ?? null;
}

function latestAt(rows: readonly LegacySummaryInsertedRow[], role: LegacySummaryInsertedRow["senderRole"]): Date | null {
  let latest: Date | null = null;
  for (const row of rows) {
    if (row.senderRole === role && (latest === null || row.createdAt > latest)) latest = row.createdAt;
  }
  return latest;
}

/**
 * The 0231 marking for one page at its switch (design step 3 §3.5 item 7,
 * I.5): messages the legacy engine stored are not proof (plan §6.3), so a
 * thread with stored messages and no chain yet is `unverified` until a read
 * proves one. Runs only while the switch holds the page in `handover`; the
 * chain columns keep their one writer module (I9). Returns how many threads
 * it marked.
 */
export async function markPageThreadsUnverified(tx: Database, pageId: number): Promise<number> {
  const result = await tx.execute(sql`
    update page_dm_threads t
       set history_state = 'unverified',
           updated_at = clock_timestamp()
      from sync_pages sp
     where t.platform_account_id = ${pageId}
       and sp.page_id = t.platform_account_id
       and sp.mode = 'handover'
       and t.history_state = 'none'
       and t.stored_message_count > 0
  `);
  return result.rowCount ?? 0;
}

/**
 * Keep the legacy coverage columns honest for legacy readers on a page the
 * engine owns (design §5.4 step 6), in the DM apply's transaction after
 * `writeThreadChain`. Asserts in the same statement that the thread's page is
 * `handover` or `live` and throws `LegacyThreadSummaryRefusedError` otherwise
 * (never on a legacy page, I9).
 *
 * Incremental, from the rows this apply INSERTED (new, hence not deleted):
 * `stored_message_count` grows by their number, newest/oldest stored ids move
 * by snowflake comparison, last fan/model times by `greatest`; no per-thread
 * scan (`sync chain check-window` compares the result offline). The coverage
 * verdict follows the effective history state (complete → complete, partial |
 * unverified → partial_window, none → pending_backfill), and a head read
 * raises `last_message_sync_at` to its send time, never backwards.
 */
export async function syncLegacyThreadSummary(
  tx: Database,
  threadId: number,
  input: { inserted: readonly LegacySummaryInsertedRow[]; headReadAt: Date | null },
): Promise<{ storedMessageCount: number; messageCoverageStatus: ThreadChainRow["messageCoverageStatus"] }> {
  const ids = input.inserted.map((row) => row.platformMessageId);
  const newest = extremeId(ids, "max");
  const oldest = extremeId(ids, "min");
  const added = input.inserted.length;
  const newCount = sql`(t.stored_message_count + ${added}::int)`;
  const effective = sql`(case when t.history_state = 'none' and ${newCount} > 0 then 'unverified' else t.history_state end)`;
  const result = await tx.execute<{ storedMessageCount: number; messageCoverageStatus: ThreadChainRow["messageCoverageStatus"] }>(sql`
    update page_dm_threads t
       set stored_message_count = ${newCount},
           newest_stored_message_id = case
             when ${newest}::text is null then t.newest_stored_message_id
             when t.newest_stored_message_id is null or t.newest_stored_message_id !~ ${NUMERIC_MESSAGE_ID}
               then ${newest}::text
             when ${newest}::numeric > t.newest_stored_message_id::numeric then ${newest}::text
             else t.newest_stored_message_id end,
           oldest_stored_message_id = case
             when ${oldest}::text is null then t.oldest_stored_message_id
             when t.oldest_stored_message_id is null or t.oldest_stored_message_id !~ ${NUMERIC_MESSAGE_ID}
               then ${oldest}::text
             when ${oldest}::numeric < t.oldest_stored_message_id::numeric then ${oldest}::text
             else t.oldest_stored_message_id end,
           last_fan_message_at = greatest(t.last_fan_message_at, ${latestAt(input.inserted, "fan")}::timestamptz),
           last_model_message_at = greatest(t.last_model_message_at, ${latestAt(input.inserted, "model")}::timestamptz),
           message_coverage_status = (case ${effective}
             when 'complete' then 'complete'
             when 'none' then 'pending_backfill'
             else 'partial_window' end)::dm_message_coverage_status,
           message_backfill_complete = (${effective} = 'complete'),
           last_message_sync_at = case
             when ${input.headReadAt}::timestamptz is null then t.last_message_sync_at
             else greatest(coalesce(t.last_message_sync_at, ${input.headReadAt}::timestamptz), ${input.headReadAt}::timestamptz)
           end,
           updated_at = clock_timestamp()
      from sync_pages sp
     where t.id = ${threadId}
       and sp.page_id = t.platform_account_id
       and sp.mode in ('handover', 'live')
    returning t.stored_message_count as "storedMessageCount",
              t.message_coverage_status::text as "messageCoverageStatus"
  `);
  const row = result.rows[0];
  if (row) {
    return { storedMessageCount: Number(row.storedMessageCount), messageCoverageStatus: row.messageCoverageStatus };
  }
  const why = await tx.execute<{ mode: SyncPageMode | null }>(sql`
    select sp.mode
      from page_dm_threads t
      left join sync_pages sp on sp.page_id = t.platform_account_id
     where t.id = ${threadId}
  `);
  const found = why.rows[0];
  throw new LegacyThreadSummaryRefusedError(threadId, found?.mode ?? null, found !== undefined);
}

/**
 * Keep the legacy stored window of one thread honest after a WebSocket
 * deletion marked a row of it on a page the engine owns (design §3.3 item 4,
 * E7): `stored_message_count`, `newest/oldest_stored_message_id` and
 * `last_fan/model_message_at`, recomputed from the thread's live rows
 * (`page_dm_messages where deleted_at is null`, the window summary of
 * `getPageDmMessageWindowSummary`). The head fields are the conversation
 * list's, the coverage verdict follows the chain (a deletion changes neither),
 * and the chain columns are untouched. Asserts in the same statement that the
 * thread's page is `handover` or `live` and throws
 * `LegacyThreadSummaryRefusedError` otherwise (I9), like
 * `syncLegacyThreadSummary`.
 */
export async function syncLegacyThreadSummaryAfterDeletion(
  tx: Database,
  threadId: number,
): Promise<{ storedMessageCount: number }> {
  const result = await tx.execute<{ storedMessageCount: number }>(sql`
    update page_dm_threads t
       set stored_message_count = s.stored_count,
           newest_stored_message_id = s.newest_id,
           oldest_stored_message_id = s.oldest_id,
           last_fan_message_at = s.last_fan_at,
           last_model_message_at = s.last_model_at,
           updated_at = clock_timestamp()
      from sync_pages sp,
           (select count(*)::int as stored_count,
                   (array_agg(m.platform_message_id order by m.created_at desc, m.platform_message_id desc, m.id desc))[1] as newest_id,
                   (array_agg(m.platform_message_id order by m.created_at asc, m.platform_message_id asc, m.id asc))[1] as oldest_id,
                   max(m.created_at) filter (where m.sender_role = 'fan') as last_fan_at,
                   max(m.created_at) filter (where m.sender_role = 'model') as last_model_at
              from page_dm_messages m
             where m.conversation_id = ${threadId}
               and m.deleted_at is null) s
     where t.id = ${threadId}
       and sp.page_id = t.platform_account_id
       and sp.mode in ('handover', 'live')
    returning t.stored_message_count as "storedMessageCount"
  `);
  const row = result.rows[0];
  if (row) return { storedMessageCount: Number(row.storedMessageCount) };
  const why = await tx.execute<{ mode: SyncPageMode | null }>(sql`
    select sp.mode
      from page_dm_threads t
      left join sync_pages sp on sp.page_id = t.platform_account_id
     where t.id = ${threadId}
  `);
  const found = why.rows[0];
  throw new LegacyThreadSummaryRefusedError(threadId, found?.mode ?? null, found !== undefined);
}
