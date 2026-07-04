import { and, asc, eq, gt, gte, inArray, isNotNull, lt, lte, ne, notInArray, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  ofapiCreditLedger,
  ofapiCreditState,
  ofapiSpendProjectionEvents,
  ofapiWebhookConfig,
  ofapiWebhookEvents,
  pages,
  transactions,
  type OFAPI_CREDIT_LEDGER_SOURCES,
} from "../schema.ts";

const OFAPI_SPEND_TRANSACTION_PAGE_LOCK_NAMESPACE = 9_003_001;

export async function withOfapiSpendTransactionPageLock<T>(
  db: Database,
  pageId: number,
  run: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const dbTx = tx as Database;
    await dbTx.execute(sql`
      select pg_advisory_xact_lock(${OFAPI_SPEND_TRANSACTION_PAGE_LOCK_NAMESPACE}, ${pageId})
    `);
    return run(dbTx);
  });
}

export interface InsertOfapiWebhookEventInput {
  idempotencyKey: string;
  eventType: string;
  ofapiAccountId: string | null;
  payload: Record<string, unknown>;
  // 'pending' marks the row as a DM-projection candidate (picked up post-settle
  // or by the sweep); 'none' (default) for event types that are never projected.
  projectionStatus?: "pending" | "none";
}

/**
 * Journals a webhook delivery. Returns null when the idempotency key was already
 * seen (OFAPI delivers at-least-once; duplicates are acked without a new row).
 */
export async function insertOfapiWebhookEvent(
  db: Database,
  input: InsertOfapiWebhookEventInput,
) {
  const [created] = await db
    .insert(ofapiWebhookEvents)
    .values({
      idempotencyKey: input.idempotencyKey,
      eventType: input.eventType,
      ofapiAccountId: input.ofapiAccountId,
      payload: input.payload,
      projectionStatus: input.projectionStatus ?? "none",
    })
    .onConflictDoNothing({ target: [ofapiWebhookEvents.idempotencyKey] })
    .returning({ id: ofapiWebhookEvents.id });

  return created ?? null;
}

export async function getOfapiWebhookEventById(db: Database, id: number) {
  return await db.query.ofapiWebhookEvents.findFirst({
    where: eq(ofapiWebhookEvents.id, id),
  }) ?? null;
}

export type OfapiWebhookEventStatus = "pending" | "processed" | "skipped" | "failed";

/**
 * Settles a pending journal row. Guarded on status = 'pending' so concurrent
 * processing of the same event (immediate job racing a sweep re-enqueue) settles
 * exactly once; returns false when another worker already settled it. Processed
 * rows get a settle-ordered fanout_seq — the SSE cursor — so events settled late
 * (retries, sweep) still land ahead of every already-advanced Last-Event-ID.
 */
export async function settleOfapiWebhookEvent(
  db: Database,
  input: {
    id: number;
    status: Exclude<OfapiWebhookEventStatus, "pending">;
    platformAccountId?: number | null;
    syncEvent?: Record<string, unknown> | null;
    error?: string | null;
    processedAt: Date;
  },
) {
  const settled = await db
    .update(ofapiWebhookEvents)
    .set({
      status: input.status,
      platformAccountId: input.platformAccountId ?? null,
      syncEvent: input.syncEvent ?? null,
      fanoutSeq: input.status === "processed"
        ? sql`nextval('ofapi_webhook_events_fanout_seq')`
        : null,
      error: input.error ?? null,
      processedAt: input.processedAt,
    })
    .where(and(
      eq(ofapiWebhookEvents.id, input.id),
      eq(ofapiWebhookEvents.status, "pending"),
    ))
    .returning({ id: ofapiWebhookEvents.id });

  return settled.length > 0;
}

export type OfapiEventProjectionStatus = "none" | "pending" | "projected" | "skipped" | "failed";
export type OfapiEventArchiveStatus = "none" | "pending" | "archived" | "skipped" | "failed";

/**
 * Records a DM-projection attempt's outcome. Separate from settle bookkeeping —
 * the projection never touches status/fanout_seq. Guarded so a terminal
 * 'projected'/'skipped' row is never demoted by a racing duplicate attempt
 * (the projection itself is idempotent; this just keeps the journal tidy).
 */
export async function markOfapiWebhookEventProjection(
  db: Database,
  input: {
    id: number;
    status: Exclude<OfapiEventProjectionStatus, "none" | "pending">;
    error?: string | null;
    projectedAt?: Date;
  },
) {
  const updated = await db
    .update(ofapiWebhookEvents)
    .set({
      projectionStatus: input.status,
      projectionError: input.error ?? null,
      projectionAttempts: sql`${ofapiWebhookEvents.projectionAttempts} + 1`,
      projectedAt: input.status === "projected" ? input.projectedAt ?? new Date() : null,
    })
    .where(and(
      eq(ofapiWebhookEvents.id, input.id),
      inArray(ofapiWebhookEvents.projectionStatus, ["pending", "failed"]),
    ))
    .returning({ id: ofapiWebhookEvents.id });

  return updated.length > 0;
}

/**
 * Settled journal rows still awaiting DM projection: 'pending' rows whose
 * immediate post-settle projection was lost (crash, flag flipped on later) and
 * 'failed' rows under the retry cap. Ordered oldest-first; the projection
 * tolerates out-of-order application, so this is just for determinism.
 */
export async function listOfapiWebhookEventsForDmProjection(
  db: Database,
  input: {
    eventTypes: readonly string[];
    maxAttempts: number;
    limit: number;
  },
) {
  if (input.eventTypes.length === 0) {
    return [];
  }

  return db
    .select()
    .from(ofapiWebhookEvents)
    .where(and(
      inArray(ofapiWebhookEvents.eventType, [...input.eventTypes]),
      sql`${ofapiWebhookEvents.status} <> 'pending'`,
      sql`(
        ${ofapiWebhookEvents.projectionStatus} = 'pending'
        or (
          ${ofapiWebhookEvents.projectionStatus} = 'failed'
          and ${ofapiWebhookEvents.projectionAttempts} < ${input.maxAttempts}
        )
      )`,
    ))
    .orderBy(asc(ofapiWebhookEvents.id))
    .limit(input.limit);
}

export async function markOfapiWebhookEventArchivePending(
  db: Database,
  input: {
    id: number;
  },
) {
  const updated = await db
    .update(ofapiWebhookEvents)
    .set({
      archiveStatus: "pending",
      archiveError: null,
    })
    .where(and(
      eq(ofapiWebhookEvents.id, input.id),
      inArray(ofapiWebhookEvents.archiveStatus, ["none", "failed"]),
    ))
    .returning({ id: ofapiWebhookEvents.id });

  return updated.length > 0;
}

export async function markOfapiWebhookEventArchive(
  db: Database,
  input: {
    id: number;
    status: Exclude<OfapiEventArchiveStatus, "none" | "pending">;
    error?: string | null;
    archivedAt?: Date;
  },
) {
  const updated = await db
    .update(ofapiWebhookEvents)
    .set({
      archiveStatus: input.status,
      archiveError: input.error ?? null,
      archiveAttempts: sql`${ofapiWebhookEvents.archiveAttempts} + 1`,
      archivedAt: input.status === "archived" ? input.archivedAt ?? new Date() : null,
    })
    .where(and(
      eq(ofapiWebhookEvents.id, input.id),
      inArray(ofapiWebhookEvents.archiveStatus, ["pending", "failed"]),
    ))
    .returning({ id: ofapiWebhookEvents.id });

  return updated.length > 0;
}

export async function listOfapiWebhookEventsForDmColdArchive(
  db: Database,
  input: {
    eventTypes: readonly string[];
    maxAttempts: number;
    limit: number;
  },
) {
  if (input.eventTypes.length === 0) {
    return [];
  }

  return db
    .select()
    .from(ofapiWebhookEvents)
    .where(and(
      inArray(ofapiWebhookEvents.eventType, [...input.eventTypes]),
      sql`${ofapiWebhookEvents.status} <> 'pending'`,
      sql`(
        ${ofapiWebhookEvents.archiveStatus} = 'pending'
        or (
          ${ofapiWebhookEvents.archiveStatus} = 'failed'
          and ${ofapiWebhookEvents.archiveAttempts} < ${input.maxAttempts}
        )
      )`,
    ))
    .orderBy(asc(ofapiWebhookEvents.id))
    .limit(input.limit);
}

/**
 * Per-page age of the OFAPI DM webhook feed: latest received_at among settled
 * message events. Backs the messages_live sync block for OFAPI-fed OnlyFans
 * pages (webhook ingest freshness instead of executor stream freshness).
 */
