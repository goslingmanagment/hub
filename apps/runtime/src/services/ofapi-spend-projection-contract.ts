import { dollarsToMills } from "@agency_hub_core/shared";

import {
  asRecord,
  extractMessageIdFromNotification,
  idToString,
  notificationChatId,
} from "./ofapi-payloads.ts";

export const OFAPI_TIPS_RECEIVED_BLOCKED_REASON = "tips_received_live_fixture_required";

export type OfapiSpendProjectionEventType =
  | "transactions.new"
  | "tips.received"
  | "messages.ppv.unlocked";

export type OfapiSpendProjectionCategory =
  | "message"
  | "tip"
  | "subscription"
  | "post"
  | "stream"
  | "other";

export type OfapiSpendProjectionStatus =
  | "pending"
  | "settled"
  | "reversed"
  | "estimated";

export interface OfapiSpendProjectionContext {
  sourceIdempotencyKey: string;
  journalId: number;
  fanoutSeq: number | null;
  ofapiAccountId: string;
  pageId: number;
}

export interface CoreSpendProjectionEvent {
  source: "ofapi_webhook";
  sourceEventType: OfapiSpendProjectionEventType;
  sourceIdempotencyKey: string;
  journalId: number;
  fanoutSeq: number | null;
  platform: "onlyfans";
  ofapiAccountId: string;
  pageId: number;
  fanPlatformUserId: string;
  transactionId: string | null;
  messageId: string | null;
  occurredAt: string;
  category: OfapiSpendProjectionCategory;
  currency: "USD";
  grossAmountMills: number | null;
  creatorNetAmountMills: number | null;
  status: OfapiSpendProjectionStatus;
}

export type OfapiSpendProjectionResult =
  | { status: "projectable"; event: CoreSpendProjectionEvent }
  | { status: "blocked"; reason: typeof OFAPI_TIPS_RECEIVED_BLOCKED_REASON }
  | { status: "skipped"; reason: string };

