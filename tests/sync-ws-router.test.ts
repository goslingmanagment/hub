import { describe, expect, it } from "vitest";

import { FANSLY_WS_LIVE_DECODER_VERSION, FANSLY_WS_MAX_FRAME_BYTES } from "@agency_hub_core/shared";

import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { decodeFanslyWsFrame, WS_ROUTE_DECODER_VERSION, type WsItem } from "../apps/runtime/src/sync/fansly/ws/decode.ts";
import {
  FAST_CONFIRM_DEADLINE_MS,
  INVALID_KNOWN_CHAT_DELAY_MS,
  INVALID_NO_CHAT_REPAIR_DELAY_MS,
  mergeDemandSignals,
  OwnBroadcastWindow,
  routeWsItems,
  unknownRouteThread,
  type RouteContext,
  type RouteThread,
} from "../apps/runtime/src/sync/fansly/ws/router.ts";
import { serviceFrame, wrapped } from "./helpers/fansly-ws-fixtures.ts";

// The engine's WebSocket decode + router (design §6.1, §6.2): every row of the
// routing table, the broadcast rule [A6] with its rate fallback, the fast
// confirmation window, the demand merge, and that every target is a registry
// entry that declares the trigger.

const OWN = "100000000000000001";
const FAN = "200000000000000001";
const GROUP = "300000000000000001";
const OTHER_GROUP = "300000000000000002";
const NOW = Date.parse("2026-10-02T12:00:00.000Z");

let nextId = 400_000_000_000_000_000n;
function message(overrides: Record<string, unknown> = {}) {
  return {
    id: String(nextId++), groupId: GROUP, senderId: FAN, createdAt: NOW / 1000 - 1,
    content: "hi", attachments: [], type: 1, ...overrides,
  } as Record<string, unknown> & { id: string };
}
const created = (msg: Record<string, unknown>) => serviceFrame({ type: 1, message: msg });
const batch = (...frames: string[]) => wrapped(10001, frames);

function items(frame: string, ownRef: string | null = OWN): WsItem[] {
  return decodeFanslyWsFrame(frame, ownRef).items;
}

const BOUND: RouteThread = { known: true, bound: true, excluded: false, headConfirmedId: null };

function context(overrides: {
  threads?: Record<string, RouteThread>;
  pending?: string[];
  broadcast?: boolean;
} = {}): RouteContext {
  return {
    pageId: 7,
    nowMs: NOW,
    thread: (groupId) => overrides.threads?.[groupId] ?? unknownRouteThread(),
    knownPendingTransaction: (id) => overrides.pending?.includes(id) ?? false,
    ownBroadcastActive: (item) => item.message.type === 2 || overrides.broadcast === true,
  };
}

