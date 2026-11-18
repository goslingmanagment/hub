import type { OfLink, OfLinkChannelsResponse } from "@agency_hub_core/contracts";
import { addDays, mondayOf, moscowDayOf, type MoscowDay } from "@agency_hub_core/ui/moscow";
import { formatDayRange, formatMills } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { linkStateView } from "@/pages/marketing/ofLinksView";
import { combinedSeries, counterSeries, linkDays, openTerm, paidFigureOf, type Channel, type PaidFigure, type Term } from "./sourcesView.js";
import {
  clicksWord,
  dayHint,
  dayMonth,
  daySlots,
  fansWord,
  linkPagePath,
  subscribersWord,
  sumKnown,
  weekFigure,
  weekText,
  unreadWords,
  type DaySlot,
  type WeekFigure,
} from "./trafficDays.js";

// The page of one source (Трафик → Источники → a source): what it is, what it brought against what its contractor
// was paid, its days over eight weeks, its links, the journal's payments and, when it had several, its contractors.
// From two reads of the channels (`ofLinksChannelsGet` with `channelKey`): eight weeks with their days, and all the
// series has with what was paid; and the links' latest read (`ofLinksGet`) for their state. Pure.

type Channels = OfLinkChannelsResponse;
type Payment = NonNullable<Channel["payments"]>[number];

export const SOURCE_WEEKS = 8;
/** Payments shown before «Показать все». */
export const SOURCE_PAYMENTS_SHOWN = 12;

export type SourceMetric = "fans" | "clicks" | "money";

/** Eight Moscow weeks ending with the current one: Monday seven weeks back to today. */
export function sourceRange(today: MoscowDay): { from: MoscowDay; to: MoscowDay } {
  return { from: addDays(mondayOf(today), -7 * (SOURCE_WEEKS - 1)), to: today };
}

export interface SourceFigure {
  /** null: unknown — the word alone says so. */
  value: string | null;
  word: string;
  /** Quiet words after the figure. */
  flag: string | null;
}

export interface SourceWeek {
  /** «3–9 нояб.». */
  label: string;
  figure: WeekFigure;
  /** «12 фанов», «нет чтения» (the running week says «идёт» by its dates). */
  text: string;
  /** «2 дня без чтения» under it; null: every finished day was read (or none of it is known). */
  note: string | null;
}

export interface SourceChart {
  slots: DaySlot[];
  values: Array<number | null>;
  hints: Array<string | null>;
  max: number;
  weeks: SourceWeek[];
}

export interface SourceLinkRow {
  key: string;
  name: string;
  to: string;
  page: string;
  /** «Активна до 5 июл.», «Истекла 1 окт.»; null: the links' read does not have it. */
  state: string | null;
  clicks: string;
  fans: string;
  brought: string;
  /** Never had a click. */
  quiet: boolean;
}

export interface SourcePaymentRow {
  key: string;
  /** «18 ноября». */
  date: string;
  /** «$900.00», «−$150.00», «1 200.00 EUR». */
  amount: string;
  refund: boolean;
  pending: boolean;
  note: string | null;
  /** Several contractors: whose. */
  contractor: string | null;
}

export type SourcePayments =
  | { state: "rows"; rows: SourcePaymentRow[] }
  /** «У подрядчика не указано имя в журнале» / «Журнал не отвечает» / no contractor at all. */
  | { state: "quiet"; text: string | null };

export interface SourceContractorRow {
  key: string;
  name: string;
  /** «16 сент. – 11 нояб.», «с 11 нояб.». */
  when: string;
  fans: string;
  brought: string;
  paid: string;
}

export interface SourcePageView {
  title: string;
  /** «Maple Media, с 11 ноября», «остановлен 1 октября»; the pages; the term's note. */
  facts: string[];
  counter: boolean;
  figures: SourceFigure[];
  /** «28 кликов»; null for a source counted by its page's subscribers. */
  clicks: string | null;
  links: SourceLinkRow[];
  payments: SourcePayments;
  /** Only when the source had more than one term. */
  contractors: SourceContractorRow[];
  dataAt: string | null;
}

