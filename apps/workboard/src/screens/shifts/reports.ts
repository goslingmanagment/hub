/**
 * «в отчёте $…» on «Смены» — pure, no React (tests/workboard-shifts-reports.test.ts). A shift's money here is the
 * rule's («чья продажа», sale-rule.ts via `teamShiftSales`); people are paid by the day's report — the post the chat
 * agent collected, or the report handed in in Hub — as the ledger reads it (`teamLedgerReports`, the read «Выплаты →
 * Отчёты» and the sale chain use, one request for the period). Where the report of a person's day has another sum than
 * the rule's shifts of that day, the day's last shift says it, as «Выплаты → Долги» says «в таблице $…»: the report's
 * sum alone, once a day. Nothing when they are equal to the cent, when there is no report (a draft not sent is none
 * yet), before the rule, while a shift of that day goes on, or when the ledger did not answer.
 */
import type { TeamLedgerReportDay, TeamLedgerReportsResponse } from "@agency_hub_core/contracts";
import { formatMills } from "@agency_hub_core/ui/format";
import { shiftReportDay, type MoscowDay } from "@agency_hub_core/ui/moscow";
import type { PeopleIndex } from "@agency_hub_core/ui/people";

/** What a journal row brings: a login's shift and its money by the rule. */
export interface NoteShift {
  key: string;
  userId: number;
  startedAt: string;
  endedAt: string;
  ongoing: boolean;
  salesNetMills: number;
}

export interface ReportNote {
  /** What the day's report pays by, over the shown pages. */
  reportMills: number;
  /** The person worked several shifts that day: the sum is the whole day's («в отчёте за день»). */
  ofDay: boolean;
}

/**
 * What a report day pays by over the shown pages (`page`, or every page): each page from the report handed in in Hub
 * where the day accrues from it (`basis` hub), else from the post; a ledger that does not say the basis — the post,
 * else Hub's. null — neither a post nor Hub's report of those pages (a draft alone is no report yet).
 */
export function reportSumOf(day: Pick<TeamLedgerReportDay, "pages">, page: string | null): number | null {
  const pages = page === null ? day.pages : day.pages.filter((one) => one.pageLabel === page);
  const known = pages
    .map((one) => (one.basis === "hub" ? one.hubMills : one.basis === "post" ? one.postedMills : one.postedMills ?? one.hubMills))
    .filter((value): value is number => value !== null && value !== undefined);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

/**
 * The notes of the shown shifts, by the shift's key: on the last shift of each person-day (a person — every login of
 * theirs, `people`; a day — the day the ledger reports a shift on, `shiftReportDay`) whose report differs from the sum
 * of that day's shown shifts. `ruleFrom` — the first day the screens count by the rule; null — not switched: none.
 */
export function reportNotes(input: {
  shifts: readonly NoteShift[];
  reports: Pick<TeamLedgerReportsResponse, "reports"> | null;
  page: string | null;
  ruleFrom: MoscowDay | null;
  people: PeopleIndex;
}): Map<string, ReportNote> {
  const out = new Map<string, ReportNote>();
  const { reports, ruleFrom, people } = input;
  if (reports === null || ruleFrom === null) return out;
  const keyOf = (personKey: string, date: MoscowDay) => `${personKey}|${date}`;

  const days = new Map<string, { shifts: NoteShift[]; ongoing: boolean }>();
  for (const shift of input.shifts) {
    const date = shiftReportDay(shift.startedAt, shift.endedAt);
    if (date < ruleFrom) continue;
    const key = keyOf(people.keyOf(shift.userId), date);
    const known = days.get(key) ?? { shifts: [], ongoing: false };
    known.shifts.push(shift);
    known.ongoing ||= shift.ongoing;
    days.set(key, known);
  }

  const reported = new Map<string, number>();
  for (const day of reports.reports) {
    const login = day.person.hubUser?.userId;
    if (login === undefined) continue;
    const sum = reportSumOf(day, input.page);
    if (sum === null) continue;
    const key = keyOf(people.keyOf(login), day.reportDate);
    reported.set(key, (reported.get(key) ?? 0) + sum);
  }

  for (const [key, day] of days) {
    const reportMills = reported.get(key);
    if (reportMills === undefined || day.ongoing) continue;
    const ruleMills = day.shifts.reduce((sum, shift) => sum + shift.salesNetMills, 0);
    // To the cent, as both print: a report is in cents, the rule's sales keep their thousandths.
    if (formatMills(reportMills) === formatMills(ruleMills)) continue;
    const last = day.shifts.reduce((latest, shift) => (shift.startedAt > latest.startedAt ? shift : latest));
    out.set(last.key, { reportMills, ofDay: day.shifts.length > 1 });
  }
  return out;
}
