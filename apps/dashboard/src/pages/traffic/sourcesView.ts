import type { OfLinkChannelsResponse } from "@agency_hub_core/contracts";
import { addDays, mondayOf, moscowDayOf, type MoscowDay } from "@agency_hub_core/ui/moscow";
import { formatMills } from "@/lib/format";
import {
  arrivalOf,
  clicksWord,
  dayHint,
  dayMonth,
  daySlots,
  fansWord,
  sumKnown,
  weekRange,
  type DaySlot,
  type LinkTarget,
} from "./trafficDays.js";

// Трафик → Источники: what the screen draws, from two reads of the channels'
// totals (`ofLinksChannelsGet`): the last two Moscow weeks with every
// segment's days, and all the series has. Pure: the days come from the
// response's own range. The component only draws what this returns.

type Channels = OfLinkChannelsResponse;
type Channel = Channels["channels"][number];
type Segment = Channel["segments"][number];
type Term = Channel["contractors"][number];

/** Two weeks, Monday to Sunday twice: the one grid every chart of the page shares. */
export const SLOT_COUNT = 14;

/** A chart row: a link that brought a fan, or the source's links together («Всего»). */
export interface SourceRow {
  key: string;
  name: string;
  /** The link's page, said when the source's links are on more than one page. */
  page: string | null;
  /** The large chart (its own scale, a soft area), or a small one (the source's shared scale). */
  large: boolean;
  /** New fans per slot; null: unknown (no read, no baseline), or a day to come. */
  fans: ReadonlyArray<number | null>;
  /** The hover hint of each slot; null for a day to come. */
  hints: ReadonlyArray<string | null>;
  /** The known days' sum; null: no day is known. */
  total: number | null;
  /** The link's page; null for «Всего». */
  link: LinkTarget | null;
}

export interface WeekSum {
  /** Fans of the week's known days; null: none is known. */
  fans: number | null;
  /** The week is still going. */
  running: boolean;
}

export interface SourceMoney {
  /** What the open term brought on this source over the two weeks. */
  recentMills: number;
  /** Over all the series has; null: that read is not here. */
  allMills: number | null;
  /** Some link's money is unknown: the figure leaves it out. */
  partial: boolean;
}

export interface SourceView {
  key: string;
  title: string;
  /** «Студия, с 11 ноября»: the contractor whose term is open; null: none. */
  contractor: string | null;
  /** «с 16 ноября без фанов». */
  attention: string | null;
  money: SourceMoney | null;
  weeks: [WeekSum, WeekSum];
  rows: SourceRow[];
  /** The scale of the small rows: their largest value, at least 2. */
  smallMax: number;
  /** «Фанов нет: A (новая, 2 клика), B (3 клика)». */
  noFans: string | null;
  /** «Без кликов: A, B». */
  noClicks: string | null;
  fans: number;
}

/** A line at the bottom: name left, fact middle, figures right. */
export interface RestLine {
  key: string;
  name: string;
  fact: string | null;
  figures: string[];
}

export interface SourcesView {
  /** Monday of the previous week … Sunday of this one. */
  from: MoscowDay;
  to: MoscowDay;
  slots: DaySlot[];
  /** «9–15 ноября». */
  lastWeek: string;
  thisWeek: string;
  /** «с 9 ноября»: the totals column's caption. */
  since: string;
  /** The latest snapshot the deltas rest on. */
  dataAt: string | null;
  /** The pages the reads cover. */
  pages: string[];
  sources: SourceView[];
  /** Sources whose contractor term is open and that brought no fan. */
  silent: RestLine[];
  /** Sources whose links never had a click: they work past the links. */
  linkless: RestLine[];
  /** Sources with no open term and no fan: what they brought over all time. */
  stopped: RestLine[];
  /** Sources the two weeks have not one read of. */
  unread: RestLine[];
  /** Links without a source that moved; then how many did not. */
  unbound: { lines: RestLine[]; rest: number } | null;
}

/** The range the screen asks for: Monday of the previous Moscow week to today. */
export function sourcesRange(today: MoscowDay): { from: MoscowDay; to: MoscowDay } {
  return { from: addDays(mondayOf(today), -7), to: today };
}

const linkKeyOf = (segment: Segment) => `${segment.pageId}:${segment.linkKind}:${segment.linkRef}`;
const nameOf = (segment: Segment) => segment.name?.trim() || `Ссылка ${segment.linkRef}`;

