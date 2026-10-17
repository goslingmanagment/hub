// Shared parsing helpers for OFAPI webhook payloads, used by both the SSE frame
// derivation (ofapi-events.ts) and the DM projection (ofapi-dm-projection.ts).
// Extracted to its own module so the projection can depend on them without a
// circular import through the event processor.

import { z } from "zod";
import { normalizeDmMessageText, truncateUtf16Safe } from "@agency_hub_core/shared";

// The wire envelope, live-verified 2026-06-10: the event id is NOT in the body
// (dedupe runs on the x-ofapi-idempotency-key header before this is parsed).
export const ofapiWebhookEnvelopeSchema = z.object({
  event: z.string().min(1),
  account_id: z.string().min(1).nullish(),
  // An absent key passes, as it did under zod 4.3's bare z.unknown(): since
  // 4.4 it fails one, which would quarantine a body that omits `payload`. The
  // pass-through transform keeps the parsed type's key required (`unknown`).
  payload: z.unknown().optional().transform((value) => value),
});

export type OfapiWebhookEnvelope = z.infer<typeof ofapiWebhookEnvelopeSchema>;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** A receipt field is PRESENT when it is truthy or a non-empty array. `null`,
 *  `false`, `""`, `0` and `[]` are the spellings the vendor uses for "no error"
 *  (e.g. `DAC7.error: null` inside the banking read) and never reject a receipt. */
const receiptFieldPresent = (value: unknown): boolean => Array.isArray(value) ? value.length > 0 : Boolean(value);

/**
 * The ONE rule for "did the vendor answer no?" on an OFAPI action receipt. Every
 * action module and the core classifier apply it to the response envelope and to
 * its `data` object alike, so a `200 {data:{success:true,hasError:true}}` is
 * rejected for a list deletion exactly as it is for a post deletion.
 *
 * A record is negative when ANY of these holds (shapes verified against the
 * vendored snapshot, reference/onlyfansapi/openapi.yaml):
 *   - `error` present — a string on the envelope of every documented 4xx/5xx
 *     (`ONLYFANS_COM_ERROR`, `VALIDATION_ERROR`, `IDEMPOTENCY_CONFLICT`, the
 *     unauthorized message), an object under `onlyfans_response.body.error`,
 *     a string inside an upload status (`error: 'Failed to download file…'`);
 *   - `errors` present — the 422 validation shape is a Laravel-style OBJECT keyed
 *     by field (`errors: { text: ['The text field is required.'] }`), not an
 *     array, so any non-empty value counts;
 *   - `hasError === true` — the boolean the vendor puts on media, queue and
 *     mass-messaging items;
 *   - `success === false` — the documented "no" of every acknowledgement receipt.
 *     Exactly one READ uses it as its ordinary domain answer (username
 *     availability: `data.success === false` means "free"); that caller passes
 *     `allowFalseSuccess` for the data record only — never for the envelope.
 * A non-record (`null`, an array, a string) is not negative: whether the SHAPE
 * is acceptable is the caller's question, this helper only reads a "no".
 */
export function negativeReceipt(value: unknown, options: { allowFalseSuccess?: boolean } = {}): boolean {
  const record = asRecord(value);
  if (!record) return false;
  return receiptFieldPresent(record.error)
    || receiptFieldPresent(record.errors)
    || record.hasError === true
    || (options.allowFalseSuccess !== true && record.success === false);
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
    // Surrogate-safe: a raw slice cut emoji in half and the lone surrogate
    // wedged the settle write for 7 days (event 152584, 2026-07-11).
    textPreview: truncateUtf16Safe(text, REPLY_TEXT_PREVIEW_MAX),
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
