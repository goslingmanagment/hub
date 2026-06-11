// Shared parsing helpers for OFAPI webhook payloads, used by both the SSE frame
// derivation (ofapi-events.ts) and the DM projection (ofapi-dm-projection.ts).
// Extracted to its own module so the projection can depend on them without a
// circular import through the event processor.

import { z } from "zod";

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
