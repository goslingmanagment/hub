import { millsToDollarsNumber } from "@agency_hub_core/shared";
import {
  findOfapiSyncSnapshotPage,
  findOfapiSyncSnapshotThread,
  getOfapiSyncReplayFloor,
  getOfapiSyncSnapshotCursorWindow,
  getOfapiSyncSnapshotRowHighWaters,
  listOfapiSyncSnapshotArchiveMessagePage,
  listOfapiSyncSnapshotArchiveMessages,
  listOfapiSyncSnapshotHotMessagePage,
  listOfapiSyncSnapshotHotMessages,
  listOfapiSyncSnapshotThreads,
  listOfapiSyncSnapshotUnresolvedTombstonePage,
  listOfapiSyncSnapshotUnresolvedTombstones,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  BadRequestError,
  NotFoundError,
  SnapshotRestartRequiredError,
} from "./errors.ts";
import {
  decodeOfapiSyncSnapshotStateCursor,
  encodeOfapiSyncSnapshotStateCursor,
  type OfapiSyncSnapshotStateCursor,
} from "./ofapi-sync-snapshot-cursor.ts";

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

type SnapshotThread = Awaited<ReturnType<typeof listOfapiSyncSnapshotThreads>>[number];
type SnapshotPage = NonNullable<Awaited<ReturnType<typeof findOfapiSyncSnapshotPage>>>;
type SnapshotHotMessage = Awaited<ReturnType<typeof listOfapiSyncSnapshotHotMessagePage>>[number];
type SnapshotArchiveMessage = Awaited<ReturnType<typeof listOfapiSyncSnapshotArchiveMessagePage>>[number];

function serializeHotMessage(hot: SnapshotHotMessage) {
  return {
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
  };
}

function serializeArchiveMessage(archived: SnapshotArchiveMessage) {
  if (archived.platformConversationId === null) {
    throw new Error(`Bounded snapshot archive row ${archived.id} lost its conversation scope`);
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
  return {
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
  };
}

function serializeThread(thread: SnapshotThread, messages: unknown[]) {
  return {
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
    messages,
  };
}

function snapshotMetadata(
  app: AppContext,
  input: { afterSeq: number },
  page: SnapshotPage,
  snapshotCursor: number,
  stateAt: string,
) {
  const dmProjectionEnabled = app.config.ofapiDmProjectionEnabled === true;
  const coldArchiveEnabled = app.config.ofapiDmColdArchiveEnabled === true;
  return {
    version: 1 as const,
    requestedAfterSeq: input.afterSeq,
    snapshotCursor,
    stateAt,
    resumeAllowed: dmProjectionEnabled && coldArchiveEnabled,
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
      omittedDomains: [
        { domain: "presence", reason: "ephemeral_not_snapshotted" },
        { domain: "typing", reason: "ephemeral_not_snapshotted" },
        ...(!dmProjectionEnabled
          ? [{ domain: "chat_heads_and_hot_messages", reason: "dm_projection_disabled" }]
          : []),
        ...(!coldArchiveEnabled
          ? [{ domain: "message_tombstones", reason: "dm_cold_archive_disabled" }]
          : []),
      ],
      messageWindow: "hot_projection_plus_archive_delta" as const,
    },
  };
}

async function nextThreadPhase(
  app: AppContext,
  platformAccountId: number,
  afterThreadId: number,
  maxThreadId: number,
): Promise<OfapiSyncSnapshotStateCursor["phase"] | null> {
  const [thread] = await listOfapiSyncSnapshotThreads(app.db, {
    platformAccountId,
    afterThreadId,
    maxThreadId,
    limit: 1,
  });
  return thread
    ? { kind: "archive", threadId: thread.id, afterRowId: 0 }
    : null;
}

function encodedNextStateCursor(
  app: AppContext,
  scope: Omit<OfapiSyncSnapshotStateCursor, "phase">,
  phase: OfapiSyncSnapshotStateCursor["phase"] | null,
) {
  return phase === null
    ? null
    : encodeOfapiSyncSnapshotStateCursor({ ...scope, phase }, {
      key: app.config.encryptionKey,
      keyVersion: app.config.encryptionKeyVersion,
    });
}

/** Resolves the sticky fanout cursor once per bounded walk. The loader is a
 * narrow test seam that proves continuations do not repeat the journal query. */
