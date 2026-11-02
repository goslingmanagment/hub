import type { ChatterSaleKind, ChatterStats } from "@agency_hub_core/contracts";

// Pure helpers of the cabinet's «Статистика»: words, numbers and the layout
// of the shift ribbon. No React here.

export type Stats = ChatterStats;
export type StatsShift = Stats["shifts"][number];
export type StatsSale = StatsShift["sales"][number];

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

/** Whole dollars: `$3,699`. */
export function money(mills: number): string {
  return usdWhole.format(Math.round(mills / 1000));
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

/** `пн, 27 окт., 18:42–02:31`. */
export function shiftWhen(shift: Pick<StatsShift, "startedAt" | "endedAt" | "ongoing">): string {
  const start = moscowOf(Date.parse(shift.startedAt));
  return `${dayLabel(start.day)}, ${timeOf(shift.startedAt)}–${shift.ongoing ? "сейчас" : timeOf(shift.endedAt)}`;
}

export interface RibbonPiece {
  /** Index into `stats.shifts`. */
  shift: number;
  /** Minutes of the Moscow day, [from, to). */
  from: number;
  to: number;
  pauses: Array<{ from: number; to: number }>;
  /** The piece ends where the shift goes on now. */
  live: boolean;
}

export interface RibbonSale extends StatsSale {
  shift: number;
  minute: number;
}

export interface RibbonDay {
  day: string;
  /** The money of the shifts that began on the day. */
  totalMills: number;
  /** A shift began on the day (else it only goes on from the day before, or there is none). */
  started: boolean;
  pieces: RibbonPiece[];
  sales: RibbonSale[];
}

/**
 * The ribbon's rows: every Moscow day of the window, the newest first, with the
 * pieces of the shifts that fall on it (a shift over midnight goes on in the
 * next row) and its sales at their minute. Pure.
 */
export function ribbonDays(stats: Pick<Stats, "daily" | "shifts" | "activitySince">): RibbonDay[] {
  const known = recordedDays(stats);
  const rows = new Map<string, RibbonDay>(stats.daily
    .filter((entry) => known.has(entry.date))
    .map((entry) => [entry.date, { day: entry.date, totalMills: entry.salesNetMills, started: entry.shifts > 0, pieces: [], sales: [] }]));
  stats.shifts.forEach((shift, index) => {
    const start = Date.parse(shift.startedAt);
    const end = Math.max(Date.parse(shift.endedAt), start + 60_000);
    let day = moscowOf(start).day;
    for (let from = start; from < end;) {
      const midnight = moscowMidnight(day) + DAY_MS;
      const to = Math.min(end, midnight);
      const row = rows.get(day);
      if (row !== undefined) {
        const base = moscowMidnight(day);
        const pauses = shift.pauses
          .map((pause) => ({ from: Math.max(Date.parse(pause.from), from), to: Math.min(Date.parse(pause.to), to) }))
          .filter((pause) => pause.to > pause.from)
          .map((pause) => ({ from: (pause.from - base) / 60_000, to: (pause.to - base) / 60_000 }));
        row.pieces.push({ shift: index, from: (from - base) / 60_000, to: (to - base) / 60_000, pauses, live: shift.ongoing && to === end });
      }
      from = to;
      day = moscowOf(to).day;
    }
    for (const sale of shift.sales) {
      const at = moscowOf(Date.parse(sale.at));
      rows.get(at.day)?.sales.push({ ...sale, shift: index, minute: at.minute });
    }
  });
  return [...rows.values()].reverse();
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
