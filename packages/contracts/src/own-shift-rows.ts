/**
 * Which report is which shift's (products package W): the ONE pairing of a person's own shifts with their reports —
 * Hub's shift (its sales by the rule), the ledger's report (the post in «Отчётность», the agent's draft) and the report
 * handed in in Hub. Pure rules; Hub's server runs them (apps/runtime/src/services/own-shift-rows.ts, `accountShifts`) and
 * every screen reads the paired rows from there — no screen pairs them again (the demo plays the server with them).
 */
import { millsToWholeCents } from "@agency_hub_core/shared";

import type { ChatterStats } from "./chatter-stats.ts";
import type { AccountShiftReport } from "./routes-account-reports.ts";
import type { ShiftReportsListResponse } from "./routes-shift-handins.ts";
import type { OwnShiftRow, OwnShiftRowState } from "./routes-workboard-today.ts";

/** The Moscow `YYYY-MM-DD` of an instant (Moscow has no DST: UTC+3). */
function moscowDayOf(at: number): string {
  return new Date(at + 3 * 3_600_000).toISOString().slice(0, 10);
}

/** The Moscow day holding most of a piece of work (Hub's `dayOfWork`, chatter-shifts.ts): its middle's. */
function dayOfWork(work: { startedAt: number; endedAt: number }): string {
  return moscowDayOf(Math.floor((work.startedAt + work.endedAt - 1) / 2));
}

type StatsShift = ChatterStats["shifts"][number];
type HubShiftReport = ShiftReportsListResponse["shifts"][number];

const DAY_MS = 86_400_000;

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function moscowMidnight(day: string): number {
  return Date.parse(`${day}T00:00:00+03:00`);
}

// ─────────────────────────────────────────────────────────────── The window

export interface OwnShiftsWindow {
  days: number;
  /** The shown Moscow days, both included. */
  from: string;
  to: string;
  /** `[startsAt, endsAt)`, ms. */
  startsAt: number;
  endsAt: number;
  /** The report dates to read: a report is dated by the Moscow day its shift BEGAN, so a night begun the evening before is in. */
  reportsFrom: string;
  reportsTo: string;
  previous: { startsAt: number; endsAt: number; reportsFrom: string; reportsTo: string };
}

/**
 * The window of `days` Moscow days ending on `until` (default today), as `accountChatterStats` reads it
 * (chatter-stats.ts `statsWindow`): a later `until` keeps today inside and lists the days to come empty. Pure.
 */
export function ownShiftsWindow(input: { days: number; until?: string | undefined; now: number }): OwnShiftsWindow {
  const today = moscowDayOf(input.now);
  const latest = addDays(today, input.days - 1);
  const asked = input.until ?? today;
  const to = asked > latest ? latest : asked;
  const from = addDays(to, -(input.days - 1));
  const startsAt = moscowMidnight(from);
  const previousTo = addDays(from, -1);
  return {
    days: input.days,
    from,
    to,
    startsAt,
    endsAt: moscowMidnight(addDays(to, 1)),
    reportsFrom: addDays(from, -1),
    reportsTo: to > today ? today : to,
    previous: {
      startsAt: startsAt - input.days * DAY_MS,
      endsAt: startsAt,
      reportsFrom: addDays(from, -input.days - 1),
      reportsTo: previousTo > today ? today : previousTo,
    },
  };
}

/**
 * The window before, cut at the same point while this one goes on — and at the start of the shift going on, if there
 * is one: its report comes only when it ends, so the same shift of the window before is left out too. Pure.
 */
export function comparisonOf(window: Pick<OwnShiftsWindow, "days" | "previous">, now: number, ongoingStartedAt: string | null): { startsAt: number; endsAt: number; sameTime: boolean } {
  const point = ongoingStartedAt === null ? now : Math.min(now, Date.parse(ongoingStartedAt));
  const endsAt = Math.max(window.previous.startsAt, Math.min(window.previous.endsAt, point - window.days * DAY_MS));
  return { startsAt: window.previous.startsAt, endsAt, sameTime: endsAt < window.previous.endsAt };
}

// ──────────────────────────────────────────────────────────────── The rows

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
 * Whether a report belongs to `[startsAt, endsAt)`: the middle of its window is inside — as Hub puts a shift in a
 * window by the middle of its work. A report without a window (a post written by hand) or an unreadable one: its date.
 */
export function reportInWindow(report: AccountShiftReport, startsAt: number, endsAt: number): boolean {
  const window = windowOf(report);
  if (window === null) {
    const day = moscowMidnight(report.reportDate);
    return day >= startsAt && day < endsAt;
  }
  const middle = Math.floor((window.from + window.to - 1) / 2);
  return middle >= startsAt && middle < endsAt;
}

/** A report's state: posted once the person posted it, else the draft's own word. */
function reportState(report: Pick<AccountShiftReport, "source" | "status">): OwnShiftRowState {
  if (report.source !== "draft") return "posted";
  return report.status === "posted" ? "posted" : report.status === "draft" ? "draft" : "other";
}

/**
 * The draft's total when the person posted another sum; null — the same, not posted, or no draft. A draft is kept in
 * thousandths and a post in cents, so the two totals of a report posted as drafted may differ by a cent of rounding:
 * the ledger compares page by page to the cent, and its word is taken — every page `posted_equal` is the same report.
 */
