import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  dmMessageArchive,
  domainEvents,
  pageDmMessages,
  pageDmThreads,
  pages,
  ofapiWebhookEvents,
  observations,
} from "../schema.ts";
import { getOfapiFanoutReplayState } from "./ofapi.ts";

/** One definition for both the v1 fanout and v2 domain-event recovery
 * barriers. If an OFAPI event covered by the durable state snapshot is not
 * proven present there, either cursor protocol must leave it replayable. */
function ofapiSnapshotReplayRequired() {
  return sql`(
    (
      ${ofapiWebhookEvents.eventType} in ('messages.received', 'messages.sent')
      and not (
        ${ofapiWebhookEvents.projectionStatus} = 'projected'
        and ${ofapiWebhookEvents.archiveStatus} in ('archived', 'skipped')
      )
    )
    or (
      ${ofapiWebhookEvents.eventType} = 'messages.deleted'
      and not (
        ${ofapiWebhookEvents.projectionStatus} in ('projected', 'skipped')
        and ${ofapiWebhookEvents.archiveStatus} = 'archived'
      )
    )
    or ${ofapiWebhookEvents.eventType} in ('messages.ppv.unlocked', 'tips.received')
    or ${ofapiWebhookEvents.eventType} in ('subscriptions.new', 'subscriptions.renewed')
    or ${ofapiWebhookEvents.eventType} like 'accounts.%'
  )`;
}

export interface OfapiSyncSnapshotCursorWindow {
  /** Highest fanout sequence on a committed journal row. Unlike sequence
   * last_value, this cannot expose nextval() from an uncommitted settle. */
  latestCommittedSeq: number;
  /** First assigned-page event after the caller's cursor that is not yet
   * represented by snapshot state and therefore must remain SSE-replayable. */
  earliestReplayRequiredSeq: number | null;
  safeSnapshotCursor: number;
}

/**
 * Computes the greatest cursor that a state snapshot may safely checkpoint.
 *
 * The event journal assigns fanout_seq in the settle transaction, before the
 * best-effort snapshot projections run. A snapshot that used the raw sequence
 * high-water could therefore checkpoint an event that was in neither the
 * projected state nor the subsequent `fanout_seq > cursor` replay. Keep the
 * cursor immediately before the first such assigned-page event.
 *
 * Only domains represented by this snapshot participate in the barrier:
 * - message creates/sends need a projected hot row/thread and a terminal cold
 *   archive attempt;
 * - deletes need a durable archive tombstone and a terminal hot-store attempt;
 * - PPV/tip annotations remain replay-required even after hot projection,
 *   because the snapshot's archive-wins merge has no completion marker proving
 *   the cold row carries the later annotation;
 * - subscriptions.new/renewed remain replay-required because the v1 path maps
 *   both to Desktop's awaited chat-head refresh, an effect the state snapshot
 *   does not materialize. v2 maps only new today; renewed is conservatively
 *   over-barriered so the shared proof remains correct for both protocols;
 * - accounts.* has no durable projection marker, so it always remains
 *   replay-required. This also keeps account auth safe when account-health
 *   projection is disabled.
 *
 * Presence, typing, and other uncovered event types never pin this cursor. The
 * response explicitly omits ephemeral domains, while the other uncovered
 * events continue through their ordinary paths.
 */
