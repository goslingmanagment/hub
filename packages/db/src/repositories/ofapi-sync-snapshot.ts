import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  dmMessageArchive,
  pageDmMessages,
  pageDmThreads,
  pages,
} from "../schema.ts";

export interface OfapiSyncSnapshotPage {
  id: number;
  label: string;
  username: string | null;
  ofapiAccountId: string;
  ofapiAuthStatus: string | null;
  ofapiAuthChangedAt: Date | null;
}

export interface OfapiSyncSnapshotThread {
  id: number;
  platformConversationId: string;
  partnerPlatformUserId: string | null;
  partnerUsername: string | null;
  partnerDisplayName: string | null;
  unreadCount: number;
  hasUnreadTips: boolean;
  lastMessageId: string | null;
  lastMessageAt: Date | null;
  lastMessageSenderRole: "fan" | "model" | "system" | "unknown";
  lastMessagePreview: string | null;
  isVisible: boolean;
  updatedAt: Date;
}

export interface OfapiSyncSnapshotHotMessage {
  conversationId: number;
  platformConversationId: string;
  platformMessageId: string;
  senderRole: "fan" | "model" | "system" | "unknown";
  createdAt: Date;
  content: string;
  totalTipAmountCents: number;
  inReplyToMessageId: string | null;
  purchasedAt: Date | null;
  syncedAt: Date;
}

export interface OfapiSyncSnapshotArchiveMessage {
  platformConversationId: string | null;
  platformMessageId: string;
  senderRole: "fan" | "model" | "system" | "unknown";
  isSentByMe: boolean;
  messageCreatedAt: Date | null;
  textPlain: string;
  priceMills: bigint | null;
  isOpened: boolean | null;
  isTip: boolean;
  tipAmountMills: bigint;
  inReplyToMessageId: string | null;
  deletedAt: Date | null;
  sourceFanoutSeq: number | null;
  sourceReceivedAt: Date;
  mediaMetadata: Array<Record<string, unknown>>;
  updatedAt: Date;
}

export async function findOfapiSyncSnapshotPage(
  db: Database,
  input: {
    assignedPageIds: number[];
    ofapiAccountId: string;
  },
): Promise<OfapiSyncSnapshotPage | null> {
  if (input.assignedPageIds.length === 0) {
    return null;
  }
  const [row] = await db
    .select({
      id: pages.id,
      label: pages.label,
      username: pages.username,
      ofapiAccountId: pages.ofapiAccountId,
      ofapiAuthStatus: pages.ofapiAuthStatus,
      ofapiAuthChangedAt: pages.ofapiAuthChangedAt,
    })
    .from(pages)
    .where(and(
      inArray(pages.id, input.assignedPageIds),
      eq(pages.ofapiAccountId, input.ofapiAccountId),
    ))
    .limit(1);

  return row?.ofapiAccountId ? { ...row, ofapiAccountId: row.ofapiAccountId } : null;
}

export async function listOfapiSyncSnapshotThreads(
  db: Database,
  input: {
    platformAccountId: number;
    afterThreadId: number;
    limit: number;
  },
): Promise<OfapiSyncSnapshotThread[]> {
  return db
    .select({
      id: pageDmThreads.id,
      platformConversationId: pageDmThreads.platformConversationId,
      partnerPlatformUserId: pageDmThreads.partnerPlatformUserId,
      partnerUsername: pageDmThreads.partnerUsername,
      partnerDisplayName: pageDmThreads.partnerDisplayName,
      unreadCount: pageDmThreads.unreadCount,
      hasUnreadTips: sql<boolean>`exists (
        select 1
        from (
          select
            m.total_tip_amount_cents,
            row_number() over (
              order by m.created_at desc, m.id desc
            ) as unread_rank
          from page_dm_messages m
          where m.conversation_id = "page_dm_threads"."id"
            and m.deleted_at is null
            and m.sender_role = 'fan'
        ) unread_fan_messages
        where unread_fan_messages.unread_rank <= "page_dm_threads"."unread_count"
          and unread_fan_messages.total_tip_amount_cents > 0
      )`,
      lastMessageId: pageDmThreads.lastMessageId,
      lastMessageAt: pageDmThreads.lastMessageAt,
      lastMessageSenderRole: pageDmThreads.lastMessageSenderRole,
      lastMessagePreview: pageDmThreads.lastMessagePreview,
      isVisible: pageDmThreads.isVisible,
      updatedAt: pageDmThreads.updatedAt,
    })
    .from(pageDmThreads)
    .where(and(
      eq(pageDmThreads.platformAccountId, input.platformAccountId),
      gt(pageDmThreads.id, input.afterThreadId),
    ))
    .orderBy(asc(pageDmThreads.id))
    .limit(input.limit);
}

