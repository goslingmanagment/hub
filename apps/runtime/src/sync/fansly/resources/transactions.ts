import { sql } from "drizzle-orm";

import {
  countTransactionsBySource,
  getOldestPendingTransactionAt,
  getPageTransactionsWriterInfo,
  rebuildRevenueRollups,
  rebuildSpenderProjections,
  upsertFanslyTransactionWithEarningsDirty,
  type Database,
} from "@agency_hub_core/db";
import {
  isKnownFanslyTransactionType,
  type FanslyEarningsTransaction,
  type FanslyTransactionsPageContract,
} from "@agency_hub_core/fansly";

import { upsertHydratedFansForPage } from "../lib/fan-hydration.ts";
import {
  findTransactionPageOverlap,
  inWindowItemsAfterOlder,
  mapFanslyTransactionItem,
} from "../lib/money-rules.ts";
import { WrongTransactionsWriterError } from "../../../services/transactions-writer-gate.ts";
import { ApplyQuarantine } from "../../engine/commit.ts";
import type {
  ApplyInput,
  ApplyResult,
  DemandSignal,
  ResourceModule,
  ShadowResult,
  StepPlan,
  WorkOutcome,
} from "../../engine/resource.ts";
import { advanceShadowWalk, offsetPageDone, offsetWalkPages, type ShadowWalkProgress } from "../lib/offset-walk.ts";
import { fanEarningsRosterFollowups } from "./fan-earnings.ts";
import { lookupFollowups, partitionLookupIds } from "./fan-profiles.ts";
import { purchaseTargetFollowups, purchaseTargetsOfTransactions } from "./purchases.ts";

// `transactions.head`, `.insurance`, `.rescan`, `.backfill` (plan §5, §7 p.5;
// design §5.6): the wallet earnings ledger from
// `GET /account/wallets/earnings/transactions?limit=<L>&offset=<O>` (never
// `after`/`before`: a bound makes `total` disagree with the rows), journaled
// as `earnings_transactions`, one page per step.
//
// - head (urgent, a WS money signal) and insurance (planned, every 5 min,
//   owner decision №5): pages of 20 [A2] from offset 0 until a page holds a
//   transaction already stored with the served status and every id the
//   signals named has been served — or the list ends. A walk that reaches
//   offset 200 without that closes `escalated` and makes the rescan due [D6].
// - rescan (planned, hourly): the legacy incremental window — from the
//   checkpoint minus 7 days, or the oldest pending row if older, never past 30
//   days — in pages of 100, early-stopped by the first page reaching below
//   the window; `total` stable and no row served twice, else the walk starts
//   over (bounded); a full read must fetch `total` rows.
// - backfill (owner, a new page): the whole list in pages of 100, `total`
//   stable, fetched = total.
//
// Every page is one apply transaction: the erasure fence (registry fence
// `dm`: the writer below takes it again, re-entrantly), the fans of the page
// ensured (their profiles asked of `fan-profiles.lookup`, never a second
// request in the step), each row through the legacy writer
// `upsertFanslyTransactionWithEarningsDirty` with its observation id, the
// spender and revenue projections rebuilt from the page's oldest row, and
// the follow-ups: the purchase targets of NEW PPV rows, and the fan-earnings
// roster when a subject is due. Canonicalization (`transaction.posted`) is
// the engine's, from the same observation.
//
// The single-writer gate (`pages.transactions_writer = 'fansly'`) is an
// admission precondition: a page whose ledger has another writer sends no
// request — its transactions work waits on `dependency` — and an apply that
// finds the writer changed under it throws `WrongTransactionsWriterError`
// (deterministic: the file is held, the step quarantined).

export type TransactionsVariant = "head" | "insurance" | "rescan" | "backfill";

/** [A2] Rows per head page (`probe.manual` checks the route honours it;
 *  fallback 100). */
export const TRANSACTIONS_HEAD_LIMIT = 20;
export const TRANSACTIONS_SCAN_LIMIT = 100;
/** [D6] A head walk that reaches this offset hands over to the rescan. */
export const TRANSACTIONS_HEAD_ESCALATE_OFFSET = 200;
const DAY_MS = 86_400_000;
/** The rescan window (registry parameters; today's production values of the
 *  legacy keys `transactionLookbackDays` / `transactionRescanCapDays`). */