export async function getLatestSettledOfapiDmEventTimes(
  db: Database,
  input: {
    pageIds: number[];
    eventTypes: readonly string[];
  },
): Promise<Map<number, Date>> {
  if (input.pageIds.length === 0 || input.eventTypes.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      platformAccountId: ofapiWebhookEvents.platformAccountId,
      lastReceivedAt: sql<Date | string | null>`max(${ofapiWebhookEvents.receivedAt})`,
    })
    .from(ofapiWebhookEvents)
    .where(and(
      inArray(ofapiWebhookEvents.platformAccountId, input.pageIds),
      inArray(ofapiWebhookEvents.eventType, [...input.eventTypes]),
      sql`${ofapiWebhookEvents.status} <> 'pending'`,
    ))
    .groupBy(ofapiWebhookEvents.platformAccountId);

  const result = new Map<number, Date>();
  for (const row of rows) {
    if (row.platformAccountId === null || row.lastReceivedAt === null) {
      continue;
    }
    const parsed = row.lastReceivedAt instanceof Date
      ? row.lastReceivedAt
      : new Date(row.lastReceivedAt);
    if (!Number.isNaN(parsed.getTime())) {
      result.set(row.platformAccountId, parsed);
    }
  }

  return result;
}

export interface OfapiFinancialTruthSummary {
  pageId: number;
  transactionCount: number;
  latestTransactionAt: Date | null;
}

export async function getOfapiFinancialTruthSummaries(
  db: Database,
  input: {
    pageIds: number[];
  },
): Promise<Map<number, OfapiFinancialTruthSummary>> {
  if (input.pageIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      pageId: transactions.platformAccountId,
      transactionCount: sql<number>`count(*)::int`,
      latestTransactionAt: sql<Date | string | null>`
        max(coalesce(${transactions.sourceUpdatedAt}, ${transactions.occurredAt}))
      `,
    })
    .from(transactions)
    .where(and(
      inArray(transactions.platformAccountId, input.pageIds),
      eq(transactions.isActive, true),
      sql`${transactions.rawType} like 'ofapi:%'`,
    ))
    .groupBy(transactions.platformAccountId);

  const result = new Map<number, OfapiFinancialTruthSummary>();
  for (const row of rows) {
    const parsed = row.latestTransactionAt instanceof Date
      ? row.latestTransactionAt
      : row.latestTransactionAt === null
        ? null
        : new Date(row.latestTransactionAt);
    result.set(row.pageId, {
      pageId: row.pageId,
      transactionCount: row.transactionCount,
      latestTransactionAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
    });
  }

  return result;
}

export interface UpsertOfapiSpendProjectionEventInput {
  domainKey: string;
  projectionStatus: "projected" | "blocked" | "skipped";
  blockedReason?: string | null;
  sourceEventType: "transactions.new" | "tips.received" | "messages.ppv.unlocked";
  sourceIdempotencyKey: string;
  journalId: number;
  fanoutSeq?: number | null;
  ofapiAccountId: string;
  pageId: number;
  fanPlatformUserId?: string | null;
  transactionId?: string | null;
  messageId?: string | null;
  occurredAt: Date;
  category?: "message" | "tip" | "subscription" | "post" | "stream" | "other" | null;
  currency?: "USD" | null;
  grossAmountMills?: bigint | null;
  creatorNetAmountMills?: bigint | null;
  eventStatus?: "pending" | "settled" | "reversed" | "estimated" | null;
}

