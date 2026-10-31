// The OnlyFans feed family (services/client-onlyfans-feed.ts): the records a
// chatter's ChatSpace already received, journaled one per observation under
// `client.onlyfans_feed.v1`, become the same message events every OnlyFans
// writer before it minted — so the archive, the AI context and the feed read
// them with nothing changed, and a message OFAPI, the export or another tab
// already brought collapses instead of doubling:
// - a `message` → `message.received` / `message.sent` with OFAPI's own key
//   (`msg:<direction>:<id>`: a message the frozen archive holds is not news
//   again) and `message.material_observed` (`msg-material:<id>:<fingerprint>`,
//   as the OFAPI lanes and the export import write it): the full head — text,
//   price, opened, the tip, media — for message_archive, where the newer
//   reading wins;
// - a `deleted` → `message.deleted` (`msg:deleted:<id>`);
// - a `ppv` of a message → `message.ppv_unlocked` (`ppv:chatspace:<msg>:<fan>`):
//   the archive marks it opened.
// Money, fans and chats the route writes itself (validation only here).
//
// Producer gate: only the chat extension's own producer (`chat-extension@<v>`)
// mints events here; the same kind from any other producer stamps forward with
// none.

import { createHash } from "node:crypto";

import { millsFromDollars } from "@agency_hub_core/shared";

import {
  asString,
  isRecord,
  type CanonicalEventDraft,
  type CanonicalizableObservation,
} from "./types.ts";

export const CLIENT_ONLYFANS_FEED_OBSERVATION_KIND = "client.onlyfans_feed.v1";
export const CLIENT_ONLYFANS_FEED_CANONICALIZER_VERSION = 1;
/** The archive's `origin_class` of what the feed brought. */
export const CLIENT_ONLYFANS_FEED_ORIGIN_CLASS = "chatspace_feed";

const PRODUCER = /^chat-extension@/;

function date(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Dollars as the feed carries them → mills as a decimal string (the material head's unit); null — none. */
function millsText(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return millsFromDollars(value).toString();
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

/** The record and the page's creator, when the observation carries a record of the feed. Pure. */
export function onlyfansFeedRecordOf(
  observation: Pick<CanonicalizableObservation, "payload">,
): { record: Record<string, unknown>; creatorRef: string | null } | null {
  if (!isRecord(observation.payload) || !isRecord(observation.payload.record)) return null;
  const record = observation.payload.record;
  return typeof record.kind === "string" ? { record, creatorRef: asString(observation.payload.creatorRef) } : null;
}

function messageEvents(
  observation: CanonicalizableObservation,
  record: Record<string, unknown>,
  creatorRef: string | null,
): CanonicalEventDraft[] {
  const messageId = asString(record.messageRef);
  const fanId = asString(record.fanRef);
  const sentAt = date(record.sentAt);
  const fromFan = bool(record.fromFan);
  if (!messageId || !fanId || !sentAt || fromFan === null) return [];
  const direction = fromFan ? "received" : "sent";
  const textHtml = typeof record.textHtml === "string" ? record.textHtml : "";
  const isTip = record.isTip === true;
  const priceMills = millsText(record.price);
  const media = Array.isArray(record.media)
    ? record.media.filter(isRecord).map((item) => ({
      id: asString(item.ref) ?? "",
      type: asString(item.type) ?? "other",
      canView: bool(item.canView),
      isReady: null,
      duration: typeof item.duration === "number" && Number.isFinite(item.duration) ? item.duration : null,
    })).filter((item) => item.id !== "").sort((left, right) => left.id.localeCompare(right.id))
    : [];
  // A chat list's last message names no media and no price: it does not say they are absent.
  const listed = record.via === "chat_list";
  const head = {
    nativeMessageId: messageId,
    textHtml,
    isSentByMe: !fromFan,
    senderPlatformUserId: fromFan ? fanId : creatorRef,
    fanPlatformUserId: fanId,
    priceMills,
    isOpened: bool(record.isOpened),
    isNew: bool(record.isNew),
    isTip,
    tipAmountMills: isTip ? priceMills ?? "0" : "0",
    tipTextPlain: typeof record.tipText === "string" ? record.tipText : null,
    reply: null,
    media,
    fieldPresence: { media: !listed, reply: false, tipText: record.tipText !== null && record.tipText !== undefined },
    // The message's own time: the archive dates the row by it even where the driver clamps the event's.
    messageCreatedAt: sentAt.toISOString(),
    vendorChangedAt: date(record.changedAt)?.toISOString() ?? null,
    materialObservedAt: observation.receivedAt.toISOString(),
    originClass: CLIENT_ONLYFANS_FEED_ORIGIN_CLASS,
  };
  const fingerprint = stableHash(head);
  return [
    {
      type: `message.${direction}`,
      occurredAt: sentAt,
      fanIdentityRef: fanId,
      conversationRef: fanId,
      messageRef: messageId,
      data: {
        text: textHtml,
        price: typeof record.price === "number" ? record.price : null,
        isTip,
        isFree: bool(record.isFree),
        mediaCount: typeof record.mediaCount === "number" ? record.mediaCount : media.length,
      },
      schemaVersion: 1,
      dedupKey: `msg:${direction}:${messageId}`,
    },
    {
      type: "message.material_observed",
      occurredAt: sentAt,
      fanIdentityRef: fanId,
      conversationRef: fanId,
      messageRef: messageId,
      data: { head, fingerprint },
      schemaVersion: 1,
      dedupKey: `msg-material:${messageId}:${fingerprint}`,
    },
  ];
}

export function canonicalizeClientOnlyfansFeedObservation(
  observation: CanonicalizableObservation,
): CanonicalEventDraft[] {
  if (observation.kind !== CLIENT_ONLYFANS_FEED_OBSERVATION_KIND || !PRODUCER.test(observation.producer)) return [];
  const parsed = onlyfansFeedRecordOf(observation);
  if (parsed === null) return [];
  const { record, creatorRef } = parsed;
  switch (record.kind) {
    case "message":
      return messageEvents(observation, record, creatorRef);
    case "deleted": {
      const messageId = asString(record.messageRef);
      if (!messageId) return [];
      return [{
        type: "message.deleted",
        occurredAt: date(record.observedAt) ?? observation.receivedAt,
        messageRef: messageId,
        data: {},
        schemaVersion: 1,
        dedupKey: `msg:deleted:${messageId}`,
      }];
    }
    case "ppv": {
      const messageId = asString(record.contentRef);
      const fanId = asString(record.fanRef);
      if (record.contentType !== "message" || !messageId || !fanId) return [];
      return [{
        type: "message.ppv_unlocked",
        occurredAt: date(record.observedAt) ?? observation.receivedAt,
        fanIdentityRef: fanId,
        conversationRef: fanId,
        messageRef: messageId,
        data: { amountUsd: typeof record.priceGross === "number" ? record.priceGross : null, source: "chatspace" },
        schemaVersion: 1,
        dedupKey: `ppv:chatspace:${messageId}:${fanId}`,
      }];
    }
    default:
      return [];
  }
}

/** The family's shape gate: a body that is not a record of the feed stays unstamped for a future parser. */
export function canParseClientOnlyfansFeedObservation(observation: CanonicalizableObservation): boolean {
  return onlyfansFeedRecordOf(observation) !== null;
}
