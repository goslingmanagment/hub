import { describe, expect, it } from "vitest";

import { fanFactLine, parseFanFactsAnswer } from "../apps/runtime/src/services/fan-facts/prompt.ts";

// The facts lane's answer (Chat Memory week 2, week-2.md §3): a fact is kept
// only with a message of this run; a close only for an AI fact of the
// conversation; a fact the memory already holds is not added twice.

const at = (minute: number) => new Date(Date.UTC(2026, 9, 24, 18, minute));
const messages = [
  { messageRef: "9300000001", at: at(0), fromFan: true, text: "hey im Dave", withMedia: false, priceMills: null, tipMills: 0 },
  { messageRef: "9300000002", at: at(1), fromFan: false, text: "hi Dave", withMedia: true, priceMills: 25_000, tipMills: 0 },
  { messageRef: "9300000003", at: at(2), fromFan: true, text: "work at 6 tmrw", withMedia: false, priceMills: null, tipMills: 5_000 },
];
const facts = [
  { id: 7, kind: "about" as const, text: "Живёт в Европе", source: "ai" as const },
  { id: 8, kind: "agreement" as const, text: "Просит звать его Bear", source: "chatter" as const },
];

describe("the facts lane's answer", () => {
  it("keeps facts with a message of the run, maps the number to the message, and drops the rest", () => {
    const answer = parseFanFactsAnswer({
      add: [
        { kind: "about", text: "  Зовут Dave ", message: 1 },
        { kind: "about", text: "Работает с 6 утра", message: 3 },
        { kind: "about", text: "No message", message: 9 },
        { kind: "mood", text: "Wrong kind", message: 1 },
        { kind: "about", text: "живёт в европе", message: 1 },
        { kind: "about", text: "Зовут Dave", message: 1 },
      ],
      close: [{ id: 7, why: "moved" }, { id: 8, why: "a chatter's" }, { id: 99, why: "unknown" }],
    }, { messages, facts });
    expect(answer.add).toEqual([
      { kind: "about", text: "Зовут Dave", messageRef: "9300000001", messageAt: at(0) },
      { kind: "about", text: "Работает с 6 утра", messageRef: "9300000003", messageAt: at(2) },
    ]);
    expect(answer.close).toEqual([{ id: 7, why: "moved" }]);
    expect(answer.dropped).toBe(6);
  });

  it("reads nothing into an answer that is not one", () => {
    expect(parseFanFactsAnswer("oops", { messages, facts })).toEqual({ add: [], close: [], dropped: 0 });
  });

  it("numbers a line with its Moscow time, its sender and its marks", () => {
    expect(fanFactLine(messages[1]!, 2)).toBe("[#2] 24.10 21:01 Model: hi Dave [media, PPV $25]");
    expect(fanFactLine(messages[2]!, 3)).toBe("[#3] 24.10 21:02 Fan: work at 6 tmrw [tip $5]");
  });
});
