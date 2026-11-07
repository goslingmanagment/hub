/**
 * The layout of the shift ribbon (the console's «Статистика» ribbon, moved here
 * as it was: apps/dashboard/src/pages/account/stats/statsView.ts): the period's
 * days as rows on a 24-hour clock (Moscow) that starts where the person's
 * shifts leave it free, so a shift is one bar in the row of its day — an evening
 * over midnight too — and each sale a bead at its minute. Pure; no React.
 */
import { sumMills, millsToNumber } from "@agency_hub_core/shared";
import { moscowDayOf, moscowDayStart } from "@agency_hub_core/ui/moscow";
import type { PersonShift, PersonVisit, ShiftSale } from "./data.js";

const DAY_MINUTES = 1440;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** The hour marks are this far apart; a row starts on one. */
export const RIBBON_STEP_HOURS = 3;

/** The Moscow day of an instant and its minute in that day. */
function moscowMinute(at: number): { day: string; minute: number } {
  const day = moscowDayOf(at);
  return { day, minute: Math.floor((at - Date.parse(moscowDayStart(day))) / MINUTE_MS) };
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
export function ribbonClock(shifts: ReadonlyArray<Pick<PersonShift, "startedAt" | "endedAt">>): RibbonClock {
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
  return moscowDayOf(rowStart + clock.labelAt * MINUTE_MS);
}

/** The instant a row starts. */
export function ribbonRowStart(day: string, clock: RibbonClock): number {
  const sameDay = clock.startHour * 60 + clock.labelAt < DAY_MINUTES;
  return Date.parse(moscowDayStart(day)) + (clock.startHour - (sameDay ? 0 : 24)) * HOUR_MS;
}

export interface RibbonPiece {
  /** Index into the shifts. */
  shift: number;
  /** Minutes from the row's start, [from, to). */
  from: number;
  to: number;
  pauses: Array<{ from: number; to: number }>;
  /** The piece ends where the shift goes on now. */
  live: boolean;
  /** The piece where the shift begins (its link lives there). */
  first: boolean;
}

export interface RibbonSale extends ShiftSale {
  shift: number;
  minute: number;
}

export interface RibbonDay {
  day: string;
  /** The money of the shifts that begin in the row; null — no shift begins in it. */
  totalMills: number | null;
  pieces: RibbonPiece[];
  visits: Array<{ visit: number; from: number; to: number }>;
  sales: RibbonSale[];
}

/**
 * The rows, the newest first: every day asked for, each a day of the clock from
 * `clock.startHour`, its shifts where they were (one that runs past the row's
 * end goes on in the next row), their sales at their minute, and the visits. A
 * shift going on in a row after the last day — a night begun before midnight —
 * gets that row.
 */
export function ribbonDays(days: readonly string[], shifts: readonly PersonShift[], visits: readonly PersonVisit[], clock: RibbonClock): RibbonDay[] {
  const newRow = (day: string): RibbonDay => ({ day, totalMills: null, pieces: [], visits: [], sales: [] });
  const rows = new Map<string, RibbonDay>(days.map((day) => [day, newRow(day)]));
  const lastDay = [...rows.keys()].sort().at(-1);
  const rowOf = (at: number, live: boolean) => {
    const day = ribbonRowOf(at, clock);
    if (!rows.has(day) && live && lastDay !== undefined && day > lastDay) rows.set(day, newRow(day));
    return rows.get(day);
  };
  const minuteIn = (day: string, at: number) => (at - ribbonRowStart(day, clock)) / MINUTE_MS;

  shifts.forEach((shift, index) => {
    const start = Date.parse(shift.startedAt);
    const end = Math.max(Date.parse(shift.endedAt), start + MINUTE_MS);
    const first = rowOf(start, shift.ongoing);
    if (first !== undefined) first.totalMills = millsToNumber(sumMills([first.totalMills ?? 0, shift.salesNetMills]));
    let begins = true;
    for (let from = start; from < end;) {
      const row = rowOf(from, shift.ongoing);
      const day = ribbonRowOf(from, clock);
      const to = Math.min(end, ribbonRowStart(day, clock) + DAY_MS);
      if (row !== undefined) {
        const pauses = shift.pauses
          .map((pause) => ({ from: Math.max(Date.parse(pause.from), from), to: Math.min(Date.parse(pause.to), to) }))
          .filter((pause) => pause.to > pause.from)
          .map((pause) => ({ from: minuteIn(day, pause.from), to: minuteIn(day, pause.to) }));
        row.pieces.push({ shift: index, from: minuteIn(day, from), to: minuteIn(day, to), pauses, live: shift.ongoing && to === end, first: begins });
      }
      begins = false;
      from = to;
    }
    for (const sale of shift.saleList ?? []) {
      const at = Date.parse(sale.at);
      const day = ribbonRowOf(at, clock);
      rows.get(day)?.sales.push({ ...sale, shift: index, minute: minuteIn(day, at) });
    }
  });
  visits.forEach((visit, index) => {
    const start = Date.parse(visit.startedAt);
    const day = ribbonRowOf(start, clock);
    const from = minuteIn(day, start);
    const to = Math.min(from + Math.max((Date.parse(visit.endedAt) - start) / MINUTE_MS, 1), DAY_MINUTES);
    rows.get(day)?.visits.push({ visit: index, from, to });
  });
  return [...rows.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/** The diameter of a sale's bead, px: its area grows with the money. */
export function beadSize(netMills: number, maxMills: number, density: "roomy" | "medium" | "dense"): number {
  const [low, high] = density === "dense" ? [6, 12] : density === "medium" ? [6, 14] : [7, 18];
  if (maxMills <= 0) return low;
  return low + Math.sqrt(Math.max(0, netMills) / maxMills) * (high - low);
}

/** The part of the clock the ribbon draws, minutes from a row's start: [from, to). */
export interface RibbonView {
  from: number;
  to: number;
}

/** A day of work fits this many hours: then the ribbon draws only them (and an hour around), not the empty night. */
const NARROW_MAX_HOURS = 18;

/**
 * The hours worth drawing (Р4): when every shift and visit lies within
 * 18 hours of the clock, from the whole hour before the first minute (half an
 * hour of air at least) to the whole hour after the last; else the whole day.
 * A shift going on is drawn up to now.
 */
export function ribbonView(rows: readonly RibbonDay[], extra: readonly number[] = []): RibbonView {
  const whole = { from: 0, to: DAY_MINUTES };
  const edges = [
    ...rows.flatMap((row) => row.pieces.flatMap((piece) => [piece.from, piece.to])),
    ...rows.flatMap((row) => row.visits.flatMap((visit) => [visit.from, visit.to])),
    ...extra,
  ];
  if (edges.length === 0) return whole;
  const first = Math.min(...edges);
  const last = Math.max(...edges);
  if (last - first > NARROW_MAX_HOURS * 60) return whole;
  const from = Math.max(0, Math.floor((first - 30) / 60) * 60);
  const to = Math.min(DAY_MINUTES, Math.ceil((last + 30) / 60) * 60);
  return to - from >= DAY_MINUTES - RIBBON_STEP_HOURS * 60 ? whole : { from, to };
}
