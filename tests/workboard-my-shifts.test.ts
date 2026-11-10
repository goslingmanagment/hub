import { describe, expect, it } from "vitest";

import type { AccountShiftReport } from "@agency_hub_core/contracts";
import { resolvePeriod } from "../packages/ui/src/period.ts";
import {
  comparisonOf,
  factsOf,
  joinShifts,
  myShiftsWindow,
  previousReportedMills,
  UNKNOWN_TIME,
  type StatsShift,
} from "../apps/workboard/src/screens/my-shifts/model.ts";

// Workboard's «Мои смены»: a chatter's shifts (Hub) and their reports (the agency
// ledger: the agent's draft, the chatter's post in «Отчётность», or both) as one
// row each. The ledger dates a report by the Moscow day its shift BEGAN, a
// night's own day is the one holding most of it: the join goes by time, and a
// post written without the agent — it has no window — by the day its shift began.

const msk = (day: string, time: string) => new Date(`${day}T${time}:00+03:00`).toISOString();

function shift(from: string, to: string, extra: Partial<StatsShift> = {}): StatsShift {
  const workedMinutes = Math.round((Date.parse(to) - Date.parse(from)) / 60_000);
  return {
    date: from.slice(0, 10), startedAt: from, endedAt: to, ongoing: false, workedMinutes, pauses: [], pages: ["page-a"],
    salesNetMills: 100_000, overlapNetMills: 0, together: [], messages: 0, ppvSent: 0, fansWritten: 0, fansPaid: 0,
    confirmedNetMills: null, sales: [], ...extra,
  };
}

/** A draft the chatter posted as it was (the ledger's draft with its post). */
function report(id: number, reportDate: string, from: string, to: string, extra: Partial<AccountShiftReport> = {}): AccountShiftReport {
  const totalMills = extra.totalMills ?? 80_000;
  return {
    source: "both", id, reportDate, windowFrom: from, windowTo: to, cutAt: to, version: 1, versions: 1, status: "posted", totalMills,
    draftTotalMills: totalMills, savedAt: to, postedAt: to,
    pages: [{ pageLabel: "page-a", amountMills: totalMills, draftMills: totalMills, postedMills: totalMills, postState: "posted_equal" }], lines: [], ...extra,
  };
}

/** A post written without the agent: no window, no draft, no sales. */
function post(reportDate: string, totalMills: number): AccountShiftReport {
  return {
    source: "post", id: null, reportDate, windowFrom: null, windowTo: null, cutAt: null, version: null, versions: null, status: "posted",
    totalMills, draftTotalMills: null, savedAt: null, postedAt: msk(reportDate, "23:50"),
    pages: [{ pageLabel: "page-a", amountMills: totalMills, draftMills: null, postedMills: totalMills, postState: "post_only" }], lines: [],
  };
}

// The week of Monday 2 November 2026, Moscow.
const WEEK = { startsAt: Date.parse(msk("2026-11-02", "00:00")), endsAt: Date.parse(msk("2026-11-09", "00:00")) };