export async function resolveOfapiSyncSnapshotCursor(
  input: {
    accountId: string;
    afterSeq: number;
    snapshotCursor?: number;
    minimumSnapshotCursor?: number;
    messageLimit: number;
  },
  decodedCursor: OfapiSyncSnapshotStateCursor | null,
  loadSafeSnapshotCursor: () => Promise<number>,
) {
  if (decodedCursor !== null) {
    // A bounded continuation carries the complete initial request scope, so we
    // do not rescan the journal on every message page. Retention can still move
    // the global replay floor past that sticky barrier mid-walk; the explicit
    // minimum check below then forces the client to restart from a fresh
    // snapshot instead of silently continuing an incomplete walk.
    if (
      decodedCursor.accountId !== input.accountId
      || decodedCursor.afterSeq !== input.afterSeq
      || decodedCursor.messageLimit !== input.messageLimit
      || (
        input.snapshotCursor !== undefined
        && input.snapshotCursor !== decodedCursor.snapshotCursor
      )
    ) {
      throw new BadRequestError("stateCursor does not match the snapshot request scope");
    }
    if (decodedCursor.snapshotCursor < (input.minimumSnapshotCursor ?? 0)) {
      throw new SnapshotRestartRequiredError(input.minimumSnapshotCursor ?? 0);
    }
    return decodedCursor.snapshotCursor;
  }

  const safeSnapshotCursor = await loadSafeSnapshotCursor();
  const snapshotCursor = input.snapshotCursor ?? safeSnapshotCursor;
  if (snapshotCursor > safeSnapshotCursor) {
    throw new BadRequestError(
      `snapshotCursor ${snapshotCursor} is ahead of safe snapshot sequence ${safeSnapshotCursor}`,
    );
  }
  if (snapshotCursor < (input.minimumSnapshotCursor ?? 0)) {
    throw new SnapshotRestartRequiredError(input.minimumSnapshotCursor ?? 0);
  }
  return snapshotCursor;
}

