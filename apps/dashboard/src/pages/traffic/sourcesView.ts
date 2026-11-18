import type { OfLinkChannelsResponse } from "@agency_hub_core/contracts";
import { addDays, mondayOf, weekdayIndex, type MoscowDay } from "@agency_hub_core/ui/moscow";
import { ruPlural } from "@/lib/plural";

// Трафик → Источники: what the screen draws, from two reads of the channels'
// totals (`ofLinksChannelsGet`): the last two Moscow weeks with every
// segment's days, and all the series has for «принесли». Pure: today is a
// parameter. The component only draws what this returns.

type Channels = OfLinkChannelsResponse;
type Channel = Channels["channels"][number];
type Segment = Channel["segments"][number];

/** Two weeks, Monday to Sunday twice: the one grid every chart of the page shares. */
export const SLOT_COUNT = 14;

export interface DaySlot {
  date: MoscowDay;
  /** «пн 9». */
  label: string;
  when: "past" | "today" | "future";
}

/** A chart row: a link, or the source's links together («Все N ссылок»). */
export interface SourceRow {
  key: string;
  name: string;
  /** The large chart (its own scale, a soft area), or a small one (the source's shared scale). */
  large: boolean;
  /** New fans per slot; null: unknown (no delta, or no baseline), or a day to come. */
  fans: ReadonlyArray<number | null>;
  /** The known days' sum. */
  total: number;
}

export interface SourceView {
  key: string;
  title: string;
  /** The contractor of the channel now (or last in the range); null: none. */
  contractor: string | null;
  /** «2 дня без фанов»: the source brought fans earlier and its last known days are zero. */
  attention: string | null;
  /** The channel's net through its links over all the series has; null: not read. */
  broughtMills: number | null;
  rows: SourceRow[];
  /** The scale of the small rows: their largest value, at least 2. */
  smallMax: number;
  /** «ещё 2 без кликов: A, B». */
  quiet: string | null;
  fans: number;
}

export interface SourcesView {
  /** Monday of the previous week … Sunday of this one. */
  from: MoscowDay;
  to: MoscowDay;
  slots: DaySlot[];
  /** «9–15 ноября». */
  lastWeek: string;
  thisWeek: string;
  /** The latest snapshot the deltas rest on. */
  dataAt: string | null;
  sources: SourceView[];
  /** «Без источника: 4 ссылки · 255 фанов за 2 недели»; null when there is no such row. */
  unbound: string | null;
  /** «Без движения»: channels without a click or a fan in the two weeks. */
  idle: string[];
}

const WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"] as const;
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"] as const;

const dayOfMonth = (day: MoscowDay) => Number(day.slice(8, 10));
const monthOf = (day: MoscowDay) => MONTHS[Number(day.slice(5, 7)) - 1] ?? "";

/** «9–15 ноября», «27 октября – 2 ноября». */
export function weekRange(from: MoscowDay, to: MoscowDay): string {
  return from.slice(0, 7) === to.slice(0, 7)
    ? `${dayOfMonth(from)}–${dayOfMonth(to)} ${monthOf(to)}`
    : `${dayOfMonth(from)} ${monthOf(from)} – ${dayOfMonth(to)} ${monthOf(to)}`;
}

/** The range the screen asks for: Monday of the previous Moscow week to today. */
export function sourcesRange(today: MoscowDay): { from: MoscowDay; to: MoscowDay } {
  return { from: addDays(mondayOf(today), -7), to: today };
}

export function daySlots(today: MoscowDay): DaySlot[] {
  const { from } = sourcesRange(today);
  return Array.from({ length: SLOT_COUNT }, (_, index) => {
    const date = addDays(from, index);
    return {
      date,
      label: `${WEEKDAYS[weekdayIndex(date)]} ${dayOfMonth(date)}`,
      when: date < today ? "past" : date === today ? "today" : "future",
    };
  });
}

const linkKeyOf = (segment: Segment) => `${segment.pageId}:${segment.linkKind}:${segment.linkRef}`;
const nameOf = (segment: Segment) => segment.name?.trim() || `Ссылка ${segment.linkRef}`;

/** Sum of the known values, null when none is known. */
function sumKnown(values: ReadonlyArray<number | null>): number | null {
  let sum: number | null = null;
  for (const value of values) {
    if (value !== null) sum = (sum ?? 0) + value;
  }
  return sum;
}

interface LinkDays {
  key: string;
  name: string;
  fans: Array<number | null>;
  clicks: Array<number | null>;
  /** Made at OnlyFans inside the two weeks. */
  createdInRange: boolean;
}

/** A link's segments of one channel merged by day; a day no segment knows stays
 *  null. A day flagged no_baseline holds everything the link had accumulated:
 *  for a link made inside the two weeks that is its arrivals since creation, and
 *  a zero is a zero for any link; a positive figure of an older link is unknown,
 *  never an arrival. */
function linkDays(segments: readonly Segment[], slots: readonly DaySlot[], rangeFromAt: string): LinkDays[] {
  const index = new Map(slots.map((slot, position) => [slot.date, position]));
  const links = new Map<string, LinkDays>();
  for (const segment of segments) {
    const key = linkKeyOf(segment);
    let link = links.get(key);
    if (!link) {
      link = { key, name: nameOf(segment), fans: slots.map(() => null), clicks: slots.map(() => null), createdInRange: false };
      links.set(key, link);
    }
    const young = segment.linkCreatedAt !== null && segment.linkCreatedAt >= rangeFromAt;
    if (young) link.createdInRange = true;
    for (const day of segment.days ?? []) {
      const position = index.get(day.businessDate);
      if (position === undefined || slots[position]!.when === "future") continue;
      const accumulated = day.flags.includes("no_baseline") && !young;
      const arrived = (value: number | null) => (accumulated && value !== 0 ? null : value);
      link.fans[position] = sumKnown([link.fans[position] ?? null, arrived(day.fans)]);
      link.clicks[position] = sumKnown([link.clicks[position] ?? null, arrived(day.clicks)]);
    }
  }
  return [...links.values()];
}

