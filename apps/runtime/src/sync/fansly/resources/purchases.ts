import { sql } from "drizzle-orm";

import { latestClosedWorkForKey, type Database, type SyncWorkRow } from "@agency_hub_core/db";
import { FANSLY_ORDER_HISTORY_PAGE_LIMIT } from "@agency_hub_core/fansly";

import {
  classifyFanslyPurchaseHistoryCapture,
  extractFanslyPurchaseHistoryTargetsFromTransactions,
  parseFanslyPurchaseHistoryCursorState,
  type FanslyPurchaseHistoryTarget,
} from "../../../services/sync/fansly-purchase-history.ts";
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
    for (const target of extractFanslyPurchaseHistoryTargetsFromTransactions([row])) {
      const kinds = byId.get(target.contentId) ?? new Set();
      kinds.add(fromLegacyTarget(target).kind);
      byId.set(target.contentId, kinds);
    }
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
  shadow: ShadowWalkProgress | null;
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
  return {
    before: typeof record.before === "string" && record.before.length > 0 ? record.before : null,
    pages: count("pages"),
    orders: count("orders"),
    headOrderIds: stringsOf(record.headOrderIds),
    knownOrderIds: Array.isArray(record.knownOrderIds) ? stringsOf(record.knownOrderIds) : null,
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
      shadow: null,
    };
    const known = new Set(knownOrderIds);
    const caughtUp = orderIds.some((id) => known.has(id));
    if (classified.outcome === "terminal_empty" || caughtUp) {
      const proof = {
        stop: caughtUp ? "known_order" : "empty_page",
        pages: next.pages,
        orders: next.orders,
        headOrderIds: next.headOrderIds.length > 0 ? next.headOrderIds : knownOrderIds.slice(0, KNOWN_ORDER_IDS_KEPT),
        observationId: input.observation.id,
      };
      return {
        work: { satisfiesRevision: true, close: "done", closeReason: proof.stop, cursor: next, proof },
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
    // The legacy lane's pending targets continue where it stopped; captured
    // targets need nothing (a new order re-reads its head, [D7]).
    const legacy = await tx.execute<{ state: unknown }>(sql`
      select state from page_sync_cursors where page_id = ${page.pageId} and stream = 'purchase_history'
    `);
    const state = parseFanslyPurchaseHistoryCursorState(legacy.rows[0]?.state ?? null);
    const cursors = (state?.pendingTargets ?? []).map((pending) => ({
      resource: PURCHASES_TARGETS_KEY,
      subject: purchaseTargetSubject(fromLegacyTarget(pending)),
      cursor: { before: pending.before, pages: 0, orders: 0, headOrderIds: [], knownOrderIds: [], shadow: null } satisfies TargetCursor,
    }));
    return { cursors, notes: { pendingTargets: cursors.length, legacyState: state === null ? "none" : "v5" } };
  },
};

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