export const TRANSACTIONS_LOOKBACK_MS = 7 * DAY_MS;
export const TRANSACTIONS_RESCAN_CAP_MS = 30 * DAY_MS;
/** Restarts of an unstable scan (total moved, rows served twice, fetched ≠
 *  total) before the walk closes withheld. */
export const TRANSACTIONS_MAX_WALK_RESTARTS = 2;
export const TRANSACTIONS_WALK_RESTART_DELAY_MS = 60_000;
/** A page whose ledger has another writer re-checks this often. */
export const TRANSACTIONS_WRONG_WRITER_RECHECK_MS = 30 * 60_000;

type RestartReason = "total_changed" | "offset_overlap" | "total_mismatch" | "empty_page_before_done";

interface TransactionsWalk {
  /** ISO: the admission of the walk's first page. */
  startedAt: string;
  offset: number;
  pages: number;
  fetched: number;
  /** `total` as the first page stated it. */
  total: number | null;
  lastPageIds: string[];
  /** Rescan: the local lower bound (ISO), never sent. */
  after: string | null;
  /** The newest `createdAt` seen (ISO), the rescan's next checkpoint. */
  newestSeenAt: string | null;
  /** Head: the ids the signals named that a page has served. */
  seenDemanded: string[];
}

export interface TransactionsCursor {
  /** Rescan: the newest `createdAt` a finished scan saw (ISO). */
  cursorTimestamp: string | null;
  walk: TransactionsWalk | null;
  /** The next walk starts over an unstable one (its restart count). */
  restartCount: number;
  /** The receipt of the last finished walk. */
  last: Record<string, unknown> | null;
  shadow: ShadowWalkProgress | null;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function iso(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseWalk(value: unknown): TransactionsWalk | null {
  const record = recordOf(value);
  const offset = count(record.offset);
  const startedAt = iso(record.startedAt);
  if (offset === null || startedAt === null) return null;
  return {
    startedAt,
    offset,
    pages: count(record.pages) ?? 0,
    fetched: count(record.fetched) ?? 0,
    total: count(record.total),
    lastPageIds: strings(record.lastPageIds),
    after: iso(record.after),
    newestSeenAt: iso(record.newestSeenAt),
    seenDemanded: strings(record.seenDemanded),
  };
}

export function parseTransactionsCursor(value: unknown): TransactionsCursor {
  const record = recordOf(value);
  const shadow = recordOf(record.shadow);
  return {
    cursorTimestamp: iso(record.cursorTimestamp),
    walk: parseWalk(record.walk),
    restartCount: count(record.restartCount) ?? 0,
    last: typeof record.last === "object" && record.last !== null ? record.last as Record<string, unknown> : null,
    shadow: count(shadow.steps) !== null && count(shadow.done) !== null
      ? { steps: count(shadow.steps)!, done: count(shadow.done)! }
      : null,
  };
}

function limitOf(variant: TransactionsVariant): number {
  return variant === "head" || variant === "insurance" ? TRANSACTIONS_HEAD_LIMIT : TRANSACTIONS_SCAN_LIMIT;
}

function maxIso(a: string | null, b: Date | null): string | null {
  if (b === null) return a;
  if (a === null) return b.toISOString();
  return Date.parse(a) >= b.getTime() ? a : b.toISOString();
}

/**
 * The rescan's local lower bound at a walk's start (the legacy incremental
 * scan's rule): the checkpoint minus the lookback, or the
 * oldest pending row if older, clamped to the rescan cap — but never above
 * the checkpoint itself (cursor + 1 ms keeps the cursor row older, so a quiet
 * page still stops on the page that holds it).
 */
export function rescanLowerBound(input: {
  cursorTimestamp: Date | null;
  oldestPendingAt: Date | null;
  now: Date;
  lookbackMs?: number;
  capMs?: number;
}): { after: Date | null; clamped: boolean } {
  const lookbackStart = input.cursorTimestamp === null
    ? null
    : new Date(input.cursorTimestamp.getTime() - (input.lookbackMs ?? TRANSACTIONS_LOOKBACK_MS));
  const earliest = lookbackStart !== null && input.oldestPendingAt !== null
    ? (input.oldestPendingAt < lookbackStart ? input.oldestPendingAt : lookbackStart)
    : (lookbackStart ?? input.oldestPendingAt);
  const capStart = new Date(input.now.getTime() - (input.capMs ?? TRANSACTIONS_RESCAN_CAP_MS));
  let after = earliest !== null && earliest < capStart ? capStart : earliest;
  const clamped = after !== earliest;
  if (after !== null && input.cursorTimestamp !== null && after > input.cursorTimestamp) {
    after = new Date(input.cursorTimestamp.getTime() + 1);
  }
  return { after, clamped };
}

/**
 * The head walk's stop rule (design §5.6): a page that holds a transaction
 * already stored with the served status, once every id the signals named has
 * been served; or the end of the list.
 */
export function headWalkDecision(input: {
  offset: number;
  itemCount: number;
  total: number | null;
  knownUnchanged: boolean;
  demanded: readonly string[];
  demandOverflow: boolean;
  seenDemanded: readonly string[];
}): { stop: "known_item" | "end" | "escalated" | null; unseen: string[] } {
  const seen = new Set(input.seenDemanded);
  const unseen = input.demanded.filter((id) => !seen.has(id));
  const allSeen = unseen.length === 0 && !input.demandOverflow;
  if (input.knownUnchanged && allSeen) return { stop: "known_item", unseen };
  if (offsetPageDone({ offset: input.offset, itemCount: input.itemCount, limit: TRANSACTIONS_HEAD_LIMIT, total: input.total })) {
    return { stop: "end", unseen };
  }
  if (input.offset + input.itemCount >= TRANSACTIONS_HEAD_ESCALATE_OFFSET) return { stop: "escalated", unseen };
  return { stop: null, unseen };
}

async function writerIsFansly(db: Database, pageId: number): Promise<{ ok: boolean; assigned: string | null }> {
  const info = await getPageTransactionsWriterInfo(db, pageId);
  const assigned = info?.transactionsWriter ?? null;
  return { ok: info !== null && assigned === "fansly", assigned };
}

async function storedRawStatuses(db: Database, pageId: number, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const result = await db.execute<{ id: string; rawStatus: string }>(sql`
    select transaction_id as id, raw_status as "rawStatus" from transactions
     where platform_account_id = ${pageId} and transaction_id = any(${sql.param([...ids])}::text[])
  `);
  return new Map(result.rows.map((row) => [row.id, String(row.rawStatus)] as const));
}

async function newestLedgerAt(db: Database, pageId: number): Promise<Date | null> {
  const result = await db.execute<{ at: Date | string | null }>(sql`
    select max(occurred_at) as at from transactions where platform_account_id = ${pageId} and source = 'fansly:rest'
  `);
  const raw = result.rows[0]?.at ?? null;
  return raw === null ? null : new Date(raw);
}

async function pageCommissionRate(db: Database, pageId: number): Promise<number> {
  const result = await db.execute<{ rate: number | string | null }>(sql`
    select commission_rate as rate from pages where id = ${pageId}
  `);
  const rate = Number(result.rows[0]?.rate ?? 0);
  return Number.isFinite(rate) ? rate : 0;
}

interface PageWrite {
  /** A served row was already stored with the served status. */
  knownUnchanged: boolean;
  followups: DemandSignal[];
  counters: Record<string, number>;
}

/** One served page into the ledger (the apply's writes, in lock order:
 *  hot tables only; the follow-ups are upserted by the engine afterwards). */
async function writeTransactionsPage(
  tx: Database,
  input: ApplyInput,
  key: string,
  items: readonly FanslyEarningsTransaction[],
): Promise<PageWrite> {
  const pageId = input.pageId;
  const writer = await writerIsFansly(tx, pageId);
  if (!writer.ok) {
    throw new WrongTransactionsWriterError({ platformAccountId: pageId, attemptedWriter: "fansly", assignedWriter: writer.assigned });
  }
  const counters: Record<string, number> = { rows: items.length };
  const stored = await storedRawStatuses(tx, pageId, items.map((item) => item.transactionId));
  const knownUnchanged = items.some((item) => stored.get(item.transactionId) === String(item.status));

  // Fans: every correlation account is ensured (unverified); the profiles not
  // read through the page within the day go to the lookup walk.
  const correlationIds = [...new Set(items.flatMap((item) => (item.correlationAccountId ? [item.correlationAccountId] : [])))];
  const lookup = await partitionLookupIds(tx, { pageId, ids: correlationIds, now: input.now });
  const fanMap = await upsertHydratedFansForPage(tx, {
    platformAccountId: pageId,
    accounts: [],
    unverifiedIds: lookup.due,
    reusedIds: lookup.fresh,
  });

  const commissionRate = await pageCommissionRate(tx, pageId);
  let dirtyFrom: Date | null = null;
  for (const item of items) {
    if (!isKnownFanslyTransactionType(item.type)) counters.unknown_type = (counters.unknown_type ?? 0) + 1;
    const { row, commissionFellBack } = mapFanslyTransactionItem(item, commissionRate);
    if (commissionFellBack) counters.commission_fallback = (counters.commission_fallback ?? 0) + 1;
    await upsertFanslyTransactionWithEarningsDirty(tx, {
      platformAccountId: pageId,
      source: "fansly:rest",
      fanId: item.correlationAccountId ? (fanMap.get(item.correlationAccountId) ?? null) : null,
      sourceObservationId: input.observation.id,
      ...row,
    });
    if (dirtyFrom === null || row.occurredAt < dirtyFrom) dirtyFrom = row.occurredAt;
  }
  if (dirtyFrom !== null) {
    await rebuildSpenderProjections(tx, pageId, dirtyFrom);
    await rebuildRevenueRollups(tx, pageId, dirtyFrom);
  }

  // PPV sales first seen now name the order histories to read.
  const fresh = items.filter((item) => !stored.has(item.transactionId));
  const purchases = purchaseTargetsOfTransactions(fresh.map((item) => ({ rawType: item.type, correlationId: item.correlationId })));
  if (purchases.conflicts.length > 0) counters.purchase_target_conflict = purchases.conflicts.length;
  if (fresh.length > 0) counters.new_rows = fresh.length;
  const followups: DemandSignal[] = [
    ...lookupFollowups(lookup.due, key),
    ...purchaseTargetFollowups(purchases.targets, key),
    // After the writer's dirty marks (stamped with the wall clock as it ran).
    ...(await fanEarningsRosterFollowups(tx, { pageId, now: new Date(), shadow: false, reason: key })),
  ];
  return { knownUnchanged, followups, counters };
}

function restartOutcome(
  cursor: TransactionsCursor,
  walk: TransactionsWalk,
  reason: RestartReason,
  now: Date,
  detail: Record<string, unknown> = {},
): WorkOutcome {
  return {
    satisfiesRevision: false,
    nextDueAt: new Date(now.getTime() + TRANSACTIONS_WALK_RESTART_DELAY_MS),
    waitingReason: "not_due",
    cursor: { ...cursor, walk: null, restartCount: cursor.restartCount + 1, shadow: null } satisfies TransactionsCursor,
    result: { restartReason: reason, restartCount: cursor.restartCount + 1, pages: walk.pages, ...detail },
  };
}

function withheldOutcome(
  cursor: TransactionsCursor,
  walk: TransactionsWalk,
  reason: RestartReason,
  detail: Record<string, unknown> = {},
): WorkOutcome {
  const receipt = { withheld: reason, pages: walk.pages, fetched: walk.fetched, total: walk.total, ...detail };
  return {
    satisfiesRevision: true,
    close: "done",
    closeReason: "walk_withheld",
    cursor: { ...cursor, walk: null, restartCount: 0, last: receipt, shadow: null } satisfies TransactionsCursor,
    proof: receipt,
  };
}

/** A restart while the bound allows one, else the walk closes withheld. */
function unstable(
  cursor: TransactionsCursor,
  walk: TransactionsWalk,
  reason: RestartReason,
  now: Date,
  detail: Record<string, unknown> = {},
): ApplyResult {
  return cursor.restartCount < TRANSACTIONS_MAX_WALK_RESTARTS
    ? { work: restartOutcome(cursor, walk, reason, now, detail), followups: [], counters: { [`walk_restart_${reason}`]: 1 } }
    : { work: withheldOutcome(cursor, walk, reason, detail), followups: [], counters: { walk_withheld: 1 } };
}

export function transactionsModule(variant: TransactionsVariant): ResourceModule {
  const key = `transactions.${variant}`;
  const limit = limitOf(variant);

  async function applyHead(tx: Database, input: ApplyInput, page: FanslyTransactionsPageContract, cursor: TransactionsCursor): Promise<ApplyResult> {
    const walk: TransactionsWalk = cursor.walk ?? {
      startedAt: input.attempt.admittedAt.toISOString(),
      offset: 0,
      pages: 0,
      fetched: 0,
      total: null,
      lastPageIds: [],
      after: null,
      newestSeenAt: null,
      seenDemanded: [],
    };
    const write = await writeTransactionsPage(tx, input, key, page.data);
    const demanded = input.work.demand.txIds;
    const served = new Set(page.data.map((item) => item.transactionId));
    const seenDemanded = [...new Set([...walk.seenDemanded, ...demanded.filter((id) => served.has(id))])];
    const decision = headWalkDecision({
      offset: walk.offset,
      itemCount: page.data.length,
      total: page.total,
      knownUnchanged: write.knownUnchanged,
      demanded,
      demandOverflow: input.work.demand.overflow,
      seenDemanded,
    });
    const next: TransactionsWalk = {
      ...walk,
      offset: walk.offset + page.data.length,
      pages: walk.pages + 1,
      fetched: walk.fetched + page.data.length,
      total: walk.total ?? page.total,
      lastPageIds: page.data.map((item) => item.transactionId),
      seenDemanded,
    };
    if (decision.stop === null) {
      return {
        work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { ...cursor, walk: next, shadow: null } },
        followups: write.followups,
        counters: write.counters,
      };
    }
    const receipt = {
      stop: decision.stop,
      pages: next.pages,
      fetched: next.fetched,
      total: page.total,
      ...(decision.unseen.length === 0 ? {} : { demandUnseen: decision.unseen.slice(0, 20) }),
    };
    const followups = decision.stop === "escalated"
      ? [...write.followups, { resource: "transactions.rescan", demand: { reason: `escalated:${key}` } } satisfies DemandSignal]
      : write.followups;
    return {
      work: {
        satisfiesRevision: true,
        close: "done",
        closeReason: decision.stop,
        cursor: { ...cursor, walk: null, last: receipt, shadow: null },
        proof: receipt,
      },
      followups,
      counters: {
        ...write.counters,
        ...(decision.stop === "escalated" ? { head_escalated: 1 } : {}),
        ...(decision.unseen.length > 0 ? { demand_unseen: decision.unseen.length } : {}),
      },
    };
  }

  async function applyRescan(tx: Database, input: ApplyInput, page: FanslyTransactionsPageContract, cursor: TransactionsCursor): Promise<ApplyResult> {
    const items = page.data;
    let walk = cursor.walk;
    const counters: Record<string, number> = {};
    if (walk === null) {
      const checkpoint = cursor.cursorTimestamp === null ? await newestLedgerAt(tx, input.pageId) : new Date(cursor.cursorTimestamp);
      const bound = rescanLowerBound({
        cursorTimestamp: checkpoint,
        oldestPendingAt: await getOldestPendingTransactionAt(tx, input.pageId),
        now: input.now,
      });
      if (bound.clamped) counters.rescan_cap_clamped = 1;
      walk = {
        startedAt: input.attempt.admittedAt.toISOString(),
        offset: 0,
        pages: 0,
        fetched: 0,
        total: null,
        lastPageIds: [],
        after: bound.after?.toISOString() ?? null,
        newestSeenAt: checkpoint?.toISOString() ?? null,
        seenDemanded: [],
      };
    }
    // Offsets index one provider snapshot: a moved total or a row served on
    // two pages means this walk can no longer be certified (the page is not
    // written; its observation stays journaled).
    if (walk.total !== null && page.total !== walk.total) {
      return unstable(cursor, walk, "total_changed", input.now, { previousTotal: walk.total, total: page.total });
    }
    const overlap = findTransactionPageOverlap(walk.lastPageIds, items);
    if (overlap.length > 0) {
      return unstable(cursor, walk, "offset_overlap", input.now, { overlap: overlap.slice(0, 10) });
    }
    const write = await writeTransactionsPage(tx, input, key, items);
    const after = walk.after === null ? null : new Date(walk.after);
    if (after !== null && inWindowItemsAfterOlder(items, after).length > 0) counters.listing_unordered = 1;
    const olderInPage = after === null ? 0 : items.filter((item) => item.createdAt < after.getTime()).length;
    const done = offsetPageDone({ offset: walk.offset, itemCount: items.length, limit, total: page.total });
    const earlyStopped = olderInPage > 0 && !done;
    const newest = items.reduce<Date | null>((latest, item) => {
      const at = new Date(item.createdAt);
      return latest === null || at > latest ? at : latest;
    }, null);
    const next: TransactionsWalk = {
      ...walk,
      offset: walk.offset + items.length,
      pages: walk.pages + 1,
      fetched: walk.fetched + items.length,
      total: walk.total ?? page.total,
      lastPageIds: items.map((item) => item.transactionId),
      newestSeenAt: maxIso(walk.newestSeenAt, newest),
    };
    const allCounters = { ...write.counters, ...counters };
    if (!done && !earlyStopped) {
      return {
        work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { ...cursor, walk: next, shadow: null } },
        followups: write.followups,
        counters: allCounters,
      };
    }
    if (!earlyStopped && next.total !== null && next.fetched !== next.total) {
      const result = unstable(cursor, next, "total_mismatch", input.now, { total: next.total, fetched: next.fetched });
      return { ...result, followups: write.followups, counters: { ...allCounters, ...result.counters } };
    }
    // Whole-ledger completeness: every listed row is stored under
    // `fansly:rest` and captured rows are never deleted, so the ledger holds
    // at least the lifetime total — or a hole outside this window needs a
    // backfill (metric; alert 4 `transactions_ledger_incomplete`).
    const ledgerRows = await countTransactionsBySource(tx, { platformAccountId: input.pageId, source: "fansly:rest" });
    const receipt = {
      after: next.after,
      walkStartedAt: next.startedAt,
      pages: next.pages,
      fetched: next.fetched,
      total: next.total,
      earlyStopped,
      ledgerRows,
      ...(next.total !== null && ledgerRows < next.total ? { ledgerIncomplete: next.total - ledgerRows } : {}),
    };
    return {
      work: {
        satisfiesRevision: true,
        close: "done",
        closeReason: earlyStopped ? "early_stop" : "end",
        cursor: { cursorTimestamp: next.newestSeenAt, walk: null, restartCount: 0, last: receipt, shadow: null },
        proof: receipt,
      },
      followups: write.followups,
      counters: {
        ...allCounters,
        ...(next.total !== null && ledgerRows < next.total ? { ledger_incomplete: 1 } : {}),
      },
    };
  }