const byName = (left: string, right: string) => left.localeCompare(right, "ru");
const linkKeyOf = (link: { pageId: number; linkKind: string; linkRef: string }) => `${link.pageId}:${link.linkKind}:${link.linkRef}`;

/** What the source's contractors were paid together: one contractor's figure, or the sum of the known ones. */
export function sourcePaid(terms: readonly Term[]): PaidFigure | null {
  const seen = new Set<string>();
  const figures: PaidFigure[] = [];
  for (const term of terms) {
    if (seen.has(term.contractorKey)) continue;
    seen.add(term.contractorKey);
    const figure = paidFigureOf(term.paid);
    if (figure !== null) figures.push(figure);
  }
  if (figures.length === 0) return null;
  const known = figures.filter((figure) => figure.state === "known");
  if (known.length === 0) return figures[0]!;
  return {
    state: "known",
    mills: known.reduce((sum, figure) => sum + (figure.mills ?? 0), 0),
    shared: figures.some((figure) => figure.shared),
    otherCurrency: figures.some((figure) => figure.otherCurrency),
  };
}

const paidFlag = (paid: PaidFigure) =>
  [...(paid.shared ? ["по всем его источникам"] : []), ...(paid.otherCurrency ? ["часть в другой валюте"] : [])].join(", ") || null;

function paidFigure(paid: PaidFigure | null): SourceFigure[] {
  if (paid === null) return [];
  if (paid.state === "unavailable") return [{ value: null, word: "заплачено: журнал не отвечает", flag: null }];
  return [{ value: formatMills(paid.mills ?? 0), word: "заплачено", flag: paidFlag(paid) }];
}

/** The chart of eight weeks: fans, clicks or money a day over every link of the source; a counter source's
 *  subscribers. */
export function sourceChart(recent: Channels, metric: SourceMetric): SourceChart {
  const count = SOURCE_WEEKS * 7;
  const slots = daySlots(recent.range.from, count, recent.range.to);
  const channel = recent.channels[0];
  let values: Array<number | null>;
  let hints: Array<string | null>;
  let unread: boolean[];
  let word: (value: number) => string;
  if (channel?.counterPage) {
    ({ values, hints, unread } = counterSeries(channel, slots));
    word = subscribersWord;
  } else {
    const links = linkDays(channel?.segments ?? [], slots, recent.range.fromAt);
    const fans = combinedSeries(links.map((link) => link.fans), count);
    const clicks = combinedSeries(links.map((link) => link.clicks), count);
    const spenders = combinedSeries(links.map((link) => link.spenders), count);
    const money = slots.map((_, position) => {
      let sum: number | null = null;
      for (const link of links) {
        if (link.fans[position] === null) continue;
        const value = link.money[position];
        if (value === null || value === undefined) return null;
        sum = (sum ?? 0) + value;
      }
      return sum;
    });
    const series = { fans, clicks, money };
    values = series[metric];
    hints = slots.map((slot, position) => dayHint(slot, {
      fans: fans[position] ?? null, clicks: clicks[position] ?? null, money: money[position] ?? null, spenders: spenders[position] ?? null,
    }));
    unread = slots.map((_, position) => links.some((link) => link.unread[position]));
    word = metric === "fans" ? fansWord : metric === "clicks" ? clicksWord : formatMills;
  }
  const weeks = Array.from({ length: SOURCE_WEEKS }, (_, week) => {
    const part = slots.slice(week * 7, week * 7 + 7);
    const figure = weekFigure(part, values.slice(week * 7, week * 7 + 7), unread.slice(week * 7, week * 7 + 7));
    return {
      label: formatDayRange(part[0]!.date, part[6]!.date),
      figure,
      text: weekText(figure.sum === null ? figure : { ...figure, unread: 0, running: false }, word),
      note: figure.sum === null ? null : unreadWords(figure),
    };
  });
  return {
    slots,
    values,
    hints,
    max: Math.max(metric === "money" ? 1000 : 2, ...values.map((value) => value ?? 0)),
    weeks,
  };
}

