/**
 * The layout of the shift ribbon (the console's «Статистика» ribbon, moved here
 * as it was: apps/dashboard/src/pages/account/stats/statsView.ts): the period's
 * days as rows on a 24-hour clock (Moscow) that starts where the person's
 * shifts leave it free, so a shift is one bar in the row of its day — an evening
 * over midnight too — and each sale a bead at its minute. Pure; no React.
 */
import { sumMills, millsToNumber } from "@agency_hub_core/shared";
import { RIBBON_STEP_HOURS, ribbonClock, ribbonRowOf, ribbonRowStart, type RibbonClock } from "@agency_hub_core/ui/ribbon";
import { shiftWhen } from "@agency_hub_core/ui/shiftWhen";
import type { PersonShift, PersonVisit, ShiftSale } from "./data.js";

const DAY_MINUTES = 1440;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// The clock lives in the design system, shared with the console's cabinet.
export { RIBBON_STEP_HOURS, ribbonClock, ribbonRowOf, ribbonRowStart, type RibbonClock };

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
 * The hours worth drawing (Р4): when every shift lies within 18 hours of the
 * clock, from the whole hour before the first minute (half an hour of air at
 * least) to the whole hour after the last; else the whole day. A shift going on
 * is drawn up to now. Work outside a shift does not stretch the hours (27 minutes
 * at noon must not leave a third of the ribbon empty): one beyond the edge is
 * drawn at the edge. Only visits, no shift: their hours.
 */
export function ribbonView(rows: readonly RibbonDay[], extra: readonly number[] = []): RibbonView {
  const whole = { from: 0, to: DAY_MINUTES };
  const pieces = rows.flatMap((row) => row.pieces.flatMap((piece) => [piece.from, piece.to]));
  const edges = [
    ...(pieces.length > 0 ? pieces : rows.flatMap((row) => row.visits.flatMap((visit) => [visit.from, visit.to]))),
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

/**
 * What a row is called (D12): the real dates of the hours it draws. A row of
 * day hours is its day, «сб, 7 нояб.»; a row whose drawn hours cross midnight
 * says both days the way a night shift is said everywhere, «пт, 6–7 нояб.» —
 * never «сб, 7 нояб.» over a bar that begins on Friday evening. The row itself
 * is the day of its hours' middle, the day Hub gives such a shift.
 */
export function ribbonRowLabel(day: string, clock: RibbonClock, view: RibbonView): string {
  const start = ribbonRowStart(day, clock);
  return shiftWhen({ startedAt: start + view.from * MINUTE_MS, endedAt: start + view.to * MINUTE_MS }).days;
}
