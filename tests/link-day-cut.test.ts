import { describe, expect, it } from "vitest";

import { linkDayCut, linkDayDelta, linkRangeDaysEnd, type LinkSeries, type LinkSeriesPoint } from "../packages/db/src/repositories/link-stats-deltas.ts";

// A link's business day runs between its closing reads: the series is read at
// 00:45, 06:45, 12:45 and 18:45 Moscow, and the 00:45 read closes the day
// before (link-stats-deltas.ts, «business day»).

/** A Moscow wall time as the UTC instant. */
const msk = (text: string) => new Date(`${text.replace(" ", "T")}:00+03:00`);
const midnight = (day: string) => msk(`${day} 00:00`);

function point(at: string, subscribers: number, spenders: number | null = Math.floor(subscribers / 3)): LinkSeriesPoint {
  return {
    observedAt: msk(at), runId: 1, ofapiAccountId: "acct", runReason: null,
    clicks: subscribers * 2, claims: null, subscribers, spenders, netMills: BigInt(subscribers * 1000),
  };
}

function series(points: LinkSeriesPoint[]): LinkSeries {
  return { pageId: 1, linkKind: "tracking", linkRef: "1", linkCreatedAt: null, points };
}

function day(series: LinkSeries, date: string, clipTo: Date) {
  const start = midnight(date);
  return linkDayDelta(series, {
    previousStartAt: new Date(start.getTime() - 86_400_000),
    startAt: start,
    nextStartAt: new Date(start.getTime() + 86_400_000),
  }, { from: null, to: clipTo });
}

describe("a link's business day", () => {
  it("is closed by the 00:45 read: the evening's fans belong to the day they came", () => {
    const link = series([
      point("2026-11-16 00:45", 0),
      point("2026-11-16 12:45", 0),
      point("2026-11-16 18:45", 3),
      point("2026-11-17 00:45", 6),
      point("2026-11-17 12:45", 16),
      point("2026-11-17 18:45", 17),
      point("2026-11-18 00:45", 22),
    ]);
    const now = msk("2026-11-18 05:30");
    expect(linkDayCut(link.points, midnight("2026-11-17")).getTime()).toBe(msk("2026-11-17 00:45").getTime() + 1);
    expect(day(link, "2026-11-16", now)?.delta?.fans).toBe(6);
    expect(day(link, "2026-11-17", now)?.delta?.fans).toBe(16);
    // Today has no read of its own yet: no figure, not a zero.
    expect(day(link, "2026-11-18", now)?.delta).toBeNull();
  });

  it("counts a retry within four hours as the closing read, and the 06:45 read as the next day's", () => {
    const retried = series([point("2026-11-16 18:45", 3), point("2026-11-17 03:20", 5), point("2026-11-17 12:45", 9)]);
    expect(linkDayCut(retried.points, midnight("2026-11-17")).getTime()).toBe(msk("2026-11-17 03:20").getTime() + 1);
    const late = series([point("2026-11-16 18:45", 3), point("2026-11-17 06:45", 5), point("2026-11-17 18:45", 9)]);
    expect(linkDayCut(late.points, midnight("2026-11-17"))).toEqual(midnight("2026-11-17"));
    const now = msk("2026-11-18 01:00");
    // Without a closing read the boundary is midnight: 06:45 goes to the new day.
    expect(day(late, "2026-11-17", now)?.delta?.fans).toBe(6);
  });

  it("gives a day without reads no figures, and the first read after an outage none either", () => {
    const link = series([
      point("2026-10-31 18:45", 9),
      point("2026-11-01 18:45", 10),
      point("2026-11-02 00:45", 11),
      // 2–7 November: nothing read.
      point("2026-11-08 12:45", 30),
      point("2026-11-08 18:45", 31),
      point("2026-11-09 00:45", 33),
      point("2026-11-09 12:45", 35),
    ]);
    const now = msk("2026-11-09 15:00");
    expect(day(link, "2026-11-01", now)?.delta?.fans).toBe(2);
    expect(day(link, "2026-11-04", now)?.delta).toBeNull();
    expect(day(link, "2026-11-07", now)?.delta).toBeNull();
    // The 8th's first read carries the whole week: it is not the 8th's arrivals.
    expect(day(link, "2026-11-08", now)?.delta).toBeNull();
    expect(day(link, "2026-11-09", now)?.delta?.fans).toBe(2);
  });

  it("keeps a link's first day without a baseline flagged, and clips the stretch to a segment", () => {
    const link = series([point("2026-11-16 12:45", 40), point("2026-11-17 00:45", 42), point("2026-11-17 12:45", 45)]);
    const first = day(link, "2026-11-16", msk("2026-11-17 15:00"));
    expect(first?.delta?.fans).toBe(42);
    expect(first?.delta?.flags).toEqual(["no_baseline"]);
    const start = midnight("2026-11-17");
    const clipped = linkDayDelta(link, {
      previousStartAt: midnight("2026-11-16"), startAt: start, nextStartAt: midnight("2026-11-18"),
    }, { from: msk("2026-11-17 10:00"), to: msk("2026-11-17 15:00") });
    expect(clipped?.startAt).toEqual(msk("2026-11-17 10:00"));
    expect(clipped?.delta?.fans).toBe(3);
    // Nothing of the day inside the clip: no row at all.
    expect(linkDayDelta(link, {
      previousStartAt: midnight("2026-11-16"), startAt: start, nextStartAt: midnight("2026-11-18"),
    }, { from: null, to: msk("2026-11-17 00:00") })).toBeNull();
  });

  it("runs the last day of a range that ended in the past to its closing read, never past now", () => {
    const link = series([
      point("2026-11-16 00:45", 0),
      point("2026-11-16 18:45", 3),
      point("2026-11-17 00:45", 6),
      point("2026-11-17 12:45", 9),
    ]);
    // The range is 1–16 November: its totals end at midnight, its last day at the 00:45 read.
    const rangeToAt = midnight("2026-11-17");
    expect(day(link, "2026-11-16", rangeToAt)?.delta?.fans).toBe(3);
    const end = linkRangeDaysEnd(rangeToAt, msk("2026-11-17 15:00"));
    expect(end).toEqual(msk("2026-11-17 04:00"));
    expect(day(link, "2026-11-16", end)?.delta?.fans).toBe(6);
    // Asked before the closing read came: the day stops at now, still without the evening it has not read.
    const early = linkRangeDaysEnd(rangeToAt, msk("2026-11-17 00:10"));
    expect(early).toEqual(msk("2026-11-17 00:10"));
    expect(day(link, "2026-11-16", early)?.delta?.fans).toBe(3);
  });

  it("counts a day's new paying fans like its fans, unknown when a snapshot does not know them", () => {
    const link = series([
      point("2026-11-15 00:45", 3, 1),
      point("2026-11-16 00:45", 9, 2),
      point("2026-11-17 00:45", 12, null),
      point("2026-11-18 00:45", 15, 5),
    ]);
    const now = msk("2026-11-18 12:00");
    expect(day(link, "2026-11-15", now)?.delta?.spenders).toBe(1);
    expect(day(link, "2026-11-16", now)?.delta?.spenders).toBeNull();
    expect(day(link, "2026-11-17", now)?.delta?.spenders).toBeNull();
    expect(day(link, "2026-11-17", now)?.delta?.fans).toBe(3);
  });
});
