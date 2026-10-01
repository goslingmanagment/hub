import type {
  PageConversationMessagesParams,
  PageConversationMessagesQuery,
  PageConversationMessagesResponse,
  PageConversationPreviewParams,
  PageConversationPreviewQuery,
  PageConversationPreviewResponse,
} from "@agency_hub_core/contracts";
import {
  PAGE_DM_MESSAGE_HISTORY_LIMIT,
  findPageSummaryByLabel,
  getPageConversationMessages,
  getPageConversationPreview,
  getPageDmSyncCoverage,
  type PageConversationMessageProvenance,
} from "@agency_hub_core/db";
import { normalizeDmMessageText } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, requireDashboardUser, type AuthPrincipal } from "./auth.ts";
import { ForbiddenError, NotFoundError } from "./errors.ts";
import { pageReadsLiveOverlay } from "./live-overlay-read.ts";
import { buildConversationHistorySyncUx } from "./sync-ux.ts";
import { getSyncStatusSnapshot, mapDomainBlockToSyncUx } from "./sync-status.ts";

function serializeTimestamp(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  return new Date(value).toISOString();
}

/** Additive provenance of a message (plan §7.11): only rows of a page that
 * reads the live overlay carry it, so the confirmed-only response is the
 * same, byte for byte, as before the overlay. */
function serializeProvenance(provenance: PageConversationMessageProvenance | undefined) {
  if (provenance === undefined) return {};
  return provenance.source === "live"
    ? { source: "live" as const, apiUnavailable: provenance.apiUnavailable }
    : { source: "rest" as const };
}

function serializePageMetric(value: number | null | undefined) {
  return {
    value: value ?? null,
    available: value !== null && value !== undefined,
  };
}

function serializePage(page: {
  id: number;
  label: string;
  platform: "fansly" | "onlyfans";
  username: string | null;
  displayName: string | null;
  followerCount: number | null;
  subscriberCount: number | null;
  lastLightSyncAt: Date | null;
  lastFollowerSyncAt: Date | null;
  modelSlug: string;
  modelName: string;
}) {
  return {
    id: page.id,
    label: page.label,
    platform: page.platform,
    username: page.username,
    displayName: page.displayName,
    followerCount: serializePageMetric(page.followerCount),
    subscriberCount: serializePageMetric(page.subscriberCount),
    lastLightSyncAt: serializeTimestamp(page.lastLightSyncAt),
    lastFollowerSyncAt: serializeTimestamp(page.lastFollowerSyncAt),
    modelSlug: page.modelSlug,
    modelName: page.modelName,
  };
}

async function resolveConversationHistorySyncUx(
  app: AppContext,
  pageId: number,
  freshness: Awaited<ReturnType<typeof getPageDmSyncCoverage>>,
) {
  const snapshot = await getSyncStatusSnapshot(app, {
    pageIds: [pageId],
    // Preview UX consumes only these domains; retain the shared snapshot's
    // global task context for queue siblings and historical DM attempt debt.
    monitorStreams: ["dm_conversations", "dm_messages"],
  });
  const page = snapshot.pages[0];
  const conversationSyncUx = page ? mapDomainBlockToSyncUx(page.blocks.messages_live) : null;
  const messageSyncUx = page ? mapDomainBlockToSyncUx(page.blocks.messages_history) : null;

  return buildConversationHistorySyncUx({
    conversationSyncUx,
    messageSyncUx,
    pendingMessageBackfillCount: freshness.pendingMessageBackfillCount,
    previewReadyConversationCount: freshness.previewReadyConversationCount,
  });
}

async function resolveAccessiblePage(
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

  return page;
}

export async function getPageConversationPreviewReport(
  app: AppContext,
  principal: AuthPrincipal,
  params: PageConversationPreviewParams,
  query: PageConversationPreviewQuery,
): Promise<PageConversationPreviewResponse> {
  requireDashboardUser(principal);
  const page = await resolveAccessiblePage(app, principal, params.pageLabel);
  const liveOverlay = await pageReadsLiveOverlay(app, page);
  const [preview, freshness] = await Promise.all([
    getPageConversationPreview(app.db, {
      platformAccountId: page.id,
      platformConversationId: params.platformConversationId,
      limit: Math.min(query.limit, PAGE_DM_MESSAGE_HISTORY_LIMIT),
      liveOverlay,
    }),
    getPageDmSyncCoverage(app.db, page.id),
  ]);

  if (!preview) {
    throw new NotFoundError("Conversation preview was not found");
  }

  const messageSyncUx = await resolveConversationHistorySyncUx(app, page.id, freshness);

  return {
    page: serializePage(page),
    fan: preview.fan
      ? {
        fanId: preview.fan.id,
        platform: page.platform,
        platformUserId: preview.fan.platformUserId,
        pageAlias: preview.fan.pageAlias,
        username: preview.fan.username,
        displayName: preview.fan.displayName,
      }
      : null,
    conversation: {
      platformConversationId: preview.conversation.platformConversationId,
      storedMessageCount: preview.conversation.storedMessageCount,
      messageCoverageStatus: preview.conversation.messageCoverageStatus,
      messageBackfillComplete: preview.conversation.messageBackfillComplete,
      messageSyncEligibility: preview.conversation.messageSyncEligibility,
      messageSyncExcludedReason: preview.conversation.messageSyncExcludedReason,
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
      content: normalizeDmMessageText(message.content),
      totalTipAmountCents: message.totalTipAmountCents,
      ...serializeProvenance(message.provenance),
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
  const page = await resolveAccessiblePage(app, principal, params.pageLabel);
  const conversation = await getPageConversationMessages(app.db, {
    platformAccountId: page.id,
    platformConversationId: params.conversationId,
    limit: Math.min(query.limit, PAGE_DM_MESSAGE_HISTORY_LIMIT),
    liveOverlay: await pageReadsLiveOverlay(app, page),
  });

  if (!conversation) {
    throw new NotFoundError("Conversation messages were not found");
  }

  return {
    page: serializePage(page),
    conversationId: conversation.conversationId,
    conversation: {
      platformConversationId: conversation.conversation.platformConversationId,
      storedMessageCount: conversation.conversation.storedMessageCount,
      messageCoverageStatus: conversation.conversation.messageCoverageStatus,
      messageBackfillComplete: conversation.conversation.messageBackfillComplete,
      messageSyncEligibility: conversation.conversation.messageSyncEligibility,
      messageSyncExcludedReason: conversation.conversation.messageSyncExcludedReason,
      lastMessageSyncAt: serializeTimestamp(conversation.conversation.lastMessageSyncAt),
      unreadCount: conversation.conversation.unreadCount,
      lastMessageAt: serializeTimestamp(conversation.conversation.lastMessageAt),
    },
    messages: conversation.messages.map((message) => ({
      messageId: message.messageId,
      senderRole: message.senderRole,
      content: normalizeDmMessageText(message.content),
      createdAt: message.createdAt.toISOString(),
      tipAmountCents: message.tipAmountCents,
      ...serializeProvenance(message.provenance),
    })),
  };
}
