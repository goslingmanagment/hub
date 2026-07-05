// OFAPI webhook family canonicalizer (Stage 8). Reads the JOURNALED envelope
// ({event, account_id, payload} — exactly what the receiver persisted), never
// the live wire. Dedup keys follow the stage spec's binding table.
// tips.received was undeclared through v1 (unverified fixture, spec
// assumption 5); v2 declares it from the live-verified shape (Stage 14,
// decision #80) — the waiting parse_version-0 observations are exactly the
// replay customers the capture-now-parse-later design promised.

import {
  asDate,
  asNumber,
  asString,
  isRecord,
  type CanonicalEventDraft,
  type CanonicalizableObservation,
} from "./types.ts";

export const OFAPI_WEBHOOK_CANONICALIZER_VERSION = 2;

export const OFAPI_WEBHOOK_CANONICALIZED_KINDS: ReadonlySet<string> = new Set([
  "messages.received",
  "messages.sent",
  "messages.deleted",
  "messages.ppv.unlocked",
  "tips.received",
  "transactions.new",
  "subscriptions.new",
  "users.online",
  "users.offline",
  "accounts.connected",
  "accounts.reconnected",
  "accounts.session_expired",
  "accounts.authentication_failed",
  "accounts.otp_code_required",
  "accounts.face_otp_required",
]);

function envelopePayload(observation: CanonicalizableObservation): Record<string, unknown> | null {
  if (!isRecord(observation.payload)) {
    return null;
  }
  const payload = observation.payload.payload;
  return isRecord(payload) ? payload : null;
}

function messageEvent(
  observation: CanonicalizableObservation,
  direction: "received" | "sent",
): CanonicalEventDraft[] {
  const message = envelopePayload(observation);
  if (!message) {
    return [];
  }
  const messageId = asString(message.id);
  if (!messageId) {
    return [];
  }
  const counterpart = direction === "received" ? message.fromUser : message.toUser;
  const fanId = isRecord(counterpart) ? asString(counterpart.id) : null;
  return [{
    type: `message.${direction}`,
    occurredAt: asDate(message.createdAt, observation.receivedAt),
    fanIdentityRef: fanId,
    conversationRef: fanId,
    messageRef: messageId,
    data: {
      text: asString(message.text),
      price: asNumber(message.price),
      isTip: message.isTip === true,
      isFree: message.isFree === true,
      mediaCount: asNumber(message.mediaCount) ?? 0,
    },
    schemaVersion: 1,
    dedupKey: `msg:${direction}:${messageId}`,
  }];
}

