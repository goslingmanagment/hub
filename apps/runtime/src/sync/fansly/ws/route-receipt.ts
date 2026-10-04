import {
  advanceWsRouterCursor,
  countRecentOwnLiveChats,
  getSyncPage,
  listKnownPendingTransactionIds,
  listWsRouterReceipts,
  loadWsRouteThreads,
  lockOwnedPage,
  readWsRoutePage,
  upsertDemands,
  wsRouterHorizonWatermark,
  type Database,
  type FanslyWsLiveAckedReceipt,
  type FanslyWsLivePayloadResolver,
  type SyncPageRow,
  type UpsertDemandInput,
  type WsRouterReceipt,
  type WsRouteThread,
} from "@agency_hub_core/db";

import type { ShadowFeed } from "../../engine/actor.ts";
import type { CommitDeps } from "../../engine/commit.ts";
import { noopMetrics, type Metrics } from "../../engine/ports.ts";
import { demandToUpsert, type DemandSignal, type EngineResourceSpec } from "../../engine/resource.ts";
import { fanslyResourceSpec } from "../registry.ts";
import { decodeFanslyWsFrame, socketFrameOf, type WsItem } from "./decode.ts";
import {
  isOwnBroadcastMarked,
  mergeDemandSignals,
  OWN_BROADCAST_FALLBACK_CHATS,
  OWN_BROADCAST_FALLBACK_WINDOW_MS,
  OwnBroadcastWindow,
  routeWsItems,
  unknownRouteThread,
  type RouteContext,
  type RouteThread,
} from "./router.ts";

// Where a captured WebSocket receipt becomes work (design §6.3, §6.4).
//
// Live (step 3, I18): `routeFanslyWsReceiptDemand` is the post-ack hook every
// step-1 live-apply driver passes (the connection's applier, the worker
// timer, start-up replay, the repair CLI). It runs in the apply's own
// transaction right after the receipt's ack, so the demand commits exactly
// when the ack does — once per receipt, whichever driver wins it. On a page
// that is `off` or `shadow` it reads the page's mode and does nothing else
// (shadow pages are fed below); on a `handover`/`live` page it decodes the
// frame, routes it and upserts the work. The lock order holds: the apply's
// overlay rows and `domain_event_seq` come first, the hook touches only
// `sync_work`, last.
//
// Shadow (step 2): the legacy receiver owns the socket and the step-1 drivers
// ack the receipts; the page's shadow actor reads the receipts past its
// cursor (`sync_pages.ws_router_cursor`) once per lap, routes them the same
// way into SHADOW work and advances the cursor in the same transaction. It
// never acks a receipt and never writes the overlay (I14). A shadow router
// that never ran starts at the horizon watermark (nothing captured before the
// engine ran becomes demand), and receipts older than the routing horizon are
// passed over: a backlog after downtime is history, not live demand. The
// receipts have no `page_id` index: a page's read walks every page's receipts
// past its cursor, so a lap that finds nothing of the page moves the cursor up
// to the watermark (at most once a minute) and a silent page's read stays
// within the horizon however long it is silent.

/** Receipts one shadow lap reads at most (design §3.12). */
export const SHADOW_WS_ROUTE_BATCH = 500;
/** A shadow lap passes over at most this many batches of stale receipts. */
export const SHADOW_WS_STALE_BATCHES_PER_LAP = 20;
/** Receipts received longer ago than this are not routed in shadow. */
export const SHADOW_WS_ROUTE_HORIZON_MS = 15 * 60_000;
/** A page with nothing past its cursor re-reads the horizon watermark at most
 *  this often (a cursor write per silent page per minute, not per lap). */
export const SHADOW_WS_FLOOR_EVERY_MS = 60_000;

/** A class name only: driver errors embed SQL and bound parameters. */
function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

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

/** Demand signals as work rows of one page; a key the page does not run in
 *  this mode (live-only in shadow, switched off by the owner) or a key no
 *  registry entry knows is dropped and counted. */
