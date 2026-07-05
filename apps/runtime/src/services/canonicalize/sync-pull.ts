// Sync-pull family canonicalizer (Stage 8). Reads the JOURNALED page payloads
// (observation kind = fetch endpoint). Declared coverage this version:
//
//   earnings_transactions (fansly)  → transaction.posted per item
//   dm_messages (onlyfans/OFAPI)    → message.received/sent per item — the
//                                     REST item id equals the webhook message
//                                     id, so the dedup key collides with the
//                                     webhook event (the cross-producer proof)
//
// Deliberately UNDECLARED (observations wait at parse_version 0 for a later
// canonicalizer version — capture now, parse later):
//   - fansly dm_messages: direction (sent vs received) needs the page's own
//     Fansly account id, which is not in the payload — a pure function cannot
//     decide it; a later version threads an account-context lookup table.
//   - onlymonster_* pages: the vendor is being retired (Stage 15); zero rows
//     in production since #67.
//   - subscribers/followers/identity/audience pages: next canonicalizer
//     version; their observations are already journaled and replayable.

import {
  asDate,
  asNumber,
  asString,
  isRecord,
  type CanonicalEventDraft,
  type CanonicalizableObservation,
} from "./types.ts";

export const SYNC_PULL_CANONICALIZER_VERSION = 1;

export const SYNC_PULL_CANONICALIZED_KINDS: ReadonlySet<string> = new Set([
  "earnings_transactions",
  "dm_messages",
]);

function fanslyEarningsTransactions(
  observation: CanonicalizableObservation,
): CanonicalEventDraft[] {
  if (!isRecord(observation.payload)) {
    return [];
  }
  const data = observation.payload.data;
  if (!Array.isArray(data)) {
    return [];
  }

  const events: CanonicalEventDraft[] = [];
  for (const item of data) {
    if (!isRecord(item)) {
      continue;
    }
    const transactionId = asString(item.transactionId);
    if (!transactionId) {
      continue;
    }
    events.push({
      type: "transaction.posted",
      occurredAt: asDate(item.createdAt, observation.receivedAt),
      fanIdentityRef: asString(item.correlationAccountId) ?? asString(item.senderId),
      transactionRef: transactionId,
      data: {
        rawType: asNumber(item.type),
        amount: asNumber(item.amount),
        destinationAmount: asNumber(item.destinationAmount),
        destinationTax: asNumber(item.destinationTax),
        status: asNumber(item.status),
        walletId: asString(item.walletId),
      },
      schemaVersion: 1,
      dedupKey: `txn:${transactionId}`,
    });
  }
  return events;
}

function ofapiRestMessages(observation: CanonicalizableObservation): CanonicalEventDraft[] {
  if (!isRecord(observation.payload)) {
    return [];
  }
  const items = observation.payload.items;
  if (!Array.isArray(items)) {
    return [];
  }

  const events: CanonicalEventDraft[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const messageId = asString(item.id);
    if (!messageId) {
      continue;
    }
    const fromUser = isRecord(item.fromUser) ? item.fromUser : {};
    const senderId = asString(fromUser.id);
    const direction = item.isSentByMe === true ? "sent" : "received";
    events.push({
      type: `message.${direction}`,
      occurredAt: asDate(item.createdAt, observation.receivedAt),
      // For sent messages the payload names only the sender (the model); the
      // fan is the conversation partner, known to the webhook-side event this
      // one dedupes against — null here is honest, not lossy.
      fanIdentityRef: direction === "received" ? senderId : null,
      conversationRef: direction === "received" ? senderId : null,
      messageRef: messageId,
      data: {
        text: asString(item.text),
        price: asNumber(item.price),
        isTip: item.isTip === true,
        isFree: item.isFree === true,
      },
      schemaVersion: 1,
      dedupKey: `msg:${direction}:${messageId}`,
    });
  }
  return events;
}

export function canonicalizeSyncPullObservation(
  observation: CanonicalizableObservation,
): CanonicalEventDraft[] {
  switch (observation.kind) {
    case "earnings_transactions":
      return observation.platform === "fansly" ? fanslyEarningsTransactions(observation) : [];
    case "dm_messages":
      return observation.platform === "onlyfans" ? ofapiRestMessages(observation) : [];
    default:
      return [];
  }
}