export async function getOfapiSyncSnapshotCursorWindow(
  db: Database,
  input: {
    assignedPageIds: number[];
    afterSeq: number;
  },
): Promise<OfapiSyncSnapshotCursorWindow> {
  // Read the committed high-water first, then the transactional cleanup floor.
  // If a new row commits between these reads and the barrier query, that query
  // either exposes it as a barrier (making
  // seq - 1 safe) or we conservatively keep the older committed high-water.
  // Reversing the order would permit a non-blocking event to raise the high-
  // water after the barrier query and skip a concurrently committed blocker.
  // This proof also depends on OFAPI_EVENT_WORKER_REPLICAS=1 plus the worker's
  // journal-ordered batch: a later fanout sequence cannot commit while an
  // earlier assigned sequence is still invisible. Stage 25 (multi-worker)
  // must introduce a transactionally committed contiguous watermark before
  // relaxing that invariant; sequence last_value or max(committed) is not one.
  const [latest] = await db
    .select({
      fanoutSeq: ofapiWebhookEvents.fanoutSeq,
    })
    .from(ofapiWebhookEvents)
    .where(isNotNull(ofapiWebhookEvents.fanoutSeq))
    .orderBy(desc(ofapiWebhookEvents.fanoutSeq))
    .limit(1);
  const replayState = await getOfapiFanoutReplayState(db);
  const replayFloor = replayState.replayFloor;

  const [barrier] = input.assignedPageIds.length === 0
    ? []
    : await db
      .select({ fanoutSeq: ofapiWebhookEvents.fanoutSeq })
      .from(ofapiWebhookEvents)
      .where(and(
        isNotNull(ofapiWebhookEvents.fanoutSeq),
        gt(ofapiWebhookEvents.fanoutSeq, input.afterSeq),
        inArray(ofapiWebhookEvents.platformAccountId, input.assignedPageIds),
        ofapiSnapshotReplayRequired(),
      ))
      .orderBy(asc(ofapiWebhookEvents.fanoutSeq))
      .limit(1);

  const latestCommittedSeq = Math.max(
    replayFloor,
    replayState.legacyHighWater,
    latest?.fanoutSeq == null ? 0 : Number(latest.fanoutSeq),
  );
  const earliestReplayRequiredSeq = barrier?.fanoutSeq == null
    ? null
    : Number(barrier.fanoutSeq);
  // The caller's afterSeq is never a source of truth. In particular, raising
  // this value to afterSeq would let an arbitrary query manufacture a cursor
  // beyond both committed fanout and the first replay barrier.
  const safeSnapshotCursor = earliestReplayRequiredSeq === null
    ? latestCommittedSeq
    : Math.min(latestCommittedSeq, earliestReplayRequiredSeq - 1);
  if (safeSnapshotCursor < replayFloor) {
    throw new Error(
      `OFAPI replay floor ${replayFloor} advanced past retained snapshot barrier ${earliestReplayRequiredSeq}`,
    );
  }

  return {
    latestCommittedSeq,
    earliestReplayRequiredSeq,
    safeSnapshotCursor,
  };
}

export interface OfapiStateSafeDomainEventWatermark {
  /** Platform-native account ref used by Desktop's state snapshot endpoint.
   * Null for non-OFAPI pages. Read in the same statement snapshot as safeSeq. */
  accountRef: string | null;
  /** Authoritative committed account high-water from domain_event_seq. */
  currentSeq: number;
  /** Earliest retained v2 event that the OFAPI state snapshot cannot yet
   * replace. Null means the cursor may start at currentSeq. */
  earliestReplayRequiredSeq: number | null;
  /** Cursor watermark encoded by /events/v2/snapshot. */
  safeSeq: number;
}

/**
 * Returns v2 cursor watermarks that are safe to install only after the caller
 * has walked the OFAPI durable-state snapshot.
 *
 * OFAPI webhook receipt writes the event journal row and its observation in
 * one transaction. Canonicalization may append the observation's domain event
 * before the independent OFAPI worker settles, projects, and archives that
 * same journal row. Joining domain_events.observation_id to the exact
 * `ofapi:webhook` observation and then its shared idempotency key lets us keep
 * the domain event in the v2 replay tail until the same completion predicate
 * used by the v1 cursor proves it replaceable by snapshot state.
 *
 * The head and barrier are read in one PostgreSQL statement snapshot. A later
 * domain-event commit is therefore strictly after safeSeq and will replay. A
 * later projection/archive completion can only make this conservative cursor
 * unnecessarily low, never unsafe.
 *
 * Non-OFAPI observations and snapshot-uncovered OFAPI families deliberately do
 * not participate. Subscription notifications are a deliberate behavioral
 * exception: replay must run Desktop's chat-head refresh because no snapshot
 * row replaces that effect. The shared predicate conservatively includes
 * renewed for v2 even though only subscription.started is mapped there today,
 * because renewed is state-affecting on v1. The barrier row itself is retained
 * in domain_events, so safeSeq = barrier - 1 is never below the v2 replay floor
 * (oldestRetainedSeq - 1).
 */
