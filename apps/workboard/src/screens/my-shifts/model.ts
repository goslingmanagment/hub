/**
 * «Мои смены» — what the screen shows, worked out from two reads; pure, no
 * React (tests/workboard-my-shifts.test.ts). The reads themselves are data.ts.
 *
 * - `accountChatterStats` — the chatter's own shifts as Hub saw them in the
 *   extension: when, worked time, pages, Hub's own sales figure, going on.
 * - `accountReports` — the chatter's own shift reports as the agency ledger
 *   keeps them, one per report date: the agent's draft (the window, the pages,
 *   the sales and why some were held out), the chatter's post in «Отчётность»
 *   (the pages as posted), or both.
 *
 * A shift and its report are one row: the report's one number is the shift's
 * (what the chatter posted, else the draft's total); Hub's figure shows only
 * where there is no report yet. Sales only — nothing here is pay.
 */
import type { AccountShiftReport, ChatterStats, ShiftReportsListResponse } from "@agency_hub_core/contracts";
import { addDays, daysInRange, moscowDayOf, moscowDayStart, type MoscowDay } from "@agency_hub_core/ui/moscow";
import { formatDayRange, formatMills } from "@agency_hub_core/ui/format";
import type { ResolvedPeriod } from "@agency_hub_core/ui/period";
import { shiftWhen, type ShiftWhen } from "@agency_hub_core/ui/shiftWhen";
import { perHourMills } from "../../shared/metrics.js";

export type StatsShift = ChatterStats["shifts"][number];

const DAY_MS = 86_400_000;

/** The longest window `accountChatterStats` reads (Moscow days): a longer own range shows its last days. */
export const MY_SHIFTS_MAX_DAYS = 31;

// ─────────────────────────────────────────────────────────────── The window

export interface MyShiftsWindow {
  /** What `accountChatterStats` is asked for. */
  days: number;
  until: MoscowDay | undefined;
  /** The shown Moscow days, both included (a week's days to come are inside, empty). */
  from: MoscowDay;
  to: MoscowDay;
  /** `[startsAt, endsAt)`, ms: Moscow midnight of `from` and of the day after `to`. */
  startsAt: number;
  endsAt: number;
  /** The period is longer than Hub reads: its last MY_SHIFTS_MAX_DAYS days are shown. */
  clipped: boolean;
  /**
   * The report dates to read. A report is dated by the Moscow day its shift
   * began (the ledger's `report_date`): a night that began the evening before
   * the window's first day is dated the day before.
   */
  reportsFrom: MoscowDay;
  reportsTo: MoscowDay;
  /** The whole window before, of the same length, and its report dates (the comparison cuts it: `comparisonOf`). */
  previous: { startsAt: number; endsAt: number; reportsFrom: MoscowDay; reportsTo: MoscowDay };
}

/** The window of a period of the app (spec §3: week · 14 · 30 · own range), as of `now`. */
export function myShiftsWindow(period: ResolvedPeriod, now: number = Date.now()): MyShiftsWindow {
  const { spec } = period;
  let days: number;
  let until: MoscowDay | undefined;
  let from: MoscowDay;
  let to: MoscowDay;
  let clipped = false;
  if (spec.kind === "week") {
    // The whole calendar week: its days to come are empty.
    days = 7;
    until = addDays(spec.monday, 6);
    from = spec.monday;
    to = until;
  } else if (spec.kind === "days") {
    days = spec.days;
    until = undefined;
    from = period.from;
    to = period.to;
  } else {
    const full = daysInRange(period.from, period.to);
    days = Math.min(full, MY_SHIFTS_MAX_DAYS);
    until = period.to;
    from = addDays(period.to, -(days - 1));
    to = period.to;
    clipped = full > days;
  }
  const startsAt = Date.parse(moscowDayStart(from));
  const endsAt = Date.parse(moscowDayStart(addDays(to, 1)));
  const today = moscowDayOf(now);
  const previousTo = addDays(from, -1);
  return {
    days,
    until,
    from,
    to,
    startsAt,
    endsAt,
    clipped,
    reportsFrom: addDays(from, -1),
    reportsTo: to > today ? today : to,
    previous: {
      startsAt: startsAt - days * DAY_MS,
      endsAt: startsAt,
      reportsFrom: addDays(from, -days - 1),
      reportsTo: previousTo > today ? today : previousTo,
    },
  };
}

