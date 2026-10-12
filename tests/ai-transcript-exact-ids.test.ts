import { describe, expect, it } from "vitest";

import {
  applyOnlyFansMediaNotes,
  buildAiContextFrameBody,
  buildPrompt,
  compareMessageRefs,
  formatTranscript,
  isTranscriptMessageRef,
  listOnlyFansMediaNoteItems,
  mergeLiveText,
  normalizeTranscriptMessages,
  resolveKnownFanMessages,
  servedWindowOf,
  QUICK_FEATURE_MEDIA_NOTE_LIMITS,
  type AiLiveTextItem,
  type OfapiChatMessage,
  type OnlyFansMessageMedia,
} from "../apps/runtime/src/modules/ai/index.ts";
import { referencePrompts } from "./helpers/ai-prompt-references.ts";

// chat-extension R20 HF-8a: a platform message id stays the exact string its
// store keeps, all the way to the prompt and the coverage answer. Fansly ids
// are 18-19 digits; past 2^53 a double rounds, and from about 9·10^17 its step
// is 128, so different ids read as one number. These pairs are each ONE double
// (docs/project-unite/fansly-web.md in chat-extension):
const PAIR_STEP = ["900000000000000001", "900000000000000002"] as const;
const PAIR_EVEN = ["899999999999999936", "900000000000000064"] as const;
const SAME_DOUBLE_ABSENT = "900000000000000005";

const T0 = Date.parse("2026-10-12T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function row(id: string | number, minutes: number, text: string, mine = false): OfapiChatMessage {
  return { id, text, isSentByMe: mine, createdAt: at(minutes) } as OfapiChatMessage;
}

describe("the pairs really are one double each", () => {
  it("so a numeric key would make each pair one message", () => {
    expect(Number(PAIR_STEP[0])).toBe(Number(PAIR_STEP[1]));
    expect(Number(PAIR_EVEN[0])).toBe(Number(PAIR_EVEN[1]));
    expect(Number(SAME_DOUBLE_ABSENT)).toBe(Number(PAIR_STEP[0]));
    expect(Number(PAIR_EVEN[0])).toBe(Number(PAIR_STEP[0]));
  });
});

describe("message refs", () => {
  it("are decimal ids, kept as the string", () => {
    for (const ref of ["0", "7", "999", "3998001000001", PAIR_STEP[0], "1".repeat(30)]) {
      expect(isTranscriptMessageRef(ref), ref).toBe(true);
    }
    for (const ref of ["", " 7", "7 ", "-7", "7.0", "1e3", "0x1A", "Infinity", "9oo4"]) {
      expect(isTranscriptMessageRef(ref), JSON.stringify(ref)).toBe(false);
    }
  });

  it("order by exact value, never through a double", () => {
    expect(compareMessageRefs(PAIR_STEP[0], PAIR_STEP[1])).toBeLessThan(0);
    expect(compareMessageRefs(PAIR_STEP[1], PAIR_STEP[0])).toBeGreaterThan(0);
    expect(compareMessageRefs(PAIR_EVEN[0], PAIR_EVEN[1])).toBeLessThan(0);
    expect(compareMessageRefs(PAIR_STEP[0], PAIR_STEP[0])).toBe(0);
    // By value, not by the string: a shorter id is a smaller one.
    expect(compareMessageRefs("999", "1000")).toBeLessThan(0);
    expect(compareMessageRefs("4012345678900", "4012345678901")).toBeLessThan(0);
    // 18 against 19 digits.
    expect(compareMessageRefs("999999999999999999", "1000000000000000000")).toBeLessThan(0);
  });

  it("are a total order: equal only as the same string", () => {
    const refs = ["10", "9", "007", "7", "1x", "abc", "", PAIR_STEP[1], PAIR_STEP[0], PAIR_EVEN[1], PAIR_EVEN[0]];
    const sorted = [...refs].sort(compareMessageRefs);
    expect(sorted).toEqual([
      "007", "7", "9", "10", PAIR_EVEN[0], PAIR_STEP[0], PAIR_STEP[1], PAIR_EVEN[1], "", "1x", "abc",
    ]);
    // Antisymmetric and transitive over every triple.
    for (const a of refs) {
      for (const b of refs) {
        expect(Math.sign(compareMessageRefs(a, b)) + Math.sign(compareMessageRefs(b, a)), `${a} ${b}`).toBe(0);
        expect(compareMessageRefs(a, b) === 0, `${a} ${b}`).toBe(a === b);
        for (const c of refs) {
          if (compareMessageRefs(a, b) < 0 && compareMessageRefs(b, c) < 0) {
            expect(compareMessageRefs(a, c), `${a} ${b} ${c}`).toBeLessThan(0);
          }
        }
      }
    }
  });
});