export async function upsertOfapiSpendProjectionEvent(
  db: Database,
  input: UpsertOfapiSpendProjectionEventInput,
) {
  const values = {
    projectionStatus: input.projectionStatus,
    blockedReason: input.blockedReason ?? null,
    sourceEventType: input.sourceEventType,
    sourceIdempotencyKey: input.sourceIdempotencyKey,
    journalId: input.journalId,
    fanoutSeq: input.fanoutSeq ?? null,
    ofapiAccountId: input.ofapiAccountId,
    pageId: input.pageId,
    fanPlatformUserId: input.fanPlatformUserId ?? null,
    transactionId: input.transactionId ?? null,
    messageId: input.messageId ?? null,
    occurredAt: input.occurredAt,
    category: input.category ?? null,
    currency: input.currency ?? null,
    grossAmountMills: input.grossAmountMills ?? null,
    creatorNetAmountMills: input.creatorNetAmountMills ?? null,
    eventStatus: input.eventStatus ?? null,
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(ofapiSpendProjectionEvents)
    .values({
      domainKey: input.domainKey,
      ...values,
    })
    .onConflictDoUpdate({
      target: [ofapiSpendProjectionEvents.domainKey],
      set: values,
    })
    .returning();

  return row;
}

export async function listOfapiSpendProjectionEvents(db: Database) {
  return db
    .select()
    .from(ofapiSpendProjectionEvents)
    .orderBy(asc(ofapiSpendProjectionEvents.id));
}

export async function listOfapiWebhookEventsForSpendProjection(
  db: Database,
  input: {
    eventTypes: readonly string[];
    limit: number;
  },
) {
  if (input.eventTypes.length === 0) {
    return [];
  }

  return db
    .select()
    .from(ofapiWebhookEvents)
    .where(and(
      inArray(ofapiWebhookEvents.eventType, [...input.eventTypes]),
      sql`${ofapiWebhookEvents.status} <> 'pending'`,
      isNotNull(ofapiWebhookEvents.platformAccountId),
      sql`not exists (
        select 1 from ${ofapiSpendProjectionEvents}
        where ${ofapiSpendProjectionEvents.journalId} = ${ofapiWebhookEvents.id}
      )`,
    ))
    .orderBy(asc(ofapiWebhookEvents.id))
    .limit(input.limit);
}

export interface OfapiSpendProjectionTransactionIngestRow {
  id: number;
  pageId: number;
  ofapiAccountId: string;
  fanPlatformUserId: string;
  transactionId: string;
  occurredAt: Date;
  category: "message" | "tip" | "subscription" | "post" | "stream" | "other";
  grossAmountMills: bigint;
  creatorNetAmountMills: bigint;
  eventStatus: "pending" | "settled" | "reversed";
  journalId: number;
}

/**
 * C3 apply candidates. OFAPI currently emits live transactions.new rows with a
 * loading/pending status for real settled spend, and the rest of reporting
 * already includes pending transactions. Pending rows therefore enter truth as
 * pending and are selected again if a later projection transitions to a terminal
 * settled/reversed state.
 */
export async function listMissingOfapiSpendProjectionTransactionsForTruthIngest(
  db: Database,
  input: {
    limit: number;
  },
): Promise<OfapiSpendProjectionTransactionIngestRow[]> {
  const rows = await db
    .select({
      id: ofapiSpendProjectionEvents.id,
      pageId: ofapiSpendProjectionEvents.pageId,
      ofapiAccountId: ofapiSpendProjectionEvents.ofapiAccountId,
      fanPlatformUserId: ofapiSpendProjectionEvents.fanPlatformUserId,
      transactionId: ofapiSpendProjectionEvents.transactionId,
      occurredAt: ofapiSpendProjectionEvents.occurredAt,
      category: ofapiSpendProjectionEvents.category,
      grossAmountMills: ofapiSpendProjectionEvents.grossAmountMills,
      creatorNetAmountMills: ofapiSpendProjectionEvents.creatorNetAmountMills,
      eventStatus: ofapiSpendProjectionEvents.eventStatus,
      journalId: ofapiSpendProjectionEvents.journalId,
    })
    .from(ofapiSpendProjectionEvents)
    .where(and(
      eq(ofapiSpendProjectionEvents.sourceEventType, "transactions.new"),
      eq(ofapiSpendProjectionEvents.projectionStatus, "projected"),
      isNotNull(ofapiSpendProjectionEvents.pageId),
      isNotNull(ofapiSpendProjectionEvents.fanPlatformUserId),
      isNotNull(ofapiSpendProjectionEvents.transactionId),
      isNotNull(ofapiSpendProjectionEvents.grossAmountMills),
      isNotNull(ofapiSpendProjectionEvents.creatorNetAmountMills),
      inArray(ofapiSpendProjectionEvents.category, [
        "message",
        "tip",
        "subscription",
        "post",
        "stream",
        "other",
      ]),
      inArray(ofapiSpendProjectionEvents.eventStatus, ["pending", "settled", "reversed"]),
      sql`not exists (
        select 1 from ${transactions} tx
        where tx.platform_account_id = ${ofapiSpendProjectionEvents.pageId}
          and tx.transaction_id = ${ofapiSpendProjectionEvents.transactionId}
          and tx.sender_id is not distinct from ${ofapiSpendProjectionEvents.fanPlatformUserId}
          and tx.transaction_state::text = (
            case ${ofapiSpendProjectionEvents.eventStatus}
              when 'settled' then 'posted'
              when 'reversed' then 'posted'
              else ${ofapiSpendProjectionEvents.eventStatus}
            end
          )
          and tx.raw_status = ${ofapiSpendProjectionEvents.eventStatus}
          and tx.canonical_type::text = (
            case
              when ${ofapiSpendProjectionEvents.eventStatus} = 'reversed' then 'refund'
              when ${ofapiSpendProjectionEvents.category} = 'message' then 'message_purchase'
              when ${ofapiSpendProjectionEvents.category} = 'tip' then 'tip'
              when ${ofapiSpendProjectionEvents.category} = 'subscription' then 'subscription'
              when ${ofapiSpendProjectionEvents.category} = 'post' then 'post_purchase'
              when ${ofapiSpendProjectionEvents.category} = 'stream' then 'stream_tip'
              else 'other'
            end
          )
          and tx.gross_amount_mills = (
            case
              when ${ofapiSpendProjectionEvents.eventStatus} = 'reversed'
                and ${ofapiSpendProjectionEvents.grossAmountMills} > 0
                then -${ofapiSpendProjectionEvents.grossAmountMills}
              else ${ofapiSpendProjectionEvents.grossAmountMills}
            end
          )
          and tx.source_destination_amount_mills = (
            case
              when ${ofapiSpendProjectionEvents.eventStatus} = 'reversed'
                and ${ofapiSpendProjectionEvents.grossAmountMills} > 0
                then -${ofapiSpendProjectionEvents.grossAmountMills}
              else ${ofapiSpendProjectionEvents.grossAmountMills}
            end
          )
          and tx.creator_net_amount_mills = (
            case
              when ${ofapiSpendProjectionEvents.eventStatus} = 'reversed'
                and ${ofapiSpendProjectionEvents.creatorNetAmountMills} > 0
                then -${ofapiSpendProjectionEvents.creatorNetAmountMills}
              else ${ofapiSpendProjectionEvents.creatorNetAmountMills}
            end
          )
      )`,
    ))
    .orderBy(asc(ofapiSpendProjectionEvents.occurredAt), asc(ofapiSpendProjectionEvents.id))
    .limit(input.limit);

  return rows
    .filter((row): row is typeof row & { pageId: number } => row.pageId !== null)
    .map((row) => ({
      id: row.id,
      pageId: row.pageId,
      ofapiAccountId: row.ofapiAccountId,
      fanPlatformUserId: row.fanPlatformUserId!,
      transactionId: row.transactionId!,
      occurredAt: row.occurredAt,
      category: row.category as OfapiSpendProjectionTransactionIngestRow["category"],
      grossAmountMills: row.grossAmountMills!,
      creatorNetAmountMills: row.creatorNetAmountMills!,
      eventStatus: row.eventStatus as OfapiSpendProjectionTransactionIngestRow["eventStatus"],
      journalId: row.journalId,
    }));
}

export type OfapiSpendProjectionComparisonStatus =
  | "matched"
  | "missing_in_core_truth"
  | "page_mismatch"
  | "amount_mismatch"
  | "fan_mismatch"
  | "state_mismatch"
  | "ppv_estimated"
  | "tips_blocked"
  | "blocked"
  | "skipped"
  | "other";

export interface OfapiSpendProjectionComparisonInput {
  from: Date;
  to: Date;
  sampleLimit: number;
}

export interface OfapiSpendProjectionComparisonStatusRow {
  status: OfapiSpendProjectionComparisonStatus;
  count: number;
  grossAmountMills: bigint;
  creatorNetAmountMills: bigint;
  coreGrossAmountMills: bigint;
  coreCreatorNetAmountMills: bigint;
}

export interface OfapiSpendProjectionComparisonPageRow
  extends OfapiSpendProjectionComparisonStatusRow {
  pageId: number;
  pageLabel: string;
}

export interface OfapiSpendProjectionComparisonSampleRow {
  projectionId: number;
  comparisonStatus: OfapiSpendProjectionComparisonStatus;
  sourceEventType: string;
  projectionStatus: string;
  eventStatus: string | null;
  blockedReason: string | null;
  journalId: number;
  pageId: number;
  pageLabel: string;
  fanPlatformUserId: string | null;
  transactionId: string | null;
  messageId: string | null;
  occurredAt: Date;
  grossAmountMills: bigint | null;
  creatorNetAmountMills: bigint | null;
  coreTransactionPk: number | null;
  corePageId: number | null;
  coreFanPlatformUserId: string | null;
  coreTransactionState: string | null;
  coreOccurredAt: Date | null;
  coreGrossAmountMills: bigint | null;
  coreCreatorNetAmountMills: bigint | null;
}

const OFAPI_SPEND_COMPARISON_STATUS_SQL = sql`
  case
    when p.source_event_type = 'messages.ppv.unlocked'
      and p.projection_status = 'projected'
      then 'ppv_estimated'
    when p.source_event_type = 'tips.received'
      and p.projection_status = 'blocked'
      then 'tips_blocked'
    when p.projection_status = 'blocked'
      then 'blocked'
    when p.projection_status = 'skipped'
      then 'skipped'
    when p.source_event_type = 'transactions.new'
      and p.projection_status = 'projected'
      and t.id is null
      then 'missing_in_core_truth'
    when p.source_event_type = 'transactions.new'
      and p.projection_status = 'projected'
      and t.platform_account_id is distinct from p.page_id
      then 'page_mismatch'
    when p.source_event_type = 'transactions.new'
      and p.projection_status = 'projected'
      and t.sender_id is distinct from p.fan_platform_user_id
      then 'fan_mismatch'
    when p.source_event_type = 'transactions.new'
      and p.projection_status = 'projected'
      and (
        t.gross_amount_mills is distinct from (
          case
            when p.event_status = 'reversed' and p.gross_amount_mills > 0
              then -p.gross_amount_mills
            else p.gross_amount_mills
          end
        )
        or t.creator_net_amount_mills is distinct from (
          case
            when p.event_status = 'reversed' and p.creator_net_amount_mills > 0
              then -p.creator_net_amount_mills
            else p.creator_net_amount_mills
          end
        )
      )
      then 'amount_mismatch'
    when p.source_event_type = 'transactions.new'
      and p.projection_status = 'projected'
      and t.transaction_state::text is distinct from (
        case p.event_status
          when 'settled' then 'posted'
          when 'reversed' then 'posted'
          when 'pending' then 'pending'
          else p.event_status
        end
      )
      then 'state_mismatch'
    when p.source_event_type = 'transactions.new'
      and p.projection_status = 'projected'
      then 'matched'
    else 'other'
  end
`;

function ofapiSpendComparisonBaseSql(input: OfapiSpendProjectionComparisonInput) {
  return sql`
    with compared as (
      select
        p.id as projection_id,
        ${OFAPI_SPEND_COMPARISON_STATUS_SQL}::text as comparison_status,
        p.source_event_type,
        p.projection_status,
        p.event_status,
        p.blocked_reason,
        p.journal_id,
        p.page_id,
        pa.label as page_label,
        p.fan_platform_user_id,
        p.transaction_id,
        p.message_id,
        p.occurred_at,
        p.gross_amount_mills,
        p.creator_net_amount_mills,
        t.id as core_transaction_pk,
        t.platform_account_id as core_page_id,
        t.sender_id as core_fan_platform_user_id,
        t.transaction_state::text as core_transaction_state,
        t.occurred_at as core_occurred_at,
        t.gross_amount_mills as core_gross_amount_mills,
        t.creator_net_amount_mills as core_creator_net_amount_mills
      from ${ofapiSpendProjectionEvents} p
      join ${pages} pa on pa.id = p.page_id
      left join lateral (
        select tx.*
        from ${transactions} tx
        where p.transaction_id is not null
          and tx.transaction_id = p.transaction_id
        order by
          case when tx.platform_account_id = p.page_id then 0 else 1 end,
          tx.id
        limit 1
      ) t on true
      where p.occurred_at >= ${input.from}::timestamptz
        and p.occurred_at < ${input.to}::timestamptz
    )
  `;
}

export async function summarizeOfapiSpendProjectionComparison(
  db: Database,
  input: OfapiSpendProjectionComparisonInput,
): Promise<OfapiSpendProjectionComparisonStatusRow[]> {
  const result = await db.execute(sql`
    ${ofapiSpendComparisonBaseSql(input)}
    select
      comparison_status,
      count(*)::int as count,
      coalesce(sum(gross_amount_mills), 0)::bigint as gross_amount_mills,
      coalesce(sum(creator_net_amount_mills), 0)::bigint as creator_net_amount_mills,
      coalesce(sum(core_gross_amount_mills), 0)::bigint as core_gross_amount_mills,
      coalesce(sum(core_creator_net_amount_mills), 0)::bigint as core_creator_net_amount_mills
    from compared
    group by comparison_status
    order by comparison_status asc
  `);

  return result.rows.map((row) => ({
    status: String(row.comparison_status) as OfapiSpendProjectionComparisonStatus,
    count: Number(row.count),
    grossAmountMills: BigInt(row.gross_amount_mills as bigint | string | number),
    creatorNetAmountMills: BigInt(row.creator_net_amount_mills as bigint | string | number),
    coreGrossAmountMills: BigInt(row.core_gross_amount_mills as bigint | string | number),
    coreCreatorNetAmountMills: BigInt(row.core_creator_net_amount_mills as bigint | string | number),
  }));
}

export async function summarizeOfapiSpendProjectionComparisonByPage(
  db: Database,
  input: OfapiSpendProjectionComparisonInput,
): Promise<OfapiSpendProjectionComparisonPageRow[]> {
  const result = await db.execute(sql`
    ${ofapiSpendComparisonBaseSql(input)}
    select
      page_id,
      page_label,
      comparison_status,
      count(*)::int as count,
      coalesce(sum(gross_amount_mills), 0)::bigint as gross_amount_mills,
      coalesce(sum(creator_net_amount_mills), 0)::bigint as creator_net_amount_mills,
      coalesce(sum(core_gross_amount_mills), 0)::bigint as core_gross_amount_mills,
      coalesce(sum(core_creator_net_amount_mills), 0)::bigint as core_creator_net_amount_mills
    from compared
    group by page_id, page_label, comparison_status
    order by page_label asc, page_id asc, comparison_status asc
  `);

  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    pageLabel: String(row.page_label),
    status: String(row.comparison_status) as OfapiSpendProjectionComparisonStatus,
    count: Number(row.count),
    grossAmountMills: BigInt(row.gross_amount_mills as bigint | string | number),
    creatorNetAmountMills: BigInt(row.creator_net_amount_mills as bigint | string | number),
    coreGrossAmountMills: BigInt(row.core_gross_amount_mills as bigint | string | number),
    coreCreatorNetAmountMills: BigInt(row.core_creator_net_amount_mills as bigint | string | number),
  }));
}

