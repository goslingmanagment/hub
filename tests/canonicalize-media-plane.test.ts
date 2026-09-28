// WP-F0(b) v5 — the media plane's golden fixtures.
//
// The payload below is SYNTHETIC and re-keyed. Its SHAPE is a live paid-video
// DM page: a message carrying one attachment, one `accountMedia` row whose
// `permissions.permissionFlags[0].price` is 79 000 and whose
// `saleStats` is `{sales: 1, total: 63 200, pending: 63 200}`, and one
// `accountMediaOrders[]` row with NO order id. Those two money numbers are the
// ones that must survive: 79 000 is what the fan is asked for, 63 200 is what
// the creator KEPT (A12 — saleStats.total is net, not gross). They are
// different numbers for the same sale and must never be mistaken for each
// other, so both are pinned literally.
//
// Three properties this file exists to make unbreakable:
//
//  1. TIME (§3.2b). media/order/attachment events are RECEIPT-TIME; the
//     provider instant is a typed field in `data`. A clamp marker on any of
//     them is a FAILURE SIGNAL — it would prove the family dated the draft at
//     provider time after all, and a historical drain would then aim appends
//     at months that tiering may have detached. Only
//     `message.material_observed` is provider-dated, because the archive's
//     occurred_at IS the message time.
//  2. MONEY. Mills travel as decimal STRINGS (JSON cannot carry a bigint and a
//     float re-opens the 1000x footgun). A sparse `saleStats` is NULL
//     everywhere — "the platform did not serve this", never zero.
//  3. NO URLs. `media.location`, `media.locations[]` and every `variants[]`
//     entry are signed CDN addresses. They stay raw-journal-only and may not
//     appear in any event.

import { describe, expect, it } from "vitest";

import {
  clampDraftOccurredAt,
  OCCURRED_AT_CLAMP_MIN,
} from "../apps/runtime/src/services/canonicalize-driver.ts";
import {
  canonicalizeSyncPullObservation,
  SYNC_PULL_CANONICALIZER_VERSION,
} from "../apps/runtime/src/services/canonicalize/sync-pull.ts";
import type {
  CanonicalEventDraft,
  CanonicalizableObservation,
} from "../apps/runtime/src/services/canonicalize/types.ts";

const PAGE_ID = 3;
const OWN_REF = "acct-creator";
const FAN_REF = "acct-fan";
const RECEIVED_AT = new Date("2026-08-19T12:00:00Z");
const NOW = new Date("2026-08-19T12:05:00Z");

const CONTEXT = {
  nativeAccountRefByAccountId: new Map<number, string>([[PAGE_ID, OWN_REF]]),
};

const PERMISSION_ENTRY = {
  id: "perm-1",
  accountMediaId: "media-offer-1",
  type: 0,
  flags: 9,
  price: 79_000,
  metadata: "{\"1\":\"{\\\"price\\\":79000}\"}",
  validAfter: null,
  validBefore: null,
  verificationFlags: 9,
  verificationMetadata: "{}",
};

/** The one paid-video DM page, parameterised by the two things the fixtures
 *  vary: the message time and whether saleStats was served. */
