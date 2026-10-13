import { describe, expect, it } from "vitest";

import { mapFanslyTransactionType } from "@agency_hub_core/fansly";

import {
  buildFanslyFanSpendingData,
  FANSLY_SPENDING_BREAKDOWN_MONTHS,
  fanslySpendingTypeLabel,
  formatFanslyFanSpendingData,
  formatFanslyFanSubscriptionData,
  type FanslyFanSubscriptionData,
  type FanslySpendingLedgerRow,
} from "../apps/runtime/src/modules/ai/index.ts";
import {
  REFERENCE_FAN,
  REFERENCE_LEDGER,
  REFERENCE_NOW,
  REFERENCE_SPENDING_DEEP,
  REFERENCE_SPENDING_NONE,
  REFERENCE_SPENDING_QUICK,
  REFERENCE_SUBSCRIPTIONS,
  withLedgerTypeNames,
  type ReferenceLedgerRow,
  type ReferenceSubscription,
} from "./helpers/fansly-money-reference.ts";

// chat-extension R20 HF-7г (parity row AI-145): the Fansly spend and
// subscription blocks against the released extension's own (the reference
// texts of helpers/fansly-money-reference.ts). No database: the aggregation the
// loader's query does is folded here from the same wallet rows.

const NOW = Date.parse(REFERENCE_NOW);

