import { OfapiAccountCustodyConflictError, ofapiAccountBelongsToPageSql } from "./ofapi-bindings.ts";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, lte, ne, sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  ofapiCreditLedger,
  ofapiCreditState,
  ofapiFanoutReplayState,
  pageLinkStatRuns,
  pageLinkStatSnapshots,
  ofapiSpendProjectionEvents,
  ofapiWebhookConfig,
  ofapiWebhookEvents,
  pages,
  transactions,
  type OFAPI_CREDIT_LEDGER_SOURCES,
  type OfapiWebhookPendingRegistration,
} from "../schema.ts";

const OFAPI_SPEND_TRANSACTION_PAGE_LOCK_NAMESPACE = 9_003_001;
const OFAPI_WEBHOOK_REGISTRATION_LOCK_KEY = 9_003_002;
const OFAPI_WEBHOOK_DISPATCH_STALE_MS = 5 * 60 * 1_000;
export const OFAPI_SYNC_EVENT_CHANNEL = "ofapi_sync_events";

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

export type OfapiWebhookCaptureState =
  | "raw_captured"
  | "accepted"
  | "quarantined_malformed";

export interface OfapiWebhookRawClaim {
  id: number;
  created: boolean;
  captureState: OfapiWebhookCaptureState;
  payloadHash: Buffer | null;
}

/** Claims the vendor idempotency key while retaining the signed byte stream.
 * JSON/envelope parsing deliberately happens only after this statement commits. */
export async function claimOfapiWebhookRaw(
  db: Database,
  input: {
    idempotencyKey: string;
    rawBody: Buffer;
    payloadHash: Buffer;
    captureHeaders: Record<string, string>;
  },
): Promise<OfapiWebhookRawClaim> {
  const created = await db.execute<{ id: string }>(sql`
    insert into ofapi_webhook_events (
      idempotency_key, event_type, payload, raw_body, payload_hash,
      capture_headers, capture_state, projection_status, status
    ) values (
      ${input.idempotencyKey}, '__raw__', '{}'::jsonb, ${input.rawBody},
      ${input.payloadHash}, ${JSON.stringify(input.captureHeaders)}::jsonb,
      'raw_captured', 'none', 'pending'
    )
    on conflict (idempotency_key) do nothing
    returning id::text
  `);
  const row = await db.execute<{
    id: string;
    capture_state: string;
    payload_hash: Buffer | null;
  }>(sql`
    select id::text, capture_state, payload_hash
    from ofapi_webhook_events
    where idempotency_key = ${input.idempotencyKey}
  `);
  const existing = row.rows[0];
  if (!existing) {
    throw new Error("OFAPI raw webhook claim disappeared");
  }
  if (
    existing.capture_state !== "raw_captured" &&
    existing.capture_state !== "accepted" &&
    existing.capture_state !== "quarantined_malformed"
  ) {
    throw new Error(`Unknown OFAPI webhook capture state ${existing.capture_state}`);
  }
  return {
    id: Number(existing.id),
    created: created.rows.length > 0,
    captureState: existing.capture_state,
    payloadHash: existing.payload_hash,
  };
}

/** Promotes byte-exact raw intake to the ordinary parsed event journal. */
export async function acceptOfapiWebhookRaw(
  db: Database,
  input: {
    id: number;
    payloadHash: Buffer;
    eventType: string;
    ofapiAccountId: string | null;
    payload: Record<string, unknown>;
    projectionStatus: "pending" | "none";
  },
) {
  const accepted = await db.execute<{ id: string }>(sql`
    update ofapi_webhook_events
    set event_type = ${input.eventType},
        ofapi_account_id = ${input.ofapiAccountId},
        payload = ${JSON.stringify(input.payload)}::jsonb,
        projection_status = ${input.projectionStatus},
        capture_state = 'accepted'
    where id = ${input.id}
      and capture_state = 'raw_captured'
      and payload_hash = ${input.payloadHash}
    returning id::text
  `);
  return accepted.rows.length > 0;
}

/** Terminal local outcome for signed bytes that violate the current envelope
 * contract. They remain retained and can be reparsed without vendor delivery. */
