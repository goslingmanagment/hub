import { describe, expect, it } from "vitest";

import type { FanslyMediaKinds } from "@agency_hub_core/db";

import {
  fanslyAttachmentBodies,
  fanslyBundleBody,
  fanslyMediaCategory,
  formatTranscript,
  liveFanslyAttachments,
  normalizeTranscriptMessages,
  storedFanslyAttachments,
  type FanslyRecordedOffer,
} from "../apps/runtime/src/modules/ai/index.ts";

// chat-extension R20 HF-7a, the rules of the Fansly media labels (AI-147):
// the Fansly extension 2.10.1's `describeAttachment` (fansly-chat
// src/shared/transcript.ts at ff30d00) over the hub's own stores. The
// end-to-end reference through the canonicalizer and the database is
// tests/fansly-transcript-media.integration.test.ts.

const photo = { mediaType: 1, mimeType: "image/jpeg" };
const video = { mediaType: 2, mimeType: "video/mp4" };
const audio = { mediaType: 100, mimeType: "audio/mp4" };

describe("Fansly media kinds (2.10.1 classifyMedia)", () => {
  it("reads Fansly's type first, then the MIME family", () => {
    expect([
      fanslyMediaCategory({ mediaType: 1, mimeType: null }),
      fanslyMediaCategory({ mediaType: 2, mimeType: "image/jpeg" }),
      fanslyMediaCategory({ mediaType: 3, mimeType: null }),
      // Prod's audio is type 100 (2026-10-13): the MIME decides.
      fanslyMediaCategory(audio),
      fanslyMediaCategory({ mediaType: null, mimeType: "image/gif" }),
      fanslyMediaCategory({ mediaType: null, mimeType: "image/png" }),
      fanslyMediaCategory({ mediaType: null, mimeType: "video/quicktime" }),
      fanslyMediaCategory({ mediaType: null, mimeType: "application/pdf" }),
      fanslyMediaCategory({ mediaType: null, mimeType: null }),
    ]).toEqual(["photo", "video", "audio", "audio", "photo", "photo", "video", "other", "other"]);
  });
});

describe("a bundle's label (2.10.1 describeBundle)", () => {
  it("counts the photos and videos among the distinct members the page served", () => {
    expect(fanslyBundleBody([
      { ref: "1", media: photo },
      { ref: "2", media: video },
      { ref: "3", media: photo },
      { ref: "1", media: photo },
      { ref: "4", media: audio },
      { ref: "5", media: null },
    ])).toBe("Media Bundle: 2 Photos, 1 Video");
    expect(fanslyBundleBody([{ ref: "1", media: photo }])).toBe("Media Bundle: 1 Photo");
    expect(fanslyBundleBody([{ ref: "2", media: video }, { ref: "3", media: video }])).toBe("Media Bundle: 2 Videos");
  });

  it("says only «Media Bundle» for a bundle of nothing countable, or one the page never served", () => {
    expect(fanslyBundleBody([{ ref: "4", media: audio }, { ref: "5", media: null }])).toBe("Media Bundle");
    expect(fanslyBundleBody([])).toBe("Media Bundle");
    expect(fanslyBundleBody(undefined)).toBe("Media Bundle");
  });
});

describe("a stored row's attachments", () => {
  const item = (id: string, type: string) => ({ id, type, canView: true, isReady: null, duration: null });
  const recorded = (entries: Array<[string, number, number | null]>) =>
    new Map<string, FanslyRecordedOffer>(entries.map(([ref, ordinal, contentType]) => [ref, { ordinal, contentType }]));

  it("takes the MIME type and `bundle` as stored, in the message's order when the media plane recorded it", () => {
    // Stored in id order: the bundle's id sorts before the video's.
    const stored = [item("820000000000000002", "bundle"), item("830000000000000001", "video/mp4")];
    expect(storedFanslyAttachments(stored, recorded([
      ["830000000000000001", 0, 1],
      ["820000000000000002", 1, 2],
    ]))).toEqual([
      { ref: "830000000000000001", as: "media", media: { mediaType: null, mimeType: "video/mp4" } },
      { ref: "820000000000000002", as: "bundle" },
    ]);
    // Not recorded yet: the stored order.
    expect(storedFanslyAttachments(stored, undefined).map((attachment) => attachment.ref))
      .toEqual(["820000000000000002", "830000000000000001"]);
  });

  it("shows an `other` item only as the media or bundle the media plane names it", () => {
    const stored = [item("1", "other"), item("2", "other"), item("3", "other"), item("4", "other"), item("5", "other")];
    expect(storedFanslyAttachments(stored, recorded([
      ["1", 0, 1],
      ["2", 1, 2],
      // A tip and a story reply are not media.
      ["3", 2, 7],
      ["4", 3, 32001],
    ]))).toEqual([
      { ref: "1", as: "media", media: null },
      { ref: "2", as: "bundle" },
    ]);
    // Unrecorded `other` (item 5) is not guessed: no label.
    expect(storedFanslyAttachments([item("5", "other")], undefined)).toEqual([]);
  });

  it("skips an item without an id", () => {
    expect(storedFanslyAttachments([{ type: "image/jpeg" }, { id: 7, type: "image/jpeg" }], undefined)).toEqual([]);
  });
});

