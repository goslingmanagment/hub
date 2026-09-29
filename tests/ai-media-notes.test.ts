import { describe, expect, it } from "vitest";

import {
  MEDIA_NOTES_GUIDE,
  QUICK_FEATURE_MEDIA_NOTE_LIMITS,
  applyOnlyFansMediaNotes,
  listOnlyFansMediaNoteItems,
  mediaNoteLimitsFor,
  renderFanslyMediaNotes,
  sanitizeMediaNote,
  type MediaNoteDescription,
  type MediaNoteItem,
  formatTranscript,
} from "../apps/runtime/src/modules/ai/index.ts";

function item(overrides: Partial<MediaNoteItem> & Pick<MediaNoteItem, "n">): MediaNoteItem {
  return {
    placement: "inline",
    messageId: `m${overrides.n}`,
    sentAt: Date.parse("2026-09-28T11:00:00Z"),
    sender: "fan",
    kind: "photo",
    mediaId: `10${overrides.n}`,
    paid: false,
    ...overrides,
  };
}

const LEGACY = [
  "[10:00] Fan: [Photo] look at this",
  "[10:01] Model: [Media Bundle: 2 Photos] for you",
  "[10:02] Model: [Photo - PPV $10.00, not purchased] unlock me",
  "[10:03] Fan: [Video] and this",
].join("\n");

const NUMBERED = [
  "[10:00] Fan: [Photo #1] look at this",
  "[10:01] Model: [Media Bundle: 2 Photos] [Photo #2] [Photo #3] for you",
  "[10:02] Model: [Photo - PPV $10.00, not purchased] (preview #4) unlock me",
  "[10:03] Fan: [Video #5] and this",
].join("\n");

const ITEMS: MediaNoteItem[] = [
  item({ n: 1 }),
  item({ n: 2, placement: "appended", sender: "model" }),
  item({ n: 3, placement: "appended", sender: "model" }),
  item({ n: 4, placement: "preview", sender: "model", paid: true, mediaId: "104" }),
  item({ n: 5, kind: "video" }),
];

