import type { WorkboardResponse } from "@agency_hub_core/contracts";
import { resolveFanLabelForScope } from "@agency_hub_core/shared";
import { resolveFanslyExternalLink, type FanslyExternalLinkKind } from "@/lib/platformUrls";
import { formatMills, formatRelativeTime, formatDate, daysRemaining } from "@/lib/format";
import { resolveOverdueSeverity, type OverdueSeverity } from "./theme.js";

type SubscriberItem = WorkboardResponse["subscribers"]["items"][number];
type SpenderItem = WorkboardResponse["activeSpenders"]["items"][number];
type SnoozedItem = WorkboardResponse["snoozed"]["items"][number];
type WorkboardFan = SubscriberItem["fan"] | SpenderItem["fan"] | SnoozedItem["fan"];

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
  platformConversationId: string | null;
  profileHref: string;
  fanslyExternalUrl: string | null;
  fanslyExternalKind: FanslyExternalLinkKind | null;
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
  tierName: string | null;
  tierShortName: string | null;
}

export interface WorkboardSpenderVm extends WorkboardBaseVm {
  kind: "spender";
  subscriptionStatus: "active" | "expired" | "never";
  subscriptionExpiresLabel: string | null;
}

export type WorkboardCardVm = WorkboardSubscriberVm | WorkboardSpenderVm;

function buildBaseVm(pageLabel: string, item: SubscriberItem | SpenderItem): WorkboardBaseVm | null {
  const fan = resolveVisibleWorkboardFan(item.fan);
  if (!fan) {
    return null;
  }

  const fanslyExternalLink = resolveFanslyExternalLink({
    platformConversationId: item.conversation.platformConversationId,
    username: fan.username,
  });

  return {
    fanId: item.fanId,
    fanLabel: fan.label,
    fanSubLabel: fan.secondaryPlatformHandle ? `@${fan.secondaryPlatformHandle}` : null,
    platformConversationId: item.conversation.platformConversationId,
    profileHref: `/pages/${pageLabel}/fans/fansly/${item.fan.platformUserId}`,
    fanslyExternalUrl: fanslyExternalLink?.url ?? null,
    fanslyExternalKind: fanslyExternalLink?.kind ?? null,
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

export function mapSubscriberVm(pageLabel: string, item: SubscriberItem): WorkboardSubscriberVm | null {
  const baseVm = buildBaseVm(pageLabel, item);
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
    tierName: item.subscription.tierName,
    tierShortName: item.subscription.tierName
      ? item.subscription.tierName.replace(/\s*\([^)]*\)\s*/g, " ").trim()
      : null,
  };
}

export function mapSpenderVm(
  pageLabel: string,
  item: SpenderItem,
): WorkboardSpenderVm | null {
  const baseVm = buildBaseVm(pageLabel, item);
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
