// Shadow-only spend projection from OFAPI webhook journal rows (ChatGoose C3).
// By itself this writes comparison rows only. A separate boot flag may then
// apply missing transaction rows from this projection into core truth; desktop
// spend-sweep cadence remains unchanged until production comparison matches.

import {
  getOfapiWebhookEventById,
  listOfapiWebhookEventsForSpendProjection,
  upsertOfapiSpendProjectionEvent,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  asRecord,
  extractMessageIdFromNotification,
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
  OFAPI_TIPS_RECEIVED_BLOCKED_REASON,
  ofapiSpendProjectionTransactionDomainKey,
  type CoreSpendProjectionEvent,
  type OfapiSpendProjectionContext,
  type OfapiSpendProjectionEventType,
  type OfapiSpendProjectionResult,
} from "./ofapi-spend-projection-contract.ts";

export const OFAPI_SPEND_PROJECTION_EVENT_TYPES = [
  "transactions.new",
  "messages.ppv.unlocked",
  "tips.received",
] as const;

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

function blockedOccurredAt(payload: Record<string, unknown>, fallback: Date): Date {
  const raw = payload.createdAt ?? payload.created_at;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fallback;
  }
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw.trim())
    ? `${raw.trim().replace(" ", "T")}Z`
    : raw.trim();
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
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
    eventStatus: event.status,
  });
}

async function writeBlockedTipsEvent(
  app: AppContext,
  context: OfapiSpendProjectionContext,
  payload: Record<string, unknown>,
  domainKey: string,
  receivedAt: Date,
) {
  await upsertOfapiSpendProjectionEvent(app.db, {
    domainKey,
    projectionStatus: "blocked",
    blockedReason: OFAPI_TIPS_RECEIVED_BLOCKED_REASON,
    sourceEventType: "tips.received",
    sourceIdempotencyKey: context.sourceIdempotencyKey,
    journalId: context.journalId,
    fanoutSeq: context.fanoutSeq,
    ofapiAccountId: context.ofapiAccountId,
    pageId: context.pageId,
    fanPlatformUserId: notificationChatId(payload),
    transactionId: null,
    messageId: extractMessageIdFromNotification(payload) ?? null,
    occurredAt: blockedOccurredAt(payload, receivedAt),
    category: "tip",
    currency: "USD",
    grossAmountMills: null,
    creatorNetAmountMills: null,
    eventStatus: null,
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
    await writeProjectedEvent(app, domainKey, result.event);
    return;
  }

  if (result.status === "blocked") {
    if (!domainKey) {
      await writeSkippedEvent(app, row, context, eventType, result.reason);
      return;
    }
    await writeBlockedTipsEvent(app, context, payload, domainKey, row.receivedAt);
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
    eventTypes: OFAPI_SPEND_PROJECTION_EVENT_TYPES,
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
