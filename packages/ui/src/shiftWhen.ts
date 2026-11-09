import { formatDayRange, formatDuration, formatTimeOfDay, formatWeekdayDay } from "./format.js";
import { moscowDayOf, type MoscowDay } from "./moscow.js";

/**
 * One label and one day of a shift for every screen (spec r3, D12): the journal,
 * the week grid, the person's card and ribbon, the review's header, the payouts
 * and every hint say a shift the same way and put it on the same day.
 *
 * - The DAY of a shift is the Moscow day holding most of it — Hub's `dayOfWork`
 *   (apps/runtime/src/services/chatter-shifts.ts: the middle of the work), the
 *   day the payout sheet gives it (shift-report.ts `payDay`). A night entered at
 *   23:54 and one entered at 00:08 are one day.
 * - The LABEL says when it really ran: the start's weekday, the dates it touched,
 *   the clock: «пт, 6 нояб. 09:16–18:53», a night «вс, 1–2 нояб. 21:00–05:49»,
 *   going on «сб, 7 нояб. 18:02 – сейчас».
 * - Its DURATION is the time worked, pauses left out: «9 ч 1 мин». The span with
 *   the pauses is only ever a hint: «9 ч 46 мин с паузами».
 *
 *   import { shiftWhen } from "@agency_hub_core/ui/shiftWhen";
 *   const when = shiftWhen(shift);           // { startedAt, endedAt, ongoing?, workedMinutes? }
 *   when.label    «вс, 1–2 нояб. 21:00–05:49»
 *   when.payDay   "2026-11-02"               the grid's column, the payout sheet's day
 *   when.worked   «8 ч 21 мин»
 */

export interface ShiftSpanLike {
  /** ISO instant, ms or Date. */
  startedAt: string | number | Date;
  /** The end; for a shift going on, the last minute Hub saw (≈ now). */
  endedAt: string | number | Date;
  /** Still going: the end reads «сейчас». */
  ongoing?: boolean;
  /** Minutes worked, pauses left out (Hub's `workedMinutes`). Without it there is no duration. */
  workedMinutes?: number | null;
}

export interface ShiftWhen {
  /** The Moscow day holding most of the shift (Hub's `dayOfWork`): its column in the grid, its day in the payout sheet. */
  payDay: MoscowDay;
  /** The Moscow day it began on. */
  firstDay: MoscowDay;
  /** The Moscow day it ended on; the day of its last minute so far while it goes on. */
  lastDay: MoscowDay;
  /** It ran over midnight. */
  overnight: boolean;
  /** «пт, 6 нояб.»; a night «вс, 1–2 нояб.»; over a month's end «пт, 31 окт. – 1 нояб.». The weekday is the start's. */
  days: string;
  /** «09:16–18:53»; a night alike «21:00–05:49»; going on «18:02 – сейчас». */
  time: string;
  /** The one label: `${days} ${time}` — «вс, 1–2 нояб. 21:00–05:49». */
  label: string;
  /** Time worked, pauses left out: «9 ч 1 мин». null without `workedMinutes`. */
  worked: string | null;
  /** The span with its pauses, only when they make it longer: «9 ч 46 мин с паузами» — for a hint, never as the duration. */
  withPauses: string | null;
  /** Minutes from the start to the end, pauses included. */
  spanMinutes: number;
  /**
   * A night's day in words, for a cell's or a row's hint: «Ночь с вс на пн: в сетке и в выплатах — пн, 2 нояб., где
   * большая часть смены.» null for a shift within one day.
   */
  payDayNote: string | null;
}

const MINUTE_MS = 60_000;
const WEEKDAY = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "Europe/Moscow" });

function msOf(value: string | number | Date): number {
  return value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
}

/** «вс» of a Moscow day. */
function weekdayOf(day: MoscowDay): string {
  return WEEKDAY.format(new Date(`${day}T12:00:00+03:00`));
}

/**
 * The day a shift belongs to: the Moscow day of the middle of its span — Hub's
 * `dayOfWork` (`middleOfWork` = ⌊(start + end − 1) / 2⌋; a tie goes to the day it
 * began). The grid, the payouts and the ribbon put a shift here; the demo too.
 */
export function shiftPayDay(shift: Pick<ShiftSpanLike, "startedAt" | "endedAt">): MoscowDay {
  const start = msOf(shift.startedAt);
  const end = msOf(shift.endedAt);
  return moscowDayOf(end > start ? Math.floor((start + end - 1) / 2) : start);
}

/** The label, the day and the duration of a shift (D12): see the module's comment. */
export function shiftWhen(shift: ShiftSpanLike): ShiftWhen {
  const start = msOf(shift.startedAt);
  const end = Math.max(start, msOf(shift.endedAt));
  const ongoing = shift.ongoing === true;
  const firstDay = moscowDayOf(start);
  // The end is exclusive: a shift to 00:00 sharp ended on the day before.
  const lastDay = end > start ? moscowDayOf(end - 1) : firstDay;
  const overnight = lastDay !== firstDay;
  const payDay = shiftPayDay({ startedAt: start, endedAt: end });
  const days = overnight ? `${weekdayOf(firstDay)}, ${formatDayRange(firstDay, lastDay)}` : formatWeekdayDay(firstDay);
  const time = ongoing ? `${formatTimeOfDay(start)} – сейчас` : `${formatTimeOfDay(start)}–${formatTimeOfDay(end)}`;
  const spanMinutes = Math.round((end - start) / MINUTE_MS);
  const workedMinutes = shift.workedMinutes ?? null;
  const worked = workedMinutes === null ? null : formatDuration(Math.max(0, Math.round(workedMinutes)));
  const withPauses = workedMinutes !== null && spanMinutes - workedMinutes >= 1 ? `${formatDuration(spanMinutes)} с паузами` : null;
  const payDayNote = overnight
    ? `Ночь с ${weekdayOf(firstDay)} на ${weekdayOf(lastDay)}: в сетке и в выплатах — ${formatWeekdayDay(payDay)}, где большая часть смены.`
    : null;
  return { payDay, firstDay, lastDay, overnight, days, time, label: `${days} ${time}`, worked, withPauses, spanMinutes, payDayNote };
}

/** «8 ч 21 мин работы · 9 ч 46 мин с паузами»: the duration with its pauses, for a hint. */
export function shiftDurationHint(when: Pick<ShiftWhen, "worked" | "withPauses">): string | null {
  if (when.worked === null) return null;
  return when.withPauses === null ? `${when.worked} работы` : `${when.worked} работы, ${when.withPauses}`;
}
