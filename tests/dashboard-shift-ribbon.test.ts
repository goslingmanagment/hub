import { describe, expect, it } from "vitest";

import { ribbonClock, ribbonDays, type Stats } from "../apps/dashboard/src/pages/account/stats/statsView.ts";

// The shift ribbon draws each shift where it was: the rows start where the
// chatter's shifts leave the clock free, so an evening over midnight is one bar
// in the row of its day, not two halves in two rows (the first cabinet's bug).

const msk = (day: string, time: string) => new Date(`${day}T${time}:00+03:00`).toISOString();
const shift = (date: string, from: string, to: string, sales: Array<{ at: string; netMills: number }> = []) => ({
  date, startedAt: from, endedAt: to, ongoing: false, workedMinutes: 0, pauses: [], pages: ["ari-1"], salesNetMills: sales.reduce((sum, sale) => sum + sale.netMills, 0),
  overlapNetMills: 0, together: [], messages: 0, ppvSent: 0, fansWritten: 0, fansPaid: 0, confirmedNetMills: null,
  sales: sales.map((sale) => ({ ...sale, kind: "tip" as const, pageLabel: "ari-1", fanName: null, overlap: false })),
});
const daily = (...dates: string[]) => dates.map((date) => ({ date, salesNetMills: 0, byKind: { ppv: 0, tip: 0, subscription: 0, post: 0 }, shifts: 0, workedMinutes: 0 }));
const stats = (shifts: Stats["shifts"], days: string[]): Pick<Stats, "daily" | "shifts" | "visits" | "activitySince"> => ({
  daily: daily(...days), shifts, visits: [], activitySince: msk(days[0]!, "00:00"),
});

describe("the shift ribbon", () => {
  const evenings = [
    shift("2026-11-02", msk("2026-11-02", "18:11"), msk("2026-11-03", "03:08"), [{ at: msk("2026-11-03", "01:30"), netMills: 40_000 }]),
    shift("2026-11-01", msk("2026-11-01", "18:08"), msk("2026-11-02", "02:44")),
  ];

  const night = shift("2026-10-28", msk("2026-10-27", "23:54"), msk("2026-10-28", "08:21"));

  it("starts the rows in the middle of the hours no shift touches, on a mark of the hours", () => {
    expect(ribbonClock(evenings).startHour).toBe(12);
    expect(ribbonClock([night]).startHour).toBe(15);
    expect(ribbonClock([])).toEqual({ startHour: 0, labelAt: 720 });
  });

  it("draws an evening over midnight as one bar in the row of its day, its sale after midnight on it", () => {
    const rows = ribbonDays(stats(evenings, ["2026-11-01", "2026-11-02"]), ribbonClock(evenings));
    expect(rows.map((row) => row.day)).toEqual(["2026-11-02", "2026-11-01"]);
    const [second, first] = rows;
    expect(second!.pieces).toEqual([expect.objectContaining({ shift: 0, from: 6 * 60 + 11, to: 15 * 60 + 8 })]);
    expect(second!.sales.map((sale) => sale.minute)).toEqual([13 * 60 + 30]);
    expect(second).toMatchObject({ hasShift: true, totalMills: 40_000 });
    expect(first!.pieces).toEqual([expect.objectContaining({ shift: 1, from: 6 * 60 + 8, to: 14 * 60 + 44 })]);
  });

  it("draws a night entered before midnight in the row of the morning it runs into", () => {
    const rows = ribbonDays(stats([night], ["2026-10-27", "2026-10-28"]), ribbonClock([night]));
    expect(rows.find((row) => row.day === "2026-10-28")!.pieces).toEqual([expect.objectContaining({ from: 8 * 60 + 54, to: 17 * 60 + 21 })]);
    expect(rows.find((row) => row.day === "2026-10-27")!.pieces).toEqual([]);
  });

  it("goes on in the next row when a shift runs past the row's end", () => {
    const long = shift("2026-11-02", msk("2026-11-02", "06:00"), msk("2026-11-02", "11:00"));
    const rows = ribbonDays(stats([long], ["2026-11-01", "2026-11-02"]), { startHour: 9, labelAt: 720 });
    expect(rows.find((row) => row.day === "2026-11-01")!.pieces).toEqual([expect.objectContaining({ from: 21 * 60, to: 24 * 60 })]);
    expect(rows.find((row) => row.day === "2026-11-02")!.pieces).toEqual([expect.objectContaining({ from: 0, to: 2 * 60 })]);
  });

  it("gives a night going on now, begun before midnight, the row of the morning it runs into", () => {
    const going = { ...shift("2026-11-03", msk("2026-11-03", "23:53"), msk("2026-11-03", "23:58")), ongoing: true };
    const rows = ribbonDays(stats([going], ["2026-11-02", "2026-11-03"]), ribbonClock([night]));
    expect(rows[0]).toMatchObject({ day: "2026-11-04", hasShift: true });
    expect(rows[0]!.pieces).toEqual([expect.objectContaining({ from: 8 * 60 + 53, live: true })]);
  });
});
