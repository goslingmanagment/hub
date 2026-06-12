// Live OnlyFans DM projection (Phase 1 of docs/ofapi-integration-plan.md, D1/D2).
// Projects settled OFAPI webhook journal rows for mapped OnlyFans pages into the
// platform-agnostic page_dm_threads / page_dm_messages tables, via the same
// repository helpers the Fansly sync uses. Runs strictly post-settle and keeps
// its own bookkeeping on the journal row (projection_status / projection_error);
// it never blocks or fails the settle/fanout path. Idempotent: message upserts
// are keyed on (conversation_id, platform_message_id), already-stored messages
// short-circuit, and conversation heads only advance forward.

import {
  findPageByOfapiAccountId,
  findPageDmMessageByPlatformMessageId,
  deletePageDmMessageByPlatformMessageId,
  getExistingPageDmMessageIds,
  listOfapiWebhookEventsForDmProjection,
  listPageDmConversationsByPlatformConversationIds,
  markOfapiWebhookEventProjection,
  markPageDmMessagePurchased,
  raisePageDmMessageTipAmount,
  refreshPageDmConversationWindow,
  upsertFanPageExternalPresences,
  upsertFanPages,
  upsertFans,
  upsertPageDmConversation,
  upsertPageDmMessages,
  type Database,
  type PageDmConversationRow,
} from "@agency_hub_core/db";
import {
  normalizeDmMessageText,
  OFAPI_EXTERNAL_PRESENCE_SOURCE_LAST_SEEN,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import {
  asRecord,
  extractMessageIdFromNotification,
  idToString,
  notificationChatId,
  ofapiWebhookEnvelopeSchema,
} from "./ofapi-payloads.ts";

export const OFAPI_DM_PROJECTION_EVENT_TYPES = [
  "messages.received",
  "messages.sent",
  "messages.deleted",
  "messages.ppv.unlocked",
  "tips.received",
] as const;

export const OFAPI_DM_PROJECTION_MAX_ATTEMPTS = 5;
const OFAPI_DM_PROJECTION_SWEEP_LIMIT = 200;
const DM_PREVIEW_MAX_LENGTH = 280;

type OfapiDmProjectionEventType = (typeof OFAPI_DM_PROJECTION_EVENT_TYPES)[number];

// Journal row shape as the projection needs it (subset of ofapi_webhook_events).
export interface OfapiDmProjectableRow {
  id: number;
  eventType: string;
  ofapiAccountId: string | null;
  payload: Record<string, unknown>;
  projectionStatus: string;
  receivedAt: Date;
}

export type OfapiDmProjectionOutcome =
  | { status: "projected" }
  | { status: "skipped"; reason: string };

export function isOfapiDmProjectionEnabled(
  config?: Pick<AppContext["config"], "ofapiDmProjectionEnabled">,
) {
  return config?.ofapiDmProjectionEnabled === true;
}

export function isOfapiDmProjectionEventType(
  eventType: string,
): eventType is OfapiDmProjectionEventType {
  return (OFAPI_DM_PROJECTION_EVENT_TYPES as readonly string[]).includes(eventType);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function truncatePreview(content: string) {
  if (!content) {
    return null;
  }

  return content.length <= DM_PREVIEW_MAX_LENGTH
    ? content
    : `${content.slice(0, DM_PREVIEW_MAX_LENGTH - 1).trimEnd()}…`;
}

function parseMessageTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function usdToCents(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value * 100)
    : 0;
}

// Message ids are numeric strings; compare numerically with a lexicographic
// fallback so equal-timestamp head updates stay deterministic.
function compareMessageIds(a: string, b: string) {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface OfapiProjectedDmMessage {
  direction: "received" | "sent";
  messageId: string;
  // OFAPI chats are addressed by the fan's OnlyFans user id (D2): conversation
  // id, partner id, and SyncEvent chatId are all this value.
  fanId: string;
  fanUsername: string | null;
  fanDisplayName: string | null;
  senderPlatformUserId: string | null;
  content: string;
  preview: string | null;
  createdAt: Date;
  tipAmountCents: number;
  inReplyToMessageId: string | null;
  // The fan's lastSeen carried on the partner user object — folded into the
  // presence store when OFAPI_PRESENCE_PROJECTION_ENABLED (parity Phase 4).
  partnerLastSeenAt: Date | null;
}

/**
 * Maps a messages.received / messages.sent payload (the complete OnlyFans
 * message object) to the row we store. Returns null when the payload is missing
 * the message id, the fan identity, or a parseable timestamp — those are
 * permanent data problems, not retryable failures.
 */
export function parseOfapiDmMessagePayload(
  eventType: "messages.received" | "messages.sent",
  payload: Record<string, unknown>,
): OfapiProjectedDmMessage | null {
  const direction = eventType === "messages.received" ? "received" as const : "sent" as const;
  // received: fromUser is the fan; sent: toUser is the fan (fromUser is absent
  // in live captures of sent events).
  const partner = asRecord(direction === "received" ? payload.fromUser : payload.toUser);
  const fanId = idToString(partner?.id);
  const messageId = idToString(payload.id);
  const createdAt = parseMessageTimestamp(payload.createdAt);
  if (!partner || !fanId || !messageId || !createdAt) {
    return null;
  }

  const content = normalizeDmMessageText(typeof payload.text === "string" ? payload.text : "");
  const senderId = idToString(asRecord(payload.fromUser)?.id);
  return {
    direction,
    messageId,
    fanId,
    fanUsername: nonEmpty(partner.username),
    // OnlyFans user objects carry the display name in "name"; "displayName" is
    // secondary and often empty.
    fanDisplayName: nonEmpty(partner.name) ?? nonEmpty(partner.displayName),
    senderPlatformUserId: senderId,
    content,
    preview: truncatePreview(content),
    createdAt,
    // Priced non-tip messages are PPV; price is the unlock price, not revenue,
    // so only tip messages carry an amount here. D5: media is never downloaded.
    tipAmountCents: payload.isTip === true ? usdToCents(payload.price) : 0,
    inReplyToMessageId: idToString(asRecord(payload.replyToMessage)?.id),
    partnerLastSeenAt: parseMessageTimestamp(partner.lastSeen),
  };
}

function headAdvances(
  message: Pick<OfapiProjectedDmMessage, "messageId" | "createdAt">,
  existing: Pick<PageDmConversationRow, "lastMessageAt" | "lastMessageId">,
) {
  if (!existing.lastMessageAt) {
    return true;
  }
  if (message.createdAt.getTime() !== existing.lastMessageAt.getTime()) {
    return message.createdAt.getTime() > existing.lastMessageAt.getTime();
  }
  return existing.lastMessageId === null ||
    compareMessageIds(message.messageId, existing.lastMessageId) > 0;
}

async function projectDmMessageEvent(
  app: AppContext,
  page: { id: number },
  message: OfapiProjectedDmMessage,
): Promise<OfapiDmProjectionOutcome> {
  return app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    // B11: lock the conversation row for the whole read-compute-upsert cycle
    // so the REST reconcile's full-row upsert and this projection serialize
    // instead of racing (lost update on the head/unread fields). Lock order —
    // conversation before fans — matches applyChatSummaries in ofapi-dm-sync.
    const [existing] = await listPageDmConversationsByPlatformConversationIds(db, {
      platformAccountId: page.id,
      platformConversationIds: [message.fanId],
      forUpdate: true,
    });

    if (existing) {
      const storedIds = await getExistingPageDmMessageIds(db, {
        conversationId: existing.id,
        platformMessageIds: [message.messageId],
      });
      if (storedIds.has(message.messageId)) {
        // At-least-once replay of a message we already hold; tip/purchase
        // annotations are managed by their own events, so nothing to do.
        return { status: "projected" } satisfies OfapiDmProjectionOutcome;
      }
    }

    const [fanRow] = await upsertFans(db, [{
      platform: "onlyfans",
      platformUserId: message.fanId,
      ...(message.fanUsername !== null ? { username: message.fanUsername } : {}),
      ...(message.fanDisplayName !== null ? { displayName: message.fanDisplayName } : {}),
    }]);
    if (fanRow) {
      await upsertFanPages(db, [{
        fanId: fanRow.id,
        platformAccountId: page.id,
      }]);
      // One journal pass folds the payload's lastSeen into presence (plan
      // recommendation 5) — gated by the Phase 4 flag, forward-only by the
      // store's greatest() semantics.
      if (app.config.ofapiPresenceProjectionEnabled === true && message.partnerLastSeenAt) {
        await upsertFanPageExternalPresences(db, [{
          fanId: fanRow.id,
          platformAccountId: page.id,
          externalPresenceAt: message.partnerLastSeenAt,
          externalPresenceObservedAt: message.createdAt,
          externalPresenceSource: OFAPI_EXTERNAL_PRESENCE_SOURCE_LAST_SEEN,
        }]);
      }
    }

    const received = message.direction === "received";
    const advance = existing ? headAdvances(message, existing) : true;
    // Unread heuristic (Phase 2 reconcile corrects drift): each new fan message
    // increments; a new model reply at the head zeroes. Replays never get here.
    const unreadCount = received
      ? (existing?.unreadCount ?? 0) + 1
      : advance
        ? 0
        : existing?.unreadCount ?? 0;

    const conversation = await upsertPageDmConversation(db, {
      platformAccountId: page.id,
      fanId: existing?.fanId ?? fanRow?.id ?? null,
      platformConversationId: message.fanId,
      partnerPlatformUserId: message.fanId,
      partnerUsername: message.fanUsername ?? existing?.partnerUsername ?? null,
      partnerDisplayName: message.fanDisplayName ?? existing?.partnerDisplayName ?? null,
      conversationFlags: existing?.conversationFlags ?? 0,
      unreadCount,
      subscriptionTierId: existing?.subscriptionTierId ?? null,
      lastMessageId: advance ? message.messageId : existing?.lastMessageId ?? null,
      lastUnreadMessageId: advance
        ? (received ? message.messageId : null)
        : existing?.lastUnreadMessageId ?? null,
      lastMessageAt: advance ? message.createdAt : existing?.lastMessageAt ?? null,
      lastMessageSenderId: advance
        ? message.senderPlatformUserId
        : existing?.lastMessageSenderId ?? null,
      lastMessageSenderRole: advance
        ? (received ? "fan" : "model")
        : existing?.lastMessageSenderRole ?? "unknown",
      lastMessagePreview: advance ? message.preview : existing?.lastMessagePreview ?? null,
      // Recomputed from stored rows by refreshPageDmConversationWindow below.
      lastFanMessageAt: existing?.lastFanMessageAt ?? null,
      lastModelMessageAt: existing?.lastModelMessageAt ?? null,
      storedMessageCount: existing?.storedMessageCount ?? 0,
      newestStoredMessageId: existing?.newestStoredMessageId ?? null,
      oldestStoredMessageId: existing?.oldestStoredMessageId ?? null,
      messageCoverageStatus: existing?.messageCoverageStatus ?? "pending_backfill",
      lastMessageSyncAt: existing?.lastMessageSyncAt ?? null,
      // A live message makes the conversation current again even if a Fansly-style
      // generation sweep had hidden it.
      isVisible: true,
      lastSeenGeneration: existing?.lastSeenGeneration ?? null,
      metadata: {
        ...existing?.metadata,
        provider: nonEmpty(existing?.metadata.provider) ?? "ofapi",
      },
      // B11 insert-race defense: when the row did not exist at read time
      // there was nothing to lock, so the upsert itself refuses to move the
      // head backwards (decision #50: heads only ever advance).
      headForwardOnly: true,
    });

    await upsertPageDmMessages(db, [{
      conversationId: conversation.id,
      platformAccountId: page.id,
      platformMessageId: message.messageId,
      senderPlatformUserId: received ? message.fanId : message.senderPlatformUserId,
      senderRole: received ? "fan" : "model",
      createdAt: message.createdAt,
      content: message.content,
      totalTipAmountCents: message.tipAmountCents,
      inReplyToMessageId: message.inReplyToMessageId,
      inReplyToRootMessageId: null,
    }]);

    await refreshPageDmConversationWindow(db, {
      conversationId: conversation.id,
      enforceRetention: true,
    });

    return { status: "projected" } satisfies OfapiDmProjectionOutcome;
  });
}

