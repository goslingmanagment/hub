import {
  formatUsdFromMicroUsd,
  formatUsdFromMills as sharedFormatUsd,
  microUsdFromDbInt,
  millsFromInteger,
  parseBusinessDate,
  type MillsLike,
} from "@agency_hub_core/shared";
import { ruPlural } from "./plural.js";

/** Every time on the screen is Moscow's (design/design-language.md §6.4; the exceptions are named in design/build-rules.md). */
const MOSCOW_ZONE = "Europe/Moscow";
const MOSCOW_YEAR = new Intl.DateTimeFormat("ru-RU", { year: "numeric", timeZone: MOSCOW_ZONE });

/** A real minus, in numbers of money and everywhere on the screen. */
const MINUS = "\u2212";
const NBSP = "\u00a0";

function realMinus(text: string): string {
  return text.startsWith("-") ? `${MINUS}${text.slice(1)}` : text;
}

/** «$11,183.60», «−$2,193.64»: always the cents. A sum made by `sumMills` goes in as is. */
export function formatMills(mills: MillsLike): string {
  return realMinus(sharedFormatUsd(mills));
}

export function formatUsdFromCents(cents: number): string {
  return realMinus(sharedFormatUsd(cents * 10));
}

/** «+$880.00», «−$222.86», «$0.00». */
export function formatSignedMills(mills: MillsLike): string {
  const value = millsFromInteger(mills);
  return value > 0n ? `+${formatMills(value)}` : formatMills(value);
}

/**
 * «29 %», «< 1 %», «0 %». `precise`: one decimal below 10, for a share or a
 * conversion in a column: «2,5 %». Whole otherwise.
 */
export function formatPercent(value: number, options: { precise?: boolean } = {}): string {
  const size = Math.abs(value);
  if (size === 0) return `0${NBSP}%`;
  if (options.precise && size < 10) return `${size.toFixed(1).replace(".", ",")}${NBSP}%`;
  if (size < 1) return `<${NBSP}1${NBSP}%`;
  return `${formatCount(Math.round(size))}${NBSP}%`;
}

/** «+64 %», «−4 %», «0 %». Always whole, no arrows. */
export function formatSignedPercent(value: number): string {
  const whole = Math.round(value);
  if (whole === 0) return `0${NBSP}%`;
  return `${whole > 0 ? "+" : MINUS}${formatCount(Math.abs(whole))}${NBSP}%`;
}

/**
 * The change against the last period: «+$4,104.21 (+64 %)», «−$222.86 (−4 %)». Growth
 * from zero has no percent: «+$880.00». Nothing to compare with: «—».
 */
export function formatChange(mills: MillsLike | null | undefined, pct: number | null | undefined): string {
  if (mills === null || mills === undefined) return "—";
  const amount = formatSignedMills(mills);
  return pct === null || pct === undefined ? amount : `${amount} (${formatSignedPercent(pct)})`;
}

/** Which way a change went, for its colour. */
export function changeDirection(mills: MillsLike | null | undefined): "up" | "down" | "flat" {
  if (mills === null || mills === undefined) return "flat";
  const value = millsFromInteger(mills);
  return value > 0n ? "up" : value < 0n ? "down" : "flat";
}

/** «1 420», «9 840», a real zero «0», no data «—». */
export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toLocaleString("ru-RU");
}

/** The AI's money: «$39.88», «< $0.01», «$0.00», «−$1.20». */
export function formatAiUsd(microUsd: number): string {
  const value = microUsdFromDbInt(microUsd);
  if (value === 0) return "$0.00";
  return value < 0 ? `${MINUS}${formatUsdFromMicroUsd(-value)}` : formatUsdFromMicroUsd(value);
}

const AI_UNIT_PRICE = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 3 });

/** The price of one AI call, only in the column «За вызов»: «$0.004». */
export function formatAiUnitPrice(microUsd: number): string {
  return realMinus(AI_UNIT_PRICE.format(microUsdFromDbInt(microUsd) / 1_000_000));
}

export function formatDelta(pct: number | null): { text: string; direction: "up" | "down" | "neutral" } {
  if (pct === null) return { text: "—", direction: "neutral" };
  const rounded = Math.abs(Math.round(pct * 10) / 10);
  if (pct > 0) return { text: `↑ ${rounded}%`, direction: "up" };
  if (pct < 0) return { text: `↓ ${rounded}%`, direction: "down" };
  return { text: "0%", direction: "neutral" };
}

export function formatDate(iso: string, options?: { includeYear?: boolean }): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ru-RU", {
    month: "short",
    day: "numeric",
    year: options?.includeYear ? "numeric" : undefined,
    timeZone: MOSCOW_ZONE,
  });
}

/** "4 окт., 12:01". `yearUnlessCurrent`: an instant of another year carries it
 *  ("30 авг. 2025 г., 11:59") — a date without one reads as this year's. */
