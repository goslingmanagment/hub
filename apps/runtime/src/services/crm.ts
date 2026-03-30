import type {
  CrmConversationPreviewParams,
  CrmConversationPreviewQuery,
  CrmConversationPreviewResponse,
  CrmReactivationQuery,
  CrmReactivationResponse,
  CrmRetentionQuery,
  CrmRetentionResponse,
  CrmSummaryResponse,
  PageConversationMessagesParams,
  PageConversationMessagesQuery,
  PageConversationMessagesResponse,
  WorkboardResponse,
  WorkboardSnoozeBody,
  WorkboardSnoozeResponse,
} from "@agency_hub_core/contracts";
import {
  PAGE_DM_MESSAGE_HISTORY_LIMIT,
  findPageSummaryByLabel,
  getCrmConversationPreview,
  getCrmFreshnessCoverage,
  getCrmSummary,
  getPageConversationMessages,
  listCrmReactivation,
  listCrmRetention,
  listWorkboardSubscribers,
  listWorkboardActiveSpenders,
  listWorkboardInactiveSpenders,
  listWorkboardSnoozed,
  snoozeWorkboardFan,
  unsnoozeWorkboardFan,
} from "@agency_hub_core/db";
import { millsToNumber } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, requireDashboardUser, type AuthPrincipal } from "./auth.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "./errors.ts";
import { getPageStreamSyncUxByStream } from "./sync-monitor.ts";
import { buildCrmMessageSyncUx } from "./sync-ux.ts";

const CRM_DM_STREAMS = ["dm_conversations", "dm_messages"] as const;

function serializeTimestamp(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  return new Date(value).toISOString();
}

function serializePage(page: NonNullable<Awaited<ReturnType<typeof findPageSummaryByLabel>>>) {
  return {
    id: page.id,
    label: page.label,
    platform: page.platform,
    username: page.username,
    displayName: page.displayName,
    followerCount: page.followerCount,
    subscriberCount: page.subscriberCount,
    lastLightSyncAt: serializeTimestamp(page.lastLightSyncAt),
    lastFollowerSyncAt: serializeTimestamp(page.lastFollowerSyncAt),
    modelSlug: page.modelSlug,
    modelName: page.modelName,
  };
}

function serializeFreshnessCoverage(freshness: Awaited<ReturnType<typeof getCrmFreshnessCoverage>>) {
  return {
    freshness: {
      lastConversationChunkSucceededAt: serializeTimestamp(freshness.lastConversationChunkSucceededAt),
      lastConversationFullSweepAt: serializeTimestamp(freshness.lastConversationFullSweepAt),
      lastMessageChunkSucceededAt: serializeTimestamp(freshness.lastMessageChunkSucceededAt),
    },
    coverage: {
      pendingMessageBackfillCount: freshness.pendingMessageBackfillCount,
      previewReadyConversationCount: freshness.previewReadyConversationCount,
    },
  };
}

async function resolveCrmMessageSyncUx(
  app: AppContext,
  pageId: number,
  freshness: Awaited<ReturnType<typeof getCrmFreshnessCoverage>>,
) {
  const syncUxByStream = await getPageStreamSyncUxByStream(app, {
    pageId,
    streams: [...CRM_DM_STREAMS],
  });
  const conversationSyncUx = syncUxByStream.get("dm_conversations") ?? null;
  const messageSyncUx = syncUxByStream.get("dm_messages") ?? null;

  return buildCrmMessageSyncUx({
    conversationSyncUx,
    messageSyncUx,
    pendingMessageBackfillCount: freshness.pendingMessageBackfillCount,
    previewReadyConversationCount: freshness.previewReadyConversationCount,
  });
}