async function projectDmMessageDeleted(
  app: AppContext,
  page: { id: number },
  payload: Record<string, unknown>,
): Promise<OfapiDmProjectionOutcome> {
  const messageId = idToString(payload.id);
  if (!messageId) {
    return { status: "skipped", reason: "messages.deleted payload has no message id" };
  }

  return app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const deleted = await deletePageDmMessageByPlatformMessageId(db, {
      platformAccountId: page.id,
      platformMessageId: messageId,
    });
    if (!deleted) {
      return {
        status: "skipped",
        reason: "Deleted message is not stored locally",
      } satisfies OfapiDmProjectionOutcome;
    }

    await refreshPageDmConversationWindow(db, {
      conversationId: deleted.conversationId,
      // Rebuilds the conversation head when the deleted message was the head,
      // so the preview/unread state never points at deleted content (B10).
      rebuildHeadForDeletedMessageId: messageId,
    });
    return { status: "projected" } satisfies OfapiDmProjectionOutcome;
  });
}

async function projectDmPpvUnlocked(
  app: AppContext,
  page: { id: number },
  payload: Record<string, unknown>,
): Promise<OfapiDmProjectionOutcome> {
  const messageId = extractMessageIdFromNotification(payload);
  if (!messageId) {
    return { status: "skipped", reason: "ppv.unlocked notification has no message reference" };
  }

  const marked = await markPageDmMessagePurchased(app.db, {
    platformAccountId: page.id,
    platformMessageId: messageId,
    purchasedAt: parseMessageTimestamp(payload.createdAt) ?? undefined,
  });
  return marked
    ? { status: "projected" }
    : { status: "skipped", reason: "Unlocked message is not stored locally (or already marked)" };
}

