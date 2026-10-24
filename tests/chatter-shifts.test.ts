import { describe, expect, it } from "vitest";

import { shiftsOfMinutes, type ActivityMinute } from "../apps/runtime/src/services/chatter-shifts.ts";

// The actual shift from the extension's minutes (Chat Memory week 1, plan §2):
// in at the first active minute, a pause from the 10th idle minute, out when
// the minutes stop (the extension closed or went silent 3 minutes) or after
// 60 idle minutes.

const T0 = Date.UTC(2026, 9, 26, 18, 0);
const at = (minute: number) => T0 + minute * 60_000;

/** Open minutes [from, to) on a page; `active` lists the minutes with activity. */
function minutes(from: number, to: number, active: readonly number[], pageLabel = "ari-1"): ActivityMinute[] {
  const out: ActivityMinute[] = [];
  for (let minute = from; minute < to; minute += 1) out.push({ at: at(minute), pageLabel, input: active.includes(minute) });
  return out;
}
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index);
const FAR_LATER = at(24 * 60);

describe("shiftsOfMinutes", () => {
  it("counts every minute of steady work and nothing before the first activity", () => {
    const [shift, ...rest] = shiftsOfMinutes(minutes(0, 40, range(5, 35)), FAR_LATER);
    expect(rest).toEqual([]);
    expect(shift).toMatchObject({ startedAt: at(5), endedAt: at(40), ongoing: false, workedMinutes: 35, pauses: [] });
    expect([...shift!.pages]).toEqual([["ari-1", 30]]);
  });

  it("pauses from the 10th idle minute to the next activity; the first idle minutes are work", () => {
    const [shift] = shiftsOfMinutes(minutes(0, 30, [0, ...range(25, 30)]), FAR_LATER);
    expect(shift).toMatchObject({ startedAt: at(0), endedAt: at(30), workedMinutes: 15, pauses: [{ from: at(10), to: at(25) }] });
  });

  it("ends when the extension goes silent and starts again with the next activity", () => {
    const shifts = shiftsOfMinutes([...minutes(0, 20, range(0, 20)), ...minutes(30, 40, range(32, 40))], FAR_LATER);
    expect(shifts.map((shift) => [shift.startedAt, shift.endedAt, shift.workedMinutes])).toEqual([
      [at(0), at(20), 20],
      [at(32), at(40), 8],
    ]);
  });

  it("ends after 60 idle minutes even with the extension open, at the last activity plus the idle that counts", () => {
    const shifts = shiftsOfMinutes(minutes(0, 120, [0, 1, 2, 100]), FAR_LATER);
    expect(shifts.map((shift) => [shift.startedAt, shift.endedAt, shift.workedMinutes])).toEqual([
      [at(0), at(12), 12],
      [at(100), at(110), 10],
    ]);
  });

  it("joins the pages of one person into one shift and keeps each page's active minutes", () => {
    const [shift, ...rest] = shiftsOfMinutes([
      ...minutes(0, 30, range(0, 10), "ari-1"),
      ...minutes(0, 30, range(10, 30), "lora-1"),
    ], FAR_LATER);
    expect(rest).toEqual([]);
    expect(shift!.workedMinutes).toBe(30);
    expect(Object.fromEntries(shift!.pages)).toEqual({ "ari-1": 10, "lora-1": 20 });
  });

  it("keeps the last shift going while the extension still beats", () => {
    const [shift] = shiftsOfMinutes(minutes(0, 30, [0, 27]), at(30));
    expect(shift).toMatchObject({ ongoing: true, endedAt: at(30), workedMinutes: 13, pauses: [{ from: at(10), to: at(27) }] });
  });

  it("has no shift for an extension that was only open", () => {
    expect(shiftsOfMinutes(minutes(0, 90, []), FAR_LATER)).toEqual([]);
  });
});