export async function quarantineMalformedOfapiWebhookRaw(
  db: Database,
  input: { id: number; payloadHash: Buffer; reason: string; processedAt?: Date },
) {
  const quarantined = await db.execute<{ id: string }>(sql`
    update ofapi_webhook_events
    set capture_state = 'quarantined_malformed',
        status = 'skipped',
        error = ${input.reason},
        processed_at = ${input.processedAt ?? new Date()}
    where id = ${input.id}
      and capture_state = 'raw_captured'
      and payload_hash = ${input.payloadHash}
    returning id::text
  `);
  return quarantined.rows.length > 0;
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
 * Latest settled received_at per page through one bounded backward index probe
 * per page (ofapi_webhook_events_page_received_idx, migration 0184). `extra`
 * narrows the probe (e.g. an event_type list); it must start with `and`.
 */
async function latestReceivedAtPerPage(
  db: Database,
  pageIds: readonly number[],
  extra: ReturnType<typeof sql>,
): Promise<Array<{ platformAccountId: number | null; lastReceivedAt: Date | string | null }>> {
  const result = await db.execute<{ platformAccountId: number | string | null; lastReceivedAt: Date | string | null }>(sql`
    select p.id as "platformAccountId", e.received_at as "lastReceivedAt"
    from (values ${sql.join(pageIds.map((id) => sql`(${id}::bigint)`), sql`, `)}) as p(id)
    left join lateral (
      select w.received_at
      from ${ofapiWebhookEvents} w
      where w.platform_account_id = p.id
        and w.status <> 'pending'
        ${extra}
      order by w.received_at desc
      limit 1
    ) e on true
  `);
  return result.rows.map((row) => ({
    platformAccountId: row.platformAccountId === null ? null : Number(row.platformAccountId),
    lastReceivedAt: row.lastReceivedAt,
  }));
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

  // One backward probe per page on ofapi_webhook_events_page_received_idx
  // (0184) instead of max() over every row of the page: the settled OFAPI
  // pages own the whole 690k-row journal, so a grouped max() was a full scan
  // (docs/diag/2026-09-11-agency-hub-load).
  const rows = await latestReceivedAtPerPage(db, input.pageIds, sql`
    and w.event_type in (${sql.join(input.eventTypes.map((type) => sql`${type}`), sql`, `)})
  `);

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
  platformFeeMills?: bigint | null;
  vatAmountMills?: bigint | null;
  taxAmountMills?: bigint | null;
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
    platformFeeMills: input.platformFeeMills ?? null,
    vatAmountMills: input.vatAmountMills ?? null,
    taxAmountMills: input.taxAmountMills ?? null,
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

/**
 * The webhook event types the spend projection sweep consumes. It lives HERE,
 * beside the only query that reads it, because migration 0143's partial index
 * (`ofapi_webhook_events_spend_candidates_idx`) repeats this list as its
 * predicate: the planner may only use a partial index when the query's own
 * clauses imply the predicate, and an implication over a list of constants is
 * proven by structural equality — a list that differs in CONTENT OR ORDER
 * silently stops the index from being used and the sweep goes back to walking
 * the whole 570k-row journal every minute (19.4 s, 380k buffers on prod
 * 2026-08-23). `tests/migration-invariants.test.ts` pins the two together.
 *
 * The sweep no longer passes the list in: one list, one query, nothing to drift.
 */
export const OFAPI_SPEND_PROJECTION_EVENT_TYPES = [
  "transactions.new",
  "messages.ppv.unlocked",
  "tips.received",
] as const;

/** The pinned list as SQL constants. `inArray` would bind PARAMETERS, and the
 *  planner cannot prove a parameterised `= any($1)` implies the index
 *  predicate — the values have to reach the planner as Consts. The members are
 *  compile-time literals of this module, never caller input; the quote escape
 *  is belt-and-braces. */
const OFAPI_SPEND_PROJECTION_EVENT_TYPES_SQL = sql.raw(
  OFAPI_SPEND_PROJECTION_EVENT_TYPES
    .map((eventType) => `'${eventType.replaceAll("'", "''")}'`)
    .join(", "),
);

/**
 * A settled spend delivery the projection has not written yet: no
 * ofapi_spend_projection_events row carries its journal id. Correlated to the
 * UNALIASED ofapi_webhook_events of the enclosing query. Shared by the
 * projection sweep (which re-offers these rows) and the Spenders money stamp
 * (which must not vouch past one of them).
 */
function ofapiWebhookEventAwaitsSpendProjectionSql() {
  // The literal below must stay equal to OFAPI_TIPS_RECEIVED_BLOCKED_REASON
  // (runtime's ofapi-spend-projection-contract.ts) — it can't be imported
  // across the package boundary, and a drift silently stops the legacy
  // blocked-tips rows from self-healing.
  return sql`not exists (
    select 1 from ${ofapiSpendProjectionEvents}
    where ${ofapiSpendProjectionEvents.journalId} = ${ofapiWebhookEvents.id}
      and not (
        ${ofapiSpendProjectionEvents.projectionStatus} = 'blocked'
        and ${ofapiSpendProjectionEvents.blockedReason} = 'tips_received_live_fixture_required'
      )
  )`;
}

export async function listOfapiWebhookEventsForSpendProjection(
  db: Database,
  input: {
    limit: number;
  },
) {
  return db
    .select()
    .from(ofapiWebhookEvents)
    .where(and(
      sql`${ofapiWebhookEvents.eventType} in (${OFAPI_SPEND_PROJECTION_EVENT_TYPES_SQL})`,
      sql`${ofapiWebhookEvents.status} <> 'pending'`,
      isNotNull(ofapiWebhookEvents.platformAccountId),
      ofapiWebhookEventAwaitsSpendProjectionSql(),
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
  platformFeeMills: bigint | null;
  vatAmountMills: bigint | null;
  taxAmountMills: bigint | null;
  eventStatus: "pending" | "settled" | "reversed";
  journalId: number;
  /** The webhook delivery key — also the Stage 7 observation key (source='webhook'). */
  sourceIdempotencyKey: string;
}

/**
 * A projected transactions.new row the truth ingest still has to apply: the
 * row's own clauses plus "no transactions row already says the same thing".
 * Correlated to the UNALIASED ofapi_spend_projection_events of the enclosing
 * query. The ingest's candidate list and the Spenders money stamp share it, so
 * "waiting to be applied" means the same thing to both.
 */
function ofapiSpendProjectionAwaitsTruthIngestSql(): SQL {
  return and(
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
    // W7.4 follow-up (2026-07-11, resurrection loop): a 'pending' event
    // whose transaction has since SETTLED (state posted, any raw_status)
    // must count as PRESENT — the old exact-shape match treated the
    // settled row as missing and the minutely ingest re-applied the stale
    // pending event, flipping REST-settled rows back to pending forever
    // (the A47 rescan could never stick).
    sql`not exists (
      select 1 from ${transactions} tx
      where tx.platform_account_id = ${ofapiSpendProjectionEvents.pageId}
        and tx.transaction_id = ${ofapiSpendProjectionEvents.transactionId}
        and tx.sender_id is not distinct from ${ofapiSpendProjectionEvents.fanPlatformUserId}
        and ${ofapiSpendProjectionEvents.eventStatus} = 'pending'
        and tx.transaction_state::text = 'posted'
    )`,
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
  )!;
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
      platformFeeMills: ofapiSpendProjectionEvents.platformFeeMills,
      vatAmountMills: ofapiSpendProjectionEvents.vatAmountMills,
      taxAmountMills: ofapiSpendProjectionEvents.taxAmountMills,
      eventStatus: ofapiSpendProjectionEvents.eventStatus,
      journalId: ofapiSpendProjectionEvents.journalId,
      sourceIdempotencyKey: ofapiSpendProjectionEvents.sourceIdempotencyKey,
    })
    .from(ofapiSpendProjectionEvents)
    // Events journaled pre-tombstone must not be written post-tombstone: the
    // sweep only applies rows whose page is still live (review R2-4). The
    // events stay journaled and would apply again on undelete.
    .innerJoin(pages, and(
      eq(pages.id, ofapiSpendProjectionEvents.pageId),
      eq(pages.status, "active"),
    ))
    .where(ofapiSpendProjectionAwaitsTruthIngestSql())
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
      platformFeeMills: row.platformFeeMills,
      vatAmountMills: row.vatAmountMills,
      taxAmountMills: row.taxAmountMills,
      eventStatus: row.eventStatus as OfapiSpendProjectionTransactionIngestRow["eventStatus"],
      journalId: row.journalId,
      sourceIdempotencyKey: row.sourceIdempotencyKey,
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
  | "tips_signal"
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
      and p.projection_status = 'projected'
      then 'tips_signal'
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
    /** Inclusive replay ceiling captured after the live subscription. */
    throughSeq?: number;
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
      ...(input.throughSeq === undefined
        ? []
        : [lte(ofapiWebhookEvents.fanoutSeq, input.throughSeq)]),
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

  const retainedHighWater = row?.maxSeq === null || row?.maxSeq === undefined
    ? 0
    : Number(row.maxSeq);
  const state = await getOfapiFanoutReplayState(db);
  return Math.max(retainedHighWater, state.replayFloor, state.legacyHighWater);
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
      min(fanout_seq) filter (
        where status = 'processed'
          and sync_event is not null
          and platform_account_id is not null
      )::bigint as "oldestRetainedSeq",
      greatest(
        coalesce(max(fanout_seq), 0),
        coalesce((
          select greatest(replay_floor, legacy_high_water)
          from ofapi_fanout_replay_state where singleton
        ), 0)
      )::bigint as "latestSeq"
    from ofapi_webhook_events
  `);
  const row = result.rows[0];
  return {
    oldestRetainedSeq: row?.oldestRetainedSeq == null
      ? null
      : Number(row.oldestRetainedSeq),
    latestSeq: row?.latestSeq == null ? 0 : Number(row.latestSeq),
  };
}

/** Global contiguous prefix through which v1 replayable rows were removed. */
export async function getOfapiSyncReplayFloor(db: Database): Promise<number> {
  return (await getOfapiFanoutReplayState(db)).replayFloor;
}

/** Replay deletion floor plus the one-time pre-0094 cursor high-water. */
export async function getOfapiFanoutReplayState(db: Database): Promise<{
  replayFloor: number;
  legacyHighWater: number;
}> {
  const [row] = await db
    .select({
      replayFloor: ofapiFanoutReplayState.replayFloor,
      legacyHighWater: ofapiFanoutReplayState.legacyHighWater,
    })
    .from(ofapiFanoutReplayState)
    .where(eq(ofapiFanoutReplayState.singleton, true))
    .limit(1);
  return {
    replayFloor: row?.replayFloor == null ? 0 : Number(row.replayFloor),
    legacyHighWater: row?.legacyHighWater == null ? 0 : Number(row.legacyHighWater),
  };
}

export async function deleteExpiredOfapiWebhookEvents(
  db: Database,
  receivedBefore: Date,
) {
  // Stage 1 belt-and-braces guard: a journal row may only be deleted once its
  // projection and archive bookkeeping show it consumed. Replayable rows are
  // additionally prefix-only: the first recent/pending/failed row blocks every
  // later replayable deletion, so one global floor is a complete continuity
  // proof rather than a lossy max-deleted approximation.
  await db.transaction(async (tx) => {
    // Test resets and disaster-recovery restores can legitimately start from
    // an empty singleton table; recreate the zero state idempotently before
    // taking the serialization lock.
    await tx
      .insert(ofapiFanoutReplayState)
      .values({ singleton: true, replayFloor: 0 })
      .onConflictDoNothing({ target: ofapiFanoutReplayState.singleton });
    const locked = await tx.execute<{ replayFloor: string | number }>(sql`
      select replay_floor as "replayFloor"
      from ofapi_fanout_replay_state
      where singleton
      for update
    `);
    const replayFloor = Number(locked.rows[0]?.replayFloor ?? 0);
    await tx.execute(sql`
      with blocker as (
        select min(e.fanout_seq) as fanout_seq
        from ofapi_webhook_events e
        where e.fanout_seq > ${replayFloor}
          and e.status = 'processed'
          and e.sync_event is not null
          and e.platform_account_id is not null
          and not (
            e.received_at < ${receivedBefore}
            and e.projection_status not in ('pending', 'failed')
            and e.archive_status not in ('pending', 'failed')
          )
      ), removed as (
        delete from ofapi_webhook_events e
        using blocker
        where e.received_at < ${receivedBefore}
          and e.status <> 'pending'
          and e.projection_status not in ('pending', 'failed')
          and e.archive_status not in ('pending', 'failed')
          and (
            e.status <> 'processed'
            or e.sync_event is null
            or e.fanout_seq is null
            or e.platform_account_id is null
            or e.fanout_seq <= ${replayFloor}
            or (
              e.fanout_seq > ${replayFloor}
              and (blocker.fanout_seq is null or e.fanout_seq < blocker.fanout_seq)
            )
          )
        returning case
          when e.status = 'processed'
           and e.sync_event is not null
           and e.fanout_seq is not null
           and e.platform_account_id is not null
          then e.fanout_seq
          else null
        end as replay_seq
      ), advanced as (
        update ofapi_fanout_replay_state state
        set replay_floor = greatest(
              state.replay_floor,
              coalesce((select max(replay_seq) from removed), state.replay_floor)
            ),
            updated_at = now()
        where state.singleton
        returning state.replay_floor
      )
      select replay_floor from advanced
    `);
    const deletedThrough = await getOfapiSyncReplayFloor(tx as Database);
    if (deletedThrough > replayFloor) {
      // Cleanup itself must wake a live API hub: the deleted row's earlier
      // settle NOTIFY may still be waiting behind this transaction.
      await tx.execute(sql`
        select pg_notify(${OFAPI_SYNC_EVENT_CHANNEL}, ${`replay-floor:${deletedThrough}`})
      `);
    }
  });
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
        when ofapi_credit_state.spend_day is null
          or ofapi_credit_state.spend_day < ${day}::date
          then ${creditsUsed}
        else ofapi_credit_state.spent_credits
      end,
      spend_day = case
        when ofapi_credit_state.spend_day is null
          or ofapi_credit_state.spend_day < ${day}::date
          then ${day}::date
        else ofapi_credit_state.spend_day
      end,
      last_balance = case
        when ${balance}::int is null then ofapi_credit_state.last_balance
        when ofapi_credit_state.last_balance_at is null
          or ofapi_credit_state.last_balance_at <= ${now}::timestamptz
          then ${balance}::int
        else ofapi_credit_state.last_balance
      end,
      last_balance_at = case
        when ${balance}::int is null then ofapi_credit_state.last_balance_at
        when ofapi_credit_state.last_balance_at is null
          or ofapi_credit_state.last_balance_at <= ${now}::timestamptz
          then ${now}::timestamptz
        else ofapi_credit_state.last_balance_at
      end,
      updated_at = greatest(ofapi_credit_state.updated_at, ${now}::timestamptz)
  `);
}

export type OfapiDayBudgetScope = "global" | "audience" | "backfill" | "link_stats";

export interface OfapiDayCreditReservationReceipt {
  scope: OfapiDayBudgetScope;
  reservationDay: string;
  estimate: number;
}

const OFAPI_DAY_COUNTER_COLUMNS = {
  global: { day: "spend_day", credits: "spent_credits" },
  audience: { day: "audience_spend_day", credits: "audience_spent_credits" },
  backfill: { day: "backfill_spend_day", credits: "backfill_spent_credits" },
  link_stats: { day: "link_stats_spend_day", credits: "link_stats_spent_credits" },
} as const;

/**
 * Atomically reserves `estimate` credits against the scope's UTC-day counter
 * (audit F9): the budget comparison and the counter increment are one
 * conditional update, so concurrent streams near the cap can never pass the
 * check together and overspend. Returns null when the reservation would
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
    /**
     * Dedicated legacy lanes also reserve the shared physical cap. The two
     * counters move in one statement so governed mirror admission can safely
     * run beside audience/backfill work without a check-then-dispatch race.
     */
    globalBudget?: number;
    now?: Date;
  },
): Promise<OfapiDayCreditReservationReceipt | null> {
  const startedAt = input.now ?? new Date();
  const estimate = Math.max(0, Math.round(input.estimate));
  const budget = Math.round(input.budget);
  if (estimate > budget) {
    return null;
  }

  const columns = OFAPI_DAY_COUNTER_COLUMNS[input.scope];
  const dayColumn = sql.raw(columns.day);
  const creditsColumn = sql.raw(columns.credits);
  const globalBudget = input.scope !== "global" && input.globalBudget !== undefined
    ? Math.round(input.globalBudget)
    : null;
  if (globalBudget !== null && estimate > globalBudget) {
    return null;
  }

  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    await database.execute(sql`
      insert into ofapi_credit_state (id, updated_at)
      values (1, ${startedAt}::timestamptz)
      on conflict (id) do nothing
    `);
    const locked = await database.execute<{
      scope_day: string | Date | null;
      scope_credits: unknown;
      spend_day: string | Date | null;
      spent_credits: unknown;
    }>(sql`
      select ${dayColumn} as scope_day,
             ${creditsColumn} as scope_credits,
             spend_day,
             spent_credits
      from ofapi_credit_state
      where id = 1
      for update
    `);
    const row = locked.rows[0];
    if (!row) throw new Error("OFAPI credit singleton disappeared during reservation");

    // Capture admission time only after the singleton lock. Injected `now` is
    // retained for deterministic tests, while production callers cannot carry
    // a pre-lock day across UTC midnight.
    const admittedAt = input.now ?? new Date();
    const day = utcDayOf(admittedAt);
    const scopeDay = row.scope_day === null
      ? null
      : utcDayOf(row.scope_day instanceof Date ? row.scope_day : new Date(row.scope_day));
    const globalDay = row.spend_day === null
      ? null
      : utcDayOf(row.spend_day instanceof Date ? row.spend_day : new Date(row.spend_day));
    if (scopeDay !== null && scopeDay > day) return null;
    if (globalBudget !== null && globalDay !== null && globalDay > day) return null;

    const scopeSpent = scopeDay === day ? Number(row.scope_credits) : 0;
    const globalSpent = globalDay === day ? Number(row.spent_credits) : 0;
    if (!Number.isFinite(scopeSpent) || scopeSpent + estimate > budget) return null;
    if (
      globalBudget !== null &&
      (!Number.isFinite(globalSpent) || globalSpent + estimate > globalBudget)
    ) return null;

    if (globalBudget !== null) {
      await database.execute(sql`
        update ofapi_credit_state
        set spend_day = ${day}::date,
            spent_credits = ${globalSpent + estimate},
            ${dayColumn} = ${day}::date,
            ${creditsColumn} = ${scopeSpent + estimate},
            updated_at = greatest(updated_at, ${admittedAt}::timestamptz)
        where id = 1
      `);
    } else {
      await database.execute(sql`
        update ofapi_credit_state
        set ${dayColumn} = ${day}::date,
            ${creditsColumn} = ${scopeSpent + estimate},
            updated_at = greatest(updated_at, ${admittedAt}::timestamptz)
        where id = 1
      `);
    }

    return { scope: input.scope, reservationDay: day, estimate };
  });
}

