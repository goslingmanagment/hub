import { describe, expect, it } from "vitest";

import { buildFanFactsUserText, fanFactLine, parseFanFactsAnswer } from "../apps/runtime/src/services/fan-facts/prompt.ts";

// The facts lane's answer (Chat Memory week 2, week-2.md §3): a fact is kept
// only with a message of this run; a close only for an AI fact of the
// conversation; a fact the memory already holds is not added twice.

const at = (minute: number) => new Date(Date.UTC(2026, 9, 24, 18, minute));
const now = new Date(Date.UTC(2026, 9, 24, 19, 0));
const messages = [
  { messageRef: "9300000001", context: false, at: at(0), fromFan: true, text: "hey im Dave", withMedia: false, priceMills: null, tipMills: 0 },
  { messageRef: "9300000002", context: false, at: at(1), fromFan: false, text: "hi Dave", withMedia: true, priceMills: 25_000, tipMills: 0 },
  { messageRef: "9300000003", context: false, at: at(2), fromFan: true, text: "work at 6 tmrw", withMedia: false, priceMills: null, tipMills: 5_000 },
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
    }, { messages, facts, now });
    expect(answer.add).toEqual([
      { kind: "about", text: "Зовут Dave", messageRef: "9300000001", messageAt: at(0) },
      { kind: "about", text: "Работает с 6 утра", messageRef: "9300000003", messageAt: at(2) },
    ]);
    expect(answer.close).toEqual([{ id: 7, why: "moved" }]);
    expect(answer.dropped).toBe(6);
  });

  it("takes a fact only from a new line, about the fan only from his own, and never brings back what was removed", () => {
    // Review 2026-10-25: context lines an earlier run read were numbered like new ones, so a fact a chatter
    // deleted came back from its old message; and «about» facts were taken from the model's own lines.
    const run = [{ ...messages[0]!, context: true }, messages[1]!, messages[2]!];
    const removed = [
      { kind: "about" as const, text: "Работает с 6 утра", messageRef: "9300000001", state: "deleted" as const },
      { kind: "promise" as const, text: "Обещал чаевые в пятницу", messageRef: "9300000001", state: "closed" as const },
    ];
    const answer = parseFanFactsAnswer({
      add: [
        { kind: "about", text: "Зовут Dave", message: 1 },
        { kind: "about", text: "Любит душ", message: 2 },
        { kind: "about", text: "работает с 6 утра", message: 3 },
        { kind: "promise", text: "Обещал чаевые в пятницу", message: 3 },
        { kind: "agreement", text: "Видео за $25", message: 2 },
      ],
      close: [],
    }, { messages: run, facts, removed, now });
    expect(answer.add.map((fact) => [fact.kind, fact.text, fact.messageRef])).toEqual([
      ["promise", "Обещал чаевые в пятницу", "9300000003"],
      ["agreement", "Видео за $25", "9300000002"],
    ]);
    expect(answer.dropped).toBe(3);
  });

  it("keeps his name from a model line calling him by it, and no open promise or deal from an old message", () => {
    // Audit 2026-10-26: «Зовут X» was lost when only the model's line named him; promises from 2025 showed as open.
    const old = { ...messages[2]!, messageRef: "9300000000", at: new Date(Date.UTC(2026, 8, 1, 12, 0)) };
    const answer = parseFanFactsAnswer({
      add: [
        { kind: "about", text: "Зовут Dave", message: 2 },
        { kind: "about", text: "Любит душ", message: 2 },
        { kind: "promise", text: "Обещал чаевые в пятницу", message: 1 },
        { kind: "agreement", text: "Видео за $25", message: 1 },
        { kind: "about", text: "Работает с 6 утра", message: 1 },
      ],
      close: [],
    }, { messages: [old, messages[1]!], facts: [], now });
    expect(answer.add.map((fact) => [fact.kind, fact.text])).toEqual([["about", "Зовут Dave"], ["about", "Работает с 6 утра"]]);
    expect(answer.dropped).toBe(3);
  });

  it("dates the request, shows the lines read before as context, apart from the new ones, numbered on", () => {
    const text = buildFanFactsUserText([{ ...messages[0]!, context: true }, messages[1]!], [], now);
    expect(text.startsWith("Today: 24.10.2026 (Sat), Moscow time.")).toBe(true);
    expect(text).toContain("<earlier>\n[#1] 24.10.26 21:00 Fan: hey im Dave\n</earlier>");
    expect(text).toContain("<transcript>\n[#2] 24.10.26 21:01 Model: hi Dave [media, PPV $25]\n</transcript>");
    expect(buildFanFactsUserText(messages, [], now)).not.toContain("<earlier>");
  });

  it("reads nothing into an answer that is not one", () => {
    expect(parseFanFactsAnswer("oops", { messages, facts, now })).toEqual({ add: [], close: [], dropped: 0 });
  });

  it("numbers a line with its Moscow date and time, its sender and its marks, a fan's media with its notes", () => {
    expect(fanFactLine(messages[1]!, 2)).toBe("[#2] 24.10.26 21:01 Model: hi Dave [media, PPV $25]");
    expect(fanFactLine(messages[2]!, 3)).toBe("[#3] 24.10.26 21:02 Fan: work at 6 tmrw [tip $5]");
    const photo = { ...messages[0]!, text: "my boy", withMedia: true, mediaNotes: ["A golden retriever on a couch."] };
    expect(fanFactLine(photo, 4)).toBe("[#4] 24.10.26 21:00 Fan: my boy [media: A golden retriever on a couch.]");
    expect(fanFactLine({ ...photo, fromFan: false }, 5)).toBe("[#5] 24.10.26 21:00 Model: my boy [media]");
  });
});