/** Wallet rows as the loader's query returns them: one row a UTC month and type. */
function ledgerRows(ledger: readonly ReferenceLedgerRow[]): FanslySpendingLedgerRow[] {
  const groups = new Map<string, FanslySpendingLedgerRow>();
  for (const row of ledger) {
    const at = new Date(row.at);
    const key = `${at.getUTCFullYear()}-${at.getUTCMonth()}-${row.type}`;
    const group = groups.get(key) ?? {
      year: at.getUTCFullYear(),
      month: at.getUTCMonth() + 1,
      canonicalType: mapFanslyTransactionType(row.type),
      rawType: String(row.type),
      grossMills: 0n,
      netMills: 0n,
    };
    group.grossMills += BigInt(row.gross);
    group.netMills += BigInt(row.net);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function spendingBlock(ledger: readonly ReferenceLedgerRow[], deep: boolean, order: "served" | "reversed" = "served") {
  const rows = ledgerRows(ledger);
  return formatFanslyFanSpendingData(buildFanslyFanSpendingData({
    fanId: REFERENCE_FAN,
    rows: order === "served" ? rows : rows.reverse(),
    deep,
  }));
}

function subscription(input: ReferenceSubscription, isCurrent: boolean): FanslyFanSubscriptionData {
  return {
    subscriberId: REFERENCE_FAN,
    tierName: input.tierName,
    rawStatus: input.status,
    isCurrent,
    renewPriceMills: BigInt(input.renewPrice),
    autoRenew: input.autoRenew,
    billingCycleDays: input.billingCycle,
    createdAt: input.createdAt === null ? null : new Date(input.createdAt),
    endsAt: input.endsAt === null ? null : new Date(input.endsAt),
  };
}

describe("[AI-145] the Fansly spend block is the extension's, with the ledger's type names", () => {
  it("a quick feature: all-time gross and net, the types, every month", () => {
    expect(spendingBlock(REFERENCE_LEDGER, false)).toBe(withLedgerTypeNames(REFERENCE_SPENDING_QUICK));
  });

  it("a deep feature adds the twelve newest months by type", () => {
    const block = spendingBlock(REFERENCE_LEDGER, true);
    expect(block).toBe(withLedgerTypeNames(REFERENCE_SPENDING_DEEP));
    // 14 months of history: every one in the totals, the two oldest not by type.
    const byType = block.slice(block.indexOf("Monthly breakdown by type:")).split("\n").slice(1);
    expect(byType).toHaveLength(FANSLY_SPENDING_BREAKDOWN_MONTHS);
    expect(byType.join("\n")).not.toContain("Oct 2025");
    expect(byType.join("\n")).not.toContain("Sep 2025");
  });

  it("a fan without a wallet row reads the zero totals, as the extension's block did", () => {
    expect(spendingBlock([], false)).toBe(REFERENCE_SPENDING_NONE);
    expect(spendingBlock([], true)).toBe(REFERENCE_SPENDING_NONE);
  });

  it("the text does not depend on the order the database returned the groups in", () => {
    expect(spendingBlock(REFERENCE_LEDGER, true, "reversed")).toBe(spendingBlock(REFERENCE_LEDGER, true));
  });

  it("the corrected names: what the extension called a subscription is a media purchase", () => {
    // The reference text, by the extension's own labels (earnings.ts LABELS).
    expect(REFERENCE_SPENDING_QUICK).toContain("- Message tip / paid message: $195.86");
    expect(REFERENCE_SPENDING_QUICK).toContain("- Subscription: $91.99");
    // 14 subscription payments of $13.99 are $195.86; the media purchases are $91.99.
    const block = spendingBlock(REFERENCE_LEDGER, false);
    expect(block).toContain("- Subscriptions: $195.86");
    expect(block).toContain("- Tips: $175.00");
    expect(block).toContain("- Paid messages: $91.99");
    expect(block).toContain("- Paid posts: $5.00");
    expect(block).toContain("- Unknown (type 24101): $1.00");
  });

  it("names a row by the ledger's canonical type, Fansly's older codes included", () => {
    const label = (type: number) => fanslySpendingTypeLabel({
      canonicalType: mapFanslyTransactionType(type),
      rawType: String(type),
    });
    expect([15001, 15000, 6515].map(label)).toEqual(["Subscriptions", "Subscriptions", "Subscriptions"]);
    expect([7101, 7001, 20001].map(label)).toEqual(["Tips", "Tips", "Tips"]);
    expect([2110, 2116, 2010, 2016].map(label)).toEqual(Array(4).fill("Paid messages"));
    expect([32101, 32001].map(label)).toEqual(["Paid posts", "Paid posts"]);
    expect([45101, 45001].map(label)).toEqual(["Streams", "Streams"]);
    // What the ledger cannot classify keeps Fansly's code, as in the reference.
    expect([24101, 6101, 99999].map(label)).toEqual([
      "Unknown (type 24101)",
      "Unknown (type 6101)",
      "Unknown (type 99999)",
    ]);
  });

  it("a single media and a media set are one line; equal amounts are ordered by name", () => {
    const block = spendingBlock([
      { type: 2110, gross: 10000, net: 8000, at: "2026-10-02T10:00:00.000Z" },
      { type: 2116, gross: 15000, net: 12000, at: "2026-10-03T10:00:00.000Z" },
      { type: 7101, gross: 25000, net: 20000, at: "2026-10-04T10:00:00.000Z" },
    ], true);
    expect(block).toBe([
      "FAN SPENDING DATA:",
      `Correlation account ID: ${REFERENCE_FAN}`,
      "Total gross (all-time): $50.00",
      "Total net (all-time): $40.00",
      "Type breakdown (all-time):",
      "- Paid messages: $25.00",
      "- Tips: $25.00",
      "Monthly totals:",
      "- Oct 2026: $50.00",
      "Monthly breakdown by type:",
      "- Oct 2026: Paid messages $25.00, Tips $25.00",
    ].join("\n"));
  });

  it("sums in mills and prints a figure as the extension did: mills / 1000 to two places", () => {
    // 3 × $0.333 is $0.999: a sum of rounded dollars would read $0.99.
    const third = { type: 7101, gross: 333, net: 266, at: "2026-10-04T10:00:00.000Z" };
    const block = spendingBlock([third, third, third], false);
    expect(block).toContain("Total gross (all-time): $1.00");
    expect(block).toContain("Total net (all-time): $0.80");
    expect(block).toContain(`Total gross (all-time): $${(999 / 1000).toFixed(2)}`);
  });

  it("a refund lowers the totals of its month and of all time", () => {
    const block = spendingBlock([
      { type: 7101, gross: 50000, net: 40000, at: "2026-09-04T10:00:00.000Z" },
      { type: 6101, gross: -20000, net: -16000, at: "2026-10-04T10:00:00.000Z" },
    ], false);
    expect(block).toContain("Total gross (all-time): $30.00");
    expect(block).toContain("- Unknown (type 6101): $-20.00");
    expect(block).toContain("- Oct 2026: $-20.00");
  });
});

describe("[AI-145] the Fansly subscription block is the extension's", () => {
  const current = ["active", "activeNoRenew", "lapsedPeriod", "bare", "yearly", "halfYearly", "oddCycle"] as const;
  const left = ["expired", "unknownStatus", "expiredNoEnd"] as const;

  it.each(current)("a subscription the active list serves: %s", (name) => {
    const reference = REFERENCE_SUBSCRIPTIONS[name];
    expect(formatFanslyFanSubscriptionData(subscription(reference.subscription, true), NOW)).toBe(reference.block);
  });

  it.each(left)("a subscription the active list no longer serves: %s", (name) => {
    const reference = REFERENCE_SUBSCRIPTIONS[name];
    expect(formatFanslyFanSubscriptionData(subscription(reference.subscription, false), NOW)).toBe(reference.block);
  });

  it("an ex-subscriber reads when the subscription ended and how long it lasted", () => {
    expect(REFERENCE_SUBSCRIPTIONS.expired.block).toContain("Status: Expired (ended Sep 1, 2026 — 42 days ago)");
    expect(REFERENCE_SUBSCRIPTIONS.expired.block).toContain("Was subscribed for: 92 days");
    expect(REFERENCE_SUBSCRIPTIONS.expired.block).not.toContain("Auto-renew");
  });

  it("a fan the page never had a subscription from gets no block", () => {
    expect(formatFanslyFanSubscriptionData(null, NOW)).toBe("");
  });

  it("a row that left the active list before the expired list was read is the same ex-subscriber", () => {
    // The hub's own case: the hourly active walk retired the row, its last
    // captured status is still 3. Fansly's expired list would serve it with 5.
    const expired = REFERENCE_SUBSCRIPTIONS.expired;
    const retired = subscription({ ...expired.subscription, status: 3 }, false);
    expect(formatFanslyFanSubscriptionData(retired, NOW)).toBe(expired.block);
    expect(formatFanslyFanSubscriptionData({ ...retired, rawStatus: 4 }, NOW)).toBe(expired.block);
  });

  it("states an end only once it is past", () => {
    const ahead = new Date(NOW + 5 * 86_400_000);
    const expired = subscription(REFERENCE_SUBSCRIPTIONS.expired.subscription, false);
    // A retired row whose captured period is not over: gone from the active
    // list, no end the hub can vouch for.
    const retired = formatFanslyFanSubscriptionData({ ...expired, rawStatus: 3, endsAt: ahead }, NOW);
    expect(retired).toContain("\nStatus: Expired\n");
    expect(retired).not.toContain("ended");
    expect(retired).not.toContain("Was subscribed for");
    expect(retired).not.toContain("Current period ends");
    expect(retired).not.toContain("Auto-renew");
    // An expired row with an end ahead keeps Fansly's code, like one without an end.
    expect(formatFanslyFanSubscriptionData({ ...expired, endsAt: ahead }, NOW)).toContain("\nStatus: Expired (5)\n");
  });

  it("a current row with a status that is not active is not called active", () => {
    const pending = subscription({ ...REFERENCE_SUBSCRIPTIONS.active.subscription, status: 1 }, true);
    const block = formatFanslyFanSubscriptionData(pending, NOW);
    expect(block).toContain("\nStatus: Unknown (1)\n");
    expect(block).not.toContain("Auto-renew");
  });

  it("reads the clock when none is given", () => {
    const active = subscription(REFERENCE_SUBSCRIPTIONS.active.subscription, true);
    const since = Math.floor((Date.now() - active.createdAt!.getTime()) / 86_400_000);
    expect(formatFanslyFanSubscriptionData(active)).toContain(`Subscribed since: Aug 27, 2026 (${since} days ago)`);
  });
});
