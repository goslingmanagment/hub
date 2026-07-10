import { and, eq, lt, sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import { dmMessageArchive } from "../schema.ts";
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

// ── Amendment-3 merge fragments (fast-reply freshness PR4) ─────────────────
// a = the existing dm_message_archive row; excluded = the incoming values.
// P = tombstone-stub hydration predicate; W = webhook may replace
// webhook-owned material (once REST advanced the row, webhook is fill-only
// + monotone until Wave 2's platform-change ordering).

const A = {
  conversationId: sql.raw(`"dm_message_archive"."platform_conversation_id"`),
  fanId: sql.raw(`"dm_message_archive"."fan_platform_user_id"`),
  senderId: sql.raw(`"dm_message_archive"."sender_platform_user_id"`),
  senderRole: sql.raw(`"dm_message_archive"."sender_role"`),
  isSentByMe: sql.raw(`"dm_message_archive"."is_sent_by_me"`),
  createdAt: sql.raw(`"dm_message_archive"."message_created_at"`),
  text: sql.raw(`"dm_message_archive"."text_plain"`),
  price: sql.raw(`"dm_message_archive"."price_mills"`),
  isOpened: sql.raw(`"dm_message_archive"."is_opened"`),
  isTip: sql.raw(`"dm_message_archive"."is_tip"`),
  tipAmount: sql.raw(`"dm_message_archive"."tip_amount_mills"`),
  replyTo: sql.raw(`"dm_message_archive"."in_reply_to_message_id"`),
  media: sql.raw(`"dm_message_archive"."media_metadata"`),
  deletedAt: sql.raw(`"dm_message_archive"."deleted_at"`),
  restObsId: sql.raw(`"dm_message_archive"."rest_material_observation_id"`),
  sourceReceivedAt: sql.raw(`"dm_message_archive"."source_received_at"`),
};

const X = {
  conversationId: sql.raw(`excluded."platform_conversation_id"`),
  fanId: sql.raw(`excluded."fan_platform_user_id"`),
  senderId: sql.raw(`excluded."sender_platform_user_id"`),
  senderRole: sql.raw(`excluded."sender_role"`),
  isSentByMe: sql.raw(`excluded."is_sent_by_me"`),
  createdAt: sql.raw(`excluded."message_created_at"`),
  text: sql.raw(`excluded."text_plain"`),
  price: sql.raw(`excluded."price_mills"`),
  isOpened: sql.raw(`excluded."is_opened"`),
  isTip: sql.raw(`excluded."is_tip"`),
  tipAmount: sql.raw(`excluded."tip_amount_mills"`),
  replyTo: sql.raw(`excluded."in_reply_to_message_id"`),
  media: sql.raw(`excluded."media_metadata"`),
  sourceReceivedAt: sql.raw(`excluded."source_received_at"`),
};

/** P := the existing row is a tombstone stub awaiting hydration. */
const P_STUB: SQL = sql`(${A.createdAt} is null)`;

/** W := P OR (REST has not advanced the row AND the incoming webhook fact is
 * not older than the last one applied). Clock-domain skew between Postgres
 * now() and Node new Date() in the >= is accepted and recorded (v8). */
const W_WEBHOOK: SQL = sql`(${P_STUB} or (${A.restObsId} is null and ${X.sourceReceivedAt} >= ${A.sourceReceivedAt}))`;

/** advance_opened: TRUE if either TRUE; else FALSE if either FALSE; else NULL. */
function advanceOpened(oldValue: SQL, incoming: SQL): SQL {
  return sql`(case
    when ${oldValue} is true or ${incoming} is true then true
    when ${oldValue} is false or ${incoming} is false then false
    else null
  end)`;
}

/** media_metadata compare normalization: object keys already compare
 * canonically in jsonb, but ARRAY ORDER is significant — sort items by id
 * on both sides before the distinctness check (v8 SQL nits). */
function sortedMedia(expr: SQL): SQL {
  return sql`(select coalesce(jsonb_agg(elem order by elem->>'id'), '[]'::jsonb)
    from jsonb_array_elements(${expr}) elem)`;
}

/** The 13-field material tuple (M3) as next-value expressions vs current —
 * the change guard: no material change → NO row write (provenance and
 * updated_at live outside the tuple and only apply inside the guard). */
function materialChangeGuard(next: {
  senderId: SQL;
  senderRole: SQL;
  isSentByMe: SQL;
  createdAt: SQL;
  text: SQL;
  price: SQL;
  isOpened: SQL;
  isTip: SQL;
  tipAmount: SQL;
  replyTo: SQL;
  conversationId: SQL;
  fanId: SQL;
  media: SQL;
}): SQL {
  return sql`row(
      ${next.senderId}, ${next.senderRole}, ${next.isSentByMe}, ${next.createdAt},
      ${next.text}, ${next.price}, ${next.isOpened}, ${next.isTip},
      ${next.tipAmount}, ${next.replyTo}, ${next.conversationId}, ${next.fanId},
      ${sortedMedia(next.media)}
    ) is distinct from row(
      ${A.senderId}, ${A.senderRole}, ${A.isSentByMe}, ${A.createdAt},
      ${A.text}, ${A.price}, ${A.isOpened}, ${A.isTip},
      ${A.tipAmount}, ${A.replyTo}, ${A.conversationId}, ${A.fanId},
      ${sortedMedia(A.media)}
    )`;
}

function preferIncomingWhen(condition: SQL, incoming: SQL, oldValue: SQL): SQL {
  return sql`(case when ${condition} then coalesce(${incoming}, ${oldValue}) else coalesce(${oldValue}, ${incoming}) end)`;
}

function earliest(...dates: Array<Date | null | undefined>): Date {
  const known = dates.filter((value): value is Date => value != null);
  return known.reduce((min, value) => (value < min ? value : min));
}

/**
 * Webhook material writer, amendment-3 shapes (v8 C2: the main body's
 * "fill-absent dumb merge" is SUPERSEDED history, not a fallback). deleted_at
 * and rest_* are untouched; provenance (source_*) applies only inside the
 * material-change guard. Erasure-fenced and lock-deferred writes never touch
 * the table.
 */
export async function upsertDmMessageArchive(
  db: Database,
  input: UpsertDmMessageArchiveInput,
): Promise<DmMessageArchiveWriteResult> {
  const now = new Date();
  const mediaMetadata = input.mediaMetadata as unknown as Array<Record<string, unknown>>;

  const next = {
    conversationId: preferIncomingWhen(W_WEBHOOK, X.conversationId, A.conversationId),
    fanId: preferIncomingWhen(W_WEBHOOK, X.fanId, A.fanId),
    senderId: preferIncomingWhen(W_WEBHOOK, X.senderId, A.senderId),
    createdAt: preferIncomingWhen(W_WEBHOOK, X.createdAt, A.createdAt),
    replyTo: preferIncomingWhen(W_WEBHOOK, X.replyTo, A.replyTo),
    price: preferIncomingWhen(W_WEBHOOK, X.price, A.price),
    senderRole: sql`(case
      when ${W_WEBHOOK} then ${X.senderRole}
      when ${A.senderRole} = 'unknown' then ${X.senderRole}
      else ${A.senderRole}
    end)`,
    isSentByMe: sql`(case when ${P_STUB} then ${X.isSentByMe} else ${A.isSentByMe} end)`,
    text: sql`(case
      when ${W_WEBHOOK} and ${X.text} <> '' then ${X.text}
      when ${A.text} = '' and ${X.text} <> '' then ${X.text}
      else ${A.text}
    end)`,
    media: sql`(case
      when ${W_WEBHOOK} and ${X.media} <> '[]'::jsonb then ${X.media}
      when ${A.media} = '[]'::jsonb and ${X.media} <> '[]'::jsonb then ${X.media}
      else ${A.media}
    end)`,
    isOpened: advanceOpened(A.isOpened, X.isOpened),
    isTip: sql`(${A.isTip} or ${X.isTip})`,
    tipAmount: sql`greatest(${A.tipAmount}, ${X.tipAmount})`,
  };

  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    if (!(await tryAcquireDmArchiveWriterFenceLock(database, input.platformAccountId))) {
      return { status: "deferred" as const };
    }
    if (
      await isDmArchiveScopeFenced(database, {
        pageId: input.platformAccountId,
        refs: [input.fanPlatformUserId, input.platformConversationId, input.senderPlatformUserId],
        materialAt: earliest(input.messageCreatedAt, input.sourceReceivedAt),
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
          platformConversationId: next.conversationId,
          fanPlatformUserId: next.fanId,
          senderPlatformUserId: next.senderId,
          senderRole: next.senderRole,
          isSentByMe: next.isSentByMe,
          messageCreatedAt: next.createdAt,
          textPlain: next.text,
          priceMills: next.price,
          isOpened: next.isOpened,
          isTip: next.isTip,
          tipAmountMills: next.tipAmount,
          inReplyToMessageId: next.replyTo,
          mediaMetadata: next.media,
          // Provenance — applies only when the guard admits a material change.
          source: input.source,
          sourceEventType: input.sourceEventType,
          sourceIdempotencyKey: input.sourceIdempotencyKey,
          sourceJournalId: input.sourceJournalId,
          sourceFanoutSeq: input.sourceFanoutSeq ?? null,
          sourceReceivedAt: input.sourceReceivedAt,
          rawShapeVersion: input.rawShapeVersion,
          retentionPolicy: input.retentionPolicy,
          retainUntil: input.retainUntil,
          updatedAt: now,
        },
        setWhere: materialChangeGuard(next),
      })
      .returning();

    // No-row RETURNING under the guard = a true material NO-OP, not a failure.
    return row ? { status: "written" as const, row } : { status: "noop" as const };
  });
}

