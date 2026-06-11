import { and, asc, eq, gt, gte, inArray, isNotNull, lt, lte, ne, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  ofapiCreditLedger,
  ofapiCreditState,
  ofapiWebhookConfig,
  ofapiWebhookEvents,
  pages,
  type OFAPI_CREDIT_LEDGER_SOURCES,
} from "../schema.ts";

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
      ...(input.pageIds
        ? [inArray(ofapiWebhookEvents.platformAccountId, input.pageIds)]
        : []),
    ))
    .orderBy(asc(ofapiWebhookEvents.fanoutSeq))
    .limit(input.limit);

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

export async function deleteExpiredOfapiWebhookEvents(
  db: Database,
  receivedBefore: Date,
) {
  await db
    .delete(ofapiWebhookEvents)
    .where(lt(ofapiWebhookEvents.receivedAt, receivedBefore));
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

export interface OfapiCreditState {
  spentToday: number;
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
    return { spentToday: 0, lastBalance: null, lastBalanceAt: null };
  }

  return {
    spentToday: row.spendDay === utcDayOf(now) ? row.spentCredits : 0,
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
  input: { from: Date; to: Date },
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ofapiWebhookEvents)
    .where(and(
      gte(ofapiWebhookEvents.receivedAt, input.from),
      lt(ofapiWebhookEvents.receivedAt, input.to),
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
// drift into later windows.
const OFAPI_RECONCILE_KNOWN_SOURCES = ["rest", "webhook_accrual", "adjustment"] as const;

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

/** Trailing-window spend across all sources except refills (burn-rate alert). */
export async function sumOfapiCreditsSpentSince(
  db: Database,
  input: { since: Date },
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${ofapiCreditLedger.credits}), 0)::int` })
    .from(ofapiCreditLedger)
    .where(and(
      gte(ofapiCreditLedger.occurredAt, input.since),
      ne(ofapiCreditLedger.source, "refill"),
    ));

  return row?.total ?? 0;
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

/** Balance observations over a window, oldest first (the balance chart). */
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
    .orderBy(asc(ofapiCreditLedger.occurredAt))
    .limit(input.limit ?? 2000);

  return rows.filter((row): row is OfapiBalancePoint => row.value !== null);
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
