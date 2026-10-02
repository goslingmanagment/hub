import { describe, expect, it } from "vitest";

import {
  captureTarget,
  judgePurchaseAnnouncements,
  legacyOrdersOf,
  purchaseAnnouncementNote,
  purchaseAnnouncementSummary,
  type ReadCapture,
} from "../apps/runtime/src/sync/report/purchase-announcements.ts";

// Rule A2.demand-replaced (shadow report A2): every order the legacy purchase
// poll read in the window must be one the engine hears of — a PPV ledger row
// of the same content, buyer and second, or a socket order frame with its
// order id. A target read without an order needs no read; an unannounced
// order or an unreadable body fails the check.

const FAN = "200000000000000001";
const OTHER_FAN = "200000000000000002";
// 2026-10-01T03:35:08Z, the production order of ari-1's media 961859486463582209.
const ORDERED_MS = 1_790_825_708_000;

function orderRow(overrides: Record<string, unknown> = {}) {
  return { orderId: "961885393169444864", accountId: FAN, accountMediaId: "961859486463582209", createdAt: ORDERED_MS, type: 1, ...overrides };
}

function capture(overrides: Partial<ReadCapture> & Pick<ReadCapture, "orders">): ReadCapture {
  return { page: "ari-1", pageId: 10, captureId: 1, target: "media:961859486463582209", ...overrides };
}

const sale = { contentId: "961859486463582209", buyerRef: FAN, occurredAt: new Date(ORDERED_MS) };

describe("rule A2.demand-replaced: the orders a legacy purchase-history body holds", () => {
  it("reads every order row: the bundle before the media, epoch milliseconds or seconds", () => {
    expect(legacyOrdersOf({ aggregationData: { accounts: [] }, accountMediaOrderHistory: [
      orderRow(),
      orderRow({ orderId: "2", accountMediaBundleId: "777", accountMediaId: "778", createdAt: ORDERED_MS / 1000 }),
    ] })).toEqual([
      { orderId: "961885393169444864", buyerRef: FAN, contentId: "961859486463582209", orderedAt: new Date(ORDERED_MS) },
      { orderId: "2", buyerRef: FAN, contentId: "777", orderedAt: new Date(ORDERED_MS) },
    ]);
    // The older body shapes the legacy classifier accepts.
    expect(legacyOrdersOf({ accountMediaOrders: [orderRow()] })).toHaveLength(1);
    expect(legacyOrdersOf({ aggregationData: { accountMediaOrders: [orderRow()] } })).toHaveLength(1);
  });

  it("an empty page, a refusal or a body without an order array holds no order", () => {
    expect(legacyOrdersOf({ aggregationData: { accounts: [] }, accountMediaOrderHistory: [] })).toEqual([]);
    expect(legacyOrdersOf({ error: { status: 422, code: 99, details: "error getting account media", body: null } })).toEqual([]);
    expect(legacyOrdersOf(null)).toEqual([]);
  });

  it("names the target a capture asked for", () => {
    expect(captureTarget({ limit: 100, before: null, accountMediaId: "962420622200152064" })).toBe("media:962420622200152064");
    expect(captureTarget({ limit: 100, before: "1", accountMediaBundleId: "941543461356580864" })).toBe("bundle:941543461356580864");
    expect(captureTarget({ limit: 100 })).toBeNull();
  });
});

