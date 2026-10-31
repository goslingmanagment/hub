import { describe, expect, it } from "vitest";

import type { OnlyfansFeedMoneyCandidate } from "@agency_hub_core/db";

import {
  feedDollarsToMills,
  kindsAgree,
  ledgerKindOf,
  ONLYFANS_FEED_MATCH_WINDOW_MS,
  pickFeedMoneyClaim,
  socketNetMills,
} from "../apps/runtime/src/services/client-onlyfans-feed-money.ts";
import {
  onlyfansFeedRecordFingerprint,
  onlyfansFeedRecordKey,
  onlyfansFeedSighting,
} from "../apps/runtime/src/services/client-onlyfans-feed.ts";

const at = (iso: string) => new Date(iso);
const row = (input: Partial<OnlyfansFeedMoneyCandidate> & { id: number }): OnlyfansFeedMoneyCandidate => ({
  transactionId: `tx-${input.id}`,
  source: "ofapi:webhook",
  canonicalType: "tip",
  grossAmountMills: 5000n,
  occurredAt: at("2026-11-01T10:00:00Z"),
  claimedByWs: false,
  claimedByLedger: false,
  ...input,
});
const tip = { sighting: "ws" as const, kind: "tip" as const, grossMills: 5000n, occurredAt: at("2026-11-01T10:00:30Z") };

describe("one purchase, one transaction: which row a sighting claims", () => {
  it("claims the row an earlier writer wrote for the same fan, amount and kind", () => {
    expect(pickFeedMoneyClaim(tip, [row({ id: 1 })])?.id).toBe(1);
  });

  it("never claims a row of its own kind: two socket tips of $5 are two tips", () => {
    expect(pickFeedMoneyClaim(tip, [row({ id: 1, source: "chatspace:ws" })])).toBeNull();
    expect(pickFeedMoneyClaim({ ...tip, sighting: "ledger" }, [row({ id: 2, source: "chatspace:ledger" })])).toBeNull();
  });

  it("claims a row once per kind of sighting: the second socket tip writes its own", () => {
    expect(pickFeedMoneyClaim(tip, [row({ id: 1, claimedByWs: true })])).toBeNull();
    // The ledger still may: it is the third sighting of the same purchase.
    expect(pickFeedMoneyClaim({ ...tip, sighting: "ledger" }, [row({ id: 1, claimedByWs: true })])?.id).toBe(1);
  });

  it("the ledger claims the socket's row of the same purchase", () => {
    const ledger = { ...tip, sighting: "ledger" as const, occurredAt: at("2026-11-01T09:59:58Z") };
    expect(pickFeedMoneyClaim(ledger, [row({ id: 7, source: "chatspace:ws" })])?.id).toBe(7);
  });

  it("needs the same gross, an agreeing kind and the window", () => {
    expect(pickFeedMoneyClaim(tip, [row({ id: 1, grossAmountMills: 5001n })])).toBeNull();
    expect(pickFeedMoneyClaim(tip, [row({ id: 1, canonicalType: "message_purchase" })])).toBeNull();
    const late = new Date(tip.occurredAt.getTime() + ONLYFANS_FEED_MATCH_WINDOW_MS + 1);
    expect(pickFeedMoneyClaim(tip, [row({ id: 1, occurredAt: late })])).toBeNull();
  });

  it("of several, takes the nearest in time", () => {
    const picked = pickFeedMoneyClaim(tip, [
      row({ id: 1, occurredAt: at("2026-11-01T09:52:00Z") }),
      row({ id: 2, occurredAt: at("2026-11-01T10:01:00Z") }),
    ]);
    expect(picked?.id).toBe(2);
  });

  it("pairs two identical tips one to one", () => {
    const candidates = [row({ id: 1 }), row({ id: 2, occurredAt: at("2026-11-01T10:00:40Z") })];
    const first = pickFeedMoneyClaim(tip, candidates)!;
    const rest = candidates.map((candidate) => (candidate.id === first.id ? { ...candidate, claimedByWs: true } : candidate));
    const second = pickFeedMoneyClaim(tip, rest)!;
    expect(new Set([first.id, second.id])).toEqual(new Set([1, 2]));
    expect(pickFeedMoneyClaim(tip, rest.map((candidate) => ({ ...candidate, claimedByWs: true })))).toBeNull();
  });
});