/**
 * Settles a reservation made by reserveOfapiDayCredits to the server-reported
 * actuals against the day named by its receipt. A response arriving after UTC
 * rollover never rewinds a newer counter window. Optionally records the
 * response's balance observation, exactly like recordOfapiCreditUsage.
 */
export async function settleOfapiDayCreditReservation(
  db: Database,
  input: {
    scope: OfapiDayBudgetScope;
    receipt: OfapiDayCreditReservationReceipt;
    creditsDelta: number;
    balance?: number | null;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const delta = Math.round(input.creditsDelta);
  const actual = Math.max(0, input.receipt.estimate + delta);
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
      ${input.receipt.reservationDay}::date,
      ${actual},
      ${balance},
      case when ${balance}::int is null then null else ${now}::timestamptz end,
      ${now}::timestamptz
    )
    on conflict (id) do update set
      ${creditsColumn} = case
        when ofapi_credit_state.${dayColumn} = ${input.receipt.reservationDay}::date
          then greatest(0, ofapi_credit_state.${creditsColumn} + ${delta})
        when ofapi_credit_state.${dayColumn} is null
          or ofapi_credit_state.${dayColumn} < ${input.receipt.reservationDay}::date
          then ${actual}
        else ofapi_credit_state.${creditsColumn}
      end,
      ${dayColumn} = case
        when ofapi_credit_state.${dayColumn} is null
          or ofapi_credit_state.${dayColumn} < ${input.receipt.reservationDay}::date
          then ${input.receipt.reservationDay}::date
        else ofapi_credit_state.${dayColumn}
      end,
      last_balance = case
        when ${balance}::int is null then ofapi_credit_state.last_balance
        when ofapi_credit_state.last_balance_at is null
          or ofapi_credit_state.last_balance_at <= ${now}::timestamptz
          then ${balance}::int
        else ofapi_credit_state.last_balance
      end,
      last_balance_at = case
        when ${balance}::int is null then ofapi_credit_state.last_balance_at
        when ofapi_credit_state.last_balance_at is null
          or ofapi_credit_state.last_balance_at <= ${now}::timestamptz
          then ${now}::timestamptz
        else ofapi_credit_state.last_balance_at
      end,
      updated_at = greatest(ofapi_credit_state.updated_at, ${now}::timestamptz)
  `);
}

export interface RecordOfapiPhysicalCreditUsageInput {
  creditsUsed: number;
  balance?: number | null;
  budgetScope?: Exclude<OfapiDayBudgetScope, "global"> | null;
  now?: Date;
}

async function applyOfapiPhysicalCreditUsage(
  db: Database,
  input: RecordOfapiPhysicalCreditUsageInput,
) {
  const now = input.now ?? new Date();
  const creditsUsed = Math.max(0, Math.round(input.creditsUsed));
  await recordOfapiCreditUsage(db, {
    creditsUsed,
    balance: input.balance ?? null,
    now,
  });
  if (input.budgetScope) {
    await settleOfapiDayCreditReservation(db, {
      scope: input.budgetScope,
      receipt: {
        scope: input.budgetScope,
        reservationDay: utcDayOf(now),
        estimate: 0,
      },
      creditsDelta: creditsUsed,
      now,
    });
  }
}

/** Records physical spend in the shared ceiling and its optional dedicated
 * lane atomically. Used as the fail-closed fallback when the ledger is down. */
export async function recordOfapiPhysicalCreditUsage(
  db: Database,
  input: RecordOfapiPhysicalCreditUsageInput,
) {
  await db.transaction((tx) => applyOfapiPhysicalCreditUsage(tx, input));
}

/** What a scope's UTC-day counter holds today: 0 when the counter belongs to
 * an earlier day or there is no state row yet. A read, never a reservation —
 * for a lane whose requests are free at the vendor and whose quota therefore
 * counts only what the vendor actually charged. */
export async function getOfapiDayCreditsSpent(
  db: Database,
  scope: OfapiDayBudgetScope,
  now = new Date(),
): Promise<number> {
  const columns = OFAPI_DAY_COUNTER_COLUMNS[scope];
  const result = await db.execute<{ day: string | Date | null; credits: unknown }>(sql`
    select ${sql.raw(columns.day)} as day, ${sql.raw(columns.credits)} as credits
    from ofapi_credit_state
    where id = 1
  `);
  const row = result.rows[0];
  if (!row || row.day === null) {
    return 0;
  }
  const day = utcDayOf(row.day instanceof Date ? row.day : new Date(row.day));
  const credits = Number(row.credits);
  // A counter dated ahead of `now` (clock skew) still counts: the cautious
  // reading, as in reserveOfapiDayCredits.
  return day >= utcDayOf(now) && Number.isFinite(credits) ? credits : 0;
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
  /** Stage 9: the acting principal for gateway reads; NULL = system spend. */
  actorUserId?: number | null;
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
      actorUserId: input.actorUserId ?? null,
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
  actorUserId?: number | null;
  budgetScope?: Exclude<OfapiDayBudgetScope, "global"> | null;
}

/** Rare ambiguous-COMMIT probe for the legacy sink. A logical requestId is
 * shared by HTTP retries, so the physical identity includes attemptNumber. */
export async function hasOfapiCreditSpendRequestAttempt(
  db: Database,
  input: { requestId: string; attemptNumber: number },
) {
  const result = await db.execute<{ recorded: boolean }>(sql`
    select true as recorded
    from ofapi_credit_ledger
    where source = 'rest'
      and request_id = ${input.requestId}
      and details ->> 'attemptNumber' = ${String(input.attemptNumber)}
    limit 1
  `);
  return result.rows[0]?.recorded === true;
}

/**
 * Records one OFAPI REST response in the credit ledger AND the ofapi_credit_state
 * day counter in a single transaction (D2: the counter stays for fast budget
 * checks but can never disagree with the ledger).
 */
export async function recordOfapiCreditSpend(
  db: Database,
  input: RecordOfapiCreditSpendInput,
): Promise<number | null> {
  const occurredAt = input.occurredAt ?? new Date();
  return db.transaction(async (tx) => {
    const entry = await insertOfapiCreditLedgerEntry(tx, {
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
      actorUserId: input.actorUserId ?? null,
    });
    await applyOfapiPhysicalCreditUsage(tx, {
      creditsUsed: input.credits,
      balance: input.balanceAfter ?? null,
      budgetScope: input.budgetScope ?? null,
      now: occurredAt,
    });
    // The id lets a caller link its own record (the media fetch log) to the row.
    return entry?.id ?? null;
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
 * (`isProratedExternal`). The optional scope reads recorded activity or actual
 * external rows directly: subtracting two independently read totals could
 * misclassify a concurrently committed REST entry as an unexplained residual.
 */
export async function summarizeOfapiSpendWindowBetween(
  db: Database,
  input: { from: Date; to: Date; scope?: "recorded_activity" | "external_residual" },
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
      ...(input.scope === "recorded_activity"
        ? [ne(ofapiCreditLedger.source, "external"), ne(ofapiCreditLedger.credits, 0)]
        : input.scope === "external_residual"
          ? [eq(ofapiCreditLedger.source, "external")]
          : []),
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

/** Net spend by source, including signed corrections and excluding refills. */
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
      ne(ofapiCreditLedger.source, "refill"),
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
      inArray(ofapiCreditLedger.source, ["rest", "adjustment"]),
      inArray(ofapiCreditLedger.operation, [...input.operations]),
      gte(ofapiCreditLedger.occurredAt, input.from),
      lt(ofapiCreditLedger.occurredAt, input.to),
    ));

  return row?.total ?? 0;
}

/** Page-scoped REST spend net of attributed corrections for chatter summaries. */
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
      inArray(ofapiCreditLedger.source, ["rest", "adjustment"]),
      inArray(ofapiCreditLedger.pageId, input.pageIds),
      gte(ofapiCreditLedger.occurredAt, input.from),
      lt(ofapiCreditLedger.occurredAt, input.to),
    ));

  return row?.total ?? 0;
}

export interface OfapiDailySpendRow {
  day: string;
  source: OfapiCreditLedgerSource;
  credits: number;
}

/** Per-UTC-day net spend by source, retaining signed corrections. */
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
      and source <> 'refill'
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

/** REST spend plus attributed corrections; only settlement rows count as requests. */
export async function listOfapiOperationBreakdownBetween(
  db: Database,
  input: { from: Date; to: Date },
): Promise<OfapiOperationBreakdownRow[]> {
  const rows = await db
    .select({
      operation: ofapiCreditLedger.operation,
      requests: sql<number>`count(*) filter (where ${ofapiCreditLedger.source} = 'rest')::int`,
      credits: sql<number>`coalesce(sum(${ofapiCreditLedger.credits}), 0)::int`,
    })
    .from(ofapiCreditLedger)
    .where(and(
      inArray(ofapiCreditLedger.source, ["rest", "adjustment"]),
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

/** Net REST spend and attributed corrections per page, top spenders first. */
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
      inArray(ofapiCreditLedger.source, ["rest", "adjustment"]),
      gte(ofapiCreditLedger.occurredAt, input.from),
      lt(ofapiCreditLedger.occurredAt, input.to),
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

export type OfapiWebhookRegistrationOperation = "create" | "update";

export type OfapiWebhookRegistrationPreparation =
  | { kind: "noop"; encryptedSigningSecret: string }
  | {
    kind: "ready";
    operation: OfapiWebhookRegistrationOperation;
    operationId: string;
    externalWebhookId: string | null;
    endpointUrl: string;
    events: string[];
    encryptedSigningSecret: string;
  }
  | {
    kind: "blocked";
    reason: "create_indeterminate" | "operation_in_flight" | "target_conflict" | "invalid_state";
  };

function sameWebhookRegistrationTarget(
  target: { endpointUrl: string; accountScope: string; events: string[] },
  desired: { endpointUrl: string; accountScope: "global"; events: string[] },
) {
  return target.endpointUrl === desired.endpointUrl &&
    target.accountScope === desired.accountScope &&
    target.events.length === desired.events.length &&
    target.events.every((event, index) => event === desired.events[index]);
}

export async function prepareOfapiWebhookRegistration(
  db: Database,
  input: {
    operationId: string;
    endpointUrl: string;
    events: string[];
    candidateEncryptedSigningSecret: string;
    remoteProof?: { id: string; updatedAt: string; state: "match" | "drift" | "missing"; credentialFingerprint: string };
    now?: Date;
  },
): Promise<OfapiWebhookRegistrationPreparation> {
  const now = input.now ?? new Date();
  const desired = {
    endpointUrl: input.endpointUrl,
    accountScope: "global" as const,
    events: input.events,
  };
  return db.transaction(async (tx) => {
    const database = tx as Database;
    await database.execute(sql`select pg_advisory_xact_lock(${OFAPI_WEBHOOK_REGISTRATION_LOCK_KEY})`);
    const existing = await database.query.ofapiWebhookConfig.findFirst({
      where: eq(ofapiWebhookConfig.id, 1),
    }) ?? null;
    if (!existing) {
      const pending: OfapiWebhookPendingRegistration = {
        operationId: input.operationId,
        operation: "create",
        externalWebhookId: null,
        ...desired,
        preparedAt: now.toISOString(),
      };
      await database.insert(ofapiWebhookConfig).values({
        id: 1,
        externalWebhookId: null,
        endpointUrl: input.endpointUrl,
        accountScope: "global",
        events: input.events,
        encryptedSigningSecret: input.candidateEncryptedSigningSecret,
        registrationState: "create_prepared",
        pendingRegistration: pending,
        pendingEncryptedSigningSecret: input.candidateEncryptedSigningSecret,
      });
      return {
        kind: "ready",
        operation: "create",
        operationId: pending.operationId,
        externalWebhookId: null,
        endpointUrl: pending.endpointUrl,
        events: pending.events,
        encryptedSigningSecret: input.candidateEncryptedSigningSecret,
      };
    }

    if (existing.registrationState === "stable") {
      if (input.remoteProof) {
        if (existing.externalWebhookId !== input.remoteProof.id || existing.updatedAt.toISOString() !== input.remoteProof.updatedAt) {
          return { kind: "blocked", reason: "target_conflict" };
        }
        if (input.remoteProof.state === "missing") {
          await database.execute(sql`
            insert into ofapi_webhook_registration_history(external_webhook_id,endpoint_url,credential_fingerprint,reason)
            values (${existing.externalWebhookId},${existing.endpointUrl},${input.remoteProof.credentialFingerprint},'confirmed_missing')
          `);
          await database.update(ofapiWebhookConfig).set({ externalWebhookId: null }).where(eq(ofapiWebhookConfig.id, 1));
          existing.externalWebhookId = null;
        }
      }

      if (existing.externalWebhookId && input.remoteProof?.state !== "drift" && sameWebhookRegistrationTarget(existing, desired)) {
        return { kind: "noop", encryptedSigningSecret: existing.encryptedSigningSecret };
      }
      const operation: OfapiWebhookRegistrationOperation = existing.externalWebhookId
        ? "update"
        : "create";
      const pending: OfapiWebhookPendingRegistration = {
        operationId: input.operationId,
        operation,
        externalWebhookId: existing.externalWebhookId,
        ...desired,
        preparedAt: now.toISOString(),
      };
      await database.update(ofapiWebhookConfig).set({
        registrationState: `${operation}_prepared`,
        pendingRegistration: pending,
        pendingEncryptedSigningSecret: input.candidateEncryptedSigningSecret,
        registrationError: null,
        updatedAt: now,
      }).where(eq(ofapiWebhookConfig.id, 1));
      return {
        kind: "ready",
        operation,
        operationId: pending.operationId,
        externalWebhookId: pending.externalWebhookId,
        endpointUrl: pending.endpointUrl,
        events: pending.events,
        encryptedSigningSecret: input.candidateEncryptedSigningSecret,
      };
    }

    if (existing.registrationState === "create_failed") {
      const pending: OfapiWebhookPendingRegistration = {
        operationId: input.operationId,
        operation: "create",
        externalWebhookId: null,
        ...desired,
        preparedAt: now.toISOString(),
      };
      await database.update(ofapiWebhookConfig).set({
        endpointUrl: input.endpointUrl,
        accountScope: "global",
        events: input.events,
        encryptedSigningSecret: input.candidateEncryptedSigningSecret,
        registrationState: "create_prepared",
        pendingRegistration: pending,
        pendingEncryptedSigningSecret: input.candidateEncryptedSigningSecret,
        registrationError: null,
        updatedAt: now,
      }).where(eq(ofapiWebhookConfig.id, 1));
      return {
        kind: "ready",
        operation: "create",
        operationId: pending.operationId,
        externalWebhookId: null,
        endpointUrl: pending.endpointUrl,
        events: pending.events,
        encryptedSigningSecret: input.candidateEncryptedSigningSecret,
      };
    }

    const pending = existing.pendingRegistration;
    const pendingSecret = existing.pendingEncryptedSigningSecret;
    if (!pending || !pendingSecret) {
      return { kind: "blocked", reason: "invalid_state" };
    }
    if (!sameWebhookRegistrationTarget(pending, desired)) {
      return { kind: "blocked", reason: "target_conflict" };
    }
    if (existing.registrationState === "create_indeterminate") {
      return { kind: "blocked", reason: "create_indeterminate" };
    }
    if (existing.registrationState === "create_dispatching") {
      if (now.getTime() - existing.updatedAt.getTime() < OFAPI_WEBHOOK_DISPATCH_STALE_MS) {
        return { kind: "blocked", reason: "operation_in_flight" };
      }
      await database.update(ofapiWebhookConfig).set({
        registrationState: "create_indeterminate",
        registrationError: "process exited while initial webhook creation was dispatching",
        updatedAt: now,
      }).where(eq(ofapiWebhookConfig.id, 1));
      return { kind: "blocked", reason: "create_indeterminate" };
    }
    if (existing.registrationState === "update_dispatching") {
      if (now.getTime() - existing.updatedAt.getTime() < OFAPI_WEBHOOK_DISPATCH_STALE_MS) {
        return { kind: "blocked", reason: "operation_in_flight" };
      }
      await database.update(ofapiWebhookConfig).set({
        registrationState: "update_prepared",
        registrationError: "retrying identical PUT after stale dispatch",
        updatedAt: now,
      }).where(eq(ofapiWebhookConfig.id, 1));
      return {
        kind: "ready",
        operation: pending.operation,
        operationId: pending.operationId,
        externalWebhookId: pending.externalWebhookId,
        endpointUrl: pending.endpointUrl,
        events: pending.events,
        encryptedSigningSecret: pendingSecret,
      };
    }
    if (existing.registrationState === "update_indeterminate") {
      await database.update(ofapiWebhookConfig).set({
        registrationState: "update_prepared",
        registrationError: null,
        updatedAt: now,
      }).where(eq(ofapiWebhookConfig.id, 1));
    }
    if (
      existing.registrationState !== "create_prepared" &&
      existing.registrationState !== "update_prepared" &&
      existing.registrationState !== "update_indeterminate"
    ) {
      return { kind: "blocked", reason: "invalid_state" };
    }
    return {
      kind: "ready",
      operation: pending.operation,
      operationId: pending.operationId,
      externalWebhookId: pending.externalWebhookId,
      endpointUrl: pending.endpointUrl,
      events: pending.events,
      encryptedSigningSecret: pendingSecret,
    };
  });
}

export async function markOfapiWebhookRegistrationDispatching(
  db: Database,
  input: { operation: OfapiWebhookRegistrationOperation; operationId: string },
) {
  const updated = await db.execute<{ id: number }>(sql`
    update ofapi_webhook_config
    set registration_state = ${`${input.operation}_dispatching`},
        updated_at = now()
    where id = 1
      and registration_state = ${`${input.operation}_prepared`}
      and pending_registration->>'operationId' = ${input.operationId}
    returning id
  `);
  return updated.rows.length > 0;
}

export async function markOfapiWebhookRegistrationIndeterminate(
  db: Database,
  input: { operation: OfapiWebhookRegistrationOperation; operationId: string; error: string },
) {
  const updated = await db.execute<{ id: number }>(sql`
    update ofapi_webhook_config
    set registration_state = ${`${input.operation}_indeterminate`},
        registration_error = ${input.error},
        updated_at = now()
    where id = 1
      and registration_state = ${`${input.operation}_dispatching`}
      and pending_registration->>'operationId' = ${input.operationId}
    returning id
  `);
  return updated.rows.length > 0;
}

export async function rejectOfapiWebhookRegistration(
  db: Database,
  input: { operation: OfapiWebhookRegistrationOperation; operationId: string; error: string },
) {
  const nextState = input.operation === "create" ? "create_failed" : "stable";
  const updated = await db.execute<{ id: number }>(sql`
    update ofapi_webhook_config
    set registration_state = ${nextState},
        pending_registration = null,
        pending_encrypted_signing_secret = null,
        registration_error = ${input.error},
        updated_at = now()
    where id = 1
      and registration_state = ${`${input.operation}_dispatching`}
      and pending_registration->>'operationId' = ${input.operationId}
    returning id
  `);
  return updated.rows.length > 0;
}

/** Owner reconciliation after independently finding the webhook created by an
 * indeterminate initial POST. The pending target and candidate secret are
 * promoted atomically; no second vendor request is issued. */
export async function reconcileOfapiWebhookRegistrationAdopt(
  db: Database,
  input: { operationId: string; externalWebhookId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const staleBefore = new Date(now.getTime() - OFAPI_WEBHOOK_DISPATCH_STALE_MS);
  const updated = await db.execute<{ id: number }>(sql`
    update ofapi_webhook_config
    set external_webhook_id = ${input.externalWebhookId},
        endpoint_url = pending_registration->>'endpointUrl',
        account_scope = pending_registration->>'accountScope',
        events = pending_registration->'events',
        encrypted_signing_secret = pending_encrypted_signing_secret,
        registration_state = 'stable',
        pending_registration = null,
        pending_encrypted_signing_secret = null,
        registration_error = null,
        updated_at = ${now}
    where id = 1
      and pending_registration->>'operation' = 'create'
      and pending_registration->>'operationId' = ${input.operationId}
      and pending_encrypted_signing_secret is not null
      and (
        registration_state = 'create_indeterminate'
        or (registration_state = 'create_dispatching' and updated_at <= ${staleBefore})
      )
    returning id
  `);
  return updated.rows.length > 0;
}

/** Owner reconciliation after independently proving that an indeterminate
 * initial POST did not create a webhook. A fresh owner registration may then
 * prepare a new create operation. */
export async function reconcileOfapiWebhookRegistrationNotCreated(
  db: Database,
  input: { operationId: string; reason: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const staleBefore = new Date(now.getTime() - OFAPI_WEBHOOK_DISPATCH_STALE_MS);
  const updated = await db.execute<{ id: number }>(sql`
    update ofapi_webhook_config
    set registration_state = 'create_failed',
        pending_registration = null,
        pending_encrypted_signing_secret = null,
        registration_error = ${`owner confirmed webhook was not created: ${input.reason}`},
        updated_at = ${now}
    where id = 1
      and pending_registration->>'operation' = 'create'
      and pending_registration->>'operationId' = ${input.operationId}
      and (
        registration_state = 'create_indeterminate'
        or (registration_state = 'create_dispatching' and updated_at <= ${staleBefore})
      )
    returning id
  `);
  return updated.rows.length > 0;
}

export async function completeOfapiWebhookRegistration(
  db: Database,
  input: {
    operation: OfapiWebhookRegistrationOperation;
    operationId: string;
    returnedExternalWebhookId: string | null;
  },
) {
  return db.transaction(async (tx) => {
    const database = tx as Database;
    await database.execute(sql`select pg_advisory_xact_lock(${OFAPI_WEBHOOK_REGISTRATION_LOCK_KEY})`);
    const current = await database.query.ofapiWebhookConfig.findFirst({
      where: eq(ofapiWebhookConfig.id, 1),
    });
    const pending = current?.pendingRegistration;
    const pendingSecret = current?.pendingEncryptedSigningSecret;
    if (
      !current ||
      current.registrationState !== `${input.operation}_dispatching` ||
      !pending ||
      pending.operationId !== input.operationId ||
      pending.operation !== input.operation ||
      !pendingSecret
    ) {
      return null;
    }
    const externalWebhookId = input.operation === "create"
      ? input.returnedExternalWebhookId
      : input.returnedExternalWebhookId ?? pending.externalWebhookId;
    if (!externalWebhookId) return null;
    const [completed] = await database.update(ofapiWebhookConfig).set({
      externalWebhookId,
      endpointUrl: pending.endpointUrl,
      accountScope: pending.accountScope,
      events: pending.events,
      encryptedSigningSecret: pendingSecret,
      previousEncryptedSigningSecret: input.operation === "update"
        ? current.encryptedSigningSecret
        : null,
      registrationState: "stable",
      pendingRegistration: null,
      pendingEncryptedSigningSecret: null,
      registrationError: null,
      updatedAt: new Date(),
    }).where(eq(ofapiWebhookConfig.id, 1)).returning();
    return completed ?? null;
  });
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
      registrationState: "stable",
      pendingRegistration: null,
      pendingEncryptedSigningSecret: null,
      registrationError: null,
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
        registrationState: "stable",
        pendingRegistration: null,
        pendingEncryptedSigningSecret: null,
        registrationError: null,
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
    .where(and(eq(pages.ofapiAccountId, ofapiAccountId), eq(pages.status, "active")));

  return row ?? null;
}

export async function listOnlyFansPagesForOfapiMapping(db: Database) {
  return db
    .select({
      id: pages.id,
      label: pages.label,
      username: pages.username,
      ofapiAccountId: pages.ofapiAccountId,
      bindingGeneration: pages.ofapiBindingGeneration,
      creatorId: pages.platformAccountId,
      metadata: pages.metadata,
    })
    .from(pages)
    .where(and(eq(pages.platform, "onlyfans"), eq(pages.status, "active")))
    .orderBy(asc(pages.label));
}

/** INITIAL-MAPPING writer (and unmapping). Replacing one non-null account with another is the verified
 * preview/apply's job (identity evidence, generation CAS, recovery); this function refuses it. Takes the
 * same advisory locks as apply and command dispatch so an unmap cannot race a send. */
export async function setPageOfapiAccountId(
  db: Database,
  input: { pageId: number; ofapiAccountId: string | null; creatorId?: string | null; evidence?: Record<string, unknown> },
) {
  await db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(9003010, ${input.pageId}::integer)`);
    await tx.execute(sql`select pg_advisory_xact_lock(9003011)`);
    const current = await tx.execute<{ ofapi_account_id: string | null; generation: number }>(sql`
      select p.ofapi_account_id, p.ofapi_binding_generation as generation from pages p where p.id = ${input.pageId} for update
    `);
    const page = current.rows[0];
    if (!page) throw new Error(`Page ${input.pageId} was not found`);
    const changed = input.ofapiAccountId !== page.ofapi_account_id;
    if (changed && input.ofapiAccountId !== null && page.ofapi_account_id !== null) {
      throw new Error(`setPageOfapiAccountId is an initial-mapping writer; page ${input.pageId} already maps "${page.ofapi_account_id}" — replace it through the verified binding preview/apply`);
    }
    if (changed && input.ofapiAccountId !== null) {
      // Custody is permanent: an account retired from page A can never be claimed by page B.
      const owner = await tx.execute<{ page_id: number }>(sql`
        select b.page_id from ofapi_account_bindings b
        where b.account_id = ${input.ofapiAccountId}
          and (b.page_id <> ${input.pageId}
            or (b.creator_id is not null and ${input.creatorId ?? null}::text is not null and b.creator_id <> ${input.creatorId ?? null}))
        union all
        select p.id from pages p where p.ofapi_account_id = ${input.ofapiAccountId} and p.id <> ${input.pageId}
        limit 1
      `);
      if (owner.rows[0]) throw new OfapiAccountCustodyConflictError(input.ofapiAccountId, input.pageId, Number(owner.rows[0].page_id));
    }
    const generation = changed ? Number(page.generation) + 1 : Number(page.generation);
    await tx.update(pages).set({
      ofapiAccountId: input.ofapiAccountId,
      ofapiBindingGeneration: generation,
      // Stage 13 invariant unchanged: OFAPI becomes the transactions writer only when none was assigned.
      ...(input.ofapiAccountId !== null ? { transactionsWriter: sql`coalesce(${pages.transactionsWriter}, 'ofapi')` } : {}),
      updatedAt: sql`now()`,
    }).where(eq(pages.id, input.pageId));
    if (!changed) return;
    if (input.ofapiAccountId === null) {
      await tx.execute(sql`
        update ofapi_account_bindings set valid_to = coalesce(valid_to, now())
        where account_id = ${page.ofapi_account_id} and page_id = ${input.pageId}
      `);
      return;
    }
    const evidence = JSON.stringify({ source: "set_page_ofapi_account_id", ...(input.evidence ?? {}) });
    await tx.execute(sql`
      insert into ofapi_account_bindings(account_id,page_id,creator_id,generation,valid_from,valid_to,evidence)
      values (${input.ofapiAccountId},${input.pageId},${input.creatorId ?? null},${generation},now(),null,${evidence}::jsonb)
      on conflict(account_id) do update set generation = excluded.generation, valid_to = null,
        creator_id = coalesce(ofapi_account_bindings.creator_id, excluded.creator_id),
        evidence = ofapi_account_bindings.evidence || excluded.evidence
    `);
  });
}

