// chat-extension R20 HF-7г (parity row AI-145): the reference of the Fansly
// spend and subscription blocks.
//
// Every `REFERENCE_*` text below is the output of the released Fansly
// extension's own formatters (fansly-chat 2.10.1, `ff30d00`:
// `src/shared/earnings.ts`, `src/shared/subscriptions.ts`), run unchanged on
// the fixture of this file and assembled the way its
// `src/background/operations.ts:2685-2811` assembles a generation: the
// all-time rows and the monthly rows Fansly serves for the fan, and for a deep
// feature the rows of each of the twelve newest months. They are what the
// extension sends in `clientContext`, and what the hub's own blocks are
// compared with.

import type { FanslyEarningsTransaction } from "@agency_hub_core/fansly";

/** The fan and the clock of every reference text. */
export const REFERENCE_FAN = "700000000000000001";
export const REFERENCE_NOW = "2026-10-13T12:00:00.000Z";

/** One wallet row of the fixture: Fansly's type code, mills, the instant. */
export interface ReferenceLedgerRow {
  type: number;
  gross: number;
  net: number;
  at: string;
}

/** A subscription payment on the 3rd of each of 14 months, Sep 2025 - Oct 2026. */
const SUBSCRIPTION_MONTHS: ReferenceLedgerRow[] = Array.from({ length: 14 }, (_unused, index) => ({
  type: 15001,
  gross: 13990,
  net: 11192,
  at: new Date(Date.UTC(2025, 8 + index, 3, 9, 0, 0)).toISOString(),
}));

/**
 * The fan's wallet rows. Fansly's codes: 15001 a subscription payment, 7101 a
 * tip, 2110 a media purchase, 32101 a locked text, 24101 prize money. One tip
 * is half an hour before a UTC month ends and one purchase ten minutes after
 * it begins. No two types share a total, in a month or over all time.
 */
export const REFERENCE_LEDGER: readonly ReferenceLedgerRow[] = [
  ...SUBSCRIPTION_MONTHS,
  { type: 7101, gross: 50000, net: 40000, at: "2026-10-05T18:00:00.000Z" },
  { type: 7101, gross: 25000, net: 20000, at: "2026-09-30T23:30:00.000Z" },
  { type: 7101, gross: 100000, net: 80000, at: "2026-03-10T12:00:00.000Z" },
  { type: 2110, gross: 16990, net: 13592, at: "2026-10-01T00:10:00.000Z" },
  { type: 2110, gross: 30000, net: 24000, at: "2026-08-15T12:00:00.000Z" },
  { type: 2110, gross: 45000, net: 36000, at: "2025-12-24T12:00:00.000Z" },
  { type: 32101, gross: 5000, net: 4000, at: "2026-07-07T12:00:00.000Z" },
  { type: 24101, gross: 1000, net: 1000, at: "2026-06-01T12:00:00.000Z" },
];

/** A fixture row as Fansly's wallet serves it to the hub. */
export function referenceWalletItem(row: ReferenceLedgerRow, index: number): FanslyEarningsTransaction {
  return {
    walletId: "600000000000000001",
    transactionId: String(910000000000000000n + BigInt(index)),
    accountId: "600000000000000002",
    correlationId: null,
    correlationAccountId: REFERENCE_FAN,
    type: row.type,
    destination: 1,
    amount: row.gross,
    // Fansly states the commission; a row paid out whole states none.
    destinationTax: row.gross === row.net ? 0 : 2000,
    destinationAmount: row.net,
    newBalance: null,
    newBalance64: null,
    createdAt: Date.parse(row.at),
    updatedAt: null,
    status: 2,
    senderId: REFERENCE_FAN,
    receiverId: "600000000000000002",
  };
}

// ── spend ───────────────────────────────────────────────────────────────────

/** A quick feature (Reply, Fix, Ping, Help, Coach). */
export const REFERENCE_SPENDING_QUICK = `FAN SPENDING DATA:
Correlation account ID: 700000000000000001
Total gross (all-time): $468.85
Total net (all-time): $375.28
Type breakdown (all-time):
- Message tip / paid message: $195.86
- Tip or media purchase: $175.00
- Subscription: $91.99
- Unknown (type 32101): $5.00
- Unknown (type 24101): $1.00
Monthly totals:
- Oct 2026: $80.98
- Sep 2026: $38.99
- Aug 2026: $43.99
- Jul 2026: $18.99
- Jun 2026: $14.99
- May 2026: $13.99
- Apr 2026: $13.99
- Mar 2026: $113.99
- Feb 2026: $13.99
- Jan 2026: $13.99
- Dec 2025: $58.99
- Nov 2025: $13.99
- Oct 2025: $13.99
- Sep 2025: $13.99`;