describe("what a ledger row is, and the socket's net", () => {
  it("reads OnlyFans' descriptions", () => {
    expect(ledgerKindOf("Tip from Fan")).toBe("tip");
    expect(ledgerKindOf("Payment for message from Fan")).toBe("message_purchase");
    expect(ledgerKindOf("Subscription from Fan")).toBe("subscription");
    expect(ledgerKindOf("Recurring subscription from Fan")).toBe("subscription");
    expect(ledgerKindOf("Payment for post from Fan")).toBe("post_purchase");
    expect(ledgerKindOf("Something new")).toBe("other");
  });

  it("lets an unknown kind meet any", () => {
    expect(kindsAgree("other", "tip")).toBe(true);
    expect(kindsAgree("tip", "other")).toBe(true);
    expect(kindsAgree("tip", "stream_tip")).toBe(true);
    expect(kindsAgree("subscription", "tip")).toBe(false);
  });

  it("counts the socket's net as OnlyFans' 80 %, in mills", () => {
    expect(feedDollarsToMills(12.5)).toBe(12_500n);
    expect(feedDollarsToMills(0.1 + 0.2)).toBe(300n);
    expect(socketNetMills(12_500n)).toBe(10_000n);
  });
});

describe("the journal keys and sightings of feed records", () => {
  const observedAt = "2026-11-01T10:00:30.000Z";

  it("keys money by OnlyFans' ids, never by when or how it was seen", () => {
    const ppv = { kind: "ppv" as const, fanRef: "42", contentType: "message", contentRef: "900", priceGross: 25, observedAt };
    expect(onlyfansFeedRecordKey(ppv)).toBe("ppv:message:900:42");
    expect(onlyfansFeedRecordFingerprint(ppv)).toBe(onlyfansFeedRecordFingerprint({ ...ppv, observedAt: "2026-11-01T11:00:00.000Z" }));
    expect(onlyfansFeedRecordFingerprint(ppv)).not.toBe(onlyfansFeedRecordFingerprint({ ...ppv, priceGross: 26 }));
  });

  it("makes the socket's purchase a sighting at 80 % and the ledger's a chargeback on undo", () => {
    const purchase = onlyfansFeedSighting({ kind: "ppv", fanRef: "42", contentType: "message", contentRef: "900", priceGross: 25, observedAt }, 1, 5)!;
    expect(purchase).toMatchObject({ sighting: "ws", kind: "message_purchase", grossMills: 25_000n, netMills: 20_000n, feedKey: "ws:ppv:message:900" });
    // A post is bought by many: the fan stays with it, as a digest, never as the id.
    const post = onlyfansFeedSighting({ kind: "ppv", fanRef: "42", contentType: "post", contentRef: "901", priceGross: 25, observedAt }, 1, 5)!;
    expect(post.feedKey).toMatch(/^ws:ppv:post:901:[0-9a-f]{24}$/);
    expect(post.transactionId).not.toContain(":42");
    const undone = onlyfansFeedSighting({
      kind: "ledger", transactionRef: "abc123", fanRef: "42", createdAt: "2026-11-01T09:59:00.000Z",
      amountGross: 25, amountNet: 20, description: "Payment for message from Fan", status: "undo", observedAt,
    }, 2, 5)!;
    expect(undone).toMatchObject({ sighting: "ledger", chargeback: true, transactionId: "abc123", netMills: 20_000n });
    expect(onlyfansFeedSighting({ kind: "tip", fanRef: "42", tipRef: "7", amountGross: 0, observedAt }, 3, 5)).toBeNull();
  });
});
