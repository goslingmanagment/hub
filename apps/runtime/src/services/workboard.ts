import type {
  WorkboardResponse,
  WorkboardSnoozeBody,
  WorkboardSnoozeResponse,
} from "@agency_hub_core/contracts";
import {
  listWorkboardSubscribers,
  listWorkboardActiveSpenders,
  listWorkboardAllSpenders,
  listWorkboardSnoozed,
  snoozeWorkboardFan,
  unsnoozeWorkboardFan,
} from "@agency_hub_core/db";
import { millsToNumber } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireDashboardUser, type AuthPrincipal } from "./auth.ts";
import { NotFoundError } from "./errors.ts";
import { resolveAccessibleDmPage } from "./fansly-page.ts";

type WorkboardSpenderSegment = WorkboardResponse["activeSpenders"]["items"][number]["segment"];
type WorkboardSpenderRow = Awaited<ReturnType<typeof listWorkboardActiveSpenders>>[number];

function serializeTimestamp(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  return new Date(value).toISOString();
}

function touchpointLabel(code: "21d" | "14d" | "7d" | "5d" | "3d" | "1d") {
  switch (code) {
    case "21d":
      return "21 days";
    case "14d":
      return "14 days";
    case "7d":
      return "7 days";
    case "5d":
      return "5 days";
    case "3d":
      return "3 days";
    case "1d":
      return "1 day";
  }
}

function serializeSpenderItem(row: WorkboardSpenderRow, segment: WorkboardSpenderSegment) {
  return {
    fanId: row.fanId,
    fan: {
      platformUserId: row.platformUserId,
      pageAlias: row.pageAlias,
      username: row.username,
      displayName: row.displayName,
    },
    ltv: { creatorNetAmountMills: millsToNumber(row.creatorNetAmountMills) },
    segment,
    overdueDays: row.overdueDays,
    silenceDays: row.silenceDays,
    conversation: {
      platformConversationId: row.platformConversationId,
      lastFanMessageAt: serializeTimestamp(row.lastFanMessageAt),
      lastModelMessageAt: serializeTimestamp(row.lastModelMessageAt),
      lastMessagePreview: row.lastMessagePreview,
      storedMessageCount: row.storedMessageCount,
      messageCoverageStatus: row.messageCoverageStatus,
      messageBackfillComplete: row.messageBackfillComplete,
      messageSyncEligibility: row.messageSyncEligibility,
    },
    subscription: {
      status: row.subscriptionStatus,
      expiresAt: serializeTimestamp(row.subscriptionExpiresAt),
    },
    lastTransactionAt: serializeTimestamp(row.lastTransactionAt),
  };
}

function resolveWorkboardSpenderSegment(
  row: Pick<WorkboardSpenderRow, "lastTransactionAt">,
  now: Date,
): WorkboardSpenderSegment {
  if (!row.lastTransactionAt) {
    return "inactive";
  }

  return row.lastTransactionAt.getTime() > now.getTime() - 30 * 24 * 60 * 60 * 1000
    ? "active"
    : "inactive";
}

export async function getWorkboardReport(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
): Promise<WorkboardResponse> {
  requireDashboardUser(principal);
  const page = await resolveAccessibleDmPage(app, principal, pageLabel, "Workboard");
  const now = new Date();
  const [subscribers, activeSpenders, allSpenders, snoozed] = await Promise.all([
    listWorkboardSubscribers(app.db, { platformAccountId: page.id, now }),
    listWorkboardActiveSpenders(app.db, { platformAccountId: page.id, now }),
    listWorkboardAllSpenders(app.db, { platformAccountId: page.id, now }),
    listWorkboardSnoozed(app.db, { platformAccountId: page.id }),
  ]);

  return {
    subscribers: {
      total: subscribers.length,
      items: subscribers.map((row) => ({
        fanId: row.fanId,
        fan: {
          platformUserId: row.platformUserId,
          pageAlias: row.pageAlias,
          username: row.username,
          displayName: row.displayName,
        },
        ltv: { creatorNetAmountMills: millsToNumber(row.creatorNetAmountMills) },
        touchpoint: {
          code: row.touchpointCode,
          label: touchpointLabel(row.touchpointCode),
          isSoft: row.isSoftTouchpoint,
          dueAt: serializeTimestamp(row.touchpointDueAt)!,
        },
        overdueDays: row.overdueDays,
        conversation: {
          platformConversationId: row.platformConversationId,
          lastFanMessageAt: serializeTimestamp(row.lastFanMessageAt),
          lastModelMessageAt: serializeTimestamp(row.lastModelMessageAt),
          lastMessagePreview: row.lastMessagePreview,
          storedMessageCount: row.storedMessageCount,
          messageCoverageStatus: row.messageCoverageStatus,
          messageBackfillComplete: row.messageBackfillComplete,
          messageSyncEligibility: row.messageSyncEligibility,
        },
        subscription: {
          expiresAt: serializeTimestamp(row.subscriptionExpiresAt)!,
          autoRenew: row.autoRenew,
          autoRenewOffDetectedAt: serializeTimestamp(row.autoRenewOffDetectedAt),
          tierName: row.subscriptionTierName,
          subscriberSince: serializeTimestamp(row.subscriberSince),
        },
        lastTransactionAt: serializeTimestamp(row.lastTransactionAt),
      })),
    },
    activeSpenders: {
      total: activeSpenders.length,
      items: activeSpenders.map((row) => serializeSpenderItem(row, "active")),
    },
    inactiveSpenders: {
      total: allSpenders.length,
      items: allSpenders.map((row) => serializeSpenderItem(row, resolveWorkboardSpenderSegment(row, now))),
    },
    snoozed: {
      total: snoozed.length,
      items: snoozed.map((row) => ({
        fanId: row.fanId,
        fan: {
          platformUserId: row.platformUserId,
          pageAlias: row.pageAlias,
          username: row.username,
          displayName: row.displayName,
        },
        ltv: { creatorNetAmountMills: millsToNumber(row.creatorNetAmountMills) },
        snoozedUntil: serializeTimestamp(row.snoozedUntil)!,
      })),
    },
  };
}

export async function snoozeWorkboardFanReport(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  body: WorkboardSnoozeBody,
): Promise<WorkboardSnoozeResponse> {
  requireDashboardUser(principal);
  const page = await resolveAccessibleDmPage(app, principal, pageLabel, "Workboard");
  const result = await snoozeWorkboardFan(app.db, {
    platformAccountId: page.id,
    fanId: body.fanId,
    days: body.days,
  });
  if (!result) {
    throw new NotFoundError(`Fan "${body.fanId}" not found on page "${pageLabel}"`);
  }

  return {
    fanId: result.fanId,
    snoozedUntil: result.snoozedUntil.toISOString(),
  };
}

export async function unsnoozeWorkboardFanReport(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  fanId: number,
): Promise<{ ok: true }> {
  requireDashboardUser(principal);
  const page = await resolveAccessibleDmPage(app, principal, pageLabel, "Workboard");
  await unsnoozeWorkboardFan(app.db, {
    platformAccountId: page.id,
    fanId,
  });

  return { ok: true };
}