/**
 * Advances a page's OFAPI auth state from an accounts.* webhook event.
 * Forward-only by provider occurrence (receipt fallback for old envelopes): an out-of-order older event never
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
      sql`(${pages.ofapiAuthChangedAt} is null or ${pages.ofapiAuthChangedAt} < ${input.changedAt}
        or (${pages.ofapiAuthChangedAt} = ${input.changedAt} and (
          ${pages.ofapiAuthStatus} is null
          or ${pages.ofapiAuthStatus} = ${input.authStatus}
          or (${input.authStatus} in ('connected', 'reconnected', 'session_expired')
            and ${pages.ofapiAuthStatus} not in ('connected', 'reconnected', 'session_expired'))
        )))`,
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
    .where(and(isNotNull(pages.ofapiAccountId), eq(pages.status, "active")))
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

  // Same per-page index probe as getLatestSettledOfapiDmEventTimes (0184).
  const rows = await latestReceivedAtPerPage(db, pageIds, sql``);

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

export interface OfapiMoneyStreamPageInput {
  pageId: number;
  /** The page's current claim (pages.ofapi_account_id); custody history counts too. */
  ofapiAccountId: string;
  /** Only deliveries received after this instant are asked about. */
  after: Date;
}

/**
 * How far back a page's stream still vouches for it. A page the hub has not
 * heard from for a day has a broken stream, not a quiet one (prod pages get
 * 1 300-2 000 deliveries a day), and the bound also caps the probe if the
 * planner walks the journal-wide received_at index instead of the page's.
 */