function paidVideoPayload(options?: {
  messageCreatedAt?: number;
  orderCreatedAt?: number;
  saleStats?: unknown;
  includeOrder?: boolean;
}) {
  const messageCreatedAt = options?.messageCreatedAt ?? 1_755_604_800; // 2026-08-19T12:00Z
  const orderCreatedAt = options?.orderCreatedAt ?? messageCreatedAt + 600;
  const media: Record<string, unknown> = {
    id: "media-offer-1",
    accountId: OWN_REF,
    mediaId: "media-1",
    previewId: null,
    permissionFlags: 9,
    price: 79_000,
    createdAt: messageCreatedAt - 3_600,
    deletedAt: null,
    deleted: false,
    permissions: {
      // Deep-cloned: a test that re-prices this entry must not reach back into
      // the module constant and silently re-price every later fixture.
      permissionFlags: [{ ...PERMISSION_ENTRY }],
      accountPermissionFlags: { flags: 0, metadata: "" },
    },
    likeCount: 4,
    whitelist: [],
    media: {
      id: "media-1",
      type: 2,
      status: 1,
      accountId: OWN_REF,
      mimetype: "video/mp4",
      flags: 0,
      filename: "clip.mp4",
      // Signed CDN material. Present here BECAUSE it is present live — the
      // assertions below prove it never leaves the journal.
      location: "https://cdn.example.invalid/signed?Signature=abc&Expires=1",
      width: 2160,
      height: 3840,
      metadata: "{\"originalHeight\":3840,\"originalWidth\":2160,\"duration\":1067.584}",
      updatedAt: messageCreatedAt,
      createdAt: messageCreatedAt - 3_600,
      variants: [{
        id: "variant-1",
        type: 2,
        mimetype: "video/mp4",
        location: "https://cdn.example.invalid/variant?Signature=def",
        locations: [{ locationId: "loc-1", location: "https://cdn.example.invalid/v" }],
      }],
      variantHash: {},
      locations: [{ locationId: "loc-1", location: "https://cdn.example.invalid/m" }],
    },
    purchased: false,
    whitelisted: false,
    accountPermissionFlags: 0,
    access: true,
  };
  if (options?.saleStats !== undefined) {
    if (options.saleStats !== null) {
      media.saleStats = options.saleStats;
    }
  } else {
    media.saleStats = { sales: 1, total: 63_200, pending: 63_200 };
  }

  return {
    messages: [{
      id: "message-1",
      type: 0,
      dataVersion: 1,
      content: "",
      groupId: "group-1",
      senderId: OWN_REF,
      correlationId: "corr-1",
      inReplyTo: null,
      inReplyToRoot: null,
      createdAt: messageCreatedAt,
      attachments: [{
        messageId: "message-1",
        contentType: 1,
        contentId: "media-offer-1",
        pos: 0,
      }],
      embeds: [],
      interactions: [],
      likes: [],
      totalTipAmount: 0,
    }],
    accountMedia: [media],
    accountMediaBundles: [],
    tips: [],
    tipGoals: [],
    accountMediaOrders: options?.includeOrder === false ? [] : [{
      accountId: FAN_REF,
      accountMediaId: "media-offer-1",
      type: 0,
      createdAt: orderCreatedAt,
    }],
    stories: [],
    storyOrders: [],
  };
}

function dmObservation(payload: unknown, receivedAt = RECEIVED_AT): CanonicalizableObservation {
  return {
    id: 900,
    source: "pull",
    producer: "sync:fansly:dm_messages",
    platform: "fansly",
    accountId: PAGE_ID,
    kind: "dm_messages",
    payload,
    observedAt: null,
    receivedAt,
  };
}

function byType(events: CanonicalEventDraft[], type: string) {
  return events.filter((event) => event.type === type);
}

function only(events: CanonicalEventDraft[], type: string) {
  const found = byType(events, type);
  expect(found, `expected exactly one ${type}`).toHaveLength(1);
  return found[0]!;
}