describe("joinShifts", () => {
  it("gives a day shift its report: the report's total is the row's number, Hub's figure is gone", () => {
    const rows = joinShifts({
      shifts: [shift(msk("2026-11-03", "12:05"), msk("2026-11-03", "19:50"))],
      reports: [report(1, "2026-11-03", msk("2026-11-03", "12:00"), msk("2026-11-03", "20:00"))],
      window: WEEK,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "posted", totalMills: 80_000, hubMills: null });
    expect(rows[0]!.report?.id).toBe(1);
  });

  it("puts a night's report, dated by the day it began, on that night — not on the night before", () => {
    // Two nights: Sun 1 → Mon 2 (pay day Monday) and Mon 2 → Tue 3 (pay day Tuesday).
    const first = shift(msk("2026-11-01", "23:00"), msk("2026-11-02", "07:00"));
    const second = shift(msk("2026-11-02", "23:10"), msk("2026-11-03", "07:05"));
    // The report of the second night is dated Monday, the day it began: Monday is the FIRST night's pay day.
    const rows = joinShifts({
      shifts: [second, first],
      reports: [report(2, "2026-11-02", msk("2026-11-02", "23:00"), msk("2026-11-03", "07:00"))],
      window: WEEK,
    });
    expect(rows.map((row) => [row.shift?.startedAt, row.report?.id ?? null, row.state])).toEqual([
      [second.startedAt, 2, "posted"],
      [first.startedAt, null, "missing"],
    ]);
  });

  it("falls back to the pay day when the report's window (a schedule) misses the shift, the longest shift of that day", () => {
    const short = shift(msk("2026-11-04", "08:00"), msk("2026-11-04", "10:00"));
    const long = shift(msk("2026-11-04", "17:00"), msk("2026-11-04", "23:30"));
    const rows = joinShifts({
      shifts: [long, short],
      reports: [report(3, "2026-11-04", msk("2026-11-04", "12:00"), msk("2026-11-04", "16:00"))],
      window: WEEK,
    });
    expect(rows.find((row) => row.report !== null)?.shift?.startedAt).toBe(long.startedAt);
    expect(rows.find((row) => row.shift === short)?.state).toBe("missing");
  });

  it("gives each report one shift and each shift one report, the longest overlap first", () => {
    const day = shift(msk("2026-11-05", "10:00"), msk("2026-11-05", "18:00"));
    const rows = joinShifts({
      shifts: [day],
      reports: [
        report(4, "2026-11-05", msk("2026-11-05", "09:00"), msk("2026-11-05", "11:00")),
        report(5, "2026-11-05", msk("2026-11-05", "10:00"), msk("2026-11-05", "18:00")),
      ],
      window: WEEK,
    });
    expect(rows.find((row) => row.shift === day)?.report?.id).toBe(5);
    // The other report of the day stays a row of its own: Hub saw no other shift.
    expect(rows.find((row) => row.shift === null)?.report?.id).toBe(4);
  });

  it("keeps a report Hub has no shift for as its own row, and drops one of the window before read for its night", () => {
    const rows = joinShifts({
      shifts: [],
      reports: [
        report(6, "2026-11-06", msk("2026-11-06", "19:00"), msk("2026-11-06", "23:30"), { source: "draft", status: "draft", postedAt: null }),
        // Sunday 1 November, read only because a night of Monday may be dated by it: not this week's.
        report(7, "2026-11-01", msk("2026-11-01", "16:00"), msk("2026-11-01", "23:00")),
      ],
      window: WEEK,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "report:6", shift: null, workedMinutes: null, totalMills: 80_000, hubMills: null, state: "draft", pages: ["page-a"] });
    expect(rows[0]!.when.label).toBe("пт, 6 нояб. 19:00–23:30");
  });

  it("says «Идёт» for a shift going on and puts it first, then the newest; a state the ledger adds later passes as it is", () => {
    const ongoing = shift(msk("2026-11-07", "18:00"), msk("2026-11-07", "21:00"), { ongoing: true, salesNetMills: 42_000 });
    const older = shift(msk("2026-11-03", "10:00"), msk("2026-11-03", "18:00"));
    const newer = shift(msk("2026-11-06", "10:00"), msk("2026-11-06", "18:00"));
    const rows = joinShifts({
      shifts: [older, ongoing, newer],
      reports: [report(8, "2026-11-06", msk("2026-11-06", "10:00"), msk("2026-11-06", "18:00"), { source: "draft", status: "checked", postedAt: null })],
      window: WEEK,
    });
    expect(rows.map((row) => [row.shift?.startedAt, row.state])).toEqual([
      [ongoing.startedAt, "ongoing"],
      [newer.startedAt, "other"],
      [older.startedAt, "missing"],
    ]);
    expect(rows[0]).toMatchObject({ totalMills: null, hubMills: 42_000 });
  });

  it("shows every shift when the reports did not come, and asks for no report it cannot know of", () => {
    const rows = joinShifts({
      shifts: [shift(msk("2026-11-07", "18:00"), msk("2026-11-07", "21:00"), { ongoing: true }), shift(msk("2026-11-03", "10:00"), msk("2026-11-03", "18:00"))],
      reports: null,
      window: WEEK,
    });
    expect(rows.map((row) => row.state)).toEqual(["ongoing", "unknown"]);
    expect(factsOf(rows, false)).toMatchObject({ shifts: 2, reportedMills: null, perHourMills: null, withoutReport: 0 });
  });
});

