// chat-extension R20 HF-7в (parity row AI-144): whether the fan bought a paid
// Fansly attachment, in the transcript the hub loads itself (a request without
// clientContext). The Fansly extension 2.10.1 marks each paid attachment on
// its own label (fansly-chat src/shared/transcript.ts at ff30d00,
// `deriveAttachmentState`, `ppvSuffix`): `[Video - PPV $20.00, purchased]`,
// `[Media Bundle: 2 Photos - PPV $25.00, not purchased]`, `... unknown]`;
// a free attachment carries no mark. It reads the purchase from the DM page's
// inline orders and from `/media/orderhistory` for each paid attachment, on
// every generation; the hub reads what it already holds:
//
//  - paid, and at what price: the permission rows the page served for the
//    attachment's media or bundle (message_media_offers.permission_entries),
//    by the extension's rule: the row with the PPV bit (flags & 1), its price,
//    else the price inside its metadata, else no price;
//  - purchased: an order of the fan in media_orders, matched as the extension
//    matches an order-history row (a single media: its own order of type 1 or
//    none; a bundle: the bundle's order);
//  - not purchased: no such order AND the hub read the target's whole order
//    history — its latest `purchases.targets` walk closed on an empty page or
//    on an order the previous walk saw, every page its walks read is
//    canonicalized, and no order of the fan waits for the media plane;
//  - unknown otherwise: a target never walked (a PPV nobody bought is never
//    walked), a walk still open or closed on a refusal, an order not projected
//    yet, the fan the hub does not know, a failed read.
//
// The fan is the one the page's capture names for the chat
// (page_dm_threads.partner_platform_user_id), never the request's word.
//
// A message whose attachments the media plane has not recorded yet keeps the
// message-level suffix (` - PPV $X.XX, unknown` on its first label, R20
// HF-7a): which attachment the archive's one price belongs to is not known.
// A socket message carries no price (money is REST-only). OnlyFans never
// reads this file.
//
// The client's word (`livePpvContext` on a Fansly page, `live-ppv-fansly-v1`):
// the hub never walks the order history of a PPV nobody bought, so on its own
// it says `unknown` where the released extension said `not purchased`, and a
// purchase reaches media_orders only after a walk. The client reads the open
// chat's newest page from Fansly at the click, as 2.13.0 did on every
// generation, and names each paid attachment with the fan's purchase as Fansly
// answers it now (the page's inline order, else the fan's own
// `/media/orderhistory`). Over the hub's state of the same media or bundle:
//
//  - `purchased` from either side stands: a purchase does not come undone,
//    and the hub's order is the fan's own;
//  - otherwise the client's answer is the state (`not purchased` included: it
//    is Fansly's answer for this fan, read seconds ago — fresher than any
//    closed walk);
//  - an attachment the client did not name keeps the hub's state.
//
// A socket message the archive has not caught has no price here; an attachment
// of it the client names paid gets its mark with the client's price. A stored
// message whose attachments the media plane has not recorded keeps its
// message-level suffix: which of its attachments a price belongs to is still
// not known. The client's word changes this one generation and is stored
// nowhere; the manifest counts what it changed (`livePpv`).

import {
  fanslyPurchaseWalkSubject,
  listPageDmConversationsByPlatformConversationIds,
  readFanslyPurchaseFacts,
  type FanslyPurchaseFacts,
  type FanslyPurchaseOrderRow,
  type FanslyPurchaseTargetKind,
  type FanslyPurchaseWalkRow,
} from "@agency_hub_core/db";
import type { AiLivePpvAttachmentItem } from "@agency_hub_core/contracts";
import { millsFromDollars, millsFromInteger, millsToDollarsNumber, millsToNumber } from "@agency_hub_core/shared";

import type { AppContext } from "../../../bootstrap.ts";
import type { PpvState } from "../prompts/index.ts";
import {
  fanslyMediaLabelBodiesOf,
  readFanslyMessageMedia,
  type FanslyMediaReadInput,
  type FanslyMessageMedia,
  type FanslyRecordedOffer,
} from "./fansly-media.ts";

