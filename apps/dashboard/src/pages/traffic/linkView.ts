import type { OfLink, OfLinkHistoryResponse } from "@agency_hub_core/contracts";
import { addDays, mondayOf, moscowDayOf, type MoscowDay } from "@agency_hub_core/ui/moscow";
import { formatDayRange, formatMills, formatWeekdayDay } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { linkStateView } from "@/pages/marketing/ofLinksView";
import { arrivalOf, clicksWord, dayHint, dayMonth, daySlots, fansWord, sumKnown, type DaySlot } from "./trafficDays.js";

// The page of one link: what its header, its figures, its chart and its table
// of days show, from the link's latest read (`ofLinksGet`) and its days
// (`ofLinksHistoryGet`). Pure: the days come from the history's own range.

export const LINK_WEEKS = 8;

export type LinkMetric = "fans" | "clicks" | "money";

/** Eight Moscow weeks ending with the current one: Monday seven weeks back to today. */
export function linkRange(today: MoscowDay): { from: MoscowDay; to: MoscowDay } {
  return { from: addDays(mondayOf(today), -7 * (LINK_WEEKS - 1)), to: today };
}

export interface LinkWeek {
  /** «3–9 нояб.». */
  label: string;
  /** «12 фанов», «40 кликов», «$120.00»; «—» when no day of it is known. */
  sum: string;
  running: boolean;
}

export interface LinkDayRow {
  date: MoscowDay;
  /** «вт, 17 нояб.». */
  label: string;
  clicks: string;
  fans: string;
  money: string;
  /** No figures: «нет чтения», or «день идёт» for today. */
  missing: string | null;
}

export interface LinkChartView {
  slots: DaySlot[];
  values: Array<number | null>;
  hints: Array<string | null>;
  max: number;
  weeks: LinkWeek[];
  /** Every day of the range, newest first. */
  table: LinkDayRow[];
}

/** One day of the history as it is drawn: a no_baseline day of an older link is unknown. */
function dayFigures(day: OfLinkHistoryResponse["days"][number], madeInside: boolean) {
  const fans = arrivalOf(day.fans, day.flags, madeInside);
  if (fans === null) return { fans: null, clicks: null, money: null };
  return {
    fans,
    clicks: arrivalOf(day.clicks, day.flags, madeInside),
    money: day.flags.includes("money_unknown") ? null : arrivalOf(day.vendorNetMills, day.flags, madeInside),
  };
}

export function linkChartView(history: OfLinkHistoryResponse, metric: LinkMetric): LinkChartView {
  const count = LINK_WEEKS * 7;
  const slots = daySlots(history.range.from, count, history.range.to);
  const madeInside = history.linkCreatedAt !== null && history.linkCreatedAt >= history.range.fromAt;
  const byDate = new Map(history.days.map((day) => [day.businessDate, dayFigures(day, madeInside)]));
  const figures = slots.map((slot) => byDate.get(slot.date) ?? { fans: null, clicks: null, money: null });
  const values = figures.map((day, index) => (slots[index]!.when === "future" ? null : day[metric]));
  const sumText = (sum: number | null) => (sum === null ? "—" : metric === "fans" ? fansWord(sum) : metric === "clicks" ? clicksWord(sum) : formatMills(sum));
  const weeks = Array.from({ length: LINK_WEEKS }, (_, week) => {
    const part = slots.slice(week * 7, week * 7 + 7);
    return {
      label: formatDayRange(part[0]!.date, part[6]!.date),
      sum: sumText(sumKnown(values.slice(week * 7, week * 7 + 7))),
      running: part.some((slot) => slot.when === "today"),
    };
  });
  // The table starts on the day the link was made: before it there is nothing to read.
  const madeOn = history.linkCreatedAt === null ? null : moscowDayOf(history.linkCreatedAt);
  const table = slots
    .map((slot, index) => ({ slot, day: figures[index]! }))
    .filter(({ slot }) => slot.when !== "future" && (madeOn === null || slot.date >= madeOn))
    .reverse()
    .map(({ slot, day }) => ({
      date: slot.date,
      label: formatWeekdayDay(slot.date),
      clicks: day.clicks === null ? "—" : day.clicks.toLocaleString("ru-RU"),
      fans: day.fans === null ? "—" : day.fans.toLocaleString("ru-RU"),
      money: day.money === null ? "—" : formatMills(day.money),
      missing: day.fans !== null ? null : slot.when === "today" ? "день идёт" : "нет чтения",
    }));
  return {
    slots,
    values,
    hints: slots.map((slot, index) => dayHint(slot, figures[index]!)),
    max: Math.max(metric === "money" ? 1000 : 2, ...values.map((value) => value ?? 0)),
    weeks,
    table,
  };
}

export interface LinkFigure {
  /** null: unknown — the word alone says so. */
  value: string | null;
  word: string;
}

/** The link's source in its line of facts: a link to the source's page, or none yet. */
export type LinkSourceFact =
  | { kind: "bound"; channelKey: string; title: string; /** «Maple Media с 6 ноября». */ contractor: string | null }
  | { kind: "none" };

/** The page of one source (Трафик → Источники → a source). */
export function sourcePath(channelKey: string): string {
  return `/traffic/source/${encodeURIComponent(channelKey)}`;
}

export interface LinkHead {
  name: string;
  /** «пробная на 360 дней» or «трекинг-ссылка», and the page: before the source. */
  before: string[];
  source: LinkSourceFact;
  /** The date it was made, its state: after the source. */
  after: string[];
  /** All-time of the link: fans, who pays, the money. */
  figures: LinkFigure[];
  /** «28 кликов». */
  clicks: string;
}

function trialWords(days: number): string {
  return `пробная на ${days} ${ruPlural(days, "день", "дня", "дней")}`;
}

export function linkHead(link: OfLink, pageLabel: string | null): LinkHead {
  const binding = link.binding;
  const source: LinkSourceFact = binding === null
    ? { kind: "none" }
    : {
      kind: "bound",
      channelKey: binding.channelKey,
      title: binding.channelTitle,
      contractor: binding.contractor
        ? `${binding.contractor.contractorTitle} с ${dayMonth(moscowDayOf(binding.contractor.validFrom), moscowDayOf(link.observedAt))}`
        : null,
    };
  const state = linkStateView(link);
  const fans = link.fans;
  const spenders = link.spenders;
  return {
    name: link.name ?? `Ссылка ${link.linkRef}`,
    before: [
      link.linkKind === "trial" ? (link.trialDays === null ? "пробная ссылка" : trialWords(link.trialDays)) : "трекинг-ссылка",
      ...(pageLabel ? [pageLabel] : []),
    ],
    source,
    after: [
      ...(link.linkCreatedAt ? [`создана ${dayMonth(moscowDayOf(link.linkCreatedAt), moscowDayOf(link.observedAt))}`] : []),
      `${state.label.toLowerCase()}${state.detail ? ` ${state.detail}` : ""}`,
    ],
    figures: [
      fans === null
        ? { value: null, word: "фанов не знаем" }
        : { value: fans.toLocaleString("ru-RU"), word: ruPlural(fans, "фан", "фана", "фанов") },
      spenders === null
        ? { value: null, word: "кто платит, не знаем" }
        : { value: spenders.toLocaleString("ru-RU"), word: ruPlural(spenders, "платит", "платят", "платят") },
      link.vendorMoney.netMills === null
        ? { value: null, word: "доход неизвестен" }
        : { value: formatMills(link.vendorMoney.netMills), word: "принесли" },
    ],
    clicks: clicksWord(link.clicks),
  };
}
