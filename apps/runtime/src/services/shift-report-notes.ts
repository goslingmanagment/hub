import {
  SHIFT_REPORT_NOTE_SALES_MAX,
  TEAM_LEDGER_REPORTS_MAX_DAYS,
  type ShiftReportNote,
  type ShiftReportNotesQuery,
  type ShiftReportNotesResponse,
  type TeamLedgerReportDay,
} from "@agency_hub_core/contracts";
import { listMatterPageLabels, listSalePlatformRefs, type Database, type ShiftSale } from "@agency_hub_core/db";
import { formatUsdFromMills } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireSessionUser, type AuthPrincipal } from "./auth.ts";
import { teamReadPages } from "./chatter-shifts.ts";
import { millsOf } from "./ledger-payouts.ts";
import { readTeamLedgerReportsWithBreakdowns } from "./ledger-team-reports.ts";
import { REPORTS_AFTER_DAYS, REPORTS_BEFORE_DAYS, pairReportLines, type PairLine, type PairSale } from "./report-line-pairs.ts";
import { readPeopleLogins, readScreensRule, type PeopleLogins, type ScreensRule } from "./sale-rule-screens.ts";
import { shiftSalesWindow, teamShiftSalesRead } from "./team-shift-sales.ts";

/**
 * «Смены» and «Мои смены»: what stands between a person's shifts of a day and the report that day is paid by
 * (`shiftReportNotes`, contract: packages/contracts routes-shift-report-notes.ts).
 *
 * A shift's money on the screens is the rule's (`teamShiftSales`: sale-rule.ts through `sale_homes`); people are paid
 * by the day's report — the breakdown the chat agent saved to the agency ledger and the post in «Отчётность». The two
 * sums of a person's day differ on most days, and nearly always for one of three reasons: a sale paid in a later
 * report («долёт»), an amount put into the report by the chatter's word, a post changed by hand after the breakdown.
 * The first is nobody's to act on, so no second sum is shown: each line of the person's reports is paired with the
 * sale it pays (report-line-pairs.ts), and a day says only what is left —
 *
 *  - `unreported`: sales of the day's shifts no counted line of ANY of the person's reports of the read pays;
 *  - `byWordsMills`: counted lines of THAT day's report that pay none of the person's sales by the rule;
 *  - `postApartMills`: the day's pay base less its breakdown's counted lines, cents aside;
 *  - `sumOnlyMills`: a day with a pay base and no breakdown — the report's sum where it differs, as before.
 *
 * THE READ. The reports of 2 days before the shown days to 8 days after them (REPORTS_BEFORE_DAYS, REPORTS_AFTER_DAYS:
 * a late sale is paid in a later report, a night's report may be dated a day off the shift); and, the mirror of it,
 * the person's sales by the rule from 8 days before the shown days to 2 after — else a «долёт» of last week in
 * Monday's report would read as money «по словам». The shifts and their sales are `teamShiftSalesRead`'s, the very
 * computation «Смены» shows, for everyone at once: a person's own answer is cut from it, so the owner and the chatter
 * read one note of one day.
 *
 * WHO READS. The owner everyone's days; anyone else their own person's (`readsEveryone`). A person is every login of
 * theirs (the people registry). Computed here because the lines of other people's reports and the references of the
 * sales must not travel to a browser. Read-only: the ledger by GET with Hub's payouts key, nothing is written
 * anywhere. The ledger not answering is a 503: nothing is known of the days then.
 */

/** A report and the rule this close say the same: no sale is this small (half a dollar), cents apart are rounding. */
const ROUNDING_APART_MILLS = 500;

const DAY_MS = 86_400_000;

const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// ── Pure: the days' notes ────────────────────────────────────────────────────

/** A sale of a person's by the rule, as a note reads it. */
export interface NoteSale extends PairSale {
  transactionId: number;
  /** Hub's transaction type. */
  kind: string;
}

/** A shift the rule counts, with the sales it counts. */
export interface NoteShift {
  userId: number;
  /** The Moscow day it is reported on. */
  reportDate: string;
  ongoing: boolean;
  /** Its money by the rule: what the journal's row shows. */
  salesNetMills: number;
  /** The sales it counts, each with its share of the net. */
  sales: readonly NoteSale[];
}

/** A person's report day as the ledger keeps it, cut to the pages asked. */
export interface NoteReportDay {
  /** The Hub login the ledger's person is. */
  userId: number;
  reportDate: string;
  /** What the day pays by (`reportSumOf`); null — neither a post nor a report handed in in Hub. */
  payBaseMills: number | null;
  /** The saved breakdown's lines; null — none saved (a post written by hand, a report handed in in Hub). */
  lines: readonly PairLine[] | null;
}