describe("Fansly ids past 2^53 up to the prompt", () => {
  const rows = [
    row(PAIR_EVEN[1], 1, "second of the even pair"),
    row(PAIR_EVEN[0], 0, "first of the even pair"),
    // One instant: only the id orders them.
    row(PAIR_STEP[1], 2, "the larger id of the step pair"),
    row(PAIR_STEP[0], 2, "the smaller id of the step pair", true),
  ];

  it("stay separate messages, in their exact order", () => {
    const messages = normalizeTranscriptMessages(rows);
    expect(messages.map((message) => message.id)).toEqual([PAIR_EVEN[0], PAIR_EVEN[1], PAIR_STEP[0], PAIR_STEP[1]]);
    expect(formatTranscript(messages)).toBe([
      "[10:00] Fan: first of the even pair",
      "[10:01] Fan: second of the even pair",
      "[10:02] Model: the smaller id of the step pair",
      "[10:02] Fan: the larger id of the step pair",
    ].join("\n"));
    // A repeat of the very same id is still one message: the first one stands.
    expect(normalizeTranscriptMessages([...rows, row(PAIR_STEP[0], 9, "a later copy")])).toEqual(messages);
  });

  it("reach every Fansly prompt, each line once", () => {
    const transcript = formatTranscript(normalizeTranscriptMessages(rows));
    for (const { name, input } of referencePrompts().filter((reference) => reference.name.startsWith("fansly "))) {
      const prompt = buildPrompt({ ...input, transcript });
      const text = [...prompt.systemBlocks, ...prompt.userBlocks].map((block) => block.text).join("\n");
      for (const line of transcript.split("\n")) {
        expect(text.split(line).length - 1, `${name}: ${line}`).toBe(1);
      }
    }
  });

  it("each get their own coverage answer", () => {
    const messages = normalizeTranscriptMessages(rows);
    const window = servedWindowOf(messages);
    expect(window.map((message) => message.messageRef)).toEqual(messages.map((message) => message.id));

    const knownFanMessages = resolveKnownFanMessages({
      ids: [PAIR_STEP[1], PAIR_EVEN[1], PAIR_EVEN[0], SAME_DOUBLE_ABSENT, PAIR_STEP[0]],
      window,
      stores: new Map(),
    });
    expect(knownFanMessages).toEqual([
      { id: PAIR_STEP[1], state: "included" },
      { id: PAIR_EVEN[1], state: "included" },
      { id: PAIR_EVEN[0], state: "included" },
      // The window holds three ids of its double, but not this one.
      { id: SAME_DOUBLE_ABSENT, state: "absent" },
      // The model's own message: the hub cannot vouch it is the fan's.
      { id: PAIR_STEP[0], state: "unknown" },
    ]);

    const frame = buildAiContextFrameBody({
      served: { source: "live_union", window, archiveHead: null },
      requestedCount: 100,
      coverage: "unknown",
      knownFanMessages,
      fanLanguageEvidence: "latin",
    });
    expect(frame.servedHead).toEqual({
      messageRef: PAIR_STEP[1], occurredAt: at(2), isFromFan: true,
    });
    expect(frame.window).toEqual({ requested: 100, served: 4 });
  });

  it("join as fresh text beside a held id of the same double", () => {
    const messages = normalizeTranscriptMessages([row(PAIR_STEP[0], 0, "held by the hub")]);
    const items: AiLiveTextItem[] = [
      { platformMessageId: PAIR_STEP[0], direction: "fan", occurredAt: at(0), text: "held by the hub" },
      { platformMessageId: PAIR_STEP[1], direction: "fan", occurredAt: at(3), text: "fresh, same double" },
      { platformMessageId: PAIR_EVEN[1], direction: "model", occurredAt: at(3), text: "fresh, same instant" },
    ];
    const merge = mergeLiveText({ messages, window: servedWindowOf(messages), items, stores: new Map(), limit: 100 });
    expect(merge).toMatchObject({
      accepted: [PAIR_STEP[1], PAIR_EVEN[1]],
      rejected: [],
      conflicts: [],
      matched: 1,
      // Same instant: the larger id is the head.
      headRef: PAIR_EVEN[1],
      hubSawHead: false,
    });
    expect(merge.window.map((message) => message.messageRef)).toEqual([PAIR_STEP[0], PAIR_STEP[1], PAIR_EVEN[1]]);
    expect(formatTranscript(merge.messages)).toBe([
      "[10:00] Fan: held by the hub",
      "[10:03] Fan: fresh, same double",
      "[10:03] Model: fresh, same instant",
    ].join("\n"));
  });

  it("keep their own image notes", () => {
    const messages = normalizeTranscriptMessages([
      { ...row(PAIR_STEP[0], 0, "first"), media: [{ id: "501", type: "photo" }], mediaCount: 1 },
      { ...row(PAIR_STEP[1], 1, "second"), media: [{ id: "502", type: "photo" }], mediaCount: 1 },
    ]);
    const mediaByMessage = new Map<string, OnlyFansMessageMedia>([
      [PAIR_STEP[0], { messageId: PAIR_STEP[0], sender: "fan", paid: false, media: [{ id: "501", type: "photo" }] }],
      [PAIR_STEP[1], { messageId: PAIR_STEP[1], sender: "fan", paid: false, media: [{ id: "502", type: "photo" }] }],
    ]);
    const items = listOnlyFansMediaNoteItems(messages, mediaByMessage);
    expect(items.map((item) => [item.n, item.messageId, item.mediaId])).toEqual([
      [1, PAIR_STEP[0], "501"],
      [2, PAIR_STEP[1], "502"],
    ]);
    const applied = applyOnlyFansMediaNotes({
      messages,
      items,
      descriptions: [{ mediaRef: "502", variant: "full", status: "described", description: "A beach." }],
      limits: QUICK_FEATURE_MEDIA_NOTE_LIMITS,
    });
    expect(formatTranscript(applied.messages)).toBe([
      "[10:00] Fan: [Photo #1] first",
      "[10:01] Fan: [Photo #2: A beach.] second",
    ].join("\n"));
  });
});

