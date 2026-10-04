import {
  countRecentOwnLiveChats,
  listKnownPendingTransactionIds,
  loadWsRouteThreads,
  readWsRoutePage,
  upsertDemands,
  type Database,
  type FanslyWsLiveAckedReceipt,
  type SyncPageRow,
  type UpsertDemandInput,
  type WsRouteThread,
} from "@agency_hub_core/db";

import { noopMetrics, type Metrics } from "../../engine/ports.ts";
import { demandToUpsert, type DemandSignal, type EngineResourceSpec } from "../../engine/resource.ts";
import { fanslyResourceSpec } from "../registry.ts";
import { decodeFanslyWsFrame, type WsItem } from "./decode.ts";
import {
  isOwnBroadcastMarked,
  OWN_BROADCAST_FALLBACK_CHATS,
  OWN_BROADCAST_FALLBACK_WINDOW_MS,
  routeWsItems,
  unknownRouteThread,
  type RouteContext,
  type RouteThread,
} from "./router.ts";

// Where a captured WebSocket receipt becomes work (design §6.3, §6.4; I18):
// `routeFanslyWsReceiptDemand` is the post-ack hook every step-1 live-apply
// driver passes (the connection's applier, the worker timer, start-up replay,
// the repair CLI). It runs in the apply's own transaction right after the
// receipt's ack, so the demand commits exactly when the ack does — once per
// receipt, whichever driver wins it. On a page no actor runs (`off`,
// `shadow`) it reads the page's mode and does nothing else; on a
// `handover`/`live` page it decodes the frame, routes it and upserts the
// work. The lock order holds: the apply's overlay rows and
// `domain_event_seq` come first, the hook touches only `sync_work`, last.

/** The facts a frame's routing needs, loaded once for its items. */
async function loadRouteContext(
  db: Database,
  input: {
    pageId: number;
    nowMs: number;
    items: readonly WsItem[];
    ownBroadcast: (item: Extract<WsItem, { kind: "message_created" }>) => boolean;
  },
): Promise<RouteContext> {
  const groupIds = new Set<string>();
  const settled = new Set<string>();
  for (const item of input.items) {
    if (item.kind === "message_created") groupIds.add(item.message.groupId);
    else if (item.kind === "invalid" && item.groupRef !== null) groupIds.add(item.groupRef);
    else if (item.kind === "transaction" && item.status !== 1) settled.add(item.id);
  }
  const threads = await loadWsRouteThreads(db, { pageId: input.pageId, groupIds: [...groupIds] });
  const pending = await listKnownPendingTransactionIds(db, { pageId: input.pageId, transactionIds: [...settled] });
  return {
    pageId: input.pageId,
    nowMs: input.nowMs,
    thread: (groupId) => routeThreadOf(threads.get(groupId)),
    knownPendingTransaction: (id) => pending.has(id),
    ownBroadcastActive: input.ownBroadcast,
  };
}

/** A thread as the router judges it, as its row stands. */
function routeThreadOf(thread: WsRouteThread | undefined): RouteThread {
  if (thread === undefined) return unknownRouteThread();
  return { known: true, bound: thread.bound, excluded: thread.excluded, headConfirmedId: thread.headConfirmedId };
}

/** Own messages of a frame without the broadcast marker (the ones the rate
 *  fallback decides). */
function unmarkedOwnMessages(items: readonly WsItem[]): Array<Extract<WsItem, { kind: "message_created" }>> {
  return items.filter((item): item is Extract<WsItem, { kind: "message_created" }> =>
    item.kind === "message_created" && item.isOwn && !isOwnBroadcastMarked(item));
}

/** Demand signals as work rows of one page; a key the owner switched off for
 *  the page or a key no registry entry knows is dropped and counted. */
function upsertsOfSignals(
  signals: readonly DemandSignal[],
  input: {
    pageId: number;
    now: Date;
    page: Pick<SyncPageRow, "registryOverrides">;
    spec: (key: string) => EngineResourceSpec | null;
    metrics: Metrics;
  },
): UpsertDemandInput[] {
  const upserts: UpsertDemandInput[] = [];
  for (const signal of signals) {
    const spec = input.spec(signal.resource);
    if (spec === null) {
      input.metrics.increment("sync_ws_route_dropped", { resource: signal.resource, reason: "unknown_resource" });
      continue;
    }
    const upsert = demandToUpsert(signal, spec, { pageId: input.pageId, now: input.now, page: input.page });
    if (upsert === null) {
      input.metrics.increment("sync_ws_route_dropped", { resource: signal.resource, reason: "switched_off" });
      continue;
    }
    input.metrics.increment("sync_ws_route_demand", { resource: signal.resource });
    upserts.push(upsert);
  }
  return upserts;
}

// ── the post-ack hook (I18) ─────────────────────────────────────────────────

export interface RouteReceiptOptions {
  metrics?: Metrics;
  /** The engine clock's wall time (tests). */
  now?: () => Date;
}

/** Build the post-ack hook (`afterAck`) of the step-1 live-apply drivers. */
export function createFanslyWsReceiptRouter(options: RouteReceiptOptions = {}) {
  const metrics = options.metrics ?? noopMetrics;
  const now = options.now ?? (() => new Date());
  return async function routeReceipt(tx: Database, receipt: FanslyWsLiveAckedReceipt): Promise<void> {
    // An unreachable raw has nothing to route.
    if (receipt.frame === null) return;
    const page = await readWsRoutePage(tx, receipt.pageId);
    // Off or shadow: no actor runs the page, so its demand would serve
    // nothing. No engine row: never engine-owned.
    if (page === null || page.mode === "off" || page.mode === "shadow") return;
    const decoded = decodeFanslyWsFrame(receipt.frame, receipt.ownRef);
    const at = now();
    let fallback: boolean | null = null;
    if (unmarkedOwnMessages(decoded.items).length > 0) {
      // The frame's own overlay rows are already written in this transaction.
      const chats = await countRecentOwnLiveChats(tx, { pageId: receipt.pageId, windowMs: OWN_BROADCAST_FALLBACK_WINDOW_MS });
      fallback = chats > OWN_BROADCAST_FALLBACK_CHATS;
    }
    const ctx = await loadRouteContext(tx, {
      pageId: receipt.pageId,
      nowMs: at.getTime(),
      items: decoded.items,
      ownBroadcast: (item) => isOwnBroadcastMarked(item) || fallback === true,
    });
    const upserts = upsertsOfSignals(routeWsItems(decoded.items, ctx), {
      pageId: receipt.pageId,
      now: at,
      page,
      spec: fanslyResourceSpec,
      metrics,
    });
    if (upserts.length === 0) return;
    await upsertDemands(tx, upserts);
  };
}

/** The production post-ack hook: every step-1 driver passes it (§14 F2). */
export const routeFanslyWsReceiptDemand = createFanslyWsReceiptRouter();
