// A fabricated Fansly DM page (`GET /message?groupId=…`, the `response`
// object) with paid attachments, and the order history Fansly would serve for
// each of them (`GET /media/orderhistory?accountMediaId=|accountMediaBundleId=`,
// every buyer). Every id is invented: round numbers no account, message or
// file holds.
//
// chat-extension R20 HF-7в (parity row AI-144): the hub's transcript of this
// page is compared with what the Fansly extension 2.10.1 renders for the same
// object after its own order-history checks
// (tests/fansly-transcript-ppv.integration.test.ts).

/** The page's own Fansly account. */
export const PPV_PAGE_REF = "500000000000000002";
/** The chat's fan, and another fan of the page. */
export const PPV_FAN = "600000000000000002";
export const PPV_OTHER_FAN = "600000000000000003";
export const PPV_GROUP = "700000000000000002";

/** 2026-10-01T10:00:00Z, in the seconds Fansly serves. */
export const PPV_PAGE_BASE_SECONDS = 1_790_848_800;

const PHOTO = { type: 1, mimetype: "image/jpeg" };
const VIDEO = { type: 2, mimetype: "video/mp4" };

/** The paid attachments and what happened to each (ids of accountMedia /
 *  accountMediaBundles). */
export const PPV_REFS = {
  /** A video the fan bought: the DM page's own order sidecar says so. */
  boughtInline: "810000000000000201",
  /** A bundle another fan bought; its order history is read to the end. */
  bundleOtherBought: "820000000000000201",
  /** A video the fan bought; its order history (both fans) is read to the end. */
  boughtInHistory: "810000000000000202",
  /** A free photo beside them. */
  free: "810000000000000203",
  /** A bundle nobody bought: Fansly never names it in an order, so it is never walked. */
  neverWalked: "820000000000000202",
  /** A photo whose PPV row carries its price in `metadata`, after a free row
   *  priced 0; another fan bought it, its history is read to the end. */
  metadataPrice: "810000000000000204",
  /** A video whose order-history walk is still running. */
  walkRunning: "810000000000000205",
} as const;

/** Attachment content types: 1 a media, 2 a bundle. */
type Attachment = [contentType: number, contentId: string];

function message(n: number, sender: "fan" | "model", content: string, attachments: Attachment[]) {
  return {
    id: `8000000000000002${String(n).padStart(2, "0")}`,
    type: 1,
    dataVersion: 1,
    content,
    groupId: PPV_GROUP,
    senderId: sender === "model" ? PPV_PAGE_REF : PPV_FAN,
    correlationId: "0",
    inReplyTo: null,
    inReplyToRoot: null,
    // One message a minute, from 10:00.
    createdAt: PPV_PAGE_BASE_SECONDS + (n - 1) * 60,
    attachments: attachments.map(([contentType, contentId], pos) => ({ contentType, contentId, pos })),
    embeds: [],
    interactions: [],
    likes: [],
    totalTipAmount: 0,
  };
}

/** A PPV row as Fansly serves it (prod shape: flags 1, a price in mills). */
function ppv(priceMills: number) {
  return { type: 2, flags: 1, price: priceMills, metadata: "" };
}

function accountMedia(id: string, media: { type: number; mimetype: string }, permissionFlags: unknown[]) {
  const mediaId = `9${id.slice(1)}`;
  return {
    id,
    accountId: PPV_PAGE_REF,
    mediaId,
    permissions: { permissionFlags },
    media: { id: mediaId, ...media },
  };
}

function bundle(id: string, members: string[], priceMills: number) {
  return {
    id,
    accountId: PPV_PAGE_REF,
    accountMediaIds: members,
    bundleContent: members.map((accountMediaId, pos) => ({ accountMediaId, pos })),
    permissions: { permissionFlags: [ppv(priceMills)] },
  };
}

/** A free media's row: flags without the PPV bit, price 0. */
const FREE = [{ type: 0, flags: 2, price: 0, metadata: "" }];

