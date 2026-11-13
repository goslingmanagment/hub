import { describe, expect, it } from "vitest";

import { SHIFT_REPORT_NOTE_SALES_MAX, type TeamLedgerReportDay, type TeamLedgerReportPage } from "../packages/contracts/src/index.ts";
import type { PairLine } from "../apps/runtime/src/services/report-line-pairs.ts";
import { peopleLoginsOf } from "../apps/runtime/src/services/sale-rule-screens.ts";
import {
  ledgerWindows,
  personDayNotes,
  readsEveryone,
  reportSumOf,
  shiftReportNoteOf,
  type NoteReportDay,
  type NoteSale,
  type NoteShift,
} from "../apps/runtime/src/services/shift-report-notes.ts";

// «Смены» count a shift's sales by the rule «чья продажа»; people are paid by the day's report. What stands between
// the two is said per person and report day as named things — sales no report pays, sums put in by word, a post
// changed by hand — and nothing where the day's two sums differ only by a sale paid in a later report («долёт»).
// Invented people, pages and amounts.

const msk = (at: string) => Date.parse(`${at.replace(" ", "T")}:00+03:00`);

// One person holds logins 11 and 12; another holds 21; login 31 is nobody's.
const logins = peopleLoginsOf([
  { userId: 11, username: "mira", personId: 1, displayName: "Мира" },
  { userId: 12, username: "mira.old", personId: 1, displayName: "Мира" },
  { userId: 21, username: "tim", personId: 2, displayName: "Тим" },
]);

let nextId = 500;
function sale(at: string, netMills: number, extra: Partial<NoteSale> = {}): NoteSale {
  nextId += 1;
  return {
    transactionId: nextId, hubRef: String(nextId), platformRef: `pf-${nextId}`, pageLabel: "page-a", netMills, occurredAt: msk(at),
    kind: "message_purchase", ...extra,
  };
}

function shift(userId: number, reportDate: string, sales: NoteSale[], extra: Partial<NoteShift> = {}): NoteShift {
  return { userId, reportDate, ongoing: false, salesNetMills: sales.reduce((sum, one) => sum + one.netMills, 0), sales, ...extra };
}

const paid = (one: NoteSale): PairLine => ({ ref: one.platformRef, pageLabel: one.pageLabel, netMills: one.netMills, counted: true, what: "" });
const added = (netMills: number, what: string, ref: string | null = null): PairLine => ({ ref, pageLabel: "page-a", netMills, counted: true, what });
const sumOf = (lines: readonly PairLine[]) => lines.filter((line) => line.counted).reduce((sum, line) => sum + line.netMills, 0);

/** A report day posted as its breakdown says, unless `payBaseMills` says otherwise. */
function report(userId: number, reportDate: string, lines: PairLine[] | null, payBaseMills?: number | null): NoteReportDay {
  return { userId, reportDate, lines, payBaseMills: payBaseMills === undefined ? (lines === null ? null : sumOf(lines)) : payBaseMills };
}

const WEEK = { from: "2026-11-09", to: "2026-11-15" };
const notesOf = (input: { shifts: NoteShift[]; reportDays: NoteReportDay[]; withoutShift?: Array<{ userId: number; sale: NoteSale }>; only?: number; from?: string; to?: string }) =>
  personDayNotes({ withoutShift: [], logins, ...WEEK, ...input });

describe("what a report day pays by", () => {
  const page = (pageLabel: string, postedMills: number | null, extra: Partial<TeamLedgerReportPage> = {}): TeamLedgerReportPage => ({
    pageLabel, model: "Mia", postedMills, draftMills: postedMills, diffMills: null, state: "posted_equal", postedAt: null, hubMills: null, hubState: null, basis: "post", ...extra,
  });
  const day = (pages: TeamLedgerReportPage[]): Pick<TeamLedgerReportDay, "pages"> => ({ pages });

  it("the post, page by page; the report handed in in Hub where the day accrues from it; a draft alone is no report", () => {
    expect(reportSumOf(day([page("page-a", 40_000), page("page-b", 10_000)]), null)).toBe(50_000);
    expect(reportSumOf(day([page("page-a", 40_000), page("page-b", 10_000)]), new Set(["page-b"]))).toBe(10_000);
    expect(reportSumOf(day([page("page-a", 40_000, { hubMills: 45_000, basis: "hub" }), page("page-b", 10_000, { basis: "hub" })]), null)).toBe(45_000);
    expect(reportSumOf(day([page("page-a", 40_000, { hubMills: 45_000, basis: "post" })]), null)).toBe(40_000);
    // A ledger that does not say the basis: the post, else Hub's.
    expect(reportSumOf(day([page("page-a", null, { hubMills: 45_000, basis: null })]), null)).toBe(45_000);
    expect(reportSumOf(day([page("page-a", null, { draftMills: 30_000, state: "draft_only" })]), null)).toBeNull();
    expect(reportSumOf(day([page("page-a", 40_000)]), new Set(["page-z"]))).toBeNull();
  });
});

