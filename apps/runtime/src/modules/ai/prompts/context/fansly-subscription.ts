// chat-extension R20 HF-7г (parity row AI-145): the FAN SUBSCRIPTION DATA block
// of a Fansly fan, built by the hub from the subscription it captured for a
// request that carries no `clientContext`.
//
// The reference is the block the released Fansly extension sends in
// `clientContext.fanSubscriptionData` (fansly-chat 2.10.1, `ff30d00`:
// `src/shared/subscriptions.ts` formatFanSubscriptionData, called without a
// tier in `src/background/operations.ts:2806-2811`). Line for line:
//
//   Tier: <name> ($R/<cycle>)
//   Status: Active
//         | Expired (ended <Mon D, YYYY>, N days ago)
//   Was subscribed for: N days                       a subscription that ended
//   Subscribed since: <Mon D, YYYY> (N days ago)
//   Current period ends: <Mon D, YYYY> (in N days)   an active one
//   Auto-renew: On (renews at $R/<cycle>)            an active one
//             | Off, will NOT renew (churn risk)
//   Billing cycle: N days
//
// A fan the page never had a subscription from gets no block, as in the
// extension. Dates are UTC.
//
// What differs from the reference, by name:
//  - No `FAN SUBSCRIPTION DATA:`, `Source:` or `Subscriber account ID:` line
//    (2026-10-23): the template already heads the block, and an API path or
//    an account id tells the model nothing about the fan. No long dashes:
//    the prompt bans them in the model's own output.
//  - THE GIFT AND PROMOTION LINES ARE ABSENT ("Active (gift subscription — …)",
//    "Active (promotional price: …)", "Promo active", "Promo price", "Promo
//    duration", "Gift code"): the hub does not store a subscription's gift
//    code or promotion (`page_subscriptions` has no such column).
//  - A subscription the page's active list stopped serving is expired here
//    whatever status it last carried: the hub reads the expired list at a
//    page's birth and on the owner's request, so until then such a row keeps
//    the status it had while active. Its end is stated only once it is past.

import { millsToDollarsNumber } from "@agency_hub_core/shared";

import { formatUsd } from "./spending.ts";

const MS_PER_DAY = 86_400_000;

const ACTIVE_STATUSES: ReadonlySet<number> = new Set([3, 4]);
const EXPIRED_STATUS = 5;

/** One captured subscription of a fan to a page (`page_subscriptions`). */
export interface FanslyFanSubscriptionData {
  /** The fan's Fansly account id. */
  subscriberId: string;
  tierName: string | null;
  /** Fansly's status code as last captured: 3 and 4 active, 5 expired. */
  rawStatus: number;
  /** The page's active list serves it. */
  isCurrent: boolean;
  renewPriceMills: bigint;
  autoRenew: boolean | null;
  billingCycleDays: number | null;
  /** When the subscription began. */
  createdAt: Date | null;
  endsAt: Date | null;
}

function billingCycleLabel(days: number): string {
  if (days === 30) return "month";
  if (days === 90) return "3 months";
  if (days === 180) return "6 months";
  if (days === 365) return "year";
  return `${days} days`;
}

function formatShortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function daysBetween(from: number, to: number): number {
  return Math.floor(Math.abs(to - from) / MS_PER_DAY);
}

/**
 * The block text, or "" for a fan without a subscription. Does not escape: the
 * prompt builder does.
 */
export function formatFanslyFanSubscriptionData(
  subscription: FanslyFanSubscriptionData | null,
  now: number = Date.now(),
): string {
  if (!subscription) {
    return "";
  }

  const cycle = subscription.billingCycleDays !== null ? billingCycleLabel(subscription.billingCycleDays) : "month";
  const tierPrice = `${formatUsd(millsToDollarsNumber(subscription.renewPriceMills))}/${cycle}`;
  const createdAtMs = subscription.createdAt?.getTime() ?? null;
  const endsAtMs = subscription.endsAt?.getTime() ?? null;
  const active = subscription.isCurrent && ACTIVE_STATUSES.has(subscription.rawStatus);

  const lines: string[] = [
    `Tier: ${subscription.tierName ?? "Unknown"} (${tierPrice})`,
  ];

  if (active) {
    lines.push("Status: Active");
  } else {
    // An active status on a row the active list no longer serves is a
    // subscription that ended after the hub last read the expired list.
    const left = ACTIVE_STATUSES.has(subscription.rawStatus);
    const label = left || subscription.rawStatus === EXPIRED_STATUS ? "Expired" : "Unknown";
    if (endsAtMs !== null && endsAtMs <= now) {
      lines.push(`Status: ${label} (ended ${formatShortDate(endsAtMs)}, ${daysBetween(endsAtMs, now)} days ago)`);
      if (createdAtMs !== null) {
        lines.push(`Was subscribed for: ${daysBetween(createdAtMs, endsAtMs)} days`);
      }
    } else {
      // No end the hub can vouch for (none captured, or one still ahead): the
      // status alone, with Fansly's code where it is the row's own.
      lines.push(left ? `Status: ${label}` : `Status: ${label} (${subscription.rawStatus})`);
    }
  }

  if (createdAtMs !== null) {
    lines.push(`Subscribed since: ${formatShortDate(createdAtMs)} (${daysBetween(createdAtMs, now)} days ago)`);
  }

  if (active && endsAtMs !== null) {
    if (endsAtMs >= now) {
      const daysUntilEnd = Math.floor((endsAtMs - now) / MS_PER_DAY);
      lines.push(`Current period ends: ${formatShortDate(endsAtMs)} (in ${daysUntilEnd} days)`);
    } else {
      // Fansly can serve an active status with a past end (data lag): say the
      // period lapsed instead of a date ahead.
      const daysSinceEnd = Math.floor((now - endsAtMs) / MS_PER_DAY);
      lines.push(`Current period ends: ${formatShortDate(endsAtMs)} (ended ${daysSinceEnd} days ago, period lapsed)`);
    }
  }

  if (active) {
    if (subscription.autoRenew === true) {
      lines.push(`Auto-renew: On (renews at ${tierPrice})`);
    } else if (subscription.autoRenew === false) {
      lines.push("Auto-renew: Off, will NOT renew (churn risk)");
    }
  }

  if (subscription.billingCycleDays !== null) {
    lines.push(`Billing cycle: ${subscription.billingCycleDays} days`);
  }

  return lines.join("\n");
}
