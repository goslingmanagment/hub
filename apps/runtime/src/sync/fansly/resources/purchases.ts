import { sql } from "drizzle-orm";

import {
  latestClosedWorkForKey,
  listFanslyDmRawPayloadsAfterId,
  listFanslyMessagePurchaseTargetsAfterId,
  listFanslyPurchaseHistoryCapturedContentIds,
  type Database,
  type SyncWorkRow,
} from "@agency_hub_core/db";
import { FANSLY_ORDER_HISTORY_PAGE_LIMIT } from "@agency_hub_core/fansly";

import type { AppContext } from "../../../bootstrap.ts";
import { createCapturePayloadRowResolver, isCapturePayloadUnavailable } from "../../../services/payload-reader.ts";
import {
  classifyFanslyPurchaseHistoryCapture,
  extractFanslyPurchaseHistoryTargets,
  fanslyPurchaseHistoryTargetOfTransaction,
  parseFanslyPurchaseHistoryCursorState,
  type FanslyPurchaseHistoryPendingTarget,
  type FanslyPurchaseHistoryTarget,
} from "../lib/purchase-history.ts";
import { ApplyQuarantine } from "../../engine/commit.ts";
import type {
  ApplyInput,
  ApplyResult,
  DemandSignal,
  LegacyImport,
  ReplayContext,
  ReplayObservation,
  ReplayVerdict,
  RequestPlan,
  ResourceModule,
  ShadowResult,
  StepPlan,
} from "../../engine/resource.ts";
import { advanceShadowWalk, type ShadowWalkProgress } from "../lib/offset-walk.ts";

// `purchases.targets` (plan §5, design §5.9): the order history of one PPV
// media or bundle the page sold — `GET /media/orderhistory?accountMediaId=|
// accountMediaBundleId=<id>&before=<orderId>&limit=100`, journaled verbatim as
// `purchase_history` (never CDN-stripped: the describer reads those URLs).
//
// One work row per target (subject `media:<id>` | `bundle:<id>`): the walk
// pages with `before = the last row's orderId` until an EMPTY page (the app's
// own client walks past short pages; row count proves nothing). A target is
// discovered by the transactions apply (a NEW ledger row of raw type
// 2010/2110 single, 2016/2116 bundle, `correlation_id` = the content id), by
// WS `order` frames (S2-10) and by DM pages (S2-08b). A target read before is
// read again from its head when a new order is signalled, until a page holds
// an order the previous walk saw ([D7]; legacy never re-walked a captured
// target).
//
// A walk serves the demand its head page could see. Demand that arrives after
// the head was read (a new order of the same target, from the ledger or a WS
// frame) is newer than every page below it, so it never rides on the walk's
// later pages: the walk re-reads its head before it closes, and a row that
// newer demand keeps open (I11) starts again at the head. Either way the
// re-read stops on the head this walk saw.
//
// The apply writes no business table: the canonicalizer turns the journaled
// page into `message.ppv_unlocked` and `media.order_observed` (→
// `media_orders`). 404/410/422 are the target's final answer (closed with the
// receipt, registry `terminalStatuses`); any other failure breaks that target
// alone, and ≥ 5 failing targets in 10 min hold the file (§3.8). A body the
// legacy classifier calls contract drift (no order array, a missing or
// repeated cursor) is quarantined with its raw page kept — the storm/witness
// gate is retired ([D3]).
//
// Deviation from design §4.3/§5.9: the targets are `sync_work` rows, not a
// `subject_refresh_state` plane — that table's plane CHECK (0197) does not
// admit `purchase_history` and this PR carries no migration. The per-target
// breaker, the resource breaker and the terminal close are the engine's own.

export const PURCHASES_TARGETS_KEY = "purchases.targets";
/** Orders the previous walk of a target saw first: a re-read stops on one. */
const KNOWN_ORDER_IDS_KEPT = 20;
/** The legacy lane's discovery backlog the import reads at most (one-time, in
 *  the switch transaction). Ledger rows are a cheap keyset read; journaled
 *  `/message` pages are bodies read through the payload seam. */
const IMPORT_LEDGER_ROWS_MAX = 20_000;
const IMPORT_DM_PAGES_MAX = 5_000;
const IMPORT_BATCH = 500;
/** Examples kept in the import notes per list. */
const IMPORT_NOTE_EXAMPLES = 10;

