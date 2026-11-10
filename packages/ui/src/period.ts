/**
 * The one period model of Workboard (spec §3): a calendar week Monday–Sunday in
 * Moscow with arrows, the last 14 or 30 days, or a range of one's own. One set of
 * address parameters for the whole app:
 *
 *   ?week=2026-11-02          the week starting that Monday (any day of it is understood)
 *   ?days=14 | ?days=30       the last 14 / 30 days, today included
 *   ?from=2026-10-01&to=2026-10-20   both days included
 *
 * No parameter is the current week. Pure functions, no React: the control, the
 * screens and every drill-down link read the same answer.
 */
import { formatDayRange } from "./format.js";
import { addDays, daysInRange, isMoscowDay, mondayOf, moscowDayEnd, moscowDayStart, type MoscowDay } from "./moscow.js";

export const PERIOD_DAY_OPTIONS = [14, 30] as const;
export type PeriodDays = (typeof PERIOD_DAY_OPTIONS)[number];

/** The longest range of one's own: a year. */
export const PERIOD_MAX_DAYS = 366;

export type PeriodSpec =
  | { kind: "week"; monday: MoscowDay }
  | { kind: "days"; days: PeriodDays }
  | { kind: "range"; from: MoscowDay; to: MoscowDay };

export interface ResolvedPeriod {
  spec: PeriodSpec;
  /** First day, included. */
  from: MoscowDay;
  /** Last day, included. Never after today. */
  to: MoscowDay;
  /** Days covered, both ends included (a week is always 7, even while it goes on). */
  days: number;
  /**
   * Days from `from` to `to`, both included: today at most, so a week going on
   * on a Saturday is 6. What a read counting whole days back from today takes
   * (`teamShiftSales` without `until`).
   */
  shownDays: number;
  /** Today is inside: the numbers still move. */
  current: boolean;
  /** The same number of days right before: what a change is measured against. */
  previous: { from: MoscowDay; to: MoscowDay };
  /** `[startsAt, endsAt)` as instants: Moscow midnight of `from` and of the day after `to`. */
  startsAt: string;
  endsAt: string;
  /** «2–8 нояб.», «28 окт. – 3 нояб.». */
  label: string;
  /** «26 окт. – 1 нояб.». */
  previousLabel: string;
}

const PARAMS = ["week", "days", "from", "to"] as const;

export function currentWeek(today: MoscowDay): PeriodSpec {
  return { kind: "week", monday: mondayOf(today) };
}

function clampRange(from: MoscowDay, to: MoscowDay, today: MoscowDay): { from: MoscowDay; to: MoscowDay } | null {
  const end = to > today ? today : to;
  if (from > end) return null;
  if (daysInRange(from, end) > PERIOD_MAX_DAYS) return { from: addDays(end, -(PERIOD_MAX_DAYS - 1)), to: end };
  return { from, to: end };
}

/** The address's period; anything unreadable is the current week. */
export function parsePeriod(search: URLSearchParams, today: MoscowDay): PeriodSpec {
  const week = search.get("week");
  if (isMoscowDay(week)) {
    const monday = mondayOf(week);
    return monday > today ? currentWeek(today) : { kind: "week", monday };
  }
  const days = Number(search.get("days"));
  if ((PERIOD_DAY_OPTIONS as readonly number[]).includes(days)) return { kind: "days", days: days as PeriodDays };
  const from = search.get("from");
  const to = search.get("to");
  if (isMoscowDay(from) && isMoscowDay(to)) {
    const range = clampRange(from, to, today);
    if (range) return { kind: "range", ...range };
  }
  return currentWeek(today);
}

/** The parameters of a period, always explicit: a link opens the very dates it was made on. */
export function periodParams(spec: PeriodSpec): Record<string, string> {
  switch (spec.kind) {
    case "week":
      return { week: spec.monday };
    case "days":
      return { days: String(spec.days) };
    case "range":
      return { from: spec.from, to: spec.to };
  }
}

/** `search` with the period replaced (the other parameters kept). */
export function withPeriod(search: URLSearchParams, spec: PeriodSpec): URLSearchParams {
  const next = new URLSearchParams(search);
  for (const key of PARAMS) next.delete(key);
  for (const [key, value] of Object.entries(periodParams(spec))) next.set(key, value);
  return next;
}

/** The address names a period itself (any of `week`, `days`, `from`, `to`). */
export function hasPeriodParams(search: URLSearchParams): boolean {
  return PARAMS.some((key) => search.has(key));
}

/** Only the period's parameters of an address: what a drill-down carries. */
export function pickPeriodParams(search: URLSearchParams): URLSearchParams {
  const picked = new URLSearchParams();
  for (const key of PARAMS) {
    const value = search.get(key);
    if (value !== null) picked.set(key, value);
  }
  return picked;
}

export function resolvePeriod(spec: PeriodSpec, today: MoscowDay): ResolvedPeriod {
  let from: MoscowDay;
  let to: MoscowDay;
  switch (spec.kind) {
    case "week":
      from = spec.monday;
      to = addDays(spec.monday, 6);
      break;
    case "days":
      from = addDays(today, -(spec.days - 1));
      to = today;
      break;
    case "range":
      from = spec.from;
      to = spec.to;
      break;
  }
  const days = daysInRange(from, to);
  const shownTo = to > today ? today : to;
  const previous = { from: addDays(from, -days), to: addDays(from, -1) };
  return {
    spec,
    from,
    to: shownTo,
    days,
    shownDays: daysInRange(from, shownTo),
    current: from <= today && to >= today,
    previous,
    startsAt: moscowDayStart(from),
    endsAt: moscowDayEnd(shownTo),
    label: formatDayRange(from, to),
    previousLabel: formatDayRange(previous.from, previous.to),
  };
}

/** One week back or forward; never past the current week. */
export function stepWeek(spec: PeriodSpec, delta: -1 | 1, today: MoscowDay): PeriodSpec {
  const monday = spec.kind === "week" ? spec.monday : mondayOf(today);
  const next = addDays(monday, delta * 7);
  return next > mondayOf(today) ? spec : { kind: "week", monday: next };
}

/** A stretch of whole Moscow days inside a period: one column of a week grid over 14 or 30 days. */
export interface DayChunk {
  from: MoscowDay;
  /** Included. */
  to: MoscowDay;
  days: number;
  /** «27 окт. – 2 нояб.»; one day: «7 нояб.». */
  label: string;
}

/**
 * A period cut in chunks of `size` days (7 by default) back from its last shown
 * day — today at most (spec §3 r2, D4): the last chunk is full, the first holds
 * what is left. 30 days → 2 + 7 + 7 + 7 + 7; 14 days → 7 + 7; a week → one
 * chunk of the days shown so far. Oldest first.
 */
export function periodChunks(period: Pick<ResolvedPeriod, "from" | "to">, size = 7): DayChunk[] {
  const step = Math.max(1, Math.floor(size));
  const chunks: DayChunk[] = [];
  let to = period.to;
  while (to >= period.from) {
    const start = addDays(to, -(step - 1));
    const from = start < period.from ? period.from : start;
    chunks.push({ from, to, days: daysInRange(from, to), label: formatDayRange(from, to) });
    to = addDays(from, -1);
  }
  return chunks.reverse();
}