export function canonicalizeOfapiWebhookObservation(
  observation: CanonicalizableObservation,
): CanonicalEventDraft[] {
  switch (observation.kind) {
    case "messages.received":
      return messageEvent(observation, "received");
    case "messages.sent":
      return messageEvent(observation, "sent");

    case "messages.deleted": {
      const payload = envelopePayload(observation);
      const messageId = payload ? asString(payload.id) : null;
      if (!messageId) {
        return [];
      }
      return [{
        type: "message.deleted",
        occurredAt: observation.observedAt ?? observation.receivedAt,
        messageRef: messageId,
        data: {},
        schemaVersion: 1,
        dedupKey: `msg:deleted:${messageId}`,
      }];
    }

    case "messages.ppv.unlocked": {
      const payload = envelopePayload(observation);
      if (!payload) {
        return [];
      }
      const notificationId = asString(payload.id);
      if (!notificationId) {
        return [];
      }
      const replacePairs = isRecord(payload.replacePairs) ? payload.replacePairs : {};
      const messageLink = asString(replacePairs["{MESSAGE_LINK}"]);
      const messageRef = messageLink?.match(/(\d+)(?:[^\d]*)$/)?.[1] ?? null;
      return [{
        type: "message.ppv_unlocked",
        occurredAt: asDate(payload.createdAt, observation.receivedAt),
        fanIdentityRef: asString(payload.user_id),
        conversationRef: asString(payload.user_id),
        messageRef,
        data: {
          amountText: asString(replacePairs["{AMOUNT}"]),
          messageLink,
        },
        schemaVersion: 1,
        // The notification id is the stable unique ref on this kind; the
        // message id inside the link is best-effort display data.
        dedupKey: `ppv:${notificationId}`,
      }];
    }

    case "tips.received": {
      // Live-verified shape (Stage 14): the tipper is payload.user.id — the
      // top-level user_id is the CREATOR (constant across tippers on a page).
      // The money itself also arrives as transactions.new (type "tip") →
      // transaction.posted; this event is the tip NOTIFICATION with its own
      // type, so projections that count money from transaction.posted never
      // double-count.
      const payload = envelopePayload(observation);
      if (!payload) {
        return [];
      }
      const notificationId = asString(payload.id);
      if (!notificationId) {
        return [];
      }
      const tipper = isRecord(payload.user) ? payload.user : {};
      const fanId = asString(tipper.id);
      return [{
        type: "tip.received",
        occurredAt: asDate(payload.createdAt, observation.receivedAt),
        fanIdentityRef: fanId,
        conversationRef: fanId,
        data: {
          amountGross: asNumber(payload.amountGross),
          amountNet: asNumber(payload.amountNet),
          subType: asString(payload.subType),
          text: asString(payload.text),
        },
        schemaVersion: 1,
        dedupKey: `tip:${notificationId}`,
      }];
    }

    case "transactions.new": {
      const payload = envelopePayload(observation);
      if (!payload) {
        return [];
      }
      const transactionId = asString(payload.id);
      if (!transactionId) {
        return [];
      }
      const fan = isRecord(payload.fan) ? payload.fan : {};
      return [{
        type: "transaction.posted",
        occurredAt: asDate(payload.created_at, observation.receivedAt),
        fanIdentityRef: asString(fan.id),
        transactionRef: transactionId,
        data: {
          transactionType: asString(payload.type),
          amount: asNumber(payload.amount),
          netAmount: asNumber(payload.net_amount),
          feeAmount: asNumber(payload.fee_amount),
          vatAmount: asNumber(payload.vat_amount),
          taxAmount: asNumber(payload.tax_amount),
          currency: asString(payload.currency),
          status: asString(payload.status),
          description: asString(payload.description),
        },
        schemaVersion: 1,
        dedupKey: `txn:${transactionId}`,
      }];
    }

    case "subscriptions.new": {
      const payload = envelopePayload(observation);
      if (!payload) {
        return [];
      }
      const user = isRecord(payload.user) ? payload.user : {};
      const fanId = asString(payload.user_id) ?? asString(user.id);
      if (!fanId) {
        return [];
      }
      const occurredAt = asDate(payload.createdAt, observation.receivedAt);
      return [{
        type: "subscription.started",
        occurredAt,
        fanIdentityRef: fanId,
        data: {
          subType: asString(payload.subType),
          notificationId: asString(payload.id),
        },
        schemaVersion: 1,
        dedupKey: `sub:started:${fanId}:${occurredAt.toISOString()}`,
      }];
    }

    case "users.online":
    case "users.offline": {
      const payload = envelopePayload(observation);
      if (!payload) {
        return [];
      }
      const state = observation.kind === "users.online" ? "online" : "offline";
      const fan = isRecord(payload.fan) ? payload.fan : {};
      const fanId = asString(fan.id);
      if (!fanId) {
        return [];
      }
      const occurredAt = asDate(
        payload.observed_at ?? payload.status_changed_at,
        observation.receivedAt,
      );
      return [{
        type: `presence.${state}`,
        occurredAt,
        fanIdentityRef: fanId,
        data: {
          statusChangedAt: asString(payload.status_changed_at),
          lastSeenOnlineAt: asString(payload.last_seen_online_at),
        },
        schemaVersion: 1,
        // Time series by design — the timestamp keeps every state change.
        dedupKey: `presence:${state}:${fanId}:${occurredAt.toISOString()}`,
      }];
    }

    case "accounts.connected":
    case "accounts.reconnected":
    case "accounts.session_expired":
    case "accounts.authentication_failed":
    case "accounts.otp_code_required":
    case "accounts.face_otp_required": {
      const status = observation.kind.slice("accounts.".length);
      const occurredAt = observation.observedAt ?? observation.receivedAt;
      return [{
        type: "account.auth_changed",
        occurredAt,
        data: { event: observation.kind, status },
        schemaVersion: 1,
        dedupKey: `auth:${status}:${occurredAt.toISOString()}`,
      }];
    }

    default:
      // Undeclared kind (incl. tips.received until its fixture verifies):
      // zero events; the sweep leaves parse_version untouched for kinds
      // outside OFAPI_WEBHOOK_CANONICALIZED_KINDS.
      return [];
  }
}