async function getBoundedOfapiSyncSnapshot(
  app: AppContext,
  input: {
    accountId: string;
    afterSeq: number;
    snapshotCursor: number;
    pageCursor: number;
    messageLimit: number;
    stateCursor?: string;
    now?: Date;
  },
  page: SnapshotPage,
  decodedCursor: OfapiSyncSnapshotStateCursor | null,
) {
  if (input.pageCursor !== 0) {
    throw new BadRequestError("pageCursor must be 0 when pageMode=bounded_v1");
  }
  const highWaters =
    decodedCursor?.maxThreadId !== undefined
    && decodedCursor.maxArchiveId !== undefined
    && decodedCursor.maxHotMessageId !== undefined
      ? {
          maxThreadId: decodedCursor.maxThreadId,
          maxArchiveId: decodedCursor.maxArchiveId,
          maxHotMessageId: decodedCursor.maxHotMessageId,
        }
      : await getOfapiSyncSnapshotRowHighWaters(app.db, page.id);
  const cursor = {
    ...(decodedCursor ?? {
      version: 1 as const,
      accountId: input.accountId,
      afterSeq: input.afterSeq,
      snapshotCursor: input.snapshotCursor,
      stateAt: serializeTimestamp(input.now ?? new Date()),
      messageLimit: input.messageLimit,
      phase: { kind: "unresolved" as const, afterRowId: 0 },
    }),
    ...highWaters,
  };
  if (
    cursor.accountId !== input.accountId
    || cursor.afterSeq !== input.afterSeq
    || cursor.snapshotCursor !== input.snapshotCursor
    || cursor.messageLimit !== input.messageLimit
  ) {
    throw new BadRequestError("stateCursor does not match the snapshot request scope");
  }

  const { phase: _initialPhase, ...scope } = cursor;
  const metadata = snapshotMetadata(
    app,
    input,
    page,
    input.snapshotCursor,
    cursor.stateAt,
  );
  let phase = cursor.phase;

  for (;;) {
    if (phase.kind === "unresolved") {
      const rows = await listOfapiSyncSnapshotUnresolvedTombstonePage(app.db, {
        platformAccountId: page.id,
        afterSeq: input.afterSeq,
        afterArchiveId: phase.afterRowId,
        maxArchiveId: cursor.maxArchiveId,
        maxHotMessageId: cursor.maxHotMessageId,
        limit: input.messageLimit + 1,
      });
      if (rows.length === 0) {
        const nextPhase = await nextThreadPhase(app, page.id, 0, cursor.maxThreadId);
        if (nextPhase === null) {
          return {
            ...metadata,
            threads: [],
            unresolvedTombstones: [],
            nextPageCursor: null,
            nextStateCursor: null,
          };
        }
        phase = nextPhase;
        continue;
      }
      const selected = rows.slice(0, input.messageLimit);
      const hasMore = rows.length > input.messageLimit;
      const nextPhase = hasMore
        ? { kind: "unresolved" as const, afterRowId: selected.at(-1)!.id }
        : await nextThreadPhase(app, page.id, 0, cursor.maxThreadId);
      return {
        ...metadata,
        threads: [],
        unresolvedTombstones: selected.flatMap((row) => {
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
        nextPageCursor: null,
        nextStateCursor: encodedNextStateCursor(app, scope, nextPhase),
      };
    }

    const thread = await findOfapiSyncSnapshotThread(app.db, {
      platformAccountId: page.id,
      threadId: phase.threadId,
      maxThreadId: cursor.maxThreadId,
    });
    if (!thread) {
      // The cursor was signed when this thread existed, but an erasure may
      // legitimately hard-delete it before the next bounded page arrives.
      // Thread ids are monotonic keyset positions: skip the vanished row and
      // continue strictly after its signed id. Signature and request-scope
      // validation already happened above, so caller-chosen positions still
      // cannot reach this branch.
      const nextPhase = await nextThreadPhase(
        app,
        page.id,
        phase.threadId,
        cursor.maxThreadId,
      );
      if (nextPhase === null) {
        return {
          ...metadata,
          threads: [],
          unresolvedTombstones: [],
          nextPageCursor: null,
          nextStateCursor: null,
        };
      }
      phase = nextPhase;
      continue;
    }

    if (phase.kind === "archive") {
      const rows = await listOfapiSyncSnapshotArchiveMessagePage(app.db, {
        platformAccountId: page.id,
        conversationId: thread.id,
        platformConversationId: thread.platformConversationId,
        afterSeq: input.afterSeq,
        afterArchiveId: phase.afterRowId,
        maxArchiveId: cursor.maxArchiveId,
        maxHotMessageId: cursor.maxHotMessageId,
        limit: input.messageLimit + 1,
      });
      if (rows.length === 0) {
        phase = { kind: "hot", threadId: thread.id, afterRowId: 0 };
        continue;
      }
      const selected = rows.slice(0, input.messageLimit);
      const hasMore = rows.length > input.messageLimit;
      const nextPhase: OfapiSyncSnapshotStateCursor["phase"] = hasMore
        ? { kind: "archive", threadId: thread.id, afterRowId: selected.at(-1)!.id }
        : { kind: "hot", threadId: thread.id, afterRowId: 0 };
      return {
        ...metadata,
        threads: [serializeThread(thread, selected.map(serializeArchiveMessage))],
        unresolvedTombstones: [],
        nextPageCursor: null,
        nextStateCursor: encodedNextStateCursor(app, scope, nextPhase),
      };
    }

    const rows = await listOfapiSyncSnapshotHotMessagePage(app.db, {
      platformAccountId: page.id,
      conversationId: thread.id,
      platformConversationId: thread.platformConversationId,
      afterMessageId: phase.afterRowId,
      maxArchiveId: cursor.maxArchiveId,
      maxHotMessageId: cursor.maxHotMessageId,
      limit: input.messageLimit + 1,
    });
    const selected = rows.slice(0, input.messageLimit);
    const hasMore = rows.length > input.messageLimit;
    const nextPhase = hasMore
      ? { kind: "hot" as const, threadId: thread.id, afterRowId: selected.at(-1)!.id }
      : await nextThreadPhase(app, page.id, thread.id, cursor.maxThreadId);
    return {
      ...metadata,
      threads: [serializeThread(thread, selected.map(serializeHotMessage))],
      unresolvedTombstones: [],
      nextPageCursor: null,
      nextStateCursor: encodedNextStateCursor(app, scope, nextPhase),
    };
  }
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
    pageMode?: "bounded_v1";
    stateCursor?: string;
    messageLimit: number;
    now?: Date;
  },
) {
  if (input.stateCursor !== undefined && input.pageMode !== "bounded_v1") {
    throw new BadRequestError("stateCursor requires pageMode=bounded_v1");
  }
  const decodedCursor = input.stateCursor === undefined
    ? null
    : decodeOfapiSyncSnapshotStateCursor(
      input.stateCursor,
      app.config.encryptionKeysByVersion,
    );
  if (input.stateCursor !== undefined && decodedCursor === null) {
    throw new BadRequestError("Invalid stateCursor");
  }
  const replayFloor = await getOfapiSyncReplayFloor(app.db);
  const snapshotCursor = await resolveOfapiSyncSnapshotCursor(
    { ...input, minimumSnapshotCursor: replayFloor },
    decodedCursor,
    async () => {
      const cursorWindow = await getOfapiSyncSnapshotCursorWindow(app.db, {
        assignedPageIds: input.assignedPageIds,
        afterSeq: input.afterSeq,
      });
      return cursorWindow.safeSnapshotCursor;
    },
  );
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

  if (input.pageMode === "bounded_v1") {
    return getBoundedOfapiSyncSnapshot(app, {
      accountId: input.accountId,
      afterSeq: input.afterSeq,
      snapshotCursor,
      pageCursor: input.pageCursor,
      messageLimit: input.messageLimit,
      ...(input.stateCursor === undefined ? {} : { stateCursor: input.stateCursor }),
      ...(input.now === undefined ? {} : { now: input.now }),
    }, page, decodedCursor);
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
