import { describe, expect, it } from "vitest";

import type { ShiftReviewGenerationRow, ShiftReviewMessageRow, ShiftReviewSendRow } from "@agency_hub_core/db";
import { shiftNumbersOf } from "../apps/runtime/src/services/chatter-numbers.ts";
import { autoOpenings } from "../apps/runtime/src/services/shift-review.ts";

// «Смены» counts a shift as «Разбор смены» does (the audit of 2026-11-08: they differed on all 34 shifts of a week).
// The cases are the audit's: an automated message of the page answered a fan in «Смены»; a fan who wrote after a
// colleague's message, the colleague still on the page, was the chatter's; a reply in the second of the fan's message
// was lost.

const MIN = 60_000;
const START = Date.parse("2026-11-07T08:00:00Z");
const END = START + 4 * 60 * MIN;
const USER = 7;
const COLLEAGUE = 8;
const GREETING = "Hey babe! Thanks for subscribing, check out my menu below";

function row(conv: string, ref: string, at: number, side: "fan" | "page", authorId: number | null = null, text = "hey"): ShiftReviewMessageRow {
  return {
    pageId: 2, platform: "fansly", conv, ref, at: new Date(at), sent: side === "page", text, priceMills: null, tipMills: null, media: 0,
    fanNativeId: side === "fan" ? `fan-${conv}` : null, mass: false, authorId, authorName: authorId === COLLEAGUE ? "Коля" : authorId === USER ? "Мирон" : null,
    bought: null, unarchived: false, deletedAt: null,
  };
}

function send(ref: string, at: number, composedWith = "hand"): ShiftReviewSendRow {
  return {
    pageId: 2, platform: "fansly", ref, conversationRef: null, fanRef: "fan", composedWith, edited: null, observedAt: new Date(at), inArchive: true,
    inSocket: false, deleted: false,
  };
}

function numbers(rows: ShiftReviewMessageRow[], sends: ShiftReviewSendRow[], openings: readonly string[] = []) {
  return shiftNumbersOf({
    rows, sends, fans: { writtenFans: [], paidFans: [] }, userId: USER, username: "Мирон", labelOf: new Map([[2, "lora-2"]]), openings, start: START, end: END,
  });
}

describe("the numbers of a shift, by the review's rules", () => {
  it("takes no answer from the page's automated message: the chatter's message after it is the reply", () => {
    const fan = START + 161 * MIN;
    const rows = [
      row("100", "1", fan, "fan"),
      row("100", "2", fan + 44_000, "page", null, GREETING),
      row("100", "3", fan + 73_000, "page", USER),
    ];
    expect(numbers(rows, [send("3", fan + 73_000)], autoOpenings([GREETING]))).toMatchObject({ messages: 1, replyDelays: [73], waitingAtEnd: 0 });
    // Without it known for automated, the greeting answered the fan and the chatter's message answered nobody.
    expect(numbers(rows, [send("3", fan + 73_000)])).toMatchObject({ messages: 1, replyDelays: [] });
  });

  it("leaves to a colleague a fan who wrote after the colleague's message while they still wrote on the page", () => {
    const rows = [
      // The colleague's chat: Коля wrote 6 minutes before the end, the fan 3 minutes before it.
      row("200", "21", END - 6 * MIN, "page", COLLEAGUE),
      row("200", "22", END - 3 * MIN, "fan"),
      // The chatter's: Мирон wrote, the fan answered and got nothing.
      row("300", "31", END - 20 * MIN, "page", USER),
      row("300", "32", END - 5 * MIN, "fan"),
      // A fan waiting since before the shift who wrote nothing in it: waiting silently, not «без ответа».
      row("400", "41", START - 2 * 60 * MIN, "fan"),
    ];
    expect(numbers(rows, [send("31", END - 20 * MIN)])).toMatchObject({ messages: 1, replyDelays: [], waitingAtEnd: 1 });
  });

  it("counts a reply sent in the second of the fan's message", () => {
    const at = START + 60 * MIN;
    const rows = [row("500", "51", at, "fan"), row("500", "52", at, "page", USER)];
    expect(numbers(rows, [send("52", at, "reply")])).toMatchObject({
      messages: 1, replyDelays: [0], waitingAtEnd: 0, composed: { hand: 0, reply: 1, fix: 0, other: 0 },
    });
  });
});

describe("«ИИ без правки» of a shift, by the review's rule", () => {
  // The journal showed 0 % beside the review's 3 % for one shift (2026-11-09): it counted the Reply button, not the text.
  const ai = (ref: string, conv: string, at: number, feature: string, completion: string): ShiftReviewGenerationRow => ({
    generationRef: ref, feature, pageId: 2, conv, fanRef: null, createdAt: new Date(at), completion, draft: null,
  });
  const PASTED = "that sounds amazing honestly tell me more about your day";
  const EDITED = "you always know how to make me smile babe";
  const HI = "hiii thanks for the follow, how is your day going";

  it("counts an AI text pasted by hand as sent unedited, not a Reply the chatter edited, and leaves a Hi out of the texts", () => {
    const t = START + 30 * MIN;
    const rows = [
      row("600", "61", t, "fan"), row("600", "62", t + 2 * MIN, "page", USER, PASTED),
      row("700", "71", t, "fan"), row("700", "72", t + 3 * MIN, "page", USER, EDITED),
      row("800", "81", t + 4 * MIN, "page", USER, HI),
    ];
    const sends = [send("62", t + 2 * MIN, "hand"), { ...send("72", t + 3 * MIN, "reply"), edited: true }, send("81", t + 4 * MIN, "hi")];
    const generations = [
      ai("g1", "600", t + MIN, "fast-reply", PASTED),
      ai("g2", "700", t + 2 * MIN, "fast-reply", EDITED),
      ai("g3", "800", t + 3 * MIN, "hi-greeting", HI),
    ];
    const result = shiftNumbersOf({
      rows, sends, fans: { writtenFans: [], paidFans: [] }, userId: USER, username: "Мирон", labelOf: new Map([[2, "lora-2"]]), openings: [],
      start: START, end: END, generations, links: new Map(),
    });
    expect(result).toMatchObject({ messages: 3, textMessages: 2, aiUnedited: 1, composed: { hand: 1, reply: 1, fix: 0, other: 1 } });
  });
});
