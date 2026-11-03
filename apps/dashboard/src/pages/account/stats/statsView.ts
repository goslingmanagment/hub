import type { ChatterSaleKind, ChatterStats } from "@agency_hub_core/contracts";

// Pure helpers of the cabinet's «Статистика»: words, numbers and the layout
// of the shift ribbon. No React here.

export type Stats = ChatterStats;
export type StatsShift = Stats["shifts"][number];
export type StatsSale = StatsShift["sales"][number];
export type StatsVisit = Stats["visits"][number];

/** The kinds of a sale in their fixed order and hue (the validated chart order: blue · orange · aqua · violet). */
export const KINDS: ReadonlyArray<{ key: ChatterSaleKind; label: string; color: string }> = [
  { key: "ppv", label: "PPV", color: "var(--color-chart-blue)" },
  { key: "tip", label: "Чаевые", color: "var(--color-chart-orange)" },
  { key: "subscription", label: "Подписки", color: "var(--color-chart-aqua)" },
  { key: "post", label: "Посты", color: "var(--color-chart-violet)" },
];

export const KIND_LABEL: Readonly<Record<ChatterSaleKind, string>> = { ppv: "PPV", tip: "Чаевые", subscription: "Подписка", post: "Пост" };
export const KIND_COLOR: Readonly<Record<ChatterSaleKind, string>> = Object.fromEntries(KINDS.map((kind) => [kind.key, kind.color])) as Record<ChatterSaleKind, string>;

export const PRICE_LABELS: Readonly<Record<string, string>> = {
  upTo10: "до $10",
  "10to25": "$10–25",
  "25to50": "$25–50",
  "50to100": "$50–100",
  over100: "от $100",
};

/** The price bucket inside a sentence: «Лучше всего покупают PPV до $10». */
export const PRICE_PHRASES: Readonly<Record<string, string>> = {
  upTo10: "PPV до $10",
  "10to25": "PPV за $10–25",
  "25to50": "PPV за $25–50",
  "50to100": "PPV за $50–100",
  over100: "PPV от $100",
};

export const DELAY_LABELS: Readonly<Record<string, string>> = {
  under5m: "до 5 мин",
  "5to15m": "5–15 мин",
  "15to60m": "15–60 мин",
  "1to6h": "1–6 ч",
  over6h: "больше 6 ч",
};

export const PERIODS = [
  { days: 7, label: "7 дней" },
  { days: 14, label: "14 дней" },
  { days: 30, label: "30 дней" },
] as const;

const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdCents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const countFormat = new Intl.NumberFormat("ru-RU");

/** Whole dollars: `$3,699` (Intl rounds the cents). */
export function money(mills: number): string {
  return usdWhole.format(mills / 1000);
}

/** To the cent: `$45.60`. */
export function moneyExact(mills: number): string {
  return usdCents.format(mills / 1000);
}

export function count(value: number): string {
  return countFormat.format(value);
}

