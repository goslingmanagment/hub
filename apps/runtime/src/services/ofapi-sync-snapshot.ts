import { millsToDollarsNumber } from "@agency_hub_core/shared";
import {
  findOfapiSyncSnapshotPage,
  getOfapiFanoutReplayWindow,
  listOfapiSyncSnapshotArchiveMessages,
  listOfapiSyncSnapshotHotMessages,
  listOfapiSyncSnapshotThreads,
  listOfapiSyncSnapshotUnresolvedTombstones,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, NotFoundError } from "./errors.ts";

const AUTHENTICATED_STATUSES = new Set(["connected", "reconnected", "session_expired"]);
const UNAUTHENTICATED_STATUSES = new Set([
  "authentication_failed",
  "otp_code_required",
  "face_otp_required",
]);

function serializeTimestamp(value: Date) {
  return value.toISOString();
}

function authenticatedFromStatus(status: string | null) {
  if (status === null) {
    return null;
  }
  if (AUTHENTICATED_STATUSES.has(status)) {
    return true;
  }
  if (UNAUTHENTICATED_STATUSES.has(status)) {
    return false;
  }
  return null;
}

function normalizeArchiveMedia(value: Array<Record<string, unknown>>): Array<{
  id: string;
  type: "photo" | "video" | "audio" | "gif" | "other";
  isReady: boolean;
  locked: boolean;
  durationSeconds?: number;
}> {
  return value.flatMap((item) => {
    const id = typeof item.id === "string" ? item.id : null;
    const rawType = typeof item.type === "string" ? item.type : "other";
    const type: "photo" | "video" | "audio" | "gif" | "other" =
      rawType === "photo" || rawType === "video" || rawType === "audio"
        || rawType === "gif" || rawType === "other"
      ? rawType
      : "other";
    if (!id) {
      return [];
    }
    return [{
      id,
      type,
      isReady: item.isReady === true,
      locked: item.locked === true,
      ...(typeof item.durationSeconds === "number"
        ? { durationSeconds: item.durationSeconds }
        : {}),
    }];
  });
}