describe("sync-pull media plane — golden shapes", () => {
  it("is at version 6 and emits four types from one paid-video DM page", () => {
    expect(SYNC_PULL_CANONICALIZER_VERSION).toBe(6);
    const events = canonicalizeSyncPullObservation(dmObservation(paidVideoPayload()), CONTEXT);
    expect(events.map((event) => event.type).sort()).toEqual([
      "media.observed",
      "media.order_observed",
      "message.attachments_observed",
      "message.material_observed",
      "message.ppv_unlocked",
      "message.sent",
    ]);
  });

  it("media.observed carries identity, price, sale counters and shape — and no URL", () => {
    const events = canonicalizeSyncPullObservation(dmObservation(paidVideoPayload()), CONTEXT);
    const media = only(events, "media.observed");

    expect(media.data).toMatchObject({
      subject: "media",
      mediaOfferRef: "media-offer-1",
      ownerAccountRef: OWN_REF,
      mediaRef: "media-1",
      previewRef: null,
      bundleRefs: [],
      mediaType: 2,
      mimeType: "video/mp4",
      width: 2160,
      height: 3840,
      // 1067.584 s of video, truncated to whole ms.
      durationMs: 1_067_584,
      // 79 000 mills = what the fan is asked for. A STRING, not a number.
      priceMills: "79000",
      permissionFlags: 9,
      likeCount: 4,
      salesCount: 1,
      // 63 200 mills = what the creator KEEPS (A12). NOT the same as the ask.
      salesNetMills: "63200",
      salesPendingMills: "63200",
      firstOrigin: "dm_sidecar",
    });
    expect(media.data.priceMills).not.toBe(media.data.salesNetMills);
    // Every permissions.permissionFlags[] row survives VERBATIM: a media row
    // can carry several prices (tier-gated, promo, verification-gated) and
    // collapsing them to one number silently picks a winner.
    expect(media.data.permissionEntries).toEqual([PERMISSION_ENTRY]);

    // dedupKey = media:v1:<page>:<accountMediaId>:<contentHash>
    expect(media.dedupKey).toMatch(/^media:v1:3:media-offer-1:[0-9a-f]{64}$/);
    expect(media.dedupKey.endsWith(String(media.data.contentHash))).toBe(true);

    // No signed CDN address, anywhere in the event.
    expect(JSON.stringify(media)).not.toMatch(/cdn\.example\.invalid|Signature=|variants/);
  });

  it("a SPARSE saleStats yields NULL sale counters, never 0", () => {
    const events = canonicalizeSyncPullObservation(
      dmObservation(paidVideoPayload({ saleStats: null })),
      CONTEXT,
    );
    const media = only(events, "media.observed");
    expect(media.data).toMatchObject({
      salesCount: null,
      salesNetMills: null,
      salesPendingMills: null,
      // …while the price is still known: absence of sales is not absence of
      // an offer.
      priceMills: "79000",
    });

    // A saleStats served with only `sales` leaves the money halves null.
    const partial = canonicalizeSyncPullObservation(
      dmObservation(paidVideoPayload({ saleStats: { sales: 2 } })),
      CONTEXT,
    );
    expect(only(partial, "media.observed").data).toMatchObject({
      salesCount: 2,
      salesNetMills: null,
      salesPendingMills: null,
    });
  });

  it("message.attachments_observed carries per-attachment offer state + buyer refs", () => {
    const events = canonicalizeSyncPullObservation(dmObservation(paidVideoPayload()), CONTEXT);
    const attachments = only(events, "message.attachments_observed");

    expect(attachments).toMatchObject({
      messageRef: "message-1",
      conversationRef: "group-1",
    });
    expect(attachments.data).toMatchObject({
      messageId: "message-1",
      conversationRef: "group-1",
      senderRef: OWN_REF,
      buyerRefs: [FAN_REF],
    });
    expect(attachments.data.attachments).toEqual([{
      pos: 0,
      contentType: 1,
      contentRef: "media-offer-1",
      bundleRef: null,
      mediaOfferRef: "media-offer-1",
      priceMills: "79000",
      permissionEntries: [PERMISSION_ENTRY],
      mimeType: "video/mp4",
      durationMs: 1_067_584,
      // Bought-ness is answered by ORDER EVIDENCE in this same response, never
      // by the served `purchased` flag — that flag describes OUR access to our
      // own media, and it is `false` in this fixture while the fan HAS bought.
      purchased: true,
      access: true,
      salesCount: 1,
      salesNetMills: "63200",
      salesPendingMills: "63200",
      buyerRefs: [FAN_REF],
    }]);
    expect(attachments.dedupKey).toMatch(/^msgatt:v1:3:message-1:[0-9a-f]{64}$/);
  });

  it("media.order_observed keys on the composite, because DM order rows have no order id", () => {
    const events = canonicalizeSyncPullObservation(dmObservation(paidVideoPayload()), CONTEXT);
    const order = only(events, "media.order_observed");

    expect(order).toMatchObject({
      fanIdentityRef: FAN_REF,
      conversationRef: "group-1",
      messageRef: "message-1",
    });
    expect(order.data).toMatchObject({
      mediaOfferRef: "media-offer-1",
      mediaRef: "media-offer-1",
      bundleRef: null,
      buyerRef: FAN_REF,
      orderType: 0,
      // A DM sidecar row carries no order id, so a DM-first order keeps a
      // NULL order_ref for good (see the coexistence test below). Only a
      // versioned change may ever make an order id the key.
      orderRef: null,
      priceMills: "79000",
      conversationRef: "group-1",
      messageRef: "message-1",
    });
    expect(order.dedupKey)
      .toBe(`mediaorder:v1:3:media-offer-1:${FAN_REF}:${1_755_604_800 + 600}`);
    // The dedup key is the COMPOSITE, but `data` still carries a content hash:
    // media_orders.content_hash is NOT NULL and the projector's lineage guard
    // skips any event without one. Without this the order lane projected
    // nothing at all, silently — which is exactly what happened once.
    expect(order.data.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("message.material_observed fills the archive's EXISTING columns (A17-4 variant B)", () => {
    const events = canonicalizeSyncPullObservation(dmObservation(paidVideoPayload()), CONTEXT);
    const material = only(events, "message.material_observed");
    const head = (material.data as { head: Record<string, unknown> }).head;

    expect(head).toMatchObject({
      nativeMessageId: "message-1",
      isSentByMe: true,
      senderPlatformUserId: OWN_REF,
      fanPlatformUserId: null,
      priceMills: "79000",
      isTip: false,
      tipAmountMills: "0",
      originClass: "fansly_dm_sidecar",
    });
    // The media list the archive already understands — ids and shape, no URL.
    expect(head.media).toEqual([{
      id: "media-offer-1",
      type: "video/mp4",
      canView: true,
      isReady: null,
      duration: 1067.584,
    }]);
    // Fansly DM pages serve no tip NOTE, so tipText is declared unobserved and
    // the archive's presence-guarded coalesce cannot wipe another producer's
    // value with a null.
    expect(head.fieldPresence).toEqual({ media: true, reply: true, tipText: false });
    expect(material.dedupKey).toMatch(/^msg-material:message-1:[0-9a-f]{64}$/);
  });
});

describe("Fansly reply material", () => {
  it.each([false, true])("preserves parent/root on text and attached replies (attached=%s)", (attached) => {
    const payload = paidVideoPayload({ includeOrder: false });
    const message = { ...payload.messages[0]!, content: "<p>reply</p>",
      inReplyTo: "parent-1", inReplyToRoot: "root-1",
      attachments: attached ? payload.messages[0]!.attachments : [] };
    const events = canonicalizeSyncPullObservation(dmObservation({ messages: [message] }), CONTEXT);
    expect(only(events, "message.sent").dedupKey).toBe("msg:sent:message-1");
    expect(only(events, "message.material_observed").data.head).toMatchObject({
      reply: { messageId: "parent-1", rootMessageId: "root-1" },
      textHtml: "<p>reply</p>", isSentByMe: true,
      fieldPresence: { media: true, reply: true, tipText: false },
    });
  });

  it("distinguishes absent reply fields, a sparse root clear, and an explicit full clear", () => {
    const message = { ...paidVideoPayload().messages[0]! } as Record<string, unknown>;
    delete message.inReplyTo;
    delete message.inReplyToRoot;
    const head = (fields: Record<string, unknown>) => only(canonicalizeSyncPullObservation(
      dmObservation({ messages: [{ ...message, ...fields }] }), CONTEXT,
    ), "message.material_observed").data.head;
    expect(head({})).toMatchObject({ reply: null, fieldPresence: { reply: false } });
    expect(head({ inReplyToRoot: null })).toMatchObject({ reply: { rootMessageId: null }, fieldPresence: { reply: true } });
    expect(head({ inReplyTo: null, inReplyToRoot: null })).toMatchObject({ reply: null, fieldPresence: { reply: true } });
    expect(head({ inReplyToRoot: "root-only" })).toMatchObject({ reply: { rootMessageId: "root-only" } });
  });

  it("does not add material for ordinary unlinked text", () => {
    const message = { ...paidVideoPayload().messages[0]!, attachments: [] } as Record<string, unknown>;
    delete message.inReplyTo;
    delete message.inReplyToRoot;
    const events = canonicalizeSyncPullObservation(dmObservation({ messages: [message] }), CONTEXT);
    expect(events.map((event) => event.type)).toEqual(["message.sent"]);
  });
});

describe("§3.2b time semantics — the two pre-2024 fixtures", () => {
  // 2022-11-05T08:30:00Z. Below OCCURRED_AT_CLAMP_MIN by years, which is the
  // whole point: a v5 drain re-reads DM history this old.
  const ANCIENT_SECONDS = 1_667_636_100;
  const ANCIENT_ISO = new Date(ANCIENT_SECONDS * 1000).toISOString();

  function ancientEvents() {
    return canonicalizeSyncPullObservation(
      dmObservation(paidVideoPayload({
        messageCreatedAt: ANCIENT_SECONDS,
        orderCreatedAt: ANCIENT_SECONDS + 600,
      })),
      CONTEXT,
    );
  }

  it("guards the premise: the fixture really is outside the clamp window", () => {
    expect(new Date(ANCIENT_SECONDS * 1000).getTime())
      .toBeLessThan(OCCURRED_AT_CLAMP_MIN.getTime());
  });

  it("FIXTURE 1 (receipt-time): media/order/attachments carry NO clamp marker", () => {
    const events = ancientEvents();
    for (const type of ["media.observed", "media.order_observed", "message.attachments_observed"]) {
      const draft = only(events, type);
      // Dated at the observation's receipt — by construction inside the clamp
      // window, so the clamp is a NO-OP and cannot mark them.
      expect(draft.occurredAt, type).toEqual(RECEIVED_AT);
      const clamped = clampDraftOccurredAt(draft, RECEIVED_AT, NOW);
      expect(clamped, `${type} must pass the clamp through identically`).toBe(draft);
      expect(clamped.data.occurredAtClamped, type).toBeUndefined();
      expect(clamped.data.occurredAtRaw, type).toBeUndefined();
    }

    // The pre-2024 provider instants are present and TYPED in `data` — that is
    // where they live, and the projections date rows from there.
    expect(only(events, "media.order_observed").data.orderedAt)
      .toBe(new Date((ANCIENT_SECONDS + 600) * 1000).toISOString());
    expect(only(events, "message.attachments_observed").data.messageCreatedAt)
      .toBe(ANCIENT_ISO);
    expect(only(events, "media.observed").data.createdAtPlatform)
      .toBe(new Date((ANCIENT_SECONDS - 3_600) * 1000).toISOString());
  });

  it("FIXTURE 2 (provider-dated): message.material_observed IS clamped, and keeps the true time", () => {
    const events = ancientEvents();
    const material = only(events, "message.material_observed");

    // The one provider-dated lane in this family: the archive's occurred_at IS
    // the message time, so the draft aims at 2022 and the driver's clamp fires.
    expect(material.occurredAt.toISOString()).toBe(ANCIENT_ISO);

    const clamped = clampDraftOccurredAt(material, RECEIVED_AT, NOW);
    expect(clamped.occurredAt).toEqual(RECEIVED_AT);
    expect(clamped.data.occurredAtClamped).toBe(true);
    expect(clamped.data.occurredAtRaw).toBe(ANCIENT_ISO);

    // …and the archive still dates the row from the HEAD, which kept the TRUE
    // message time through the clamp. Without this the row would land on the
    // day of the drain instead of the day of the conversation.
    const head = (clamped.data as { head: Record<string, unknown> }).head;
    expect(head.messageCreatedAt).toBe(ANCIENT_ISO);
    // The dedup key was built BEFORE the clamp, so a replay stays key-stable.
    expect(clamped.dedupKey).toBe(material.dedupKey);
  });
});

describe("coexistence: message.ppv_unlocked and media.order_observed", () => {
  it("both lanes run, keyed by two different identities, and are never summed", () => {
    const events = canonicalizeSyncPullObservation(dmObservation(paidVideoPayload()), CONTEXT);
    const ppv = only(events, "message.ppv_unlocked");
    const order = only(events, "media.order_observed");

    // The fan-purchase event existing consumers read, unchanged at v5.
    expect(ppv.dedupKey)
      .toBe(`ppv:${FAN_REF}:media-offer-1:${new Date((1_755_604_800 + 600) * 1000).toISOString()}`);
    // The ORDER-identity lane feeding media_orders / commerce serving.
    expect(order.dedupKey).not.toBe(ppv.dedupKey);
    expect(order.type).not.toBe(ppv.type);
  });

  it("an inline DM order row and a purchase_history row mint the SAME order key", () => {
    // This is what collapses the two lanes to ONE media_orders row: the
    // composite key is identical, so the second lane's draft dedupes.
    const dm = canonicalizeSyncPullObservation(dmObservation(paidVideoPayload()), CONTEXT);
    const history = canonicalizeSyncPullObservation({
      ...dmObservation(paidVideoPayload()),
      kind: "purchase_history",
      producer: "sync:fansly:purchase_history",
    }, CONTEXT);

    const dmOrder = only(dm, "media.order_observed");
    const historyOrder = only(history, "media.order_observed");
    expect(historyOrder.dedupKey).toBe(dmOrder.dedupKey);
    // …and the purchase_history lane records that IT saw the media first when
    // it is the first to see it, without pretending to be the DM sidecar.
    expect(only(history, "media.observed").data.firstOrigin).toBe("order_history");
    expect(only(dm, "media.observed").data.firstOrigin).toBe("dm_sidecar");
  });

  it("an order-history row records its orderId, under the SAME composite key", () => {
    const payload = paidVideoPayload();
    // The live order-history row shape: `orderId`, no `id`.
    (payload.accountMediaOrders[0] as Record<string, unknown>).orderId = "order-1";
    const history = only(canonicalizeSyncPullObservation({
      ...dmObservation(payload),
      kind: "purchase_history",
      producer: "sync:fansly:purchase_history",
    }, CONTEXT), "media.order_observed");
    const dm = only(
      canonicalizeSyncPullObservation(dmObservation(paidVideoPayload()), CONTEXT),
      "media.order_observed",
    );

    expect(history.data.orderRef).toBe("order-1");
    expect(dm.data.orderRef).toBeNull();
    // One key for both sightings: whichever lane mints it first decides
    // media_orders.order_ref and the other dedupes. A DM-first order (most of
    // them) therefore keeps order_ref NULL even after order history serves
    // its orderId — the column is not complete.
    expect(history.dedupKey).toBe(dm.dedupKey);
    expect(history.data.contentHash).not.toBe(dm.data.contentHash);
  });

  it("the same order seen twice in one response mints one draft", () => {
    const payload = paidVideoPayload();
    payload.accountMediaOrders.push({ ...payload.accountMediaOrders[0]! });
    const events = canonicalizeSyncPullObservation(dmObservation(payload), CONTEXT);
    expect(byType(events, "media.order_observed")).toHaveLength(1);
  });
});

describe("replay determinism and payload sanity", () => {
  it("is byte-identical across two canonicalizations of the same payload", () => {
    const first = canonicalizeSyncPullObservation(dmObservation(paidVideoPayload()), CONTEXT);
    const second = canonicalizeSyncPullObservation(dmObservation(paidVideoPayload()), CONTEXT);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // Key stability is the property that makes a re-parse append NOTHING.
    expect(second.map((event) => event.dedupKey)).toEqual(first.map((event) => event.dedupKey));
  });

  it("mints a NEW key when the price or the sale counters move, and only then", () => {
    const base = canonicalizeSyncPullObservation(dmObservation(paidVideoPayload()), CONTEXT);
    const repriced = paidVideoPayload();
    (repriced.accountMedia[0]!.permissions as { permissionFlags: { price: number }[] })
      .permissionFlags[0]!.price = 99_000;
    const moved = canonicalizeSyncPullObservation(dmObservation(repriced), CONTEXT);
    expect(only(moved, "media.observed").dedupKey)
      .not.toBe(only(base, "media.observed").dedupKey);

    const resold = paidVideoPayload({ saleStats: { sales: 2, total: 126_400, pending: 0 } });
    expect(only(canonicalizeSyncPullObservation(dmObservation(resold), CONTEXT), "media.observed")
      .dedupKey).not.toBe(only(base, "media.observed").dedupKey);

    // A re-fetch that only moved a signed CDN URL is NOT a new fact.
    const rotatedUrl = paidVideoPayload();
    (rotatedUrl.accountMedia[0]!.media as Record<string, unknown>).location =
      "https://cdn.example.invalid/rotated?Signature=zzz";
    expect(
      only(canonicalizeSyncPullObservation(dmObservation(rotatedUrl), CONTEXT), "media.observed")
        .dedupKey,
    ).toBe(only(base, "media.observed").dedupKey);
  });

  it("keeps every event payload under the 64 KiB sanity ceiling", () => {
    // A wide page: 40 media rows, each with several permission entries, all
    // attached to one message. permission_entries is the array that grows.
    const payload = paidVideoPayload();
    const message = payload.messages[0]!;
    for (let index = 1; index < 40; index += 1) {
      const clone = JSON.parse(JSON.stringify(payload.accountMedia[0])) as Record<string, unknown>;
      clone.id = `media-offer-${index}`;
      (clone.permissions as { permissionFlags: unknown[] }).permissionFlags = [
        { ...PERMISSION_ENTRY, id: `perm-${index}-a`, accountMediaId: clone.id },
        { ...PERMISSION_ENTRY, id: `perm-${index}-b`, accountMediaId: clone.id, price: 129_000 },
        { ...PERMISSION_ENTRY, id: `perm-${index}-c`, accountMediaId: clone.id, price: 39_000 },
      ];
      payload.accountMedia.push(clone as never);
      message.attachments.push({
        messageId: "message-1",
        contentType: 1,
        contentRef: undefined as never,
        contentId: clone.id as string,
        pos: index,
      } as never);
    }

    const events = canonicalizeSyncPullObservation(dmObservation(payload), CONTEXT);
    expect(events.length).toBeGreaterThan(40);
    for (const event of events) {
      const bytes = Buffer.byteLength(JSON.stringify(event.data), "utf8");
      expect(bytes, `${event.type} payload bytes`).toBeLessThan(64 * 1024);
    }
  });

  it("emits nothing for a payload with no sale material at all", () => {
    const events = canonicalizeSyncPullObservation(dmObservation({ messages: [] }), CONTEXT);
    expect(events).toEqual([]);
  });
});