export function formatDateTime(iso: string, options?: { yearUnlessCurrent?: boolean }): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const withYear = options?.yearUnlessCurrent === true && MOSCOW_YEAR.format(d) !== MOSCOW_YEAR.format(new Date());
  return d.toLocaleDateString("ru-RU", {
    month: "short",
    day: "numeric",
    year: withYear ? "numeric" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: MOSCOW_ZONE,
  });
}

/** «только что», «5 мин назад», «2 ч назад», «3 дня назад»: only next to the exact time. */
export function formatAgo(at: string | number | Date, now: number = Date.now()): string {
  const minutes = Math.floor((now - new Date(at).getTime()) / 60_000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return `${days} ${ruPlural(days, "день", "дня", "дней")} назад`;
}

export function formatRelativeTime(iso: string): string {
  return formatAgo(iso);
}

export function formatRelativeTimeCompact(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "сейчас";
  if (mins < 60) return `${mins} мин`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ч`;
  const days = Math.floor(hours / 24);
  return `${days} дн`;
}

export function daysAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

const TYPE_LABELS: Record<string, string> = {
  subscription: "Подписка",
  tip: "Чаевые",
  message_purchase: "Платное сообщение",
  post_purchase: "Платный пост",
  stream_tip: "Чаевые в эфире",
  chargeback: "Чарджбэк",
  refund: "Возврат",
  payout_reversal: "Отмена выплаты",
  other: "Прочее",
};

const STATE_LABELS: Record<string, string> = {
  posted: "Проведена",
  pending: "Ожидает",
  unknown: "Неизвестно",
};

/** A transaction's state in words. */
export function transactionStateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

export function transactionTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

export function daysRemaining(expiresIso: string): number {
  const diff = new Date(expiresIso).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 86_400_000));
}

// As Intl's ru-RU writes them, one word for a month everywhere.
const MONTH_SHORT = ["янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."];

export function formatBusinessDateShort(bd: string): string {
  const { month, day } = parseBusinessDate(bd);
  return `${day} ${MONTH_SHORT[month - 1]}`;
}

export function formatBusinessDateMonth(bd: string): string {
  const { year, month } = parseBusinessDate(bd);
  return `${MONTH_SHORT[month - 1]} ${String(year).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Usage date-nav helpers
// ---------------------------------------------------------------------------

export type UsagePeriod = "day" | "week" | "month";

/** Build a YYYY-MM-DD string from year/month/day. */
function bd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** Get Monday of the ISO week containing the given business date. */
export function weekStart(date: string): string {
  const { year, month, day } = parseBusinessDate(date);
  const d = new Date(year, month - 1, day);
  const dow = d.getDay(); // 0=Sun
  const shift = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(year, month - 1, day + shift);
  return bd(mon.getFullYear(), mon.getMonth() + 1, mon.getDate());
}

/** Get Sunday of the ISO week containing the given business date. */
export function weekEnd(date: string): string {
  const ws = weekStart(date);
  const { year, month, day } = parseBusinessDate(ws);
  const sun = new Date(year, month - 1, day + 6);
  return bd(sun.getFullYear(), sun.getMonth() + 1, sun.getDate());
}

/** First day of the month containing the given business date. */
export function monthStart(date: string): string {
  const { year, month } = parseBusinessDate(date);
  return bd(year, month, 1);
}

/** Last day of the month containing the given business date. */
export function monthEnd(date: string): string {
  const { year, month } = parseBusinessDate(date);
  return bd(year, month, lastDayOfMonth(year, month));
}

/** Compute the {from, to} range for the given period around the anchor date. */
export function usageRange(anchor: string, mode: UsagePeriod): { from: string; to: string } {
  switch (mode) {
    case "day":
      return { from: anchor, to: anchor };
    case "week":
      return { from: weekStart(anchor), to: weekEnd(anchor) };
    case "month":
      return { from: monthStart(anchor), to: monthEnd(anchor) };
  }
}

/** Shift anchor date by one period step. */
export function shiftAnchor(anchor: string, mode: UsagePeriod, direction: -1 | 1): string {
  const { year, month, day } = parseBusinessDate(anchor);
  switch (mode) {
    case "day": {
      const d = new Date(year, month - 1, day + direction);
      return bd(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }
    case "week": {
      const d = new Date(year, month - 1, day + direction * 7);
      return bd(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }
    case "month": {
      const newMonth = month - 1 + direction;
      const d = new Date(year, newMonth, 1);
      const clamped = Math.min(day, lastDayOfMonth(d.getFullYear(), d.getMonth() + 1));
      return bd(d.getFullYear(), d.getMonth() + 1, clamped);
    }
  }
}

const MONTH_FULL = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

/** Human-readable label for the current date/range based on period mode. */
export function usageDateLabel(anchor: string, mode: UsagePeriod): string {
  const { year, month, day } = parseBusinessDate(anchor);
  switch (mode) {
    case "day":
      return `${day} ${MONTH_SHORT[month - 1]} ${year}`;
    case "week": {
      const ws = weekStart(anchor);
      const we = weekEnd(anchor);
      const f = parseBusinessDate(ws);
      const t = parseBusinessDate(we);
      if (f.year === t.year && f.month === t.month) {
        return `${f.day}–${t.day} ${MONTH_SHORT[f.month - 1]} ${f.year}`;
      }
      if (f.year === t.year) {
        return `${f.day} ${MONTH_SHORT[f.month - 1]} – ${t.day} ${MONTH_SHORT[t.month - 1]} ${f.year}`;
      }
      return `${f.day} ${MONTH_SHORT[f.month - 1]} ${f.year} – ${t.day} ${MONTH_SHORT[t.month - 1]} ${t.year}`;
    }
    case "month":
      return `${MONTH_FULL[month - 1]} ${year}`;
  }
}

// ---------------------------------------------------------------------------
// The header's dates (design-language §6.4): Moscow time everywhere, months as
// Intl's ru-RU writes them («нояб.»), an en dash in a range.
// ---------------------------------------------------------------------------

const DAY_AND_MONTH = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: MOSCOW_ZONE });
const WEEKDAY = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: MOSCOW_ZONE });
const CLOCK = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: MOSCOW_ZONE });