interface LinkDays {
  key: string;
  name: string;
  page: string;
  target: LinkTarget;
  fans: Array<number | null>;
  clicks: Array<number | null>;
  money: Array<number | null>;
  /** Made at OnlyFans inside the two weeks. */
  createdInRange: boolean;
}

/** A link's segments of one channel merged by day; a day no segment knows stays null. */
function linkDays(segments: readonly Segment[], slots: readonly DaySlot[], rangeFromAt: string): LinkDays[] {
  const index = new Map(slots.map((slot, position) => [slot.date, position]));
  const links = new Map<string, LinkDays>();
  for (const segment of segments) {
    const key = linkKeyOf(segment);
    let link = links.get(key);
    if (!link) {
      link = {
        key,
        name: nameOf(segment),
        page: segment.pageLabel,
        target: { pageId: segment.pageId, linkKind: segment.linkKind, linkRef: segment.linkRef },
        fans: slots.map(() => null),
        clicks: slots.map(() => null),
        money: slots.map(() => null),
        createdInRange: false,
      };
      links.set(key, link);
    }
    const young = segment.linkCreatedAt !== null && segment.linkCreatedAt >= rangeFromAt;
    if (young) link.createdInRange = true;
    for (const day of segment.days ?? []) {
      const position = index.get(day.businessDate);
      if (position === undefined || slots[position]!.when === "future") continue;
      const fans = arrivalOf(day.fans, day.flags, young);
      if (fans === null) continue;
      // A day's money is known when every part of the day that is known knew it.
      const money = day.flags.includes("money_unknown") ? null : arrivalOf(day.vendorNetMills, day.flags, young);
      const before = link.money[position] ?? null;
      link.money[position] = link.fans[position] === null ? money : before === null || money === null ? null : before + money;
      link.fans[position] = (link.fans[position] ?? 0) + fans;
      link.clicks[position] = sumKnown([link.clicks[position] ?? null, arrivalOf(day.clicks, day.flags, young)]);
    }
  }
  return [...links.values()];
}

/** The per-slot sum of series: the known values of each slot, null when none is known. */
export function combinedSeries(series: ReadonlyArray<ReadonlyArray<number | null>>): Array<number | null> {
  return Array.from({ length: SLOT_COUNT }, (_, position) => sumKnown(series.map((values) => values[position] ?? null)));
}

/** A slot's money over several links: unknown as soon as one link with a known day does not know it. */
function combinedMoney(links: readonly LinkDays[]): Array<number | null> {
  return Array.from({ length: SLOT_COUNT }, (_, position) => {
    let sum = 0;
    for (const link of links) {
      if (link.fans[position] === null) continue;
      const money = link.money[position];
      if (money === null || money === undefined) return null;
      sum += money;
    }
    return sum;
  });
}

const known = (values: ReadonlyArray<number | null>) => sumKnown(values) ?? 0;

/** «с 16 ноября без фанов»: the finished days since the last fan of the two
 *  weeks, when two or more of them are known; «ни кликов, ни фанов» when they
 *  had no click either. Today is not finished and never counts. */
export function quietSinceNote(slots: readonly DaySlot[], fans: ReadonlyArray<number | null>, clicks: ReadonlyArray<number | null>): string | null {
  const finished = slots.filter((slot) => slot.when === "past").length;
  let lastFan = -1;
  for (let position = 0; position < finished; position += 1) {
    if ((fans[position] ?? 0) > 0) lastFan = position;
  }
  if (lastFan < 0) return null;
  const after = Array.from({ length: finished - lastFan - 1 }, (_, offset) => lastFan + 1 + offset);
  const knownAfter = after.filter((position) => fans[position] !== null && fans[position] !== undefined);
  if (knownAfter.length < 2) return null;
  const since = dayMonth(slots[lastFan + 1]!.date);
  const clicked = after.some((position) => (clicks[position] ?? 0) > 0);
  return clicked ? `с ${since} без фанов` : `с ${since} ни кликов, ни фанов`;
}

/** The rows of a source: a chart row is a link that brought a fan. One such
 *  link — its chart is the large one; two and more — «Всего» first, large,
 *  over every link of the source, then a small row per link. */