/** What the period's reports are compared with: the window before, as far as it is comparable. */
export interface Comparison {
  startsAt: number;
  endsAt: number;
  /** «2–3 нояб.». */
  label: string;
  /** Cut short of its end: «на это же время». */
  sameTime: boolean;
}

/**
 * The window before, cut at the same point while this one goes on («на это же
 * время») — and at the start of the shift going on, if there is one: its report
 * comes only when it ends, so the same shift of the window before is left out
 * too. A window already over is compared with the whole one before it.
 */
export function comparisonOf(window: Pick<MyShiftsWindow, "days" | "previous">, now: number, ongoingStartedAt: string | null): Comparison {
  const point = ongoingStartedAt === null ? now : Math.min(now, Date.parse(ongoingStartedAt));
  const endsAt = Math.max(window.previous.startsAt, Math.min(window.previous.endsAt, point - window.days * DAY_MS));
  return {
    startsAt: window.previous.startsAt,
    endsAt,
    label: formatDayRange(moscowDayOf(window.previous.startsAt), moscowDayOf(Math.max(window.previous.startsAt, endsAt - 1))),
    sameTime: endsAt < window.previous.endsAt,
  };
}

// ──────────────────────────────────────────────────────────────── The rows

/**
 * The state of a row, in words on the screen:
 * - `posted` «Пост отправлен» — the chatter posted it in «Отчётность», with a draft or without (the post's word:
 *   a report handed in in Hub is «Сдан», below);
 * - `draft` «Собран» — check it and send it (the one to act on);
 * - `missing` «Отчёта нет» — the shift ended, and there is neither a draft nor a post (to act on);
 * - `ongoing` «Идёт» — no report while the shift goes on;
 * - `unknown` — the reports did not come (the ledger is away), or the posts did not and the shift has no draft:
 *   nothing is said per row;
 * - `other` — a state the ledger added later, in its own word.
 *
 * With the person's switch «сдаёт смену в системе» on (ecosystem package F), a shift that began after it was
 * turned on is Hub's report, opened by its row: `ongoing` «Идёт» (it may be handed in already), `due` «Сдайте
 * смену», `handed` «Сдан». Rows before the switch keep their post.
 */
export type RowState = "posted" | "draft" | "missing" | "ongoing" | "unknown" | "other" | "due" | "handed";

/** Hub's report of a shift row (`shiftReportsList`). */
export type HubShiftReport = ShiftReportsListResponse["shifts"][number];

export interface MyShiftRow {
  /** The shift's start, or `report:<id>` for a report Hub has no shift for. */
  key: string;
  /** Hub's shift; null — a report whose shift Hub did not see («смена в Hub не найдена»). */
  shift: StatsShift | null;
  /** The shift's report; null — none (yet), or the reports did not come. */
  report: AccountShiftReport | null;
  /** The one label of a shift (D12): the shift's own; a report alone — its window's. */
  when: ShiftWhen;
  /** Where the shift worked (Hub); a report alone — the report's pages. */
  pages: string[];
  /** Hub's worked time; null — a report alone. */
  workedMinutes: number | null;
  /** The shift's one number: the report's (what was posted, else the draft's total); null — no report. */
  totalMills: number | null;
  /** The draft's total where the chatter posted another sum («в черновике было $X»); null — posted as drafted, not posted, or no draft. */
  draftMills: number | null;
  /** Hub's own figure of the shift's sales, shown only where there is no report: null when there is one. */
  hubMills: number | null;
  state: RowState;
  /** The shift's report in Hub (the switch on, a shift after it): the row opens it. Null — the old way. */
  hub: HubShiftReport | null;
  /** `totalMills` is a draft's, not handed in yet: said «предварительно». */
  preliminary: boolean;
}