export async function listOfapiSpendProjectionComparisonSamples(
  db: Database,
  input: OfapiSpendProjectionComparisonInput,
): Promise<OfapiSpendProjectionComparisonSampleRow[]> {
  const result = await db.execute(sql`
    ${ofapiSpendComparisonBaseSql(input)}
    select *
    from compared
    where comparison_status <> 'matched'
    order by occurred_at desc, projection_id desc
    limit ${input.sampleLimit}
  `);

  return result.rows.map((row) => ({
    projectionId: Number(row.projection_id),
    comparisonStatus: String(row.comparison_status) as OfapiSpendProjectionComparisonStatus,
    sourceEventType: String(row.source_event_type),
    projectionStatus: String(row.projection_status),
    eventStatus: row.event_status === null ? null : String(row.event_status),
    blockedReason: row.blocked_reason === null ? null : String(row.blocked_reason),
    journalId: Number(row.journal_id),
    pageId: Number(row.page_id),
    pageLabel: String(row.page_label),
    fanPlatformUserId: row.fan_platform_user_id === null ? null : String(row.fan_platform_user_id),
    transactionId: row.transaction_id === null ? null : String(row.transaction_id),
    messageId: row.message_id === null ? null : String(row.message_id),
    occurredAt: row.occurred_at instanceof Date
      ? row.occurred_at
      : new Date(row.occurred_at as string),
    grossAmountMills: row.gross_amount_mills === null
      ? null
      : BigInt(row.gross_amount_mills as bigint | string | number),
    creatorNetAmountMills: row.creator_net_amount_mills === null
      ? null
      : BigInt(row.creator_net_amount_mills as bigint | string | number),
    coreTransactionPk: row.core_transaction_pk === null ? null : Number(row.core_transaction_pk),
    corePageId: row.core_page_id === null ? null : Number(row.core_page_id),
    coreFanPlatformUserId: row.core_fan_platform_user_id === null
      ? null
      : String(row.core_fan_platform_user_id),
    coreTransactionState: row.core_transaction_state === null
      ? null
      : String(row.core_transaction_state),
    coreOccurredAt: row.core_occurred_at === null
      ? null
      : row.core_occurred_at instanceof Date
        ? row.core_occurred_at
        : new Date(row.core_occurred_at as string),
    coreGrossAmountMills: row.core_gross_amount_mills === null
      ? null
      : BigInt(row.core_gross_amount_mills as bigint | string | number),
    coreCreatorNetAmountMills: row.core_creator_net_amount_mills === null
      ? null
      : BigInt(row.core_creator_net_amount_mills as bigint | string | number),
  }));
}

/** Pending rows whose enqueue may have been lost (crash between journal insert and boss.send). */
export async function listPendingOfapiWebhookEventIds(
  db: Database,
  input: {
    receivedBefore: Date;
    limit: number;
  },
) {
  const rows = await db
    .select({ id: ofapiWebhookEvents.id })
    .from(ofapiWebhookEvents)
    .where(and(
      eq(ofapiWebhookEvents.status, "pending"),
      lt(ofapiWebhookEvents.receivedAt, input.receivedBefore),
    ))
    .orderBy(asc(ofapiWebhookEvents.id))
    .limit(input.limit);

  return rows.map((row) => row.id);
}

export interface OfapiSyncEventRow {
  // The settle-ordered fanout sequence — the SSE event id / Last-Event-ID cursor.
  id: number;
  platformAccountId: number;
  syncEvent: Record<string, unknown>;
}

/**
 * Processed frames after a fanout-seq cursor, oldest first. Page-filtered when
 * pageIds is given (SSE replay); unfiltered when omitted (the hub's catch-up after
 * a LISTEN gap — subscribers filter per connection).
 *
 * Rows orphaned by page deletion (null platform_account_id) are excluded in SQL,
 * not post-filtered: callers detect "more rows remain" via rows.length === limit,
 * so a post-fetch filter shrinking a full batch would end pagination early and
 * silently skip the rest of the gap.
 */
export async function listOfapiSyncEventsForReplay(
  db: Database,
  input: {
    afterSeq: number;
    pageIds?: number[];
    limit: number;
  },
): Promise<OfapiSyncEventRow[]> {
  if (input.pageIds && input.pageIds.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      id: ofapiWebhookEvents.fanoutSeq,
      platformAccountId: ofapiWebhookEvents.platformAccountId,
      syncEvent: ofapiWebhookEvents.syncEvent,
    })
    .from(ofapiWebhookEvents)
    .where(and(
      gt(ofapiWebhookEvents.fanoutSeq, input.afterSeq),
      eq(ofapiWebhookEvents.status, "processed"),
      isNotNull(ofapiWebhookEvents.syncEvent),
      isNotNull(ofapiWebhookEvents.platformAccountId),
      ...(input.pageIds
        ? [inArray(ofapiWebhookEvents.platformAccountId, input.pageIds)]
        : []),
    ))
    .orderBy(asc(ofapiWebhookEvents.fanoutSeq))
    .limit(input.limit);

  // Type narrowing only — every condition is already enforced in the WHERE clause.
  return rows.filter(
    (row): row is OfapiSyncEventRow =>
      row.id !== null && row.platformAccountId !== null && row.syncEvent !== null,
  );
}

/** Current high-water fanout seq (0 when nothing has been processed yet). */
export async function getMaxOfapiFanoutSeq(db: Database): Promise<number> {
  const [row] = await db
    .select({ maxSeq: sql<number | null>`max(${ofapiWebhookEvents.fanoutSeq})::bigint` })
    .from(ofapiWebhookEvents);

  return row?.maxSeq === null || row?.maxSeq === undefined ? 0 : Number(row.maxSeq);
}

export interface OfapiFanoutReplayWindow {
  oldestRetainedSeq: number | null;
  latestSeq: number;
}

/**
 * Current durable fanout high-water plus the oldest replayable journal row.
 * The sequence high-water remains valid after every journal row is pruned.
 */
export async function getOfapiFanoutReplayWindow(
  db: Database,
): Promise<OfapiFanoutReplayWindow> {
  const result = await db.execute<{
    oldestRetainedSeq: number | string | bigint | null;
    latestSeq: number | string | bigint | null;
  }>(sql`
    select
      min(fanout_seq)::bigint as "oldestRetainedSeq",
      coalesce((
        select case when is_called then last_value else 0 end
        from ofapi_webhook_events_fanout_seq
      ), 0)::bigint as "latestSeq"
    from ofapi_webhook_events
    where fanout_seq is not null
  `);
  const row = result.rows[0];
  return {
    oldestRetainedSeq: row?.oldestRetainedSeq == null
      ? null
      : Number(row.oldestRetainedSeq),
    latestSeq: row?.latestSeq == null ? 0 : Number(row.latestSeq),
  };
}

export async function deleteExpiredOfapiWebhookEvents(
  db: Database,
  receivedBefore: Date,
) {
  // Stage 1 belt-and-braces guard: a journal row may only be deleted once its
  // projection and archive bookkeeping show it consumed — 'pending'/'failed'
  // rows are never deletable regardless of age ('none' means no consumer wants
  // the row). This permanently closes the "expire before the projection
  // consumes" class even if the retention window is ever shortened again.
  await db
    .delete(ofapiWebhookEvents)
    .where(and(
      lt(ofapiWebhookEvents.receivedAt, receivedBefore),
      notInArray(ofapiWebhookEvents.projectionStatus, ["pending", "failed"]),
      notInArray(ofapiWebhookEvents.archiveStatus, ["pending", "failed"]),
    ));
}

function utcDayOf(now: Date) {
  return now.toISOString().slice(0, 10);
}

