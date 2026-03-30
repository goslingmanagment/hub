import type { CrmRetentionResponse, CrmReactivationResponse } from "@agency_hub_core/contracts";
import { resolveFanLabelForScope } from "@agency_hub_core/shared";
import { formatMills, formatRelativeTime, formatDate, daysRemaining } from "@/lib/format";

export interface RetentionRowVm {
  fanLabel: string;
  fanSubLabel: string | null;
  spendLabel: string;
  lastMessageLabel: string | null;
  lastMessageDirection: "inbound" | "outbound" | null;
  unreadCount: number;
  canPreview: boolean;
  platformConversationId: string | null;
  profileHref: string;
  expiryLabel: string;
  expiryRelativeLabel: string;
  touchpointCode: string;
  touchpointLabel: string;
  isSoftTouchpoint: boolean;
  isHandled: boolean;
  isAutoRenewOn: boolean;
}

export type ScoreTier = "high" | "medium" | "low";

export interface ReactivationRowVm {
  fanLabel: string;
  fanSubLabel: string | null;
  isDeletedUser: boolean;
  spendLabel: string;
  lastMessageLabel: string | null;
  lastMessageDirection: "inbound" | "outbound" | null;
  unreadCount: number;
  canPreview: boolean;
  platformConversationId: string | null;
  profileHref: string;
  silenceDaysLabel: string;
  scoreLabel: string;
  scoreRaw: number;
  scoreTier: ScoreTier;
  subscriptionStatusLabel: "Active" | "Expired" | "Never";
  noDmHistory: boolean;
}

function resolveScoreTier(score: number): ScoreTier {
  if (score >= 1000) return "high";
  if (score >= 100) return "medium";
  return "low";
}

const SCORE_TIER_LABELS: Record<ScoreTier, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

function resolveDirection(role: string | null): "inbound" | "outbound" | null {
  if (role === "fan") return "inbound";
  if (role === "model") return "outbound";
  return null;
}

export function mapRetentionRowVm(
  pageLabel: string,
  item: CrmRetentionResponse["items"][number],
): RetentionRowVm {
  const fan = resolveFanLabelForScope(item.fan, "page");
  return {
    fanLabel: fan.label,
    fanSubLabel: fan.secondaryPlatformHandle ? `@${fan.secondaryPlatformHandle}` : null,
    spendLabel: formatMills(item.spend.creatorNetAmountMills),
    lastMessageLabel: item.conversation.lastMessageAt
      ? formatRelativeTime(item.conversation.lastMessageAt)
      : null,
    lastMessageDirection: resolveDirection(item.conversation.lastMessageSenderRole),
    unreadCount: item.conversation.unreadCount,
    canPreview: item.platformConversationId !== null,
    platformConversationId: item.platformConversationId,
    profileHref: `/pages/${pageLabel}/fans/fansly/${item.fan.platformUserId}`,
    expiryLabel: formatDate(item.subscription.subscriptionExpiresAt!),
    expiryRelativeLabel: `in ${daysRemaining(item.subscription.subscriptionExpiresAt!)}d`,
    touchpointCode: item.touchpointCode,
    touchpointLabel: item.touchpointLabel,
    isSoftTouchpoint: item.isSoftTouchpoint,
    isHandled: item.isHandled,
    isAutoRenewOn: item.subscription.autoRenew === true,
  };
}

export function mapReactivationRowVm(
  pageLabel: string,
  item: CrmReactivationResponse["items"][number],
): ReactivationRowVm {
  const fan = resolveFanLabelForScope(item.fan, "page");
  const subStatus: ReactivationRowVm["subscriptionStatusLabel"] =
    item.subscription.isSubscriber
      ? "Active"
      : item.subscription.subscriptionExpiresAt
        ? "Expired"
        : "Never";
  const isDeletedUser =
    item.fan.pageAlias === null &&
    item.fan.username === null &&
    item.fan.displayName === null;
  const tier = resolveScoreTier(item.reactivationScore);
  return {
    fanLabel: fan.label,
    fanSubLabel: fan.secondaryPlatformHandle ? `@${fan.secondaryPlatformHandle}` : null,
    isDeletedUser,
    spendLabel: formatMills(item.spend.creatorNetAmountMills),
    lastMessageLabel: item.conversation.lastMessageAt
      ? formatRelativeTime(item.conversation.lastMessageAt)
      : null,
    lastMessageDirection: resolveDirection(item.conversation.lastMessageSenderRole),
    unreadCount: item.conversation.unreadCount,
    canPreview: item.platformConversationId !== null,
    platformConversationId: item.platformConversationId,
    profileHref: `/pages/${pageLabel}/fans/fansly/${item.fan.platformUserId}`,
    silenceDaysLabel: `${item.silenceDays}d`,
    scoreLabel: SCORE_TIER_LABELS[tier],
    scoreRaw: item.reactivationScore,
    scoreTier: tier,
    subscriptionStatusLabel: subStatus,
    noDmHistory: item.noDmHistory,
  };
}
