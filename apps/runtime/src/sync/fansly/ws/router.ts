import type { DemandSignal } from "../../engine/resource.ts";
import type { WsItem } from "./decode.ts";

// The WebSocket demand router (design §6.2): decoded socket items → demand
// for registry resources. Pure: the facts it needs (the page's threads, the
// ledger's pending transactions, whether an own message is part of a mass
// broadcast) come in through `RouteContext`, loaded by the caller — the
// post-ack hook of a live page (I18) or the shadow feed of a shadow page.
// One table decides every route; the coalescing windows, classes and
// deadlines of each target come from its registry entry when the demand is
// written (`demandToUpsert`).
//
// | Item                                                      | Demand                                         |
// |-----------------------------------------------------------|------------------------------------------------|
// | message created, bound non-excluded thread, fan           | dm-messages.head (fast window on attachments, tip, incomplete frame) |
// | message created, own, mass broadcast                      | none (decision №9, D22)                        |
// | message created, own, not a broadcast                     | dm-messages.head (normal window)               |
// | message created, excluded thread                          | none (overlay "API недоступен", decision №8)   |
// | message created, unknown or unbound thread                | dm-conversations.find                          |
// | message created, already confirmed by REST                | none                                           |
// | message deleted                                           | dm-live.deletions (no HTTP)                    |
// | chat created                                              | dm-conversations.find                          |
// | transaction status 1, type ≠ 16012                        | transactions.head (2 s fixed window)           |
// | transaction status 2 of a pending ledger row              | transactions.rescan (now)                      |
// | transaction type 16012 (payout)                           | payouts.daily (now)                            |
// | PPV order                                                 | transactions.head + purchases.targets (media/bundle ids) |
// | wallet                                                    | transactions.head                              |
// | subscription                                              | transactions.head + subscribers.poll (now)     |
// | payout request                                            | payouts.daily (now)                            |
// | broken frame naming a chat (plan §7 p.10 (a))             | dm-messages.head at +15 s                      |
// | broken frame without a chat (plan §7 p.10 (b))            | repair.ws-gap at +10 s (coalesced)             |
// | anything else                                             | none                                           |

/** Fansly's payout transaction type: never in the earnings listing. */
export const FANSLY_PAYOUT_TRANSACTION_TYPE = 16012;
/** Transaction status of a new ledger row and of a settled one. */
export const FANSLY_TRANSACTION_STATUS_NEW = 1;
export const FANSLY_TRANSACTION_STATUS_SETTLED = 2;

/**
 * [A6], measured on the production journal (7 days to 2026-10-02): the
 * page's own mass messages arrive as `message.type = 2` sharing one
 * `correlationId` per broadcast (1 920 chats in 2.5 min, 5 858 chats in
 * 10 min); chatter replies are type 1. The rate fallback below catches a
 * broadcast whose marker changes.
 */
export const OWN_BROADCAST_MESSAGE_TYPE = 2;
/** Rate fallback: more than this many own messages in distinct chats … */
export const OWN_BROADCAST_FALLBACK_CHATS = 20;
/** … within this window make every own message a broadcast (the peak of
 *  chatter replies in the same journal: 17 distinct chats in 60 s). */
export const OWN_BROADCAST_FALLBACK_WINDOW_MS = 60_000;

/** A broken frame naming a chat: that chat's head after this long (§7 p.10 (a)). */
export const INVALID_KNOWN_CHAT_DELAY_MS = 15_000;
/** A broken frame without a chat: one page repair, coalesced this long (§7 p.10 (b)). */
export const INVALID_NO_CHAT_REPAIR_DELAY_MS = 10_000;
/** A fast confirmation is due this soon after its first event (plan §7 p.4). */
export const FAST_CONFIRM_DEADLINE_MS = 10_000;

export interface RouteThread {
  /** A thread row exists on the page. */
  known: boolean;
  /** It is bound to a fan (only bound threads are read). */
  bound: boolean;
  /** Excluded from message sync (decision №8). */
  excluded: boolean;
  /** The newest message REST confirmed in the chain. */
  headConfirmedId: string | null;
}

export interface RouteContext {
  pageId: number;
  nowMs: number;
  thread(groupId: string): RouteThread;
  /** A ledger row of the page with this id is still `pending`. */
  knownPendingTransaction(id: string): boolean;
  /** This own message is part of a mass broadcast ([A6] marker or the rate
   *  fallback). */
  ownBroadcastActive(item: Extract<WsItem, { kind: "message_created" }>): boolean;
}

const UNKNOWN_THREAD: RouteThread = { known: false, bound: false, excluded: false, headConfirmedId: null };

/** A thread unknown to the context. */
export function unknownRouteThread(): RouteThread {
  return UNKNOWN_THREAD;
}

