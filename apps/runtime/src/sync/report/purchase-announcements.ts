import {
  listLegacyPurchaseHistoryCapturesInWindow,
  listPpvLedgerSales,
  type Database,
  type FanslyWsLivePayloadResolver,
  type LegacyPurchaseHistoryCapture,
  type SyncPageRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { createCapturePayloadRowResolver, isCapturePayloadUnavailable } from "../../services/payload-reader.ts";
import { fanslyPurchaseHistoryOrderRows } from "../fansly/lib/purchase-history.ts";
import { normalizeFanslyTimestamp } from "../../services/sync/shared.ts";
import { readOrderFrames } from "../fansly/ws/money-frames.ts";

// Rule A2.demand-replaced (design §3.12 A2, §5.9): legacy reads the order
// history of PPV media on a schedule — every 4 hours per page, the targets its
// lane found in new ledger sales and in chat pages since its last run. The
// engine's `purchases.targets` has no schedule: a walk is asked for by a
// socket order frame (the router, which feeds shadow too) and, on a live page,
// by the transactions apply for every new PPV sale (raw type 2010/2110 single,
// 2016/2116 bundle) — which in shadow sends no target demand (it never reads
// the ledger page). So the shadow cannot meet legacy's volume, and the switch
// is what compares them. What the window CAN show is whether the poll found a
// purchase the engine would never hear of: every order in the bodies the poll
// journaled in the window is matched with its announcement — a PPV ledger row
// of the same content, buyer and second (as the report reads the ledger), or
// a socket order frame of the page with the same order id (received from 7
// days before the window to its end). A target read without an order (PPV
// media legacy found in a chat before any sale) needs no engine read: its
// sale's announcement walks it. Measured on the production journal for the 7
// days to 2026-10-02: 548 captures, 482 targets, 66 orders on 66 targets —
// every order announced by both its ledger row and its socket frame; the
// other 416 targets answered with an empty page.

/** A capture of an attempt begun at the window's end lands just after it. */
export const PURCHASE_CAPTURE_SLACK_MS = 60_000;
/** How far back a socket order frame is looked for. */
export const ORDER_FRAME_LOOKBACK_MS = 7 * 24 * 3_600_000;

/** One order row of a legacy purchase-history body. */
export interface LegacyOrder {
  orderId: string | null;
  buyerRef: string | null;
  /** The bundle when the row names one, else the media (the sale's `correlation_id`). */
  contentId: string | null;
  orderedAt: Date | null;
}

/** One legacy capture of the window, read: its target and its orders. */
export interface ReadCapture {
  page: string;
  pageId: number;
  captureId: number;
  /** `media:<id>` | `bundle:<id>`; null when its request names none. */
  target: string | null;
  /** Null: the body could not be read. A refusal or a body without an order
   *  array holds no order. */
  orders: readonly LegacyOrder[] | null;
}

export interface PurchaseAnnouncementCheck {
  /** The window's legacy captures of the stream (the answers its attempts got). */
  captures: number;
  /** Distinct targets read; those whose answer held an order. */
  targets: number;
  targetsWithOrders: number;
  /** Order rows read (a row read twice counts once per page and order id). */
  orders: number;
  /** Orders a PPV ledger row announces. */
  ledger: number;
  /** Orders only a socket order frame announces. */
  socketOnly: number;
  /** Orders neither announces: a purchase only the poll found. */
  unannounced: Array<{ page: string; pageId: number; target: string | null; orderId: string | null; orderedAt: Date | null }>;
  unannouncedCount: number;
  /** Captures whose body the payload seam could not read. */
  unreadable: Array<{ page: string; captureId: number }>;
  /** Every order announced and every body read. */
  passes: boolean;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The orders of a purchase-history body ([] for a refusal or a body without
 *  an order array). */
export function legacyOrdersOf(payload: unknown): LegacyOrder[] {
  return (fanslyPurchaseHistoryOrderRows(payload) ?? []).map((row) => {
    const createdAt = row.createdAt;
    return {
      orderId: stringOf(row.orderId),
      buyerRef: stringOf(row.accountId),
      contentId: stringOf(row.accountMediaBundleId) ?? stringOf(row.accountMediaId),
      orderedAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? normalizeFanslyTimestamp(createdAt) : null,
    };
  });
}

/** The target a legacy capture asked for. */
export function captureTarget(requestParams: unknown): string | null {
  const params = recordOf(requestParams);
  const media = stringOf(params.accountMediaId);
  if (media !== null) return `media:${media}`;
  const bundle = stringOf(params.accountMediaBundleId);
  return bundle === null ? null : `bundle:${bundle}`;
}

const secondOf = (at: Date) => Math.floor(at.getTime() / 1000);

/**
 * Rule A2.demand-replaced, pure: each order read is announced by a PPV ledger
 * row of its page (same content, same buyer, same second) or by a socket order
 * frame of its page with its order id; an unreadable body or an unannounced
 * order fails the check.
 */
export function judgePurchaseAnnouncements(input: {
  captures: readonly ReadCapture[];
  ledger: ReadonlyMap<number, ReadonlyArray<{ contentId: string; buyerRef: string | null; occurredAt: Date }>>;
  socketOrderIds: ReadonlyMap<number, ReadonlySet<string>>;
  maxListed: number;
}): PurchaseAnnouncementCheck {
  const targets = new Set<string>();
  const targetsWithOrders = new Set<string>();
  const unreadable: PurchaseAnnouncementCheck["unreadable"] = [];
  const unannounced: PurchaseAnnouncementCheck["unannounced"] = [];
  const seen = new Set<string>();
  let orders = 0;
  let ledger = 0;
  let socketOnly = 0;
  for (const capture of input.captures) {
    const targetKey = capture.target === null ? null : `${capture.pageId}:${capture.target}`;
    if (targetKey !== null) targets.add(targetKey);
    if (capture.orders === null) {
      unreadable.push({ page: capture.page, captureId: capture.captureId });
      continue;
    }
    if (capture.orders.length > 0 && targetKey !== null) targetsWithOrders.add(targetKey);
    for (const order of capture.orders) {
      // The same order read twice (a re-read head) is one purchase.
      const key = order.orderId === null ? null : `${capture.pageId}:${order.orderId}`;
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      orders += 1;
      const sales = input.ledger.get(capture.pageId) ?? [];
      const inLedger = order.contentId !== null && order.orderedAt !== null && sales.some((sale) =>
        sale.contentId === order.contentId
        && secondOf(sale.occurredAt) === secondOf(order.orderedAt!)
        && (sale.buyerRef === null || order.buyerRef === null || sale.buyerRef === order.buyerRef));
      if (inLedger) {
        ledger += 1;
        continue;
      }
      if (order.orderId !== null && input.socketOrderIds.get(capture.pageId)?.has(order.orderId) === true) {
        socketOnly += 1;
        continue;
      }
      unannounced.push({ page: capture.page, pageId: capture.pageId, target: capture.target, orderId: order.orderId, orderedAt: order.orderedAt });
    }
  }
  return {
    captures: input.captures.length,
    targets: targets.size,
    targetsWithOrders: targetsWithOrders.size,
    orders,
    ledger,
    socketOnly,
    unannounced: unannounced.slice(0, input.maxListed),
    unannouncedCount: unannounced.length,
    unreadable: unreadable.slice(0, input.maxListed),
    passes: unannounced.length === 0 && unreadable.length === 0,
  };
}

/** What the poll read and how it was announced, in one line. */
export function purchaseAnnouncementSummary(check: PurchaseAnnouncementCheck): string {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const read = `the poll read ${plural(check.targets, "target")} in ${plural(check.captures, "capture")}, `
    + `${check.targetsWithOrders} with orders: ${plural(check.orders, "order")}`;
  const announced = `${check.ledger} by a PPV ledger row, ${check.socketOnly} by a socket order frame alone`;
  const faults = [
    ...(check.unannouncedCount === 0 ? [] : [`${check.unannouncedCount} NOT announced, a purchase only the poll found (`
      + check.unannounced.map((entry) => `${entry.page} ${entry.target ?? "no target"} order ${entry.orderId ?? "without id"}`).join("; ") + ")"]),
    ...(check.unreadable.length === 0 ? [] : [`${check.unreadable.length} capture bod${check.unreadable.length === 1 ? "y" : "ies"} unreadable (`
      + check.unreadable.map((entry) => `${entry.page} #${entry.captureId}`).join(", ") + ")"]),
  ];
  return faults.length === 0
    ? `${read}, every one announced (${announced})`
    : `${read}; ${faults.join("; ")}; announced ${announced}`;
}

/** The row's note: the rule, why the shadow has no volume to compare, the check. */
export function purchaseAnnouncementNote(check: PurchaseAnnouncementCheck): string {
  return "rule A2.demand-replaced: purchases.targets runs on demand only (the socket's order frames; live, also the "
    + "transactions apply's new PPV sales, which name no target in shadow), compared after the switch; "
    + purchaseAnnouncementSummary(check);
}

/**
 * Rule A2.demand-replaced over the window: the legacy `purchase_history`
 * captures of the pages (captured in the window, or within
 * `PURCHASE_CAPTURE_SLACK_MS` after it), their bodies read through the payload
 * seam, each order matched with the ledger and — for those the ledger lacks —
 * the socket's order frames.
 */
export async function checkPurchaseAnnouncements(
  db: Database,
  input: {
    pages: readonly Pick<SyncPageRow, "pageId" | "pageLabel">[];
    window: { start: Date; end: Date };
    maxListed: number;
    resolvePayload?: FanslyWsLivePayloadResolver;
    logger?: AppContext["logger"];
  },
): Promise<PurchaseAnnouncementCheck> {
  const pageIds = input.pages.map((page) => page.pageId);
  const label = new Map(input.pages.map((page) => [page.pageId, page.pageLabel ?? String(page.pageId)]));
  const rows: LegacyPurchaseHistoryCapture[] = await listLegacyPurchaseHistoryCapturesInWindow(db, {
    pageIds,
    from: input.window.start,
    to: new Date(input.window.end.getTime() + PURCHASE_CAPTURE_SLACK_MS),
  });
  const seam = { db, logger: input.logger ?? ({ warn: () => undefined } as unknown as AppContext["logger"]) };
  const resolve = createCapturePayloadRowResolver(seam, "raw_payload", rows);
  const captures: ReadCapture[] = [];
  for (const row of rows) {
    let orders: LegacyOrder[] | null;
    try {
      orders = legacyOrdersOf((await resolve(row)).payload);
    } catch (error) {
      if (!isCapturePayloadUnavailable(error)) throw error;
      orders = null;
    }
    captures.push({
      page: label.get(row.pageId) ?? String(row.pageId),
      pageId: row.pageId,
      captureId: row.id,
      target: captureTarget(row.requestParams),
      orders,
    });
  }

  const ledger = new Map<number, Awaited<ReturnType<typeof listPpvLedgerSales>>>();
  for (const pageId of new Set(captures.map((capture) => capture.pageId))) {
    const contentIds = captures.filter((capture) => capture.pageId === pageId)
      .flatMap((capture) => (capture.orders ?? []).flatMap((order) => (order.contentId === null ? [] : [order.contentId])));
    ledger.set(pageId, await listPpvLedgerSales(db, { pageId, contentIds }));
  }
  const byLedger = judgePurchaseAnnouncements({ captures, ledger, socketOrderIds: new Map(), maxListed: Number.MAX_SAFE_INTEGER });
  if (byLedger.unannouncedCount === 0) return judgePurchaseAnnouncements({ captures, ledger, socketOrderIds: new Map(), maxListed: input.maxListed });

  // Only the pages with an order the ledger lacks read their order frames.
  const framePages = [...new Set(byLedger.unannounced.map((entry) => entry.pageId))];
  const socketOrderIds = new Map<number, Set<string>>();
  for (const frame of await readOrderFrames(db, {
    from: new Date(input.window.start.getTime() - ORDER_FRAME_LOOKBACK_MS),
    to: input.window.end,
    pageIds: framePages,
    ...(input.resolvePayload === undefined ? {} : { resolvePayload: input.resolvePayload }),
  })) {
    socketOrderIds.set(frame.pageId, (socketOrderIds.get(frame.pageId) ?? new Set()).add(frame.orderId));
  }
  return judgePurchaseAnnouncements({ captures, ledger, socketOrderIds, maxListed: input.maxListed });
}