describe("a day whose two sums differ only by a sale paid later", () => {
  it("says nothing: the late sale is in the next day's report, by its reference or in words", () => {
    const inTime = sale("2026-11-10 14:00", 40_000);
    const lateByRef = sale("2026-11-10 22:50", 15_990);
    const lateInWords = sale("2026-11-10 23:10", 8_000);
    const nextDay = sale("2026-11-11 15:00", 20_000);
    const notes = notesOf({
      shifts: [shift(11, "2026-11-10", [inTime, lateByRef, lateInWords]), shift(11, "2026-11-11", [nextDay])],
      reportDays: [
        // Tuesday's report was cut before the two late sales: $40.00 against the rule's $63.99.
        report(11, "2026-11-10", [paid(inTime)]),
        // Wednesday's pays them as «долёт»: one added with the sale's reference (Hub's id), one — older — in words.
        report(11, "2026-11-11", [paid(nextDay), added(15_990, "долёт ппв", lateByRef.hubRef), added(8_000, "долёт: тип 23:10")]),
      ],
    });
    expect(notes).toEqual([]);
  });

  it("a report later than the shown days pays it too; one that never does leaves the sale unreported", () => {
    const late = sale("2026-11-15 23:30", 12_000);
    const sunday = shift(11, "2026-11-15", [late]);
    const paidLater = notesOf({ shifts: [sunday], reportDays: [report(11, "2026-11-15", []), report(11, "2026-11-19", [added(12_000, "долёт 23:30")])] });
    expect(paidLater).toEqual([]);
    const never = notesOf({ shifts: [sunday], reportDays: [report(11, "2026-11-15", [])] });
    expect(never.map((note) => note.unreported.map((one) => one.transactionId))).toEqual([[late.transactionId]]);
  });

  it("a «долёт» of the week before in a shown day's report is that sale's pay, not money by word", () => {
    const lastWeek = sale("2026-11-06 23:40", 9_990);
    const monday = sale("2026-11-09 12:00", 30_000);
    const notes = notesOf({
      // The shift of last Friday is read though it is not shown: its sales are what Monday's report may pay.
      shifts: [shift(11, "2026-11-06", [lastWeek]), shift(11, "2026-11-09", [monday])],
      reportDays: [report(11, "2026-11-06", []), report(11, "2026-11-09", [paid(monday), added(9_990, "долёт ппв 23:40")])],
    });
    // Friday is not a shown day: no note of it either.
    expect(notes).toEqual([]);
  });
});