/**
 * Records credits spent by an OFAPI REST call plus the response's reported
 * balance. Day spend rolls over at UTC midnight; the increment is atomic so
 * concurrent executor chunks can't lose spend.
 */
export async function recordOfapiCreditUsage(
  db: Database,
  input: {
    creditsUsed: number;
    balance?: number | null;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const day = utcDayOf(now);
  const creditsUsed = Math.max(0, Math.round(input.creditsUsed));
  const balance = typeof input.balance === "number" && Number.isFinite(input.balance)
    ? Math.round(input.balance)
    : null;

  await db.execute(sql`
    insert into ofapi_credit_state (id, spend_day, spent_credits, last_balance, last_balance_at, updated_at)
    values (
      1,
      ${day}::date,
      ${creditsUsed},
      ${balance},
      case when ${balance}::int is null then null else ${now}::timestamptz end,
      ${now}::timestamptz
    )
    on conflict (id) do update set
      spent_credits = case
        when ofapi_credit_state.spend_day = ${day}::date
          then ofapi_credit_state.spent_credits + ${creditsUsed}
        else ${creditsUsed}
      end,
      spend_day = ${day}::date,
      last_balance = coalesce(${balance}::int, ofapi_credit_state.last_balance),
      last_balance_at = case
        when ${balance}::int is null then ofapi_credit_state.last_balance_at
        else ${now}::timestamptz
      end,
      updated_at = ${now}::timestamptz
  `);
}

export type OfapiDayBudgetScope = "global" | "audience";

const OFAPI_DAY_COUNTER_COLUMNS = {
  global: { day: "spend_day", credits: "spent_credits" },
  audience: { day: "audience_spend_day", credits: "audience_spent_credits" },
} as const;

/**
 * Atomically reserves `estimate` credits against the scope's UTC-day counter
 * (audit F9): the budget comparison and the counter increment are one
 * conditional update, so concurrent streams near the cap can never pass the
 * check together and overspend. Returns false when the reservation would
 * exceed `budget`. Callers settle the estimate to the server-reported actuals
 * via settleOfapiDayCreditReservation; a crash in between leaks at most the
 * estimate until the UTC-day rollover (conservative direction).
 */
export async function reserveOfapiDayCredits(
  db: Database,
  input: {
    scope: OfapiDayBudgetScope;
    estimate: number;
    budget: number;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const day = utcDayOf(now);
  const estimate = Math.max(0, Math.round(input.estimate));
  const budget = Math.round(input.budget);
  if (estimate > budget) {
    return false;
  }

  const columns = OFAPI_DAY_COUNTER_COLUMNS[input.scope];
  const dayColumn = sql.raw(columns.day);
  const creditsColumn = sql.raw(columns.credits);
  const reserved = await db.execute(sql`
    insert into ofapi_credit_state (id, ${dayColumn}, ${creditsColumn}, updated_at)
    values (1, ${day}::date, ${estimate}, ${now}::timestamptz)
    on conflict (id) do update set
      ${creditsColumn} = case
        when ofapi_credit_state.${dayColumn} = ${day}::date
          then ofapi_credit_state.${creditsColumn} + ${estimate}
        else ${estimate}
      end,
      ${dayColumn} = ${day}::date,
      updated_at = ${now}::timestamptz
    where (case
        when ofapi_credit_state.${dayColumn} = ${day}::date
          then ofapi_credit_state.${creditsColumn}
        else 0
      end) + ${estimate} <= ${budget}
    returning id
  `);

  return reserved.rows.length > 0;
}

/**
 * Settles a reservation made by reserveOfapiDayCredits to the server-reported
 * actuals: applies `creditsDelta` (actual minus estimate, or minus the whole
 * estimate when the ledger sink already recorded the actuals) to the scope's
 * day counter, clamped at zero — a reservation that straddled the UTC-day
 * rollover settles against the new day. Optionally records the response's
 * balance observation, exactly like recordOfapiCreditUsage.
 */
export async function settleOfapiDayCreditReservation(
  db: Database,
  input: {
    scope: OfapiDayBudgetScope;
    creditsDelta: number;
    balance?: number | null;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const day = utcDayOf(now);
  const delta = Math.round(input.creditsDelta);
  const balance = typeof input.balance === "number" && Number.isFinite(input.balance)
    ? Math.round(input.balance)
    : null;

  const columns = OFAPI_DAY_COUNTER_COLUMNS[input.scope];
  const dayColumn = sql.raw(columns.day);
  const creditsColumn = sql.raw(columns.credits);
  await db.execute(sql`
    insert into ofapi_credit_state (id, ${dayColumn}, ${creditsColumn}, last_balance, last_balance_at, updated_at)
    values (
      1,
      ${day}::date,
      greatest(0, ${delta}),
      ${balance},
      case when ${balance}::int is null then null else ${now}::timestamptz end,
      ${now}::timestamptz
    )
    on conflict (id) do update set
      ${creditsColumn} = greatest(0, case
        when ofapi_credit_state.${dayColumn} = ${day}::date
          then ofapi_credit_state.${creditsColumn} + ${delta}
        else ${delta}
      end),
      ${dayColumn} = ${day}::date,
      last_balance = coalesce(${balance}::int, ofapi_credit_state.last_balance),
      last_balance_at = case
        when ${balance}::int is null then ofapi_credit_state.last_balance_at
        else ${now}::timestamptz
      end,
      updated_at = ${now}::timestamptz
  `);
}

export interface OfapiCreditState {
  spentToday: number;
  // The audience sweep's reservation counter (audit F9) — what its budget
  // guard compares against when the credit ledger is on.
  audienceSpentToday: number;
  lastBalance: number | null;
  lastBalanceAt: Date | null;
}

export async function getOfapiCreditState(
  db: Database,
  now = new Date(),
): Promise<OfapiCreditState> {
  const row = await db.query.ofapiCreditState.findFirst({
    where: eq(ofapiCreditState.id, 1),
  });
  if (!row) {
    return { spentToday: 0, audienceSpentToday: 0, lastBalance: null, lastBalanceAt: null };
  }

  return {
    spentToday: row.spendDay === utcDayOf(now) ? row.spentCredits : 0,
    audienceSpentToday: row.audienceSpendDay === utcDayOf(now) ? row.audienceSpentCredits : 0,
    lastBalance: row.lastBalance,
    lastBalanceAt: row.lastBalanceAt,
  };
}

export type OfapiCreditLedgerSource = (typeof OFAPI_CREDIT_LEDGER_SOURCES)[number];

export type OfapiCreditLedgerRow = typeof ofapiCreditLedger.$inferSelect;

export interface InsertOfapiCreditLedgerEntryInput {
  occurredAt: Date;
  source: OfapiCreditLedgerSource;
  operation?: string | null;
  pageId?: number | null;
  httpStatus?: number | null;
  credits: number;
  estimated?: boolean;
  balanceAfter?: number | null;
  requestId?: string | null;
  accrualDay?: string | null;
  details?: Record<string, unknown> | null;
}

export async function insertOfapiCreditLedgerEntry(
  db: Database,
  input: InsertOfapiCreditLedgerEntryInput,
) {
  const [row] = await db
    .insert(ofapiCreditLedger)
    .values({
      occurredAt: input.occurredAt,
      source: input.source,
      operation: input.operation ?? null,
      pageId: input.pageId ?? null,
      httpStatus: input.httpStatus ?? null,
      credits: Math.round(input.credits),
      estimated: input.estimated ?? false,
      balanceAfter: input.balanceAfter ?? null,
      requestId: input.requestId ?? null,
      accrualDay: input.accrualDay ?? null,
      details: input.details ?? null,
    })
    .returning({ id: ofapiCreditLedger.id });

  return row ?? null;
}

export interface RecordOfapiCreditSpendInput {
  occurredAt?: Date;
  operation: string;
  pageId?: number | null;
  httpStatus?: number | null;
  credits: number;
  estimated?: boolean;
  balanceAfter?: number | null;
  requestId?: string | null;
  details?: Record<string, unknown> | null;
}

/**
 * Records one OFAPI REST response in the credit ledger AND the ofapi_credit_state
 * day counter in a single transaction (D2: the counter stays for fast budget
 * checks but can never disagree with the ledger).
 */
export async function recordOfapiCreditSpend(
  db: Database,
  input: RecordOfapiCreditSpendInput,
) {
  const occurredAt = input.occurredAt ?? new Date();
  await db.transaction(async (tx) => {
    await insertOfapiCreditLedgerEntry(tx, {
      occurredAt,
      source: "rest",
      operation: input.operation,
      pageId: input.pageId ?? null,
      httpStatus: input.httpStatus ?? null,
      credits: input.credits,
      estimated: input.estimated ?? false,
      balanceAfter: input.balanceAfter ?? null,
      requestId: input.requestId ?? null,
      details: input.details ?? null,
    });
    await recordOfapiCreditUsage(tx, {
      creditsUsed: input.credits,
      balance: input.balanceAfter ?? null,
      now: occurredAt,
    });
  });
}

/**
 * Posts the webhook accrual ledger row for one UTC day (D4): idempotent via the
 * partial unique index on accrual_day, so re-running the daily job or the
 * first-enable backfill never double-charges. Returns false when the day was
 * already posted.
 */
export async function upsertOfapiWebhookAccrual(
  db: Database,
  input: {
    accrualDay: string;
    occurredAt: Date;
    credits: number;
    eventCount: number;
  },
) {
  const inserted = await db.execute(sql`
    insert into ofapi_credit_ledger
      (occurred_at, source, operation, credits, estimated, accrual_day, details)
    values (
      ${input.occurredAt}::timestamptz,
      'webhook_accrual',
      'ofapi_webhook_events',
      ${Math.round(input.credits)},
      true,
      ${input.accrualDay}::date,
      ${JSON.stringify({ eventCount: input.eventCount })}::jsonb
    )
    on conflict (accrual_day) where source = 'webhook_accrual' do nothing
    returning id
  `);

  return inserted.rows.length > 0;
}

/** Journaled deliveries received in [from, to) — the webhook accrual basis. */
export async function countOfapiWebhookEventsReceivedBetween(
  db: Database,
  input: { from: Date; to: Date; pageIds?: number[] },
): Promise<number> {
  if (input.pageIds !== undefined && input.pageIds.length === 0) {
    return 0;
  }

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ofapiWebhookEvents)
    .where(and(
      gte(ofapiWebhookEvents.receivedAt, input.from),
      lt(ofapiWebhookEvents.receivedAt, input.to),
      ...(input.pageIds !== undefined
        ? [inArray(ofapiWebhookEvents.platformAccountId, input.pageIds)]
        : []),
    ));

  return row?.count ?? 0;
}

export interface OfapiBalanceObservationRow {
  id: number;
  occurredAt: Date;
  balanceAfter: number;
}

/** Ledger rows carrying a server-reported balance, in insertion order after the cursor. */
export async function listOfapiBalanceObservationsAfter(
  db: Database,
  input: { afterLedgerId: number; limit: number },
): Promise<OfapiBalanceObservationRow[]> {
  const rows = await db
    .select({
      id: ofapiCreditLedger.id,
      occurredAt: ofapiCreditLedger.occurredAt,
      balanceAfter: ofapiCreditLedger.balanceAfter,
    })
    .from(ofapiCreditLedger)
    .where(and(
      isNotNull(ofapiCreditLedger.balanceAfter),
      gt(ofapiCreditLedger.id, input.afterLedgerId),
    ))
    .orderBy(asc(ofapiCreditLedger.id))
    .limit(input.limit);

  return rows.filter((row): row is OfapiBalanceObservationRow => row.balanceAfter !== null);
}

// Sources counted as "spend we already knew about" when decomposing balance
// drift (D5). external/refill rows are reconciliation OUTPUT — their ids land
// after the observations they describe, so summing them here would double-count
// drift into later windows. webhook_accrual is deliberately NOT here (audit
// F8): the daily accrual row posts a whole day's webhook burn at ~00:40 the
// next day, long after the balance observations that already absorbed that
// burn — counting it would first let the intra-day drop reconcile as a
// duplicate `external` row, then make the spanning window emit a compensating
// phantom `refill`. The planner instead estimates un-posted webhook burn per
// observation window from the journal (estimateWebhookCreditsBetween).
const OFAPI_RECONCILE_KNOWN_SOURCES = ["rest", "adjustment"] as const;

/** Sum of known-spend credits over a ledger id window (from exclusive, to inclusive). */
export async function sumOfapiKnownCreditsBetween(
  db: Database,
  input: { fromLedgerIdExclusive: number; toLedgerIdInclusive: number },
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${ofapiCreditLedger.credits}), 0)::int` })
    .from(ofapiCreditLedger)
    .where(and(
      gt(ofapiCreditLedger.id, input.fromLedgerIdExclusive),
      lte(ofapiCreditLedger.id, input.toLedgerIdInclusive),
      inArray(ofapiCreditLedger.source, [...OFAPI_RECONCILE_KNOWN_SOURCES]),
    ));

  return row?.total ?? 0;
}

/**
 * Trailing-window spend across all sources except refills (burn-rate alert).
 * Reconciliation `external` rows describe drift accumulated over a whole
 * observation window but are stamped at the window's closing observation, so
 * a sparse-observation residual (days of drift) would otherwise land in the
 * trailing hour as one lump and trip a false burn alert (audit P-33): rows
 * that carry their window start (details.fromOccurredAt) are pro-rated by the
 * window's overlap with [since, occurredAt].
 */
export interface OfapiSpendWindowStats {
  /** Net credits spent in the window (refills excluded, external drift prorated). */
  total: number;
  /**
   * Earliest EFFECTIVE spend start in the window: for a prorated `external` drift
   * row this is `greatest(fromOccurredAt, since)` — the start of the counted slice
   * — otherwise `occurredAt`. Null when the window holds no spend. Sizes the runway
   * forecast's observed span so it matches how `total` is attributed, instead of
   * anchoring on a drift row's post time (which would understate the span and make
   * the runway too pessimistic).
   */
  earliestEffectiveAt: Date | null;
}

/**
 * Net spend AND the earliest effective spend start over `[from, to)`, computed
 * in one query so the two can never drift. The `external`-drift proration
 * window used by both the sum and the effective-start is defined once
 * (`isProratedExternal`).
 */
export async function summarizeOfapiSpendWindowBetween(
  db: Database,
  input: { from: Date; to: Date },
): Promise<OfapiSpendWindowStats> {
  const fromOccurredAt = sql`(${ofapiCreditLedger.details} ->> 'fromOccurredAt')::timestamptz`;
  const isProratedExternal = sql`${ofapiCreditLedger.source} = 'external'
    and (${ofapiCreditLedger.details} ->> 'fromOccurredAt') is not null
    and ${fromOccurredAt} < ${ofapiCreditLedger.occurredAt}`;
  const [row] = await db
    .select({
      total: sql<number>`coalesce(round(sum(
        case
          when ${isProratedExternal}
          then ${ofapiCreditLedger.credits}::double precision
            * extract(epoch from (${ofapiCreditLedger.occurredAt} - greatest(${fromOccurredAt}, ${input.from})))
            / extract(epoch from (${ofapiCreditLedger.occurredAt} - ${fromOccurredAt}))
          else ${ofapiCreditLedger.credits}
        end
      )), 0)::int`,
      // Raw aggregate: the driver may hand back a timestamptz string, so coerce
      // like getLatestOfapiWebhookEventReceivedAt rather than assuming a Date.
      earliestEffectiveAt: sql<Date | string | null>`min(
        case
          when ${isProratedExternal}
          then greatest(${fromOccurredAt}, ${input.from})
          else ${ofapiCreditLedger.occurredAt}
        end
      )`,
    })
    .from(ofapiCreditLedger)
    .where(and(
      gte(ofapiCreditLedger.occurredAt, input.from),
      lt(ofapiCreditLedger.occurredAt, input.to),
      ne(ofapiCreditLedger.source, "refill"),
    ));

  const rawEarliest = row?.earliestEffectiveAt ?? null;
  const parsed = rawEarliest === null
    ? null
    : rawEarliest instanceof Date ? rawEarliest : new Date(rawEarliest);
  return {
    total: row?.total ?? 0,
    earliestEffectiveAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
  };
}

/**
 * Backwards-compatible unbounded-later helper. New forecast/alerting callers
 * should prefer `summarizeOfapiSpendWindowBetween` and pass their current
 * observation time as `to` so future-dated imports cannot leak into live totals.
 */
export async function summarizeOfapiSpendWindowSince(
  db: Database,
  input: { since: Date },
): Promise<OfapiSpendWindowStats> {
  return summarizeOfapiSpendWindowBetween(db, {
    from: input.since,
    to: new Date("9999-12-31T23:59:59.999Z"),
  });
}

export async function sumOfapiCreditsSpentBetween(
  db: Database,
  input: { from: Date; to: Date },
): Promise<number> {
  const { total } = await summarizeOfapiSpendWindowBetween(db, input);
  return total;
}

export async function sumOfapiCreditsSpentSince(
  db: Database,
  input: { since: Date },
): Promise<number> {
  const { total } = await summarizeOfapiSpendWindowSince(db, input);
  return total;
}

export interface OfapiCreditReconcileState {
  reconciledThroughLedgerId: number | null;
  lastReconcileAt: Date | null;
  lastDriftCredits: number | null;
}

export async function getOfapiCreditReconcileState(
  db: Database,
): Promise<OfapiCreditReconcileState> {
  const row = await db.query.ofapiCreditState.findFirst({
    where: eq(ofapiCreditState.id, 1),
  });

  return {
    reconciledThroughLedgerId: row?.reconciledThroughLedgerId ?? null,
    lastReconcileAt: row?.lastReconcileAt ?? null,
    lastDriftCredits: row?.lastDriftCredits ?? null,
  };
}

/** Advances the reconciliation cursor without touching the spend counter columns. */
export async function setOfapiCreditReconcileCursor(
  db: Database,
  input: {
    reconciledThroughLedgerId: number;
    lastReconcileAt: Date;
    lastDriftCredits: number | null;
  },
) {
  await db.execute(sql`
    insert into ofapi_credit_state
      (id, reconciled_through_ledger_id, last_reconcile_at, last_drift_credits, updated_at)
    values (
      1,
      ${input.reconciledThroughLedgerId},
      ${input.lastReconcileAt}::timestamptz,
      ${input.lastDriftCredits},
      ${input.lastReconcileAt}::timestamptz
    )
    on conflict (id) do update set
      reconciled_through_ledger_id = ${input.reconciledThroughLedgerId},
      last_reconcile_at = ${input.lastReconcileAt}::timestamptz,
      last_drift_credits = ${input.lastDriftCredits},
      updated_at = ${input.lastReconcileAt}::timestamptz
  `);
}

/** Latest UTC day with a posted webhook accrual row, as YYYY-MM-DD (admin/ops). */
export async function getLastOfapiWebhookAccrualDay(db: Database): Promise<string | null> {
  const [row] = await db
    .select({ day: sql<string | null>`max(${ofapiCreditLedger.accrualDay})` })
    .from(ofapiCreditLedger)
    .where(eq(ofapiCreditLedger.source, "webhook_accrual"));

  return row?.day ?? null;
}

/** Positive (spend) credits by source over a time window — the "spent today" card. */
export async function sumOfapiSpendBySourceBetween(
  db: Database,
  input: { from: Date; to: Date },
): Promise<Map<OfapiCreditLedgerSource, number>> {
  const rows = await db
    .select({
      source: ofapiCreditLedger.source,
      credits: sql<number>`sum(${ofapiCreditLedger.credits})::int`,
    })
    .from(ofapiCreditLedger)
    .where(and(
      gte(ofapiCreditLedger.occurredAt, input.from),
      lt(ofapiCreditLedger.occurredAt, input.to),
      gt(ofapiCreditLedger.credits, 0),
    ))
    .groupBy(ofapiCreditLedger.source);

  return new Map(rows.map((row) => [row.source as OfapiCreditLedgerSource, row.credits]));
}

/** Spend attributed to specific REST operations over a window (per-stream budgets). */
export async function sumOfapiRestCreditsForOperationsBetween(
  db: Database,
  input: { operations: readonly string[]; from: Date; to: Date },
): Promise<number> {
  if (input.operations.length === 0) {
    return 0;
  }

  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${ofapiCreditLedger.credits}), 0)::int` })
    .from(ofapiCreditLedger)
    .where(and(
      eq(ofapiCreditLedger.source, "rest"),
      inArray(ofapiCreditLedger.operation, [...input.operations]),
      gte(ofapiCreditLedger.occurredAt, input.from),
      lt(ofapiCreditLedger.occurredAt, input.to),
      gt(ofapiCreditLedger.credits, 0),
    ));

  return row?.total ?? 0;
}

