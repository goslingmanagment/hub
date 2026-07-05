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

export const SYNC_PULL_CANONICALIZER_VERSION = 3;

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
  // v3 (Stage 16 parse side): shapes derived from the extension's
  // production-proven parsers (chatgoose shared/types.ts) — the ramp
  // VERIFIES rather than discovers; units confirmed mills by core's own
  // treatment of the same endpoint family (executor-handlers totalGross).
  "fan_earnings_stats",
  "fan_earnings_monthly",
  "purchase_history",
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
    case "fan_earnings_stats":
      return observation.platform === "fansly" ? fanslyEarningsObserved(observation, false) : [];
    case "fan_earnings_monthly":
      return observation.platform === "fansly" ? fanslyEarningsObserved(observation, true) : [];
    case "purchase_history":
      return observation.platform === "fansly" ? fanslyPurchaseHistory(observation) : [];
    default:
      return [];
  }
}

interface EarningsAggregate {
  grossMills: number;
  netMills: number;
  breakdown: Array<{ type: number | null; grossMills: number; netMills: number }>;
}

// Deep key-sorted copy: a replacer-array JSON.stringify would WHITELIST keys
// recursively and silently drop nested fields (breakdown[].type) from the
// hash — a snapshot differing only there would wrongly dedupe to nothing.
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalJson(record[key])]),
    );
  }
  return value;
}

function stableHash(value: unknown): string {
  // Order-independent content hash so an unchanged snapshot re-fetch
  // produces the same dedup key (spec: no new event on identical stats).
  const canonical = JSON.stringify(canonicalJson(value));
  let hash = 0;
  for (let index = 0; index < canonical.length; index += 1) {
    hash = (hash * 31 + canonical.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16);
}

/** Both earnings kinds: rows aggregate per (fan, window); window = 'lifetime'
 *  for the stats snapshot, 'YYYY-MM' for monthly rows. Amounts are MILLS. */
function fanslyEarningsObserved(
  observation: CanonicalizableObservation,
  monthly: boolean,
): CanonicalEventDraft[] {
  const rows = Array.isArray(observation.payload) ? observation.payload : null;
  if (!rows) {
    return [];
  }

  const perKey = new Map<string, { fan: string; window: string; aggregate: EarningsAggregate }>();
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }
    const fan = asString(row.correlationAccountId);
    if (!fan) {
      continue;
    }
    let window = "lifetime";
    if (monthly) {
      const year = asNumber(row.year);
      const month = asNumber(row.month);
      if (year === null || month === null) {
        continue;
      }
      window = `${year}-${String(month).padStart(2, "0")}`;
    }
    const key = `${fan}:${window}`;
    const entry = perKey.get(key) ?? {
      fan,
      window,
      aggregate: { grossMills: 0, netMills: 0, breakdown: [] },
    };
    const gross = asNumber(row.totalGross) ?? 0;
    const net = asNumber(row.totalNet) ?? 0;
    entry.aggregate.grossMills += gross;
    entry.aggregate.netMills += net;
    entry.aggregate.breakdown.push({
      type: asNumber(row.type),
      grossMills: gross,
      netMills: net,
    });
    perKey.set(key, entry);
  }

  const events: CanonicalEventDraft[] = [];
  for (const { fan, window, aggregate } of perKey.values()) {
    events.push({
      type: "fan.earnings_observed",
      occurredAt: observation.observedAt ?? observation.receivedAt,
      fanIdentityRef: fan,
      data: {
        window,
        grossMills: Math.trunc(aggregate.grossMills),
        netMills: Math.trunc(aggregate.netMills),
        breakdown: aggregate.breakdown,
      },
      schemaVersion: 1,
      // Content-hashed: an unchanged snapshot re-fetch dedupes to nothing.
      dedupKey: `fan_earnings:${fan}:${window}:${stableHash(aggregate)}`,
    });
  }
  return events;
}

/** PPV order-history rows carry NO order id (extension-proven shape) — the
 *  dedup key is the composite (fan, media/bundle, createdAt); recorded
 *  deviation from the spec's `ppv:<order_id>` ideal. */
function fanslyPurchaseHistory(observation: CanonicalizableObservation): CanonicalEventDraft[] {
  if (!isRecord(observation.payload)) {
    return [];
  }
  const aggregation = isRecord(observation.payload.aggregationData)
    ? observation.payload.aggregationData
    : {};
  const rows = Array.isArray(observation.payload.accountMediaOrderHistory)
    ? observation.payload.accountMediaOrderHistory
    : Array.isArray(aggregation.accountMediaOrders)
      ? aggregation.accountMediaOrders
      : null;
  if (!rows) {
    return [];
  }

  const events: CanonicalEventDraft[] = [];
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }
    const fan = asString(row.accountId);
    const mediaRef = asString(row.accountMediaId) ?? asString(row.accountMediaBundleId);
    if (!fan || !mediaRef) {
      continue;
    }
    const occurredAt = asDate(row.createdAt, observation.receivedAt);
    events.push({
      type: "message.ppv_unlocked",
      occurredAt,
      fanIdentityRef: fan,
      data: {
        accountMediaId: asString(row.accountMediaId),
        accountMediaBundleId: asString(row.accountMediaBundleId),
        orderType: asNumber(row.type),
      },
      schemaVersion: 1,
      dedupKey: `ppv:${fan}:${mediaRef}:${occurredAt.toISOString()}`,
    });
  }
  return events;
}
