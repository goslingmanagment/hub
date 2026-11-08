import { describe, expect, it } from "vitest";

import {
  dayOfWork,
  workHoldsSale,
  workOfMinutes,
  workOnPages,
  type ActivityMinute,
  type ComputedWork,
  type SentMinute,
} from "../apps/runtime/src/services/chatter-shifts.ts";

// The one definition of a shift (services/chatter-shifts.ts). The cases are the
// real ones of the first ten days of data: a browser restart, a look-in at noon,
// a tail of answers after a night shift, a tab of someone else's page.

const T0 = Date.UTC(2026, 9, 26, 15, 0); // 18:00 in Moscow
const at = (minute: number) => T0 + minute * 60_000;
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index);

/** Open minutes [from, to) on a page; `active` lists the minutes with activity. */
function minutes(from: number, to: number, active: readonly number[], pageLabel = "ari-1"): ActivityMinute[] {
  const out: ActivityMinute[] = [];
  for (let minute = from; minute < to; minute += 1) out.push({ at: at(minute), pageLabel, input: active.includes(minute) });
  return out;
}
/** `count` messages spread over [from, to). */
function sends(from: number, to: number, count: number, pageLabel = "ari-1"): SentMinute[] {
  return Array.from({ length: count }, (_, index) => ({ at: at(from + Math.floor((index * (to - from)) / count)), pageLabel, messages: 1 }));
}
const FAR_LATER = at(10 * 24 * 60);
const bounds = (work: readonly ComputedWork[]) => work.map((one) => [one.kind, one.startedAt, one.endedAt]);
const totalMessages = (work: ComputedWork) => [...work.messages.values()].reduce((sum, count) => sum + count, 0);

