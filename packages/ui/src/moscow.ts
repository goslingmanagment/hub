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

/** Days from `from` to `to`, both counted: 2 → 8 Nov is 7. */
export function daysInRange(from: MoscowDay, to: MoscowDay): number {
  const start = parseBusinessDate(from);
  const end = parseBusinessDate(to);
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

/** The instant a Moscow day starts at, as ISO: `2026-11-02` → `2026-11-01T21:00:00.000Z`. */
export function moscowDayStart(day: MoscowDay): string {
  return businessDateToUtcStart(day, MOSCOW_TIME_ZONE).toISOString();
}

/** The instant a Moscow day ends at (the next day's start, excluded). */
export function moscowDayEnd(day: MoscowDay): string {
  return moscowDayStart(addDays(day, 1));
}