/** The extension's `PERMISSION_FLAG_PPV`: the bit that makes a row a price. */
const PPV_FLAG = 1;
/** Fansly's order types. */
const ORDER_TYPE_SINGLE = 1;
const ORDER_TYPE_BUNDLE = 2;

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positiveMills(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** A paid attachment: its price in mills, or null when the page served none. */
export interface FanslyPpvOffer {
  priceMills: number | null;
}

/**
 * 2.10.1 `findPpvPermission` + `extractPpvPriceMills` over the stored rows: the
 * first row with the PPV bit makes the attachment paid; its price is a
 * positive `price`, else the one in `metadata` (`{"1": "{\"price\": <mills>}"}`,
 * how Fansly serves a bundle member's or a promo's price), else none. No row
 * with the bit: free (null).
 */
export function fanslyPpvOffer(permissionEntries: readonly unknown[] | undefined): FanslyPpvOffer | null {
  const entry = (permissionEntries ?? [])
    .map(recordOf)
    .find((row) => row !== null && typeof row.flags === "number" && (row.flags & PPV_FLAG) === PPV_FLAG);
  if (entry === undefined || entry === null) {
    return null;
  }
  const price = positiveMills(entry.price);
  if (price !== null) {
    return { priceMills: price };
  }
  if (typeof entry.metadata !== "string" || entry.metadata.length === 0) {
    return { priceMills: null };
  }
  try {
    const outer = recordOf(JSON.parse(entry.metadata));
    const inner = typeof outer?.["1"] === "string" ? recordOf(JSON.parse(outer["1"])) : null;
    return { priceMills: positiveMills(inner?.price) };
  } catch {
    // Malformed metadata: a paid attachment of unknown price, as the extension.
    return { priceMills: null };
  }
}

/** A paid attachment's order-history target. */
export interface FanslyPurchaseTarget {
  kind: FanslyPurchaseTargetKind;
  ref: string;
}

/** 2.10.1 `orderMatchesPurchaseRequest` over a media_orders row of the fan:
 *  a single media's own order (type 1, or none), a bundle's order (named as
 *  the bundle and not a single's, or the bundle's id with type 2). */
export function fanslyOrderMatches(order: FanslyPurchaseOrderRow, target: FanslyPurchaseTarget): boolean {
  if (target.kind === "media") {
    return order.mediaOfferRef === target.ref
      && order.bundleRef === null
      && (order.orderType === null || order.orderType === ORDER_TYPE_SINGLE);
  }
  if (order.bundleRef !== null) {
    return order.bundleRef === target.ref && order.orderType !== ORDER_TYPE_SINGLE;
  }
  return order.orderType === ORDER_TYPE_BUNDLE && order.mediaOfferRef === target.ref;
}

/** The walk closes that read a target's history to its end: an empty page,
 *  or an order the previous whole walk saw (resources/purchases.ts). */
const COMPLETE_WALK_CLOSES: ReadonlySet<string> = new Set(["empty_page", "known_order"]);

/** Whether every order of the target is in media_orders as far as the walk
 *  rows tell: the latest walk is done by reading to the end, and none of its
 *  pages waits for the canonicalizer. */
export function fanslyPurchaseWalkComplete(walk: FanslyPurchaseWalkRow | undefined): boolean {
  return walk !== undefined
    && walk.state === "done"
    && walk.closeReason !== null
    && COMPLETE_WALK_CLOSES.has(walk.closeReason)
    && !walk.pagesPending;
}

/** The fan's state of one paid attachment from the hub's own stores; null
 *  facts: the hub could not tell. */
export function fanslyPpvState(target: FanslyPurchaseTarget, facts: FanslyPurchaseFacts | null): PpvState {
  if (facts === null) {
    return "unknown";
  }
  if (facts.orders.some((order) => fanslyOrderMatches(order, target))) {
    return "purchased";
  }
  if (facts.ordersPending.has(target.ref)) {
    return "unknown";
  }
  return fanslyPurchaseWalkComplete(facts.walks.get(fanslyPurchaseWalkSubject(target))) ? "not purchased" : "unknown";
}

/**
 * The hub's state of an attachment with the client's word over it (the
 * header): `purchased` from either side stands; else the client's answer;
 * else (the client did not name it) the hub's.
 */
export function fanslyPpvStateWithClient(hub: PpvState, clientBought: boolean | undefined): PpvState {
  if (hub === "purchased" || clientBought === true) {
    return "purchased";
  }
  return clientBought === false ? "not purchased" : hub;
}

/** The client's word on the open chat's paid attachments, as the loader reads it. */
export interface FanslyClientPurchases {
  /** Walk subject (`media:<id>` | `bundle:<id>`) → the fan bought it. A
   *  purchase is the target's: one item saying bought makes it bought. */
  bought: Map<string, boolean>;
  /** `<message ref>/<subject>` → the price the client read, in mills (null:
   *  the page served none): what marks a socket message's attachment. */
  offers: Map<string, number | null>;
  /** How many items the client sent. */
  sent: number;
}

/** The key of one attachment of one message (the contract's item key). */
function attachmentKey(messageRef: string, subject: string): string {
  return `${messageRef}/${subject}`;
}

/** Reads a request's Fansly items. */
export function fanslyClientPurchasesOf(items: readonly AiLivePpvAttachmentItem[]): FanslyClientPurchases {
  const bought = new Map<string, boolean>();
  const offers = new Map<string, number | null>();
  for (const item of items) {
    const subject = fanslyPurchaseWalkSubject({ kind: item.contentKind, ref: item.contentRef });
    bought.set(subject, bought.get(subject) === true || item.purchased);
    offers.set(
      attachmentKey(item.platformMessageId, subject),
      item.priceUsd === undefined ? null : millsToNumber(millsFromDollars(item.priceUsd)),
    );
  }
  return { bought, offers, sent: items.length };
}

/** 2.10.1 `ppvSuffix`: ` - PPV $X.XX, <state>`, without the amount when the
 *  page served no price. */
export function fanslyPpvSuffix(offer: FanslyPpvOffer, state: PpvState): string {
  const price = offer.priceMills === null
    ? ""
    : ` $${millsToDollarsNumber(millsFromInteger(offer.priceMills)).toFixed(2)}`;
  return ` - PPV${price}, ${state}`;
}

/** What the transcript's PPV marks rest on, for the generation's manifest:
 *  counts only. */
export interface FanslyPpvManifest {
  paid: number;
  purchased: number;
  notPurchased: number;
  unknown: number;
}

/** What the client's word did to the marks (the manifest's `livePpv`). */
export interface FanslyClientPurchasesApplied {
  sent: number;
  /** Marks the client's word changed, or added (a socket message's). */
  changed: number;
  /** Marks the client's word named with the state the hub had already. */
  matched: number;
  /** Items no served attachment of their message matched (older than the
   *  window, a message the media plane has not recorded, a free one). */
  ignored: number;
}

export interface FanslyTranscriptMediaLabels {
  /** Message ref → its label bodies, a paid attachment's with its mark. */
  bodies: Map<string, string[]>;
  /** The messages whose bodies carry their attachments' own marks (every
   *  attachment recorded): the normalizer adds no message-level suffix. */
  ppvMarked: Set<string>;
  /** Null when no served attachment is paid. */
  ppv: FanslyPpvManifest | null;
  /** The purchase read failed: every paid attachment reads `unknown`
   *  (but for what the client's word says). */
  ppvError: boolean;
  /** The media read the labels come from (the image notes read it too,
   *  fansly-media-notes.ts). */
  media: FanslyMessageMedia;
  /** Only when the request carried the client's word. */
  client: FanslyClientPurchasesApplied | null;
}

/** Whether the media plane recorded every attachment of a stored row (an
 *  item without an id is never shown). Only then is each one's price known;
 *  otherwise the row keeps the message-level suffix. */
function recordedAttachments(
  mediaMetadata: ReadonlyArray<Record<string, unknown>>,
  offers: ReadonlyMap<string, FanslyRecordedOffer> | undefined,
): boolean {
  if (offers === undefined) {
    return false;
  }
  return mediaMetadata.every((item) => typeof item.id !== "string" || item.id.length === 0 || offers.has(item.id));
}

/** One paid attachment the transcript marks. */
export interface FanslyPaidAttachment {
  messageRef: string;
  /** Its place among the message's label bodies. */
  index: number;
  offer: FanslyPpvOffer;
  target: FanslyPurchaseTarget;
  /** A socket message's attachment the client named paid (the hub has no
   *  price for it): its mark exists only by the client's word. */
  byClient: boolean;
}

/**
 * The paid attachments of the served messages: of a stored row whose
 * attachments the media plane recorded, by its permission rows (`ppvMarked`
 * names those rows); of a socket message, by the client's word alone.
 */
export function fanslyPaidAttachmentsOf(
  input: Pick<FanslyMediaReadInput, "stored" | "live">,
  media: Pick<FanslyMessageMedia, "attachments" | "offers">,
  client: FanslyClientPurchases | undefined,
): { paid: FanslyPaidAttachment[]; ppvMarked: Set<string> } {
  const ppvMarked = new Set<string>();
  const paid: FanslyPaidAttachment[] = [];
  for (const row of input.stored) {
    const offers = media.offers.get(row.messageRef);
    const items = media.attachments.get(row.messageRef) ?? [];
    if (items.length === 0 || !recordedAttachments(row.mediaMetadata, offers)) {
      continue;
    }
    ppvMarked.add(row.messageRef);
    items.forEach((item, index) => {
      const offer = fanslyPpvOffer(offers!.get(item.ref)?.permissionEntries);
      if (offer !== null) {
        paid.push({ messageRef: row.messageRef, index, offer, target: { kind: item.as, ref: item.ref }, byClient: false });
      }
    });
  }
  // A socket message has no price in the hub: an attachment of it the client
  // names paid is marked with the client's price.
  if (client !== undefined) {
    for (const message of input.live) {
      (media.attachments.get(message.messageRef) ?? []).forEach((item, index) => {
        const target: FanslyPurchaseTarget = { kind: item.as, ref: item.ref };
        const key = attachmentKey(message.messageRef, fanslyPurchaseWalkSubject(target));
        if (client.offers.has(key)) {
          paid.push({ messageRef: message.messageRef, index, offer: { priceMills: client.offers.get(key) ?? null }, target, byClient: true });
        }
      });
    }
  }
  return { paid, ppvMarked };
}

/**
 * Marks each paid attachment's label body (in `bodies`, in place) with its
 * state: the hub's from `facts` (null: the hub could not tell), the client's
 * word over it. Returns what the manifest counts.
 */
export function markFanslyPaidAttachments(
  paid: readonly FanslyPaidAttachment[],
  bodies: Map<string, string[]>,
  facts: FanslyPurchaseFacts | null,
  client: FanslyClientPurchases | undefined,
): { ppv: FanslyPpvManifest | null; client: FanslyClientPurchasesApplied | null } {
  const applied: FanslyClientPurchasesApplied | null = client === undefined
    ? null
    : {
      sent: client.sent,
      changed: 0,
      matched: 0,
      // An item applies where an attachment of its own message is marked.
      ignored: (() => {
        const marked = new Set(paid.map((item) => attachmentKey(item.messageRef, fanslyPurchaseWalkSubject(item.target))));
        return [...client.offers.keys()].filter((key) => !marked.has(key)).length;
      })(),
    };
  if (paid.length === 0) {
    return { ppv: null, client: applied };
  }
  const manifest: FanslyPpvManifest = { paid: paid.length, purchased: 0, notPurchased: 0, unknown: 0 };
  for (const item of paid) {
    const hub = fanslyPpvState(item.target, facts);
    const clientBought = client?.bought.get(fanslyPurchaseWalkSubject(item.target));
    const state = fanslyPpvStateWithClient(hub, clientBought);
    if (applied !== null && clientBought !== undefined) {
      if (item.byClient || state !== hub) applied.changed += 1;
      else applied.matched += 1;
    }
    if (state === "purchased") manifest.purchased += 1;
    else if (state === "not purchased") manifest.notPurchased += 1;
    else manifest.unknown += 1;
    const labels = bodies.get(item.messageRef);
    if (labels !== undefined && labels[item.index] !== undefined) {
      labels[item.index] = `${labels[item.index]}${fanslyPpvSuffix(item.offer, state)}`;
    }
  }
  return { ppv: manifest, client: applied };
}

/**
 * The transcript's Fansly media labels with each paid attachment's purchase
 * mark: the media read of fansly-media.ts over every stored row with media,
 * then — only when an attachment is paid — the chat's fan and what the hub
 * knows of their purchases, with the client's word over it when the request
 * carried one (`client`, the header). A failed purchase read leaves the marks
 * `unknown` but for the client's word, and says so; a failed media read is
 * the caller's (it throws).
 */
export async function loadFanslyTranscriptMediaLabels(
  app: Pick<AppContext, "db">,
  input: FanslyMediaReadInput & { conversationRef: string; client?: FanslyClientPurchases },
): Promise<FanslyTranscriptMediaLabels> {
  const media = await readFanslyMessageMedia(app, input, { allStoredOffers: true });
  const bodies = fanslyMediaLabelBodiesOf(media);
  const { paid, ppvMarked } = fanslyPaidAttachmentsOf(input, media, input.client);
  if (paid.length === 0) {
    return { bodies, ppvMarked, ...markFanslyPaidAttachments(paid, bodies, null, input.client), ppvError: false, media };
  }

  let facts: FanslyPurchaseFacts | null = null;
  let ppvError = false;
  try {
    const [thread] = await listPageDmConversationsByPlatformConversationIds(app.db, {
      platformAccountId: input.pageId,
      platformConversationIds: [input.conversationRef],
    });
    const fan = thread?.partnerPlatformUserId ?? null;
    if (fan !== null && fan !== "") {
      facts = await readFanslyPurchaseFacts(app.db, {
        pageId: input.pageId,
        buyerRef: fan,
        targets: paid.map((item) => item.target),
      });
    }
  } catch {
    ppvError = true;
    facts = null;
  }
  return { bodies, ppvMarked, ...markFanslyPaidAttachments(paid, bodies, facts, input.client), ppvError, media };
}