describe("sales no report pays", () => {
  it("are listed on their shift's day with their count and sum, the oldest first, without the fan", () => {
    const first = sale("2026-11-10 13:00", 15_992, { kind: "tip" });
    const second = sale("2026-11-10 16:30", 24_000);
    const reported = sale("2026-11-10 15:00", 40_000);
    const [note] = notesOf({ shifts: [shift(11, "2026-11-10", [reported, second, first])], reportDays: [report(11, "2026-11-10", [paid(reported)])] }).map(shiftReportNoteOf);
    expect(note).toEqual({
      userIds: [11, 12],
      reportDate: "2026-11-10",
      unreported: {
        count: 2,
        mills: 39_992,
        sales: [
          { saleId: first.transactionId, occurredAt: new Date(msk("2026-11-10 13:00")).toISOString(), pageLabel: "page-a", kind: "tip", netMills: 15_992 },
          { saleId: second.transactionId, occurredAt: new Date(msk("2026-11-10 16:30")).toISOString(), pageLabel: "page-a", kind: "message_purchase", netMills: 24_000 },
        ],
      },
      byWordsMills: 0,
      postApartMills: 0,
      sumOnlyMills: null,
    });
  });

  it("only of a day with a saved breakdown: a day without any report says nothing, a breakdown not posted yet is read", () => {
    const one = sale("2026-11-10 13:00", 15_000);
    const day = shift(11, "2026-11-10", [one]);
    expect(notesOf({ shifts: [day], reportDays: [] })).toEqual([]);
    // Another day's report does not make this day a reported one.
    expect(notesOf({ shifts: [day], reportDays: [report(11, "2026-11-11", [])] })).toEqual([]);
    // Composed, not posted: no pay base yet, the breakdown is there.
    const draft = notesOf({ shifts: [day], reportDays: [report(11, "2026-11-10", [], null)] });
    expect(draft.map((note) => [note.unreported.length, note.postApartMills])).toEqual([[1, 0]]);
  });

  it("a line held out of the report's sum does not pay its sale", () => {
    const held = sale("2026-11-10 13:00", 15_000);
    const notes = notesOf({ shifts: [shift(11, "2026-11-10", [held])], reportDays: [report(11, "2026-11-10", [{ ...paid(held), counted: false }])] });
    expect(notes.map((note) => note.unreported.map((one) => one.transactionId))).toEqual([[held.transactionId]]);
  });

  it("lists at most SHIFT_REPORT_NOTE_SALES_MAX of them; the count and the sum are of all", () => {
    const many = Array.from({ length: SHIFT_REPORT_NOTE_SALES_MAX + 3 }, (_, index) => sale(`2026-11-10 12:${String(index).padStart(2, "0")}`, 1_000));
    const [note] = notesOf({ shifts: [shift(11, "2026-11-10", many)], reportDays: [report(11, "2026-11-10", [])] }).map(shiftReportNoteOf);
    expect(note!.unreported.count).toBe(SHIFT_REPORT_NOTE_SALES_MAX + 3);
    expect(note!.unreported.mills).toBe((SHIFT_REPORT_NOTE_SALES_MAX + 3) * 1_000);
    expect(note!.unreported.sales).toHaveLength(SHIFT_REPORT_NOTE_SALES_MAX);
  });

  it("a sale two shifts of the person's day share is one sale, the parts added", () => {
    const half = sale("2026-11-10 13:00", 10_000);
    const otherHalf: NoteSale = { ...half, netMills: 6_000 };
    const notes = notesOf({ shifts: [shift(11, "2026-11-10", [half]), shift(12, "2026-11-10", [otherHalf])], reportDays: [report(12, "2026-11-10", [])] });
    expect(notes.map((note) => note.unreported.map((one) => [one.transactionId, one.netMills]))).toEqual([[[half.transactionId, 16_000]]]);
  });
});

describe("what a report counts by word", () => {
  it("is the day's counted lines that pay none of the person's sales: someone else's sale, money past the platform", () => {
    const own = sale("2026-11-10 13:00", 15_000);
    const notes = notesOf({
      shifts: [shift(11, "2026-11-10", [own])],
      reportDays: [report(11, "2026-11-10", [
        paid(own),
        added(25_000, "ппв другой смены, фан купил при мне", "pf-of-another-shift"),
        added(12_000, "перевод на карту мимо площадки"),
        { ...added(99_000, "не моё"), counted: false },
      ])],
    });
    expect(notes).toMatchObject([{ reportDate: "2026-11-10", unreported: [], byWordsMills: 37_000, postApartMills: 0 }]);
  });

  it("stands on the day of the report that counts it, not on another day of the person", () => {
    const tuesday = sale("2026-11-10 13:00", 15_000);
    const wednesday = sale("2026-11-11 13:00", 18_000);
    const notes = notesOf({
      shifts: [shift(11, "2026-11-10", [tuesday]), shift(11, "2026-11-11", [wednesday])],
      reportDays: [report(11, "2026-11-10", [paid(tuesday)]), report(11, "2026-11-11", [paid(wednesday), added(12_000, "со слов")])],
    });
    expect(notes.map((note) => [note.reportDate, note.byWordsMills])).toEqual([["2026-11-11", 12_000]]);
  });

  it("a second line of a sale an earlier report already pays is by word: a sale is paid once", () => {
    const one = sale("2026-11-10 13:00", 15_000);
    const next = sale("2026-11-11 13:00", 18_000);
    const notes = notesOf({
      shifts: [shift(11, "2026-11-10", [one]), shift(11, "2026-11-11", [next])],
      reportDays: [report(11, "2026-11-11", [paid(next), paid(one)]), report(11, "2026-11-10", [paid(one)])],
    });
    expect(notes.map((note) => [note.reportDate, note.byWordsMills])).toEqual([["2026-11-11", 15_000]]);
  });

  it("a sale the rule gives the person with no shift to hold it is theirs: its line is not by word, and no day lists it", () => {
    const decided = sale("2026-11-08 20:00", 30_000);
    const own = sale("2026-11-10 13:00", 15_000);
    const notes = notesOf({
      shifts: [shift(11, "2026-11-10", [own])],
      withoutShift: [{ userId: 12, sale: decided }],
      reportDays: [report(11, "2026-11-10", [paid(own), paid(decided)])],
    });
    expect(notes).toEqual([]);
  });
});

