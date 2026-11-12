/**
 * Moscow days. The agency's day is Moscow midnight to midnight: the shifts, the
 * payout sheet and every money-by-day number in Hub are cut on it. A day here is
 * a calendar date, `YYYY-MM-DD`, and its arithmetic never goes through the
 * browser's own time zone.
 */
import {
  MOSCOW_TIME_ZONE,
  businessDateToUtcStart,
  isValidBusinessDateString,
  parseBusinessDate,
  toBusinessDate,
} from "@agency_hub_core/shared";

export { MOSCOW_TIME_ZONE };

/** A calendar date in Moscow: `YYYY-MM-DD`. */
export type MoscowDay = string;

export function isMoscowDay(value: string | null | undefined): value is MoscowDay {
  return typeof value === "string" && isValidBusinessDateString(value);
}

/** Today in Moscow. */
export function moscowToday(now: Date = new Date()): MoscowDay {
  return toBusinessDate(now, MOSCOW_TIME_ZONE);
}

/** The Moscow day an instant falls on. */
export function moscowDayOf(at: string | number | Date): MoscowDay {
  return toBusinessDate(new Date(at), MOSCOW_TIME_ZONE);
}

/** The day `days` after (or before, negative) a day. */
export function addDays(day: MoscowDay, days: number): MoscowDay {
  const { year, month, day: date } = parseBusinessDate(day);
  const shifted = new Date(Date.UTC(year, month - 1, date + days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * Days from `from` to `to`, both counted: 2 → 8 Nov is 7. With `until` (today),
 * `to` stops there: a week going on, on its Saturday, is 6 days so far; a range
 * that has not begun by `until` is 0.
 */
export function daysInRange(from: MoscowDay, to: MoscowDay, until?: MoscowDay): number {
  const last = until !== undefined && to > until ? until : to;
  if (until !== undefined && from > last) return 0;
  const start = parseBusinessDate(from);
  const end = parseBusinessDate(last);
  const span = Date.UTC(end.year, end.month - 1, end.day) - Date.UTC(start.year, start.month - 1, start.day);
  return Math.round(span / 86_400_000) + 1;
}

/** 0 for Monday … 6 for Sunday: a Moscow week starts on Monday. */
export function weekdayIndex(day: MoscowDay): number {
  const { year, month, day: date } = parseBusinessDate(day);
  return (new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7;
}

/** The Monday of the week a day belongs to. */
export function mondayOf(day: MoscowDay): MoscowDay {
  return addDays(day, -weekdayIndex(day));
}

const DAY_MS = 86_400_000;
const TWO_HOURS_MS = 2 * 3_600_000;
/** Moscow keeps UTC+3 all year (no summer time since 2014): the shifts' hot paths count on it without a formatter. */
const MOSCOW_OFFSET_MS = 3 * 3_600_000;

/**
 * The Moscow day a shift is reported on and paid by — the ledger's `ReportDate` (internal/payroll/source.go), the one
 * day every system puts a shift's report on: the day it starts, except that a shift starting within two hours before
 * midnight that mostly lies in the next day belongs to the next day (a night entered at 23:54 is the morning's).
 */
export function shiftReportDay(startedAt: string | number | Date, endedAt: string | number | Date): MoscowDay {
  const start = typeof startedAt === "number" ? startedAt : new Date(startedAt).getTime();
  const end = typeof endedAt === "number" ? endedAt : new Date(endedAt).getTime();
  const local = start + MOSCOW_OFFSET_MS;
  // The instant of the Moscow midnight after the start.
  const midnight = local - (((local % DAY_MS) + DAY_MS) % DAY_MS) + DAY_MS - MOSCOW_OFFSET_MS;
  const before = midnight - start;
  const reported = before <= TWO_HOURS_MS && end > midnight && end - midnight > before ? midnight : start;
  return new Date(reported + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant a Moscow day starts at, as ISO: `2026-11-02` → `2026-11-01T21:00:00.000Z`. */
export function moscowDayStart(day: MoscowDay): string {
  return businessDateToUtcStart(day, MOSCOW_TIME_ZONE).toISOString();
}

/** The instant a Moscow day ends at (the next day's start, excluded). */
export function moscowDayEnd(day: MoscowDay): string {
  return moscowDayStart(addDays(day, 1));
}
