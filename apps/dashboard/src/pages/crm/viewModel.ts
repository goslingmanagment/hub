import type { CrmRetentionResponse, CrmReactivationResponse } from "@agency_hub_core/contracts";
import { resolveFanLabel } from "@agency_hub_core/shared";
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

export interface ReactivationRowVm {
  fanLabel: string;
  fanSubLabel: string | null;
  spendLabel: string;
  lastMessageLabel: string | null;
  lastMessageDirection: "inbound" | "outbound" | null;
  unreadCount: number;
  canPreview: boolean;
  platformConversationId: string | null;
  profileHref: string;
  silenceDaysLabel: string;
  scoreLabel: string;
  subscriptionStatusLabel: "Active" | "Expired" | "Never";
  noDmHistory: boolean;
}

function resolveDirection(role: string | null): "inbound" | "outbound" | null {
  if (role === "fan") return "inbound";
  if (role === "model") return "outbound";
  return null;
}

export function mapRetentionRowVm(
  pageLabel: string,
  item: CrmRetentionResponse["items"][number],
): RetentionRowVm {
  const fan = resolveFanLabel(item.fan);
  return {
    fanLabel: fan.label,
    fanSubLabel: fan.displayName && fan.username ? `@${fan.username}` : null,
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
  const fan = resolveFanLabel(item.fan);
  const subStatus: ReactivationRowVm["subscriptionStatusLabel"] =
    item.subscription.isSubscriber
      ? "Active"
      : item.subscription.subscriptionExpiresAt
        ? "Expired"
        : "Never";
  return {
    fanLabel: fan.label,
    fanSubLabel: fan.displayName && fan.username ? `@${fan.username}` : null,
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
    scoreLabel: item.reactivationScore.toFixed(1),
    subscriptionStatusLabel: subStatus,
    noDmHistory: item.noDmHistory,
  };
}
