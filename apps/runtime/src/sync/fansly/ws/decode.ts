import {
  decodeFanslyWsLiveFrame,
  FANSLY_WS_CAPTURE_KIND,
  FANSLY_WS_LIVE_DECODER_VERSION,
  FANSLY_WS_LIVE_FIELD,
  FANSLY_WS_MAX_FRAME_BYTES,
  wsJson,
  wsObject,
  type FanslyWsLiveMessage,
} from "@agency_hub_core/shared";

// The engine's WebSocket frame decoder (design §6.1). Pure: no I/O, no clock.
//
// The step-1 overlay decoder (`decodeFanslyWsLiveFrame`) stays the only
// MESSAGE decoder: message items come from it verbatim, so the overlay and the
// router can never disagree about what a message frame said. This module adds
// a decoder for the nodes the step-1 decoder calls `other` — a new chat,
// money (transaction, wallet, PPV order), subscription and payout events —
// with its own version (the overlay's decoder version is not bumped), and
// re-reads the chat id of a message envelope the step-1 decoder refused, so a
// broken frame of a known chat can still target that chat (plan §7 p.10 (a)).
//
// Money decoders read only the fields routing needs (money map §9): a
// `transaction` frame carries no `createdAt` and no fan id; amounts are never
// read — the ledger comes from REST only. Broadcast recognition is not a
// decoder field: the router decides it (§6.2, [A6]).

/** Version of the non-message decoders below (routing only; never stored on
 *  an overlay row). A change of a decoded field or of a required-field rule is
 *  a new version. */
export const WS_ROUTE_DECODER_VERSION = 1;

/** Same bounds as the step-1 walk (`packages/shared/src/fansly-ws-messages.ts`),
 *  so every path it reports is a path indexed here. */
const MAX_DEPTH = 8;
const MAX_NODES = 255;

/** The optional socket fields whose absence makes a message frame incomplete
 *  (plan §7 p.4 "неполный кадр"): the confirmation read goes fast. */
const COMPLETE_FRAME_FIELDS = FANSLY_WS_LIVE_FIELD.content | FANSLY_WS_LIVE_FIELD.attachments;

/** Fansly socket services and event types the router understands (prod
 *  journal, money map §9, ws map §1.6). */
const SERVICE = { group: 4, money: 6, order: 2, subscription: 15, payout: 16 } as const;
const EVENT = {
  groupCreated: 8,
  transaction: 3,
  wallet: 2,
  order: 7,
  subscription: 5,
  payoutRequested: 20,
  payoutUpdated: 21,
} as const;

/** A decoded money/group node that lacks a field its route needs. */
export type WsInvalidReason =
  | "envelope" | "message_id" | "group_id" | "sender_id" | "created_at" | "limit"
  | "group_created" | "transaction" | "wallet" | "order" | "subscription" | "payout_request";

export type WsItem =
  | {
    kind: "message_created";
    path: number[];
    /** The step-1 message, unchanged. */
    message: FanslyWsLiveMessage;
    /** Sent by the page itself (`senderId` = the page's own Fansly id). */
    isOwn: boolean;
    /** Attachments, a tip, or an incomplete frame: confirm on the fast window. */
    fast: boolean;
  }
  | { kind: "message_deleted"; path: number[]; messageId: string; groupId: string | null }
  | { kind: "group_created"; path: number[]; groupRef: string }
  /** svc 6 / type 3: a ledger row was created (status 1) or settled (status 2). */
  | { kind: "transaction"; path: number[]; id: string; type: number; status: number; correlationId: string | null }
  /** svc 6 / type 2: a wallet balance changed. */
  | { kind: "wallet"; path: number[]; id: string }
  /** svc 2 / type 7: a PPV order. */
  | {
    kind: "order";
    path: number[];
    orderId: string;
    accountMediaId: string | null;
    accountMediaBundleId: string | null;
    correlationAccountId: string | null;
  }
  /** svc 15 / type 5: a subscription record changed. */
  | { kind: "subscription"; path: number[]; id: string; subscriberId: string | null; status: number | null }
  /** svc 16 / types 20, 21: a payout request was created or updated. */
  | { kind: "payout_request"; path: number[]; id: string; status: number | null }
  /** A step-1 invalid/limit item, or a money/group node without a required
   *  field. `groupRef`: the chat a broken message envelope still names. */
  | { kind: "invalid"; path: number[]; groupRef: string | null; reason: WsInvalidReason }
  /** Typing, presence, likes, notifications, transport controls …: not news
   *  for any resource, and not a decoder error. */
  | { kind: "other"; path: number[]; serviceId: number | null; eventType: number | null };