function amountText(payment: Payment): string {
  const dollars = ["USD", "USDT", "USDC"].includes(payment.currency);
  const magnitude = Math.abs(payment.amountMills);
  const text = dollars
    ? formatMills(magnitude)
    : `${(magnitude / 1000).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${payment.currency}`;
  return payment.amountMills < 0 ? `−${text}` : text;
}

function sourcePayments(channel: Channel | undefined, terms: readonly Term[], today: MoscowDay): SourcePayments {
  if (terms.length === 0) return { state: "quiet", text: null };
  const states = [...new Map(terms.map((term) => [term.contractorKey, term.paid])).values()];
  if (channel?.payments === null || channel?.payments === undefined) {
    return {
      state: "quiet",
      text: states.some((paid) => paid?.reason === "ledger_unavailable") || states.every((paid) => paid === null)
        ? "Журнал не отвечает"
        : "У подрядчика не указано имя в журнале",
    };
  }
  if (channel.payments.length === 0) {
    return {
      state: "quiet",
      text: states.every((paid) => paid?.reason === "no_ledger_names") ? "У подрядчика не указано имя в журнале" : "Оплат в журнале нет",
    };
  }
  const several = new Set(channel.payments.map((payment) => payment.contractorKey)).size > 1;
  return {
    state: "rows",
    rows: channel.payments.map((payment) => ({
      key: `${payment.contractorKey}:${payment.num}`,
      date: dayMonth(payment.date, today),
      amount: amountText(payment),
      refund: payment.amountMills < 0,
      pending: payment.status === "pending",
      note: payment.note,
      contractor: several ? payment.contractorTitle : null,
    })),
  };
}

/** «с 11 нояб.», «16 сент. – 11 нояб.» (a term's end is exclusive: its last day is the day before). */
function termWhen(term: Term, today: MoscowDay): string {
  const from = moscowDayOf(term.validFrom);
  if (term.validTo === null) return `с ${dayMonth(from, today)}`;
  const to = addDays(moscowDayOf(term.validTo), -1);
  return `${dayMonth(from, today)} – ${dayMonth(to < from ? from : to, today)}`;
}

