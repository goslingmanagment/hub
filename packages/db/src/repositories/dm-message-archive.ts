import { and, eq, lt, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { dmMessageArchive } from "../schema.ts";

export type DmMessageArchiveSource = "webhook" | "command" | "rest_reconcile" | "rest_backfill";
export type DmMessageArchiveEventType =
  | "messages.received"
  | "messages.sent"
  | "messages.deleted";

export interface DmMessageArchiveMediaItem {
  id: string;
  type: "photo" | "video" | "audio" | "gif" | "other";
  isReady: boolean;
  locked: boolean;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
}

export interface UpsertDmMessageArchiveInput {
  platform: "onlyfans";
  platformAccountId: number;
  ofapiAccountId: string;
  platformConversationId: string;
  fanPlatformUserId: string;
  platformMessageId: string;
  senderPlatformUserId?: string | null;
  senderRole: "fan" | "model" | "system" | "unknown";
  isSentByMe: boolean;
  messageCreatedAt: Date;
  textPlain: string;
  priceMills?: bigint | null;
  isOpened?: boolean | null;
  isTip: boolean;
  tipAmountMills: bigint;
  inReplyToMessageId?: string | null;
  source: DmMessageArchiveSource;
  sourceEventType: Extract<DmMessageArchiveEventType, "messages.received" | "messages.sent">;
  sourceIdempotencyKey: string;
  sourceJournalId: number;
  sourceFanoutSeq?: number | null;
  sourceReceivedAt: Date;
  rawShapeVersion: string;
  mediaMetadata: DmMessageArchiveMediaItem[];
  retentionPolicy: string;
  retainUntil: Date;
}

export interface TombstoneDmMessageArchiveInput {
  platform: "onlyfans";
  platformAccountId: number;
  ofapiAccountId: string;
  platformMessageId: string;
  deletedAt: Date;
  source: DmMessageArchiveSource;
  sourceEventType: Extract<DmMessageArchiveEventType, "messages.deleted">;
  sourceIdempotencyKey: string;
  sourceJournalId: number;
  sourceFanoutSeq?: number | null;
  sourceReceivedAt: Date;
  retentionPolicy: string;
  retainUntil: Date;
}

export async function upsertDmMessageArchive(
  db: Database,
  input: UpsertDmMessageArchiveInput,
) {
  const now = new Date();
  const mediaMetadata = input.mediaMetadata as unknown as Array<Record<string, unknown>>;
  const [row] = await db
    .insert(dmMessageArchive)
    .values({
      platform: input.platform,
      platformAccountId: input.platformAccountId,
      ofapiAccountId: input.ofapiAccountId,
      platformConversationId: input.platformConversationId,
      fanPlatformUserId: input.fanPlatformUserId,
      platformMessageId: input.platformMessageId,
      senderPlatformUserId: input.senderPlatformUserId ?? null,
      senderRole: input.senderRole,
      isSentByMe: input.isSentByMe,
      messageCreatedAt: input.messageCreatedAt,
      textPlain: input.textPlain,
      priceMills: input.priceMills ?? null,
      isOpened: input.isOpened ?? null,
      isTip: input.isTip,
      tipAmountMills: input.tipAmountMills,
      inReplyToMessageId: input.inReplyToMessageId ?? null,
      source: input.source,
      sourceEventType: input.sourceEventType,
      sourceIdempotencyKey: input.sourceIdempotencyKey,
      sourceJournalId: input.sourceJournalId,
      sourceFanoutSeq: input.sourceFanoutSeq ?? null,
      sourceReceivedAt: input.sourceReceivedAt,
      rawShapeVersion: input.rawShapeVersion,
      mediaMetadata,
      retentionPolicy: input.retentionPolicy,
      retainUntil: input.retainUntil,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        dmMessageArchive.platform,
        dmMessageArchive.ofapiAccountId,
        dmMessageArchive.platformMessageId,
      ],
      set: {
        platformAccountId: input.platformAccountId,
        platformConversationId: input.platformConversationId,
        fanPlatformUserId: input.fanPlatformUserId,
        senderPlatformUserId: input.senderPlatformUserId ?? null,
        senderRole: input.senderRole,
        isSentByMe: input.isSentByMe,
        messageCreatedAt: input.messageCreatedAt,
        textPlain: input.textPlain,
        priceMills: input.priceMills ?? null,
        isOpened: input.isOpened ?? null,
        isTip: input.isTip,
        tipAmountMills: input.tipAmountMills,
        inReplyToMessageId: input.inReplyToMessageId ?? null,
        source: input.source,
        sourceEventType: input.sourceEventType,
        sourceIdempotencyKey: input.sourceIdempotencyKey,
        sourceJournalId: input.sourceJournalId,
        sourceFanoutSeq: input.sourceFanoutSeq ?? null,
        sourceReceivedAt: input.sourceReceivedAt,
        rawShapeVersion: input.rawShapeVersion,
        mediaMetadata,
        retentionPolicy: input.retentionPolicy,
        retainUntil: input.retainUntil,
        updatedAt: now,
      },
    })
    .returning();

  return row ?? null;
}