function instantOf(value: string | number | Date): Date {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // A business date is a Moscow day: noon there is safely inside it.
    return new Date(`${value}T12:00:00+03:00`);
  }
  return new Date(value);
}

/** «3 нояб.» */
export function formatDay(value: string | number | Date): string {
  return DAY_AND_MONTH.format(instantOf(value));
}

/** «вт, 3 нояб.»: shifts, charts, a day in a schedule. */
export function formatWeekdayDay(value: string | number | Date): string {
  const instant = instantOf(value);
  return `${WEEKDAY.format(instant)}, ${DAY_AND_MONTH.format(instant)}`;
}

function rangeOf(format: Intl.DateTimeFormat, from: Date, to: Date): string {
  const parts = (value: Date) => {
    const all = format.formatToParts(value);
    return { day: all.find((part) => part.type === "day")?.value ?? "", month: all.find((part) => part.type === "month")?.value ?? "" };
  };
  const start = parts(from);
  const end = parts(to);
  if (start.month === end.month && start.day === end.day) return `${end.day} ${end.month}`;
  if (start.month === end.month) return `${start.day}–${end.day} ${end.month}`;
  return `${start.day} ${start.month} – ${end.day} ${end.month}`;
}

/** «21–27 окт.», «28 окт. – 3 нояб.», «3 нояб.». `to` is the last day included. */
export function formatDayRange(from: string | number | Date, to: string | number | Date): string {
  return rangeOf(DAY_AND_MONTH, instantOf(from), instantOf(to));
}

/** The same for a window whose end is exclusive: a report's `[from, to)`, Moscow days. */
export function formatWindowRange(from: string, toExclusive: string): string {
  return formatDayRange(from, new Date(Date.parse(toExclusive) - 1));
}

/**
 * «5 ч 7 мин», «3 ч», «40 мин». Hours of work are never days: «669 ч 30 мин».
 * `days`, for how long something has been so: «2 дня 4 ч».
 */
export function formatDuration(minutes: number, options: { days?: boolean } = {}): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (options.days && hours >= 24) {
    const days = Math.floor(hours / 24);
    const left = hours % 24;
    return `${days} ${ruPlural(days, "день", "дня", "дней")}${left > 0 ? ` ${left} ч` : ""}`;
  }
  if (hours === 0) return `${rest} мин`;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/** «40 с», on technical screens only; from a minute on as `formatDuration`. */
export function formatSeconds(seconds: number): string {
  return seconds < 60 ? `${Math.round(seconds)} с` : formatDuration(Math.round(seconds / 60));
}

/** «23:41» по Москве. */
export function formatTimeOfDay(at: string | number | Date): string {
  return CLOCK.format(new Date(at));
}

/** «Обновлено в 23:41, 5 мин назад». */
export function formatUpdated(at: string | number | Date, now: number = Date.now()): string {
  return `Обновлено в ${CLOCK.format(new Date(at))}, ${formatAgo(at, now)}`;
}

/** «Проверено в 23:41, 5 мин назад»: when Hub was read, on data that no longer changes. */
export function formatChecked(at: string | number | Date, now: number = Date.now()): string {
  return `Проверено в ${CLOCK.format(new Date(at))}, ${formatAgo(at, now)}`;
}

/** «3 нояб., 14:05, 2 ч назад»; a moment of today: «14:05, 5 мин назад». */
export function formatMomentAgo(at: string | number | Date, now: number = Date.now()): string {
  const instant = new Date(at);
  const today = DAY_AND_MONTH.format(instant) === DAY_AND_MONTH.format(new Date(now));
  return `${today ? CLOCK.format(instant) : formatDateTime(instant.toISOString(), { yearUnlessCurrent: true })}, ${formatAgo(at, now)}`;
}