export async function getOfapiSyncSnapshot(
  app: AppContext,
  input: {
    assignedPageIds: number[];
    accountId: string;
    afterSeq: number;
    snapshotCursor?: number;
    pageCursor: number;
    limit: number;
    now?: Date;
  },
) {
  const replayWindow = await getOfapiFanoutReplayWindow(app.db);
  const snapshotCursor = input.snapshotCursor ?? replayWindow.latestSeq;
  if (snapshotCursor > replayWindow.latestSeq) {
    throw new BadRequestError(
      `snapshotCursor ${snapshotCursor} is ahead of current fanout sequence ${replayWindow.latestSeq}`,
    );
  }
  if (input.afterSeq > snapshotCursor) {
    throw new BadRequestError(
      `afterSeq ${input.afterSeq} is ahead of snapshotCursor ${snapshotCursor}`,
    );
  }

  const page = await findOfapiSyncSnapshotPage(app.db, {
    assignedPageIds: input.assignedPageIds,
    ofapiAccountId: input.accountId,
  });
  if (!page) {
    throw new NotFoundError("Assigned OFAPI account not found");
  }

  const rows = await listOfapiSyncSnapshotThreads(app.db, {
    platformAccountId: page.id,
    afterThreadId: input.pageCursor,
    limit: input.limit + 1,
  });
  const hasMore = rows.length > input.limit;
  const threads = rows.slice(0, input.limit);
  const [hotMessages, unresolvedTombstones] = await Promise.all([
    listOfapiSyncSnapshotHotMessages(app.db, {
      platformAccountId: page.id,
      conversationIds: threads.map((thread) => thread.id),
    }),
    input.pageCursor === 0
      ? listOfapiSyncSnapshotUnresolvedTombstones(app.db, {
        platformAccountId: page.id,
        afterSeq: input.afterSeq,
      })
      : Promise.resolve([]),
  ]);
  const archiveMessages = await listOfapiSyncSnapshotArchiveMessages(app.db, {
    platformAccountId: page.id,
    platformConversationIds: threads.map((thread) => thread.platformConversationId),
    hotMessageIds: hotMessages.map((message) => message.platformMessageId),
    afterSeq: input.afterSeq,
  });

  const messagesByChat = new Map<string, Map<string, {
    chatId: string;
    messageId: string;
    message: {
      id: string;
      text: string;
      createdAt: string;
      isSentByMe: boolean;
      price: number;
      isOpened?: boolean | null;
      isNew?: boolean;
      isTip?: boolean;
      tipAmountUsd?: number | null;
      media?: Array<{
        id: string;
        type: "photo" | "video" | "audio" | "gif" | "other";
        isReady: boolean;
        locked: boolean;
        durationSeconds?: number;
      }>;
    } | null;
    deletedAt: string | null;
    sourceUpdatedAt: string;
    sourceFanoutSeq: number | null;
  }>>();
  const byChat = (chatId: string) => {
    let messages = messagesByChat.get(chatId);
    if (!messages) {
      messages = new Map();
      messagesByChat.set(chatId, messages);
    }
    return messages;
  };

  for (const hot of hotMessages) {
    byChat(hot.platformConversationId).set(hot.platformMessageId, {
      chatId: hot.platformConversationId,
      messageId: hot.platformMessageId,
      message: {
        id: hot.platformMessageId,
        text: hot.content,
        createdAt: serializeTimestamp(hot.createdAt),
        isSentByMe: hot.senderRole === "model",
        price: 0,
        isOpened: hot.purchasedAt === null ? null : true,
        isTip: hot.totalTipAmountCents > 0,
        tipAmountUsd: hot.totalTipAmountCents / 100,
        media: [],
      },
      deletedAt: null,
      sourceUpdatedAt: serializeTimestamp(hot.syncedAt),
      sourceFanoutSeq: null,
    });
  }

  for (const archived of archiveMessages) {
    if (!archived.platformConversationId) {
      continue;
    }
    const message = archived.messageCreatedAt === null
      ? null
      : {
        id: archived.platformMessageId,
        text: archived.textPlain,
        createdAt: serializeTimestamp(archived.messageCreatedAt),
        isSentByMe: archived.isSentByMe,
        price: millsToDollarsNumber(archived.priceMills ?? 0n),
        isOpened: archived.isOpened,
        isTip: archived.isTip,
        tipAmountUsd: millsToDollarsNumber(archived.tipAmountMills),
        media: normalizeArchiveMedia(archived.mediaMetadata),
      };
    byChat(archived.platformConversationId).set(archived.platformMessageId, {
      chatId: archived.platformConversationId,
      messageId: archived.platformMessageId,
      message,
      deletedAt: archived.deletedAt ? serializeTimestamp(archived.deletedAt) : null,
      sourceUpdatedAt: serializeTimestamp(
        archived.updatedAt > archived.sourceReceivedAt
          ? archived.updatedAt
          : archived.sourceReceivedAt,
      ),
      sourceFanoutSeq: archived.sourceFanoutSeq,
    });
  }

  const dmProjectionEnabled = app.config.ofapiDmProjectionEnabled === true;
  const coldArchiveEnabled = app.config.ofapiDmColdArchiveEnabled === true;
  const resumeAllowed = dmProjectionEnabled && coldArchiveEnabled;
  const omittedDomains = [
    { domain: "presence", reason: "ephemeral_not_snapshotted" },
    { domain: "typing", reason: "ephemeral_not_snapshotted" },
    ...(!dmProjectionEnabled
      ? [{ domain: "chat_heads_and_hot_messages", reason: "dm_projection_disabled" }]
      : []),
    ...(!coldArchiveEnabled
      ? [{ domain: "message_tombstones", reason: "dm_cold_archive_disabled" }]
      : []),
  ];

  return {
    version: 1 as const,
    requestedAfterSeq: input.afterSeq,
    snapshotCursor,
    stateAt: serializeTimestamp(input.now ?? new Date()),
    resumeAllowed,
    page: {
      pageId: page.id,
      label: page.label,
      accountId: page.ofapiAccountId,
      username: page.username,
      authStatus: page.ofapiAuthStatus,
      authenticated: authenticatedFromStatus(page.ofapiAuthStatus),
      authChangedAt: page.ofapiAuthChangedAt
        ? serializeTimestamp(page.ofapiAuthChangedAt)
        : null,
    },
    coverage: {
      durableDomains: [
        ...(dmProjectionEnabled ? ["chat_heads" as const, "hot_messages" as const] : []),
        ...(coldArchiveEnabled ? ["message_tombstones" as const] : []),
        "account_auth" as const,
      ],
      omittedDomains,
      messageWindow: "hot_projection_plus_archive_delta" as const,
    },
    threads: threads.map((thread) => ({
      chatId: thread.platformConversationId,
      fanName: thread.partnerDisplayName
        ?? thread.partnerUsername
        ?? thread.partnerPlatformUserId
        ?? thread.platformConversationId,
      unreadCount: Math.max(0, thread.unreadCount),
      hasUnreadTips: thread.hasUnreadTips,
      lastMessageId: thread.lastMessageId,
      lastMessageAt: thread.lastMessageAt ? serializeTimestamp(thread.lastMessageAt) : null,
      lastMessageIsSentByMe: thread.lastMessageSenderRole === "model",
      lastMessagePreview: thread.lastMessagePreview ?? "",
      visible: thread.isVisible,
      sourceUpdatedAt: serializeTimestamp(thread.updatedAt),
      messages: [...(messagesByChat.get(thread.platformConversationId)?.values() ?? [])],
    })),
    unresolvedTombstones: unresolvedTombstones.flatMap((row) => {
      if (!row.deletedAt || row.sourceFanoutSeq === null) {
        return [];
      }
      return [{
        messageId: row.platformMessageId,
        deletedAt: serializeTimestamp(row.deletedAt),
        sourceUpdatedAt: serializeTimestamp(
          row.updatedAt > row.sourceReceivedAt ? row.updatedAt : row.sourceReceivedAt,
        ),
        sourceFanoutSeq: row.sourceFanoutSeq,
      }];
    }),
    nextPageCursor: hasMore ? threads.at(-1)?.id ?? null : null,
  };
}