/** A draft's window; null — a post written without the agent (no window), or one that cannot be read. */
function windowOf(report: Pick<AccountShiftReport, "windowFrom" | "windowTo">): { from: number; to: number } | null {
  if (report.windowFrom === null || report.windowTo === null) return null;
  const from = Date.parse(report.windowFrom);
  const to = Date.parse(report.windowTo);
  return Number.isNaN(from) || Number.isNaN(to) || to <= from ? null : { from, to };
}

/** How long a report's window and a shift ran at the same time, ms. */
function overlapOf(report: AccountShiftReport, shift: StatsShift): number {
  const window = windowOf(report);
  if (window === null) return 0;
  return Math.max(0, Math.min(window.to, Date.parse(shift.endedAt)) - Math.max(window.from, Date.parse(shift.startedAt)));
}

/**
 * Whether a report belongs to `[startsAt, endsAt)`: the middle of its window is
 * inside — as Hub puts a shift in a window by the middle of its work. A report
 * without a window (a post written by hand) or an unreadable one: its date.
 */
export function reportInWindow(report: AccountShiftReport, startsAt: number, endsAt: number): boolean {
  const window = windowOf(report);
  if (window === null) {
    const day = Date.parse(moscowDayStart(report.reportDate));
    return day >= startsAt && day < endsAt;
  }
  const middle = Math.floor((window.from + window.to - 1) / 2);
  return middle >= startsAt && middle < endsAt;
}

/**
 * Which report is which shift's. The ledger dates a report by the day its shift
 * BEGAN, while a night's own day is the one holding most of it (`shiftWhen`'s
 * pay day), so the day alone puts a night's report on the night before. Hence:
 *
 * 1. a report goes to the shift its window ran at the same time with the
 *    longest (a tie: the shift with more worked time) — every pair once,
 *    the longest overlaps first;
 * 2. a report that overlaps no free shift (the agent's window is the schedule,
 *    the work was at another hour) or has no window at all (a post written
 *    without the agent): the ended shift of the report's date — the one that
 *    began on it, as the ledger dates a report, else the one whose pay day it
 *    is; of several the one with the most worked time;
 * 3. a report that still has no shift is a row of its own, when its window
 *    belongs to this one (`reportInWindow`) — reports of the neighbouring
 *    windows, read for their nights, are dropped.
 *
 * `reports` null: they did not come — every shift is a row, states `unknown`
 * (a shift going on stays «Идёт»). `postsRead` false: the drafts came, the posts
 * did not — a shift without a draft may still have a post, so it is `unknown`,
 * never «Отчёта нет». Newest first, a shift going on first.
 */