function upsertsOfSignals(
  signals: readonly DemandSignal[],
  input: {
    pageId: number;
    shadow: boolean;
    now: Date;
    page: Pick<SyncPageRow, "registryOverrides">;
    spec: (key: string) => EngineResourceSpec | null;
    metrics: Metrics;
  },
): UpsertDemandInput[] {
  const upserts: UpsertDemandInput[] = [];
  const mode = input.shadow ? "shadow" : "live";
  for (const signal of signals) {
    const spec = input.spec(signal.resource);
    if (spec === null) {
      input.metrics.increment("sync_ws_route_dropped", { resource: signal.resource, reason: "unknown_resource", mode });
      continue;
    }
    const upsert = demandToUpsert(signal, spec, { pageId: input.pageId, shadow: input.shadow, now: input.now, page: input.page });
    if (upsert === null) {
      input.metrics.increment("sync_ws_route_dropped", { resource: signal.resource, reason: "not_run_in_mode", mode });
      continue;
    }
    input.metrics.increment("sync_ws_route_demand", { resource: signal.resource, mode });
    upserts.push(upsert);
  }
  return upserts;
}

// ── live: the post-ack hook (I18) ───────────────────────────────────────────

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
    // Off: the legacy engine owns the page. Shadow: the shadow actor routes
    // the page's receipts from its cursor. No engine row: never engine-owned.
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
      shadow: false,
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

// ── shadow: the actor's demand feed (design §3.12, §6.4) ────────────────────

export interface ShadowWsFeedOptions {
  /** The runtime payload seam; without one only an inline body is read. */
  resolvePayload?: FanslyWsLivePayloadResolver;
  batch?: number;
  horizonMs?: number;
}

/** What one shadow lap did (tests, metrics). */
export interface ShadowWsRouteResult {
  routed: number;
  stale: number;
  unreadable: number;
  cursor: number;
  signals: number;
}

/** The in-memory state a page's shadow feed keeps between laps. */
export interface ShadowWsFeedState {
  window: OwnBroadcastWindow;
  /** Monotonic time the horizon watermark was last read (`clock.monoNow`). */
  floorCheckedMono?: number;
}

interface PageWindow extends ShadowWsFeedState {
  generation: bigint;
}

/**
 * Route one shadow page's receipts past its cursor into shadow work (one
 * lap's worth). Generation-fenced: a foreign generation throws
 * `OwnershipLostError` and nothing is written. Exported for tests; the actor
 * runs it through `createFanslyShadowWsFeed`.
 */