/** Snowflake order of two Fansly ids (decimal strings). */
function snowflakeAtMost(id: string, bound: string): boolean {
  try {
    return BigInt(id) <= BigInt(bound);
  } catch {
    return false;
  }
}

/** Route one item. */
function routeItem(item: WsItem, ctx: RouteContext): DemandSignal[] {
  const at = (ms: number) => new Date(ctx.nowMs + ms);
  switch (item.kind) {
    case "message_created": {
      const groupId = item.message.groupId;
      const thread = ctx.thread(groupId);
      if (thread.excluded) return [];
      if (!thread.known || !thread.bound) {
        return [{ resource: "dm-conversations.find", subject: groupId, demand: { reason: "ws:message_unknown_chat" } }];
      }
      // A late frame of a message REST already confirmed: nothing to read.
      if (thread.headConfirmedId !== null && snowflakeAtMost(item.message.id, thread.headConfirmedId)) return [];
      if (item.isOwn) {
        if (ctx.ownBroadcastActive(item)) return [];
        return [{
          resource: "dm-messages.head",
          subject: groupId,
          coalesce: "normal",
          demand: { messageIds: [item.message.id], reason: "ws:message_created:own" },
        }];
      }
      return [{
        resource: "dm-messages.head",
        subject: groupId,
        coalesce: item.fast ? "fast" : "normal",
        demand: { messageIds: [item.message.id], reason: "ws:message_created" },
        ...(item.fast ? { deadlineMs: FAST_CONFIRM_DEADLINE_MS } : {}),
      }];
    }
    case "message_deleted":
      return [{
        resource: "dm-live.deletions",
        subject: item.groupId ?? "",
        demand: { messageIds: [item.messageId], reason: "ws:message_deleted" },
      }];
    case "group_created":
      return [{ resource: "dm-conversations.find", subject: item.groupRef, demand: { reason: "ws:group_created" } }];
    case "transaction": {
      if (item.type === FANSLY_PAYOUT_TRANSACTION_TYPE) {
        return [{ resource: "payouts.daily", dueAt: at(0), demand: { reason: "ws:transaction:payout" } }];
      }
      if (item.status === FANSLY_TRANSACTION_STATUS_NEW) {
        return [{ resource: "transactions.head", demand: { txIds: [item.id], reason: "ws:transaction" } }];
      }
      if (item.status === FANSLY_TRANSACTION_STATUS_SETTLED && ctx.knownPendingTransaction(item.id)) {
        return [{ resource: "transactions.rescan", dueAt: at(0), demand: { txIds: [item.id], reason: "ws:transaction:settled" } }];
      }
      return [];
    }
    case "order": {
      const targets = [
        ...(item.accountMediaId === null ? [] : [`media:${item.accountMediaId}`]),
        ...(item.accountMediaBundleId === null ? [] : [`bundle:${item.accountMediaBundleId}`]),
      ];
      return [
        { resource: "transactions.head", demand: { reason: "ws:order" } },
        ...(targets.length === 0 ? [] : [{ resource: "purchases.targets", ids: targets, demand: { reason: "ws:order" } }]),
      ];
    }
    case "wallet":
      return [{ resource: "transactions.head", demand: { reason: "ws:wallet" } }];
    case "subscription":
      return [
        { resource: "transactions.head", demand: { reason: "ws:subscription" } },
        { resource: "subscribers.poll", dueAt: at(0), demand: { reason: "ws:subscription" } },
      ];
    case "payout_request":
      return [{ resource: "payouts.daily", dueAt: at(0), demand: { reason: "ws:payout_request" } }];
    case "invalid": {
      if (item.groupRef !== null) {
        const thread = ctx.thread(item.groupRef);
        if (thread.excluded) return [];
        if (!thread.known || !thread.bound) {
          return [{ resource: "dm-conversations.find", subject: item.groupRef, demand: { reason: "ws:message_unknown_chat:invalid" } }];
        }
        return [{
          resource: "dm-messages.head",
          subject: item.groupRef,
          dueAt: at(INVALID_KNOWN_CHAT_DELAY_MS),
          demand: { reason: "ws:message_invalid_known_chat" },
        }];
      }
      return [{ resource: "repair.ws-gap", dueAt: at(INVALID_NO_CHAT_REPAIR_DELAY_MS), demand: { reason: `ws:invalid:${item.reason}` } }];
    }
    case "other":
      return [];
  }
}

/**
 * Route the decoded items of one frame (or of several frames of one page):
 * one signal per work key, demands merged (message and transaction ids,
 * reasons, batch ids), the earliest due time, the shortest deadline, the fast
 * window when any item asked for it. Returned in the lock order of new work
 * rows, (resource, subject).
 */