export async function listOfapiStateSafeDomainEventWatermarks(
  db: Database,
  accountIds: readonly number[],
): Promise<Map<number, OfapiStateSafeDomainEventWatermark>> {
  const watermarks = new Map<number, OfapiStateSafeDomainEventWatermark>();
  if (accountIds.length === 0) {
    return watermarks;
  }

  const requestedRows = sql.join(
    accountIds.map((accountId) => sql`(${accountId}::bigint)`),
    sql`, `,
  );
  const result = await db.execute<{
    account_id: string | number;
    account_ref: string | null;
    current_seq: string;
    barrier_seq: string | null;
  }>(sql`
    with requested(account_id) as (values ${requestedRows})
    select requested.account_id,
           account_page.ofapi_account_id as account_ref,
           coalesce(seq.next_seq - 1, 0)::text as current_seq,
           barrier.account_seq::text as barrier_seq
    from requested
    left join ${pages} account_page on account_page.id = requested.account_id
    left join domain_event_seq seq on seq.account_id = requested.account_id
    left join lateral (
      select event.account_seq
      from ${domainEvents} event
      join ${observations} observation
        on observation.id = event.observation_id
       and observation.source = 'webhook'
       and observation.producer = 'ofapi:webhook'
       and observation.platform = 'onlyfans'
      join ${ofapiWebhookEvents}
        on ${ofapiWebhookEvents.idempotencyKey} = observation.idempotency_key
       and ${ofapiWebhookEvents.eventType} = observation.kind
      where event.account_id = requested.account_id
        and ${ofapiSnapshotReplayRequired()}
      order by event.account_seq asc
      limit 1
    ) barrier on true
  `);

  for (const row of result.rows) {
    const currentSeq = Number(row.current_seq);
    const earliestReplayRequiredSeq = row.barrier_seq === null
      ? null
      : Number(row.barrier_seq);
    const safeSeq = earliestReplayRequiredSeq === null
      ? currentSeq
      : Math.max(0, Math.min(currentSeq, earliestReplayRequiredSeq - 1));
    watermarks.set(Number(row.account_id), {
      accountRef: row.account_ref,
      currentSeq,
      earliestReplayRequiredSeq,
      safeSeq,
    });
  }

  return watermarks;
}

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

export interface OfapiSyncSnapshotRowHighWaters {
  maxThreadId: number;
  maxArchiveId: number;
  maxHotMessageId: number;
}