describe("rule A2.demand-replaced: each order read is announced to the engine", () => {
  const judge = (captures: ReadCapture[], input: { ledger?: Array<typeof sale>; socket?: string[] } = {}) => judgePurchaseAnnouncements({
    captures,
    ledger: new Map([[10, input.ledger ?? []]]),
    socketOrderIds: new Map([[10, new Set(input.socket ?? [])]]),
    maxListed: 5,
  });

  it("the window of 2026-10-02 17:42–18:42: three PPV media lora-1's poll found in chats, each an empty page — nothing to announce", () => {
    const check = judge([1, 2, 3].map((id) => capture({ page: "lora-1", pageId: 10, captureId: id, target: `media:${id}`, orders: [] })));
    expect(check).toEqual({
      captures: 3, targets: 3, targetsWithOrders: 0, orders: 0, ledger: 0, socketOnly: 0,
      unannounced: [], unannouncedCount: 0, unreadable: [], passes: true,
    });
    expect(purchaseAnnouncementSummary(check)).toBe(
      "the poll read 3 targets in 3 captures, 0 with orders: 0 orders, every one announced (0 by a PPV ledger row, 0 by a socket order frame alone)",
    );
  });

  it("a PPV ledger row of the same content, buyer and second announces an order", () => {
    const orders = legacyOrdersOf({ accountMediaOrderHistory: [orderRow({ createdAt: ORDERED_MS + 400 })] });
    expect(judge([capture({ orders })], { ledger: [sale] })).toMatchObject({ orders: 1, ledger: 1, socketOnly: 0, passes: true });
    // Another buyer, another second or another content is another sale.
    expect(judge([capture({ orders })], { ledger: [{ ...sale, buyerRef: OTHER_FAN }] })).toMatchObject({ ledger: 0, unannouncedCount: 1, passes: false });
    expect(judge([capture({ orders })], { ledger: [{ ...sale, occurredAt: new Date(ORDERED_MS + 1_000) }] })).toMatchObject({ ledger: 0, passes: false });
    expect(judge([capture({ orders })], { ledger: [{ ...sale, contentId: "1" }] })).toMatchObject({ ledger: 0, passes: false });
    // Another page's ledger never announces it.
    expect(judgePurchaseAnnouncements({
      captures: [capture({ orders })], ledger: new Map([[11, [sale]]]), socketOrderIds: new Map(), maxListed: 5,
    })).toMatchObject({ ledger: 0, passes: false });
  });

  it("a socket order frame of the page with the order id announces an order the ledger lacks (yet)", () => {
    const orders = legacyOrdersOf({ accountMediaOrderHistory: [orderRow()] });
    expect(judge([capture({ orders })], { socket: ["961885393169444864"] })).toMatchObject({ ledger: 0, socketOnly: 1, passes: true });
    expect(judge([capture({ orders })], { socket: ["1"] })).toMatchObject({ socketOnly: 0, unannouncedCount: 1, passes: false });
  });

  it("an order neither announces is a purchase only the poll found: the check fails and names it", () => {
    const check = judge([
      capture({ captureId: 7, orders: legacyOrdersOf({ accountMediaOrderHistory: [orderRow(), orderRow({ orderId: "9", accountId: OTHER_FAN })] }) }),
    ], { ledger: [sale] });
    expect(check).toMatchObject({
      orders: 2, ledger: 1, unannouncedCount: 1, passes: false,
      unannounced: [{ page: "ari-1", pageId: 10, target: "media:961859486463582209", orderId: "9", orderedAt: new Date(ORDERED_MS) }],
    });
    expect(purchaseAnnouncementNote(check)).toBe(
      "rule A2.demand-replaced: purchases.targets runs on demand only (the socket's order frames; live, also the transactions "
        + "apply's new PPV sales, which name no target in shadow), compared after the switch; the poll read 1 target in 1 capture, "
        + "1 with orders: 2 orders; 1 NOT announced, a purchase only the poll found (ari-1 media:961859486463582209 order 9); "
        + "announced 1 by a PPV ledger row, 0 by a socket order frame alone",
    );
  });

  it("a capture body the report cannot read fails the check", () => {
    const check = judge([capture({ captureId: 42, orders: null }), capture({ captureId: 43, target: "media:2", orders: [] })]);
    expect(check).toMatchObject({ captures: 2, targets: 2, orders: 0, unreadable: [{ page: "ari-1", captureId: 42 }], passes: false });
    expect(purchaseAnnouncementSummary(check)).toContain("1 capture body unreadable (ari-1 #42)");
  });

  it("an order read twice (a head re-read) is one purchase; targets count once per page", () => {
    const orders = legacyOrdersOf({ accountMediaOrderHistory: [orderRow()] });
    const check = judge([capture({ captureId: 1, orders }), capture({ captureId: 2, orders })], { ledger: [sale] });
    expect(check).toMatchObject({ captures: 2, targets: 1, targetsWithOrders: 1, orders: 1, ledger: 1, passes: true });
  });

  it("lists at most maxListed unannounced orders and counts them all", () => {
    const orders = legacyOrdersOf({ accountMediaOrderHistory: Array.from({ length: 8 }, (_, index) => orderRow({ orderId: String(index + 1) })) });
    const check = judge([capture({ orders })]);
    expect(check.unannouncedCount).toBe(8);
    expect(check.unannounced).toHaveLength(5);
  });
});
