import { and, eq, lt, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { dmMessageArchive } from "../schema.ts";
import { reduceDmMessageCandidate } from "./dm-message-candidate.ts";
import {
  isDmArchiveScopeFenced,
  tryAcquireDmArchiveWriterFenceLock,
} from "./erasure-fence.ts";

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

export type DmMessageArchiveWriteStatus =
  /** An erasure holds the exclusive fence lock — write deferred, caller
   * leaves its journal row/observation retryable (sweep retries). */
  | "deferred"
  /** An executed erasure covers this material (material-time-bounded) —
   * terminal skip; the caller stamps its journal row 'erasure_fenced'. */
  | "fenced"
  /** The row was inserted or materially updated. */
  | "written"
  /** The conflict-update guard matched nothing — true material no-op. */
  | "noop";

export interface DmMessageArchiveWriteResult {
  status: DmMessageArchiveWriteStatus;
  row?: typeof dmMessageArchive.$inferSelect;
}

// ── Wave 2: candidates replace the Wave-1 SQL merges ───────────────────────
// The amendment-3 per-field precedence lives in ONE place now — the candidate
// reducer (dm-message-candidate.ts, "no competing writers", v7 amendment 8).
// These writers keep their Wave-1 signatures and adapt inputs into
// MessageFactCandidate; the erasure fence and all merge/no-op semantics are
// enforced inside the reducer.

function earliest(...dates: Array<Date | null | undefined>): Date {
  const known = dates.filter((value): value is Date => value != null);
  return known.reduce((min, value) => (value < min ? value : min));
}

/**
 * Webhook material writer (Wave-2 candidate adapter). A late/retried webhook
 * is fill-only once REST advanced the row (W predicate, inside the reducer);
 * deleted_at and rest_* are never touched by webhook candidates.
 */
export async function upsertDmMessageArchive(
  db: Database,
  input: UpsertDmMessageArchiveInput,
): Promise<DmMessageArchiveWriteResult> {
  const result = await reduceDmMessageCandidate(db, {
    source: "webhook",
    platform: input.platform,
    platformAccountId: input.platformAccountId,
    ofapiAccountId: input.ofapiAccountId,
    platformMessageId: input.platformMessageId,
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
    mediaMetadata: input.mediaMetadata,
    sourceEventType: input.sourceEventType,
    sourceIdempotencyKey: input.sourceIdempotencyKey,
    sourceJournalId: input.sourceJournalId,
    sourceFanoutSeq: input.sourceFanoutSeq ?? null,
    sourceReceivedAt: input.sourceReceivedAt,
    rawShapeVersion: input.rawShapeVersion,
    retentionPolicy: input.retentionPolicy,
    retainUntil: input.retainUntil,
  });
  return { status: result.status, ...(result.row ? { row: result.row } : {}) };
}

export async function tombstoneDmMessageArchive(
  db: Database,
  input: TombstoneDmMessageArchiveInput,
): Promise<DmMessageArchiveWriteResult> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    if (!(await tryAcquireDmArchiveWriterFenceLock(database, input.platformAccountId))) {
      return { status: "deferred" as const };
    }
    if (
      await isDmArchiveScopeFenced(database, {
        pageId: input.platformAccountId,
        refs: [],
        materialAt: earliest(input.deletedAt, input.sourceReceivedAt),
      })
    ) {
      return { status: "fenced" as const };
    }

    const [row] = await database
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
        setWhere: sql`${dmMessageArchive.deletedAt} is null`,
      })
      .returning();

    return row ? { status: "written" as const, row } : { status: "noop" as const };
  });
}

export interface UpsertDmMessageArchiveFromReadthroughInput {
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
  mediaMetadata: DmMessageArchiveMediaItem[];
  /** The v2 readthrough observation this material came from. */
  observationId: number;
  /** The observation's received_at — becomes source_received_at on INSERT and
   * rest_material_observed_at (observation time, NOT platform edit time). */
  observationReceivedAt: Date;
  /** The platform's own edit time (REST changedAt) — Wave-2 ordering input,
   * stored as rest_platform_changed_at, never mixed with observation time. */
  platformChangedAt?: Date | null;
  retentionPolicy: string;
  retainUntil: Date;
}

/**
 * REST readthrough writer (Wave-2 candidate adapter; M7 INSERT columns).
 * Fill-absent + sentinel-aware + is_opened monotone via the reducer's
 * precedence table; the UPDATE arm never touches source_* or deleted_at.
 */
export async function upsertDmMessageArchiveFromReadthrough(
  db: Database,
  input: UpsertDmMessageArchiveFromReadthroughInput,
): Promise<DmMessageArchiveWriteResult> {
  const result = await reduceDmMessageCandidate(db, {
    source: "rest_reconcile",
    platform: input.platform,
    platformAccountId: input.platformAccountId,
    ofapiAccountId: input.ofapiAccountId,
    platformMessageId: input.platformMessageId,
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
    mediaMetadata: input.mediaMetadata,
    sourceEventType: input.isSentByMe ? "messages.sent" : "messages.received",
    sourceIdempotencyKey: `readthrough:${input.observationId}:${input.platformMessageId}`,
    sourceJournalId: null,
    sourceReceivedAt: input.observationReceivedAt,
    restMaterialObservationId: input.observationId,
    restPlatformChangedAt: input.platformChangedAt ?? null,
    retentionPolicy: input.retentionPolicy,
    retainUntil: input.retainUntil,
  });
  return { status: result.status, ...(result.row ? { row: result.row } : {}) };
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
