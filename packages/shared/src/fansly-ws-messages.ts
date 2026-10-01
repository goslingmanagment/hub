import { FANSLY_WS_MAX_FRAME_BYTES, wsJson, wsObject } from "./fansly-ws-capture.ts";

/** Version of the live message decoder below. Overlay rows and receipts record
 * the version that wrote them; a change of the decoded field set or of a
 * required-field rule is a new version, never a silent reinterpretation. */
export const FANSLY_WS_LIVE_DECODER_VERSION = 1;

/** Which optional socket fields a `message created` frame carried (bit mask on
 * the overlay row). A field the frame did not carry is unknown, not empty, so
 * parity never scores it against REST. */
export const FANSLY_WS_LIVE_FIELD = Object.freeze({
  content: 1,
  inReplyTo: 2,
  inReplyToRoot: 4,
  attachments: 8,
  type: 16,
  correlationId: 32,
});

/** Ids and the content type only: never a URL, a price or an amount. */
export type FanslyWsLiveAttachment = { contentType: number; contentId: string };

/** The socket-only part of a message (plan §7.3): text, sender, chat,
 * normalized time, reply-to and the attachment fact and type. Tips, PPV
 * prices, purchases and media access are REST-only and are never read here. */
export type FanslyWsLiveMessage = {
  id: string;
  groupId: string;
  senderId: string;
  /** Whole-ms instant (fanslyWsCreatedAtMs). */
  createdAtMs: number;
  content: string | null;
  inReplyTo: string | null;
  inReplyToRoot: string | null;
  attachments: FanslyWsLiveAttachment[];
  type: number | null;
  correlationId: string | null;
  fieldMask: number;
};

export type FanslyWsLiveInvalidReason = "envelope" | "message_id" | "group_id" | "sender_id" | "created_at";

export type FanslyWsLiveItem =
  | { kind: "message_created"; path: number[]; message: FanslyWsLiveMessage }
  | { kind: "message_deleted"; path: number[]; messageId: string; groupId: string | null }
  /** Chat created, money, wallet, unknown services, stripped controls: not a
   * message, so not a decoder error of the live message path. */
  | { kind: "other"; path: number[] }
  | { kind: "invalid"; path: number[]; reason: FanslyWsLiveInvalidReason }
  | { kind: "limit"; path: number[] };

export type FanslyWsLiveDecode = { decoderVersion: number; items: FanslyWsLiveItem[] };

const MAX_DEPTH = 8;
const MAX_NODES = 255;
const MAX_ATTACHMENTS = 64;

const nativeRef = (value: unknown): string | null =>
  typeof value === "string" && /^[0-9]{1,32}$/.test(value) ? value : null;

/** A WS frame's message createdAt is epoch seconds, usually fractional. Same
 * unit rule as REST normalizeFanslyTimestamp (>= 1e12 is already ms), kept to
 * a whole-ms instant; anything else is absent. */
export function fanslyWsCreatedAtMs(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = value >= 1_000_000_000_000 ? value : value * 1000;
  const wholeMs = Math.round(ms);
  return wholeMs <= 8.64e15 ? wholeMs : null;
}