describe("joinShifts: the posts in «Отчётность»", () => {
  it("gives a shift its post written without the agent, by the day: «Отправлен», the posted sum, Hub's figure gone", () => {
    const day = shift(msk("2026-11-04", "12:00"), msk("2026-11-04", "20:00"));
    const rows = joinShifts({ shifts: [day], reports: [post("2026-11-04", 64_000)], window: WEEK });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ shift: day, state: "posted", totalMills: 64_000, draftMills: null, hubMills: null });
    expect(rows[0]!.report?.source).toBe("post");
  });

  it("puts a night's post on the night that began on its date, not on the night it ends", () => {
    // Sun 1 → Mon 2 ends on Monday (its pay day); Mon 2 → Tue 3 began on Monday: the post dated Monday is the second's.
    const first = shift(msk("2026-11-01", "23:00"), msk("2026-11-02", "07:00"));
    const second = shift(msk("2026-11-02", "23:10"), msk("2026-11-03", "07:05"));
    const rows = joinShifts({ shifts: [second, first], reports: [post("2026-11-02", 51_000)], window: WEEK });
    expect(rows.map((row) => [row.shift?.startedAt, row.report?.totalMills ?? null, row.state])).toEqual([
      [second.startedAt, 51_000, "posted"],
      [first.startedAt, null, "missing"],
    ]);
    // A night alone takes a post dated by the day it ends, too (the pay day).
    const alone = joinShifts({ shifts: [first], reports: [post("2026-11-02", 51_000)], window: WEEK });
    expect(alone[0]).toMatchObject({ state: "posted", totalMills: 51_000 });
  });

  it("keeps a post Hub has no shift for as a row of its own, by its day: no clock is invented", () => {
    const rows = joinShifts({ shifts: [], reports: [post("2026-11-05", 30_000), post("2026-11-01", 9_000)], window: WEEK });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "post:2026-11-05", shift: null, state: "posted", totalMills: 30_000, pages: ["page-a"] });
    expect(rows[0]!.when.time).toBe(UNKNOWN_TIME);
    expect(rows[0]!.when.days).toBe("чт, 5 нояб.");
  });

  it("says what the draft was where the chatter posted another sum — a changed page or a page left out — and nothing where it is the same", () => {
    const changed = shift(msk("2026-11-03", "10:00"), msk("2026-11-03", "18:00"));
    const partial = shift(msk("2026-11-04", "10:00"), msk("2026-11-04", "18:00"));
    const same = shift(msk("2026-11-05", "10:00"), msk("2026-11-05", "18:00"));
    const drafted = shift(msk("2026-11-06", "10:00"), msk("2026-11-06", "18:00"));
    const rows = joinShifts({
      shifts: [changed, partial, same, drafted],
      reports: [
        report(21, "2026-11-03", changed.startedAt, changed.endedAt, { totalMills: 95_000, draftTotalMills: 80_000 }),
        report(22, "2026-11-04", partial.startedAt, partial.endedAt, { totalMills: 50_000, draftTotalMills: 70_000 }),
        report(23, "2026-11-05", same.startedAt, same.endedAt),
        report(24, "2026-11-06", drafted.startedAt, drafted.endedAt, { source: "draft", status: "draft", postedAt: null }),
      ],
      window: WEEK,
    });
    const of = (one: StatsShift) => rows.find((row) => row.shift === one)!;
    expect(of(changed)).toMatchObject({ state: "posted", totalMills: 95_000, draftMills: 80_000 });
    expect(of(partial)).toMatchObject({ state: "posted", totalMills: 50_000, draftMills: 70_000 });
    expect(of(same)).toMatchObject({ state: "posted", totalMills: 80_000, draftMills: null });
    expect(of(drafted)).toMatchObject({ state: "draft", totalMills: 80_000, draftMills: null });
    // «По отчётам» is what was posted, the draft where nothing was.
    expect(factsOf(rows, true)).toMatchObject({ reportedMills: 95_000 + 50_000 + 80_000 + 80_000, withoutReport: 0, drafts: 1 });
  });

  it("claims no missing report while the posts did not come: a shift without a draft may have a post", () => {
    const withDraft = shift(msk("2026-11-03", "10:00"), msk("2026-11-03", "18:00"));
    const without = shift(msk("2026-11-04", "10:00"), msk("2026-11-04", "18:00"));
    const rows = joinShifts({
      shifts: [withDraft, without],
      reports: [report(25, "2026-11-03", withDraft.startedAt, withDraft.endedAt, { source: "draft", status: "draft", postedAt: null })],
      postsRead: false,
      window: WEEK,
    });
    expect(rows.map((row) => row.state)).toEqual(["unknown", "draft"]);
    expect(factsOf(rows, false)).toMatchObject({ withoutReport: 0, reportedMills: null, drafts: 1 });
  });
});

