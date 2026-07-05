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
//   (v2) fansly dm_messages now DECLARED: direction resolves against the
//   per-run page->native-ref context map (see SyncPullCanonicalizeContext).
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

export const SYNC_PULL_CANONICALIZER_VERSION = 2;

/** Per-run context: page -> own platform-native account id. Direction of a
 *  Fansly DM (sent vs received) is decidable only against the page's OWN
 *  account ref; the sweep builds this once per run — the canonicalizer
 *  itself stays pure. */
export interface SyncPullCanonicalizeContext {
  nativeAccountRefByAccountId: ReadonlyMap<number, string | null>;
}

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

function fanslyDmMessages(
  observation: CanonicalizableObservation,
  context: SyncPullCanonicalizeContext | undefined,
): CanonicalEventDraft[] {
  if (!isRecord(observation.payload) || observation.accountId == null) {
    return [];
  }
  const ownRef = context?.nativeAccountRefByAccountId.get(observation.accountId) ?? null;
  if (ownRef === null) {
    // Undecidable without the page's own account ref. Rare (every live page
    // carries one); such rows stamp with zero events and are recoverable via
    // events:replay --parse-version once the mapping lands (recorded edge).
    return [];
  }
  const messages = observation.payload.messages;
  if (!Array.isArray(messages)) {
    return [];
  }

  const events: CanonicalEventDraft[] = [];
  for (const item of messages) {
    if (!isRecord(item)) {
      continue;
    }
    const messageId = asString(item.id);
    if (!messageId) {
      continue;
    }
    const senderId = asString(item.senderId);
    const direction = senderId !== null && senderId === ownRef ? "sent" : "received";
    // Fansly DM tip totals arrive in MILLS (normalizeDmTipAmountCents ÷10
    // precedent); keep mills in the event data.
    const tipMills = asNumber(item.totalTipAmount);
    events.push({
      type: `message.${direction}`,
      occurredAt: asDate(item.createdAt, observation.receivedAt),
      fanIdentityRef: direction === "received" ? senderId : null,
      conversationRef: asString(item.groupId),
      messageRef: messageId,
      data: {
        text: asString(item.content),
        tipAmountMills: tipMills !== null && tipMills > 0 ? Math.round(tipMills) : 0,
        isTip: tipMills !== null && tipMills > 0,
      },
      schemaVersion: 1,
      dedupKey: `msg:${direction}:${messageId}`,
    });
  }
  return events;
}

export function canonicalizeSyncPullObservation(
  observation: CanonicalizableObservation,
  context?: SyncPullCanonicalizeContext,
): CanonicalEventDraft[] {
  switch (observation.kind) {
    case "earnings_transactions":
      return observation.platform === "fansly" ? fanslyEarningsTransactions(observation) : [];
    case "dm_messages":
      if (observation.platform === "onlyfans") {
        return ofapiRestMessages(observation);
      }
      return observation.platform === "fansly" ? fanslyDmMessages(observation, context) : [];
    default:
      return [];
  }
}