describe("a post that lies apart from its breakdown", () => {
  const own = sale("2026-11-10 13:00", 40_000);
  const day = [shift(11, "2026-11-10", [own])];

  it("says by how much, with its sign", () => {
    expect(notesOf({ shifts: day, reportDays: [report(11, "2026-11-10", [paid(own)], 55_000)] })).toMatchObject([{ postApartMills: 15_000, byWordsMills: 0, unreported: [] }]);
    expect(notesOf({ shifts: day, reportDays: [report(11, "2026-11-10", [paid(own)], 32_000)] })).toMatchObject([{ postApartMills: -8_000 }]);
  });

  it("cents apart is rounding, half a dollar is a change; a breakdown not posted has nothing to lie apart from", () => {
    expect(notesOf({ shifts: day, reportDays: [report(11, "2026-11-10", [paid(own)], 40_490)] })).toEqual([]);
    expect(notesOf({ shifts: day, reportDays: [report(11, "2026-11-10", [paid(own)], 39_510)] })).toEqual([]);
    expect(notesOf({ shifts: day, reportDays: [report(11, "2026-11-10", [paid(own)], 40_500)] })).toMatchObject([{ postApartMills: 500 }]);
    expect(notesOf({ shifts: day, reportDays: [report(11, "2026-11-10", [paid(own)], null)] })).toEqual([]);
  });

  it("every kind on one day, each its own number", () => {
    const missing = sale("2026-11-10 18:00", 21_000);
    const notes = notesOf({
      shifts: [shift(11, "2026-11-10", [own, missing])],
      reportDays: [report(11, "2026-11-10", [paid(own), added(12_000, "со слов")], 67_000)],
    });
    expect(notes).toMatchObject([{ byWordsMills: 12_000, postApartMills: 15_000, sumOnlyMills: null }]);
    expect(notes[0]!.unreported.map((one) => one.transactionId)).toEqual([missing.transactionId]);
  });
});

describe("a day paid by a report with no breakdown", () => {
  const own = sale("2026-11-10 13:00", 246_404);
  const day = [shift(11, "2026-11-10", [own])];

  it("says the report's sum where it is another than the rule's shifts of the day, and lists no sale", () => {
    expect(notesOf({ shifts: day, reportDays: [report(11, "2026-11-10", null, 446_400)] }))
      .toEqual([{ userIds: [11, 12], reportDate: "2026-11-10", unreported: [], byWordsMills: 0, postApartMills: 0, sumOnlyMills: 446_400 }]);
  });

  it("nothing when equal to the cent or cents apart, and nothing without a pay base", () => {
    expect(notesOf({ shifts: day, reportDays: [report(11, "2026-11-10", null, 246_400)] })).toEqual([]);
    expect(notesOf({ shifts: day, reportDays: [report(11, "2026-11-10", null, 246_890)] })).toEqual([]);
    expect(notesOf({ shifts: day, reportDays: [report(11, "2026-11-10", null, 246_910)] })).toHaveLength(1);
    expect(notesOf({ shifts: day, reportDays: [report(11, "2026-11-10", null, null)] })).toEqual([]);
  });

  it("the day's shifts are added up before they are compared", () => {
    const morning = shift(11, "2026-11-10", [sale("2026-11-10 09:00", 100_000)]);
    const evening = shift(12, "2026-11-10", [sale("2026-11-10 19:00", 50_000)]);
    expect(notesOf({ shifts: [morning, evening], reportDays: [report(12, "2026-11-10", null, 150_000)] })).toEqual([]);
    expect(notesOf({ shifts: [morning, evening], reportDays: [report(12, "2026-11-10", null, 200_000)] })).toMatchObject([{ sumOnlyMills: 200_000 }]);
  });
});