/** Pins the finite row universe for one bounded state walk. */
export async function getOfapiSyncSnapshotRowHighWaters(
  db: Database,
  platformAccountId: number,
): Promise<OfapiSyncSnapshotRowHighWaters> {
  const result = await db.execute<{
    max_thread_id: string;
    max_archive_id: string;
    max_hot_message_id: string;
  }>(sql`
    select
      coalesce((select max(t.id) from ${pageDmThreads} t
        where t.platform_account_id = ${platformAccountId}), 0)::text as max_thread_id,
      coalesce((select max(a.id) from ${dmMessageArchive} a
        where a.platform_account_id = ${platformAccountId}), 0)::text as max_archive_id,
      coalesce((select max(m.id) from ${pageDmMessages} m
        where m.platform_account_id = ${platformAccountId}), 0)::text as max_hot_message_id
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error("OFAPI snapshot high-water query returned no row");
  }
  const highWaters = {
    maxThreadId: Number(row.max_thread_id),
    maxArchiveId: Number(row.max_archive_id),
    maxHotMessageId: Number(row.max_hot_message_id),
  };
  if (Object.values(highWaters).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("OFAPI snapshot row high-water exceeded the safe integer range");
  }
  return highWaters;
}

export interface OfapiSyncSnapshotHotMessage {
  id: number;
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
  id: number;
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
      eq(pages.status, "active"),
    ))
    .limit(1);

  return row?.ofapiAccountId ? { ...row, ofapiAccountId: row.ofapiAccountId } : null;
}

export async function listOfapiSyncSnapshotThreads(
  db: Database,
  input: {
    platformAccountId: number;
    afterThreadId: number;
    maxThreadId?: number;
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
      ...(input.maxThreadId === undefined ? [] : [lte(pageDmThreads.id, input.maxThreadId)]),
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
      id: pageDmMessages.id,
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
      id: dmMessageArchive.id,
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
      id: dmMessageArchive.id,
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

/** One exact thread selected by a server-issued state cursor. */
export async function findOfapiSyncSnapshotThread(
  db: Database,
  input: {
    platformAccountId: number;
    threadId: number;
    maxThreadId?: number;
  },
): Promise<OfapiSyncSnapshotThread | null> {
  const rows = await listOfapiSyncSnapshotThreads(db, {
    platformAccountId: input.platformAccountId,
    afterThreadId: input.threadId - 1,
    ...(input.maxThreadId === undefined ? {} : { maxThreadId: input.maxThreadId }),
    limit: 1,
  });
  const row = rows[0];
  return row?.id === input.threadId ? row : null;
}

/** Keyset page for chat-less delete facts. The legacy query intentionally
 * remains untouched; bounded-v1 uses this row-id cursor so every tombstone is
 * eventually returned without collecting the whole delta in one response. */
export async function listOfapiSyncSnapshotUnresolvedTombstonePage(
  db: Database,
  input: {
    platformAccountId: number;
    afterSeq: number;
    afterArchiveId: number;
    maxArchiveId: number;
    maxHotMessageId: number;
    limit: number;
  },
) {
  return db
    .select({
      id: dmMessageArchive.id,
      platformMessageId: dmMessageArchive.platformMessageId,
      deletedAt: dmMessageArchive.deletedAt,
      sourceFanoutSeq: dmMessageArchive.sourceFanoutSeq,
      sourceReceivedAt: dmMessageArchive.sourceReceivedAt,
      updatedAt: dmMessageArchive.updatedAt,
    })
    .from(dmMessageArchive)
    .where(and(
      eq(dmMessageArchive.platformAccountId, input.platformAccountId),
      gt(dmMessageArchive.id, input.afterArchiveId),
      lte(dmMessageArchive.id, input.maxArchiveId),
      isNull(dmMessageArchive.platformConversationId),
      gt(dmMessageArchive.sourceFanoutSeq, input.afterSeq),
      isNull(dmMessageArchive.messageCreatedAt),
    ))
    .orderBy(asc(dmMessageArchive.id))
    .limit(input.limit);
}

/** Archive is the authoritative overlay when both stores hold a message. The
 * second arm includes every hot row's archive twin even when its fanout seq is
 * older than the requested delta, matching the legacy snapshot merge. */
export async function listOfapiSyncSnapshotArchiveMessagePage(
  db: Database,
  input: {
    platformAccountId: number;
    conversationId: number;
    platformConversationId: string;
    afterSeq: number;
    afterArchiveId: number;
    maxArchiveId: number;
    maxHotMessageId: number;
    limit: number;
  },
): Promise<OfapiSyncSnapshotArchiveMessage[]> {
  const hotTwin = db
    .select({ one: sql<number>`1` })
    .from(pageDmMessages)
    .where(and(
      eq(pageDmMessages.platformAccountId, input.platformAccountId),
      eq(pageDmMessages.conversationId, input.conversationId),
      eq(pageDmMessages.platformMessageId, dmMessageArchive.platformMessageId),
      lte(pageDmMessages.id, input.maxHotMessageId),
      isNull(pageDmMessages.deletedAt),
    ));

  return db
    .select({
      id: dmMessageArchive.id,
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
      eq(dmMessageArchive.platformConversationId, input.platformConversationId),
      gt(dmMessageArchive.id, input.afterArchiveId),
      lte(dmMessageArchive.id, input.maxArchiveId),
      or(
        gt(dmMessageArchive.sourceFanoutSeq, input.afterSeq),
        exists(hotTwin),
      ),
    ))
    .orderBy(asc(dmMessageArchive.id))
    .limit(input.limit);
}

/** Hot rows that have no archive overlay. Returning archive pages first and
 * excluding their twins here reproduces the legacy map's archive-wins rule
 * while ensuring each message appears exactly once across bounded pages. */
export async function listOfapiSyncSnapshotHotMessagePage(
  db: Database,
  input: {
    platformAccountId: number;
    conversationId: number;
    platformConversationId: string;
    afterMessageId: number;
    maxArchiveId: number;
    maxHotMessageId: number;
    limit: number;
  },
): Promise<OfapiSyncSnapshotHotMessage[]> {
  const archiveTwin = db
    .select({ one: sql<number>`1` })
    .from(dmMessageArchive)
    .where(and(
      eq(dmMessageArchive.platformAccountId, input.platformAccountId),
      eq(dmMessageArchive.platformConversationId, input.platformConversationId),
      eq(dmMessageArchive.platformMessageId, pageDmMessages.platformMessageId),
      lte(dmMessageArchive.id, input.maxArchiveId),
    ));

  return db
    .select({
      id: pageDmMessages.id,
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
      eq(pageDmMessages.conversationId, input.conversationId),
      gt(pageDmMessages.id, input.afterMessageId),
      lte(pageDmMessages.id, input.maxHotMessageId),
      isNull(pageDmMessages.deletedAt),
      notExists(archiveTwin),
    ))
    .orderBy(asc(pageDmMessages.id))
    .limit(input.limit);
}