/** One person's report day with something to say, every sale of it listed. */
export interface PersonDayNote {
  /** Every login of the person, the smallest id first. */
  userIds: number[];
  reportDate: string;
  /** The day's sales no report pays, the oldest first; a sale two of the day's shifts share is one, the parts added. */
  unreported: NoteSale[];
  byWordsMills: number;
  postApartMills: number;
  sumOnlyMills: number | null;
}

/**
 * What a report day pays by over the pages asked (`labels`; null — every page): each page from the report handed in in
 * Hub where the day accrues from it (`basis` hub), else from the post; a ledger that does not say the basis — the post,
 * else Hub's. null — neither a post nor Hub's report of those pages (a draft alone is no report yet). Pure.
 */
export function reportSumOf(day: Pick<TeamLedgerReportDay, "pages">, labels: ReadonlySet<string> | null): number | null {
  const pages = labels === null ? day.pages : day.pages.filter((one) => labels.has(one.pageLabel));
  const known = pages
    .map((one) => (one.basis === "hub" ? one.hubMills : one.basis === "post" ? one.postedMills : one.postedMills ?? one.hubMills))
    .filter((value): value is number => value !== null && value !== undefined);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

const sumKnown = (values: ReadonlyArray<number | null>): number | null => {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
};

/** The same sale twice (two shifts of one person share it) is one sale of theirs, the parts added. */
function addSale(sales: Map<number, NoteSale>, sale: NoteSale): void {
  const known = sales.get(sale.transactionId);
  sales.set(sale.transactionId, known === undefined ? sale : { ...known, netMills: known.netMills + sale.netMills });
}

/**
 * Every person's shown report days with something to say. `shifts` — the ruled shifts of the read: the shown days' and
 * those whose sales the shown days' reports may pay; `withoutShift` — what the rule gives a login's person with no work
 * to hold it (a line may pay it; no shift's day lists it); `reportDays` — the reports of the read. A day says nothing
 * while a shift of it still goes on, and nothing without a report. `only` — that login's person alone. Pure.
 */
export function personDayNotes(input: {
  shifts: readonly NoteShift[];
  withoutShift: ReadonlyArray<{ userId: number; sale: NoteSale }>;
  reportDays: readonly NoteReportDay[];
  logins: Pick<PeopleLogins, "personOf" | "loginsOf">;
  /** The shown Moscow days, both included. */
  from: string;
  to: string;
  only?: number;
}): PersonDayNote[] {
  const { logins } = input;
  const onlyPerson = input.only === undefined ? null : logins.personOf(input.only);
  interface Person { login: number; shifts: NoteShift[]; sales: Map<number, NoteSale>; days: NoteReportDay[] }
  const people = new Map<string, Person>();
  const personOf = (userId: number): Person | null => {
    const key = logins.personOf(userId);
    if (onlyPerson !== null && key !== onlyPerson) return null;
    let person = people.get(key);
    if (person === undefined) {
      person = { login: userId, shifts: [], sales: new Map(), days: [] };
      people.set(key, person);
    }
    return person;
  };
  for (const shift of input.shifts) {
    const person = personOf(shift.userId);
    if (person === null) continue;
    person.shifts.push(shift);
    for (const sale of shift.sales) addSale(person.sales, sale);
  }
  for (const one of input.withoutShift) {
    const person = personOf(one.userId);
    if (person !== null) addSale(person.sales, one.sale);
  }
  for (const day of input.reportDays) personOf(day.userId)?.days.push(day);

  const notes: PersonDayNote[] = [];
  for (const person of people.values()) {
    const shown = [...new Set(person.shifts.map((shift) => shift.reportDate))].filter((date) => date >= input.from && date <= input.to);
    if (shown.length === 0) continue;
    // Every line of the person's reports of the read, the oldest report first: a sale two reports count is paid by the first.
    const days = [...person.days].sort((left, right) => left.reportDate.localeCompare(right.reportDate));
    const pairs = pairReportLines([...person.sales.values()], days.flatMap((day) => day.lines ?? []));
    const unpaid = new Set(pairs.unpaid.map((sale) => sale.transactionId));
    const loose = new Set(pairs.loose);
    const userIds = [...new Set(logins.loginsOf(person.login))].sort((left, right) => left - right);

    for (const reportDate of shown) {
      const shifts = person.shifts.filter((shift) => shift.reportDate === reportDate);
      if (shifts.some((shift) => shift.ongoing)) continue;
      const ofDay = days.filter((day) => day.reportDate === reportDate);
      const withLines = ofDay.filter((day) => day.lines !== null);
      const note: PersonDayNote = { userIds, reportDate, unreported: [], byWordsMills: 0, postApartMills: 0, sumOnlyMills: null };
      if (withLines.length > 0) {
        const missing = new Map<number, NoteSale>();
        for (const shift of shifts) for (const sale of shift.sales) if (unpaid.has(sale.transactionId)) addSale(missing, sale);
        note.unreported = [...missing.values()].sort((left, right) => left.occurredAt - right.occurredAt || left.transactionId - right.transactionId);
        const counted = withLines.flatMap((day) => day.lines ?? []).filter((line) => line.counted);
        note.byWordsMills = counted.filter((line) => loose.has(line)).reduce((sum, line) => sum + line.netMills, 0);
        // The post against the breakdown saved for it. A report adds up lines rounded to the cent while a line keeps its
        // thousandths, so a day of many sales may lie a few cents apart: less than the smallest sale is not a change.
        const base = sumKnown(withLines.map((day) => day.payBaseMills));
        // A post is written in whole cents: the breakdown's sum is read as the post prints it, so a post $44.00 above a
        // breakdown of $421.582 says «+$44.00», not «+$43.99».
        const breakdown = Math.round(counted.reduce((sum, line) => sum + line.netMills, 0) / 10) * 10;
        const apart = base === null ? 0 : base - breakdown;
        note.postApartMills = Math.abs(apart) < ROUNDING_APART_MILLS ? 0 : apart;
      } else {
        // No breakdown to read (a post written by hand, a report handed in in Hub): the report's sum where it is another.
        const base = sumKnown(ofDay.map((day) => day.payBaseMills));
        const rule = shifts.reduce((sum, shift) => sum + shift.salesNetMills, 0);
        if (base !== null && formatUsdFromMills(base) !== formatUsdFromMills(rule) && Math.abs(base - rule) >= ROUNDING_APART_MILLS) note.sumOnlyMills = base;
      }
      if (note.unreported.length > 0 || note.byWordsMills !== 0 || note.postApartMills !== 0 || note.sumOnlyMills !== null) notes.push(note);
    }
  }
  return notes.sort((left, right) => right.reportDate.localeCompare(left.reportDate) || left.userIds[0]! - right.userIds[0]!);
}

/** A day's note as the screens get it: the sums of every sale no report pays, the first of them listed. Never the fan. Pure. */
export function shiftReportNoteOf(day: PersonDayNote): ShiftReportNote {
  return {
    userIds: day.userIds,
    reportDate: day.reportDate,
    unreported: {
      count: day.unreported.length,
      mills: day.unreported.reduce((sum, sale) => sum + sale.netMills, 0),
      sales: day.unreported.slice(0, SHIFT_REPORT_NOTE_SALES_MAX).map((sale) => ({
        saleId: sale.transactionId,
        occurredAt: new Date(sale.occurredAt).toISOString(),
        pageLabel: sale.pageLabel,
        kind: sale.kind,
        netMills: sale.netMills,
      })),
    },
    byWordsMills: day.byWordsMills,
    postApartMills: day.postApartMills,
    sumOnlyMills: day.sumOnlyMills,
  };
}

/** [from, to] in windows of at most `maxDays` Moscow days, the oldest first: the ledger reads no longer one. Pure. */
export function ledgerWindows(from: string, to: string, maxDays: number): Array<{ from: string; to: string }> {
  const windows: Array<{ from: string; to: string }> = [];
  for (let start = from; start <= to; start = addDays(start, maxDays)) {
    const end = addDays(start, maxDays - 1);
    windows.push({ from: start, to: end < to ? end : to });
  }
  return windows;
}

// ── The read ─────────────────────────────────────────────────────────────────

type NotesApp = Pick<AppContext, "db" | "config" | "logger">;

/** What the notes of some shown days are judged from. */
export interface NoteFacts {
  shifts: NoteShift[];
  withoutShift: Array<{ userId: number; sale: NoteSale }>;
  reportDays: NoteReportDay[];
  logins: PeopleLogins;
}

/**
 * The facts behind the notes of the Moscow days [from, to], on `pages`: the ledger's reports of the days around them
 * (first: the ledger away is a 503 before anything of Hub's is computed), then everyone's ruled shifts with their sales.
 * `only` — the logins whose shifts are kept (a chatter's own); absent — everyone's.
 */
export async function readNoteFacts(
  app: NotesApp,
  input: { from: string; to: string; pages: "all" | readonly number[]; rule: ScreensRule; now: Date; only?: (logins: PeopleLogins) => ReadonlySet<number> },
  options: { fetchImpl?: typeof fetch } = {},
): Promise<NoteFacts> {
  const { from, to, pages, rule, now } = input;
  const labels = pages === "all" ? null : await labelsOf(app.db, pages);

  const reportDays: NoteReportDay[] = [];
  for (const window of ledgerWindows(addDays(from, -REPORTS_BEFORE_DAYS), addDays(to, REPORTS_AFTER_DAYS), TEAM_LEDGER_REPORTS_MAX_DAYS)) {
    const { answer, breakdowns } = await readTeamLedgerReportsWithBreakdowns(app, window, { ...options, now });
    for (const day of answer.reports) {
      // As «Выплаты → Отчёты» joins a ledger person to a Hub login; a person no login is of has no shift to stand under.
      const userId = day.person.hubUser?.userId;
      if (userId === undefined) continue;
      const breakdown = breakdowns.get(day.key);
      reportDays.push({
        userId,
        reportDate: day.reportDate,
        payBaseMills: reportSumOf(day, labels),
        lines: breakdown === undefined ? null : breakdown.lines
          .filter((line) => labels === null || labels.has(line.page))
          .map((line) => ({ ref: line.transaction_ref, pageLabel: line.page, netMills: millsOf(line.net_micros), counted: line.counted, what: line.what })),
      });
    }
  }

  // The mirror of the reports' window: a report pays the sales of up to REPORTS_AFTER_DAYS days before its day.
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  const [read, logins] = await Promise.all([
    teamShiftSalesRead(app.db, {
      days: days + REPORTS_AFTER_DAYS + REPORTS_BEFORE_DAYS, until: addDays(to, REPORTS_BEFORE_DAYS), now, pages, rule,
    }),
    readPeopleLogins(app.db),
  ]);
  const only = input.only?.(logins) ?? null;
  const money = read.money.filter((one) => one.current && one.ruled && (only === null || only.has(one.userId)));
  const withoutShift = read.withoutShift.filter((one) => only === null || only.has(one.userId));
  const platformRefs = await listSalePlatformRefs(app.db, [...new Set([
    ...money.flatMap((one) => one.own.map((sale) => sale.transactionId)), ...withoutShift.map((one) => one.sale.transactionId),
  ])]);
  const noteSale = (sale: ShiftSale): NoteSale => ({
    transactionId: sale.transactionId,
    hubRef: String(sale.transactionId),
    platformRef: platformRefs.get(sale.transactionId) ?? null,
    pageLabel: sale.pageLabel,
    netMills: sale.netMills,
    occurredAt: sale.occurredAt.getTime(),
    kind: sale.kind,
  });
  return {
    shifts: money.map((one) => ({
      userId: one.userId, reportDate: one.date, ongoing: one.work.ongoing, salesNetMills: one.salesNetMills, sales: one.own.map(noteSale),
    })),
    withoutShift: withoutShift.map((one) => ({ userId: one.userId, sale: noteSale(one.sale) })),
    reportDays,
    logins,
  };
}

async function labelsOf(db: Database, pageIds: readonly number[]): Promise<Set<string>> {
  const { labelOf } = await listMatterPageLabels(db);
  return new Set(pageIds.map((id) => labelOf.get(id)).filter((label): label is string => label !== undefined));
}

/**
 * Whose days a session reads. People's shift reports from the agency ledger are the owner's alone (`teamLedgerReports`
 * refuses a team lead) and one's own (`accountReports`): so everyone's days for the owner; their own person's days for
 * anyone else, a team lead too — and for a narrow session (the one the extension opens, no password) whatever the
 * role, as every read it may make.
 */
export function readsEveryone(principal: { narrowDeviceTokenId?: number | undefined; user: { role: string } }): boolean {
  return principal.narrowDeviceTokenId === undefined && principal.user.role === "owner";
}

export async function readShiftReportNotes(
  app: AppContext,
  principal: AuthPrincipal,
  input: { query: ShiftReportNotesQuery; pageScope: readonly number[] | undefined },
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<ShiftReportNotesResponse> {
  requireSessionUser(principal);
  const now = options.now ?? new Date();
  const { days, until } = input.query;
  // The window of «Смены» and «Мои смены»: the same days.
  const shown = shiftSalesWindow({ days, now, until }).dates;
  const from = shown[0]!;
  const to = shown.at(-1)!;
  const everyone = readsEveryone(principal);
  // The page asked: 404 and 403 as every team read. Without one, every page: one's own days are read as the owner reads them.
  const pages = await teamReadPages(app, principal, { pageLabel: input.query.pageLabel, pageScope: everyone ? input.pageScope : undefined });
  const rule = await readScreensRule(app.db);
  if (rule === null) return { from, to, ruleFrom: null, notes: [], serverNow: now.toISOString() };

  const userId = principal.user.id;
  const facts = await readNoteFacts(app, {
    from, to, pages, rule, now, ...(everyone ? {} : { only: (logins: PeopleLogins) => new Set(logins.loginsOf(userId)) }),
  }, options.fetchImpl ? { fetchImpl: options.fetchImpl } : {});
  const notes = personDayNotes({ ...facts, from, to, ...(everyone ? {} : { only: userId }) }).map(shiftReportNoteOf);
  return { from, to, ruleFrom: rule.from, notes, serverNow: now.toISOString() };
}