function sourceRows(links: readonly LinkDays[], slots: readonly DaySlot[], manyPages: boolean): SourceRow[] {
  const rowOf = (link: LinkDays): SourceRow => ({
    key: link.key,
    name: link.name,
    page: manyPages ? link.page : null,
    large: false,
    fans: link.fans,
    hints: slots.map((slot, position) => dayHint(slot, { fans: link.fans[position] ?? null, clicks: link.clicks[position] ?? null, money: link.money[position] ?? null })),
    total: sumKnown(link.fans),
    link: link.target,
  });
  const rows = links
    .filter((link) => known(link.fans) > 0)
    .map(rowOf)
    .sort((left, right) => (right.total ?? 0) - (left.total ?? 0) || left.name.localeCompare(right.name, "ru"));
  if (rows.length === 1) return [{ ...rows[0]!, large: true }];
  if (rows.length === 0) return [];
  const fans = combinedSeries(links.map((link) => link.fans));
  const clicks = combinedSeries(links.map((link) => link.clicks));
  const money = combinedMoney(links);
  return [
    {
      key: "all",
      name: "Всего",
      page: null,
      large: true,
      fans,
      hints: slots.map((slot, position) => dayHint(slot, { fans: fans[position] ?? null, clicks: clicks[position] ?? null, money: money[position] ?? null })),
      total: sumKnown(fans),
      link: null,
    },
    ...rows,
  ];
}

const byName = (left: string, right: string) => left.localeCompare(right, "ru");

/** The term open at the end of the range (no end, or an end after it). */
function openTerm(channel: Channel | undefined, toAt: string): Term | null {
  return channel?.contractors.find((term) => term.validTo === null || term.validTo > toAt) ?? null;
}

const sameTerm = (left: Term, right: Term) => left.contractorKey === right.contractorKey && left.validFrom === right.validFrom;

