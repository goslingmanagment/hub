// Shadow-only spend projection from OFAPI webhook journal rows (ChatGoose C3).
// By itself this writes comparison rows only. A separate boot flag may then
// apply missing transaction rows from this projection into core truth; desktop
// spend-sweep cadence remains unchanged until production comparison matches.

import {
  getOfapiWebhookEventById,
  listOfapiWebhookEventsForSpendProjection,
  OFAPI_SPEND_PROJECTION_EVENT_TYPES,
  upsertOfapiSpendProjectionEvent,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  asRecord,
  idToString,
  notificationChatId,
  ofapiWebhookEnvelopeSchema,
} from "./ofapi-payloads.ts";
import {
  applyOfapiSpendProjectionTransactions,
  isOfapiSpendTransactionIngestEnabled,
} from "./ofapi-spend-transaction-ingest.ts";
import {
  mapOfapiTransactionStatusForSpendProjection,
  mapOfapiWebhookToSpendProjectionEvent,
  ofapiSpendProjectionTransactionDomainKey,
  type CoreSpendProjectionEvent,
  type OfapiSpendProjectionContext,
  type OfapiSpendProjectionEventType,
  type OfapiSpendProjectionResult,
} from "./ofapi-spend-projection-contract.ts";

/** Re-exported, never redefined: the list and the query that filters on it now
 *  live in one place (packages/db's ofapi repository), because migration 0143's
 *  partial index repeats it as a predicate and a second copy here would be a
 *  drift the planner reports only as a slow query. */
export { OFAPI_SPEND_PROJECTION_EVENT_TYPES };

const OFAPI_SPEND_PROJECTION_SWEEP_LIMIT = 200;

type OfapiSpendProjectionEventTypeConst = (typeof OFAPI_SPEND_PROJECTION_EVENT_TYPES)[number];

interface OfapiSpendProjectableRow {
  id: number;
  idempotencyKey: string;
  eventType: string;
  ofapiAccountId: string | null;
  platformAccountId: number | null;
  payload: Record<string, unknown>;
  fanoutSeq: number | null;
  status: string;
  receivedAt: Date;
}

export function isOfapiSpendProjectionShadowEnabled(
  config?: Pick<AppContext["config"], "ofapiSpendProjectionShadowEnabled">,
) {
  return config?.ofapiSpendProjectionShadowEnabled === true;
}

export function isOfapiSpendProjectionEventType(
  eventType: string,
): eventType is OfapiSpendProjectionEventTypeConst {
  return (OFAPI_SPEND_PROJECTION_EVENT_TYPES as readonly string[]).includes(eventType);
}