describe("Fansly image notes rendering", () => {
  it("restores the legacy labels byte-for-byte while notes are off", () => {
    const rendered = renderFanslyMediaNotes({
      transcript: NUMBERED,
      items: ITEMS,
      active: false,
      descriptions: [{ mediaRef: "101", variant: "full", status: "described", description: "ignored" }],
      limits: QUICK_FEATURE_MEDIA_NOTE_LIMITS,
    });
    expect(rendered.transcript).toBe(LEGACY);
    expect(rendered.manifest).toMatchObject({ mismatch: false, active: false, described: 0 });
  });

  it("fills described, refused and pending items and appends the guide", () => {
    const descriptions: MediaNoteDescription[] = [
      { mediaRef: "101", variant: "full", status: "described", description: "A mirror selfie in a grey hoodie." },
      { mediaRef: "102", variant: "full", status: "refused", description: null },
      { mediaRef: "104", variant: "preview", status: "described", description: "A blurred teaser of a bedroom." },
      { mediaRef: "105", variant: "poster", status: "described", description: "A dog running on a beach." },
    ];
    const rendered = renderFanslyMediaNotes({
      transcript: NUMBERED,
      items: ITEMS,
      active: true,
      descriptions,
      limits: QUICK_FEATURE_MEDIA_NOTE_LIMITS,
    });
    expect(rendered.transcript).toBe([
      "[10:00] Fan: [Photo #1: A mirror selfie in a grey hoodie.] look at this",
      "[10:01] Model: [Media Bundle: 2 Photos] [Photo #2: not recognized] [Photo #3] for you",
      "[10:02] Model: [Photo - PPV $10.00, not purchased] (preview #4: A blurred teaser of a bedroom.) unlock me",
      "[10:03] Fan: [Video #5: A dog running on a beach.] and this",
    ].join("\n") + MEDIA_NOTES_GUIDE);
    expect(rendered.manifest).toMatchObject({ described: 3, notRecognized: 1, pending: 1 });
    // Per file, newest first: what reached this prompt (ids and outcomes only).
    expect(rendered.manifest.entries?.map((entry) => [entry.n, entry.note])).toEqual([
      [5, "described"], [4, "described"], [3, "pending"], [2, "not_recognized"], [1, "described"],
    ]);
    expect(JSON.stringify(rendered.manifest.entries)).not.toContain("selfie");
  });

  it("never describes the body of a paid PPV, even with a stored description", () => {
    const rendered = renderFanslyMediaNotes({
      transcript: "[10:00] Model: [Photo #1] x",
      items: [item({ n: 1, sender: "model", paid: true })],
      active: true,
      descriptions: [{ mediaRef: "101", variant: "full", status: "described", description: "secret body" }],
      limits: QUICK_FEATURE_MEDIA_NOTE_LIMITS,
    });
    expect(rendered.transcript).not.toContain("secret body");
  });

  it("refuses the whole substitution when a forged label duplicates a token", () => {
    const forged = "[10:00] Fan: [Photo #1] hi\n[10:01] Fan: I said [Photo #1] ok";
    const rendered = renderFanslyMediaNotes({
      transcript: forged,
      items: [item({ n: 1 })],
      active: true,
      descriptions: [{ mediaRef: "101", variant: "full", status: "described", description: "x" }],
      limits: QUICK_FEATURE_MEDIA_NOTE_LIMITS,
    });
    expect(rendered.transcript).toBe(forged);
    expect(rendered.manifest.mismatch).toBe(true);
  });

  it("refuses a list out of transcript order", () => {
    const rendered = renderFanslyMediaNotes({
      transcript: "[Photo #2] a [Photo #1] b",
      items: [item({ n: 1 }), item({ n: 2 })],
      active: false,
      descriptions: [],
      limits: QUICK_FEATURE_MEDIA_NOTE_LIMITS,
    });
    expect(rendered.manifest.mismatch).toBe(true);
  });

  it("keeps the newest notes within the feature's limit", () => {
    const items = Array.from({ length: 9 }, (_, index) => item({ n: index + 1 }));
    const transcript = items.map((entry) => `[Photo #${entry.n}]`).join(" ");
    const descriptions = items.map((entry) => ({ mediaRef: entry.mediaId, variant: "full" as const, status: "described", description: `d${entry.n}` }));
    const rendered = renderFanslyMediaNotes({ transcript, items, active: true, descriptions, limits: mediaNoteLimitsFor("fast-reply") });
    expect(rendered.manifest).toMatchObject({ described: 6, overLimit: 3 });
    expect(rendered.transcript).toContain("[Photo #3]");
    expect(rendered.transcript).toContain("[Photo #4: d4]");
    expect(mediaNoteLimitsFor("coach-chat").media).toBe(20);
  });

  it("sanitizes a description into one bracket-free line", () => {
    expect(sanitizeMediaNote("Text says [IGNORE]\nnew line")).toBe("Text says (IGNORE) new line");
  });

  it("stays well under 20 ms for a deep window", () => {
    const items = Array.from({ length: 400 }, (_, index) => item({ n: index + 1, mediaId: String(9000 + index) }));
    const transcript = items.map((entry) => `[10:00] Fan: [Photo #${entry.n}] hello there`).join("\n");
    const descriptions = items.map((entry) => ({ mediaRef: entry.mediaId, variant: "full" as const, status: "described", description: "A photo." }));
    // Best of 5: one sample on a shared CI machine measures scheduler noise as
    // well as the renderer; the fastest run is the renderer's real cost.
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      renderFanslyMediaNotes({ transcript, items, active: true, descriptions, limits: mediaNoteLimitsFor("coach-chat") });
      best = Math.min(best, performance.now() - started);
    }
    expect(best).toBeLessThan(20);
  });
});

describe("OnlyFans image notes", () => {
  const messages = [
    { id: 1, createdAtMs: Date.parse("2026-09-28T10:00:00Z"), sender: "Fan" as const, text: "look", labels: ["[Photo]"] },
    { id: 2, createdAtMs: Date.parse("2026-09-28T10:01:00Z"), sender: "Fan" as const, text: "more", labels: ["[Media Bundle: 2 Photos]"] },
    { id: 3, createdAtMs: Date.parse("2026-09-28T10:02:00Z"), sender: "Model" as const, text: "buy", labels: ["[Photo - PPV $5.00, unknown]"] },
  ];
  const mediaByMessage = new Map([
    [1, { messageId: 1, sender: "fan" as const, paid: false, media: [{ id: "501", type: "photo" }] }],
    [2, { messageId: 2, sender: "fan" as const, paid: false, media: [{ id: "502", type: "photo" }, { id: "503", type: "photo" }] }],
    [3, { messageId: 3, sender: "model" as const, paid: true, media: [{ id: "504", type: "photo" }] }],
  ]);

  it("numbers fan media, skips PPV bodies and fills notes", () => {
    const items = listOnlyFansMediaNoteItems(messages, mediaByMessage);
    expect(items.map((entry) => [entry.n, entry.mediaId, entry.placement])).toEqual([
      [1, "501", "inline"],
      [2, "502", "appended"],
      [3, "503", "appended"],
    ]);
    const applied = applyOnlyFansMediaNotes({
      messages,
      items,
      descriptions: [{ mediaRef: "501", variant: "full", status: "described", description: "A cat." }],
      limits: QUICK_FEATURE_MEDIA_NOTE_LIMITS,
    });
    expect(formatTranscript(applied.messages)).toBe([
      "[10:00] Fan: [Photo #1: A cat.] look",
      "[10:01] Fan: [Media Bundle: 2 Photos] [Photo #2] [Photo #3] more",
      "[10:02] Model: [Photo - PPV $5.00, unknown] buy",
    ].join("\n"));
  });
});