export function joinShifts(input: {
  shifts: readonly StatsShift[];
  reports: readonly AccountShiftReport[] | null;
  postsRead?: boolean;
  window: Pick<MyShiftsWindow, "startsAt" | "endsAt">;
  /** Hub's shift reports (`shiftReportsList`); null or switched off — none. */
  hub?: ShiftReportsListResponse | null;
}): MyShiftRow[] {
  const { shifts, reports, window } = input;
  // «Отчёта нет» only when both the drafts and the posts came: else a shift without one may still have a post.
  const missingKnown = reports !== null && input.postsRead !== false;
  const reportOfShift = new Map<number, AccountShiftReport>();
  const placed = new Set<number>();

  if (reports !== null) {
    // 1. The longest overlaps first.
    const pairs: Array<{ shift: number; report: number; overlap: number }> = [];
    shifts.forEach((shift, shiftIndex) => {
      reports.forEach((report, reportIndex) => {
        const overlap = overlapOf(report, shift);
        if (overlap > 0) pairs.push({ shift: shiftIndex, report: reportIndex, overlap });
      });
    });
    pairs.sort((a, b) => b.overlap - a.overlap || shifts[b.shift]!.workedMinutes - shifts[a.shift]!.workedMinutes);
    for (const pair of pairs) {
      if (reportOfShift.has(pair.shift) || placed.has(pair.report)) continue;
      reportOfShift.set(pair.shift, reports[pair.report]!);
      placed.add(pair.report);
    }
    // 2. By the day, for what is left: the shift that began on the report's date first, then the one whose pay day it is.
    reports.forEach((report, reportIndex) => {
      if (placed.has(reportIndex)) return;
      let best: { index: number; began: boolean } | null = null;
      for (const [shiftIndex, shift] of shifts.entries()) {
        if (shift.ongoing || reportOfShift.has(shiftIndex)) continue;
        const when = shiftWhen(shift);
        const began = when.firstDay === report.reportDate;
        if (!began && when.payDay !== report.reportDate) continue;
        if (best === null || (began && !best.began) || (began === best.began && shift.workedMinutes > shifts[best.index]!.workedMinutes)) best = { index: shiftIndex, began };
      }
      if (best === null) return;
      reportOfShift.set(best.index, report);
      placed.add(reportIndex);
    });
  }

  const rows: Array<{ row: MyShiftRow; at: number; ongoing: boolean }> = shifts.map((shift, index) => {
    const report = reportOfShift.get(index) ?? null;
    const hub = hubReportOf(shift, input.hub ?? null);
    const base: MyShiftRow = {
      key: shift.startedAt,
      shift,
      report,
      when: shiftWhen({ startedAt: shift.startedAt, endedAt: shift.endedAt, ongoing: shift.ongoing, workedMinutes: shift.workedMinutes }),
      pages: shift.pages,
      workedMinutes: shift.workedMinutes,
      totalMills: report?.totalMills ?? null,
      draftMills: report === null ? null : changedFrom(report),
      hubMills: report === null ? shift.salesNetMills : null,
      state: report !== null ? reportState(report) : shift.ongoing ? "ongoing" : missingKnown ? "missing" : "unknown",
      hub,
      preliminary: false,
    };
    // Hub's report is the shift's report, one number from one service: handed in, its total; not yet, the draft's
    // total «предварительно», and «Сдайте смену» (or «Идёт»).
    const row: MyShiftRow = hub === null ? base
      : hub.state === "submitted"
        ? { ...base, state: "handed", totalMills: hub.totalMills, draftMills: null, hubMills: null }
        : { ...base, state: shift.ongoing ? "ongoing" : "due", totalMills: hub.draftTotalMills, draftMills: null, hubMills: hub.draftTotalMills === null ? shift.salesNetMills : null, preliminary: hub.draftTotalMills !== null };
    return { row, at: Date.parse(shift.startedAt), ongoing: shift.ongoing };
  });

  // 3. The reports of shifts Hub did not see.
  reports?.forEach((report, reportIndex) => {
    if (placed.has(reportIndex) || !reportInWindow(report, window.startsAt, window.endsAt)) return;
    const own = windowOf(report);
    const day = moscowDayStart(report.reportDate);
    rows.push({
      row: {
        key: report.id === null ? `post:${report.reportDate}` : `report:${report.id}`,
        shift: null,
        report,
        when: own === null ? dayOnly(day) : shiftWhen({ startedAt: own.from, endedAt: own.to }),
        pages: report.pages.map((page) => page.pageLabel),
        workedMinutes: null,
        totalMills: report.totalMills,
        draftMills: changedFrom(report),
        hubMills: null,
        state: reportState(report),
        hub: null,
        preliminary: false,
      },
      at: own?.from ?? Date.parse(day),
      ongoing: false,
    });
  });

  return rows.sort((a, b) => Number(b.ongoing) - Number(a.ongoing) || b.at - a.at).map((one) => one.row);
}

/**
 * Hub's report row of a shift, when the person's switch is on and the shift began after it: the row of the same
 * shift that ran with it the longest. Null — the old way. Pure.
 */
export function hubReportOf(shift: Pick<StatsShift, "startedAt" | "endedAt">, hub: ShiftReportsListResponse | null): HubShiftReport | null {
  if (hub === null || !hub.enabled || hub.enabledSince === null) return null;
  const since = Date.parse(hub.enabledSince);
  const from = Date.parse(shift.startedAt);
  const to = Math.max(from + 1, Date.parse(shift.endedAt));
  let best: { row: HubShiftReport; overlap: number } | null = null;
  for (const row of hub.shifts) {
    if (Date.parse(row.startedAt) < since) continue;
    const overlap = Math.min(to, Math.max(Date.parse(row.startedAt) + 1, Date.parse(row.endedAt))) - Math.max(from, Date.parse(row.startedAt));
    if (overlap > 0 && (best === null || overlap > best.overlap)) best = { row, overlap };
  }
  return best?.row ?? null;
}