async function projectDmTipReceived(
  app: AppContext,
  page: { id: number },
  payload: Record<string, unknown>,
): Promise<OfapiDmProjectionOutcome> {
  const messageId = extractMessageIdFromNotification(payload);
  const tipAmountCents = usdToCents(payload.amountGross);
  if (!messageId) {
    return { status: "skipped", reason: "tips.received notification has no message reference" };
  }
  if (tipAmountCents <= 0) {
    return { status: "skipped", reason: "tips.received notification has no positive amount" };
  }

  const raised = await raisePageDmMessageTipAmount(app.db, {
    platformAccountId: page.id,
    platformMessageId: messageId,
    tipAmountCents,
  });
  return raised
    ? { status: "projected" }
    : { status: "skipped", reason: "Tipped message is not stored locally" };
}

/**
 * Projects one journal row. Returns the outcome; throws only on infrastructure
 * errors (DB failures), which the caller records as a retryable 'failed'.
 */
export async function projectOfapiDmEvent(
  app: AppContext,
  row: OfapiDmProjectableRow,
): Promise<OfapiDmProjectionOutcome> {
  if (!isOfapiDmProjectionEventType(row.eventType)) {
    return { status: "skipped", reason: `Event type "${row.eventType}" is not projected` };
  }

  const envelope = ofapiWebhookEnvelopeSchema.safeParse(row.payload);
  if (!envelope.success) {
    return { status: "skipped", reason: "Journaled payload is not a valid OFAPI envelope" };
  }

  const page = row.ofapiAccountId
    ? await findPageByOfapiAccountId(app.db, row.ofapiAccountId)
    : null;
  if (!page) {
    return {
      status: "skipped",
      reason: row.ofapiAccountId
        ? `No page mapped to OFAPI account "${row.ofapiAccountId}"`
        : "Envelope has no account_id",
    };
  }
  if (page.platform !== "onlyfans") {
    return { status: "skipped", reason: `Page "${page.label}" is not an OnlyFans page` };
  }

  const payload = asRecord(envelope.data.payload) ?? {};
  switch (row.eventType) {
    case "messages.received":
    case "messages.sent": {
      const message = parseOfapiDmMessagePayload(row.eventType, payload);
      if (!message) {
        return {
          status: "skipped",
          reason: "Message payload is missing ids, fan identity, or a valid createdAt",
        };
      }
      return projectDmMessageEvent(app, page, message);
    }
    case "messages.deleted":
      return projectDmMessageDeleted(app, page, payload);
    case "messages.ppv.unlocked":
      return projectDmPpvUnlocked(app, page, payload);
    case "tips.received":
      return projectDmTipReceived(app, page, payload);
  }
}

