import {
  appendProjectionOnlyDomainEvents,
  hashOfapiCaptureValue,
  type Database,
  type DomainEventInput,
} from "@agency_hub_core/db";
import { millsFromDollars } from "@agency_hub_core/shared";

const SIGNED_BIGINT_MAX_MILLS = 9_223_372_036_854_775_807n;
const MAX_DOLLAR_DECIMAL_LENGTH = 20;

interface MaterialPageInput {
  accountId: number;
  observationId: number;
  observationReceivedAt: Date;
  chatId: string;
  originClass: "capture_background" | "capture_interactive" | "export_import" | "harvest_import";
  items: readonly Record<string, unknown>[];
  checkpointDedupKey?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown) {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asDateString(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function booleanOrNull(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

export function ofapiDollarValueToMillsString(value: unknown) {
  const isNonnegativeNumber = typeof value === "number"
    && Number.isFinite(value)
    && value >= 0;
  const isNonnegativeDecimal = typeof value === "string"
    && value.length <= MAX_DOLLAR_DECIMAL_LENGTH
    && /^(0|[1-9]\d*)(\.\d{1,3})?$/.test(value);
  if (!isNonnegativeNumber && !isNonnegativeDecimal) return null;

  const mills = millsFromDollars(value as number | string);
  if (mills > SIGNED_BIGINT_MAX_MILLS) {
    throw new Error("OFAPI dollar amount exceeds the signed BIGINT mills range");
  }
  return mills.toString();
}

function stableMedia(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const item = asRecord(raw);
    const id = asString(item?.id);
    if (!item || !id) return [];
    return [{
      id,
      type: asString(item.type) ?? "other",
      canView: booleanOrNull(item.canView),
      isReady: booleanOrNull(item.isReady),
      duration: typeof item.duration === "number" && Number.isFinite(item.duration)
        ? item.duration
        : null,
    }];
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function replyMetadata(value: unknown) {
  const reply = asRecord(value);
  const messageId = asString(reply?.id);
  if (!reply || !messageId) return null;
  return {
    messageId,
    textHtml: typeof reply.text === "string" ? reply.text : null,
    isSentByMe: booleanOrNull(reply.isSentByMe),
  };
}

function materialDraft(
  input: MaterialPageInput,
  item: Record<string, unknown>,
): DomainEventInput | null {
  const messageId = asString(item.id);
  const createdAtRaw = asDateString(item.createdAt);
  if (!messageId || !createdAtRaw || typeof item.isSentByMe !== "boolean") return null;
  const isSentByMe = item.isSentByMe;
  const counterpart = asRecord(isSentByMe ? item.toUser : item.fromUser);
  const fanId = asString(counterpart?.id);
  const isTip = item.isTip === true;
  const priceMills = ofapiDollarValueToMillsString(item.price);
  const declaredPresence = asRecord(item.materialPresence);
  const head = {
    nativeMessageId: messageId,
    textHtml: typeof item.text === "string" ? item.text : "",
    isSentByMe,
    senderPlatformUserId: asString(asRecord(item.fromUser)?.id),
    fanPlatformUserId: fanId,
    priceMills,
    isOpened: booleanOrNull(item.isOpened),
    isNew: booleanOrNull(item.isNew),
    isTip,
    tipAmountMills: isTip
      ? ofapiDollarValueToMillsString(item.tipAmount) ?? priceMills ?? "0"
      : "0",
    tipTextPlain: typeof item.tipText === "string" ? item.tipText : null,
    reply: replyMetadata(item.replyToMessage),
    media: stableMedia(item.media),
    fieldPresence: {
      media: declaredPresence?.media !== false,
      reply: declaredPresence?.reply !== false,
      tipText: declaredPresence?.tipText !== false,
    },
    vendorChangedAt: asDateString(item.changedAt),
    materialObservedAt: input.observationReceivedAt.toISOString(),
    originClass: input.originClass,
  };
  const fingerprint = hashOfapiCaptureValue(head);
  return {
    type: "message.material_observed",
    occurredAt: new Date(createdAtRaw),
    fanIdentityRef: fanId,
    conversationRef: input.chatId,
    messageRef: messageId,
    data: { head, fingerprint },
    schemaVersion: 1,
    observationId: input.observationId,
    dedupKey: `msg-material:${messageId}:${fingerprint}`,
  };
}

export async function appendOfapiMessageMaterialPage(
  db: Database,
  input: MaterialPageInput,
) {
  const drafts = input.items.flatMap((item) => {
    const draft = materialDraft(input, item);
    return draft ? [draft] : [];
  });
  if (drafts.length !== input.items.length) {
    throw new Error("Strict OFAPI page contained an unmaterializable message");
  }
  if (drafts.length === 0) {
    return appendProjectionOnlyDomainEvents(db, input.accountId, [], {
      occurredAt: input.observationReceivedAt,
      observationId: input.observationId,
      dedupKey: input.checkpointDedupKey ?? `projection-checkpoint:${input.observationId}`,
    });
  }
  return appendProjectionOnlyDomainEvents(db, input.accountId, drafts, {
    occurredAt: input.observationReceivedAt,
    observationId: input.observationId,
    dedupKey: input.checkpointDedupKey ?? `projection-checkpoint:${input.observationId}`,
    data: {
      profile: "ofapi_message_material_v1",
      originClass: input.originClass,
    },
  });
}