describe("workOfMinutes", () => {
  it("is a shift from two hours of work and fifty messages, and nothing before the first activity counts", () => {
    const [shift, ...rest] = workOfMinutes(minutes(0, 245, range(5, 245)), sends(5, 245, 60), FAR_LATER);
    expect(rest).toEqual([]);
    expect(shift).toMatchObject({ kind: "shift", startedAt: at(5), endedAt: at(245), ongoing: false, workedMinutes: 240, pauses: [] });
    expect(totalMessages(shift!)).toBe(60);
  });

  it("is a visit with under two hours of work, however many messages", () => {
    const work = workOfMinutes(minutes(0, 71, range(0, 71)), sends(0, 71, 38), FAR_LATER);
    expect(bounds(work)).toEqual([["visit", at(0), at(71)]]);
  });

  it("is a visit with under fifty messages, however long the extension was in use", () => {
    const work = workOfMinutes(minutes(0, 400, range(0, 400)), sends(0, 400, 34), FAR_LATER);
    expect(bounds(work)).toEqual([["visit", at(0), at(400)]]);
  });

  it("pauses from the 10th idle minute to the next activity; the first idle minutes are work", () => {
    const active = [...range(0, 100), ...range(125, 300)];
    const [shift] = workOfMinutes(minutes(0, 300, active), sends(0, 300, 100), FAR_LATER);
    expect(shift).toMatchObject({ kind: "shift", startedAt: at(0), endedAt: at(300), workedMinutes: 284, pauses: [{ from: at(109), to: at(125) }] });
  });

  it("goes on through a browser restart: the extension closing ends nothing, the gap is a pause", () => {
    const work = workOfMinutes(
      [...minutes(0, 200, range(0, 200)), ...minutes(235, 400, range(235, 400))],
      [...sends(0, 200, 60), ...sends(235, 400, 60)],
      FAR_LATER,
    );
    expect(bounds(work)).toEqual([["shift", at(0), at(400)]]);
    expect(work[0]!.pauses).toEqual([{ from: at(209), to: at(235) }]);
  });

  it("ends after 60 minutes with no activity, the extension open or not, at the last activity plus the idle that counts", () => {
    const work = workOfMinutes(minutes(0, 600, [...range(0, 200), ...range(260, 500)]), [...sends(0, 200, 60), ...sends(260, 500, 60)], FAR_LATER);
    expect(bounds(work)).toEqual([
      ["shift", at(0), at(209)],
      ["shift", at(260), at(509)],
    ]);
  });

  it("leaves a look-in the next morning out of the shift, and an earlier one 66 minutes before it", () => {
    const work = workOfMinutes(
      [...minutes(0, 8, range(0, 8)), ...minutes(74, 500, range(74, 500)), ...minutes(1000, 1030, range(1000, 1030))],
      [...sends(0, 8, 8), ...sends(74, 500, 800), ...sends(1000, 1030, 14)],
      FAR_LATER,
    );
    expect(bounds(work)).toEqual([
      ["visit", at(0), at(8)],
      ["shift", at(74), at(500)],
      ["visit", at(1000), at(1030)],
    ]);
  });

  it("ends a shift at its last piece of real work: the sparse answers after it are a visit", () => {
    // A night's work, then four hours of one or two messages at a time, each less than an hour apart.
    const active = [...range(0, 480), ...range(527, 537), ...range(557, 558), ...range(581, 583), ...range(593, 594), ...range(640, 641)];
    const sent = [...sends(0, 480, 300), ...sends(527, 537, 2), ...sends(557, 558, 1), ...sends(581, 583, 2), ...sends(593, 594, 1), ...sends(640, 641, 1)];
    const work = workOfMinutes(minutes(0, 650, active), sent, FAR_LATER);
    expect(bounds(work)).toEqual([
      ["shift", at(0), at(489)],
      ["visit", at(527), at(650)],
    ]);
    expect(totalMessages(work[0]!)).toBe(300);
    expect(totalMessages(work[1]!)).toBe(7);
  });

  it("keeps a last piece with five messages in the shift", () => {
    const work = workOfMinutes(minutes(0, 330, [...range(0, 300), ...range(320, 330)]), [...sends(0, 300, 100), ...sends(320, 330, 5)], FAR_LATER);
    expect(bounds(work)).toEqual([["shift", at(0), at(330)]]);
  });

  it("joins the pages of one person into one shift and keeps each page's active minutes and messages", () => {
    const work = workOfMinutes(
      [...minutes(0, 150, range(0, 60), "ari-1"), ...minutes(0, 150, range(60, 150), "lora-1")],
      [...sends(0, 60, 40, "ari-1"), ...sends(60, 150, 20, "lora-1")],
      FAR_LATER,
    );
    expect(work).toHaveLength(1);
    expect(work[0]!.workedMinutes).toBe(150);
    expect(Object.fromEntries(work[0]!.pages)).toEqual({ "ari-1": 60, "lora-1": 90 });
    expect(Object.fromEntries(work[0]!.messages)).toEqual({ "ari-1": 40, "lora-1": 20 });
  });

  it("counts work going on now as a shift once it has five messages, short as it is", () => {
    const [shift] = workOfMinutes(minutes(0, 30, [0, 27]), sends(0, 5, 5), at(30));
    expect(shift).toMatchObject({ kind: "shift", ongoing: true, endedAt: at(30), workedMinutes: 13, pauses: [{ from: at(10), to: at(27) }] });
  });

  it("keeps a shift going through a break with the extension closed: the same shift, its pages, the break so far a pause", () => {
    // Three hours of work, the extension closed after the minute at 180; 35 minutes later the person is on a break.
    const work = workOfMinutes(minutes(0, 181, range(0, 180)), sends(0, 180, 120), at(215));
    expect(bounds(work)).toEqual([["shift", at(0), at(215)]]);
    expect(work[0]).toMatchObject({ ongoing: true, workedMinutes: 189, lastInputAt: at(179), lastBeatAt: at(180), pauses: [{ from: at(189), to: at(215) }] });
    expect(work[0]!.salesSince.get("ari-1")).toBe(at(0));
    // Back before the hour is out: one shift, the break a pause between.
    const back = workOfMinutes([...minutes(0, 181, range(0, 180)), ...minutes(230, 260, range(230, 260))], [...sends(0, 180, 120), ...sends(230, 260, 20)], at(260));
    expect(bounds(back)).toEqual([["shift", at(0), at(260)]]);
    expect(back[0]!.pauses).toEqual([{ from: at(189), to: at(230) }]);
  });

  it("ends a shift whose extension closed an hour after its last action, at that action plus the idle that counts", () => {
    expect(bounds(workOfMinutes(minutes(0, 181, range(0, 180)), sends(0, 180, 120), at(238)))).toEqual([["shift", at(0), at(238)]]);
    const [shift] = workOfMinutes(minutes(0, 181, range(0, 180)), sends(0, 180, 120), at(239));
    expect(shift).toMatchObject({ kind: "shift", ongoing: false, endedAt: at(181), pauses: [] });
  });

  it("does not take a glance at the extension going on now for a shift", () => {
    expect(workOfMinutes(minutes(0, 10, range(0, 10)), sends(2, 3, 1), at(10))).toMatchObject([{ kind: "visit", ongoing: true }]);
  });

  it("leaves a look-in half an hour before the shift out of it", () => {
    // Two minutes and two answers at 17:20, the shift from 18:05.
    const work = workOfMinutes(
      [...minutes(0, 2, range(0, 2)), ...minutes(45, 400, range(45, 400))],
      [...sends(0, 2, 2), ...sends(45, 400, 200)],
      FAR_LATER,
    );
    expect(bounds(work)).toEqual([
      ["visit", at(0), at(2)],
      ["shift", at(45), at(400)],
    ]);
  });

  it("keeps the shift going while answers still come now, and cuts their tail only once it is over", () => {
    const active = [...range(0, 300), ...range(340, 341)];
    const sent = [...sends(0, 300, 200), ...sends(340, 341, 1)];
    expect(bounds(workOfMinutes(minutes(0, 345, active), sent, at(345)))).toEqual([["shift", at(0), at(345)]]);
    expect(bounds(workOfMinutes(minutes(0, 345, active), sent, FAR_LATER))).toEqual([
      ["shift", at(0), at(309)],
      ["visit", at(340), at(345)],
    ]);
  });

  it("has no work for an extension that was only open", () => {
    expect(workOfMinutes(minutes(0, 90, []), [], FAR_LATER)).toEqual([]);
  });
});