  async function applyBackfill(tx: Database, input: ApplyInput, page: FanslyTransactionsPageContract, cursor: TransactionsCursor): Promise<ApplyResult> {
    const items = page.data;
    const walk: TransactionsWalk = cursor.walk ?? {
      startedAt: input.attempt.admittedAt.toISOString(),
      offset: 0,
      pages: 0,
      fetched: 0,
      total: null,
      lastPageIds: [],
      after: null,
      newestSeenAt: null,
      seenDemanded: [],
    };
    if (walk.total !== null && page.total !== walk.total) {
      return unstable(cursor, walk, "total_changed", input.now, { previousTotal: walk.total, total: page.total });
    }
    const done = offsetPageDone({ offset: walk.offset, itemCount: items.length, limit, total: page.total });
    if (items.length === 0 && (!done || (walk.offset === 0 && page.total > 0))) {
      return unstable(cursor, walk, "empty_page_before_done", input.now, { total: page.total, offset: walk.offset });
    }
    const overlap = findTransactionPageOverlap(walk.lastPageIds, items);
    if (overlap.length > 0) {
      return unstable(cursor, walk, "offset_overlap", input.now, { overlap: overlap.slice(0, 10) });
    }
    const write = await writeTransactionsPage(tx, input, key, items);
    const newest = items.reduce<Date | null>((latest, item) => {
      const at = new Date(item.createdAt);
      return latest === null || at > latest ? at : latest;
    }, null);
    const next: TransactionsWalk = {
      ...walk,
      offset: walk.offset + items.length,
      pages: walk.pages + 1,
      fetched: walk.fetched + items.length,
      total: walk.total ?? page.total,
      lastPageIds: items.map((item) => item.transactionId),
      newestSeenAt: maxIso(walk.newestSeenAt, newest),
    };
    if (!done) {
      return {
        work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { ...cursor, walk: next, shadow: null } },
        followups: write.followups,
        counters: write.counters,
      };
    }
    // A short last page with a stable total is no drift; a fetched count that
    // still differs from it closes the backfill withheld for the owner.
    if (next.total !== null && next.fetched !== next.total) {
      return {
        work: withheldOutcome(cursor, next, "total_mismatch", { total: next.total, fetched: next.fetched }),
        followups: write.followups,
        counters: { ...write.counters, walk_withheld: 1 },
      };
    }
    const receipt = { walkStartedAt: next.startedAt, pages: next.pages, fetched: next.fetched, total: next.total };
    return {
      work: {
        satisfiesRevision: true,
        close: "done",
        closeReason: "backfill_complete",
        cursor: { ...cursor, walk: null, restartCount: 0, last: receipt, shadow: null },
        proof: receipt,
      },
      followups: write.followups,
      counters: write.counters,
    };
  }

  return {
    async plan(work, ctx): Promise<StepPlan> {
      const writer = await writerIsFansly(ctx.db, ctx.pageId);
      if (!writer.ok) {
        return { kind: "wait", reason: "dependency", until: new Date(ctx.now.getTime() + TRANSACTIONS_WRONG_WRITER_RECHECK_MS) };
      }
      const cursor = parseTransactionsCursor(work.cursor);
      if (variant === "rescan" && cursor.walk === null && cursor.cursorTimestamp === null &&
        (await countTransactionsBySource(ctx.db, { platformAccountId: ctx.pageId, source: "fansly:rest" })) === 0) {
        // Nothing stored yet: the window has no checkpoint to reach back from.
        const enqueue: DemandSignal[] = [{ resource: "transactions.backfill", demand: { reason: `dependency:${key}` } }];
        return { kind: "wait", reason: "dependency", until: new Date(ctx.now.getTime() + TRANSACTIONS_WRONG_WRITER_RECHECK_MS), enqueue };
      }
      const offset = ctx.shadow
        ? (cursor.shadow?.done ?? 0) * limit
        : cursor.walk?.offset ?? 0;
      return { kind: "request", request: { spec: "transactions.page", params: { limit, offset } } };
    },

    async apply(tx, input: ApplyInput): Promise<ApplyResult> {
      const page = input.parsed as FanslyTransactionsPageContract;
      const cursor = parseTransactionsCursor(input.work.cursor);
      const requestedOffset = count(recordOf(input.request.params).offset);
      const walkOffset = cursor.walk?.offset ?? 0;
      if (requestedOffset !== walkOffset) {
        throw new ApplyQuarantine("transactions_cursor_mismatch", { requestedOffset, walkOffset });
      }
      switch (variant) {
        case "head":
        case "insurance":
          return applyHead(tx, input, page, cursor);
        case "rescan":
          return applyRescan(tx, input, page, cursor);
        case "backfill":
          return applyBackfill(tx, input, page, cursor);
      }
    },

    async shadow(work, _request, ctx): Promise<ShadowResult> {
      const cursor = parseTransactionsCursor(work.cursor);
      // What the live step would ask of the roster walk; purchase targets and
      // profiles need the answer, so shadow names none.
      const followups = await fanEarningsRosterFollowups(ctx.db, { pageId: ctx.pageId, now: ctx.now, shadow: true, reason: key });
      if (variant !== "backfill") {
        return {
          work: { satisfiesRevision: true, close: "done", closeReason: "shadow", cursor: { ...cursor, shadow: null } },
          followups,
        };
      }
      const stored = await countTransactionsBySource(ctx.db, { platformAccountId: ctx.pageId, source: "fansly:rest" });
      const step = advanceShadowWalk(cursor.shadow, () => offsetWalkPages({ total: stored, limit, statedTotal: true }));
      return step.finished
        ? { work: { satisfiesRevision: true, close: "done", closeReason: "shadow", cursor: { ...cursor, shadow: null } }, followups }
        : { work: { satisfiesRevision: false, nextDueAt: ctx.now, cursor: { ...cursor, shadow: step.progress } }, followups: [] };
    },
  };
}
