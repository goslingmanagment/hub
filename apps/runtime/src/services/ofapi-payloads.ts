// Shared parsing helpers for OFAPI webhook payloads, used by both the SSE frame
// derivation (ofapi-events.ts) and the DM projection (ofapi-dm-projection.ts).
// Extracted to its own module so the projection can depend on them without a
// circular import through the event processor.

import { z } from "zod";
import { normalizeDmMessageText } from "@agency_hub_core/shared";

// The wire envelope, live-verified 2026-06-10: the event id is NOT in the body
// (dedupe runs on the x-ofapi-idempotency-key header before this is parsed).
export const ofapiWebhookEnvelopeSchema = z.object({
  event: z.string().min(1),
  account_id: z.string().min(1).nullish(),
  payload: z.unknown(),
});

export type OfapiWebhookEnvelope = z.infer<typeof ofapiWebhookEnvelopeSchema>;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// OnlyFans ids arrive as numbers in message payloads and as strings in
// notification payloads; SyncEvent serializes them all as strings.
export function idToString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}

export function parseEpochMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// Notification payloads (ppv unlocked, tips) carry the message id and chat
// (= fan) id only inside the OnlyFans chat link, e.g.
// …/my/chats/chat/<fanId>?firstId=<msgId>.
function notificationLinkMatch(
  payload: Record<string, unknown>,
  pattern: RegExp,
): string | undefined {
  const candidates: unknown[] = [payload.text];
  const replacePairs = asRecord(payload.replacePairs);
  if (replacePairs) {
    candidates.push(...Object.values(replacePairs));
  }

  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }

    const match = pattern.exec(candidate);
    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

export function extractMessageIdFromNotification(payload: Record<string, unknown>): string | undefined {
  return notificationLinkMatch(payload, /[?&]firstId=(\d+)/);
}

// The fan id comes from payload.user.id or the chat link path. payload.user_id is
// NOT a fallback — in live captures it holds the recipient creator's id, not the fan.
export function notificationChatId(payload: Record<string, unknown>): string | null {
  return idToString(asRecord(payload.user)?.id)
    ?? notificationLinkMatch(payload, /\/my\/chats\/chat\/(\d+)/)
    ?? null;
}

const SYNC_MEDIA_TYPES = new Set(["photo", "video", "audio", "gif"]);
const REPLY_TEXT_PREVIEW_MAX = 120;

export interface NormalizedOfapiSyncMessageMedia {
  id: string;
  type: "photo" | "video" | "audio" | "gif" | "other";
  isReady: boolean;
  locked: boolean;
  durationSeconds?: number | null;
}

export interface NormalizedOfapiSyncMessageReplyTo {
  messageId?: string;
  sender?: "fan" | "model";
  textPreview: string;
}

export interface NormalizedOfapiSyncMessage {
  id: string;
  text: string;
  createdAt: string;
  isSentByMe: boolean;
  price: number;
  isOpened?: boolean | null;
  isNew?: boolean;
  isTip?: boolean;
  tipAmountUsd?: number | null;
  tipText?: string | null;
  mediaCount?: number;
  media?: NormalizedOfapiSyncMessageMedia[];
  replyTo?: NormalizedOfapiSyncMessageReplyTo | null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseableTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function normalizeSyncMediaItem(item: unknown): NormalizedOfapiSyncMessageMedia | null {
  const media = asRecord(item);
  const id = idToString(media?.id);
  if (!media || !id) {
    return null;
  }

  const rawType = typeof media.type === "string" ? media.type : "";
  const duration = nonNegativeNumber(media.duration);
  return {
    id,
    type: SYNC_MEDIA_TYPES.has(rawType)
      ? rawType as NormalizedOfapiSyncMessageMedia["type"]
      : "other",
    isReady: media.isReady !== false,
    locked: media.canView === false,
    ...(duration === null ? {} : { durationSeconds: duration }),
  };
}

function normalizeReplyTo(
  value: unknown,
  chatId: string,
): NormalizedOfapiSyncMessageReplyTo | null {
  const reply = asRecord(value);
  if (!reply) {
    return null;
  }

  const text = typeof reply.text === "string" ? normalizeDmMessageText(reply.text) : "";
  if (text.length === 0) {
    return null;
  }

  const senderId = idToString(asRecord(reply.fromUser)?.id);
  return {
    ...(idToString(reply.id) ? { messageId: idToString(reply.id)! } : {}),
    ...(senderId ? { sender: senderId === chatId ? "fan" as const : "model" as const } : {}),
    textPreview: text.slice(0, REPLY_TEXT_PREVIEW_MAX),
  };
}

export function normalizeOfapiSyncMessage(input: {
  payload: Record<string, unknown>;
  chatId: string;
  isSentByMe: boolean;
}): NormalizedOfapiSyncMessage | null {
  const messageId = idToString(input.payload.id);
  const createdAt = parseableTimestamp(input.payload.createdAt);
  if (!messageId || !input.chatId || !createdAt) {
    return null;
  }

  const price = nonNegativeNumber(input.payload.price) ?? 0;
  const rawMedia = Array.isArray(input.payload.media) ? input.payload.media : [];
  const media = rawMedia
    .map((item) => normalizeSyncMediaItem(item))
    .filter((item): item is NormalizedOfapiSyncMessageMedia => item !== null);
  const payloadMediaCount = nonNegativeInteger(input.payload.mediaCount);
  const mediaCount = payloadMediaCount ?? (media.length > 0 ? media.length : null);
  const isTip = typeof input.payload.isTip === "boolean" ? input.payload.isTip : undefined;
  const tipAmount = nonNegativeNumber(input.payload.tipAmount)
    ?? (isTip === true ? price : null);
  const tipText = typeof input.payload.tipText === "string"
    ? normalizeDmMessageText(input.payload.tipText)
    : null;
  const replyTo = normalizeReplyTo(input.payload.replyToMessage, input.chatId);

  return {
    id: messageId,
    text: typeof input.payload.text === "string" ? input.payload.text : "",
    createdAt,
    isSentByMe: input.isSentByMe,
    price,
    ...(typeof input.payload.isOpened === "boolean" || input.payload.isOpened === null
      ? { isOpened: input.payload.isOpened }
      : {}),
    ...(typeof input.payload.isNew === "boolean" ? { isNew: input.payload.isNew } : {}),
    ...(isTip === undefined ? {} : { isTip }),
    ...(tipAmount === null ? {} : { tipAmountUsd: tipAmount }),
    ...(tipText === null ? {} : { tipText }),
    ...(mediaCount === null ? {} : { mediaCount }),
    ...(media.length === 0 ? {} : { media }),
    ...(replyTo === null ? {} : { replyTo }),
  };
}