/**
 * Tombstone writer. deleted_at is sticky (first deletion time wins) and a
 * repeat delivery is a guarded NO-OP: WHERE deleted_at IS NULL stops the
 * provenance rewrite AND the retain_until refresh on every repeat (intended
 * — v8 SQL nits). Delete webhooks carry no fan/conversation refs, so a
 * fan-scope erasure cannot fence a stub by ref: the post-erasure stub is the
 * DOCUMENTED CONTENTLESS SURVIVOR (message id only, no content) — the
 * waiver stands only WITH the page-scope fence below.
 */
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
        setWhere: sql`${A.deletedAt} is null`,
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
  retentionPolicy: string;
  retainUntil: Date;
}

/**
 * REST readthrough writer (amendment 3 + v7.1 + M7). INSERT arm: a row the
 * webhook lane missed — source='rest_reconcile', source_journal_id NULL
 * (never fake journal ids), idempotency key "readthrough:<obsId>:<msgId>".
 * UPDATE arm: fill-absent + sentinel-aware (the exact tombstone-stub shape,
 * so REST completing a stub falls out free) + is_opened monotone advance;
 * NEVER touches source_* columns or deleted_at; rest_material_* provenance
 * applies only inside the material-change guard (a chat-open replaying 100
 * known messages rewrites 0 rows).
 */
