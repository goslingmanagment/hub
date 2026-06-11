import { and, asc, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { ofapiWebhookConfig, ofapiWebhookEvents, pages } from "../schema.ts";

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