export interface PurchaseTarget {
  kind: "media" | "bundle";
  id: string;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

/** `media:<id>` | `bundle:<id>`. */
export function purchaseTargetSubject(target: PurchaseTarget): string {
  return `${target.kind}:${target.id}`;
}

export function parsePurchaseTargetSubject(subject: string): PurchaseTarget | null {
  const separator = subject.indexOf(":");
  if (separator <= 0) return null;
  const kind = subject.slice(0, separator);
  const id = subject.slice(separator + 1);
  return (kind === "media" || kind === "bundle") && /^[0-9]+$/.test(id) ? { kind, id } : null;
}

/** The legacy lane's name of the same target (`single:` | `bundle:`). */
function legacyTargetKey(target: PurchaseTarget): string {
  return `${target.kind === "media" ? "single" : "bundle"}:${target.id}`;
}

function fromLegacyTarget(target: FanslyPurchaseHistoryTarget): PurchaseTarget {
  return { kind: target.kind === "single" ? "media" : "bundle", id: target.contentId };
}

/**
 * The targets a batch of ledger rows names (raw types 2010/2110 single,
 * 2016/2116 bundle; `correlation_id` is the content id), one per content id.
 * A content id seen as both kinds names no target: choosing the request
 * parameter would be a guess (legacy fails the batch closed; here only that id
 * is left out, and counted).
 */
export function purchaseTargetsOfTransactions(
  rows: ReadonlyArray<{ rawType: string | number; correlationId: string | null }>,
): { targets: PurchaseTarget[]; conflicts: string[] } {
  const byId = new Map<string, Set<PurchaseTarget["kind"]>>();
  for (const row of rows) {
    const target = fanslyPurchaseHistoryTargetOfTransaction(row);
    if (target === null) continue;
    const kinds = byId.get(target.contentId) ?? new Set();
    kinds.add(fromLegacyTarget(target).kind);
    byId.set(target.contentId, kinds);
  }
  const targets: PurchaseTarget[] = [];
  const conflicts: string[] = [];
  for (const [id, kinds] of byId) {
    if (kinds.size > 1) {
      conflicts.push(id);
      continue;
    }
    targets.push({ kind: [...kinds][0]!, id });
  }
  targets.sort((left, right) => purchaseTargetSubject(left).localeCompare(purchaseTargetSubject(right)));
  return { targets, conflicts: conflicts.sort() };
}

/** The walks a set of targets needs (one row per target; an open one only
 *  gains demand). */
export function purchaseTargetFollowups(targets: readonly PurchaseTarget[], reason: string): DemandSignal[] {
  return targets.map((target) => ({
    resource: PURCHASES_TARGETS_KEY,
    subject: purchaseTargetSubject(target),
    params: { target },
    demand: { reason },
  }));
}

interface TargetCursor {
  /** The order id the next page is asked before; null = the head. */
  before: string | null;
  pages: number;
  orders: number;
  /** The first orders of this walk's head page (newest first). */
  headOrderIds: string[];
  /** The previous walk's head orders: a re-read stops on a page holding one. */
  knownOrderIds: string[] | null;
  /** The demand revision this walk's head covers: the revision its head page
   *  was admitted at (a walk imported mid-history: its first page's). */
  headRevision: number | null;
  shadow: ShadowWalkProgress | null;
}

/** A walk from the head that stops on a page holding one of `knownOrderIds`
 *  (null: the last closed walk's head, looked up on the first page). */
function headWalk(knownOrderIds: string[] | null): TargetCursor {
  return { before: null, pages: 0, orders: 0, headOrderIds: [], knownOrderIds, headRevision: null, shadow: null };
}

function parseTargetCursor(value: unknown): TargetCursor {
  const record = recordOf(value);
  const count = (key: string) => {
    const raw = record[key];
    return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
  };
  const shadow = recordOf(record.shadow);
  const steps = shadow.steps;
  const done = shadow.done;
  const headRevision = record.headRevision;
  return {
    before: typeof record.before === "string" && record.before.length > 0 ? record.before : null,
    pages: count("pages"),
    orders: count("orders"),
    headOrderIds: stringsOf(record.headOrderIds),
    knownOrderIds: Array.isArray(record.knownOrderIds) ? stringsOf(record.knownOrderIds) : null,
    headRevision: typeof headRevision === "number" && Number.isSafeInteger(headRevision) && headRevision >= 0 ? headRevision : null,
    shadow: typeof steps === "number" && typeof done === "number" ? { steps, done } : null,
  };
}

function targetRequest(target: PurchaseTarget, before: string | null): RequestPlan<"media.order_history"> {
  return { spec: "media.order_history", params: { target, before } };
}

function orderIdsOf(response: unknown): string[] {
  const payload = recordOf(response);
  const aggregation = recordOf(payload.aggregationData);
  const rows = Array.isArray(payload.accountMediaOrderHistory)
    ? payload.accountMediaOrderHistory
    : Array.isArray(payload.accountMediaOrders)
      ? payload.accountMediaOrders
      : Array.isArray(aggregation.accountMediaOrders) ? aggregation.accountMediaOrders : [];
  return rows.flatMap((row) => {
    const id = recordOf(row).orderId;
    return typeof id === "string" && id.length > 0 ? [id] : [];
  });
}

/** The orders the page already knows for a target (shadow estimate). */
async function knownOrderCount(db: Database, pageId: number, target: PurchaseTarget): Promise<number> {
  const result = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from media_orders
     where page_id = ${pageId} and media_offer_ref = ${target.id}
  `);
  return Number(result.rows[0]?.n ?? 0);
}

function targetOf(work: Pick<SyncWorkRow, "subject">): PurchaseTarget | null {
  return parsePurchaseTargetSubject(work.subject);
}

export const purchasesTargetsModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const target = targetOf(work);
    if (target === null) return { kind: "quarantine", reason: "purchase_target_unknown" };
    const cursor = parseTargetCursor(work.cursor);
    return { kind: "request", request: targetRequest(target, ctx.shadow ? null : cursor.before) };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const target = targetOf(input.work);
    if (target === null) throw new ApplyQuarantine("purchase_target_unknown");
    const cursor = parseTargetCursor(input.work.cursor);
    const requestBefore = (recordOf(input.request.params).before ?? null) as string | null;
    if (requestBefore !== cursor.before) {
      throw new ApplyQuarantine("purchase_cursor_mismatch", { requestBefore, cursorBefore: cursor.before });
    }
    const classified = classifyFanslyPurchaseHistoryCapture({
      id: input.observation.id,
      targetKey: legacyTargetKey(target),
      requestBefore,
      statusCode: null,
      responsePayload: input.response,
    });
    if (classified.blocked) {
      // Contract drift: the raw page stays journaled; the owner re-applies
      // it after a parser fix (`sync work requeue --quarantined`).
      throw new ApplyQuarantine(`purchase_history_${classified.outcome}`, { target: purchaseTargetSubject(target) });
    }
    const orderIds = orderIdsOf(input.response);
    // The demand this step serves, and the demand this walk's head covers.
    const served = input.attempt.demandRevision ?? input.work.demandRevision;
    const headRevision = requestBefore === null ? served : (cursor.headRevision ?? served);
    // The previous walk's head (first page of this walk only).
    let knownOrderIds = cursor.knownOrderIds;
    if (knownOrderIds === null) {
      const previous = await latestClosedWorkForKey(tx, {
        pageId: input.pageId, shadow: false, resource: PURCHASES_TARGETS_KEY, subject: input.work.subject,
      });
      knownOrderIds = stringsOf(recordOf(previous?.proof).headOrderIds);
    }
    const next: TargetCursor = {
      before: classified.nextBefore,
      pages: cursor.pages + 1,
      orders: cursor.orders + orderIds.length,
      headOrderIds: cursor.pages === 0 ? orderIds.slice(0, KNOWN_ORDER_IDS_KEPT) : cursor.headOrderIds,
      knownOrderIds,
      headRevision,
      shadow: null,
    };
    const known = new Set(knownOrderIds);
    const caughtUp = orderIds.some((id) => known.has(id));
    if (classified.outcome === "terminal_empty" || caughtUp) {
      const headOrderIds = next.headOrderIds.length > 0 ? next.headOrderIds : knownOrderIds.slice(0, KNOWN_ORDER_IDS_KEPT);
      // What follows this walk starts at the head and stops on this walk's
      // head — also when newer demand keeps the row open past the close: the
      // stop position points into older history the walk has just read.
      const following = headWalk(headOrderIds);
      if (served > headRevision) {
        // Demand arrived after the head page was read: an order newer than
        // every page this walk holds. Re-read the head before closing.
        return {
          work: { satisfiesRevision: false, nextDueAt: input.now, cursor: following },
          followups: [],
          counters: { orders: orderIds.length, head_reread: 1 },
        };
      }
      const proof = {
        stop: caughtUp ? "known_order" : "empty_page",
        pages: next.pages,
        orders: next.orders,
        headOrderIds,
        observationId: input.observation.id,
      };
      return {
        work: { satisfiesRevision: true, close: "done", closeReason: proof.stop, cursor: following, proof },
        followups: [],
        counters: { orders: orderIds.length },
      };
    }
    return {
      work: { satisfiesRevision: false, nextDueAt: input.now, cursor: next },
      followups: [],
      counters: { orders: orderIds.length },
    };
  },

  async shadow(work, _request, ctx): Promise<ShadowResult> {
    const target = targetOf(work);
    const cursor = parseTargetCursor(work.cursor);
    const known = target === null ? 0 : await knownOrderCount(ctx.db, ctx.pageId, target);
    // A walk to the empty page: every full page of the known orders, the
    // short one, then the empty one.
    const step = advanceShadowWalk(cursor.shadow, () =>
      known === 0 ? 1 : Math.floor(known / FANSLY_ORDER_HISTORY_PAGE_LIMIT) + 2);
    return step.finished
      ? { work: { satisfiesRevision: true, close: "done", closeReason: "shadow", cursor: { ...cursor, shadow: null } }, followups: [] }
      : { work: { satisfiesRevision: false, nextDueAt: ctx.now, cursor: { ...cursor, shadow: step.progress } }, followups: [] };
  },

  async replay(observation: ReplayObservation, ctx: ReplayContext): Promise<ReplayVerdict> {
    return replayPurchaseHistory(observation, ctx);
  },

  async importLegacy(tx, page): Promise<LegacyImport> {
    return importLegacyTargets(tx, page.pageId);
  },
};

// ── import (step-3 switch, design §5.9 Import, §11.1 C.2) ───────────────────

/** The payload seam's context for the one-time import: a body the catalog
 *  cannot serve is counted in the import notes, the seam's own warning has no
 *  sink here. */
function importSeam(tx: Database): Pick<AppContext, "db" | "logger"> {
  return { db: tx, logger: { warn: () => undefined } as unknown as AppContext["logger"] };
}

/** The ledger rows past the legacy transaction cursor (raw types
 *  2010/2110/2016/2116), as targets. */
async function ledgerBacklog(tx: Database, pageId: number, afterId: number) {
  const rows: Array<{ rawType: string; correlationId: string }> = [];
  let cursor = afterId;
  let truncated = false;
  for (;;) {
    const batch = await listFanslyMessagePurchaseTargetsAfterId(tx, { pageId, afterId: cursor, limit: IMPORT_BATCH });
    rows.push(...batch);
    if (batch.length > 0) cursor = batch.at(-1)!.id;
    if (batch.length < IMPORT_BATCH) break;
    if (rows.length >= IMPORT_LEDGER_ROWS_MAX) {
      truncated = true;
      break;
    }
  }
  return { ...purchaseTargetsOfTransactions(rows), rows: rows.length, throughId: cursor, truncated };
}

/** The journaled `/message` pages past the legacy raw cursor, as targets (the
 *  lane's own extractor; the first page that names a content id decides its
 *  kind, as the lane's batches did). */
async function dmBacklog(tx: Database, pageId: number, afterId: number) {
  const seam = importSeam(tx);
  const kinds = new Map<string, PurchaseTarget["kind"]>();
  const disagreements = new Set<string>();
  const unavailable: number[] = [];
  let pages = 0;
  let cursor = afterId;
  let truncated = false;
  for (;;) {
    const batch = (await listFanslyDmRawPayloadsAfterId(tx, { pageId, afterId: cursor, limit: IMPORT_BATCH }))
      .map((row) => ({ id: row.id, payload: row.responsePayload, payloadRef: row.payloadRef }));
    const resolve = createCapturePayloadRowResolver(seam, "raw_payload", batch);
    const payloads: unknown[] = [];
    for (const row of batch) {
      try {
        payloads.push((await resolve(row)).payload);
      } catch (error) {
        if (!isCapturePayloadUnavailable(error)) throw error;
        unavailable.push(row.id);
      }
    }
    for (const target of extractFanslyPurchaseHistoryTargets(payloads).map(fromLegacyTarget)) {
      const kind = kinds.get(target.id);
      if (kind === undefined) kinds.set(target.id, target.kind);
      else if (kind !== target.kind) disagreements.add(target.id);
    }
    pages += batch.length;
    if (batch.length > 0) cursor = batch.at(-1)!.id;
    if (batch.length < IMPORT_BATCH) break;
    if (pages >= IMPORT_DM_PAGES_MAX) {
      truncated = true;
      break;
    }
  }
  return { kinds, disagreements, unavailable, pages, throughId: cursor, truncated };
}

/** The legacy lane's pending target, continued where it stopped. */
function continuation(pending: FanslyPurchaseHistoryPendingTarget): TargetCursor {
  return { ...headWalk([]), before: pending.before };
}

/**
 * The legacy `purchase_history` lane, continued by the engine: one target row
 * per target the lane still owed.
 *
 * - its pending targets, from where each stopped (to the empty page: the lane
 *   kept no head to stop on) — unless a ledger row past its cursor sold the
 *   same target again: that order is newer than the head the lane read, so the
 *   target is walked again from its head;
 * - the targets of the ledger rows past its transaction cursor, as the
 *   transactions apply derives them from rows new to it ([D7]: a sale of an
 *   already captured target re-reads it too);
 * - the targets of the journaled `/message` pages past its raw cursor that the
 *   lane has not captured (its own discovery rule).
 *
 * Without this backlog a sale the lane had journaled but not yet scanned would
 * never be read: after the switch the engine finds targets only in ledger rows
 * and pages new to it. The read is bounded; the notes give every count, and a
 * cut-short source says where it stopped.
 */
async function importLegacyTargets(tx: Database, pageId: number): Promise<LegacyImport> {
  const legacy = await tx.execute<{ state: unknown }>(sql`
    select state from page_sync_cursors where page_id = ${pageId} and stream = 'purchase_history'
  `);
  const rawState = legacy.rows[0]?.state ?? null;
  const state = parseFanslyPurchaseHistoryCursorState(rawState);
  // No readable state: the lane would start both sources from the beginning.
  const transactionCursorId = state?.transactionCursorId ?? 0;
  const rawPayloadCursorId = state?.rawPayloadCursorId ?? 0;
  const ledger = await ledgerBacklog(tx, pageId, transactionCursorId);
  const dm = await dmBacklog(tx, pageId, rawPayloadCursorId);
  const captured = new Set(await listFanslyPurchaseHistoryCapturedContentIds(tx, pageId));

  const chosen = new Map<string, { target: PurchaseTarget; cursor: TargetCursor }>();
  const ambiguous = new Set<string>(ledger.conflicts);
  const disagreements = new Set<string>(dm.disagreements);
  const sold = new Map(ledger.targets.map((target) => [target.id, target.kind]));
  let pendingRestarted = 0;
  let invalid = 0;
  const choose = (target: PurchaseTarget, cursor: TargetCursor): boolean => {
    if (parsePurchaseTargetSubject(purchaseTargetSubject(target)) === null) {
      invalid += 1;
      return false;
    }
    const existing = chosen.get(target.id);
    if (existing !== undefined) {
      if (existing.target.kind !== target.kind) disagreements.add(target.id);
      return false;
    }
    chosen.set(target.id, { target, cursor });
    return true;
  };
  for (const pending of state?.pendingTargets ?? []) {
    const target = fromLegacyTarget(pending);
    const soldAgain = sold.get(target.id) === target.kind && pending.before !== null;
    if (choose(target, soldAgain ? headWalk([]) : continuation(pending)) && soldAgain) pendingRestarted += 1;
  }
  let ledgerTargets = 0;
  for (const target of ledger.targets) {
    if (choose(target, headWalk(null))) ledgerTargets += 1;
  }
  let dmTargets = 0;
  let dmCaptured = 0;
  for (const [id, kind] of dm.kinds) {
    if (ambiguous.has(id)) continue;
    if (!chosen.has(id) && captured.has(id)) {
      dmCaptured += 1;
      continue;
    }
    if (choose({ kind, id }, headWalk(null))) dmTargets += 1;
  }

  const cursors = [...chosen.values()]
    .map(({ target, cursor }) => ({ resource: PURCHASES_TARGETS_KEY, subject: purchaseTargetSubject(target), cursor }))
    .sort((left, right) => left.subject.localeCompare(right.subject));
  return {
    cursors,
    notes: {
      legacyState: state !== null ? "v5" : rawState === null ? "none" : "unreadable",
      targets: cursors.length,
      pendingTargets: state?.pendingTargets.length ?? 0,
      pendingRestarted,
      ledger: {
        afterId: transactionCursorId,
        rowsScanned: ledger.rows,
        throughId: ledger.throughId,
        truncated: ledger.truncated,
        targets: ledgerTargets,
      },
      dmPages: {
        afterId: rawPayloadCursorId,
        pagesScanned: dm.pages,
        throughId: dm.throughId,
        truncated: dm.truncated,
        targets: dmTargets,
        capturedSkipped: dmCaptured,
        bodiesUnavailable: dm.unavailable.length,
        unavailableExamples: dm.unavailable.slice(0, IMPORT_NOTE_EXAMPLES),
      },
      // A content id the ledger names as both kinds: left out (choosing the
      // request parameter would be a guess).
      ambiguousContentIds: [...ambiguous].sort().slice(0, IMPORT_NOTE_EXAMPLES),
      ambiguousSkipped: ambiguous.size,
      // Sources that disagree on a content id's kind: the first source (pending,
      // then ledger, then the earliest page) is kept.
      kindDisagreements: [...disagreements].sort().slice(0, IMPORT_NOTE_EXAMPLES),
      invalidTargets: invalid,
    },
  };
}

/**
 * Replay of a legacy `purchase_history` observation (design §5.9): the
 * classifier accepts the page, and every (offer, buyer) it served has a
 * `media_orders` row on the page.
 */
async function replayPurchaseHistory(observation: ReplayObservation, ctx: ReplayContext): Promise<ReplayVerdict> {
  const payload = recordOf(observation.payload);
  if (recordOf(payload.error).status !== undefined) {
    return { kind: "not_replayable", reason: "legacy_rejection_receipt" };
  }
  const classified = classifyFanslyPurchaseHistoryCapture({
    id: observation.id,
    targetKey: "single:replay",
    requestBefore: null,
    statusCode: null,
    responsePayload: observation.payload,
  });
  if (classified.blocked) return { kind: "mismatch", reason: `contract:${classified.outcome}` };
  const aggregation = recordOf(payload.aggregationData);
  const rows = (Array.isArray(payload.accountMediaOrderHistory)
    ? payload.accountMediaOrderHistory
    : Array.isArray(payload.accountMediaOrders)
      ? payload.accountMediaOrders
      : Array.isArray(aggregation.accountMediaOrders) ? aggregation.accountMediaOrders : []) as unknown[];
  const pairs = new Map<string, { offer: string; buyer: string }>();
  for (const row of rows) {
    const record = recordOf(row);
    const offer = typeof record.accountMediaBundleId === "string" && record.accountMediaBundleId.length > 0
      ? record.accountMediaBundleId
      : typeof record.accountMediaId === "string" ? record.accountMediaId : "";
    const buyer = typeof record.accountId === "string" ? record.accountId : "";
    if (offer.length > 0 && buyer.length > 0) pairs.set(`${offer}:${buyer}`, { offer, buyer });
  }
  if (pairs.size === 0) return { kind: "match", detail: { orders: 0 } };
  const offers = [...new Set([...pairs.values()].map((pair) => pair.offer))];
  const stored = await ctx.db.execute<{ offer: string; buyer: string }>(sql`
    select distinct media_offer_ref as offer, buyer_platform_user_id as buyer
      from media_orders
     where page_id = ${ctx.pageId} and media_offer_ref = any(${sql.param(offers)}::text[])
  `);
  const known = new Set(stored.rows.map((row) => `${row.offer}:${row.buyer}`));
  const missing = [...pairs.keys()].filter((key) => !known.has(key));
  return missing.length === 0
    ? { kind: "match", detail: { orders: pairs.size } }
    : { kind: "mismatch", reason: "orders_missing", detail: { orders: pairs.size, missing: missing.length, examples: missing.slice(0, 5) } };
}
