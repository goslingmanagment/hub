import type { WorkboardPresenceResponse, WorkboardResponse } from "@agency_hub_core/contracts";
import { resolveFanLabelForScope } from "@agency_hub_core/shared";
import { buildFanProfileRoute } from "@/lib/navigation";
import {
  resolveExternalLink,
  type ExternalLinkKind,
  type ExternalLinkPlatform,
} from "@/lib/platformUrls";
import { formatMills, formatRelativeTime, formatDate, daysRemaining } from "@/lib/format";
import { resolveOverdueSeverity, type OverdueSeverity } from "./theme.js";

type SubscriberItem = WorkboardResponse["subscribers"]["items"][number];
type SpenderItem = WorkboardResponse["activeSpenders"]["items"][number];
type SnoozedItem = WorkboardResponse["snoozed"]["items"][number];
type PresenceItem = WorkboardPresenceResponse["activeNow"]["items"][number];
type WorkboardFan = SubscriberItem["fan"] | SpenderItem["fan"] | SnoozedItem["fan"] | PresenceItem["fan"];

function resolveVisibleWorkboardFan(fan: WorkboardFan) {
  const resolved = resolveFanLabelForScope({
    platformUserId: fan.platformUserId,
    pageAlias: fan.pageAlias,
    username: fan.username,
    displayName: fan.displayName,
  }, "page");

  return resolved.isDeletedFallback ? null : resolved;
}

interface WorkboardBaseVm {
  fanId: number;
  fanLabel: string;
  fanSubLabel: string | null;
  platform: ExternalLinkPlatform;
  platformConversationId: string | null;
  profileHref: string;
  externalUrl: string | null;
  externalKind: ExternalLinkKind | null;
  ltvMills: number;
  ltvLabel: string;
  overdueDays: number;
  overdueSeverity: OverdueSeverity;
  overdueLabel: string;
  whyNowLabel: string;
  lastFanMessageLabel: string | null;
  lastModelMessageLabel: string | null;
  lastTransactionLabel: string | null;
  canPreview: boolean;
}

export interface WorkboardSubscriberVm extends WorkboardBaseVm {
  kind: "subscriber";
  touchpointCode: string;
  touchpointLabel: string;
  expiryLabel: string;
  expiryRelativeLabel: string;
  autoRenew: boolean | null;
  autoRenewOffDetectedLabel: string | null;
  tierName: string | null;
  tierShortName: string | null;
}

export interface WorkboardSpenderVm extends WorkboardBaseVm {
  kind: "spender";
  subscriptionStatus: "active" | "expired" | "never";
  subscriptionExpiresLabel: string | null;
}

export type WorkboardCardVm = WorkboardSubscriberVm | WorkboardSpenderVm;

function buildBaseVm(
  pageLabel: string,
  platform: ExternalLinkPlatform,
  item: SubscriberItem | SpenderItem,
): WorkboardBaseVm | null {
  const fan = resolveVisibleWorkboardFan(item.fan);
  if (!fan) {
    return null;
  }

  const externalLink = resolveExternalLink(platform, {
    platformConversationId: item.conversation.platformConversationId,
    username: fan.username,
  });

  return {
    fanId: item.fanId,
    fanLabel: fan.label,
    fanSubLabel: fan.secondaryPlatformHandle ? `@${fan.secondaryPlatformHandle}` : null,
    platform,
    platformConversationId: item.conversation.platformConversationId,
    profileHref: buildFanProfileRoute(pageLabel, platform, item.fan.platformUserId),
    externalUrl: externalLink?.url ?? null,
    externalKind: externalLink?.kind ?? null,
    ltvMills: item.ltv.creatorNetAmountMills,
    ltvLabel: formatMills(item.ltv.creatorNetAmountMills),
    overdueDays: item.overdueDays,
    overdueSeverity: resolveOverdueSeverity(item.overdueDays),
    overdueLabel: item.overdueDays > 0 ? `Просрочено ${item.overdueDays}д` : "На сегодня",
    whyNowLabel: "",
    lastFanMessageLabel: item.conversation.lastFanMessageAt
      ? formatRelativeTime(item.conversation.lastFanMessageAt)
      : null,
    lastModelMessageLabel: item.conversation.lastModelMessageAt
      ? formatRelativeTime(item.conversation.lastModelMessageAt)
      : null,
    lastTransactionLabel: item.lastTransactionAt
      ? formatRelativeTime(item.lastTransactionAt)
      : null,
    canPreview: item.conversation.platformConversationId !== null,
  };
}