describe("whose day it is, and which days", () => {
  it("a person is every login of theirs: shifts on one, the report on another, lines of both", () => {
    const morning = sale("2026-11-10 09:00", 10_000);
    const evening = sale("2026-11-10 19:00", 20_000);
    const notes = notesOf({
      shifts: [shift(11, "2026-11-10", [morning]), shift(12, "2026-11-10", [evening])],
      reportDays: [report(12, "2026-11-10", [paid(morning)])],
    });
    expect(notes.map((note) => [note.userIds, note.unreported.map((one) => one.transactionId)])).toEqual([[[11, 12], [evening.transactionId]]]);
    // Another person's report pays nothing of this one's, and a login nobody holds is a person of its own.
    const foreign = notesOf({ shifts: [shift(11, "2026-11-10", [morning])], reportDays: [report(11, "2026-11-10", []), report(21, "2026-11-10", [paid(morning)])] });
    expect(foreign.map((note) => [note.userIds, note.unreported.length, note.byWordsMills])).toEqual([[[11, 12], 1, 0]]);
    const alone = notesOf({ shifts: [shift(31, "2026-11-10", [evening])], reportDays: [report(31, "2026-11-10", [])] });
    expect(alone.map((note) => note.userIds)).toEqual([[31]]);
  });

  it("a day with a shift still going on says nothing yet", () => {
    const one = sale("2026-11-10 13:00", 15_000);
    const going = shift(11, "2026-11-10", [], { ongoing: true });
    expect(notesOf({ shifts: [shift(11, "2026-11-10", [one]), going], reportDays: [report(11, "2026-11-10", [])] })).toEqual([]);
  });

  it("only the shown days have a note, the newest first", () => {
    const before = sale("2026-11-08 13:00", 5_000);
    const monday = sale("2026-11-09 13:00", 6_000);
    const sunday = sale("2026-11-15 13:00", 7_000);
    const after = sale("2026-11-16 13:00", 8_000);
    const notes = notesOf({
      shifts: [shift(11, "2026-11-08", [before]), shift(11, "2026-11-09", [monday]), shift(21, "2026-11-15", [sunday]), shift(11, "2026-11-16", [after])],
      reportDays: ["2026-11-08", "2026-11-09", "2026-11-16"].map((date) => report(11, date, [])).concat(report(21, "2026-11-15", [])),
    });
    expect(notes.map((note) => [note.reportDate, note.userIds])).toEqual([["2026-11-15", [21]], ["2026-11-09", [11, 12]]]);
  });

  it("a chatter's own answer holds their person's days alone", () => {
    const mine = sale("2026-11-10 13:00", 15_000);
    const theirs = sale("2026-11-10 14:00", 99_000);
    const notes = notesOf({
      shifts: [shift(11, "2026-11-10", [mine]), shift(21, "2026-11-10", [theirs])],
      reportDays: [report(11, "2026-11-10", []), report(21, "2026-11-10", [added(50_000, "со слов")])],
      // By either login of the person.
      only: 12,
    });
    expect(notes.map((note) => note.userIds)).toEqual([[11, 12]]);
    expect(JSON.stringify(notes)).not.toContain("99000");
    expect(JSON.stringify(notes)).not.toContain("50000");
  });
});

describe("the ledger's windows", () => {
  it("one window while the days fit the ledger's limit, several when they do not", () => {
    expect(ledgerWindows("2026-11-07", "2026-11-23", 62)).toEqual([{ from: "2026-11-07", to: "2026-11-23" }]);
    expect(ledgerWindows("2026-09-01", "2026-11-23", 62)).toEqual([{ from: "2026-09-01", to: "2026-11-01" }, { from: "2026-11-02", to: "2026-11-23" }]);
    expect(ledgerWindows("2026-11-01", "2026-11-03", 1)).toEqual([
      { from: "2026-11-01", to: "2026-11-01" }, { from: "2026-11-02", to: "2026-11-02" }, { from: "2026-11-03", to: "2026-11-03" },
    ]);
  });
});

describe("whose days a session reads", () => {
  it("everyone's for the owner and a team lead; one's own for a chatter, and for a narrow session whatever the role", () => {
    expect(readsEveryone({ user: { role: "owner" } })).toBe(true);
    expect(readsEveryone({ user: { role: "team_lead" } })).toBe(true);
    expect(readsEveryone({ user: { role: "chatter" } })).toBe(false);
    expect(readsEveryone({ user: { role: "owner" }, narrowDeviceTokenId: 7 })).toBe(false);
    expect(readsEveryone({ user: { role: "team_lead" }, narrowDeviceTokenId: 7 })).toBe(false);
  });
});