/** A deep feature (Recap, Review, the notes fill). */
export const REFERENCE_SPENDING_DEEP = `FAN SPENDING DATA:
Correlation account ID: 700000000000000001
Total gross (all-time): $468.85
Total net (all-time): $375.28
Type breakdown (all-time):
- Message tip / paid message: $195.86
- Tip or media purchase: $175.00
- Subscription: $91.99
- Unknown (type 32101): $5.00
- Unknown (type 24101): $1.00
Monthly totals:
- Oct 2026: $80.98
- Sep 2026: $38.99
- Aug 2026: $43.99
- Jul 2026: $18.99
- Jun 2026: $14.99
- May 2026: $13.99
- Apr 2026: $13.99
- Mar 2026: $113.99
- Feb 2026: $13.99
- Jan 2026: $13.99
- Dec 2025: $58.99
- Nov 2025: $13.99
- Oct 2025: $13.99
- Sep 2025: $13.99
Monthly breakdown by type:
- Oct 2026: Tip or media purchase $50.00, Subscription $16.99, Message tip / paid message $13.99
- Sep 2026: Tip or media purchase $25.00, Message tip / paid message $13.99
- Aug 2026: Subscription $30.00, Message tip / paid message $13.99
- Jul 2026: Message tip / paid message $13.99, Unknown (type 32101) $5.00
- Jun 2026: Message tip / paid message $13.99, Unknown (type 24101) $1.00
- May 2026: Message tip / paid message $13.99
- Apr 2026: Message tip / paid message $13.99
- Mar 2026: Tip or media purchase $100.00, Message tip / paid message $13.99
- Feb 2026: Message tip / paid message $13.99
- Jan 2026: Message tip / paid message $13.99
- Dec 2025: Subscription $45.00, Message tip / paid message $13.99
- Nov 2025: Message tip / paid message $13.99`;

/** A fan Fansly reports no earnings from. */
export const REFERENCE_SPENDING_NONE = `FAN SPENDING DATA:
Correlation account ID: 700000000000000001
Total gross (all-time): $0.00
Total net (all-time): $0.00`;

/**
 * The reference with its type names corrected: the one difference of the
 * hub's spend block. The extension named Fansly's codes wrongly (2110, a media
 * purchase, "Subscription"; 15001, a subscription payment, "Message tip / paid
 * message"); the hub names a row by the ledger's canonical type.
 */
export function withLedgerTypeNames(reference: string): string {
  return reference
    .replaceAll("Message tip / paid message", "\u0001")
    .replaceAll("Tip or media purchase", "\u0002")
    .replaceAll("Unknown (type 32101)", "Paid posts")
    .replaceAll("Subscription", "Paid messages")
    .replaceAll("\u0001", "Subscriptions")
    .replaceAll("\u0002", "Tips");
}

// ── subscription ────────────────────────────────────────────────────────────

/** A subscription of the reference fan as Fansly's `/subscribers` serves it. */
export interface ReferenceSubscription {
  status: number;
  tierName: string | null;
  renewPrice: number;
  autoRenew: boolean | null;
  billingCycle: number | null;
  createdAt: string | null;
  endsAt: string | null;
}

const ACTIVE: ReferenceSubscription = {
  status: 3,
  tierName: "Gold Tier",
  renewPrice: 13990,
  autoRenew: true,
  billingCycle: 30,
  createdAt: "2026-08-27T00:00:00.000Z",
  endsAt: "2026-10-29T00:00:00.000Z",
};
const ENDED = { autoRenew: false, createdAt: "2026-06-01T08:00:00.000Z", endsAt: "2026-09-01T08:00:00.000Z" };

