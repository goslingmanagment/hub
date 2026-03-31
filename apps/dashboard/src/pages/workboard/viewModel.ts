import type { WorkboardResponse } from "@agency_hub_core/contracts";
import { resolveFanLabelForScope } from "@agency_hub_core/shared";
import { formatMills, formatRelativeTime, formatDate, daysRemaining } from "@/lib/format";

type SubscriberItem = WorkboardResponse["subscribers"]["items"][number];
type SpenderItem = WorkboardResponse["activeSpenders"]["items"][number];
type SnoozedItem = WorkboardResponse["snoozed"]["items"][number];
type WorkboardFan = SubscriberItem["fan"] | SpenderItem["fan"] | SnoozedItem["fan"];

export type OverdueSeverity = "normal" | "yellow" | "red";

export function resolveOverdueSeverity(days: number): OverdueSeverity {
  if (days >= 7) return "red";
  if (days >= 3) return "yellow";
  return "normal";
}

export const OVERDUE_BG: Record<OverdueSeverity, string> = {
  normal: "bg-card",
  yellow: "bg-yellow-500/5",
  red: "bg-red-500/5",
};

function resolveVisibleWorkboardFan(fan: WorkboardFan) {
  const resolved = resolveFanLabelForScope({
    platformUserId: fan.platformUserId,
    pageAlias: fan.pageAlias,
    username: fan.username,
    displayName: fan.displayName,
  }, "page");

  return resolved.isDeletedFallback ? null : resolved;
}

export interface WorkboardSubscriberVm {
  kind: "subscriber";
  fanId: number;
  fanLabel: string;
  fanSubLabel: string | null;
  platformConversationId: string | null;
  profileHref: string;
  ltvLabel: string;
  touchpointCode: string;
  touchpointLabel: string;
  isSoftTouchpoint: boolean;
  overdueDays: number;
  overdueSeverity: OverdueSeverity;
  lastFanMessageLabel: string | null;
  lastModelMessageLabel: string | null;
  lastTransactionLabel: string | null;
  expiryLabel: string;
  expiryRelativeLabel: string;
  autoRenew: boolean | null;
  tierName: string | null;
  tierShortName: string | null;
  subscribedMonths: number | null;
  canPreview: boolean;
}

export function mapSubscriberVm(pageLabel: string, item: SubscriberItem): WorkboardSubscriberVm | null {
  const fan = resolveVisibleWorkboardFan(item.fan);
  if (!fan) {
    return null;
  }

  return {
    kind: "subscriber" as const,
    fanId: item.fanId,
    fanLabel: fan.label,
    fanSubLabel: fan.secondaryPlatformHandle ? `@${fan.secondaryPlatformHandle}` : null,
    platformConversationId: item.conversation.platformConversationId,
    profileHref: `/pages/${pageLabel}/fans/fansly/${item.fan.platformUserId}`,
    ltvLabel: formatMills(item.ltv.creatorNetAmountMills),
    touchpointCode: item.touchpoint.code,
    touchpointLabel: item.touchpoint.label,
    isSoftTouchpoint: item.touchpoint.isSoft,
    overdueDays: item.overdueDays,
    overdueSeverity: resolveOverdueSeverity(item.overdueDays),
    lastFanMessageLabel: item.conversation.lastFanMessageAt
      ? formatRelativeTime(item.conversation.lastFanMessageAt)
      : null,
    lastModelMessageLabel: item.conversation.lastModelMessageAt
      ? formatRelativeTime(item.conversation.lastModelMessageAt)
      : null,
    lastTransactionLabel: item.lastTransactionAt
      ? formatRelativeTime(item.lastTransactionAt)
      : null,
    expiryLabel: formatDate(item.subscription.expiresAt),
    expiryRelativeLabel: `in ${daysRemaining(item.subscription.expiresAt)}d`,
    autoRenew: item.subscription.autoRenew,
    tierName: item.subscription.tierName,
    tierShortName: item.subscription.tierName
      ? item.subscription.tierName.replace(/\s*\([^)]*\)\s*/g, " ").trim()
      : null,
    subscribedMonths: item.subscription.subscriberSince
      ? Math.max(1, Math.round((Date.now() - new Date(item.subscription.subscriberSince).getTime()) / (30.44 * 24 * 60 * 60 * 1000)))
      : null,
    canPreview: item.conversation.platformConversationId !== null,
  };
}

export interface WorkboardSpenderVm {
  kind: "spender";
  fanId: number;
  fanLabel: string;
  fanSubLabel: string | null;
  platformConversationId: string | null;
  profileHref: string;
  ltvLabel: string;
  silenceDays: number;
  overdueDays: number;
  overdueSeverity: OverdueSeverity;
  lastFanMessageLabel: string | null;
  lastModelMessageLabel: string | null;
  lastTransactionLabel: string | null;
  subscriptionStatus: "expired" | "never";
  subscriptionExpiresLabel: string | null;
  canPreview: boolean;
}

export type WorkboardCardVm = WorkboardSubscriberVm | WorkboardSpenderVm;

export function mapSpenderVm(pageLabel: string, item: SpenderItem): WorkboardSpenderVm | null {
  const fan = resolveVisibleWorkboardFan(item.fan);
  if (!fan) {
    return null;
  }

  return {
    kind: "spender" as const,
    fanId: item.fanId,
    fanLabel: fan.label,
    fanSubLabel: fan.secondaryPlatformHandle ? `@${fan.secondaryPlatformHandle}` : null,
    platformConversationId: item.conversation.platformConversationId,
    profileHref: `/pages/${pageLabel}/fans/fansly/${item.fan.platformUserId}`,
    ltvLabel: formatMills(item.ltv.creatorNetAmountMills),
    silenceDays: item.silenceDays,
    overdueDays: item.overdueDays,
    overdueSeverity: resolveOverdueSeverity(item.overdueDays),
    lastFanMessageLabel: item.conversation.lastFanMessageAt
      ? formatRelativeTime(item.conversation.lastFanMessageAt)
      : null,
    lastModelMessageLabel: item.conversation.lastModelMessageAt
      ? formatRelativeTime(item.conversation.lastModelMessageAt)
      : null,
    lastTransactionLabel: item.lastTransactionAt
      ? formatRelativeTime(item.lastTransactionAt)
      : null,
    subscriptionStatus: item.subscription.status,
    subscriptionExpiresLabel: item.subscription.expiresAt
      ? formatDate(item.subscription.expiresAt)
      : null,
    canPreview: item.conversation.platformConversationId !== null,
  };
}

export interface WorkboardSnoozedVm {
  fanId: number;
  fanLabel: string;
  ltvLabel: string;
  snoozedUntilLabel: string;
}

export function mapSnoozedVm(item: SnoozedItem): WorkboardSnoozedVm | null {
  const fan = resolveVisibleWorkboardFan(item.fan);
  if (!fan) {
    return null;
  }

  return {
    fanId: item.fanId,
    fanLabel: fan.label,
    ltvLabel: formatMills(item.ltv.creatorNetAmountMills),
    snoozedUntilLabel: formatDate(item.snoozedUntil),
  };
}