describe("decodeFanslyWsFrame (design §6.1)", () => {
  it("keeps the step-1 message decoder and marks own and fast messages", () => {
    const tipped = message({ messageTip: { amount: 5000, receiverId: OWN } });
    const withMedia = message({ attachments: [{ contentType: 1, contentId: "500000000000000001" }] });
    const plain = message();
    const incomplete = message();
    delete incomplete.content;
    const own = message({ senderId: OWN });
    const decoded = decodeFanslyWsFrame(batch(created(tipped), created(withMedia), created(plain), created(incomplete), created(own)), OWN);
    expect(decoded.messageDecoderVersion).toBe(FANSLY_WS_LIVE_DECODER_VERSION);
    expect(decoded.routeDecoderVersion).toBe(WS_ROUTE_DECODER_VERSION);
    expect(decoded.items.map((item) => item.kind === "message_created"
      ? { id: item.message.id, path: item.path, isOwn: item.isOwn, fast: item.fast } : item.kind)).toEqual([
      { id: tipped.id, path: [0], isOwn: false, fast: true },
      { id: withMedia.id, path: [1], isOwn: false, fast: true },
      { id: plain.id, path: [2], isOwn: false, fast: false },
      { id: incomplete.id, path: [3], isOwn: false, fast: true },
      { id: own.id, path: [4], isOwn: true, fast: false },
    ]);
    // Without the page's own id nothing is own.
    expect(items(created(own), null)).toMatchObject([{ kind: "message_created", isOwn: false }]);
  });

  it("decodes chats, money, subscriptions and payouts; everything else is other", () => {
    const frame = batch(
      serviceFrame({ type: 10, message: { id: "600000000000000001", groupId: GROUP, type: 1 } }),
      serviceFrame({ type: 10, message: { id: "600000000000000002" } }),
      serviceFrame({ type: 8, id: OTHER_GROUP }, 4),
      serviceFrame({ type: 3, transaction: { id: "700000000000000001", type: 2110, status: 1, amount: 5000, correlationId: "710000000000000001" } }, 6),
      serviceFrame({ type: 2, wallet: { id: "720000000000000001", balance: 100 } }, 6),
      serviceFrame({ type: 7, order: { orderId: "730000000000000001", accountMediaId: "740000000000000001", correlationAccountId: FAN, type: 1 } }, 2),
      serviceFrame({ type: 5, subscription: { id: "750000000000000001", subscriberId: FAN, status: 3, price: 999 } }, 15),
      serviceFrame({ type: 20, payoutRequest: { id: "760000000000000001", status: 1 } }, 16),
      serviceFrame({ type: 21, payoutRequest: { id: "760000000000000001", status: 2 } }, 16),
      serviceFrame({ type: 22, typingAnnounceEvent: { groupId: GROUP } }, 5),
      serviceFrame({ type: 2, ackCommand: {} }, 4),
      JSON.stringify({ t: 2, d: "pong" }),
    );
    expect(items(frame)).toEqual([
      { kind: "message_deleted", path: [0], messageId: "600000000000000001", groupId: GROUP },
      { kind: "message_deleted", path: [1], messageId: "600000000000000002", groupId: null },
      { kind: "group_created", path: [2], groupRef: OTHER_GROUP },
      { kind: "transaction", path: [3], id: "700000000000000001", type: 2110, status: 1, correlationId: "710000000000000001" },
      { kind: "wallet", path: [4], id: "720000000000000001" },
      { kind: "order", path: [5], orderId: "730000000000000001", accountMediaId: "740000000000000001", accountMediaBundleId: null, correlationAccountId: FAN },
      { kind: "subscription", path: [6], id: "750000000000000001", subscriberId: FAN, status: 3 },
      { kind: "payout_request", path: [7], id: "760000000000000001", status: 1 },
      { kind: "payout_request", path: [8], id: "760000000000000001", status: 2 },
      { kind: "other", path: [9], serviceId: 5, eventType: 22 },
      { kind: "other", path: [10], serviceId: 4, eventType: 2 },
      { kind: "other", path: [11], serviceId: null, eventType: null },
    ]);
  });

  it("names the chat of a broken message envelope and calls broken money frames invalid", () => {
    const noSender = message();
    delete noSender.senderId;
    const frame = batch(
      created(noSender),
      created(message({ groupId: "not-a-ref" })),
      serviceFrame({ type: 3, transaction: { type: 2110, status: 1 } }, 6),
      serviceFrame({ type: 7, order: {} }, 2),
      serviceFrame({ type: 8 }, 4),
      "not json",
    );
    expect(items(frame)).toEqual([
      { kind: "invalid", path: [0], groupRef: GROUP, reason: "sender_id" },
      { kind: "invalid", path: [1], groupRef: null, reason: "group_id" },
      { kind: "invalid", path: [2], groupRef: null, reason: "transaction" },
      { kind: "invalid", path: [3], groupRef: null, reason: "order" },
      { kind: "invalid", path: [4], groupRef: null, reason: "group_created" },
      { kind: "invalid", path: [5], groupRef: null, reason: "envelope" },
    ]);
    expect(items("x".repeat(FANSLY_WS_MAX_FRAME_BYTES + 1))).toEqual([{ kind: "invalid", path: [], groupRef: null, reason: "limit" }]);
  });
});