export type WsItemKind = WsItem["kind"];

export interface WsFrameDecode {
  messageDecoderVersion: number;
  routeDecoderVersion: number;
  items: WsItem[];
}

interface ServiceNode {
  serviceId: number | null;
  eventType: number | null;
  event: Record<string, unknown> | null;
}

const nativeRef = (value: unknown): string | null =>
  typeof value === "string" && /^[0-9]{1,32}$/.test(value) ? value : null;

const safeInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

const pathKey = (path: readonly number[]): string => path.join(".");

/** Every service envelope of the frame by path, walked like the step-1
 *  decoder (same order, same bounds). */
function indexServiceNodes(frame: string): Map<string, ServiceNode> {
  const nodes = new Map<string, ServiceNode>();
  let visited = 0;
  function visit(encoded: unknown, path: number[]): void {
    if (path.length > MAX_DEPTH || visited >= MAX_NODES) return;
    visited += 1;
    const wrapper = wsObject(encoded);
    if (!wrapper) return;
    if (wrapper.t === 10001) {
      const children = wsJson(wrapper.d);
      if (!Array.isArray(children)) return;
      for (let i = 0; i < children.length; i++) {
        if (visited >= MAX_NODES) return;
        visit(children[i], [...path, i]);
      }
      return;
    }
    if (wrapper.t !== 10000) {
      nodes.set(pathKey(path), { serviceId: null, eventType: null, event: null });
      return;
    }
    const service = wsObject(wrapper.d);
    const event = wsObject(service?.event);
    nodes.set(pathKey(path), {
      serviceId: safeInt(service?.serviceId),
      eventType: safeInt(event?.type),
      event,
    });
  }
  visit(frame, []);
  return nodes;
}

function invalid(path: number[], reason: WsInvalidReason, groupRef: string | null = null): WsItem {
  return { kind: "invalid", path, groupRef, reason };
}

/** A node the step-1 decoder calls `other`: a new chat, money, a
 *  subscription, a payout, or something no resource cares about. */
