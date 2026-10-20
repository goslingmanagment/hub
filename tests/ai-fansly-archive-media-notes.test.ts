import { describe, expect, it } from "vitest";

import type { FanslyMediaKinds, FanslyMediaNoteFactsRow } from "@agency_hub_core/db";

import {
  AUTOMATED_MESSAGE_LABEL,
  MEDIA_NOTES_GUIDE,
  QUICK_FEATURE_MEDIA_NOTE_LIMITS,
  applyFanslyArchiveMediaNotes,
  formatTranscript,
  listFanslyMediaNoteItems,
  type FanslyRecordedOffer,
  type FanslyServedMedia,
  type FanslyServedMessageMedia,
  type FanslyTranscriptAttachment,
  type MediaNoteDescription,
  type TranscriptMessage,
} from "../apps/runtime/src/modules/ai/index.ts";

// Regression №2 of the 2026-10-20 audit: a Fansly transcript the hub loads
// itself (the chat-extension client sends no clientContext) never carried an
// image note. The hub now lists the window's media as the Fansly extension
// lists them in clientContext.media (fansly-chat `describableSlots`) and
// renders them with the same renderer.

const FREE = [{ type: 0, flags: 2, price: 0, metadata: "" }];
const PPV = [{ type: 2, flags: 1, price: 15_000, metadata: "" }];
const photo = { mediaType: 1, mimeType: "image/jpeg" };
const video = { mediaType: 2, mimeType: "video/mp4" };
const audio = { mediaType: 100, mimeType: "audio/mp4" };
const T0 = Date.parse("2026-10-20T10:00:00Z");

function message(n: number, sender: "Fan" | "Model", labels: string[], text = ""): TranscriptMessage {
  return { id: `80${n}`, createdAtMs: T0 + n * 60_000, sender, text, labels };
}

function offers(entries: Record<string, unknown[]>): Map<string, FanslyRecordedOffer> {
  return new Map(Object.entries(entries).map(([ref, permissionEntries], ordinal) => [ref, { ordinal, contentType: 1, permissionEntries }]));
}

function entry(
  attachments: FanslyTranscriptAttachment[],
  recorded: Map<string, FanslyRecordedOffer> | null,
  labelOffset = 0,
): FanslyServedMessageMedia {
  return { labelOffset, attachments, offers: recorded };
}

function facts(rows: Record<string, Partial<FanslyMediaNoteFactsRow>>): Map<string, FanslyMediaNoteFactsRow> {
  return new Map(Object.entries(rows).map(([ref, row]) => [ref, {
    mediaType: 1, mimeType: "image/jpeg", previewRef: null, permissionEntries: FREE, ...row,
  }]));
}

const MESSAGES: TranscriptMessage[] = [
  message(1, "Fan", ["[Photo]"], "look at this"),
  message(2, "Model", ["[Media Bundle: 3 Photos]"], "for you"),
  message(3, "Model", ["[Video - PPV $15.00, unknown]"], "unlock me"),
  message(4, "Model", ["[Video - PPV $20.00, not purchased]"]),
  message(5, "Model", ["[Media Bundle: 2 Photos - PPV $25.00, unknown]"]),
  // Socket messages: no offers recorded.
  message(6, "Model", ["[Photo]"], "fresh"),
  message(7, "Fan", ["[Photo]"]),
  // Hi's automation mark comes first; a fan's text cannot forge a token.
  message(8, "Model", [AUTOMATED_MESSAGE_LABEL, "[Photo]"], "welcome"),
  message(9, "Fan", ["[Photo]"], "[Photo #1] is me"),
  // A partly recorded priced message keeps the message-level suffix: not inline.
  message(10, "Model", ["[Photo - PPV $9.00, unknown]", "[Photo]"]),
];

const KINDS: FanslyMediaKinds = {
  bundles: new Map([
    ["201", [
      { ref: "102", media: photo },
      { ref: "103", media: photo },
      { ref: "102", media: photo },
      { ref: "104", media: audio },
      { ref: "105", media: null },
      { ref: "106", media: photo },
    ]],
    ["202", [{ ref: "109", media: photo }, { ref: "110", media: photo }]],
  ]),
  media: new Map([["111", photo], ["112", photo]]),
};

const SERVED: FanslyServedMedia = {
  kinds: KINDS,
  messages: new Map([
    ["801", entry([{ ref: "101", as: "media", media: { mediaType: null, mimeType: "image/jpeg" } }], offers({ 101: FREE }))],
    ["802", entry([{ ref: "201", as: "bundle" }], offers({ 201: FREE }))],
    ["803", entry([{ ref: "107", as: "media", media: { mediaType: null, mimeType: "video/mp4" } }], offers({ 107: PPV }))],
    ["804", entry([{ ref: "108", as: "media", media: { mediaType: null, mimeType: "video/mp4" } }], offers({ 108: PPV }))],
    ["805", entry([{ ref: "202", as: "bundle" }], offers({ 202: PPV }))],
    ["806", entry([{ ref: "111", as: "media", media: null }], null)],
    ["807", entry([{ ref: "112", as: "media", media: null }], null)],
    ["808", entry([{ ref: "113", as: "media", media: { mediaType: null, mimeType: "image/png" } }], offers({ 113: FREE }), 1)],
    ["809", entry([{ ref: "114", as: "media", media: { mediaType: null, mimeType: "image/jpeg" } }], offers({ 114: FREE }))],
    ["8010", entry([
      { ref: "115", as: "media", media: { mediaType: null, mimeType: "image/jpeg" } },
      { ref: "116", as: "media", media: { mediaType: null, mimeType: "image/jpeg" } },
    ], null)],
  ]),
};