/** A report's state: posted once the chatter posted it, else the draft's own word. */
function reportState(report: Pick<AccountShiftReport, "source" | "status">): RowState {
  if (report.source !== "draft") return "posted";
  return report.status === "posted" ? "posted" : report.status === "draft" ? "draft" : "other";
}

/**
 * The draft's total when the chatter posted another sum; null — the same, not posted, or no draft. A draft is kept in
 * thousandths and a post in cents, so the two totals of a report posted as drafted may differ by a cent of rounding:
 * the ledger compares page by page to the cent, and its word is taken — every page `posted_equal` is the same report.
 * Whatever the pages say, a draft that reads as the same sum is never shown as another one.
 */
function changedFrom(report: Pick<AccountShiftReport, "source" | "totalMills" | "draftTotalMills" | "pages">): number | null {
  if (report.source !== "both" || report.draftTotalMills === null) return null;
  if (report.pages.length > 0 && report.pages.every((page) => page.postState === "posted_equal")) return null;
  return formatMills(report.draftTotalMills) === formatMills(report.totalMills) ? null : report.draftTotalMills;
}

/** The label of a report Hub has no shift for and that has no window (a post written by hand): its day alone. */
function dayOnly(dayStart: string): ShiftWhen {
  const when = shiftWhen({ startedAt: dayStart, endedAt: dayStart });
  return { ...when, time: UNKNOWN_TIME, label: `${when.days}, ${UNKNOWN_TIME}` };
}

/** The clock of a shift nobody knows the hours of. */
export const UNKNOWN_TIME = "время смены не известно";

// ─────────────────────────────────────────────────────────────── The facts

export interface MyShiftsFacts {
  /** Rows: Hub's shifts and the reports Hub has no shift for. */
  shifts: number;
  /** Hub's worked time of the shifts, pauses left out. */
  workedMinutes: number;
  /** The sum of the reports' one numbers (what was posted, else the draft's total); null — the reports or the posts did not come. */
  reportedMills: number | null;
  /** The report totals of shifts with a report over their worked time; null — no such shift. */
  perHourMills: number | null;
  /** Ended shifts with neither a draft nor a post: the one thing to act on. 0 while the reports or the posts are unknown. */
  withoutReport: number;
  /** Reports to check and send («Собран»). */
  drafts: number;
}

export function factsOf(rows: readonly MyShiftRow[], reportsKnown: boolean): MyShiftsFacts {
  let workedMinutes = 0;
  let reportedMills = 0;
  let pairedMills = 0;
  let pairedMinutes = 0;
  for (const row of rows) {
    workedMinutes += row.workedMinutes ?? 0;
    reportedMills += row.totalMills ?? 0;
    if (row.shift !== null && row.report !== null) {
      pairedMills += row.report.totalMills;
      pairedMinutes += row.shift.workedMinutes;
    }
  }
  return {
    shifts: rows.length,
    workedMinutes,
    reportedMills: reportsKnown ? reportedMills : null,
    perHourMills: reportsKnown ? perHourMills(pairedMills, pairedMinutes) : null,
    withoutReport: rows.filter((row) => row.state === "missing").length,
    drafts: rows.filter((row) => row.state === "draft").length,
  };
}

/**
 * The sum of the report totals of the window before (`comparisonOf`), to
 * compare with; null — nothing to compare with: the reports did not come, or
 * none of that window is in the ledger (the reports began later: unknown, never
 * a zero).
 */
export function previousReportedMills(reports: readonly AccountShiftReport[] | null, previous: Pick<Comparison, "startsAt" | "endsAt">): number | null {
  if (reports === null || previous.endsAt <= previous.startsAt) return null;
  const inside = reports.filter((report) => reportInWindow(report, previous.startsAt, previous.endsAt));
  if (inside.length === 0) return null;
  return inside.reduce((sum, report) => sum + report.totalMills, 0);
}