function decodeBusinessNode(node: ServiceNode | undefined, path: number[]): WsItem {
  if (node === undefined || node.event === null) {
    return { kind: "other", path, serviceId: node?.serviceId ?? null, eventType: node?.eventType ?? null };
  }
  const { serviceId, eventType, event } = node;
  if (serviceId === SERVICE.group && eventType === EVENT.groupCreated) {
    const groupRef = nativeRef(event.id);
    return groupRef === null ? invalid(path, "group_created") : { kind: "group_created", path, groupRef };
  }
  if (serviceId === SERVICE.money && eventType === EVENT.transaction) {
    const transaction = wsObject(event.transaction);
    const id = nativeRef(transaction?.id);
    const type = safeInt(transaction?.type);
    const status = safeInt(transaction?.status);
    if (id === null || type === null || status === null) return invalid(path, "transaction");
    return { kind: "transaction", path, id, type, status, correlationId: nativeRef(transaction?.correlationId) };
  }
  if (serviceId === SERVICE.money && eventType === EVENT.wallet) {
    const id = nativeRef(wsObject(event.wallet)?.id);
    return id === null ? invalid(path, "wallet") : { kind: "wallet", path, id };
  }
  if (serviceId === SERVICE.order && eventType === EVENT.order) {
    const order = wsObject(event.order);
    const orderId = nativeRef(order?.orderId);
    if (orderId === null) return invalid(path, "order");
    return {
      kind: "order",
      path,
      orderId,
      accountMediaId: nativeRef(order?.accountMediaId),
      accountMediaBundleId: nativeRef(order?.accountMediaBundleId),
      correlationAccountId: nativeRef(order?.correlationAccountId),
    };
  }
  if (serviceId === SERVICE.subscription && eventType === EVENT.subscription) {
    const subscription = wsObject(event.subscription);
    const id = nativeRef(subscription?.id);
    if (id === null) return invalid(path, "subscription");
    return {
      kind: "subscription",
      path,
      id,
      subscriberId: nativeRef(subscription?.subscriberId),
      status: safeInt(subscription?.status),
    };
  }
  if (serviceId === SERVICE.payout && (eventType === EVENT.payoutRequested || eventType === EVENT.payoutUpdated)) {
    const request = wsObject(event.payoutRequest);
    const id = nativeRef(request?.id);
    return id === null ? invalid(path, "payout_request") : { kind: "payout_request", path, id, status: safeInt(request?.status) };
  }
  return { kind: "other", path, serviceId, eventType };
}

/**
 * Decode one captured frame for routing. `ownRef` is the page's own Fansly id
 * (`observations.native_account_ref`); without it no message is own.
 */
export function decodeFanslyWsFrame(frame: string, ownRef: string | null): WsFrameDecode {
  const decoded: WsFrameDecode = {
    messageDecoderVersion: FANSLY_WS_LIVE_DECODER_VERSION,
    routeDecoderVersion: WS_ROUTE_DECODER_VERSION,
    items: [],
  };
  const live = decodeFanslyWsLiveFrame(frame);
  decoded.messageDecoderVersion = live.decoderVersion;
  const nodes = Buffer.byteLength(frame) > FANSLY_WS_MAX_FRAME_BYTES ? new Map<string, ServiceNode>() : indexServiceNodes(frame);
  for (const item of live.items) {
    switch (item.kind) {
      case "message_created": {
        const message = item.message;
        const raw = wsObject(nodes.get(pathKey(item.path))?.event?.message);
        const tip = wsObject(raw?.messageTip) !== null;
        const incomplete = (message.fieldMask & COMPLETE_FRAME_FIELDS) !== COMPLETE_FRAME_FIELDS;
        decoded.items.push({
          kind: "message_created",
          path: item.path,
          message,
          isOwn: ownRef !== null && message.senderId === ownRef,
          fast: message.attachments.length > 0 || tip || incomplete,
        });
        break;
      }
      case "message_deleted":
        decoded.items.push({ kind: "message_deleted", path: item.path, messageId: item.messageId, groupId: item.groupId });
        break;
      case "invalid": {
        // A message envelope the step-1 decoder refused may still name its chat.
        const message = wsObject(nodes.get(pathKey(item.path))?.event?.message);
        decoded.items.push(invalid(item.path, item.reason, nativeRef(message?.groupId)));
        break;
      }
      case "limit":
        decoded.items.push(invalid(item.path, "limit"));
        break;
      case "other":
        decoded.items.push(decodeBusinessNode(nodes.get(pathKey(item.path)), item.path));
        break;
    }
  }
  return decoded;
}

/** The frame of a captured socket receipt's body, or null when the body is
 *  not a socket frame. */
export function socketFrameOf(payload: unknown): string | null {
  const envelope = wsObject(payload);
  return envelope?.codec === FANSLY_WS_CAPTURE_KIND && typeof envelope.frame === "string" ? envelope.frame : null;
}

/** Items that are business news (not `other`): the denominator of the decode
 *  debt rule (plan §7 p.10 (d)). */
export function isBusinessWsItem(item: WsItem): boolean {
  return item.kind !== "other";
}