export async function upsertDmMessageArchiveFromReadthrough(
  db: Database,
  input: UpsertDmMessageArchiveFromReadthroughInput,
): Promise<DmMessageArchiveWriteResult> {
  const now = new Date();
  const mediaMetadata = input.mediaMetadata as unknown as Array<Record<string, unknown>>;

  const next = {
    // ids / createdAt / price / reply / scope refs: COALESCE(old, incoming).
    conversationId: sql`coalesce(${A.conversationId}, ${X.conversationId})`,
    fanId: sql`coalesce(${A.fanId}, ${X.fanId})`,
    senderId: sql`coalesce(${A.senderId}, ${X.senderId})`,
    createdAt: sql`coalesce(${A.createdAt}, ${X.createdAt})`,
    price: sql`coalesce(${A.price}, ${X.price})`,
    replyTo: sql`coalesce(${A.replyTo}, ${X.replyTo})`,
    senderRole: sql`(case when ${A.senderRole} = 'unknown' then ${X.senderRole} else ${A.senderRole} end)`,
    isSentByMe: sql`(case when ${P_STUB} then ${X.isSentByMe} else ${A.isSentByMe} end)`,
    text: sql`(case when ${A.text} = '' and ${X.text} <> '' then ${X.text} else ${A.text} end)`,
    media: sql`(case
      when ${A.media} = '[]'::jsonb and ${X.media} <> '[]'::jsonb then ${X.media}
      else ${A.media}
    end)`,
    isOpened: advanceOpened(A.isOpened, X.isOpened),
    isTip: sql`(${A.isTip} or ${X.isTip})`,
    tipAmount: sql`greatest(${A.tipAmount}, ${X.tipAmount})`,
  };

  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    if (!(await tryAcquireDmArchiveWriterFenceLock(database, input.platformAccountId))) {
      return { status: "deferred" as const };
    }
    if (
      await isDmArchiveScopeFenced(database, {
        pageId: input.platformAccountId,
        refs: [input.fanPlatformUserId, input.platformConversationId, input.senderPlatformUserId],
        materialAt: earliest(input.messageCreatedAt, input.observationReceivedAt),
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
        source: "rest_reconcile",
        sourceEventType: input.isSentByMe ? "messages.sent" : "messages.received",
        sourceIdempotencyKey: `readthrough:${input.observationId}:${input.platformMessageId}`,
        sourceJournalId: null,
        sourceFanoutSeq: null,
        sourceReceivedAt: input.observationReceivedAt,
        rawShapeVersion: "ofapi-message-v1",
        mediaMetadata,
        retentionPolicy: input.retentionPolicy,
        retainUntil: input.retainUntil,
        restMaterialObservationId: input.observationId,
        restMaterialObservedAt: input.observationReceivedAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          dmMessageArchive.platform,
          dmMessageArchive.ofapiAccountId,
          dmMessageArchive.platformMessageId,
        ],
        set: {
          platformConversationId: next.conversationId,
          fanPlatformUserId: next.fanId,
          senderPlatformUserId: next.senderId,
          senderRole: next.senderRole,
          isSentByMe: next.isSentByMe,
          messageCreatedAt: next.createdAt,
          textPlain: next.text,
          priceMills: next.price,
          isOpened: next.isOpened,
          isTip: next.isTip,
          tipAmountMills: next.tipAmount,
          inReplyToMessageId: next.replyTo,
          mediaMetadata: next.media,
          // REST provenance only — the UPDATE arm never touches source_*.
          restMaterialObservationId: input.observationId,
          restMaterialObservedAt: input.observationReceivedAt,
          updatedAt: now,
        },
        setWhere: materialChangeGuard(next),
      })
      .returning();

    return row ? { status: "written" as const, row } : { status: "noop" as const };
  });
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
