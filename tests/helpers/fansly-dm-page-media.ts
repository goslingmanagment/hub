// A fabricated Fansly DM page (`GET /message?groupId=…`, the `response` object)
// with every kind of attachment a transcript meets. Every id is invented:
// round numbers no account, message or file holds.
//
// chat-extension R20 HF-7a (parity row AI-147): the hub's transcript of this
// page is compared with what the Fansly extension 2.10.1 renders for the same
// object (tests/fansly-transcript-media.integration.test.ts).

/** The page's own Fansly account. */
export const MEDIA_PAGE_REF = "500000000000000001";
export const MEDIA_FAN = "600000000000000001";
export const MEDIA_GROUP = "700000000000000001";

/** 2026-10-01T10:00:00Z, in the seconds Fansly serves. */
export const MEDIA_PAGE_BASE_SECONDS = 1_790_848_800;

const PHOTO = { type: 1, mimetype: "image/jpeg" };
const VIDEO = { type: 2, mimetype: "video/mp4" };
/** Fansly's audio is type 100 on prod (2026-10-13, read only). */
const AUDIO = { type: 100, mimetype: "audio/mp4" };

/** Attachment content types: 1 a media, 2 a bundle, 7 a tip, 32001 a story reply. */
type Attachment = [contentType: number, contentId: string];

function message(
  n: number,
  sender: "fan" | "model",
  content: string,
  attachments: Attachment[],
  totalTipAmount = 0,
) {
  return {
    id: `8000000000000000${String(n).padStart(2, "0")}`,
    type: 1,
    dataVersion: 1,
    content,
    groupId: MEDIA_GROUP,
    senderId: sender === "model" ? MEDIA_PAGE_REF : MEDIA_FAN,
    correlationId: "0",
    inReplyTo: null,
    inReplyToRoot: null,
    // One message a minute, from 10:00.
    createdAt: MEDIA_PAGE_BASE_SECONDS + (n - 1) * 60,
    attachments: attachments.map(([contentType, contentId], pos) => ({ contentType, contentId, pos })),
    embeds: [],
    interactions: [],
    likes: [],
    totalTipAmount,
  };
}

function accountMedia(
  id: string,
  owner: "fan" | "model",
  media: { type: number; mimetype: string },
  priceMills?: number,
) {
  const mediaId = `9${id.slice(1)}`;
  return {
    id,
    accountId: owner === "model" ? MEDIA_PAGE_REF : MEDIA_FAN,
    mediaId,
    // A free media carries a permission row too: flags without the PPV bit, price 0.
    permissions: {
      permissionFlags: [priceMills === undefined
        ? { type: 0, flags: 2, price: 0, metadata: "" }
        : { type: 2, flags: 1, price: priceMills, metadata: "" }],
    },
    media: { id: mediaId, ...media },
  };
}

function bundle(id: string, members: string[], priceMills?: number) {
  return {
    id,
    accountId: MEDIA_PAGE_REF,
    accountMediaIds: members,
    bundleContent: members.map((accountMediaId, pos) => ({ accountMediaId, pos })),
    ...(priceMills === undefined
      ? {}
      : { permissions: { permissionFlags: [{ type: 2, flags: 1, price: priceMills, metadata: "" }] } }),
  };
}

export const FANSLY_DM_PAGE_WITH_MEDIA = {
  // Newest first, as Fansly serves a page.
  messages: [
    message(12, "fan", "just text", []),
    // Two media in one message: a label each.
    message(11, "model", "pics", [[1, "810000000000000011"], [1, "810000000000000012"]]),
    // A GIF is a photo; a message of media alone.
    message(10, "fan", "", [[1, "810000000000000010"]]),
    // A story reply's attachment is not media.
    message(9, "fan", "replying to your story", [[32001, "850000000000000001"]]),
    // A bundle the page does not serve.
    message(8, "model", "a set", [[2, "820000000000000099"]]),
    // A media the page does not serve.
    message(7, "fan", "can you see it?", [[1, "810000000000000098"]]),
    // A tip: its attachment is not media.
    message(6, "fan", "for you babe", [[7, "840000000000000001"]], 5000),
    message(5, "fan", "", [[1, "810000000000000009"]]),
    // A paid video, then a free bundle whose id sorts BEFORE the video's: the
    // archive keeps a message's media in id order, the transcript in the message's.
    message(4, "model", "two things", [[1, "830000000000000001"], [2, "820000000000000002"]]),
    message(3, "model", "unlock me", [[1, "810000000000000006"]]),
    message(2, "model", "for you", [[2, "820000000000000001"]]),
    message(1, "fan", "look at this", [[1, "810000000000000001"]]),
  ],
  accountMedia: [
    accountMedia("810000000000000001", "fan", PHOTO),
    accountMedia("810000000000000002", "model", PHOTO),
    accountMedia("810000000000000003", "model", PHOTO),
    accountMedia("810000000000000004", "model", VIDEO),
    accountMedia("810000000000000005", "model", AUDIO),
    accountMedia("810000000000000006", "model", VIDEO, 15_000),
    accountMedia("810000000000000007", "model", { type: 1, mimetype: "image/png" }),
    accountMedia("810000000000000008", "model", { type: 1, mimetype: "image/gif" }),
    accountMedia("810000000000000009", "fan", AUDIO),
    accountMedia("810000000000000010", "fan", { type: 1, mimetype: "image/gif" }),
    accountMedia("810000000000000011", "model", PHOTO),
    accountMedia("810000000000000012", "model", PHOTO),
    accountMedia("830000000000000001", "model", VIDEO, 20_000),
  ],
  accountMediaBundles: [
    // Paid: two photos, a video and an audio (an audio is not counted).
    bundle("820000000000000001", [
      "810000000000000002", "810000000000000003", "810000000000000004", "810000000000000005",
    ], 25_000),
    // Free: two photos and a member the page does not serve.
    bundle("820000000000000002", ["810000000000000007", "810000000000000008", "810000000000000099"]),
  ],
  accountMediaOrders: [],
};