export function mapSubscriberVm(
  pageLabel: string,
  platform: ExternalLinkPlatform,
  item: SubscriberItem,
): WorkboardSubscriberVm | null {
  const baseVm = buildBaseVm(pageLabel, platform, item);
  if (!baseVm) {
    return null;
  }

  return {
    ...baseVm,
    kind: "subscriber",
    touchpointCode: item.touchpoint.code,
    touchpointLabel: item.touchpoint.label,
    whyNowLabel: `Подписка истекает через ${item.touchpoint.label} — напишите`,
    expiryLabel: formatDate(item.subscription.expiresAt),
    expiryRelativeLabel: `через ${daysRemaining(item.subscription.expiresAt)}д`,
    autoRenew: item.subscription.autoRenew,
    autoRenewOffDetectedLabel: item.subscription.autoRenewOffDetectedAt
      ? formatDate(item.subscription.autoRenewOffDetectedAt, { includeYear: true })
      : null,
    tierName: item.subscription.tierName,
    tierShortName: item.subscription.tierName
      ? item.subscription.tierName.replace(/\s*\([^)]*\)\s*/g, " ").trim()
      : null,
  };
}

export function mapSpenderVm(
  pageLabel: string,
  platform: ExternalLinkPlatform,
  item: SpenderItem,
): WorkboardSpenderVm | null {
  const baseVm = buildBaseVm(pageLabel, platform, item);
  if (!baseVm) {
    return null;
  }

  return {
    ...baseVm,
    kind: "spender",
    whyNowLabel: item.segment === "active"
      ? `Активный спендер, не писали ${item.silenceDays}д`
      : `Неактивный спендер, не писали ${item.silenceDays}д`,
    subscriptionStatus: item.subscription.status,
    subscriptionExpiresLabel: item.subscription.expiresAt
      ? formatDate(item.subscription.expiresAt)
      : null,
  };
}

export interface WorkboardSnoozedVm {
  fanId: number;
  fanLabel: string;
  ltvMills: number;
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
    ltvMills: item.ltv.creatorNetAmountMills,
    ltvLabel: formatMills(item.ltv.creatorNetAmountMills),
    snoozedUntilLabel: formatDate(item.snoozedUntil),
  };
}

export interface WorkboardPresenceVm {
  fanId: number;
  fanLabel: string;
  fanSubLabel: string | null;
  platform: ExternalLinkPlatform;
  profileHref: string;
  externalUrl: string | null;
  externalKind: ExternalLinkKind | null;
  ltvMills: number;
  ltvLabel: string;
  presenceLabel: string;
  isSubscriber: boolean;
  lastTransactionLabel: string | null;
}

export function mapPresenceVm(
  pageLabel: string,
  platform: ExternalLinkPlatform,
  item: PresenceItem,
): WorkboardPresenceVm | null {
  const fan = resolveVisibleWorkboardFan(item.fan);
  if (!fan) {
    return null;
  }

  const externalLink = resolveExternalLink(platform, {
    platformConversationId: item.platformConversationId,
    username: fan.username,
  });

  return {
    fanId: item.fanId,
    fanLabel: fan.label,
    fanSubLabel: fan.secondaryPlatformHandle ? `@${fan.secondaryPlatformHandle}` : null,
    platform,
    profileHref: buildFanProfileRoute(pageLabel, platform, item.fan.platformUserId),
    externalUrl: externalLink?.url ?? null,
    externalKind: externalLink?.kind ?? null,
    ltvMills: item.ltv.creatorNetAmountMills,
    ltvLabel: formatMills(item.ltv.creatorNetAmountMills),
    presenceLabel: formatRelativeTime(item.presence.lastSeenAt),
    isSubscriber: item.isSubscriber,
    lastTransactionLabel: item.lastTransactionAt
      ? formatRelativeTime(item.lastTransactionAt)
      : null,
  };
}