describe("a socket message's attachments", () => {
  it("are a media or a bundle by their content type, in the message's order; the rest is not shown", () => {
    expect(liveFanslyAttachments([
      { contentType: 7, contentId: "40" },
      { contentType: 2, contentId: "20" },
      { contentType: 1, contentId: "10" },
      { contentType: 32001, contentId: "50" },
    ])).toEqual([
      { ref: "20", as: "bundle" },
      { ref: "10", as: "media", media: null },
    ]);
  });
});

describe("the label bodies", () => {
  const kinds: FanslyMediaKinds = {
    bundles: new Map([["B", [{ ref: "p", media: photo }, { ref: "v", media: video }]]]),
    media: new Map([["known", video]]),
  };

  it("are the media's word, `Media` for a media of no known kind, the bundle's count", () => {
    expect(fanslyAttachmentBodies([
      { ref: "x", as: "media", media: { mediaType: null, mimeType: "image/jpeg" } },
      { ref: "known", as: "media", media: null },
      { ref: "never-served", as: "media", media: null },
      { ref: "y", as: "media", media: { mediaType: null, mimeType: "audio/mp4" } },
      { ref: "B", as: "bundle" },
      { ref: "unknown-bundle", as: "bundle" },
    ], kinds)).toEqual(["Photo", "Video", "Media", "Audio", "Media Bundle: 1 Photo, 1 Video", "Media Bundle"]);
  });
});

describe("the normalizer with Fansly bodies", () => {
  const at = "2026-10-01T10:00:00.000Z";
  const base = { isSentByMe: true, createdAt: at, text: "two things" };

  it("labels each attachment, the PPV suffix on the first, the tip after", () => {
    const messages = normalizeTranscriptMessages([
      { ...base, id: "1", price: 20, isOpened: null },
      { ...base, id: "2", isSentByMe: false, text: "for you", isTip: true, tipAmount: 5 },
      { ...base, id: "3", price: 15 },
      { ...base, id: "4", text: "no media" },
    ], {
      mediaLabelBodiesByMessageId: new Map([
        ["1", ["Video", "Media Bundle: 2 Photos"]],
        ["2", ["Photo"]],
        // No bodies: the OFAPI reading, as without the option.
        ["3", []],
      ]),
    });
    expect(formatTranscript(messages).split("\n")).toEqual([
      "--- 2026-10-01 ---",
      "[10:00] Model: [Video - PPV $20.00, unknown] [Media Bundle: 2 Photos] two things",
      "[10:00] Fan: [Photo] [Tip: $5.00] for you",
      "[10:00] Model: [PPV $15.00, unknown] two things",
      "[10:00] Model: no media",
    ]);
  });

  it("leaves a message's OFAPI media reading alone without the option", () => {
    const ofapi = [{ ...base, id: "1", media: [{ id: 1, type: "photo" }, { id: 2, type: "video" }], mediaCount: 2, price: 15 }];
    const plain = formatTranscript(normalizeTranscriptMessages(ofapi));
    expect(plain).toBe("--- 2026-10-01 ---\n[10:00] Model: [Media Bundle: 1 Photo, 1 Video - PPV $15.00, unknown] two things");
    expect(formatTranscript(normalizeTranscriptMessages(ofapi, { mediaLabelBodiesByMessageId: new Map() }))).toBe(plain);
  });
});