describe("the sales of a shift", () => {
  const shift = workOfMinutes(
    [
      ...minutes(0, 480, range(0, 480), "lora-vip-of"),
      ...minutes(140, 480, range(140, 300), "lora-1"),
      ...minutes(200, 210, range(200, 203), "ari-1"),
    ],
    [...sends(0, 480, 300, "lora-vip-of"), ...sends(140, 300, 20, "lora-1"), ...sends(200, 203, 3, "ari-1")],
    FAR_LATER,
  )[0]!;

  it("holds those on the pages it worked, from the first action there to its end", () => {
    expect(workHoldsSale(shift, { pageLabel: "lora-vip-of", at: at(0) })).toBe(true);
    expect(workHoldsSale(shift, { pageLabel: "lora-1", at: at(150) })).toBe(true);
    // Hours after the last message on it, still in the shift: a fan pays for what was sent earlier.
    expect(workHoldsSale(shift, { pageLabel: "lora-1", at: at(470) })).toBe(true);
  });

  it("does not hold a page's sales before the person took it over: they are the colleague's", () => {
    expect(workHoldsSale(shift, { pageLabel: "lora-1", at: at(100) })).toBe(false);
  });

  it("does not hold the sales of a page with only a look at it", () => {
    expect(workHoldsSale(shift, { pageLabel: "ari-1", at: at(201) })).toBe(false);
  });

  it("does not hold a sale after its end", () => {
    expect(workHoldsSale(shift, { pageLabel: "lora-vip-of", at: at(481) })).toBe(false);
  });

  it("in a visit, holds the pages it wrote on, with any message", () => {
    const [visit] = workOfMinutes(minutes(0, 30, range(0, 30)), sends(10, 11, 1), FAR_LATER);
    expect(visit!.kind).toBe("visit");
    expect(workHoldsSale(visit!, { pageLabel: "ari-1", at: at(20) })).toBe(true);
  });
});

describe("a shift as a view of some pages sees it", () => {
  const [shift] = workOfMinutes(
    [...minutes(0, 300, range(0, 300), "lora-1"), ...minutes(100, 110, range(100, 104), "ari-1")],
    [...sends(0, 300, 100, "lora-1"), ...sends(100, 104, 3, "ari-1")],
    FAR_LATER,
  );

  it("stays the whole shift on a page it worked", () => {
    expect(workOnPages(shift!, new Set(["lora-1"]))).toMatchObject({ kind: "shift", startedAt: at(0), endedAt: at(300), workedMinutes: 300 });
  });

  it("is a look-in on a page it only touched, with no sales there", () => {
    const seen = workOnPages(shift!, new Set(["ari-1"]))!;
    expect(seen.kind).toBe("visit");
    expect(workHoldsSale(seen, { pageLabel: "ari-1", at: at(120) })).toBe(false);
  });

  it("is nothing on a page it never touched", () => {
    expect(workOnPages(shift!, new Set(["lora-2"]))).toBeNull();
  });
});

describe("dayOfWork", () => {
  const moscow = (day: string, time: string) => Date.parse(`${day}T${time}:00+03:00`);
  const day = (from: number, to: number) => dayOfWork({ startedAt: from, endedAt: to });

  it("puts an evening over midnight on the day it began", () => {
    expect(day(moscow("2026-11-01", "18:08"), moscow("2026-11-02", "02:44"))).toBe("2026-11-01");
  });

  it("puts one night on one day, entered at 23:54 or at 00:08", () => {
    expect(day(moscow("2026-10-27", "23:54"), moscow("2026-10-28", "08:21"))).toBe("2026-10-28");
    expect(day(moscow("2026-10-28", "00:08"), moscow("2026-10-28", "08:19"))).toBe("2026-10-28");
  });

  it("gives a tie to the day it began", () => {
    expect(day(moscow("2026-10-27", "20:00"), moscow("2026-10-28", "04:00"))).toBe("2026-10-27");
  });
});
