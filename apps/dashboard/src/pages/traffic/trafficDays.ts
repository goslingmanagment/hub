import { addDays, weekdayIndex, type MoscowDay } from "@agency_hub_core/ui/moscow";
import { formatMills } from "@/lib/format";
import { ruPlural } from "@/lib/plural";

// The day language shared by «Источники» and the page of one link: the slots
// of a day grid, the words of a date, what one day of a link brought, the hint
// over a day. Pure.

export interface DaySlot {
  date: MoscowDay;
  /** «пн 9». */
  label: string;
  /** «вт 17 ноября». */
  long: string;
  when: "past" | "today" | "future";
}

const WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"] as const;
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"] as const;

const dayOfMonth = (day: MoscowDay) => Number(day.slice(8, 10));
const monthOf = (day: MoscowDay) => MONTHS[Number(day.slice(5, 7)) - 1] ?? "";

/** «9 ноября»; with the year when it is not `thisYear`'s: «1 апреля 2025». */
export function dayMonth(day: MoscowDay, thisYear?: MoscowDay): string {
  const year = thisYear !== undefined && day.slice(0, 4) !== thisYear.slice(0, 4) ? ` ${day.slice(0, 4)}` : "";
  return `${dayOfMonth(day)} ${monthOf(day)}${year}`;
}

/** «9–15 ноября», «27 октября – 2 ноября». */
export function weekRange(from: MoscowDay, to: MoscowDay): string {
  return from.slice(0, 7) === to.slice(0, 7)
    ? `${dayOfMonth(from)}–${dayOfMonth(to)} ${monthOf(to)}`
    : `${dayOfMonth(from)} ${monthOf(from)} – ${dayOfMonth(to)} ${monthOf(to)}`;
}

/** `count` days from `from`, each past, today or to come against `today`. */
export function daySlots(from: MoscowDay, count: number, today: MoscowDay): DaySlot[] {
  return Array.from({ length: count }, (_, index) => {
    const date = addDays(from, index);
    const weekday = WEEKDAYS[weekdayIndex(date)];
    return {
      date,
      label: `${weekday} ${dayOfMonth(date)}`,
      long: `${weekday} ${dayMonth(date)}`,
      when: date < today ? "past" : date === today ? "today" : "future",
    };
  });
}

export const fansWord = (count: number) => `${count.toLocaleString("ru-RU")} ${ruPlural(count, "фан", "фана", "фанов")}`;
export const clicksWord = (count: number) => `${count.toLocaleString("ru-RU")} ${ruPlural(count, "клик", "клика", "кликов")}`;

/** Sum of the known values, null when none is known. */
export function sumKnown(values: ReadonlyArray<number | null>): number | null {
  let sum: number | null = null;
  for (const value of values) {
    if (value !== null) sum = (sum ?? 0) + value;
  }
  return sum;
}

/** What a day of a link brought. A day flagged no_baseline holds everything the
 *  link had accumulated by then: for a link made inside the shown days that is
 *  its arrivals since creation, and a zero is a zero for any link; a positive
 *  figure of an older link is unknown, never an arrival. */
export function arrivalOf(value: number | null, flags: readonly string[], madeInside: boolean): number | null {
  return flags.includes("no_baseline") && !madeInside && value !== 0 ? null : value;
}

export interface DayFigures {
  fans: number | null;
  clicks: number | null;
  /** Mills; null: unknown. */
  money: number | null;
}

/** The hover hint of a day: «вт 17 ноября: 4 фана, 9 кликов, $12.50». Null for a day to come. */
export function dayHint(slot: DaySlot, figures: DayFigures): string | null {
  if (slot.when === "future") return null;
  if (figures.fans === null) {
    return `${slot.long}: ${slot.when === "today" ? "за сегодня чтения ещё не было" : "нет чтения"}`;
  }
  const parts = [fansWord(figures.fans)];
  if (figures.clicks !== null) parts.push(clicksWord(figures.clicks));
  if (figures.money !== null) parts.push(formatMills(figures.money));
  return `${slot.long}${slot.when === "today" ? ", день идёт" : ""}: ${parts.join(", ")}`;
}

export interface LinkTarget {
  pageId: number;
  linkKind: "tracking" | "trial";
  linkRef: string;
}

/** The page of one link (screens.ts `traffic-link`). */
export function linkPagePath(link: LinkTarget): string {
  return `/traffic/link/${link.pageId}/${link.linkKind}/${encodeURIComponent(link.linkRef)}`;
}