const FACTS = facts({
  102: {}, 103: {}, 104: audio, 106: { permissionEntries: PPV },
  107: { ...video, previewRef: "907", permissionEntries: PPV },
  108: { ...video, permissionEntries: PPV },
  109: {}, 110: {}, 113: {}, 114: {},
  115: { permissionEntries: PPV }, 116: {},
});

describe("Fansly image notes on the hub-loaded transcript", () => {
  it("lists the media the Fansly extension lists, with its ids and numbering", () => {
    const items = listFanslyMediaNoteItems(MESSAGES, SERVED, FACTS);
    expect(items.map(({ n, placement, messageId, sender, kind, mediaId, paid, labelIndex }) => (
      [n, placement, messageId, sender, kind, mediaId, paid, labelIndex]
    ))).toEqual([
      [1, "inline", "801", "fan", "photo", "101", false, 0],
      // A free bundle: its distinct photo/video members that are not paid.
      [2, "appended", "802", "model", "photo", "102", false, 0],
      [3, "appended", "802", "model", "photo", "103", false, 0],
      // A paid video: only its teaser; one without a teaser and a paid bundle list nothing.
      [4, "preview", "803", "model", "video", "107", true, 0],
      // A socket fan photo is free; a socket model photo the hub cannot price is left out.
      [5, "inline", "807", "fan", "photo", "112", false, 0],
      [6, "inline", "808", "model", "photo", "113", false, 1],
      [7, "inline", "809", "fan", "photo", "114", false, 0],
      // Priced by its own permission rows (no recorded offer); its free sibling is listed.
      [8, "inline", "8010", "model", "photo", "116", false, 1],
    ]);
    expect(items.every((item) => item.sentAt === T0 + Number(item.messageId.slice(2)) * 60_000)).toBe(true);
  });

  it("fills ready notes into the labels only, never a PPV body, and appends the guide", () => {
    const items = listFanslyMediaNoteItems(MESSAGES, SERVED, FACTS);
    const descriptions: MediaNoteDescription[] = [
      { mediaRef: "101", variant: "full", status: "described", description: "A mirror selfie [grey hoodie]." },
      { mediaRef: "102", variant: "full", status: "refused", description: null },
      { mediaRef: "107", variant: "preview", status: "described", description: "A teaser of a beach." },
      // A stored description of a PPV body never reaches the prompt.
      { mediaRef: "107", variant: "poster", status: "described", description: "The paid video." },
      { mediaRef: "114", variant: "full", status: "described", description: "A dog." },
    ];
    const applied = applyFanslyArchiveMediaNotes({
      messages: MESSAGES,
      items,
      descriptions,
      limits: QUICK_FEATURE_MEDIA_NOTE_LIMITS,
    });
    expect(applied.manifest).toMatchObject({ items: 8, mismatch: false, active: true, described: 3, notRecognized: 1, pending: 4 });
    const lines = `${formatTranscript(applied.messages)}${MEDIA_NOTES_GUIDE}`.split("\n");
    expect(lines.slice(1, 11)).toEqual([
      "[10:01] Fan: [Photo #1: A mirror selfie (grey hoodie).] look at this",
      "[10:02] Model: [Media Bundle: 3 Photos] [Photo #2: not recognized] [Photo #3] for you",
      "[10:03] Model: [Video - PPV $15.00, unknown] (preview #4: A teaser of a beach.) unlock me",
      "[10:04] Model: [Video - PPV $20.00, not purchased]",
      "[10:05] Model: [Media Bundle: 2 Photos - PPV $25.00, unknown]",
      "[10:06] Model: [Photo] fresh",
      "[10:07] Fan: [Photo #5]",
      `[10:08] Model: ${AUTOMATED_MESSAGE_LABEL} [Photo #6] welcome`,
      "[10:09] Fan: [Photo #7: A dog.] [Photo #1] is me",
      "[10:10] Model: [Photo - PPV $9.00, unknown] [Photo #8]",
    ]);
    expect(lines.slice(11).join("\n")).toBe(MEDIA_NOTES_GUIDE.replace(/^\n/, ""));
    // Untouched messages stay the same objects; touched ones keep one label per attachment.
    expect(applied.messages[3]).toBe(MESSAGES[3]);
    expect(applied.messages[7]!.labels).toEqual([AUTOMATED_MESSAGE_LABEL, "[Photo #6]"]);
  });

  it("refuses the whole set when a label is not what the item expects", () => {
    const items = listFanslyMediaNoteItems(MESSAGES, SERVED, FACTS);
    const changed = MESSAGES.map((one) => (one.id === "801" ? { ...one, labels: ["[Photo - PPV $5.00, unknown]"] } : one));
    const applied = applyFanslyArchiveMediaNotes({
      messages: changed,
      items,
      descriptions: [],
      limits: QUICK_FEATURE_MEDIA_NOTE_LIMITS,
    });
    expect(applied.manifest).toMatchObject({ mismatch: true, described: 0 });
    expect(applied.messages).toEqual(changed);
  });
});