export function sourcePageView(input: {
  channelKey: string;
  recent: Channels;
  allTime: Channels | undefined;
  links: readonly OfLink[] | undefined;
  /** The pages' labels by id (the links' read). */
  pageLabels: ReadonlyMap<number, string>;
}): SourcePageView {
  const { recent, allTime } = input;
  const today = recent.range.to;
  const channel = recent.channels[0];
  const ever = allTime?.channels[0];
  const title = channel?.channelTitle ?? ever?.channelTitle ?? input.channelKey;
  const counterPage = channel?.counterPage ?? ever?.counterPage ?? null;
  const allTerms = ever?.contractors ?? channel?.contractors ?? [];
  const term = openTerm(ever ?? channel, recent.range.toAt);

  // The links: those bound to it now, and every one its stretches over all time had.
  const segments = ever?.segments ?? [];
  const bound = (input.links ?? []).filter((link) => link.binding?.channelKey === input.channelKey);
  const keys = new Set([...segments.map(linkKeyOf), ...bound.map(linkKeyOf)]);
  const recentFans = new Map<string, number>();
  for (const segment of channel?.segments ?? []) {
    recentFans.set(linkKeyOf(segment), (recentFans.get(linkKeyOf(segment)) ?? 0) + (segment.fans ?? 0));
  }
  const links: Array<SourceLinkRow & { recent: number }> = [...keys].map((key) => {
    const own = segments.filter((segment) => linkKeyOf(segment) === key);
    const latest = (input.links ?? []).find((link) => linkKeyOf(link) === key);
    const first = own[0];
    const clicks = own.reduce((sum, segment) => sum + segment.clicks, 0);
    const fans = own.reduce((sum, segment) => sum + (segment.fans ?? 0), 0);
    const brought = sumKnown(own.map((segment) => segment.vendorNetMills));
    const state = latest ? linkStateView(latest) : null;
    const target = first ?? latest!;
    return {
      key,
      name: (first?.name ?? latest?.name)?.trim() || `Ссылка ${target.linkRef}`,
      to: linkPagePath({ pageId: target.pageId, linkKind: target.linkKind, linkRef: target.linkRef }),
      page: first?.pageLabel ?? input.pageLabels.get(target.pageId) ?? "",
      state: state === null ? null : `${state.label}${state.detail ? ` ${state.detail}` : ""}`,
      clicks: clicks.toLocaleString("ru-RU"),
      fans: fans.toLocaleString("ru-RU"),
      brought: brought === null ? "—" : formatMills(brought),
      quiet: clicks === 0 && (latest?.clicks ?? 0) === 0,
      recent: recentFans.get(key) ?? 0,
    };
  }).sort((left, right) => Number(right.recent > 0) - Number(left.recent > 0) || byName(left.name, right.name));

  const pages = [...new Set([
    ...(counterPage ? [counterPage.label] : []),
    ...segments.map((segment) => segment.pageLabel),
    ...(channel?.segments ?? []).map((segment) => segment.pageLabel),
  ])].sort(byName);
  const lastEnded = [...allTerms].filter((item) => item.validTo !== null).sort((left, right) => left.validTo!.localeCompare(right.validTo!)).at(-1);
  const facts = [
    ...(term !== null
      ? [`${term.contractorTitle}, с ${dayMonth(moscowDayOf(term.validFrom), today)}`]
      : lastEnded ? [`остановлен ${dayMonth(moscowDayOf(lastEnded.validTo!), today)}`] : []),
    ...(pages.length > 0 ? [pages.join(", ")] : []),
    ...(term?.note ? [term.note] : []),
  ];

  const paid = sourcePaid(allTerms);
  let figures: SourceFigure[];
  let clicks: string | null = null;
  if (counterPage !== null) {
    const counted = sumKnown((ever?.counterDays ?? []).map((day) => day.newSubscribers));
    figures = [
      counted === null
        ? { value: null, word: "подписчиков не знаем", flag: null }
        : { value: counted.toLocaleString("ru-RU"), word: ruPlural(counted, "подписчик", "подписчика", "подписчиков"), flag: null },
      ...paidFigure(paid),
    ];
  } else {
    const totals = ever?.totals ?? channel?.totals;
    const fans = totals?.fans ?? null;
    figures = [
      fans === null
        ? { value: null, word: "фанов не знаем", flag: null }
        : { value: fans.toLocaleString("ru-RU"), word: ruPlural(fans, "фан", "фана", "фанов"), flag: null },
      totals === undefined
        ? { value: null, word: "доход неизвестен", flag: null }
        : { value: formatMills(totals.vendorNetMills), word: "принесли", flag: ever?.flags.includes("money_unknown") ? "не по всем ссылкам" : null },
      ...paidFigure(paid),
    ];
    clicks = totals === undefined ? null : clicksWord(totals.clicks);
  }

  const contractors: SourceContractorRow[] = allTerms.length > 1
    ? allTerms.map((item) => {
      const figure = paidFigureOf(item.paid);
      return {
        key: `${item.contractorKey}:${item.validFrom}`,
        name: item.contractorTitle,
        when: termWhen(item, today),
        fans: fansWord(item.totals.fans),
        brought: `принесли ${formatMills(item.totals.vendorNetMills)}`,
        paid: figure === null ? "—" : figure.state === "unavailable" ? "журнал не отвечает" : `заплачено ${formatMills(figure.mills ?? 0)}${figure.shared ? ", по всем его источникам" : ""}`,
      };
    })
    : [];

  let dataAt: string | null = null;
  for (const segment of channel?.segments ?? []) {
    if (dataAt === null || segment.endObservedAt > dataAt) dataAt = segment.endObservedAt;
  }

  return {
    title,
    facts,
    counter: counterPage !== null,
    figures,
    clicks,
    links: links.map(({ recent: _recent, ...row }) => row),
    payments: sourcePayments(ever, allTerms, today),
    contractors,
    dataAt,
  };
}
