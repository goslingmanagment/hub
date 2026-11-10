/**
 * The shift ribbon's clock, for the chatter's cabinet (the console's «Статистика»)
 * and Workboard's person card: the period's days as rows on a 24-hour clock
 * (Moscow) that starts where the person's shifts leave it free, so a shift is
 * one bar in the row of its day — an evening over midnight too. Pure; no React.
 */
const DAY_MINUTES = 1440;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Moscow has no DST: UTC+3. Plain arithmetic, no `Intl`: the ribbon asks this for every sale of the period. */
const MSK_OFFSET_MS = 3 * HOUR_MS;
/** The hour marks are this far apart; a row starts on one. */
export const RIBBON_STEP_HOURS = 3;

/** The Moscow day (`YYYY-MM-DD`) of an instant and its minute in that day. */
function moscowMinute(at: number): { day: string; minute: number } {
  const shifted = at + MSK_OFFSET_MS;
  const day = new Date(shifted).toISOString().slice(0, 10);
  const midnight = Date.parse(`${day}T00:00:00Z`);
  return { day, minute: Math.floor((shifted - midnight) / MINUTE_MS) };
}

/** The start of a Moscow day, as an instant. */
function moscowMidnight(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) - MSK_OFFSET_MS;
}

/** Where a row of the clock starts, and which day names a row. */
export interface RibbonClock {
  /** The Moscow hour the rows start at. */
  startHour: number;
  /** Minutes from a row's start to the moment whose Moscow day names the row: the middle of the working hours. */
  labelAt: number;
}

/**
 * The clock for these shifts: the rows start in the middle of the longest
 * stretch no shift touches — on an hour mark if that is free too — so a shift
 * lies whole in a row; a row is named by the day of its working hours' middle,
 * the day a shift belongs to. No shifts: midnight to midnight.
 */
export function ribbonClock(shifts: ReadonlyArray<{ startedAt: string; endedAt: string }>): RibbonClock {
  const plain = { startHour: 0, labelAt: DAY_MINUTES / 2 };
  if (shifts.length === 0) return plain;
  const taken = new Array<boolean>(DAY_MINUTES).fill(false);
  for (const shift of shifts) {
    const start = moscowMinute(Date.parse(shift.startedAt)).minute;
    const length = Math.min(Math.ceil((Date.parse(shift.endedAt) - Date.parse(shift.startedAt)) / MINUTE_MS), DAY_MINUTES);
    for (let minute = 0; minute < length; minute += 1) taken[(start + minute) % DAY_MINUTES] = true;
  }
  let best = { from: 0, length: 0 };
  // Twice round the clock, so a free stretch over midnight counts whole.
  let run = 0;
  for (let minute = 0; minute < 2 * DAY_MINUTES; minute += 1) {
    run = taken[minute % DAY_MINUTES] ? 0 : Math.min(run + 1, DAY_MINUTES);
    if (run > best.length) best = { from: minute - run + 1, length: run };
  }
  if (best.length === 0) return plain;
  const freeMiddle = (best.from + best.length / 2) % DAY_MINUTES;
  const onMark = (Math.round(freeMiddle / 60 / RIBBON_STEP_HOURS) * RIBBON_STEP_HOURS) % 24;
  const startHour = taken[onMark * 60] ? Math.round(freeMiddle / 60) % 24 : onMark;
  const busyMiddle = (freeMiddle + DAY_MINUTES / 2) % DAY_MINUTES;
  return { startHour, labelAt: Math.floor((busyMiddle - startHour * 60 + DAY_MINUTES) % DAY_MINUTES) };
}

/** The row an instant falls in. */
export function ribbonRowOf(at: number, clock: RibbonClock): string {
  const intoRow = (moscowMinute(at).minute - clock.startHour * 60 + DAY_MINUTES) % DAY_MINUTES;
  const rowStart = Math.floor(at / MINUTE_MS) * MINUTE_MS - intoRow * MINUTE_MS;
  return moscowMinute(rowStart + clock.labelAt * MINUTE_MS).day;
}

/** The instant a row starts. */
export function ribbonRowStart(day: string, clock: RibbonClock): number {
  const sameDay = clock.startHour * 60 + clock.labelAt < DAY_MINUTES;
  return moscowMidnight(day) + (clock.startHour - (sameDay ? 0 : 24)) * HOUR_MS;
}