/** Each case: the subscription, and the extension's block for it at `REFERENCE_NOW`. */
export const REFERENCE_SUBSCRIPTIONS = {
  active: { subscription: ACTIVE, block: `FAN SUBSCRIPTION DATA:
Source: /api/v1/subscribers
Subscriber account ID: 700000000000000001
Tier: Gold Tier ($13.99/month)
Status: Active
Subscribed since: Aug 27, 2026 (47 days ago)
Current period ends: Oct 29, 2026 (in 15 days)
Auto-renew: On (renews at $13.99/month)
Billing cycle: 30 days` },
  activeNoRenew: {
    subscription: { ...ACTIVE, tierName: "VIP", renewPrice: 35000, autoRenew: false, billingCycle: 90 },
    block: `FAN SUBSCRIPTION DATA:
Source: /api/v1/subscribers
Subscriber account ID: 700000000000000001
Tier: VIP ($35.00/3 months)
Status: Active
Subscribed since: Aug 27, 2026 (47 days ago)
Current period ends: Oct 29, 2026 (in 15 days)
Auto-renew: Off — will NOT renew (churn risk)
Billing cycle: 90 days`,
  },
  expired: { subscription: { ...ACTIVE, ...ENDED, status: 5 }, block: `FAN SUBSCRIPTION DATA:
Source: /api/v1/subscribers
Subscriber account ID: 700000000000000001
Tier: Gold Tier ($13.99/month)
Status: Expired (ended Sep 1, 2026 — 42 days ago)
Was subscribed for: 92 days
Subscribed since: Jun 1, 2026 (134 days ago)
Billing cycle: 30 days` },
  lapsedPeriod: {
    subscription: { ...ACTIVE, endsAt: "2026-10-10T00:00:00.000Z" },
    block: `FAN SUBSCRIPTION DATA:
Source: /api/v1/subscribers
Subscriber account ID: 700000000000000001
Tier: Gold Tier ($13.99/month)
Status: Active
Subscribed since: Aug 27, 2026 (47 days ago)
Current period ends: Oct 10, 2026 (ended 3 days ago — period lapsed)
Auto-renew: On (renews at $13.99/month)
Billing cycle: 30 days`,
  },
  bare: {
    subscription: { ...ACTIVE, tierName: null, billingCycle: null, autoRenew: null },
    block: `FAN SUBSCRIPTION DATA:
Source: /api/v1/subscribers
Subscriber account ID: 700000000000000001
Tier: Unknown ($13.99/month)
Status: Active
Subscribed since: Aug 27, 2026 (47 days ago)
Current period ends: Oct 29, 2026 (in 15 days)`,
  },
  unknownStatus: { subscription: { ...ACTIVE, ...ENDED, status: 6 }, block: `FAN SUBSCRIPTION DATA:
Source: /api/v1/subscribers
Subscriber account ID: 700000000000000001
Tier: Gold Tier ($13.99/month)
Status: Unknown (ended Sep 1, 2026 — 42 days ago)
Was subscribed for: 92 days
Subscribed since: Jun 1, 2026 (134 days ago)
Billing cycle: 30 days` },
  expiredNoEnd: {
    subscription: { ...ACTIVE, status: 5, autoRenew: false, endsAt: null },
    block: `FAN SUBSCRIPTION DATA:
Source: /api/v1/subscribers
Subscriber account ID: 700000000000000001
Tier: Gold Tier ($13.99/month)
Status: Expired (5)
Subscribed since: Aug 27, 2026 (47 days ago)
Billing cycle: 30 days`,
  },
  yearly: { subscription: { ...ACTIVE, billingCycle: 365, renewPrice: 99990 }, block: `FAN SUBSCRIPTION DATA:
Source: /api/v1/subscribers
Subscriber account ID: 700000000000000001
Tier: Gold Tier ($99.99/year)
Status: Active
Subscribed since: Aug 27, 2026 (47 days ago)
Current period ends: Oct 29, 2026 (in 15 days)
Auto-renew: On (renews at $99.99/year)
Billing cycle: 365 days` },
  halfYearly: { subscription: { ...ACTIVE, billingCycle: 180, renewPrice: 59990 }, block: `FAN SUBSCRIPTION DATA:
Source: /api/v1/subscribers
Subscriber account ID: 700000000000000001
Tier: Gold Tier ($59.99/6 months)
Status: Active
Subscribed since: Aug 27, 2026 (47 days ago)
Current period ends: Oct 29, 2026 (in 15 days)
Auto-renew: On (renews at $59.99/6 months)
Billing cycle: 180 days` },
  oddCycle: { subscription: { ...ACTIVE, billingCycle: 45, renewPrice: 19990 }, block: `FAN SUBSCRIPTION DATA:
Source: /api/v1/subscribers
Subscriber account ID: 700000000000000001
Tier: Gold Tier ($19.99/45 days)
Status: Active
Subscribed since: Aug 27, 2026 (47 days ago)
Current period ends: Oct 29, 2026 (in 15 days)
Auto-renew: On (renews at $19.99/45 days)
Billing cycle: 45 days` },
} as const satisfies Record<string, { subscription: ReferenceSubscription; block: string }>;