function parseDate(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const trimmed = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseDollarMills(value: unknown): number | null {
  if (
    (typeof value !== "number" || !Number.isFinite(value)) &&
    typeof value !== "string"
  ) {
    return null;
  }

  try {
    return Number(dollarsToMills(value));
  } catch {
    return null;
  }
}

function parseAmountToken(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(/\$([0-9]+(?:\.[0-9]{1,3})?)/);
  return match?.[1] ? parseDollarMills(match[1]) : null;
}

function ppvEstimatedAmountMills(payload: Record<string, unknown>): number | null {
  const replacePairs = asRecord(payload.replacePairs);
  const explicitAmount = replacePairs ? parseAmountToken(replacePairs["{AMOUNT}"]) : null;
  return explicitAmount ?? parseAmountToken(payload.text);
}

function mapTransactionCategory(rawType: unknown): OfapiSpendProjectionCategory {
  switch (typeof rawType === "string" ? rawType.toLowerCase() : "") {
    case "message":
    case "paid_message":
    case "paided_message":
      return "message";
    case "tip":
    case "tips":
      return "tip";
    case "subscription":
    case "subscribe":
    case "recurring_subscription":
      return "subscription";
    case "post":
    case "post_purchase":
      return "post";
    case "stream":
    case "live_stream":
      return "stream";
    default:
      return "other";
  }
}

function mapTransactionStatus(rawStatus: unknown): Exclude<OfapiSpendProjectionStatus, "estimated"> {
  switch (typeof rawStatus === "string" ? rawStatus.toLowerCase() : "") {
    case "done":
    case "paid":
    case "posted":
    case "settled":
    case "completed":
      return "settled";
    case "refunded":
    case "reversed":
    case "chargeback":
    case "chargebacked":
    case "cancelled":
    case "canceled":
      return "reversed";
    case "loading":
    case "pending":
    default:
      return "pending";
  }
}

function baseEvent(
  context: OfapiSpendProjectionContext,
  sourceEventType: OfapiSpendProjectionEventType,
): Omit<
  CoreSpendProjectionEvent,
  | "sourceEventType"
  | "fanPlatformUserId"
  | "transactionId"
  | "messageId"
  | "occurredAt"
  | "category"
  | "currency"
  | "grossAmountMills"
  | "creatorNetAmountMills"
  | "status"
> & { sourceEventType: OfapiSpendProjectionEventType } {
  return {
    source: "ofapi_webhook",
    sourceEventType,
    sourceIdempotencyKey: context.sourceIdempotencyKey,
    journalId: context.journalId,
    fanoutSeq: context.fanoutSeq,
    platform: "onlyfans",
    ofapiAccountId: context.ofapiAccountId,
    pageId: context.pageId,
  };
}

function mapTransactionsNew(
  context: OfapiSpendProjectionContext,
  payload: Record<string, unknown>,
): OfapiSpendProjectionResult {
  const transactionId = idToString(payload.id);
  const fanPlatformUserId = idToString(asRecord(payload.fan)?.id);
  const occurredAt = parseDate(payload.created_at);
  const grossAmountMills = parseDollarMills(payload.amount);
  const creatorNetAmountMills = parseDollarMills(payload.net_amount);
  const currency = typeof payload.currency === "string" ? payload.currency.toUpperCase() : null;

  if (!transactionId) {
    return { status: "skipped", reason: "transactions_new_missing_transaction_id" };
  }
  if (!fanPlatformUserId) {
    return { status: "skipped", reason: "transactions_new_missing_fan_id" };
  }
  if (!occurredAt) {
    return { status: "skipped", reason: "transactions_new_missing_occurred_at" };
  }
  if (currency !== "USD") {
    return { status: "skipped", reason: "transactions_new_unsupported_currency" };
  }

  return {
    status: "projectable",
    event: {
      ...baseEvent(context, "transactions.new"),
      fanPlatformUserId,
      transactionId,
      messageId: null,
      occurredAt,
      category: mapTransactionCategory(payload.type),
      currency: "USD",
      grossAmountMills,
      creatorNetAmountMills,
      status: mapTransactionStatus(payload.status),
    },
  };
}

function mapPpvUnlocked(
  context: OfapiSpendProjectionContext,
  payload: Record<string, unknown>,
): OfapiSpendProjectionResult {
  const notificationId = idToString(payload.id);
  const fanPlatformUserId = notificationChatId(payload);
  const occurredAt = parseDate(payload.createdAt);

  if (!notificationId) {
    return { status: "skipped", reason: "ppv_unlocked_missing_notification_id" };
  }
  if (!fanPlatformUserId) {
    return { status: "skipped", reason: "ppv_unlocked_missing_fan_id" };
  }
  if (!occurredAt) {
    return { status: "skipped", reason: "ppv_unlocked_missing_occurred_at" };
  }

  return {
    status: "projectable",
    event: {
      ...baseEvent(context, "messages.ppv.unlocked"),
      fanPlatformUserId,
      transactionId: null,
      messageId: extractMessageIdFromNotification(payload) ?? null,
      occurredAt,
      category: "message",
      currency: "USD",
      grossAmountMills: ppvEstimatedAmountMills(payload),
      creatorNetAmountMills: null,
      status: "estimated",
    },
  };
}

export function mapOfapiWebhookToSpendProjectionEvent(input: {
  context: OfapiSpendProjectionContext;
  eventType: string;
  payload: Record<string, unknown>;
}): OfapiSpendProjectionResult {
  switch (input.eventType) {
    case "transactions.new":
      return mapTransactionsNew(input.context, input.payload);
    case "messages.ppv.unlocked":
      return mapPpvUnlocked(input.context, input.payload);
    case "tips.received":
      return { status: "blocked", reason: OFAPI_TIPS_RECEIVED_BLOCKED_REASON };
    default:
      return { status: "skipped", reason: "unsupported_spend_projection_event_type" };
  }
}