export async function tombstoneDmMessageArchive(
  db: Database,
  input: TombstoneDmMessageArchiveInput,
) {
  const now = new Date();
  const [row] = await db
    .insert(dmMessageArchive)
    .values({
      platform: input.platform,
      platformAccountId: input.platformAccountId,
      ofapiAccountId: input.ofapiAccountId,
      platformMessageId: input.platformMessageId,
      senderRole: "unknown",
      isSentByMe: false,
      textPlain: "",
      isTip: false,
      tipAmountMills: 0n,
      deletedAt: input.deletedAt,
      source: input.source,
      sourceEventType: input.sourceEventType,
      sourceIdempotencyKey: input.sourceIdempotencyKey,
      sourceJournalId: input.sourceJournalId,
      sourceFanoutSeq: input.sourceFanoutSeq ?? null,
      sourceReceivedAt: input.sourceReceivedAt,
      rawShapeVersion: "ofapi-message-v1",
      mediaMetadata: [],
      retentionPolicy: input.retentionPolicy,
      retainUntil: input.retainUntil,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        dmMessageArchive.platform,
        dmMessageArchive.ofapiAccountId,
        dmMessageArchive.platformMessageId,
      ],
      set: {
        deletedAt: sql`coalesce(${dmMessageArchive.deletedAt}, ${input.deletedAt}::timestamptz)`,
        source: input.source,
        sourceEventType: input.sourceEventType,
        sourceIdempotencyKey: input.sourceIdempotencyKey,
        sourceJournalId: input.sourceJournalId,
        sourceFanoutSeq: input.sourceFanoutSeq ?? null,
        sourceReceivedAt: input.sourceReceivedAt,
        retentionPolicy: input.retentionPolicy,
        retainUntil: input.retainUntil,
        updatedAt: now,
      },
    })
    .returning();

  return row ?? null;
}

export async function findDmMessageArchiveByPlatformMessageId(
  db: Database,
  input: {
    platform: "onlyfans";
    ofapiAccountId: string;
    platformMessageId: string;
  },
) {
  return await db.query.dmMessageArchive.findFirst({
    where: and(
      eq(dmMessageArchive.platform, input.platform),
      eq(dmMessageArchive.ofapiAccountId, input.ofapiAccountId),
      eq(dmMessageArchive.platformMessageId, input.platformMessageId),
    ),
  }) ?? null;
}

export async function deleteExpiredDmMessageArchiveRows(
  db: Database,
  now: Date,
) {
  const rows = await db
    .delete(dmMessageArchive)
    .where(lt(dmMessageArchive.retainUntil, now))
    .returning({ id: dmMessageArchive.id });

  return rows.length;
}

export async function getDmMessageArchiveStatus(
  db: Database,
  now = new Date(),
) {
  const result = await db.execute<{
    row_count: number | string;
    tombstone_count: number | string;
    last_archived_at: Date | string | null;
    last_source_received_at: Date | string | null;
    next_purge_at: Date | string | null;
    archive_pending_count: number | string;
    archive_failed_count: number | string;
    last_archive_error: string | null;
  }>(sql`
    with archive_rows as (
      select
        count(*)::int as row_count,
        count(*) filter (where deleted_at is not null)::int as tombstone_count,
        max(archived_at) as last_archived_at,
        max(source_received_at) as last_source_received_at,
        min(retain_until) as next_purge_at
      from dm_message_archive
    ), journal_status as (
      select
        count(*) filter (where archive_status = 'pending')::int as archive_pending_count,
        count(*) filter (where archive_status = 'failed')::int as archive_failed_count,
        (
          select archive_error
          from ofapi_webhook_events
          where archive_status = 'failed'
            and archive_error is not null
          order by id desc
          limit 1
        ) as last_archive_error
      from ofapi_webhook_events
    )
    select *
    from archive_rows
    cross join journal_status
  `);
  const row = result.rows[0];
  const lastSourceReceivedAt = row?.last_source_received_at
    ? new Date(row.last_source_received_at)
    : null;

  return {
    rowCount: Number(row?.row_count ?? 0),
    tombstoneCount: Number(row?.tombstone_count ?? 0),
    lastArchivedAt: row?.last_archived_at ? new Date(row.last_archived_at) : null,
    lastSourceReceivedAt,
    nextPurgeAt: row?.next_purge_at ? new Date(row.next_purge_at) : null,
    archiveLagMs: lastSourceReceivedAt ? Math.max(0, now.getTime() - lastSourceReceivedAt.getTime()) : null,
    archivePendingCount: Number(row?.archive_pending_count ?? 0),
    archiveFailedCount: Number(row?.archive_failed_count ?? 0),
    lastArchiveError: row?.last_archive_error ?? null,
  };
}