export async function routeShadowReceipts(
  d: CommitDeps,
  state: ShadowWsFeedState,
  options: ShadowWsFeedOptions = {},
): Promise<ShadowWsRouteResult> {
  const batch = options.batch ?? SHADOW_WS_ROUTE_BATCH;
  const horizonMs = options.horizonMs ?? SHADOW_WS_ROUTE_HORIZON_MS;
  const result: ShadowWsRouteResult = { routed: 0, stale: 0, unreadable: 0, cursor: 0, signals: 0 };
  const page = await getSyncPage(d.db, d.pageId);
  if (page === null || page.mode !== "shadow") return result;
  // `result.cursor` stays the stored cursor until the lap's write moves it.
  let cursor = page.wsRouterCursor;
  result.cursor = cursor;
  const floorAtWatermark = async () => {
    state.floorCheckedMono = d.clock.monoNow();
    cursor = Math.max(cursor, await wsRouterHorizonWatermark(d.db, { horizonMs }));
  };

  // Never ran: skip the history up to the routing horizon.
  if (cursor === 0) await floorAtWatermark();

  // Read past the stale backlog (bodies are not read for stale rows).
  let receipts: WsRouterReceipt[] = [];
  let reachedEnd = false;
  for (let pass = 0; pass < SHADOW_WS_STALE_BATCHES_PER_LAP; pass += 1) {
    const read = await listWsRouterReceipts(d.db, { pageId: d.pageId, after: cursor, limit: batch, horizonMs });
    if (read.length === 0) {
      reachedEnd = true;
      break;
    }
    const firstFresh = read.findIndex((receipt) => !receipt.stale);
    if (firstFresh === -1) {
      result.stale += read.length;
      cursor = read.at(-1)!.observationId;
      if (read.length < batch) {
        reachedEnd = true;
        break;
      }
      continue;
    }
    result.stale += firstFresh;
    receipts = read.slice(firstFresh);
    if (firstFresh > 0) cursor = read[firstFresh - 1]!.observationId;
    break;
  }

  const routed: Array<{ items: WsItem[]; fallback: boolean }> = [];
  for (const receipt of receipts) {
    if (receipt.stale) {
      result.stale += 1;
      continue;
    }
    let frame: string | null = null;
    if (!receipt.missing) {
      try {
        const payload = options.resolvePayload === undefined
          ? receipt.payload
          : await options.resolvePayload(d.db, receipt.observationId, { payload: receipt.payload, payloadRef: receipt.payloadRef });
        frame = socketFrameOf(payload);
      } catch (error) {
        d.logger.warn({ pageId: d.pageId, observationId: receipt.observationId, err: errorClass(error) },
          "Fansly sync shadow: a WS receipt's body is unreadable; it is passed over");
      }
    }
    if (frame === null) {
      result.unreadable += 1;
      continue;
    }
    const decoded = decodeFanslyWsFrame(frame, receipt.ownRef);
    const atMs = receipt.receivedAt.getTime();
    // The rate fallback counts own messages by receipt time, in routing order.
    const own = unmarkedOwnMessages(decoded.items);
    for (const item of decoded.items) {
      if (item.kind === "message_created" && item.isOwn) state.window.record(item.message.groupId, atMs);
    }
    routed.push({ items: decoded.items, fallback: own.length > 0 && state.window.activeAt(atMs) });
    for (const item of decoded.items) d.metrics.increment("sync_shadow_ws_items", { pageId: d.pageId, kind: item.kind });
    result.routed += 1;
  }
  // Nothing of this page past the cursor: the next read starts at the
  // horizon watermark instead of walking every page's receipts since the
  // page's last one.
  if (receipts.length === 0 && reachedEnd
    && (state.floorCheckedMono === undefined || d.clock.monoNow() - state.floorCheckedMono >= SHADOW_WS_FLOOR_EVERY_MS)) {
    await floorAtWatermark();
  }
  const lastId = receipts.at(-1)?.observationId ?? cursor;
  if (lastId === result.cursor) return result;

  const now = d.clock.wallNow();
  const signals: DemandSignal[] = [];
  if (routed.length > 0) {
    const ctx = await loadRouteContext(d.db, {
      pageId: d.pageId,
      nowMs: now.getTime(),
      items: routed.flatMap((receipt) => receipt.items),
      ownBroadcast: () => false,
    });
    for (const receipt of routed) {
      signals.push(...routeWsItems(receipt.items, {
        ...ctx,
        ownBroadcastActive: (item) => isOwnBroadcastMarked(item) || receipt.fallback,
      }));
    }
  }
  const upserts = upsertsOfSignals(mergeDemandSignals(signals), {
    pageId: d.pageId,
    shadow: true,
    now,
    page,
    spec: (key) => d.registry.spec(key),
    metrics: d.metrics,
  });
  await d.db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
    if (upserts.length > 0) await upsertDemands(tx, upserts);
    await advanceWsRouterCursor(tx, { pageId: d.pageId, generation: d.generation, cursor: lastId });
  });
  result.cursor = lastId;
  result.signals = upserts.length;
  if (result.stale > 0) d.metrics.increment("sync_shadow_ws_receipts", { pageId: d.pageId, outcome: "stale" }, result.stale);
  if (result.unreadable > 0) d.metrics.increment("sync_shadow_ws_receipts", { pageId: d.pageId, outcome: "unreadable" }, result.unreadable);
  if (result.routed > 0) d.metrics.increment("sync_shadow_ws_receipts", { pageId: d.pageId, outcome: "routed" }, result.routed);
  return result;
}

/**
 * The shadow actor's WS demand feed (`ShadowFeed`, run once per lap). It keeps
 * one rate-fallback window per page and generation (a new owner starts with
 * an empty window: at most the fallback's threshold of extra reads).
 */
export function createFanslyShadowWsFeed(options: ShadowWsFeedOptions = {}): ShadowFeed {
  const windows = new Map<number, PageWindow>();
  return async (d) => {
    let state = windows.get(d.pageId);
    if (state === undefined || state.generation !== d.generation) {
      state = { generation: d.generation, window: new OwnBroadcastWindow() };
      windows.set(d.pageId, state);
    }
    await routeShadowReceipts(d, state, options);
  };
}