describe("routeWsItems (design §6.2)", () => {
  it("confirms a fan message of a bound chat on the normal or the fast window", () => {
    const plain = message();
    const media = message({ attachments: [{ contentType: 2, contentId: "500000000000000002" }] });
    const ctx = context({ threads: { [GROUP]: BOUND, [OTHER_GROUP]: BOUND } });
    expect(routeWsItems(items(created(plain)), ctx)).toEqual([{
      resource: "dm-messages.head", subject: GROUP, coalesce: "normal",
      demand: { messageIds: [plain.id], reason: "ws:message_created" },
    }]);
    expect(routeWsItems(items(created({ ...media, groupId: OTHER_GROUP })), ctx)).toEqual([{
      resource: "dm-messages.head", subject: OTHER_GROUP, coalesce: "fast", deadlineMs: FAST_CONFIRM_DEADLINE_MS,
      demand: { messageIds: [media.id], reason: "ws:message_created" },
    }]);
  });

  it("own messages: a chatter reply is confirmed, a mass broadcast creates no work (decision №9, D22)", () => {
    const reply = message({ senderId: OWN });
    const broadcast = message({ senderId: OWN, type: 2, correlationId: "990000000000000001" });
    const ctx = context({ threads: { [GROUP]: BOUND } });
    expect(routeWsItems(items(created(reply)), ctx)).toEqual([{
      resource: "dm-messages.head", subject: GROUP, coalesce: "normal",
      demand: { messageIds: [reply.id], reason: "ws:message_created:own" },
    }]);
    expect(routeWsItems(items(created(broadcast)), ctx)).toEqual([]);
    // The rate fallback turns an unmarked own message into a broadcast too.
    expect(routeWsItems(items(created(reply)), context({ threads: { [GROUP]: BOUND }, broadcast: true }))).toEqual([]);
  });

  it("excluded, unknown, unbound and already confirmed chats", () => {
    const msg = message();
    expect(routeWsItems(items(created(msg)), context({ threads: { [GROUP]: { ...BOUND, excluded: true } } }))).toEqual([]);
    for (const thread of [unknownRouteThread(), { ...BOUND, bound: false }]) {
      expect(routeWsItems(items(created(msg)), context({ threads: { [GROUP]: thread } }))).toEqual([{
        resource: "dm-conversations.find", subject: GROUP, demand: { reason: "ws:message_unknown_chat" },
      }]);
    }
    // A late frame of a message REST already confirmed needs no read.
    expect(routeWsItems(items(created(msg)), context({ threads: { [GROUP]: { ...BOUND, headConfirmedId: msg.id } } }))).toEqual([]);
    const newer = message();
    expect(routeWsItems(items(created(newer)), context({ threads: { [GROUP]: { ...BOUND, headConfirmedId: msg.id } } })))
      .toMatchObject([{ resource: "dm-messages.head", subject: GROUP }]);
  });

  it("deletions, new chats, money, subscriptions and payouts", () => {
    const route = (frame: string, ctx = context()) => routeWsItems(items(frame), ctx);
    expect(route(serviceFrame({ type: 10, message: { id: "600000000000000001", groupId: GROUP } }))).toEqual([{
      resource: "dm-live.deletions", subject: GROUP, demand: { messageIds: ["600000000000000001"], reason: "ws:message_deleted" },
    }]);
    expect(route(serviceFrame({ type: 10, message: { id: "600000000000000002" } }))).toEqual([{
      resource: "dm-live.deletions", subject: "", demand: { messageIds: ["600000000000000002"], reason: "ws:message_deleted" },
    }]);
    expect(route(serviceFrame({ type: 8, id: OTHER_GROUP }, 4))).toEqual([{
      resource: "dm-conversations.find", subject: OTHER_GROUP, demand: { reason: "ws:group_created" },
    }]);
    const tx = (id: string, type: number, status: number) => serviceFrame({ type: 3, transaction: { id, type, status } }, 6);
    expect(route(tx("700000000000000001", 2110, 1))).toEqual([{
      resource: "transactions.head", demand: { txIds: ["700000000000000001"], reason: "ws:transaction" },
    }]);
    // A settlement matters only for a row the ledger still holds as pending.
    expect(route(tx("700000000000000002", 2110, 2))).toEqual([]);
    expect(route(tx("700000000000000002", 2110, 2), context({ pending: ["700000000000000002"] }))).toEqual([{
      resource: "transactions.rescan", dueAt: new Date(NOW), demand: { txIds: ["700000000000000002"], reason: "ws:transaction:settled" },
    }]);
    for (const status of [1, 2]) {
      expect(route(tx("700000000000000003", 16012, status))).toEqual([{
        resource: "payouts.daily", dueAt: new Date(NOW), demand: { reason: "ws:transaction:payout" },
      }]);
    }
    expect(route(serviceFrame({ type: 7, order: { orderId: "730000000000000001", accountMediaId: "740000000000000001", accountMediaBundleId: "750000000000000001" } }, 2))).toEqual([
      { resource: "purchases.targets", ids: ["media:740000000000000001", "bundle:750000000000000001"], demand: { reason: "ws:order" } },
      { resource: "transactions.head", demand: { reason: "ws:order" } },
    ]);
    expect(route(serviceFrame({ type: 2, wallet: { id: "720000000000000001" } }, 6))).toEqual([
      { resource: "transactions.head", demand: { reason: "ws:wallet" } },
    ]);
    expect(route(serviceFrame({ type: 5, subscription: { id: "750000000000000001", status: 3 } }, 15))).toEqual([
      { resource: "subscribers.poll", dueAt: new Date(NOW), demand: { reason: "ws:subscription" } },
      { resource: "transactions.head", demand: { reason: "ws:subscription" } },
    ]);
    expect(route(serviceFrame({ type: 21, payoutRequest: { id: "760000000000000001", status: 2 } }, 16))).toEqual([
      { resource: "payouts.daily", dueAt: new Date(NOW), demand: { reason: "ws:payout_request" } },
    ]);
    expect(route(serviceFrame({ type: 22, typingAnnounceEvent: {} }, 5))).toEqual([]);
  });

  it("degradation rules (plan §7 p.10): a broken frame of a known chat reads its head at +15 s, else one page repair", () => {
    const noSender = message();
    delete noSender.senderId;
    expect(routeWsItems(items(created(noSender)), context({ threads: { [GROUP]: BOUND } }))).toEqual([{
      resource: "dm-messages.head", subject: GROUP, dueAt: new Date(NOW + INVALID_KNOWN_CHAT_DELAY_MS),
      demand: { reason: "ws:message_invalid_known_chat" },
    }]);
    expect(routeWsItems(items(created(noSender)), context())).toEqual([{
      resource: "dm-conversations.find", subject: GROUP, demand: { reason: "ws:message_unknown_chat:invalid" },
    }]);
    expect(routeWsItems(items(batch("garbage", serviceFrame({ type: 3, transaction: {} }, 6))), context())).toEqual([{
      resource: "repair.ws-gap", dueAt: new Date(NOW + INVALID_NO_CHAT_REPAIR_DELAY_MS),
      demand: { reason: "ws:invalid:envelope,ws:invalid:transaction" },
    }]);
  });

  it("merges a frame's demand per work key: ids, the fast window, the shortest deadline, the default due time", () => {
    const a = message();
    const b = message({ attachments: [{ contentType: 1, contentId: "500000000000000003" }] });
    const noSender = message();
    delete noSender.senderId;
    const signals = routeWsItems(items(batch(created(a), created(b), created(noSender))), context({ threads: { [GROUP]: BOUND } }));
    expect(signals).toEqual([{
      resource: "dm-messages.head", subject: GROUP, coalesce: "fast", deadlineMs: FAST_CONFIRM_DEADLINE_MS,
      demand: { messageIds: [a.id, b.id], reason: "ws:message_created,ws:message_invalid_known_chat" },
    }]);
    // Lock order of new work rows: (resource, subject).
    expect(mergeDemandSignals([
      { resource: "transactions.head" }, { resource: "dm-messages.head", subject: "b" }, { resource: "dm-messages.head", subject: "a" },
    ]).map((signal) => `${signal.resource}/${signal.subject ?? ""}`)).toEqual(["dm-messages.head/a", "dm-messages.head/b", "transactions.head/"]);
  });

  it("every target is a registry entry that declares the trigger", () => {
    const frames = [
      created(message()), created(message({ senderId: OWN })), serviceFrame({ type: 10, message: { id: "600000000000000001" } }),
      serviceFrame({ type: 8, id: OTHER_GROUP }, 4), serviceFrame({ type: 3, transaction: { id: "1", type: 2110, status: 1 } }, 6),
      serviceFrame({ type: 3, transaction: { id: "2", type: 2110, status: 2 } }, 6), serviceFrame({ type: 3, transaction: { id: "3", type: 16012, status: 1 } }, 6),
      serviceFrame({ type: 7, order: { orderId: "4", accountMediaId: "5" } }, 2), serviceFrame({ type: 2, wallet: { id: "6" } }, 6),
      serviceFrame({ type: 5, subscription: { id: "7" } }, 15), serviceFrame({ type: 20, payoutRequest: { id: "8" } }, 16),
      "garbage",
    ];
    const contexts = [context({ threads: { [GROUP]: BOUND }, pending: ["2"] }), context()];
    const seen = new Set<string>();
    for (const frame of frames) {
      for (const ctx of contexts) {
        for (const signal of routeWsItems(items(frame), ctx)) {
          const spec = fanslyResourceSpec(signal.resource);
          expect(spec, signal.resource).not.toBeNull();
          for (const reason of signal.demand!.reason.split(",")) {
            expect(spec!.triggers.some((trigger) => reason === trigger || reason.startsWith(`${trigger}:`)), `${signal.resource} ← ${reason}`).toBe(true);
          }
          seen.add(signal.resource);
        }
      }
    }
    expect([...seen].sort()).toEqual([
      "dm-conversations.find", "dm-live.deletions", "dm-messages.head", "payouts.daily", "purchases.targets", "repair.ws-gap",
      "subscribers.poll", "transactions.head", "transactions.rescan",
    ]);
  });
});

describe("OwnBroadcastWindow (the shadow rate fallback, design §6.2)", () => {
  it("more than 20 own messages in distinct chats within 60 s is a broadcast", () => {
    const window = new OwnBroadcastWindow();
    for (let chat = 0; chat < 20; chat++) window.record(`g${chat}`, NOW + chat * 1_000);
    expect(window.chatsAt(NOW + 19_000)).toBe(20);
    expect(window.activeAt(NOW + 19_000)).toBe(false);
    // Repeats in one chat do not count twice.
    window.record("g0", NOW + 20_000);
    expect(window.activeAt(NOW + 20_000)).toBe(false);
    window.record("g20", NOW + 21_000);
    expect(window.activeAt(NOW + 21_000)).toBe(true);
    // A minute later the early chats have left the window.
    expect(window.chatsAt(NOW + 62_500)).toBe(19);
    expect(window.activeAt(NOW + 62_500)).toBe(false);
  });
});