/** Page-scoped positive REST spend for chatter-visible credit summaries. */
export async function sumOfapiRestCreditsForPagesBetween(
  db: Database,
  input: { pageIds: number[]; from: Date; to: Date },
): Promise<number> {
  if (input.pageIds.length === 0) {
    return 0;
  }

  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${ofapiCreditLedger.credits}), 0)::int` })
    .from(ofapiCreditLedger)
    .where(and(
      eq(ofapiCreditLedger.source, "rest"),
      inArray(ofapiCreditLedger.pageId, input.pageIds),
      gte(ofapiCreditLedger.occurredAt, input.from),
      lt(ofapiCreditLedger.occurredAt, input.to),
      gt(ofapiCreditLedger.credits, 0),
    ));

  return row?.total ?? 0;
}

export interface OfapiDailySpendRow {
  day: string;
  source: OfapiCreditLedgerSource;
  credits: number;
}

/** Per-UTC-day positive spend by source (the stacked daily bars). */
export async function listOfapiDailySpendBySource(
  db: Database,
  input: { from: Date; to: Date },
): Promise<OfapiDailySpendRow[]> {
  const result = await db.execute(sql`
    select
      to_char((occurred_at at time zone 'UTC')::date, 'YYYY-MM-DD') as day,
      source,
      sum(credits)::int as credits
    from ofapi_credit_ledger
    where occurred_at >= ${input.from}::timestamptz
      and occurred_at < ${input.to}::timestamptz
      and credits > 0
    group by 1, 2
    order by 1 asc
  `);

  return result.rows.map((row) => ({
    day: String(row.day),
    source: String(row.source) as OfapiCreditLedgerSource,
    credits: Number(row.credits),
  }));
}

export interface OfapiBalancePoint {
  at: Date;
  value: number;
}

/**
 * Balance observations over a window, oldest first (the balance chart). When
 * the window holds more rows than the cap, the NEWEST ones win — every charged
 * REST response is an observation, so a busy month easily exceeds the cap and
 * the chart must not lose its right edge.
 */
export async function listOfapiBalanceSeriesBetween(
  db: Database,
  input: { from: Date; to: Date; limit?: number },
): Promise<OfapiBalancePoint[]> {
  const rows = await db
    .select({
      at: ofapiCreditLedger.occurredAt,
      value: ofapiCreditLedger.balanceAfter,
    })
    .from(ofapiCreditLedger)
    .where(and(
      isNotNull(ofapiCreditLedger.balanceAfter),
      gte(ofapiCreditLedger.occurredAt, input.from),
      lt(ofapiCreditLedger.occurredAt, input.to),
    ))
    .orderBy(sql`${ofapiCreditLedger.occurredAt} desc, ${ofapiCreditLedger.id} desc`)
    .limit(input.limit ?? 2000);

  return rows
    .filter((row): row is OfapiBalancePoint => row.value !== null)
    .reverse();
}

export interface OfapiRefillRow {
  at: Date;
  credits: number;
}

export async function listOfapiRefillsBetween(
  db: Database,
  input: { from: Date; to: Date },
): Promise<OfapiRefillRow[]> {
  const rows = await db
    .select({
      at: ofapiCreditLedger.occurredAt,
      credits: ofapiCreditLedger.credits,
    })
    .from(ofapiCreditLedger)
    .where(and(
      eq(ofapiCreditLedger.source, "refill"),
      gte(ofapiCreditLedger.occurredAt, input.from),
      lt(ofapiCreditLedger.occurredAt, input.to),
    ))
    .orderBy(asc(ofapiCreditLedger.occurredAt));

  return rows;
}

export interface OfapiOperationBreakdownRow {
  operation: string | null;
  requests: number;
  credits: number;
}

/** REST spend grouped by operation over a window (breakdown panel). */
export async function listOfapiOperationBreakdownBetween(
  db: Database,
  input: { from: Date; to: Date },
): Promise<OfapiOperationBreakdownRow[]> {
  const rows = await db
    .select({
      operation: ofapiCreditLedger.operation,
      requests: sql<number>`count(*)::int`,
      credits: sql<number>`coalesce(sum(${ofapiCreditLedger.credits}), 0)::int`,
    })
    .from(ofapiCreditLedger)
    .where(and(
      eq(ofapiCreditLedger.source, "rest"),
      gte(ofapiCreditLedger.occurredAt, input.from),
      lt(ofapiCreditLedger.occurredAt, input.to),
    ))
    .groupBy(ofapiCreditLedger.operation)
    .orderBy(sql`3 desc`);

  return rows;
}

export interface OfapiPageBreakdownRow {
  pageId: number;
  pageLabel: string;
  credits: number;
}

/** REST spend attributed to pages over a window, top spenders first. */
export async function listOfapiPageBreakdownBetween(
  db: Database,
  input: { from: Date; to: Date; limit?: number },
): Promise<OfapiPageBreakdownRow[]> {
  const rows = await db
    .select({
      pageId: ofapiCreditLedger.pageId,
      pageLabel: pages.label,
      credits: sql<number>`coalesce(sum(${ofapiCreditLedger.credits}), 0)::int`,
    })
    .from(ofapiCreditLedger)
    .innerJoin(pages, eq(ofapiCreditLedger.pageId, pages.id))
    .where(and(
      eq(ofapiCreditLedger.source, "rest"),
      gte(ofapiCreditLedger.occurredAt, input.from),
      lt(ofapiCreditLedger.occurredAt, input.to),
      gt(ofapiCreditLedger.credits, 0),
    ))
    .groupBy(ofapiCreditLedger.pageId, pages.label)
    .orderBy(sql`3 desc`)
    .limit(input.limit ?? 20);

  return rows.filter((row): row is OfapiPageBreakdownRow => row.pageId !== null);
}

export interface ListOfapiCreditLedgerInput {
  offset: number;
  limit: number;
  source?: OfapiCreditLedgerSource;
  pageId?: number;
  operation?: string;
  from?: Date;
  to?: Date;
}

export interface OfapiCreditLedgerListRow {
  id: number;
  occurredAt: Date;
  source: OfapiCreditLedgerSource;
  operation: string | null;
  pageId: number | null;
  pageLabel: string | null;
  httpStatus: number | null;
  credits: number;
  estimated: boolean;
  balanceAfter: number | null;
  requestId: string | null;
  accrualDay: string | null;
}

export interface OfapiCreditLedgerPageOption {
  pageId: number;
  pageLabel: string;
}

export async function listOfapiCreditLedgerPageOptions(
  db: Database,
): Promise<OfapiCreditLedgerPageOption[]> {
  const rows = await db
    .selectDistinct({
      pageId: ofapiCreditLedger.pageId,
      pageLabel: pages.label,
    })
    .from(ofapiCreditLedger)
    .innerJoin(pages, eq(ofapiCreditLedger.pageId, pages.id))
    .where(isNotNull(ofapiCreditLedger.pageId))
    .orderBy(pages.label, ofapiCreditLedger.pageId);

  return rows.filter((row): row is OfapiCreditLedgerPageOption => row.pageId !== null);
}

export async function listOfapiCreditLedgerEntries(
  db: Database,
  input: ListOfapiCreditLedgerInput,
): Promise<{ total: number; rows: OfapiCreditLedgerListRow[] }> {
  const clauses = [
    ...(input.source ? [eq(ofapiCreditLedger.source, input.source)] : []),
    ...(input.pageId !== undefined ? [eq(ofapiCreditLedger.pageId, input.pageId)] : []),
    ...(input.operation ? [eq(ofapiCreditLedger.operation, input.operation)] : []),
    ...(input.from ? [gte(ofapiCreditLedger.occurredAt, input.from)] : []),
    ...(input.to ? [lt(ofapiCreditLedger.occurredAt, input.to)] : []),
  ];
  const where = clauses.length > 0 ? and(...clauses) : undefined;

  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(ofapiCreditLedger)
    .where(where);

  const rows = await db
    .select({
      id: ofapiCreditLedger.id,
      occurredAt: ofapiCreditLedger.occurredAt,
      source: ofapiCreditLedger.source,
      operation: ofapiCreditLedger.operation,
      pageId: ofapiCreditLedger.pageId,
      pageLabel: pages.label,
      httpStatus: ofapiCreditLedger.httpStatus,
      credits: ofapiCreditLedger.credits,
      estimated: ofapiCreditLedger.estimated,
      balanceAfter: ofapiCreditLedger.balanceAfter,
      requestId: ofapiCreditLedger.requestId,
      accrualDay: ofapiCreditLedger.accrualDay,
    })
    .from(ofapiCreditLedger)
    .leftJoin(pages, eq(ofapiCreditLedger.pageId, pages.id))
    .where(where)
    .orderBy(sql`${ofapiCreditLedger.occurredAt} desc, ${ofapiCreditLedger.id} desc`)
    .limit(input.limit)
    .offset(input.offset);

  return {
    total: countRow?.total ?? 0,
    rows: rows.map((row) => ({
      ...row,
      source: row.source as OfapiCreditLedgerSource,
    })),
  };
}

export async function getOfapiWebhookConfig(db: Database) {
  return await db.query.ofapiWebhookConfig.findFirst({
    where: eq(ofapiWebhookConfig.id, 1),
  }) ?? null;
}

export async function upsertOfapiWebhookConfig(
  db: Database,
  input: {
    externalWebhookId: string | null;
    endpointUrl: string;
    accountScope: string;
    events: string[];
    encryptedSigningSecret: string;
    previousEncryptedSigningSecret?: string | null;
  },
) {
  const [row] = await db
    .insert(ofapiWebhookConfig)
    .values({
      id: 1,
      externalWebhookId: input.externalWebhookId,
      endpointUrl: input.endpointUrl,
      accountScope: input.accountScope,
      events: input.events,
      encryptedSigningSecret: input.encryptedSigningSecret,
      previousEncryptedSigningSecret: input.previousEncryptedSigningSecret ?? null,
    })
    .onConflictDoUpdate({
      target: ofapiWebhookConfig.id,
      set: {
        externalWebhookId: input.externalWebhookId,
        endpointUrl: input.endpointUrl,
        accountScope: input.accountScope,
        events: input.events,
        encryptedSigningSecret: input.encryptedSigningSecret,
        previousEncryptedSigningSecret: input.previousEncryptedSigningSecret ?? null,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  return row;
}

export async function findPageByOfapiAccountId(db: Database, ofapiAccountId: string) {
  const [row] = await db
    .select({
      id: pages.id,
      label: pages.label,
      platform: pages.platform,
    })
    .from(pages)
    .where(eq(pages.ofapiAccountId, ofapiAccountId));

  return row ?? null;
}

export async function listOnlyFansPagesForOfapiMapping(db: Database) {
  return db
    .select({
      id: pages.id,
      label: pages.label,
      username: pages.username,
      ofapiAccountId: pages.ofapiAccountId,
    })
    .from(pages)
    .where(eq(pages.platform, "onlyfans"))
    .orderBy(asc(pages.label));
}

export async function setPageOfapiAccountId(
  db: Database,
  input: {
    pageId: number;
    ofapiAccountId: string | null;
  },
) {
  await db
    .update(pages)
    .set({
      ofapiAccountId: input.ofapiAccountId,
      updatedAt: sql`now()`,
    })
    .where(eq(pages.id, input.pageId));
}

/**
 * Advances a page's OFAPI auth state from an accounts.* webhook event.
 * Forward-only by event receive time: an out-of-order older event never
 * overwrites a newer state. Returns false when skipped for that reason.
 */
export async function advancePageOfapiAuthStatus(
  db: Database,
  input: {
    pageId: number;
    authStatus: string;
    changedAt: Date;
  },
) {
  const updated = await db
    .update(pages)
    .set({
      ofapiAuthStatus: input.authStatus,
      ofapiAuthChangedAt: input.changedAt,
      updatedAt: sql`now()`,
    })
    .where(and(
      eq(pages.id, input.pageId),
      sql`(${pages.ofapiAuthChangedAt} is null or ${pages.ofapiAuthChangedAt} <= ${input.changedAt})`,
    ))
    .returning({ id: pages.id });

  return updated.length > 0;
}

export interface OfapiMappedPageRow {
  id: number;
  label: string;
  platform: "fansly" | "onlyfans";
  username: string | null;
  displayName: string | null;
  metadata: Record<string, unknown>;
  ofapiAccountId: string;
  ofapiAuthStatus: string | null;
  ofapiAuthChangedAt: Date | null;
}

export async function listOfapiMappedPages(db: Database): Promise<OfapiMappedPageRow[]> {
  const rows = await db
    .select({
      id: pages.id,
      label: pages.label,
      platform: pages.platform,
      username: pages.username,
      displayName: pages.displayName,
      metadata: pages.metadata,
      ofapiAccountId: pages.ofapiAccountId,
      ofapiAuthStatus: pages.ofapiAuthStatus,
      ofapiAuthChangedAt: pages.ofapiAuthChangedAt,
    })
    .from(pages)
    .where(isNotNull(pages.ofapiAccountId))
    .orderBy(asc(pages.label));

  return rows.filter((row): row is OfapiMappedPageRow => row.ofapiAccountId !== null);
}

/** Most recent journaled delivery overall — the webhook-silence signal. */
export async function getLatestOfapiWebhookEventReceivedAt(db: Database): Promise<Date | null> {
  const [row] = await db
    .select({ latest: sql<Date | string | null>`max(${ofapiWebhookEvents.receivedAt})` })
    .from(ofapiWebhookEvents);

  if (!row || row.latest === null) {
    return null;
  }
  const parsed = row.latest instanceof Date ? row.latest : new Date(row.latest);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Per-page age of the latest settled event of any type (admin status view). */
export async function getLatestOfapiEventTimesForPages(
  db: Database,
  pageIds: number[],
): Promise<Map<number, Date>> {
  if (pageIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      platformAccountId: ofapiWebhookEvents.platformAccountId,
      lastReceivedAt: sql<Date | string | null>`max(${ofapiWebhookEvents.receivedAt})`,
    })
    .from(ofapiWebhookEvents)
    .where(and(
      inArray(ofapiWebhookEvents.platformAccountId, pageIds),
      sql`${ofapiWebhookEvents.status} <> 'pending'`,
    ))
    .groupBy(ofapiWebhookEvents.platformAccountId);

  const result = new Map<number, Date>();
  for (const row of rows) {
    if (row.platformAccountId === null || row.lastReceivedAt === null) {
      continue;
    }
    const parsed = row.lastReceivedAt instanceof Date
      ? row.lastReceivedAt
      : new Date(row.lastReceivedAt);
    if (!Number.isNaN(parsed.getTime())) {
      result.set(row.platformAccountId, parsed);
    }
  }

  return result;
}