export function sourcesView(recent: Channels, allTime: Channels | undefined): SourcesView {
  const from = recent.range.from;
  const today = recent.range.to;
  const slots = daySlots(from, SLOT_COUNT, today);
  const to = slots[SLOT_COUNT - 1]!.date;
  const since = `с ${dayMonth(from)}`;
  const allByKey = new Map((allTime?.channels ?? []).map((channel) => [channel.channelKey, channel]));
  const recentByKey = new Map(recent.channels.map((channel) => [channel.channelKey, channel]));
  const sources: SourceView[] = [];
  const silent: RestLine[] = [];
  const linkless: RestLine[] = [];
  const stopped: RestLine[] = [];
  const unread: RestLine[] = [];
  let unbound: SourcesView["unbound"] = null;
  let dataAt: string | null = null;
  const pages = new Set<string>();

  for (const channel of [...recent.channels, ...(allTime?.channels ?? [])]) {
    for (const segment of channel.segments) pages.add(segment.pageLabel);
  }
  for (const channel of recent.channels) {
    for (const segment of channel.segments) {
      if (dataAt === null || segment.endObservedAt > dataAt) dataAt = segment.endObservedAt;
    }
  }

  const keys = [...new Set([...recentByKey.keys(), ...allByKey.keys()])];
  for (const key of keys) {
    const channel = recentByKey.get(key);
    const ever = allByKey.get(key);
    const links = channel ? linkDays(channel.segments, slots, recent.range.fromAt) : [];
    const fans = links.reduce((sum, link) => sum + known(link.fans), 0);
    const clicks = links.reduce((sum, link) => sum + known(link.clicks), 0);

    if (key === null) {
      const moved = links.filter((link) => known(link.fans) > 0 || known(link.clicks) > 0)
        .sort((left, right) => known(right.fans) - known(left.fans) || known(right.clicks) - known(left.clicks) || byName(left.name, right.name));
      if (links.length > 0) {
        unbound = {
          lines: moved.map((link) => ({
            key: link.key,
            name: link.name,
            fact: link.page,
            figures: [`${clicksWord(known(link.clicks))}, ${fansWord(known(link.fans))} ${since}`],
          })),
          rest: links.length - moved.length,
        };
      }
      continue;
    }

    const title = channel?.channelTitle ?? ever?.channelTitle ?? key;
    const term = openTerm(channel ?? ever, recent.range.toAt);
    const contractor = term === null ? null : `${term.contractorTitle}, с ${dayMonth(moscowDayOf(term.validFrom), today)}`;

    if (fans > 0) {
      const combinedFans = combinedSeries(links.map((link) => link.fans));
      const combinedClicks = combinedSeries(links.map((link) => link.clicks));
      const rows = sourceRows(links, slots, new Set(links.map((link) => link.page)).size > 1);
      const small = rows.filter((row) => !row.large).flatMap((row) => row.fans.filter((value): value is number => value !== null));
      const rowKeys = new Set(rows.map((row) => row.key));
      const quiet = links.filter((link) => !rowKeys.has(link.key));
      const noFans = quiet
        .filter((link) => known(link.clicks) > 0 || link.createdInRange)
        .sort((left, right) => known(right.clicks) - known(left.clicks) || byName(left.name, right.name))
        .map((link) => `${link.name} (${link.createdInRange ? "новая, " : ""}${clicksWord(known(link.clicks))})`);
      const noClicks = quiet
        .filter((link) => known(link.clicks) === 0 && !link.createdInRange)
        .map((link) => link.name)
        .sort(byName);
      const recentTerm = term === null ? null : channel?.contractors.find((item) => sameTerm(item, term)) ?? null;
      const everTerm = term === null ? null : ever?.contractors.find((item) => sameTerm(item, term)) ?? null;
      sources.push({
        key,
        title,
        contractor,
        attention: quietSinceNote(slots, combinedFans, combinedClicks),
        money: recentTerm === null ? null : {
          recentMills: recentTerm.totals.vendorNetMills,
          allMills: everTerm?.totals.vendorNetMills ?? null,
          partial: recentTerm.flags.includes("money_unknown") || (everTerm?.flags.includes("money_unknown") ?? false),
        },
        weeks: [
          { fans: sumKnown(combinedFans.slice(0, 7)), running: slots.slice(0, 7).some((slot) => slot.when === "today") },
          { fans: sumKnown(combinedFans.slice(7, 14)), running: slots.slice(7, 14).some((slot) => slot.when === "today") },
        ],
        rows,
        smallMax: Math.max(2, ...small),
        noFans: noFans.length > 0 ? `Фанов нет: ${noFans.join(", ")}` : null,
        noClicks: noClicks.length > 0 ? `Без кликов: ${noClicks.join(", ")}` : null,
        fans,
      });
      continue;
    }

    // Not a source on the chart: which of the facts at the bottom it is.
    if (ever !== undefined && ever.totals.clicks === 0 && clicks === 0) {
      linkless.push({ key, name: title, fact: "здесь не виден", figures: [] });
    } else if (channel !== undefined && !links.some((link) => link.fans.some((value) => value !== null))) {
      unread.push({ key, name: title, fact: contractor, figures: [`нет чтений ${since}`] });
    } else if (term !== null) {
      const paid = channel?.totals.vendorNetMills ?? 0;
      silent.push({
        key,
        name: title,
        fact: contractor,
        figures: [clicksWord(clicks), ...(paid > 0 ? [`${formatMills(paid)} от прежних фанов`] : [])],
      });
    } else {
      const brought = ever?.totals.vendorNetMills ?? null;
      // The last term that ended: whose the source was.
      const last = [...(channel ?? ever)?.contractors ?? [], ...(ever?.contractors ?? [])]
        .filter((item) => item.validTo !== null)
        .sort((left, right) => left.validTo!.localeCompare(right.validTo!))
        .at(-1);
      stopped.push({
        key,
        name: title,
        fact: last ? `${last.contractorTitle}, до ${dayMonth(moscowDayOf(last.validTo!), today)}` : null,
        figures: brought === null ? [] : [
          `принесли ${formatMills(brought)}`,
          ...(ever?.flags.includes("money_unknown") ? ["не по всем ссылкам"] : []),
        ],
      });
    }
  }

  sources.sort((left, right) =>
    Number(right.attention !== null) - Number(left.attention !== null)
    || right.fans - left.fans
    || byName(left.title, right.title));
  for (const list of [silent, linkless, stopped, unread]) list.sort((left, right) => byName(left.name, right.name));

  return {
    from,
    to,
    slots,
    lastWeek: weekRange(from, addDays(from, 6)),
    thisWeek: weekRange(addDays(from, 7), to),
    since,
    dataAt,
    pages: [...pages].sort(byName),
    sources,
    silent,
    linkless,
    stopped,
    unread,
    unbound,
  };
}

/** «a», «a и b», «a, b и c». */
function joinAnd(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} и ${items.at(-1)}`;
}

/** What the reads cover, from their own pages and the models the console knows
 *  them by: «Мия · mia-of и mia-vip-of». Null: no page. */
export function coverageLine(pages: readonly string[], modelOf: (page: string) => string | null): string | null {
  if (pages.length === 0) return null;
  const byModel = new Map<string, string[]>();
  for (const page of pages) {
    const model = modelOf(page) ?? "";
    byModel.set(model, [...(byModel.get(model) ?? []), page]);
  }
  return [...byModel].map(([model, labels]) => (model ? `${model} · ${joinAnd(labels)}` : joinAnd(labels))).join("; ");
}