export async function listOfapiSyncSnapshotHotMessages(
  db: Database,
  input: {
    platformAccountId: number;
    conversationIds: number[];
  },
): Promise<OfapiSyncSnapshotHotMessage[]> {
  if (input.conversationIds.length === 0) {
    return [];
  }
  return db
    .select({
      conversationId: pageDmMessages.conversationId,
      platformConversationId: pageDmThreads.platformConversationId,
      platformMessageId: pageDmMessages.platformMessageId,
      senderRole: pageDmMessages.senderRole,
      createdAt: pageDmMessages.createdAt,
      content: pageDmMessages.content,
      totalTipAmountCents: pageDmMessages.totalTipAmountCents,
      inReplyToMessageId: pageDmMessages.inReplyToMessageId,
      purchasedAt: pageDmMessages.purchasedAt,
      syncedAt: pageDmMessages.syncedAt,
    })
    .from(pageDmMessages)
    .innerJoin(pageDmThreads, eq(pageDmThreads.id, pageDmMessages.conversationId))
    .where(and(
      eq(pageDmMessages.platformAccountId, input.platformAccountId),
      inArray(pageDmMessages.conversationId, input.conversationIds),
      isNull(pageDmMessages.deletedAt),
    ))
    .orderBy(
      asc(pageDmMessages.conversationId),
      asc(pageDmMessages.createdAt),
      asc(pageDmMessages.id),
    );
}

export async function listOfapiSyncSnapshotArchiveMessages(
  db: Database,
  input: {
    platformAccountId: number;
    platformConversationIds: string[];
    hotMessageIds: string[];
    afterSeq: number;
  },
): Promise<OfapiSyncSnapshotArchiveMessage[]> {
  if (input.platformConversationIds.length === 0) {
    return [];
  }
  const deltaOrHot = input.hotMessageIds.length === 0
    ? gt(dmMessageArchive.sourceFanoutSeq, input.afterSeq)
    : or(
      gt(dmMessageArchive.sourceFanoutSeq, input.afterSeq),
      inArray(dmMessageArchive.platformMessageId, input.hotMessageIds),
    );

  return db
    .select({
      platformConversationId: dmMessageArchive.platformConversationId,
      platformMessageId: dmMessageArchive.platformMessageId,
      senderRole: dmMessageArchive.senderRole,
      isSentByMe: dmMessageArchive.isSentByMe,
      messageCreatedAt: dmMessageArchive.messageCreatedAt,
      textPlain: dmMessageArchive.textPlain,
      priceMills: dmMessageArchive.priceMills,
      isOpened: dmMessageArchive.isOpened,
      isTip: dmMessageArchive.isTip,
      tipAmountMills: dmMessageArchive.tipAmountMills,
      inReplyToMessageId: dmMessageArchive.inReplyToMessageId,
      deletedAt: dmMessageArchive.deletedAt,
      sourceFanoutSeq: dmMessageArchive.sourceFanoutSeq,
      sourceReceivedAt: dmMessageArchive.sourceReceivedAt,
      mediaMetadata: dmMessageArchive.mediaMetadata,
      updatedAt: dmMessageArchive.updatedAt,
    })
    .from(dmMessageArchive)
    .where(and(
      eq(dmMessageArchive.platformAccountId, input.platformAccountId),
      inArray(dmMessageArchive.platformConversationId, input.platformConversationIds),
      deltaOrHot,
    ))
    .orderBy(
      asc(dmMessageArchive.platformConversationId),
      asc(dmMessageArchive.messageCreatedAt),
      asc(dmMessageArchive.id),
    );
}

export async function listOfapiSyncSnapshotUnresolvedTombstones(
  db: Database,
  input: {
    platformAccountId: number;
    afterSeq: number;
  },
) {
  return db
    .select({
      platformMessageId: dmMessageArchive.platformMessageId,
      deletedAt: dmMessageArchive.deletedAt,
      sourceFanoutSeq: dmMessageArchive.sourceFanoutSeq,
      sourceReceivedAt: dmMessageArchive.sourceReceivedAt,
      updatedAt: dmMessageArchive.updatedAt,
    })
    .from(dmMessageArchive)
    .where(and(
      eq(dmMessageArchive.platformAccountId, input.platformAccountId),
      isNull(dmMessageArchive.platformConversationId),
      gt(dmMessageArchive.sourceFanoutSeq, input.afterSeq),
      isNull(dmMessageArchive.messageCreatedAt),
    ))
    .orderBy(asc(dmMessageArchive.sourceFanoutSeq), asc(dmMessageArchive.id));
}