describe("factsOf", () => {
  it("sums the reports, divides only the reported shifts' money by their hours, and names the shifts without a report", () => {
    const rows = joinShifts({
      shifts: [
        shift(msk("2026-11-03", "10:00"), msk("2026-11-03", "14:00")),
        shift(msk("2026-11-04", "10:00"), msk("2026-11-04", "14:00")),
      ],
      reports: [
        report(9, "2026-11-03", msk("2026-11-03", "10:00"), msk("2026-11-03", "14:00"), { totalMills: 200_000 }),
        report(10, "2026-11-06", msk("2026-11-06", "19:00"), msk("2026-11-06", "21:00"), { totalMills: 30_000 }),
      ],
      window: WEEK,
    });
    expect(factsOf(rows, true)).toEqual({
      shifts: 3,
      workedMinutes: 480,
      reportedMills: 230_000,
      // $200 over the 4 hours of the one shift that has a report; the report without a shift has no hours.
      perHourMills: 50_000,
      withoutReport: 1,
      drafts: 0,
    });
  });
});

describe("the window and the comparison", () => {
  const now = Date.parse(msk("2026-11-10", "23:00"));

  it("reads a whole calendar week, and the reports from the day before it", () => {
    const window = myShiftsWindow(resolvePeriod({ kind: "week", monday: "2026-11-09" }, "2026-11-10"), now);
    expect(window).toMatchObject({ days: 7, until: "2026-11-15", from: "2026-11-09", to: "2026-11-15", clipped: false, reportsFrom: "2026-11-08", reportsTo: "2026-11-10" });
    expect(window.previous).toMatchObject({ reportsFrom: "2026-11-01", reportsTo: "2026-11-08" });
  });

  it("shows the last 31 days of a longer own range", () => {
    const window = myShiftsWindow(resolvePeriod({ kind: "range", from: "2026-09-01", to: "2026-10-31" }, "2026-11-10"), now);
    expect(window).toMatchObject({ days: 31, until: "2026-10-31", from: "2026-10-01", to: "2026-10-31", clipped: true });
  });

  it("cuts the week before at the same point — at the start of the shift going on, whose report is not there yet", () => {
    const window = myShiftsWindow(resolvePeriod({ kind: "week", monday: "2026-11-09" }, "2026-11-10"), now);
    const cut = comparisonOf(window, now, msk("2026-11-10", "20:00"));
    expect(cut).toMatchObject({ endsAt: Date.parse(msk("2026-11-03", "20:00")), label: "2–3 нояб.", sameTime: true });
    // Last week's Tuesday evening shift began after that point: it is not compared with today's, still without a report.
    const reports = [
      report(11, "2026-11-02", msk("2026-11-02", "18:00"), msk("2026-11-02", "23:00"), { totalMills: 60_000 }),
      report(12, "2026-11-03", msk("2026-11-03", "20:30"), msk("2026-11-04", "02:00"), { totalMills: 90_000 }),
    ];
    expect(previousReportedMills(reports, cut)).toBe(60_000);
    // A week that is over is compared with the whole week before it.
    const past = myShiftsWindow(resolvePeriod({ kind: "week", monday: "2026-11-02" }, "2026-11-10"), now);
    expect(comparisonOf(past, now, null)).toMatchObject({ label: "26 окт. – 1 нояб.", sameTime: false });
  });

  it("has nothing to compare with when the ledger holds no report of the window before", () => {
    const window = myShiftsWindow(resolvePeriod({ kind: "days", days: 14 }, "2026-11-10"), now);
    expect(previousReportedMills([], comparisonOf(window, now, null))).toBeNull();
    expect(previousReportedMills(null, comparisonOf(window, now, null))).toBeNull();
  });
});
