import { describe, expect, it } from "vitest";

import type { TeamLedgerReportDay, TeamLedgerReportPage } from "../packages/contracts/src/index.ts";
import { peopleIndex, type RegistryPerson } from "../packages/ui/src/people.ts";
import { reportNotes, reportSumOf, type NoteShift } from "../apps/workboard/src/screens/shifts/reports.ts";

// «Смены» count a shift's sales by the rule «чья продажа»; people are paid by the day's report (the post, or the
// report handed in in Hub). Where the report of a person's day has another sum, the day's last shift says it:
// «в отчёте $…» (one shift that day), «в отчёте за день $…» (several). Invented people and amounts.

const RULE_FROM = "2026-11-02";
const msk = (at: string) => new Date(`${at.replace(" ", "T")}:00+03:00`).toISOString();

function shift(userId: number, from: string, to: string, salesNetMills: number, ongoing = false): NoteShift {
  return { key: `${userId}:${msk(from)}`, userId, startedAt: msk(from), endedAt: msk(to), ongoing, salesNetMills };
}

function page(pageLabel: string, postedMills: number | null, extra: Partial<TeamLedgerReportPage> = {}): TeamLedgerReportPage {
  return { pageLabel, model: "Mia", postedMills, draftMills: postedMills, diffMills: null, state: "posted_equal", postedAt: null, hubMills: null, hubState: null, basis: "post", ...extra };
}

function day(userId: number, reportDate: string, pages: TeamLedgerReportPage[]): TeamLedgerReportDay {
  return {
    key: `person:p${userId}:${reportDate}`, person: { slug: `p${userId}`, hubUser: { userId, username: `login${userId}` }, name: `login${userId}` },
    reportDate, pages, postedMills: null, draftMills: null, hubMills: null, postedAt: null, draft: null, postIds: [],
  };
}

function person(id: number, logins: number[]): RegistryPerson {
  return { id, displayName: `Человек ${id}`, role: "chatter", logins: logins.map((userId) => ({ userId, username: `login${userId}` })) } as unknown as RegistryPerson;
}

const people = peopleIndex([person(1, [11, 12]), person(2, [21])]);

describe("what a report day pays by", () => {
  it("the post, page by page; the report handed in in Hub where the day accrues from it; a draft alone is no report", () => {
    expect(reportSumOf(day(11, "2026-11-10", [page("mia-1", 40_000), page("mia-2", 10_000)]), null)).toBe(50_000);
    expect(reportSumOf(day(11, "2026-11-10", [page("mia-1", 40_000), page("mia-2", 10_000)]), "mia-2")).toBe(10_000);
    expect(reportSumOf(day(11, "2026-11-10", [page("mia-1", 40_000, { hubMills: 45_000, basis: "hub" }), page("mia-2", 10_000, { basis: "hub" })]), null)).toBe(45_000);
    expect(reportSumOf(day(11, "2026-11-10", [page("mia-1", 40_000, { hubMills: 45_000, basis: "post" })]), null)).toBe(40_000);
    expect(reportSumOf(day(11, "2026-11-10", [page("mia-1", null, { draftMills: 30_000, state: "draft_only" })]), null)).toBeNull();
    expect(reportSumOf(day(11, "2026-11-10", [page("mia-1", 40_000)]), "mia-9")).toBeNull();
  });
});

describe("«в отчёте $…» on «Смены»", () => {
  const notes = (shifts: NoteShift[], days: TeamLedgerReportDay[], page: string | null = null, ruleFrom: string | null = RULE_FROM) =>
    reportNotes({ shifts, reports: { reports: days }, page, ruleFrom, people });

  it("says the report's sum on the shift when it differs from the rule's", () => {
    const one = shift(11, "2026-11-10 10:00", "2026-11-10 18:00", 246_400);
    expect([...notes([one], [day(11, "2026-11-10", [page("mia-1", 446_400)])])]).toEqual([[one.key, { reportMills: 446_400, ofDay: false }]]);
  });

  it("nothing when equal to the cent, when there is no report, or before the rule", () => {
    const one = shift(11, "2026-11-10 10:00", "2026-11-10 18:00", 246_404);
    expect(notes([one], [day(11, "2026-11-10", [page("mia-1", 246_400)])]).size).toBe(0);
    expect(notes([one], []).size).toBe(0);
    expect(notes([one], [day(11, "2026-11-10", [page("mia-1", 100_000)])], null, null).size).toBe(0);
    const old = shift(11, "2026-11-01 10:00", "2026-11-01 18:00", 10_000);
    expect(notes([old], [day(11, "2026-11-01", [page("mia-1", 90_000)])]).size).toBe(0);
  });

  it("a person-day of several shifts, on several logins, is one day: said once, on its last shift", () => {
    const morning = shift(11, "2026-11-10 08:00", "2026-11-10 12:00", 100_000);
    const evening = shift(12, "2026-11-10 18:00", "2026-11-10 23:00", 50_000);
    const other = shift(21, "2026-11-10 09:00", "2026-11-10 17:00", 70_000);
    const result = notes([evening, other, morning], [day(11, "2026-11-10", [page("mia-1", 200_000)]), day(21, "2026-11-10", [page("mia-1", 70_000)])]);
    expect([...result]).toEqual([[evening.key, { reportMills: 200_000, ofDay: true }]]);
    // The same sum as the day's shifts added up: nothing.
    expect(notes([evening, morning], [day(12, "2026-11-10", [page("mia-1", 150_000)])]).size).toBe(0);
  });

  it("a night is the day the ledger reports it on; a day with a shift still going says nothing yet", () => {
    const night = shift(21, "2026-11-10 23:00", "2026-11-11 07:00", 30_000);
    expect([...notes([night], [day(21, "2026-11-11", [page("mia-1", 35_000)])])]).toEqual([[night.key, { reportMills: 35_000, ofDay: false }]]);
    expect(notes([night], [day(21, "2026-11-10", [page("mia-1", 35_000)])]).size).toBe(0);
    const going = shift(21, "2026-11-11 08:00", "2026-11-11 12:00", 5_000, true);
    expect(notes([night, going], [day(21, "2026-11-11", [page("mia-1", 35_000)])]).size).toBe(0);
  });

  it("with a page picked, the report's page against the shift's sales of it", () => {
    const one = shift(11, "2026-11-10 10:00", "2026-11-10 18:00", 40_000);
    const both = day(11, "2026-11-10", [page("mia-1", 40_000), page("mia-2", 10_000)]);
    expect(notes([one], [both], "mia-1").size).toBe(0);
    expect([...notes([one], [both], "mia-2")]).toEqual([[one.key, { reportMills: 10_000, ofDay: false }]]);
  });

  it("the ledger not answering is no line at all", () => {
    const one = shift(11, "2026-11-10 10:00", "2026-11-10 18:00", 40_000);
    expect(reportNotes({ shifts: [one], reports: null, page: null, ruleFrom: RULE_FROM, people }).size).toBe(0);
  });
});
