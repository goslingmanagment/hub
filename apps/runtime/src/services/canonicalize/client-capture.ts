// Client-capture family (Stage 11). DELIBERATELY registration + validation
// only: desktop-held facts (acceptance telemetry, guard/send audit, spend
// ledgers) are not account-scoped platform truth, so NO domain events ship
// here — they live as observations until Stage 29 defines the restricted
// class that consumes them. Registering the family makes the sweep stamp
// parse_version (the kinds are "seen", not pending), and the version gives
// Stage 29 its replay hook: bump it and every captured fact re-presents.

import {
  asDate,
  asNumber,
  asString,
  isRecord,
  type CanonicalEventDraft,
  type CanonicalizableObservation,
} from "./types.ts";

// v2 (Stage 12): harvest.messages parses into message.* events with Stage 8
// dedup-key PARITY (msg:<direction>:<id>, msg:deleted:<id>) so a message the
// kernel already saw — webhook, OFAPI REST, gateway tee — collapses, and only
// pre-webhook-epoch history appends. harvest.fan_transactions is validation-
// only BY DEVIATION from the spec's "candidate events": the ledger's
// transaction events start at the webhook epoch, so historical harvest events
// would ALL append as noise — the meaningful dedup surface is the transactions
// TRUTH table, which is exactly what the reconcile CLI's residue query joins.
export const CLIENT_CAPTURE_CANONICALIZER_VERSION = 2;

// The endpoint's allowlist, prefixed. desktop.unknown:* kinds stay OUTSIDE
// the family — they wait at parse_version 0 until someone declares them
// (capture now, parse later).
export const CLIENT_CAPTURE_CANONICALIZED_KINDS: ReadonlySet<string> = new Set([
  "desktop.ai_acceptance",
  "desktop.guard_audit",
  "desktop.send_audit",
  "desktop.ai_spend",
  "desktop.credit_spend",
  "desktop.data_purge_notice",
  // Stage 12 harvest kinds. messages parse (dedup-key parity with Stage 8);
  // fan_transactions is validation-only (see the v2 note above); the rest are
  // observation-only per spec §2 (guard text is sensitive; spend ledgers wait
  // for Stage 29 like their live twins).
  "harvest.messages",
  "harvest.fan_transactions",
  "harvest.outbox",
  "harvest.message_guard_events",
  "harvest.usage_events",
  "harvest.ai_spend_log",
  "harvest.credit_log",
]);

// Local desktop `messages` rows (SCHEMA_VERSION 16): message_id is the
// PLATFORM message id (numeric string — same id space as OFAPI webhook/REST),
// is_sent_by_me carries direction, chat_id is the per-fan conversation id.
function harvestMessageEvents(
  observation: CanonicalizableObservation,
): CanonicalEventDraft[] {
  if (!isRecord(observation.payload)) {
    return [];
  }
  const row = observation.payload.row;
  if (!isRecord(row)) {
    return [];
  }
  const messageId = asString(row.message_id);
  if (!messageId) {
    return [];
  }
  const direction = row.is_sent_by_me === 1 || row.is_sent_by_me === true ? "sent" : "received";
  const occurredAt = asDate(row.created_at, observation.receivedAt);
  const chatId = asString(row.chat_id);
  const events: CanonicalEventDraft[] = [{
    type: `message.${direction}`,
    occurredAt,
    fanIdentityRef: chatId,
    conversationRef: chatId,
    messageRef: messageId,
    data: {
      text: asString(row.text_plain),
      price: asNumber(row.price),
      isTip: row.is_tip === 1 || row.is_tip === true,
      tipAmount: asNumber(row.tip_amount),
      mediaCount: 0,
    },
    schemaVersion: 1,
    dedupKey: `msg:${direction}:${messageId}`,
  }];
  if (row.deleted === 1 || row.deleted === true) {
    events.push({
      type: "message.deleted",
      occurredAt,
      messageRef: messageId,
      data: {},
      schemaVersion: 1,
      dedupKey: `msg:deleted:${messageId}`,
    });
  }
  return events;
}

export function canonicalizeClientCaptureObservation(
  observation: CanonicalizableObservation,
): CanonicalEventDraft[] {
  if (observation.kind === "harvest.messages") {
    return harvestMessageEvents(observation);
  }
  // Everything else: validation is the whole job — a payload that is not an
  // object would have nothing for Stage 29 to replay; zero events either way.
  void isRecord(observation.payload);
  return [];
}
