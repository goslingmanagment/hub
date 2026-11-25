import { describe, expect, it } from "vitest";

import { SHIFT_PAUSE_POLICY, classifyShiftBreaks, shiftSendBreaksOf } from "@agency_hub_core/contracts";

const T0 = Date.parse("2026-11-26T18:00:00+03:00");
const MIN = 60_000;
const m = (minute: number) => T0 + minute * MIN;

/** Every minute in [from, to) has a send. */
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => m(from + index));

describe("shiftSendBreaksOf", () => {
  it("counts >= 10 full empty minutes without sends as a break, and ignores 9 full empty minutes", () => {
    // 0..10 send, 11..19 empty (9m), 20..30 send, 31..40 empty (10m), 41..60 send.
    const sends = [...range(0, 11), ...range(20, 31), ...range(41, 60)];
    expect(shiftSendBreaksOf({ sendMinutes: sends, shiftStart: m(0), shiftEnd: m(60) })).toEqual([
      { from: m(31), to: m(41), minutes: 10 },
    ]);
  });

  it("does not flag a normal closed shift's 10-minute end-of-shift idle tail (9 full empty minutes after last send)", () => {
    // Last send in minute 49 (49:00..49:59), closed shift ends at 59:00 (lastInput + 10 min) -> 50..58 = 9 empty minutes.
    const sends = range(0, 50);
    expect(shiftSendBreaksOf({ sendMinutes: sends, shiftStart: m(0), shiftEnd: m(59) })).toEqual([]);
    // 10 full empty minutes after last send (50..59, shiftEnd = 60) -> flagged.
    expect(shiftSendBreaksOf({ sendMinutes: sends, shiftStart: m(0), shiftEnd: m(60) })).toEqual([
      { from: m(50), to: m(60), minutes: 10 },
    ]);
  });

  it("excludes pre-slot look-in gaps when slotStart is after shiftStart", () => {
    // Look-in at -45..-40, gap -39..-1 (39m before slotStart = 0), then continuous sends 0..120.
    const sends = [...range(-45, -40), ...range(0, 120)];
    expect(shiftSendBreaksOf({ sendMinutes: sends, shiftStart: m(-45), shiftEnd: m(120), slotStart: m(0) })).toEqual([]);
    // Without slotStart, that 39m gap is seen.
    expect(shiftSendBreaksOf({ sendMinutes: sends, shiftStart: m(-45), shiftEnd: m(120) })).toEqual([
      { from: m(-40), to: m(0), minutes: 40 },
    ]);
  });
});

describe("classifyShiftBreaks (10 / 60 / 3 policy)", () => {
  it("returns zeroes when there are no breaks", () => {
    expect(classifyShiftBreaks([], { ongoing: false })).toEqual({
      breaks: [],
      restMinutes: 0,
      restOverrunMinutes: 0,
      awayCount: 0,
      awayExcessCount: 0,
      awayMinutes: 0,
      preliminary: false,
    });
  });

  it("flags rest overruns past 60 min without counting them as an extra away", () => {
    const result = classifyShiftBreaks([{ from: m(60), to: m(135), minutes: 75 }], { ongoing: false });
    expect(result).toEqual({
      breaks: [{ from: m(60), to: m(135), minutes: 75, kind: "rest", overrunMinutes: 15, awayIndex: null }],
      restMinutes: 75,
      restOverrunMinutes: 15,
      awayCount: 0,
      awayExcessCount: 0,
      awayMinutes: 0,
      preliminary: false,
    });
  });

  it("picks the single longest break as rest, marks #1..#3 chronologically as away, and #4+ as away_excess", () => {
    const raw = [
      { from: m(20), to: m(35), minutes: 15 },
      { from: m(100), to: m(155), minutes: 55 },
      { from: m(200), to: m(212), minutes: 12 },
      { from: m(260), to: m(274), minutes: 14 },
      { from: m(320), to: m(340), minutes: 20 },
    ];
    const result = classifyShiftBreaks(raw, { ongoing: true });
    expect(SHIFT_PAUSE_POLICY).toEqual({ minAwayMinutes: 10, restMaxMinutes: 60, maxAwayCount: 3 });
    expect(result).toMatchObject({
      restMinutes: 55,
      restOverrunMinutes: 0,
      awayCount: 4,
      awayExcessCount: 1,
      awayMinutes: 15 + 12 + 14 + 20,
      preliminary: true,
    });
    expect(result.breaks.map((one) => [one.kind, one.awayIndex, one.overrunMinutes])).toEqual([
      ["away", 1, 0],
      ["rest", null, 0],
      ["away", 2, 0],
      ["away", 3, 0],
      ["away_excess", 4, 0],
    ]);
  });
});