export function routeWsItems(items: readonly WsItem[], ctx: RouteContext): DemandSignal[] {
  const signals: DemandSignal[] = [];
  for (const item of items) signals.push(...routeItem(item, ctx));
  return mergeDemandSignals(signals);
}

function mergeIds(a: readonly string[] | undefined, b: readonly string[] | undefined): string[] | undefined {
  if (a === undefined && b === undefined) return undefined;
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

/** The earlier due time. No due time means the target's default — now, or
 *  the end of its quiet window — which is never later than an explicit due
 *  time of this router (now, +10 s, +15 s), so it wins. */
function earlier(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (a === undefined || b === undefined) return undefined;
  return a.getTime() <= b.getTime() ? a : b;
}

function shorter(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** One signal per (resource, subject); see `routeWsItems`. */
export function mergeDemandSignals(signals: readonly DemandSignal[]): DemandSignal[] {
  const byKey = new Map<string, DemandSignal>();
  for (const signal of signals) {
    const key = `${signal.resource}\u0000${signal.subject ?? ""}`;
    const seen = byKey.get(key);
    if (seen === undefined) {
      byKey.set(key, { ...signal });
      continue;
    }
    const merged: DemandSignal = { ...seen };
    const dueAt = earlier(seen.dueAt, signal.dueAt);
    if (dueAt === undefined) delete merged.dueAt;
    else merged.dueAt = dueAt;
    const deadlineMs = shorter(seen.deadlineMs, signal.deadlineMs);
    if (deadlineMs !== undefined) merged.deadlineMs = deadlineMs;
    if (seen.coalesce === "fast" || signal.coalesce === "fast") merged.coalesce = "fast";
    const ids = mergeIds(seen.ids, signal.ids);
    if (ids !== undefined) merged.ids = ids;
    if (seen.demand !== undefined || signal.demand !== undefined) {
      const messageIds = mergeIds(seen.demand?.messageIds, signal.demand?.messageIds);
      const txIds = mergeIds(seen.demand?.txIds, signal.demand?.txIds);
      const reasons = [...new Set([seen.demand?.reason, signal.demand?.reason].filter((r): r is string => r !== undefined))];
      merged.demand = {
        reason: reasons.join(","),
        ...(messageIds === undefined ? {} : { messageIds }),
        ...(txIds === undefined ? {} : { txIds }),
      };
    }
    byKey.set(key, merged);
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.resource !== b.resource) return a.resource < b.resource ? -1 : 1;
    const as = a.subject ?? "";
    const bs = b.subject ?? "";
    return as === bs ? 0 : as < bs ? -1 : 1;
  });
}

/** Whether an own message carries the measured broadcast marker ([A6]). */
export function isOwnBroadcastMarked(item: Extract<WsItem, { kind: "message_created" }>): boolean {
  return item.isOwn && item.message.type === OWN_BROADCAST_MESSAGE_TYPE;
}

/**
 * The rate fallback of a shadow page, over the receipts the shadow feed
 * routes (design §6.2 "in shadow the same count over receipts of the
 * window"): the distinct chats of own messages by receipt time. A live page
 * counts the overlay instead (`countRecentOwnLiveChats`).
 */
export class OwnBroadcastWindow {
  readonly #windowMs: number;
  readonly #threshold: number;
  /** groupId → latest receipt time of an own message in it. */
  #lastSeen = new Map<string, number>();
  #prunedAtMs = Number.NEGATIVE_INFINITY;

  constructor(options: { windowMs?: number; threshold?: number } = {}) {
    this.#windowMs = options.windowMs ?? OWN_BROADCAST_FALLBACK_WINDOW_MS;
    this.#threshold = options.threshold ?? OWN_BROADCAST_FALLBACK_CHATS;
  }

  /** Record an own message received at `atMs` in `groupId`. */
  record(groupId: string, atMs: number): void {
    const seen = this.#lastSeen.get(groupId);
    if (seen === undefined || atMs > seen) this.#lastSeen.set(groupId, atMs);
    // Forget chats that left the window, at most four times a window.
    if (atMs - this.#prunedAtMs >= this.#windowMs / 4) {
      this.#lastSeen = new Map([...this.#lastSeen].filter(([, at]) => at > atMs - this.#windowMs));
      this.#prunedAtMs = atMs;
    }
  }

  /** Distinct chats with an own message in (atMs − window, atMs]. */
  chatsAt(atMs: number): number {
    let count = 0;
    for (const seen of this.#lastSeen.values()) {
      if (seen > atMs - this.#windowMs && seen <= atMs) count += 1;
    }
    return count;
  }

  /** More than the threshold of distinct chats within the window. */
  activeAt(atMs: number): boolean {
    return this.chatsAt(atMs) > this.#threshold;
  }
}