/**
 * Best-effort projection of a freshly settled row plus bookkeeping. Never
 * throws — failures are recorded on the journal row and retried by the sweep.
 */
export async function runOfapiDmProjectionForSettledRow(
  app: AppContext,
  row: OfapiDmProjectableRow,
) {
  if (
    !isOfapiDmProjectionEnabled(app.config) ||
    // Presence/subscription rows belong to their own projections; stamping
    // them "skipped" here would terminally block the enable-later
    // back-projection because the mark never demotes a settled status
    // (pre-deploy audit B4).
    !isOfapiDmProjectionEventType(row.eventType)
  ) {
    return;
  }
  if (row.projectionStatus !== "pending" && row.projectionStatus !== "failed") {
    return;
  }

  try {
    const outcome = await projectOfapiDmEvent(app, row);
    await markOfapiWebhookEventProjection(app.db, {
      id: row.id,
      status: outcome.status,
      error: outcome.status === "skipped" ? outcome.reason : null,
    });
  } catch (error) {
    app.logger.warn(
      { err: error, eventId: row.id, eventType: row.eventType },
      "OFAPI DM projection failed; sweep will retry",
    );
    await markOfapiWebhookEventProjection(app.db, {
      id: row.id,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }).catch((markError) => {
      app.logger.warn(
        { err: markError, eventId: row.id },
        "Failed to record OFAPI DM projection failure",
      );
    });
  }
}

/**
 * Minutely sweep: projects settled rows whose immediate post-settle projection
 * was lost (worker crash, flag enabled later) and retries failed rows under the
 * attempt cap.
 */
export async function sweepOfapiDmProjections(app: AppContext) {
  if (!isOfapiDmProjectionEnabled(app.config)) {
    return 0;
  }

  const rows = await listOfapiWebhookEventsForDmProjection(app.db, {
    eventTypes: OFAPI_DM_PROJECTION_EVENT_TYPES,
    maxAttempts: OFAPI_DM_PROJECTION_MAX_ATTEMPTS,
    limit: OFAPI_DM_PROJECTION_SWEEP_LIMIT,
  });

  for (const row of rows) {
    await runOfapiDmProjectionForSettledRow(app, row);
  }

  return rows.length;
}
