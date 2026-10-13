import { describe, expect, it } from "vitest";

import type { FanslyPurchaseFacts } from "@agency_hub_core/db";

import {
  fanslyOrderMatches,
  fanslyPpvOffer,
  fanslyPpvState,
  fanslyPpvSuffix,
  fanslyPurchaseWalkComplete,
  formatTranscript,
  normalizeTranscriptMessages,
} from "../apps/runtime/src/modules/ai/index.ts";

// chat-extension R20 HF-7в, the rules of a Fansly paid attachment's purchase
// mark (AI-144): the Fansly extension 2.10.1's `findPpvPermission`,
// `extractPpvPriceMills`, `orderMatchesPurchaseRequest` and `ppvSuffix`
// (fansly-chat src/shared/transcript.ts and src/background/fansly-client.ts at
// ff30d00) over the hub's own stores, and what makes the hub sure an order is
// absent. The end-to-end reference through the canonicalizer and the database
// is tests/fansly-transcript-ppv.integration.test.ts.

describe("a paid attachment (2.10.1 findPpvPermission, extractPpvPriceMills)", () => {
  it("is paid by the first permission row with the PPV bit, at its price", () => {
    expect(fanslyPpvOffer([{ type: 2, flags: 1, price: 15_000, metadata: "" }])).toEqual({ priceMills: 15_000 });
    // Prod's other PPV rows carry the bit beside others (9, 13, 11, 3).
    expect(fanslyPpvOffer([{ flags: 9, price: 20_000 }])).toEqual({ priceMills: 20_000 });
    // A free row first, priced 0: not the price (the archive's one price would take it).
    expect(fanslyPpvOffer([{ flags: 4, price: 0 }, { flags: 13, price: 7_500 }])).toEqual({ priceMills: 7_500 });
  });

  it("takes the price inside the row's metadata when its own is 0, else names no price", () => {
    const metadata = JSON.stringify({ 1: JSON.stringify({ price: 12_000 }) });
    expect(fanslyPpvOffer([{ flags: 1, price: 0, metadata }])).toEqual({ priceMills: 12_000 });
    expect(fanslyPpvOffer([{ flags: 1, price: 0, metadata: "" }])).toEqual({ priceMills: null });
    expect(fanslyPpvOffer([{ flags: 1, metadata: "{not json" }])).toEqual({ priceMills: null });
    expect(fanslyPpvOffer([{ flags: 1, metadata: JSON.stringify({ 1: "{}" }) }])).toEqual({ priceMills: null });
    // Mills are whole: a fractional or unsafe price is no price.
    expect(fanslyPpvOffer([{ flags: 1, price: 1.5 }])).toEqual({ priceMills: null });
  });

  it("is free without a row with the PPV bit", () => {
    expect(fanslyPpvOffer([])).toBeNull();
    expect(fanslyPpvOffer(undefined)).toBeNull();
    expect(fanslyPpvOffer([{ type: 0, flags: 2, price: 0, metadata: "" }, { flags: 4, price: 0 }, { flags: 8 }])).toBeNull();
    expect(fanslyPpvOffer([null, "1", { price: 15_000 }])).toBeNull();
  });
});

describe("an order of the fan (2.10.1 orderMatchesPurchaseRequest over media_orders)", () => {
  const order = (mediaOfferRef: string, bundleRef: string | null, orderType: number | null) =>
    ({ mediaOfferRef, bundleRef, orderType });
  const media = { kind: "media" as const, ref: "10" };
  const bundle = { kind: "bundle" as const, ref: "20" };

  it("buys a single media by its own order of type 1, or of no type", () => {
    expect(fanslyOrderMatches(order("10", null, 1), media)).toBe(true);
    expect(fanslyOrderMatches(order("10", null, null), media)).toBe(true);
    expect(fanslyOrderMatches(order("10", null, 2), media)).toBe(false);
    expect(fanslyOrderMatches(order("10", null, 1001), media)).toBe(false);
    expect(fanslyOrderMatches(order("11", null, 1), media)).toBe(false);
    expect(fanslyOrderMatches(order("10", "10", 1), media)).toBe(false);
  });

  it("buys a bundle by the bundle's order: its id with type 2, or named as the bundle and not a single's", () => {
    // Prod: a bundle's order-history row is `accountMediaId: <bundle>, type: 2`.
    expect(fanslyOrderMatches(order("20", null, 2), bundle)).toBe(true);
    expect(fanslyOrderMatches(order("20", null, 1), bundle)).toBe(false);
    expect(fanslyOrderMatches(order("20", null, null), bundle)).toBe(false);
    expect(fanslyOrderMatches(order("20", "20", null), bundle)).toBe(true);
    expect(fanslyOrderMatches(order("20", "20", 2), bundle)).toBe(true);
    expect(fanslyOrderMatches(order("20", "20", 1), bundle)).toBe(false);
    expect(fanslyOrderMatches(order("21", "21", 2), bundle)).toBe(false);
  });
});