describe("OnlyFans ids", () => {
  it("give the same transcript as the number OFAPI sends", () => {
    // OnlyFans ids are 13-14 digits: as numbers they are exact, and the order
    // of their strings is the order the numbers had.
    const shapes: Array<[id: number, minutes: number]> = [
      [3998001000003, 0], [999, 1], [1000, 1], [4012345678901, 2], [4012345678900, 2], [3998001000002, 3],
      [3998001000001, 3], [3998001000002, 4],
    ];
    const asNumbers = shapes.map(([id, minutes], index) => row(id, minutes, `m${index}`, index % 2 === 1));
    const asStrings = shapes.map(([id, minutes], index) => row(String(id), minutes, `m${index}`, index % 2 === 1));
    const fromNumbers = normalizeTranscriptMessages(asNumbers);
    expect(normalizeTranscriptMessages(asStrings)).toEqual(fromNumbers);
    // And the order is the one the numeric sort gave (first copy of an id wins).
    const firstCopies = shapes.filter(([id], index) => shapes.findIndex(([other]) => other === id) === index);
    expect(fromNumbers.map((message) => message.id)).toEqual(
      [...firstCopies]
        .sort(([leftId, leftAt], [rightId, rightAt]) => leftAt - rightAt || leftId - rightId)
        .map(([id]) => String(id)),
    );
  });
});