function changedFrom(report: Pick<AccountShiftReport, "source" | "totalMills" | "draftTotalMills" | "pages">): number | null {
  if (report.source !== "both" || report.draftTotalMills === null) return null;
  if (report.pages.length > 0 && report.pages.every((page) => page.postState === "posted_equal")) return null;
  return millsToWholeCents(report.draftTotalMills) === millsToWholeCents(report.totalMills) ? null : report.draftTotalMills;
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

/**
 * Which report is which shift's. The ledger dates a report by the day its shift BEGAN, while a night's own day is the
 * one holding most of it (`dayOfWork`), so the day alone puts a night's report on the night before. Hence:
 *
 * 1. a report goes to the shift its window ran at the same time with the longest (a tie: the shift with more worked
 *    time) — every pair once, the longest overlaps first;
 * 2. a report that overlaps no free shift (the agent's window is the schedule, the work was at another hour) or has
 *    no window at all (a post written without the agent): the ended shift of the report's date — the one that began
 *    on it, as the ledger dates a report, else the one whose day it is; of several the one with the most worked time;
 * 3. a report that still has no shift is a row of its own, when its window belongs to this one (`reportInWindow`) —
 *    reports of the neighbouring windows, read for their nights, are dropped.
 *
 * `reports` null: they did not come — every shift is a row, states `unknown` (a shift going on stays `ongoing`).
 * `postsRead` false: the drafts came, the posts did not — a shift without a draft may still have a post, so it is
 * `unknown`, never `missing`. Hub's own report (the switch on) is the shift's report: handed in, its total; not yet,
 * the draft's total «предварительно». Newest first, a shift going on first. Pure.
 */
export function pairShiftsWithReports(input: {
  shifts: readonly StatsShift[];
  reports: readonly AccountShiftReport[] | null;
  postsRead?: boolean;
  window: Pick<OwnShiftsWindow, "startsAt" | "endsAt">;
  hub?: ShiftReportsListResponse | null;
}): OwnShiftRow[] {
  const { shifts, reports, window } = input;
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
    // 2. By the day, for what is left: the shift that began on the report's date first, then the one whose day it is.
    reports.forEach((report, reportIndex) => {
      if (placed.has(reportIndex)) return;
      let best: { index: number; began: boolean } | null = null;
      for (const [shiftIndex, shift] of shifts.entries()) {
        if (shift.ongoing || reportOfShift.has(shiftIndex)) continue;
        const span = { startedAt: Date.parse(shift.startedAt), endedAt: Date.parse(shift.endedAt) };
        const began = moscowDayOf(span.startedAt) === report.reportDate;
        if (!began && dayOfWork(span) !== report.reportDate) continue;
        if (best === null || (began && !best.began) || (began === best.began && shift.workedMinutes > shifts[best.index]!.workedMinutes)) best = { index: shiftIndex, began };
      }
      if (best === null) return;
      reportOfShift.set(best.index, report);
      placed.add(reportIndex);
    });
  }

  const rows: Array<{ row: OwnShiftRow; at: number; ongoing: boolean }> = shifts.map((shift, index) => {
    const report = reportOfShift.get(index) ?? null;
    const hub = hubReportOf(shift, input.hub ?? null);
    const base: OwnShiftRow = {
      key: shift.startedAt,
      shift,
      report,
      workedMinutes: shift.workedMinutes,
      ruleMills: shift.salesNetMills,
      totalMills: report?.totalMills ?? null,
      draftMills: report === null ? null : changedFrom(report),
      hubMills: report === null ? shift.salesNetMills : null,
      state: report !== null ? reportState(report) : shift.ongoing ? "ongoing" : missingKnown ? "missing" : "unknown",
      hub,
      preliminary: false,
    };
    const row: OwnShiftRow = hub === null ? base
      : hub.state === "submitted"
        ? { ...base, state: "handed", totalMills: hub.totalMills, draftMills: null, hubMills: null }
        : { ...base, state: shift.ongoing ? "ongoing" : "due", totalMills: hub.draftTotalMills, draftMills: null, hubMills: hub.draftTotalMills === null ? shift.salesNetMills : null, preliminary: hub.draftTotalMills !== null };
    return { row, at: Date.parse(shift.startedAt), ongoing: shift.ongoing };
  });

  // 3. The reports of shifts Hub did not see.
  reports?.forEach((report, reportIndex) => {
    if (placed.has(reportIndex) || !reportInWindow(report, window.startsAt, window.endsAt)) return;
    const own = windowOf(report);
    rows.push({
      row: {
        key: report.id === null ? `post:${report.reportDate}` : `report:${report.id}`,
        shift: null,
        report,
        workedMinutes: null,
        ruleMills: null,
        totalMills: report.totalMills,
        draftMills: changedFrom(report),
        hubMills: null,
        state: reportState(report),
        hub: null,
        preliminary: false,
      },
      at: own?.from ?? moscowMidnight(report.reportDate),
      ongoing: false,
    });
  });

  return rows.sort((a, b) => Number(b.ongoing) - Number(a.ongoing) || b.at - a.at).map((one) => one.row);
}

/**
 * The sum of the report totals of the window before, to compare with; null — nothing to compare with: the reports did
 * not come, or none of that window is in the ledger (the reports began later: unknown, never a zero). Pure.
 */
export function previousReportedMills(reports: readonly AccountShiftReport[] | null, previous: { startsAt: number; endsAt: number }): number | null {
  if (reports === null || previous.endsAt <= previous.startsAt) return null;
  const inside = reports.filter((report) => reportInWindow(report, previous.startsAt, previous.endsAt));
  if (inside.length === 0) return null;
  return inside.reduce((sum, report) => sum + report.totalMills, 0);
}