async function resolveCrmPage(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
) {
  const page = await findPageSummaryByLabel(app.db, pageLabel);
  if (!page) {
    throw new NotFoundError(`Page "${pageLabel}" was not found`);
  }
  if (!canAccessPage(principal, page.id)) {
    throw new ForbiddenError();
  }
  if (page.platform !== "fansly") {
    throw new BadRequestError("CRM is only supported for Fansly pages");
  }

  return page;
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

export async function getCrmSummaryReport(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
): Promise<CrmSummaryResponse> {
  const page = await resolveCrmPage(app, principal, pageLabel);
  const summary = await getCrmSummary(app.db, {
    platformAccountId: page.id,
  });
  const freshnessCoverage = serializeFreshnessCoverage(summary.freshness);
  const messageSyncUx = await resolveCrmMessageSyncUx(app, page.id, summary.freshness);

  return {
    page: serializePage(page),
    retention: {
      total: summary.retentionTotal,
      countsByTouchpoint: summary.retentionCountsByTouchpoint,
    },
    reactivation: {
      total: summary.reactivationTotal,
    },
    freshness: freshnessCoverage.freshness,
    coverage: freshnessCoverage.coverage,
    messageSyncUx,
  };
}

export async function getCrmRetentionReport(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  query: CrmRetentionQuery,
): Promise<CrmRetentionResponse> {
  const page = await resolveCrmPage(app, principal, pageLabel);
  const [retention, freshness] = await Promise.all([
    listCrmRetention(app.db, {
      platformAccountId: page.id,
      limit: query.limit,
      offset: query.offset,
      query: query.query,
      touchpoint: query.touchpoint,
      autoRenew: query.autoRenew,
      unreadOnly: query.unreadOnly,
      showHandled: query.showHandled,
      sortBy: query.sortBy,
      sortDir: query.sortDir,
    }),
    getCrmFreshnessCoverage(app.db, page.id),
  ]);
  const freshnessCoverage = serializeFreshnessCoverage(freshness);

  return {
    page: serializePage(page),
    items: retention.items.map((item) => ({
      fan: {
        fanId: item.fanId,
        platform: "fansly",
        platformUserId: item.platformUserId,
        username: item.username,
        displayName: item.displayName,
      },
      spend: {
        creatorNetAmountMills: millsToNumber(item.creatorNetAmountMills),
        creatorNetAmountUsd: millsToNumber(item.creatorNetAmountMills) / 1000,
      },
      subscription: {
        isSubscriber: true,
        subscriptionExpiresAt: serializeTimestamp(item.subscriptionExpiresAt),
        autoRenew: item.autoRenew,
        subscriptionTierName: item.subscriptionTierName,
      },
      conversation: {
        platformConversationId: item.platformConversationId,
        unreadCount: item.unreadCount,
        lastMessageAt: serializeTimestamp(item.lastMessageAt),
        lastMessagePreview: item.lastMessagePreview,
        messageBackfillComplete: item.messageBackfillComplete,
        storedMessageCount: item.storedMessageCount,
        lastMessageSenderRole: item.lastMessageSenderRole,
      },
      platformConversationId: item.platformConversationId,
      touchpointCode: item.touchpointCode,
      touchpointLabel: touchpointLabel(item.touchpointCode),
      isSoftTouchpoint: item.isSoftTouchpoint,
      isHandled: item.isHandled,
      lastContactAt: serializeTimestamp(item.lastContactAt),
      touchpointDueAt: new Date(item.touchpointDueAt).toISOString(),
    })),
    limit: query.limit,
    offset: query.offset,
    total: retention.total,
    summary: {
      freshness: freshnessCoverage.freshness,
      coverage: freshnessCoverage.coverage,
      countsByTouchpoint: {
        "21d": retention.countsByTouchpoint.get("21d") ?? 0,
        "14d": retention.countsByTouchpoint.get("14d") ?? 0,
        "7d": retention.countsByTouchpoint.get("7d") ?? 0,
        "5d": retention.countsByTouchpoint.get("5d") ?? 0,
        "3d": retention.countsByTouchpoint.get("3d") ?? 0,
        "1d": retention.countsByTouchpoint.get("1d") ?? 0,
      },
    },
  };
}

export async function getCrmReactivationReport(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
  query: CrmReactivationQuery,
): Promise<CrmReactivationResponse> {
  const page = await resolveCrmPage(app, principal, pageLabel);
  const [reactivation, freshness] = await Promise.all([
    listCrmReactivation(app.db, {
      platformAccountId: page.id,
      limit: query.limit,
      offset: query.offset,
      query: query.query,
      minSpendUsd: query.minSpendUsd,
      minSilenceDays: query.minSilenceDays,
      unreadOnly: query.unreadOnly,
      noDmHistoryOnly: query.noDmHistoryOnly,
      hideDeleted: query.hideDeleted,
      subscriberState: query.subscriberState,
      sortBy: query.sortBy,
      sortDir: query.sortDir,
    }),
    getCrmFreshnessCoverage(app.db, page.id),
  ]);
  const freshnessCoverage = serializeFreshnessCoverage(freshness);

  return {
    page: serializePage(page),
    items: reactivation.items.map((item) => ({
      fan: {
        fanId: item.fanId,
        platform: "fansly",
        platformUserId: item.platformUserId,
        username: item.username,
        displayName: item.displayName,
      },
      spend: {
        creatorNetAmountMills: millsToNumber(item.creatorNetAmountMills),
        creatorNetAmountUsd: millsToNumber(item.creatorNetAmountMills) / 1000,
      },
      subscription: {
        isSubscriber: item.isSubscriber ?? false,
        subscriberSince: serializeTimestamp(item.subscriberSince),
        subscriptionExpiresAt: serializeTimestamp(item.subscriptionExpiresAt),
        autoRenew: item.autoRenew,
        subscriptionTierName: null,
      },
      conversation: {
        platformConversationId: item.platformConversationId,
        unreadCount: item.unreadCount,
        lastMessageAt: serializeTimestamp(item.lastMessageAt),
        lastMessagePreview: item.lastMessagePreview,
        messageBackfillComplete: item.messageBackfillComplete,
        storedMessageCount: item.storedMessageCount,
        lastMessageSenderRole: item.lastMessageSenderRole,
      },
      platformConversationId: item.platformConversationId,
      noDmHistory: item.noDmHistory,
      silenceDays: item.silenceDays,
      reactivationScore: item.reactivationScore,
    })),
    limit: query.limit,
    offset: query.offset,
    total: reactivation.total,
    summary: {
      freshness: freshnessCoverage.freshness,
      coverage: freshnessCoverage.coverage,
    },
  };
}

export async function getCrmConversationPreviewReport(
  app: AppContext,
  principal: AuthPrincipal,
  params: CrmConversationPreviewParams,
  query: CrmConversationPreviewQuery,
): Promise<CrmConversationPreviewResponse> {
  const page = await resolveCrmPage(app, principal, params.pageLabel);
  const [preview, freshness] = await Promise.all([
    getCrmConversationPreview(app.db, {
      platformAccountId: page.id,
      platformConversationId: params.platformConversationId,
      limit: Math.min(query.limit, PAGE_DM_MESSAGE_HISTORY_LIMIT),
    }),
    getCrmFreshnessCoverage(app.db, page.id),
  ]);

  if (!preview) {
    throw new NotFoundError("Conversation preview was not found");
  }

  const messageSyncUx = await resolveCrmMessageSyncUx(app, page.id, freshness);

  return {
    page: serializePage(page),
    fan: preview.fan
      ? {
        fanId: preview.fan.id,
        platform: "fansly",
        platformUserId: preview.fan.platformUserId,
        username: preview.fan.username,
        displayName: preview.fan.displayName,
      }
      : null,
    conversation: {
      platformConversationId: preview.conversation.platformConversationId,
      storedMessageCount: preview.conversation.storedMessageCount,
      messageBackfillComplete: preview.conversation.messageBackfillComplete,
      lastMessageSyncAt: serializeTimestamp(preview.conversation.lastMessageSyncAt),
      unreadCount: preview.conversation.unreadCount,
      lastMessageAt: serializeTimestamp(preview.conversation.lastMessageAt),
    },
    messageSyncUx,
    messages: preview.messages.map((message) => ({
      platformMessageId: message.platformMessageId,
      senderPlatformUserId: message.senderPlatformUserId,
      senderRole: message.senderRole,
      createdAt: message.createdAt.toISOString(),
      content: message.content,
      totalTipAmountCents: message.totalTipAmountCents,
    })),
  };
}

export async function getPageConversationMessagesReport(
  app: AppContext,
  principal: AuthPrincipal,
  params: PageConversationMessagesParams,
  query: PageConversationMessagesQuery,
): Promise<PageConversationMessagesResponse> {
  requireDashboardUser(principal);
  const page = await resolveCrmPage(app, principal, params.pageLabel);
  const conversation = await getPageConversationMessages(app.db, {
    platformAccountId: page.id,
    platformConversationId: params.conversationId,
    limit: query.limit,
  });

  if (!conversation) {
    throw new NotFoundError("Conversation messages were not found");
  }

  return {
    page: serializePage(page),
    conversationId: conversation.conversationId,
    messages: conversation.messages.map((message) => ({
      messageId: message.messageId,
      senderRole: message.senderRole,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
      tipAmountCents: message.tipAmountCents,
    })),
  };
}

// ---------------------------------------------------------------------------
// Workboard
// ---------------------------------------------------------------------------

function serializeSpenderItem(row: Awaited<ReturnType<typeof listWorkboardActiveSpenders>>[number]) {
  return {
    fanId: row.fanId,
    fan: {
      platformUserId: row.platformUserId,
      username: row.username,
      displayName: row.displayName,
    },
    ltv: { creatorNetAmountMills: millsToNumber(row.creatorNetAmountMills) },
    overdueDays: row.overdueDays,
    silenceDays: row.silenceDays,
    conversation: {
      platformConversationId: row.platformConversationId,
      lastFanMessageAt: serializeTimestamp(row.lastFanMessageAt),
      lastModelMessageAt: serializeTimestamp(row.lastModelMessageAt),
      lastMessagePreview: row.lastMessagePreview,
      storedMessageCount: row.storedMessageCount,
      messageBackfillComplete: row.messageBackfillComplete,
    },
    subscription: {
      status: row.subscriptionStatus,
      expiresAt: serializeTimestamp(row.subscriptionExpiresAt),
    },
    lastTransactionAt: serializeTimestamp(row.lastTransactionAt),
  };
}

export async function getWorkboardReport(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
): Promise<WorkboardResponse> {
  const page = await resolveCrmPage(app, principal, pageLabel);
  const [subscribers, activeSpenders, inactiveSpenders, snoozed] = await Promise.all([
    listWorkboardSubscribers(app.db, { platformAccountId: page.id }),
    listWorkboardActiveSpenders(app.db, { platformAccountId: page.id }),
    listWorkboardInactiveSpenders(app.db, { platformAccountId: page.id }),
    listWorkboardSnoozed(app.db, { platformAccountId: page.id }),
  ]);

  return {
    subscribers: {
      total: subscribers.length,
      items: subscribers.map((row) => ({
        fanId: row.fanId,
        fan: {
          platformUserId: row.platformUserId,
          username: row.username,
          displayName: row.displayName,
        },
        ltv: { creatorNetAmountMills: millsToNumber(row.creatorNetAmountMills) },
        touchpoint: {
          code: row.touchpointCode,
          label: touchpointLabel(row.touchpointCode),
          isSoft: row.isSoftTouchpoint,
          dueAt: new Date(row.touchpointDueAt).toISOString(),
        },
        overdueDays: row.overdueDays,
        conversation: {
          platformConversationId: row.platformConversationId,
          lastFanMessageAt: serializeTimestamp(row.lastFanMessageAt),
          lastModelMessageAt: serializeTimestamp(row.lastModelMessageAt),
          lastMessagePreview: row.lastMessagePreview,
          storedMessageCount: row.storedMessageCount,
          messageBackfillComplete: row.messageBackfillComplete,
        },
        subscription: {
          expiresAt: new Date(row.subscriptionExpiresAt).toISOString(),
          autoRenew: row.autoRenew,
          tierName: row.subscriptionTierName,
          subscriberSince: serializeTimestamp(row.subscriberSince),
        },
        lastTransactionAt: serializeTimestamp(row.lastTransactionAt),
      })),
    },
    activeSpenders: {
      total: activeSpenders.length,
      items: activeSpenders.map(serializeSpenderItem),
    },
    inactiveSpenders: {
      total: inactiveSpenders.length,
      items: inactiveSpenders.map(serializeSpenderItem),
    },
    snoozed: {
      total: snoozed.length,
      items: snoozed.map((row) => ({
        fanId: row.fanId,
        fan: {
          platformUserId: row.platformUserId,
          username: row.username,
          displayName: row.displayName,
        },
        ltv: { creatorNetAmountMills: millsToNumber(row.creatorNetAmountMills) },
        snoozedUntil: new Date(row.snoozedUntil).toISOString(),
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
  const page = await resolveCrmPage(app, principal, pageLabel);
  const result = await snoozeWorkboardFan(app.db, {
    platformAccountId: page.id,
    fanId: body.fanId,
    days: body.days,
  });

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
  const page = await resolveCrmPage(app, principal, pageLabel);
  await unsnoozeWorkboardFan(app.db, {
    platformAccountId: page.id,
    fanId,
  });

  return { ok: true };
}