/** `65 ч 36 мин`, `45 мин`, `8 ч`. */
export function duration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} мин`;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/** `part / whole`, null without a whole. */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

export function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

/** The Russian plural of a count: plural(5, ["смена", "смены", "смен"]). */
export function plural(value: number, forms: readonly [string, string, string]): string {
  const tens = value % 100;
  const ones = value % 10;
  if (tens >= 11 && tens <= 14) return forms[2];
  if (ones === 1) return forms[0];
  if (ones >= 2 && ones <= 4) return forms[1];
  return forms[2];
}

/** The change against the window before, as a signed share; null when there is nothing to compare with. */
export function change(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || previous <= 0) return null;
  return (current - previous) / previous;
}

const MSK_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

/** The Moscow day (`YYYY-MM-DD`) and minute of the day of an instant. Moscow has no DST: UTC+3. */
export function moscowOf(at: number): { day: string; minute: number } {
  const shifted = at + MSK_OFFSET_MS;
  const day = new Date(shifted).toISOString().slice(0, 10);
  const midnight = Date.parse(`${day}T00:00:00Z`);
  return { day, minute: Math.floor((shifted - midnight) / 60_000) };
}

/** The start of a Moscow day, as an instant. */
function moscowMidnight(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) - MSK_OFFSET_MS;
}

const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "UTC" });
const dayMonth = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
const timeFormat = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });

/** `пн, 27 окт.` of a Moscow `YYYY-MM-DD`. */
export function dayLabel(day: string): string {
  const at = new Date(`${day}T12:00:00Z`);
  return `${weekday.format(at)}, ${dayMonth.format(at)}`;
}

/** `27 окт.` of a Moscow `YYYY-MM-DD`. */
export function shortDay(day: string): string {
  return dayMonth.format(new Date(`${day}T12:00:00Z`));
}

/** `18:42`, Moscow. */
export function timeOf(iso: string): string {
  return timeFormat.format(new Date(iso));
}

/** `пн, 27 окт., 18:42–02:31`: the day the shift belongs to. */
export function shiftWhen(shift: Pick<StatsShift, "date" | "startedAt" | "endedAt" | "ongoing">): string {
  return `${dayLabel(shift.date)}, ${timeOf(shift.startedAt)}–${shift.ongoing ? "сейчас" : timeOf(shift.endedAt)}`;
}

const DAY_MINUTES = 1440;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** The hour marks of the ribbon are this far apart; its rows start on one. */
export const RIBBON_STEP_HOURS = 3;

/** Where the ribbon's day of the clock starts, and which day names a row. */
export interface RibbonClock {
  /** The Moscow hour the rows start at. */
  startHour: number;
  /** Minutes from a row's start to the moment whose Moscow day names the row: the middle of the chatter's working hours. */
  labelAt: number;
}

/**
 * The ribbon's clock for the chatter's shifts: the rows start in the middle of
 * the longest stretch of the clock none of them touches — on a mark of the
 * hours if that is free too, else on the hour — so a shift lies whole in a row;
 * a row is named by the day of its working hours' middle, the day its shifts
 * belong to (`shifts[].date`): an evening's row by the evening, a night's by
 * its morning. No shifts — midnight to midnight. Pure.
 */
export function ribbonClock(shifts: ReadonlyArray<Pick<StatsShift, "startedAt" | "endedAt">>): RibbonClock {
  const plain = { startHour: 0, labelAt: DAY_MINUTES / 2 };
  if (shifts.length === 0) return plain;
  const taken = new Array<boolean>(DAY_MINUTES).fill(false);
  for (const shift of shifts) {
    const start = moscowOf(Date.parse(shift.startedAt)).minute;
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

/** The row an instant falls in. Pure. */
export function ribbonRowOf(at: number, clock: RibbonClock): string {
  const intoRow = (moscowOf(at).minute - clock.startHour * 60 + DAY_MINUTES) % DAY_MINUTES;
  const rowStart = Math.floor(at / MINUTE_MS) * MINUTE_MS - intoRow * MINUTE_MS;
  return moscowOf(rowStart + clock.labelAt * MINUTE_MS).day;
}

/** The instant a row starts. Pure. */
export function ribbonRowStart(day: string, clock: RibbonClock): number {
  const sameDay = clock.startHour * 60 + clock.labelAt < DAY_MINUTES;
  return moscowMidnight(day) + (clock.startHour - (sameDay ? 0 : 24)) * HOUR_MS;
}

export interface RibbonPiece {
  /** Index into `stats.shifts`. */
  shift: number;
  /** Minutes from the row's start, [from, to). */
  from: number;
  to: number;
  pauses: Array<{ from: number; to: number }>;
  /** The piece ends where the shift goes on now. */
  live: boolean;
}

export interface RibbonVisit {
  /** Index into `stats.visits`. */
  visit: number;
  from: number;
  to: number;
}

export interface RibbonSale extends StatsSale {
  shift: number;
  minute: number;
}

export interface RibbonDay {
  day: string;
  /** The money of the shifts that begin in the row. */
  totalMills: number;
  /** A shift begins in the row (else one only goes on into it, or there is none). */
  hasShift: boolean;
  pieces: RibbonPiece[];
  visits: RibbonVisit[];
  sales: RibbonSale[];
}

/**
 * The ribbon's rows, the newest first: every Moscow day of the window, each a
 * day of the clock from `clock.startHour`, its shifts where they were (one that runs
 * past the row's end goes on in the next row), their sales at their minute, and
 * the visits. A shift going on now in a row after the window's last day — a
 * night begun before midnight — gets that row. Pure.
 */
export function ribbonDays(stats: Pick<Stats, "daily" | "shifts" | "visits" | "activitySince">, clock: RibbonClock): RibbonDay[] {
  const known = recordedDays(stats);
  const newRow = (day: string): RibbonDay => ({ day, totalMills: 0, hasShift: false, pieces: [], visits: [], sales: [] });
  const rows = new Map<string, RibbonDay>(stats.daily.filter((entry) => known.has(entry.date)).map((entry) => [entry.date, newRow(entry.date)]));
  const lastDay = [...rows.keys()].sort().at(-1);
  const rowOf = (at: number, live: boolean) => {
    const day = ribbonRowOf(at, clock);
    if (!rows.has(day) && live && lastDay !== undefined && day > lastDay) rows.set(day, newRow(day));
    return rows.get(day);
  };
  const minuteIn = (day: string, at: number) => (at - ribbonRowStart(day, clock)) / MINUTE_MS;

  stats.shifts.forEach((shift, index) => {
    const start = Date.parse(shift.startedAt);
    const end = Math.max(Date.parse(shift.endedAt), start + MINUTE_MS);
    const first = rowOf(start, shift.ongoing);
    if (first !== undefined) {
      first.totalMills += shift.salesNetMills;
      first.hasShift = true;
    }
    for (let from = start; from < end;) {
      const row = rowOf(from, shift.ongoing);
      const day = ribbonRowOf(from, clock);
      const to = Math.min(end, ribbonRowStart(day, clock) + DAY_MS);
      if (row !== undefined) {
        const pauses = shift.pauses
          .map((pause) => ({ from: Math.max(Date.parse(pause.from), from), to: Math.min(Date.parse(pause.to), to) }))
          .filter((pause) => pause.to > pause.from)
          .map((pause) => ({ from: minuteIn(day, pause.from), to: minuteIn(day, pause.to) }));
        row.pieces.push({ shift: index, from: minuteIn(day, from), to: minuteIn(day, to), pauses, live: shift.ongoing && to === end });
      }
      from = to;
    }
    for (const sale of shift.sales) {
      const at = Date.parse(sale.at);
      const day = ribbonRowOf(at, clock);
      rows.get(day)?.sales.push({ ...sale, shift: index, minute: minuteIn(day, at) });
    }
  });
  stats.visits.forEach((visit, index) => {
    const start = Date.parse(visit.startedAt);
    const day = ribbonRowOf(start, clock);
    const from = minuteIn(day, start);
    const to = Math.min(from + Math.max((Date.parse(visit.endedAt) - start) / MINUTE_MS, 1), DAY_MINUTES);
    rows.get(day)?.visits.push({ visit: index, from, to });
  });
  return [...rows.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/**
 * The window's days Hub has the chatter's shifts for: from the day of their
 * first minute in the extension on. A day before it is unknown, not a day off.
 * Pure.
 */
export function recordedDays(stats: Pick<Stats, "daily" | "activitySince">): Set<string> {
  if (stats.activitySince === null) return new Set();
  const first = moscowOf(Date.parse(stats.activitySince)).day;
  return new Set(stats.daily.map((entry) => entry.date).filter((date) => date >= first));
}

/** The radius of a sale's bead, px: its area grows with the money, 3 to 9. Pure. */
export function beadRadius(netMills: number, maxMills: number): number {
  if (maxMills <= 0) return 3;
  return 3 + Math.sqrt(Math.max(0, netMills) / maxMills) * 6;
}

/** The price bucket where the chatter's PPVs sell best, with at least `minSent` of them sent. Pure. */
export function bestPriceBucket(byPrice: Stats["ppv"]["byPrice"], minSent = 5): { bucket: string; rate: number; sent: number; bought: number } | null {
  let best: { bucket: string; rate: number; sent: number; bought: number } | null = null;
  for (const cell of byPrice) {
    if (cell.sent < minSent) continue;
    const rate = cell.bought / cell.sent;
    if (best === null || rate > best.rate) best = { bucket: cell.bucket, rate, sent: cell.sent, bought: cell.bought };
  }
  return best;
}

/** How often a fan bought after a fast reply and after a slow one (an hour and more), each with enough replies. Pure. */
export function replyContrast(byDelay: Stats["replies"]["byDelay"], minReplies = 10): { fast: number; slow: number } | null {
  const fast = byDelay.find((cell) => cell.bucket === "under5m");
  const slow = byDelay.filter((cell) => cell.bucket === "1to6h" || cell.bucket === "over6h")
    .reduce((total, cell) => ({ replies: total.replies + cell.replies, bought: total.bought + cell.bought }), { replies: 0, bought: 0 });
  if (fast === undefined || fast.replies < minReplies || slow.replies < minReplies) return null;
  return { fast: fast.bought / fast.replies, slow: slow.bought / slow.replies };
}

/** The share of replies sent within 15 minutes. Pure. */
export function quickReplyShare(byDelay: Stats["replies"]["byDelay"]): number | null {
  const total = byDelay.reduce((sum, cell) => sum + cell.replies, 0);
  const quick = byDelay.filter((cell) => cell.bucket === "under5m" || cell.bucket === "5to15m").reduce((sum, cell) => sum + cell.replies, 0);
  return share(quick, total);
}