export const OFAPI_MONEY_STREAM_HEARD_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface OfapiMoneyStreamPageState {
  /**
   * received_at of the newest delivery of any type settled to the page after
   * `after` and within OFAPI_MONEY_STREAM_HEARD_WINDOW_MS of now; null if none.
   */
  lastHeardAt: Date | null;
  /**
   * received_at of the earliest transactions.new delivery received after
   * `after` that is not in the page's transaction truth yet: not settled
   * (or still raw, so of unknown page), settled but not projected, or
   * projected but not yet applied by the truth ingest. Null when every such
   * delivery is in.
   */
  unappliedSince: Date | null;
}

function toDateOrNull(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Where the OFAPI money stream of each page stands, for the Spenders money
 * stamp: when the hub last heard anything for the page, and whether a
 * transactions.new delivery received since `after` is still on its way into
 * the numbers. Only transactions.new feeds transaction truth (the ingest's
 * candidates); tips.received and messages.ppv.unlocked are comparison rows.
 *
 * Every probe is bounded by an index, never by the journal's size:
 * - lastHeardAt: one backward step on ofapi_webhook_events_page_received_idx
 *   (0184). platform_account_id is written only by the settle, so the probe
 *   needs no status filter. Bounded below by `after` and the heard window: a
 *   planner that prefers the journal-wide received_at index walks at most
 *   that window.
 * - unsettled deliveries: the handful of status = 'pending' rows
 *   (ofapi_webhook_events_status_idx).
 * - settled ones not yet in truth: the page's transactions.new rows since
 *   `after` (ofapi_webhook_events_transactions_page_received_idx, 0250),
 *   each checked against the projection and the ingest's own candidate rule.
 * Page ids and bounds go in per page, not as a VALUES list, so the planner
 * sees the actual page when it picks the index.
 */
export async function getOfapiMoneyStreamStates(
  db: Database,
  pages: readonly OfapiMoneyStreamPageInput[],
): Promise<Map<number, OfapiMoneyStreamPageState>> {
  if (pages.length === 0) {
    return new Map();
  }

  const heardWindowStart = new Date(Date.now() - OFAPI_MONEY_STREAM_HEARD_WINDOW_MS);
  const statements = pages.map((page) => sql`
    select ${page.pageId}::bigint as "pageId",
      (
        select max(e.received_at)
        from ofapi_webhook_events e
        where e.platform_account_id = ${page.pageId}
          and e.received_at > ${page.after.getTime() > heardWindowStart.getTime() ? page.after : heardWindowStart}
      ) as "lastHeardAt",
      least(
        (
          select min(e.received_at)
          from ofapi_webhook_events e
          where e.status = 'pending'
            and e.received_at > ${page.after}
            and (
              e.event_type = '__raw__'
              or (
                e.event_type = 'transactions.new'
                and ${ofapiAccountBelongsToPageSql({
                  accountId: sql`e.ofapi_account_id`,
                  pageId: page.pageId,
                  pageAccountId: page.ofapiAccountId,
                })}
              )
            )
        ),
        (
          select min(${ofapiWebhookEvents.receivedAt})
          from ${ofapiWebhookEvents}
          where ${ofapiWebhookEvents.eventType} = 'transactions.new'
            and ${ofapiWebhookEvents.platformAccountId} = ${page.pageId}
            and ${ofapiWebhookEvents.receivedAt} > ${page.after}
            and (
              ${ofapiWebhookEventAwaitsSpendProjectionSql()}
              or exists (
                select 1 from ${ofapiSpendProjectionEvents}
                where ${ofapiSpendProjectionEvents.journalId} = ${ofapiWebhookEvents.id}
                  and ${ofapiSpendProjectionAwaitsTruthIngestSql()}
              )
            )
        )
      ) as "unappliedSince"
  `);

  const result = await db.execute<{
    pageId: number | string;
    lastHeardAt: Date | string | null;
    unappliedSince: Date | string | null;
  }>(sql.join(statements, sql` union all `));

  const states = new Map<number, OfapiMoneyStreamPageState>();
  for (const row of result.rows) {
    states.set(Number(row.pageId), {
      lastHeardAt: toDateOrNull(row.lastHeardAt),
      unappliedSince: toDateOrNull(row.unappliedSince),
    });
  }
  return states;
}

export type LinkStatKind = "tracking" | "trial";

/** One row of page_link_stat_runs is one ATTEMPT to read a (page, kind) list.
 * 'complete' = the list was read whole in one response with nothing dropped
 * (the only absence-proving status); 'partial' = read whole, with a caveat in
 * `reason`; 'truncated' = the walk was stopped; 'failed' = the request or the
 * write failed; 'skipped' = no attempt was made. Only the first two carry
 * snapshots. */
export type LinkStatRunStatus = "complete" | "partial" | "truncated" | "failed" | "skipped";

export interface InsertLinkStatRunInput {
  platformAccountId: number;
  linkKind: LinkStatKind;
  status: LinkStatRunStatus;
  pulledAt: Date;
  apiPages: number;
  rawItems: number;
  writtenRows: number;
  /** Why the row is not a clean 'complete' (caveats, block, error, skip). */
  reason?: string | null;
  /** The scheduled window the attempt belongs to. `attempt` is numbered
   * within it; without a window the row is attempt 1. */
  windowAt?: Date | null;
  /** The OFAPI account the page was bound to when the attempt was made. */
  ofapiAccountId?: string | null;
}

export interface InsertLinkStatSnapshotInput {
  platformAccountId: number;
  linkKind: LinkStatKind;
  platformLinkId: string;
  name: string | null;
  url: string | null;
  linkCreatedAt: Date | null;
  linkEndsAt: Date | null;
  isFinished: boolean | null;
  clicksCount: number;
  claimsCount: number | null;
  subscribersCount: number;
  // null = vendor value unknown (revenue block missing, still computing, or
  // unparseable) — deliberately distinct from a real zero.
  spendersCount: number | null;
  revenueGrossMills: bigint | null;
  revenueIsLoading: boolean | null;
  revenueCalculatedAt: Date | null;
}

/** `reason` is operator-facing text and, on a failure, a vendor or driver
 * error message: bound it so one pathological error cannot bloat the series. */
const LINK_STAT_RUN_REASON_MAX_LENGTH = 500;

/** Writes one attempt row. `attempt` is the row's ordinal within its
 * (page, kind, window), taken from the rows already there — so a scheduled
 * run, a retry, a post-rebind run and the monitor's `window_missed` row number
 * themselves without telling each other. Two writers racing on one pair can
 * tie; nothing keys on the number. Snapshot-carrying statuses go through
 * insertLinkStatRunWithSnapshots. */
export async function insertLinkStatRun(
  db: Database,
  input: InsertLinkStatRunInput,
): Promise<{ id: number; attempt: number }> {
  const windowAt = input.windowAt ?? null;
  const reason = input.reason ?? null;
  const [row] = await db
    .insert(pageLinkStatRuns)
    .values({
      platformAccountId: input.platformAccountId,
      linkKind: input.linkKind,
      status: input.status,
      pulledAt: input.pulledAt,
      apiPages: input.apiPages,
      rawItems: input.rawItems,
      writtenRows: input.writtenRows,
      reason: reason === null ? null : reason.slice(0, LINK_STAT_RUN_REASON_MAX_LENGTH),
      windowAt,
      attempt: windowAt === null
        ? 1
        : sql<number>`(
            select least(coalesce(max(prior.attempt), 0) + 1, 32767)::smallint
            from page_link_stat_runs prior
            where prior.platform_account_id = ${input.platformAccountId}
              and prior.link_kind = ${input.linkKind}
              and prior.window_at = ${windowAt.toISOString()}::timestamptz
          )`,
      ofapiAccountId: input.ofapiAccountId ?? null,
    })
    .returning({ id: pageLinkStatRuns.id, attempt: pageLinkStatRuns.attempt });
  if (!row) {
    throw new Error("insertLinkStatRun returned no row");
  }
  return row;
}

// node-postgres extended protocol caps bind parameters at 65535; with 16
// columns per row a single VALUES insert breaks past 4095 rows. Chunk well
// below that; callers wrap this in a transaction when atomicity matters.
const LINK_STAT_SNAPSHOT_INSERT_CHUNK = 1000;

async function insertLinkStatSnapshots(
  db: Database,
  runId: number,
  rows: InsertLinkStatSnapshotInput[],
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  let insertedTotal = 0;
  for (let start = 0; start < rows.length; start += LINK_STAT_SNAPSHOT_INSERT_CHUNK) {
    const chunk = rows.slice(start, start + LINK_STAT_SNAPSHOT_INSERT_CHUNK);
    const inserted = await db
      .insert(pageLinkStatSnapshots)
      .values(chunk.map((row) => ({
        runId,
        platformAccountId: row.platformAccountId,
        linkKind: row.linkKind,
        platformLinkId: row.platformLinkId,
        name: row.name,
        url: row.url,
        linkCreatedAt: row.linkCreatedAt,
        linkEndsAt: row.linkEndsAt,
        isFinished: row.isFinished,
        clicksCount: row.clicksCount,
        claimsCount: row.claimsCount,
        subscribersCount: row.subscribersCount,
        spendersCount: row.spendersCount,
        revenueGrossMills: row.revenueGrossMills,
        revenueIsLoading: row.revenueIsLoading,
        revenueCalculatedAt: row.revenueCalculatedAt,
      })))
      .returning({ id: pageLinkStatSnapshots.id });
    insertedTotal += inserted.length;
  }
  return insertedTotal;
}

/** Atomic run + snapshots: a 'complete'/'partial' run row must never exist
 * without its snapshot rows (that state reads as mass link deletion
 * downstream), so both inserts commit or neither does. */
export async function insertLinkStatRunWithSnapshots(
  db: Database,
  run: InsertLinkStatRunInput,
  rows: InsertLinkStatSnapshotInput[],
): Promise<{ runId: number; writtenRows: number }> {
  if (rows.length > 0 && run.status !== "complete" && run.status !== "partial") {
    throw new Error(`link-stat run status ${run.status} cannot carry snapshots`);
  }
  return db.transaction(async (tx) => {
    const dbTx = tx as Database;
    const inserted = await insertLinkStatRun(dbTx, run);
    const writtenRows = await insertLinkStatSnapshots(dbTx, inserted.id, rows);
    if (writtenRows !== rows.length) {
      throw new Error(
        `link-stat snapshot insert wrote ${writtenRows} of ${rows.length} rows`,
      );
    }
    return { runId: inserted.id, writtenRows };
  });
}

export async function listLinkStatRuns(
  db: Database,
  input: { platformAccountId: number; linkKind?: LinkStatKind },
) {
  const conditions = [eq(pageLinkStatRuns.platformAccountId, input.platformAccountId)];
  if (input.linkKind !== undefined) {
    conditions.push(eq(pageLinkStatRuns.linkKind, input.linkKind));
  }
  return db
    .select()
    .from(pageLinkStatRuns)
    .where(and(...conditions))
    .orderBy(desc(pageLinkStatRuns.pulledAt), desc(pageLinkStatRuns.id));
}

/** Latest FINISHED walk (complete or partial, never truncated, failed or
 * skipped) for (page, kind) — the baseline the inventory-vanished guard
 * compares a new empty walk against. Including partial runs makes the guard
 * converge (the second consecutive empty walk sees an empty baseline and
 * proves absence) and closes the reverse hole (a non-empty partial baseline
 * still flags a sudden wipe as suspicious).
 *
 * With `ofapiAccountId` the baseline is the latest finished walk made UNDER
 * THAT ACCOUNT: the stored lists are the vendor's cache of one connection, so
 * what another account showed says nothing about this one's emptiness. Rows
 * whose account is unknown (null) never match an account. */
export async function findLatestFinishedLinkStatRun(
  db: Database,
  input: { platformAccountId: number; linkKind: LinkStatKind; ofapiAccountId?: string },
) {
  const [row] = await db
    .select()
    .from(pageLinkStatRuns)
    .where(and(
      eq(pageLinkStatRuns.platformAccountId, input.platformAccountId),
      eq(pageLinkStatRuns.linkKind, input.linkKind),
      inArray(pageLinkStatRuns.status, ["complete", "partial"]),
      ...(input.ofapiAccountId === undefined
        ? []
        : [eq(pageLinkStatRuns.ofapiAccountId, input.ofapiAccountId)]),
    ))
    .orderBy(desc(pageLinkStatRuns.pulledAt), desc(pageLinkStatRuns.id))
    .limit(1);
  return row ?? null;
}

/** Latest finished walk that actually SAW links (rawItems > 0). A page with
 * no such run has never demonstrated a non-empty inventory — an empty walk
 * there is unverifiable (cold vendor cache?) and must never mint an
 * absence-proving 'complete'. With `ofapiAccountId` the question is asked of
 * that account alone (see findLatestFinishedLinkStatRun). */
export async function findLatestNonEmptyFinishedLinkStatRun(
  db: Database,
  input: { platformAccountId: number; linkKind: LinkStatKind; ofapiAccountId?: string },
) {
  const [row] = await db
    .select()
    .from(pageLinkStatRuns)
    .where(and(
      eq(pageLinkStatRuns.platformAccountId, input.platformAccountId),
      eq(pageLinkStatRuns.linkKind, input.linkKind),
      inArray(pageLinkStatRuns.status, ["complete", "partial"]),
      gt(pageLinkStatRuns.rawItems, 0),
      ...(input.ofapiAccountId === undefined
        ? []
        : [eq(pageLinkStatRuns.ofapiAccountId, input.ofapiAccountId)]),
    ))
    .orderBy(desc(pageLinkStatRuns.pulledAt), desc(pageLinkStatRuns.id))
    .limit(1);
  return row ?? null;
}

/** Has (page, kind) shown links under an account OTHER than this one — a
 * finished non-empty walk whose account differs or is unknown? That is what
 * makes the first non-empty walk under an account a binding change rather
 * than a page's first inventory. */
export async function hasNonEmptyLinkStatRunUnderAnotherAccount(
  db: Database,
  input: { platformAccountId: number; linkKind: LinkStatKind; ofapiAccountId: string },
): Promise<boolean> {
  const [row] = await db
    .select({ id: pageLinkStatRuns.id })
    .from(pageLinkStatRuns)
    .where(and(
      eq(pageLinkStatRuns.platformAccountId, input.platformAccountId),
      eq(pageLinkStatRuns.linkKind, input.linkKind),
      inArray(pageLinkStatRuns.status, ["complete", "partial"]),
      gt(pageLinkStatRuns.rawItems, 0),
      sql`${pageLinkStatRuns.ofapiAccountId} is distinct from ${input.ofapiAccountId}`,
    ))
    .limit(1);
  return row !== undefined;
}

/**
 * The ONE definition of a window's usable result for a (page, kind): the row
 * gives the series a point a reader can use. `run` is the SQL alias of a
 * page_link_stat_runs row.
 *
 *   - `complete` — a whole read. An empty one is the confirmed absence the
 *     reconcile mints only after THE SAME OFAPI account showed links and then
 *     read empty twice (the per-account guard): "every link was deleted" is a
 *     point of the series, not a missing one. A cold cache can never get here
 *     — under a new account its empty reads stay `partial`;
 *   - `partial` that wrote snapshots;
 *   - an empty `partial` on a pair that had NEVER shown a link, under any
 *     OFAPI account (rows of unknown account included), before this row,
 *     AND whose emptiness has lasted: an earlier empty read of the pair at
 *     least 24 hours before this one. Such a pair stays `partial`
 *     (empty_unverified) for good — lora-of's trial links, 154 runs on
 *     production since 2026-07-22, none ever non-empty — and that is its
 *     steady state, not a missing point that would retry every window and
 *     page as stale forever. The first empty read of a pair, and every empty
 *     read in the 24 hours after it, is not a result: a page connected for
 *     the first time may well have links while the vendor's stored cache is
 *     still cold, and "0 links" must not pass for a reading until the
 *     emptiness has persisted. Until then the pair is retried and ages
 *     toward series_stale like any pair without a result.
 *
 * Everything else is an attempt without a result: `failed`, `skipped`,
 * `truncated`, a `partial` that wrote nothing (every item dropped), and an
 * empty `partial` on a pair that has had links under some account — a cold
 * cache after a rebind (`empty_unverified` under the new account), an
 * inventory that vanished and is not confirmed yet (`inventory_vanished`).
 * The presence of such a row neither cancels a retry of its window nor
 * advances the freshness of the series.
 */
/** How long a never-linked pair must keep reading empty before its empty
 * reads count as results (linkStatRunUsableResultSql). */
export const LINK_STAT_EMPTY_PERSISTENCE_HOURS = 24;

export function linkStatRunUsableResultSql(run: SQL): SQL {
  return sql`(
    ${run}.status = 'complete'
    or (${run}.status = 'partial' and ${run}.written_rows > 0)
    or (${run}.status = 'partial' and ${run}.raw_items = 0
      and not exists (
        select 1 from page_link_stat_runs seen
        where seen.platform_account_id = ${run}.platform_account_id
          and seen.link_kind = ${run}.link_kind
          and seen.status in ('complete', 'partial')
          and seen.raw_items > 0
          and seen.id < ${run}.id
      )
      and exists (
        select 1 from page_link_stat_runs earlier
        where earlier.platform_account_id = ${run}.platform_account_id
          and earlier.link_kind = ${run}.link_kind
          and earlier.status in ('complete', 'partial')
          and earlier.raw_items = 0
          and earlier.id < ${run}.id
          and earlier.pulled_at <= ${run}.pulled_at - interval '${sql.raw(String(LINK_STAT_EMPTY_PERSISTENCE_HOURS))} hours'
      ))
  )`;
}

export interface LinkStatWindowPairState {
  platformAccountId: number;
  linkKind: LinkStatKind;
  /** Rows the pair has in the window, of any status. */
  attempts: number;
  /** Of those, the rows made under the page's CURRENT OFAPI binding (its
   * `ofapi_account_id` now). Attempts of an earlier binding stay in the
   * history but do not use up the retries of the binding that replaced it. */
  attemptsUnderCurrentBinding: number;
  /** At least one of them is a usable result (linkStatRunUsableResultSql). */
  hasUsableResult: boolean;
  lastStatus: LinkStatRunStatus;
  lastReason: string | null;
}

/** What each (page, kind) has in one scheduled window. A pair with no row in
 * the window is absent from the result: the caller holds the list of pairs it
 * expects. */
export async function listLinkStatWindowPairStates(
  db: Database,
  input: { windowAt: Date },
): Promise<LinkStatWindowPairState[]> {
  const run = sql.raw("r");
  const result = await db.execute<{
    platformAccountId: number | string;
    linkKind: LinkStatKind;
    attempts: number | string;
    attemptsUnderCurrentBinding: number | string;
    hasUsableResult: boolean;
    lastStatus: LinkStatRunStatus;
    lastReason: string | null;
  }>(sql`
    select r.platform_account_id as "platformAccountId",
           r.link_kind as "linkKind",
           count(*)::int as "attempts",
           (count(*) filter (where r.ofapi_account_id is not distinct from p.ofapi_account_id))::int
             as "attemptsUnderCurrentBinding",
           bool_or(${linkStatRunUsableResultSql(run)}) as "hasUsableResult",
           (array_agg(r.status order by r.attempt desc, r.id desc))[1] as "lastStatus",
           (array_agg(r.reason order by r.attempt desc, r.id desc))[1] as "lastReason"
    from page_link_stat_runs r
    join pages p on p.id = r.platform_account_id
    where r.window_at = ${input.windowAt.toISOString()}::timestamptz
    group by r.platform_account_id, r.link_kind, p.ofapi_account_id
    order by r.platform_account_id, r.link_kind
  `);
  return result.rows.map((row) => ({
    platformAccountId: Number(row.platformAccountId),
    linkKind: row.linkKind,
    attempts: Number(row.attempts),
    attemptsUnderCurrentBinding: Number(row.attemptsUnderCurrentBinding),
    hasUsableResult: row.hasUsableResult === true,
    lastStatus: row.lastStatus,
    lastReason: row.lastReason,
  }));
}

export async function listLinkStatSnapshots(db: Database, input: { runId: number }) {
  return db
    .select()
    .from(pageLinkStatSnapshots)
    .where(eq(pageLinkStatSnapshots.runId, input.runId))
    .orderBy(pageLinkStatSnapshots.platformLinkId);
}
