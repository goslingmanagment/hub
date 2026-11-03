import { describe, expect, it } from "vitest";

import { joinShifts, openSpansOf, shiftOfSale, streaksOf } from "../apps/runtime/src/services/chatter-stats.ts";

// Whose a sale is in the cabinet's statistics: a shift's money is the sales
// that came while it went on, on a page the chatter had open in the extension
// at that moment — not every sale of a page touched once in the shift.

const T0 = Date.UTC(2026, 10, 2, 18, 0);
const at = (minute: number, seconds = 0) => T0 + minute * 60_000 + seconds * 1000;
const open = (pageId: number, minutes: readonly number[]) => minutes.map((minute) => ({ pageId, at: at(minute) }));
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index);

describe("openSpansOf", () => {
  it("joins open minutes up to three minutes apart and pads the ends", () => {
    // A beat skipped at minute 5 (61 s between beats) and one 3 minutes later still is one stretch.
    const spans = openSpansOf(open(1, [0, 1, 2, 3, 4, 6, 7, 10]));
    expect(spans.get(1)).toEqual([{ from: at(-1), to: at(12) }]);
  });

  it("splits a page closed for longer than the extension's lost time", () => {
    const spans = openSpansOf([...open(1, range(0, 10)), ...open(1, range(30, 40)), ...open(2, [5])]);
    expect(spans.get(1)).toEqual([{ from: at(-1), to: at(11) }, { from: at(29), to: at(41) }]);
    expect(spans.get(2)).toEqual([{ from: at(4), to: at(7) }]);
  });
});

describe("shiftOfSale", () => {
  const shifts = [{ startedAt: at(0), endedAt: at(480) }, { startedAt: at(600), endedAt: at(700) }];
  // Page 1 open the whole first shift; page 2 only for its first 20 minutes.
  const spans = openSpansOf([...open(1, range(0, 480)), ...open(2, range(0, 20)), ...open(1, range(600, 700))]);

  it("is the shift's when its page was open at that moment", () => {
    expect(shiftOfSale({ pageId: 1, at: at(120, 30) }, shifts, spans)).toBe(0);
    expect(shiftOfSale({ pageId: 2, at: at(10) }, shifts, spans)).toBe(0);
    expect(shiftOfSale({ pageId: 1, at: at(650) }, shifts, spans)).toBe(1);
  });

  it("is nobody's on a page closed by then, even inside the shift", () => {
    expect(shiftOfSale({ pageId: 2, at: at(300) }, shifts, spans)).toBeNull();
  });

  it("is nobody's outside every shift, even with the page open", () => {
    const always = openSpansOf(open(1, range(0, 800)));
    expect(shiftOfSale({ pageId: 1, at: at(500) }, shifts, always)).toBeNull();
    expect(shiftOfSale({ pageId: 1, at: at(-5) }, shifts, always)).toBeNull();
  });

  it("is nobody's on a page never open", () => {
    expect(shiftOfSale({ pageId: 9, at: at(100) }, shifts, spans)).toBeNull();
  });
});

describe("streaksOf", () => {
  const days = new Set(["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);

  it("counts the days in a row up to today", () => {
    expect(streaksOf(days, "2026-11-02")).toEqual({ current: 4, longest: 4 });
  });

  it("keeps the run while today has no shift yet", () => {
    expect(streaksOf(days, "2026-11-03")).toEqual({ current: 4, longest: 4 });
  });

  it("is broken by a whole day without a shift", () => {
    expect(streaksOf(days, "2026-11-04")).toEqual({ current: 0, longest: 4 });
    expect(streaksOf(new Set(), "2026-11-04")).toEqual({ current: 0, longest: 0 });
  });
});

describe("joinShifts", () => {
  const shift = (from: number, to: number, worked: number, pages: Array<[string, number]> = [["ari-1", worked]]) => ({
    startedAt: at(from), endedAt: at(to), ongoing: false, workedMinutes: worked, pauses: [], pages: new Map(pages),
  });

  it("makes one shift of pieces less than an hour apart, the gap a pause", () => {
    // 15:11–16:07, 16:43–17:36, 17:42–23:29: the browser restarted twice in one evening.
    const [evening, ...rest] = joinShifts([shift(371, 427, 54), shift(342, 347, 5, [["lora-1", 5]]), shift(463, 516, 50), shift(522, 869, 340)]);
    expect(rest).toEqual([]);
    expect(evening).toMatchObject({ startedAt: at(342), endedAt: at(869), workedMinutes: 449, parts: [1, 0, 2, 3] });
    expect(evening!.pauses).toEqual([
      { from: at(347), to: at(371) },
      { from: at(427), to: at(463) },
      { from: at(516), to: at(522) },
    ]);
    expect([...evening!.pages]).toEqual([["lora-1", 5], ["ari-1", 444]]);
  });

  it("keeps shifts an hour or more apart separate, and the last one's ongoing", () => {
    const joined = joinShifts([shift(0, 100, 90), { ...shift(160, 200, 40), ongoing: true }]);
    expect(joined.map((one) => [one.startedAt, one.endedAt, one.ongoing])).toEqual([[at(0), at(100), false], [at(160), at(200), true]]);
  });
});