function liveMessage(message: Record<string, unknown>): FanslyWsLiveMessage | FanslyWsLiveInvalidReason {
  const id = nativeRef(message.id);
  if (!id) return "message_id";
  const groupId = nativeRef(message.groupId);
  if (!groupId) return "group_id";
  const senderId = nativeRef(message.senderId);
  if (!senderId) return "sender_id";
  const createdAtMs = fanslyWsCreatedAtMs(message.createdAt);
  if (createdAtMs === null) return "created_at";
  let fieldMask = 0;
  const has = (key: string, bit: number) => {
    if (!Object.hasOwn(message, key)) return false;
    fieldMask |= bit;
    return true;
  };
  const content = has("content", FANSLY_WS_LIVE_FIELD.content) && typeof message.content === "string"
    ? message.content : null;
  const inReplyTo = has("inReplyTo", FANSLY_WS_LIVE_FIELD.inReplyTo) ? nativeRef(message.inReplyTo) : null;
  const inReplyToRoot = has("inReplyToRoot", FANSLY_WS_LIVE_FIELD.inReplyToRoot)
    ? nativeRef(message.inReplyToRoot) : null;
  const attachments: FanslyWsLiveAttachment[] = [];
  if (has("attachments", FANSLY_WS_LIVE_FIELD.attachments) && Array.isArray(message.attachments)) {
    for (const raw of message.attachments.slice(0, MAX_ATTACHMENTS)) {
      const attachment = wsObject(raw);
      const contentId = nativeRef(attachment?.contentId);
      const contentType = attachment?.contentType;
      if (contentId && typeof contentType === "number" && Number.isSafeInteger(contentType)) {
        attachments.push({ contentType, contentId });
      }
    }
  }
  const type = has("type", FANSLY_WS_LIVE_FIELD.type)
    && typeof message.type === "number" && Number.isSafeInteger(message.type) ? message.type : null;
  const correlationId = has("correlationId", FANSLY_WS_LIVE_FIELD.correlationId)
    ? nativeRef(message.correlationId) : null;
  return { id, groupId, senderId, createdAtMs, content, inReplyTo, inReplyToRoot, attachments, type,
    correlationId, fieldMask };
}

/** The live overlay decoder (plan §7.2): reads an already durable B0 frame and
 * names every message created or deleted in it. Same envelope walk and bounds
 * as the hint extractor. A message frame without its required fields (`id`,
 * `groupId`, `senderId`, a parseable `createdAt`; a deletion needs only `id`)
 * is `invalid`, never a partial row. Pure: no I/O, no clock. */
export function decodeFanslyWsLiveFrame(frame: string): FanslyWsLiveDecode {
  const items: FanslyWsLiveItem[] = [];
  const decode = { decoderVersion: FANSLY_WS_LIVE_DECODER_VERSION, items };
  if (Buffer.byteLength(frame) > FANSLY_WS_MAX_FRAME_BYTES) {
    items.push({ kind: "limit", path: [] });
    return decode;
  }
  let visited = 0;
  function visit(encoded: unknown, path: number[]) {
    if (path.length > MAX_DEPTH || visited >= MAX_NODES) { items.push({ kind: "limit", path }); return; }
    visited += 1;
    const wrapper = wsObject(encoded);
    if (!wrapper) { items.push({ kind: "invalid", path, reason: "envelope" }); return; }
    if (wrapper.t === 10001) {
      const children = wsJson(wrapper.d);
      if (!Array.isArray(children)) { items.push({ kind: "invalid", path, reason: "envelope" }); return; }
      for (let i = 0; i < children.length; i++) {
        // Count containers too, so empty/nested batches cannot bypass the bound.
        if (visited >= MAX_NODES) { items.push({ kind: "limit", path: [...path, i] }); return; }
        visit(children[i], [...path, i]);
      }
      return;
    }
    if (wrapper.t !== 10000) { items.push({ kind: "other", path }); return; }
    const service = wsObject(wrapper.d);
    const event = wsObject(service?.event);
    if (!service || !event) { items.push({ kind: "invalid", path, reason: "envelope" }); return; }
    if (service.serviceId !== 5 || (event.type !== 1 && event.type !== 10)) {
      items.push({ kind: "other", path });
      return;
    }
    const message = wsObject(event.message);
    if (!message) { items.push({ kind: "invalid", path, reason: "message_id" }); return; }
    if (event.type === 10) {
      const messageId = nativeRef(message.id);
      if (!messageId) { items.push({ kind: "invalid", path, reason: "message_id" }); return; }
      items.push({ kind: "message_deleted", path, messageId, groupId: nativeRef(message.groupId) });
      return;
    }
    const decoded = liveMessage(message);
    items.push(typeof decoded === "string"
      ? { kind: "invalid", path, reason: decoded }
      : { kind: "message_created", path, message: decoded });
  }
  visit(frame, []);
  return decode;
}