function parseOccurredAt(value: string): Date {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function domainKeyFor(
  eventType: OfapiSpendProjectionEventType,
  ofapiAccountId: string,
  payload: Record<string, unknown>,
): string | null {
  switch (eventType) {
    case "transactions.new": {
      const transactionId = idToString(payload.id);
      if (!transactionId) {
        return null;
      }

      const status = mapOfapiTransactionStatusForSpendProjection(payload.status);
      return ofapiSpendProjectionTransactionDomainKey({ ofapiAccountId, transactionId, status });
    }
    case "messages.ppv.unlocked": {
      const notificationId = idToString(payload.id);
      const fanId = notificationChatId(payload);
      return notificationId && fanId
        ? `ofapi:${ofapiAccountId}:ppv:${notificationId}:${fanId}`
        : null;
    }
    case "tips.received": {
      const tipId = idToString(payload.id);
      return tipId ? `ofapi:${ofapiAccountId}:tip:${tipId}` : null;
    }
  }
}

function projectionContext(row: OfapiSpendProjectableRow): OfapiSpendProjectionContext | null {
  if (!row.ofapiAccountId || row.platformAccountId === null) {
    return null;
  }
  return {
    sourceIdempotencyKey: row.idempotencyKey,
    journalId: row.id,
    fanoutSeq: row.fanoutSeq,
    ofapiAccountId: row.ofapiAccountId,
    pageId: row.platformAccountId,
  };
}

async function writeProjectedEvent(
  app: AppContext,
  domainKey: string,
  event: CoreSpendProjectionEvent,
) {
  await upsertOfapiSpendProjectionEvent(app.db, {
    domainKey,
    projectionStatus: "projected",
    sourceEventType: event.sourceEventType,
    sourceIdempotencyKey: event.sourceIdempotencyKey,
    journalId: event.journalId,
    fanoutSeq: event.fanoutSeq,
    ofapiAccountId: event.ofapiAccountId,
    pageId: event.pageId,
    fanPlatformUserId: event.fanPlatformUserId,
    transactionId: event.transactionId,
    messageId: event.messageId,
    occurredAt: parseOccurredAt(event.occurredAt),
    category: event.category,
    currency: event.currency,
    grossAmountMills: event.grossAmountMills === null ? null : BigInt(event.grossAmountMills),
    creatorNetAmountMills: event.creatorNetAmountMills === null
      ? null
      : BigInt(event.creatorNetAmountMills),
    platformFeeMills: event.platformFeeMills === null ? null : BigInt(event.platformFeeMills),
    vatAmountMills: event.vatAmountMills === null ? null : BigInt(event.vatAmountMills),
    taxAmountMills: event.taxAmountMills === null ? null : BigInt(event.taxAmountMills),
    eventStatus: event.status,
  });
}

async function writeSkippedEvent(
  app: AppContext,
  row: OfapiSpendProjectableRow,
  context: OfapiSpendProjectionContext,
  eventType: OfapiSpendProjectionEventType,
  reason: string,
) {
  await upsertOfapiSpendProjectionEvent(app.db, {
    domainKey: `ofapi:${context.ofapiAccountId}:journal:${row.id}`,
    projectionStatus: "skipped",
    blockedReason: reason,
    sourceEventType: eventType,
    sourceIdempotencyKey: context.sourceIdempotencyKey,
    journalId: context.journalId,
    fanoutSeq: context.fanoutSeq,
    ofapiAccountId: context.ofapiAccountId,
    pageId: context.pageId,
    occurredAt: row.receivedAt,
  });
}

async function applySpendProjectionResult(
  app: AppContext,
  row: OfapiSpendProjectableRow,
  payload: Record<string, unknown>,
  context: OfapiSpendProjectionContext,
  result: OfapiSpendProjectionResult,
) {
  const eventType = row.eventType as OfapiSpendProjectionEventType;
  const domainKey = domainKeyFor(eventType, context.ofapiAccountId, payload);

  if (result.status === "projectable") {
    if (!domainKey) {
      await writeSkippedEvent(app, row, context, eventType, "missing_domain_key");
      return;
    }
    // Stage 14: a legacy blocked tips row shares this domain key
    // (ofapi:{acct}:tip:{id}), so the upsert flips it blocked -> projected.
    await writeProjectedEvent(app, domainKey, result.event);
    return;
  }

  await writeSkippedEvent(app, row, context, eventType, result.reason);
}

export async function projectOfapiSpendEvent(
  app: AppContext,
  row: OfapiSpendProjectableRow,
) {
  if (!isOfapiSpendProjectionEventType(row.eventType)) {
    return { status: "skipped" as const, reason: `Event type "${row.eventType}" is not projected` };
  }
  if (row.status === "pending") {
    return { status: "skipped" as const, reason: "Journal row is not settled" };
  }

  const context = projectionContext(row);
  if (!context) {
    return { status: "skipped" as const, reason: "Journal row has no mapped OFAPI page" };
  }

  const envelope = ofapiWebhookEnvelopeSchema.safeParse(row.payload);
  if (!envelope.success) {
    await writeSkippedEvent(
      app,
      row,
      context,
      row.eventType,
      "Journaled payload is not a valid OFAPI envelope",
    );
    return { status: "skipped" as const, reason: "Journaled payload is not a valid OFAPI envelope" };
  }

  const payload = asRecord(envelope.data.payload) ?? {};
  const result = mapOfapiWebhookToSpendProjectionEvent({
    context,
    eventType: row.eventType,
    payload,
  });
  await applySpendProjectionResult(app, row, payload, context, result);
  return result.status === "projectable"
    ? { status: "projected" as const }
    : result;
}

export async function runOfapiSpendProjectionForSettledRow(
  app: AppContext,
  row: Pick<OfapiSpendProjectableRow, "id" | "eventType">,
) {
  if (
    !isOfapiSpendProjectionShadowEnabled(app.config) ||
    !isOfapiSpendProjectionEventType(row.eventType)
  ) {
    return;
  }

  const fresh = await getOfapiWebhookEventById(app.db, row.id);
  if (!fresh) {
    return;
  }

  try {
    await projectOfapiSpendEvent(app, fresh);
    if (isOfapiSpendTransactionIngestEnabled(app.config)) {
      const applied = await applyOfapiSpendProjectionTransactions(app);
      if (applied > 0) {
        app.logger.info(
          { applied },
          "OFAPI spend transaction ingest applied projected transactions",
        );
      }
    }
  } catch (error) {
    app.logger.warn(
      { err: error, eventId: row.id, eventType: row.eventType },
      "OFAPI spend shadow projection failed; the sweep will retry",
    );
  }
}

export async function sweepOfapiSpendProjections(app: AppContext) {
  if (!isOfapiSpendProjectionShadowEnabled(app.config)) {
    return 0;
  }

  const rows = await listOfapiWebhookEventsForSpendProjection(app.db, {
    limit: OFAPI_SPEND_PROJECTION_SWEEP_LIMIT,
  });

  for (const row of rows) {
    await runOfapiSpendProjectionForSettledRow(app, row);
  }

  if (isOfapiSpendTransactionIngestEnabled(app.config)) {
    const applied = await applyOfapiSpendProjectionTransactions(app);
    if (applied > 0) {
      app.logger.info(
        { applied },
        "OFAPI spend transaction ingest applied projected transactions",
      );
    }
  }

  return rows.length;
}