const known = (values: ReadonlyArray<number | null>) => sumKnown(values) ?? 0;
const byFansThenName = <T extends { name: string; total: number }>(left: T, right: T) =>
  right.total - left.total || left.name.localeCompare(right.name, "ru");

/** The per-day sum of rows: the known values of each day, null when none is known. */
export function combinedSeries(rows: ReadonlyArray<{ fans: ReadonlyArray<number | null> }>): Array<number | null> {
  return Array.from({ length: SLOT_COUNT }, (_, position) => sumKnown(rows.map((row) => row.fans[position] ?? null)));
}

/** «2 дня без фанов»: the series' last known days are zero (two or more), and a fan came earlier. */
export function quietDaysNote(series: ReadonlyArray<number | null>): string | null {
  const knownDays = series.filter((value): value is number => value !== null);
  let zeros = 0;
  while (zeros < knownDays.length && knownDays[knownDays.length - 1 - zeros] === 0) zeros += 1;
  const hadFan = knownDays.slice(0, knownDays.length - zeros).some((value) => value > 0);
  if (zeros < 2 || !hadFan) return null;
  return `${zeros} ${ruPlural(zeros, "день", "дня", "дней")} без фанов`;
}

/** The rows of a source: one link with fans — its chart is the large one; two
 *  and more — «Все N ссылок» first, large, then a small row per link. */
export function sourceRows(links: readonly LinkDays[]): SourceRow[] {
  const rows = links
    .map((link) => ({ key: link.key, name: link.name, large: false, fans: link.fans, total: known(link.fans) }))
    .sort(byFansThenName);
  const withFans = rows.filter((row) => row.total > 0);
  if (withFans.length === 1) {
    return rows.map((row) => (row === withFans[0] ? { ...row, large: true } : row));
  }
  if (withFans.length >= 2) {
    const fans = combinedSeries(rows);
    return [
      { key: "all", name: `Все ${rows.length} ${ruPlural(rows.length, "ссылка", "ссылки", "ссылок")}`, large: true, fans, total: known(fans) },
      ...rows,
    ];
  }
  return rows;
}

function contractorOf(channel: Channel): string | null {
  const terms = [...channel.contractors].sort((left, right) =>
    (left.validTo === null ? 1 : 0) - (right.validTo === null ? 1 : 0) || left.validFrom.localeCompare(right.validFrom));
  return terms.at(-1)?.contractorTitle ?? null;
}

export function sourcesView(recent: Channels, allTime: Channels | undefined, today: MoscowDay): SourcesView {
  const slots = daySlots(today);
  const from = slots[0]!.date;
  const to = slots[SLOT_COUNT - 1]!.date;
  const brought = new Map((allTime?.channels ?? []).map((channel) => [channel.channelKey, channel.totals.vendorNetMills]));
  const sources: SourceView[] = [];
  const idle: string[] = [];
  let unbound: string | null = null;
  let dataAt: string | null = null;

  for (const channel of recent.channels) {
    for (const segment of channel.segments) {
      if (dataAt === null || segment.endObservedAt > dataAt) dataAt = segment.endObservedAt;
    }
    const links = linkDays(channel.segments, slots, recent.range.fromAt);
    const active = links.filter((link) => known(link.fans) > 0 || known(link.clicks) > 0 || link.createdInRange);
    const fans = links.reduce((sum, link) => sum + known(link.fans), 0);
    if (channel.channelKey === null) {
      if (links.length > 0) {
        unbound = `${links.length} ${ruPlural(links.length, "ссылка", "ссылки", "ссылок")} · ${fans} ${ruPlural(fans, "фан", "фана", "фанов")} за 2 недели`;
      }
      continue;
    }
    const title = channel.channelTitle ?? channel.channelKey;
    if (fans === 0 && links.every((link) => known(link.clicks) === 0)) {
      idle.push(title);
      continue;
    }
    const rows = sourceRows(active);
    const small = rows.filter((row) => !row.large).flatMap((row) => row.fans.filter((value): value is number => value !== null));
    const quietLinks = links.filter((link) => !active.includes(link)).map((link) => link.name).sort((left, right) => left.localeCompare(right, "ru"));
    sources.push({
      key: channel.channelKey,
      title,
      contractor: contractorOf(channel),
      attention: quietDaysNote(combinedSeries(active)),
      broughtMills: brought.get(channel.channelKey) ?? null,
      rows,
      smallMax: Math.max(2, ...small),
      quiet: quietLinks.length > 0 ? `ещё ${quietLinks.length} без кликов: ${quietLinks.join(", ")}` : null,
      fans,
    });
  }
  // A channel the two weeks have no segment of is known only to the all-time read.
  const recentKeys = new Set(recent.channels.map((channel) => channel.channelKey));
  for (const channel of allTime?.channels ?? []) {
    if (channel.channelKey !== null && !recentKeys.has(channel.channelKey)) idle.push(channel.channelTitle ?? channel.channelKey);
  }
  sources.sort((left, right) => right.fans - left.fans || left.title.localeCompare(right.title, "ru"));
  idle.sort((left, right) => left.localeCompare(right, "ru"));

  return {
    from,
    to,
    slots,
    lastWeek: weekRange(from, addDays(from, 6)),
    thisWeek: weekRange(addDays(from, 7), to),
    dataAt,
    sources,
    unbound,
    idle,
  };
}
