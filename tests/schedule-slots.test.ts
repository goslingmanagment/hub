import { describe, expect, it } from "vitest";

import type { RuleSlot } from "../apps/runtime/src/services/sale-rule.ts";
import { scheduleSpansOf, slotOccurrencesOf } from "../apps/runtime/src/services/schedule-slots.ts";

// Where a person's schedule lines run (services/schedule-slots.ts): the one expansion of the registry's lines over
// days that the report's window and the cut of a shift both read. Moscow time; 2026-11-16 is a Monday.

const ME = 7;
const msk = (day: string, time: string) => Date.parse(`${day}T${time}:00+03:00`);
const line = (extra: Partial<RuleSlot> = {}): RuleSlot => ({
  personId: ME, pageId: null, startMinute: 8 * 60, endMinute: 16 * 60, weekdays: null, validFrom: null, validTo: null, ...extra,
});
const runs = (slots: readonly RuleSlot[], from: number, to: number, pagesOfAll?: readonly number[]) =>
  slotOccurrencesOf(slots, { userIds: new Set([ME]), from, to, pagesOfAll }).map((run) => [run.start, run.end, run.pageId]);

describe("slotOccurrencesOf", () => {
  it("runs a line on its weekdays only, and nobody else's", () => {
    const slots = [line({ weekdays: ["mon", "wed"] }), { ...line(), personId: 9 }];
    expect(runs(slots, msk("2026-11-16", "00:00"), msk("2026-11-19", "00:00"))).toEqual([
      [msk("2026-11-16", "08:00"), msk("2026-11-16", "16:00"), null],
      [msk("2026-11-18", "08:00"), msk("2026-11-18", "16:00"), null],
    ]);
  });

  it("runs a line within its validity, by the day it begins", () => {
    const slots = [line({ validFrom: "2026-11-17", validTo: "2026-11-18" })];
    expect(runs(slots, msk("2026-11-16", "00:00"), msk("2026-11-20", "00:00"))).toEqual([
      [msk("2026-11-17", "08:00"), msk("2026-11-17", "16:00"), null],
      [msk("2026-11-18", "08:00"), msk("2026-11-18", "16:00"), null],
    ]);
  });

  it("runs a slot over midnight from its day's evening to the next morning, and finds the one begun the day before", () => {
    const slots = [line({ startMinute: 18 * 60, endMinute: 2 * 60, validFrom: "2026-11-16", validTo: "2026-11-16" })];
    expect(runs(slots, msk("2026-11-17", "01:00"), msk("2026-11-17", "01:30"))).toEqual([[msk("2026-11-16", "18:00"), msk("2026-11-17", "02:00"), null]]);
    // Its end is the end: nothing of it after 02:00, nor a run of the day it is not valid on.
    expect(runs(slots, msk("2026-11-17", "02:00"), msk("2026-11-17", "23:00"))).toEqual([]);
    // One ending at 24:00 runs to midnight.
    expect(runs([line({ startMinute: 18 * 60, endMinute: 24 * 60 })], msk("2026-11-16", "12:00"), msk("2026-11-16", "23:00")))
      .toEqual([[msk("2026-11-16", "18:00"), msk("2026-11-17", "00:00"), null]]);
  });

  it("lets a page-specific standing line override an every-page line on that page, matching standingLinesOn", () => {
    const slots = [line(), line({ pageId: 12, startMinute: 16 * 60, endMinute: 20 * 60 })];
    const day = [msk("2026-11-16", "00:00"), msk("2026-11-16", "23:00")] as const;
    expect(runs(slots, ...day)).toEqual([
      [msk("2026-11-16", "08:00"), msk("2026-11-16", "16:00"), null],
      [msk("2026-11-16", "16:00"), msk("2026-11-16", "20:00"), 12],
    ]);
    // With working pages [11, 12]: page 11 uses the every-page line (08-16), while page 12 uses ONLY its own line (16-20).
    expect(runs(slots, ...day, [11, 12])).toEqual([
      [msk("2026-11-16", "08:00"), msk("2026-11-16", "16:00"), 11],
      [msk("2026-11-16", "16:00"), msk("2026-11-16", "20:00"), 12],
    ]);
    // Overnight split (e.g. every-page 18:00-02:00 + page 12 override 18:00-00:00): page 12 ends at 00:00, page 11 at 02:00.
    const overnight = [
      line({ startMinute: 18 * 60, endMinute: 2 * 60 }),
      line({ pageId: 12, startMinute: 18 * 60, endMinute: 24 * 60 }),
    ];
    expect(runs(overnight, msk("2026-11-16", "18:00"), msk("2026-11-17", "03:00"), [11, 12])).toEqual([
      [msk("2026-11-16", "18:00"), msk("2026-11-17", "02:00"), 11],
      [msk("2026-11-16", "18:00"), msk("2026-11-17", "00:00"), 12],
    ]);
    // Page-specific weekday override: chosen by date alone before weekdays, so Tuesday does not fall back to the every-page line.
    const mondayOnly = [line(), line({ pageId: 12, weekdays: ["mon"], startMinute: 16 * 60, endMinute: 20 * 60 })];
    expect(runs(mondayOnly, msk("2026-11-17", "00:00"), msk("2026-11-17", "23:00"), [11, 12])).toEqual([
      [msk("2026-11-17", "08:00"), msk("2026-11-17", "16:00"), 11],
    ]);
    // A page with its own line that is not a working page: once its line ends, the every-page line does not run there.
    const ended = [line(), line({ pageId: 99, startMinute: 16 * 60, endMinute: 20 * 60, validTo: "2026-11-10" })];
    expect(runs(ended, msk("2026-11-17", "00:00"), msk("2026-11-17", "23:00"), [11])).toEqual([
      [msk("2026-11-17", "08:00"), msk("2026-11-17", "16:00"), 11],
    ]);
  });

  it("takes a swap's «off» hours out of its page that day only, and runs a «cover» line of its own, whatever is off", () => {
    const off = line({ pageId: 11, startMinute: 11 * 60, endMinute: 14 * 60, validFrom: "2026-11-16", validTo: "2026-11-16", day: "off" });
    const cover = line({ pageId: 11, startMinute: 12 * 60, endMinute: 18 * 60, validFrom: "2026-11-16", validTo: "2026-11-16", day: "cover" });
    const week = [msk("2026-11-16", "00:00"), msk("2026-11-17", "23:00")] as const;
    expect(runs([line(), off, cover], ...week, [11, 12])).toEqual([
      [msk("2026-11-16", "08:00"), msk("2026-11-16", "11:00"), 11],
      [msk("2026-11-16", "14:00"), msk("2026-11-16", "16:00"), 11],
      [msk("2026-11-16", "08:00"), msk("2026-11-16", "16:00"), 12],
      [msk("2026-11-16", "12:00"), msk("2026-11-16", "18:00"), 11],
      [msk("2026-11-17", "08:00"), msk("2026-11-17", "16:00"), 11],
      [msk("2026-11-17", "08:00"), msk("2026-11-17", "16:00"), 12],
    ]);
    // Without the working pages a line of every page stays one: a page's «off» does not reach it.
    expect(runs([line(), off], msk("2026-11-16", "00:00"), msk("2026-11-16", "23:00"))).toEqual([[msk("2026-11-16", "08:00"), msk("2026-11-16", "16:00"), null]]);
  });
});

describe("scheduleSpansOf", () => {
  it("joins the runs that overlap or touch, in order, and keeps the others apart", () => {
    const at = (time: string) => msk("2026-11-16", time);
    expect(scheduleSpansOf([
      { start: at("16:00"), end: at("20:00") },
      { start: at("08:00"), end: at("11:00") },
      { start: at("14:00"), end: at("16:00") },
      { start: at("08:00"), end: at("10:00") },
    ])).toEqual([{ start: at("08:00"), end: at("11:00") }, { start: at("14:00"), end: at("20:00") }]);
    expect(scheduleSpansOf([])).toEqual([]);
  });
});