describe("the order history the hub read to its end", () => {
  const walk = (state: string, closeReason: string | null, pagesPending = false) => ({ state, closeReason, pagesPending });

  it("is a done walk that read to an empty page or to an order its previous whole walk saw, every page canonicalized", () => {
    expect(fanslyPurchaseWalkComplete(walk("done", "empty_page"))).toBe(true);
    expect(fanslyPurchaseWalkComplete(walk("done", "known_order"))).toBe(true);
    expect(fanslyPurchaseWalkComplete(walk("done", "empty_page", true))).toBe(false);
    expect(fanslyPurchaseWalkComplete(walk("done", "subject_terminal:422"))).toBe(false);
    expect(fanslyPurchaseWalkComplete(walk("done", null))).toBe(false);
    for (const state of ["open", "running", "quarantined", "cancelled", "superseded"]) {
      expect(fanslyPurchaseWalkComplete(walk(state, "empty_page")), state).toBe(false);
    }
    expect(fanslyPurchaseWalkComplete(undefined)).toBe(false);
  });
});

describe("the fan's state of a paid attachment", () => {
  const target = { kind: "media" as const, ref: "10" };
  const facts = (over: Partial<FanslyPurchaseFacts> = {}): FanslyPurchaseFacts => ({
    orders: [],
    walks: new Map([["media:10", { state: "done", closeReason: "empty_page", pagesPending: false }]]),
    ordersPending: new Set(),
    ...over,
  });

  it("is purchased by an order of the fan, whatever the walks say", () => {
    expect(fanslyPpvState(target, facts({ orders: [{ mediaOfferRef: "10", bundleRef: null, orderType: 1 }] })))
      .toBe("purchased");
    expect(fanslyPpvState(target, facts({
      orders: [{ mediaOfferRef: "10", bundleRef: null, orderType: 1 }],
      walks: new Map(),
      ordersPending: new Set(["10"]),
    }))).toBe("purchased");
  });

  it("is not purchased only when the whole history landed without one", () => {
    expect(fanslyPpvState(target, facts())).toBe("not purchased");
    // An order of the fan waits for the media plane.
    expect(fanslyPpvState(target, facts({ ordersPending: new Set(["10"]) }))).toBe("unknown");
    // Never walked (nobody bought it), or the walk is open.
    expect(fanslyPpvState(target, facts({ walks: new Map() }))).toBe("unknown");
    expect(fanslyPpvState(target, facts({
      walks: new Map([["media:10", { state: "running", closeReason: null, pagesPending: false }]]),
    }))).toBe("unknown");
    // The walk of a bundle with the same id is another target.
    expect(fanslyPpvState({ kind: "bundle", ref: "10" }, facts())).toBe("unknown");
    // The hub could not tell (no fan, a failed read).
    expect(fanslyPpvState(target, null)).toBe("unknown");
  });
});

describe("the mark (2.10.1 ppvSuffix)", () => {
  it("names the price in dollars and the state; no amount when the page served none", () => {
    expect(fanslyPpvSuffix({ priceMills: 15_000 }, "purchased")).toBe(" - PPV $15.00, purchased");
    expect(fanslyPpvSuffix({ priceMills: 4_999 }, "not purchased")).toBe(" - PPV $5.00, not purchased");
    expect(fanslyPpvSuffix({ priceMills: 12_345 }, "unknown")).toBe(" - PPV $12.35, unknown");
    expect(fanslyPpvSuffix({ priceMills: null }, "unknown")).toBe(" - PPV, unknown");
  });
});

describe("the normalizer with bodies that carry their own marks", () => {
  const at = "2026-10-01T10:00:00.000Z";
  const base = { isSentByMe: true, createdAt: at, text: "three things" };

  it("adds no message-level suffix to a message whose bodies are marked, and keeps it for the others", () => {
    const messages = normalizeTranscriptMessages([
      { ...base, id: "1", price: 20, isOpened: null },
      { ...base, id: "2", price: 15, isOpened: null, text: "unlock me" },
      // Marked, all free: the archive's price is not repeated.
      { ...base, id: "3", price: 9, text: "free now" },
    ], {
      mediaLabelBodiesByMessageId: new Map([
        ["1", ["Video - PPV $20.00, purchased", "Photo", "Media Bundle: 1 Photo, 1 Video - PPV $30.00, unknown"]],
        ["2", ["Video"]],
        ["3", ["Photo"]],
      ]),
      mediaLabelBodiesCarryPpv: new Set(["1", "3"]),
    });
    expect(formatTranscript(messages).split("\n")).toEqual([
      "[10:00] Model: [Video - PPV $20.00, purchased] [Photo] [Media Bundle: 1 Photo, 1 Video - PPV $30.00, unknown] three things",
      "[10:00] Model: [Video - PPV $15.00, unknown] unlock me",
      "[10:00] Model: [Photo] free now",
    ]);
  });
});