export const FANSLY_DM_PAGE_WITH_PPV = {
  // Newest first, as Fansly serves a page.
  messages: [
    message(7, "fan", "ok", []),
    message(6, "model", "still waiting", [[1, PPV_REFS.walkRunning]]),
    message(5, "model", "special price", [[1, PPV_REFS.metadataPrice]]),
    // Three attachments, each with its own state: bought, free, never walked.
    message(4, "model", "three things", [
      [1, PPV_REFS.boughtInHistory], [1, PPV_REFS.free], [2, PPV_REFS.neverWalked],
    ]),
    message(3, "fan", "wow", []),
    message(2, "model", "a set", [[2, PPV_REFS.bundleOtherBought]]),
    message(1, "model", "unlock me", [[1, PPV_REFS.boughtInline]]),
  ],
  accountMedia: [
    accountMedia(PPV_REFS.boughtInline, VIDEO, [ppv(15_000)]),
    accountMedia("810000000000000211", PHOTO, FREE),
    accountMedia("810000000000000212", PHOTO, FREE),
    accountMedia(PPV_REFS.boughtInHistory, VIDEO, [ppv(20_000)]),
    accountMedia(PPV_REFS.free, PHOTO, FREE),
    accountMedia("810000000000000213", PHOTO, FREE),
    accountMedia("810000000000000214", VIDEO, FREE),
    accountMedia(PPV_REFS.metadataPrice, PHOTO, [
      { type: 0, flags: 4, price: 0, metadata: "" },
      { type: 2, flags: 1, price: 0, metadata: JSON.stringify({ 1: JSON.stringify({ price: 12_000 }) }) },
    ]),
    accountMedia(PPV_REFS.walkRunning, VIDEO, [ppv(10_000)]),
  ],
  accountMediaBundles: [
    bundle(PPV_REFS.bundleOtherBought, ["810000000000000211", "810000000000000212"], 25_000),
    bundle(PPV_REFS.neverWalked, ["810000000000000213", "810000000000000214"], 30_000),
  ],
  // The fan's order of the first video, inline on the page (prod shape: a
  // single is `accountMediaId` with type 1).
  accountMediaOrders: [
    { accountId: PPV_FAN, accountMediaId: PPV_REFS.boughtInline, type: 1, createdAt: PPV_PAGE_BASE_SECONDS + 120 },
  ],
};

/** One order-history row (prod shape, 2026-10-13: a bundle's order names the
 *  bundle in `accountMediaId` with type 2, as a single's names the media with
 *  type 1). */
function order(orderId: string, buyer: string, contentId: string, type: 1 | 2, minute: number) {
  return {
    orderId,
    accountId: buyer,
    correlationAccountId: PPV_PAGE_REF,
    accountMediaId: contentId,
    type,
    createdAt: PPV_PAGE_BASE_SECONDS + minute * 60,
    orderMetadata: "",
  };
}

/** Every order Fansly holds for a target, newest first, every buyer. A target
 *  absent here has none. */
export const PPV_ORDER_HISTORY: Record<string, { kind: "media" | "bundle"; orders: ReturnType<typeof order>[] }> = {
  [PPV_REFS.bundleOtherBought]: {
    kind: "bundle",
    orders: [order("910000000000000201", PPV_OTHER_FAN, PPV_REFS.bundleOtherBought, 2, 30)],
  },
  [PPV_REFS.boughtInHistory]: {
    kind: "media",
    orders: [
      order("910000000000000203", PPV_OTHER_FAN, PPV_REFS.boughtInHistory, 1, 40),
      order("910000000000000202", PPV_FAN, PPV_REFS.boughtInHistory, 1, 20),
    ],
  },
  [PPV_REFS.metadataPrice]: {
    kind: "media",
    orders: [order("910000000000000204", PPV_OTHER_FAN, PPV_REFS.metadataPrice, 1, 50)],
  },
};

/** An order-history page as Fansly serves it (prod keys). */
export function orderHistoryPage(orders: ReadonlyArray<ReturnType<typeof order>>) {
  return { accountMediaOrderHistory: [...orders], aggregationData: { accounts: [] } };
}
