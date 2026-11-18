/**
 * Трафик → Источники: the OnlyFans links' totals by channel (`ofLinksChannelsGet`)
 * of the demo agency, live up to the latest collection window before the
 * request. Invented sources and links: one with three links of which one
 * brings fans, one with six working links and three quiet ones, one with a
 * single link born two days ago, one whose link the series missed for a while
 * (unknown days, then a day without a baseline), links without a channel and
 * two channels with no movement. Honours `from`, `to`, `pageId` and `days` as
 * the service does: a segment per link over the range, its days cut by it.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { between, demoError, iso, mills, queryString, rng, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DAY_MS, HOUR_MS, OF_PAGES, demoDigits, mskDayKey } from "./publish-of-common.ts";

type Channels = KernelOperationResponse<"ofLinksChannelsGet">;
type Channel = Channels["channels"][number];
type Segment = Channel["segments"][number];
type Flag = Segment["flags"][number];

const MSK_OFFSET_MS = 3 * HOUR_MS;
/** The series began this many days before today. */
const SERIES_DAYS = 56;

const CHANNELS = {
  x: { title: "X (Twitter)", contractor: ["promo-lab", "Promo Lab"] },
  reddit: { title: "Reddit", contractor: ["north-wind", "Студия «Северный ветер»"] },
  shoutouts: { title: "Шаутауты", contractor: ["shout-desk", "Шаут-деск"] },
  tiktok: { title: "TikTok", contractor: null },
  instagram: { title: "Instagram", contractor: null },
  telegram: { title: "Telegram-канал", contractor: null },
} as const;
type ChannelKey = keyof typeof CHANNELS;

interface LinkSeed {
  name: string;
  page: 0 | 1;
  kind: "tracking" | "trial";
  channel: ChannelKey | null;
  /** New fans a day, on average. */
  rate: number;
  /** Days before today the link was created; null: older than the series. */
  createdDaysAgo: number | null;
  /** The series first read it this many days ago (it missed it before). */
  firstReadDaysAgo?: number;
  /** No fans from this many days ago on (its source went quiet). */
  quietSinceDaysAgo?: number;
  /** Clicks, but never a fan. */
  clicksOnly?: boolean;
  /** Nothing at all in the last weeks. */
  idle?: boolean;
}

const LINKS: readonly LinkSeed[] = [
  { name: "X · ссылка в био", page: 0, kind: "tracking", channel: "x", rate: 3.2, createdDaysAgo: null, quietSinceDaysAgo: 1 },
  { name: "X · закреплённый пост", page: 0, kind: "tracking", channel: "x", rate: 0, createdDaysAgo: null, clicksOnly: true },
  { name: "X · второй аккаунт", page: 1, kind: "tracking", channel: "x", rate: 0, createdDaysAgo: 4, clicksOnly: true },

  { name: "Reddit · основной профиль", page: 0, kind: "tracking", channel: "reddit", rate: 1.6, createdDaysAgo: null },
  { name: "Reddit · промо-посты", page: 0, kind: "tracking", channel: "reddit", rate: 1.1, createdDaysAgo: null },
  { name: "Reddit · VIP", page: 1, kind: "tracking", channel: "reddit", rate: 0.9, createdDaysAgo: null },
  { name: "Пробные 7 дней · Reddit", page: 0, kind: "trial", channel: "reddit", rate: 0.8, createdDaysAgo: null },
  { name: "Reddit · кросспосты", page: 0, kind: "tracking", channel: "reddit", rate: 0.45, createdDaysAgo: null },
  { name: "Reddit · новый профиль", page: 1, kind: "tracking", channel: "reddit", rate: 0.6, createdDaysAgo: 9 },
  { name: "Reddit · архив", page: 0, kind: "tracking", channel: "reddit", rate: 0, createdDaysAgo: null, idle: true },
  { name: "Reddit · старый профиль", page: 0, kind: "tracking", channel: "reddit", rate: 0, createdDaysAgo: null, idle: true },
  { name: "Reddit · тест", page: 1, kind: "tracking", channel: "reddit", rate: 0, createdDaysAgo: null, idle: true },

  { name: "Шаутаут @luna.shares", page: 0, kind: "tracking", channel: "shoutouts", rate: 6, createdDaysAgo: 2 },

  { name: "TikTok · био", page: 0, kind: "tracking", channel: "tiktok", rate: 1.3, createdDaysAgo: null, firstReadDaysAgo: 6 },

  { name: "Instagram · сторис", page: 0, kind: "tracking", channel: "instagram", rate: 0, createdDaysAgo: null, idle: true },
  { name: "Telegram · закреп", page: 1, kind: "tracking", channel: "telegram", rate: 0, createdDaysAgo: null, idle: true },

  { name: "Пробные 30 дней · бывшие фаны", page: 0, kind: "trial", channel: null, rate: 1.4, createdDaysAgo: null },
  { name: "Ссылка с основной страницы", page: 1, kind: "tracking", channel: null, rate: 2.1, createdDaysAgo: null },
  { name: "Рассылка по фанам", page: 1, kind: "tracking", channel: null, rate: 0.5, createdDaysAgo: null },
];

/** UTC instant of Moscow midnight of a day key. */
const dayStartMs = (day: string) => Date.parse(`${day}T00:00:00Z`) - MSK_OFFSET_MS;
const nextDay = (day: string) => mskDayKey(dayStartMs(day) + DAY_MS);

/** The series' windows: 03, 09, 15 and 21 Moscow; the latest one at or before `at`. */
function windowAtOrBefore(at: number): number {
  const local = at + MSK_OFFSET_MS;
  const midnight = Math.floor(local / DAY_MS) * DAY_MS;
  const hours = (local - midnight) / HOUR_MS;
  const slot = hours < 3 ? -3 : Math.floor((hours - 3) / 6) * 6 + 3;
  return midnight + slot * HOUR_MS - MSK_OFFSET_MS;
}

interface DayFigures { fans: number; clicks: number; netMills: number }

/** What a link really took in on a Moscow day (before anything is read of it). */
function arrivals(seed: LinkSeed, index: number, day: string, today: string, daysAgo: number, todayShare: number): DayFigures {
  if (seed.idle) return { fans: 0, clicks: 0, netMills: 0 };
  const random = rng(`traffic-sources:${index}:${day}`);
  const share = day === today ? todayShare : 1;
  if (seed.clicksOnly) {
    const clicks = daysAgo <= 6 ? Math.round(between(random, 0, 4) * share) : 0;
    return { fans: 0, clicks, netMills: 0 };
  }
  const quiet = seed.quietSinceDaysAgo !== undefined && daysAgo <= seed.quietSinceDaysAgo;
  const young = seed.createdDaysAgo !== null && seed.createdDaysAgo <= 3;
  // A young link grows: its newest day is its best.
  const rate = young ? seed.rate * (seed.createdDaysAgo! - daysAgo + 1) / 2 : seed.rate;
  const fans = quiet ? 0 : Math.max(0, Math.round(rate * between(random, 0.1, 1.9) * share));
  const clicks = Math.round((fans * between(random, 5, 11) + between(random, 0, 6)) * share);
  return { fans, clicks, netMills: mills(fans * between(random, 6, 15)) };
}

interface ReadDay extends DayFigures {
  day: string;
  /** No reading before it, and the link is older than it: the value is all it had. */
  noBaseline: boolean;
}

interface LinkHistory {
  seed: LinkSeed;
  linkRef: string;
  pageId: number;
  pageLabel: string;
  createdAt: number | null;
  /** The first reading's instant. */
  firstReadAt: number;
  /** Every day from the first reading to today: what a day's delta shows. */
  days: ReadDay[];
}

function linkHistory(seed: LinkSeed, index: number, now: Date): LinkHistory {
  const today = mskDayKey(now);
  const latestRead = windowAtOrBefore(now.getTime());
  const todayShare = Math.max(0.15, (latestRead - dayStartMs(today)) / DAY_MS);
  const page = OF_PAGES[seed.page] ?? OF_PAGES[0]!;
  const createdDaysAgo = seed.createdDaysAgo;
  const createdAt = createdDaysAgo === null ? null : dayStartMs(today) - createdDaysAgo * DAY_MS + 11 * HOUR_MS;
  const firstReadDaysAgo = Math.min(seed.firstReadDaysAgo ?? SERIES_DAYS, createdDaysAgo ?? SERIES_DAYS);
  const firstDay = mskDayKey(dayStartMs(today) - firstReadDaysAgo * DAY_MS);
  const firstReadAt = createdAt !== null && firstReadDaysAgo === createdDaysAgo
    ? windowAtOrBefore(createdAt + 6 * HOUR_MS)
    : dayStartMs(firstDay) + 3 * HOUR_MS;
  // What it had before the first reading, when it is older than that.
  let carried = { fans: 0, clicks: 0, netMills: 0 };
  if (createdAt === null || createdAt < dayStartMs(firstDay)) {
    const random = rng(`traffic-sources:before:${index}`);
    const fans = seed.idle ? Math.round(between(random, 5, 30)) : Math.round(seed.rate * between(random, 25, 60));
    carried = { fans, clicks: fans * 9, netMills: mills(fans * 11) };
  }
  const days: ReadDay[] = [];
  for (let daysAgo = firstReadDaysAgo; daysAgo >= 0; daysAgo -= 1) {
    const day = mskDayKey(dayStartMs(today) - daysAgo * DAY_MS);
    const figures = arrivals(seed, index, day, today, daysAgo, todayShare);
    if (days.length === 0 && (createdAt === null || createdAt < dayStartMs(day))) {
      days.push({
        day,
        fans: figures.fans + carried.fans,
        clicks: figures.clicks + carried.clicks,
        netMills: figures.netMills + carried.netMills,
        noBaseline: true,
      });
    } else {
      days.push({ day, ...figures, noBaseline: false });
    }
  }
  return {
    seed,
    linkRef: demoDigits(`traffic-sources-ref:${index}`, 7),
    pageId: page.id,
    pageLabel: page.label,
    createdAt,
    firstReadAt,
    days,
  };
}

const sum = (days: readonly DayFigures[]) => days.reduce(
  (total, day) => ({ fans: total.fans + day.fans, clicks: total.clicks + day.clicks, netMills: total.netMills + day.netMills }),
  { fans: 0, clicks: 0, netMills: 0 },
);

const hubMoney = {
  state: "no_data",
  reason: "not_computed",
  revenueBasis: "creator_net_after_platform_fee",
  attributionRule: "ofapi_subscription_period_equal_split.v1",
  netMills: null,
  pendingMills: null,
} as const;

/** One link's segment over [fromAt, toAt), or null when nothing was read of it by the end. */
function segmentOf(link: LinkHistory, range: { from: string; fromAt: number; toAt: number }, withDays: boolean): Segment | null {
  const latestRead = windowAtOrBefore(range.toAt - 1);
  if (link.firstReadAt >= range.toAt) return null;
  const inRange = link.days.filter((day) => dayStartMs(day.day) < range.toAt && dayStartMs(day.day) + DAY_MS > range.fromAt);
  const readBefore = link.firstReadAt < range.fromAt;
  const createdInside = link.createdAt !== null && link.createdAt >= range.fromAt;
  // Counted from zero without a reading before: everything up to the end.
  const counted = readBefore ? inRange : link.days.filter((day) => dayStartMs(day.day) < range.toAt);
  const total = sum(counted);
  const flags: Flag[] = !readBefore && !createdInside ? ["no_baseline"] : [];
  const kind = link.seed.kind;
  const days = withDays
    ? (() => {
      const rows: NonNullable<Segment["days"]> = [];
      for (let day = range.from; dayStartMs(day) < range.toAt; day = nextDay(day)) {
        const read = link.days.find((item) => item.day === day);
        if (!read) {
          rows.push({ businessDate: day, clicks: null, fans: null, vendorNetMills: null, flags: [] });
          continue;
        }
        rows.push({
          businessDate: day,
          clicks: read.clicks,
          fans: read.fans,
          vendorNetMills: read.netMills,
          flags: read.noBaseline ? ["no_baseline"] : [],
        });
      }
      return rows;
    })()
    : null;
  return {
    pageId: link.pageId,
    pageLabel: link.pageLabel,
    linkKind: kind,
    linkRef: link.linkRef,
    name: link.seed.name,
    linkCreatedAt: link.createdAt === null ? null : iso(new Date(link.createdAt)),
    channelKey: link.seed.channel,
    contractorKey: null,
    startAt: iso(new Date(range.fromAt)),
    endAt: iso(new Date(range.toAt)),
    startObservedAt: readBefore ? iso(new Date(windowAtOrBefore(range.fromAt - 1))) : null,
    endObservedAt: iso(new Date(latestRead)),
    clicks: total.clicks,
    claims: kind === "trial" ? total.fans : null,
    subscribers: kind === "trial" ? Math.round(total.fans * 0.4) : total.fans,
    fans: total.fans,
    vendorNetMills: total.netMills,
    flags,
    days,
  };
}

function totalsOf(segments: readonly Segment[]): Channel["totals"] {
  return {
    linkCount: new Set(segments.map((segment) => `${segment.pageId}:${segment.linkKind}:${segment.linkRef}`)).size,
    clicks: segments.reduce((total, segment) => total + segment.clicks, 0),
    claims: segments.reduce((total, segment) => total + (segment.claims ?? 0), 0),
    subscribers: segments.reduce((total, segment) => total + segment.subscribers, 0),
    fans: segments.reduce((total, segment) => total + (segment.fans ?? 0), 0),
    vendorNetMills: segments.reduce((total, segment) => total + (segment.vendorNetMills ?? 0), 0),
    hubMoney,
  };
}

const flagsOf = (segments: readonly Segment[]): Flag[] => [...new Set(segments.flatMap((segment) => segment.flags))];

export function ofLinkChannels(request: DemoRequest): Channels | ReturnType<typeof demoError> {
  const { now } = request;
  const today = mskDayKey(now);
  const seriesFloorAt = dayStartMs(today) - SERIES_DAYS * DAY_MS + 3 * HOUR_MS;
  const from = queryString(request, "from") ?? mskDayKey(seriesFloorAt);
  const to = queryString(request, "to") ?? today;
  if (from > to) return demoError(400, "Bad Request", "`from` is after `to`");
  if (from > today) return demoError(400, "Bad Request", "`from` is in the future");
  const rawPage = queryString(request, "pageId");
  const pageId = rawPage === undefined ? undefined : Number(rawPage);
  if (pageId !== undefined && !OF_PAGES.some((page) => page.id === pageId)) return demoError(404, "Not Found", "OnlyFans page not found");
  const withDays = queryString(request, "days") === "true";
  const fromAt = dayStartMs(from);
  const toAt = Math.min(dayStartMs(nextDay(to)), now.getTime());
  const range = { from, fromAt, toAt };

  const segments = LINKS
    .map((seed, index) => linkHistory(seed, index, now))
    .filter((link) => pageId === undefined || link.pageId === pageId)
    .flatMap((link) => segmentOf(link, range, withDays) ?? []);
  const termFrom = iso(new Date(seriesFloorAt));
  const channelKeys = [...new Set(segments.map((segment) => segment.channelKey))]
    .sort((left, right) => (left === right ? 0 : left === null ? 1 : right === null ? -1 : left < right ? -1 : 1));
  const channels: Channel[] = channelKeys.map((key) => {
    const own = segments.filter((segment) => segment.channelKey === key);
    const contractor = key === null ? null : CHANNELS[key as ChannelKey].contractor;
    return {
      channelKey: key,
      channelTitle: key === null ? null : CHANNELS[key as ChannelKey].title,
      contractors: contractor === null ? [] : [{
        contractorKey: contractor[0],
        contractorTitle: contractor[1],
        validFrom: termFrom,
        validTo: null,
        validFromBasis: "confirmed",
        totals: totalsOf(own),
        flags: flagsOf(own),
      }],
      totals: totalsOf(own),
      flags: flagsOf(own),
      segments: own,
    };
  });
  const contractorKeys = [...new Set(channelKeys.map((key) => (key === null ? null : CHANNELS[key as ChannelKey].contractor?.[0] ?? null)))];
  const contractors: Channels["contractors"] = contractorKeys.map((contractorKey) => {
    const keys = channelKeys.filter((key) => (key === null ? null : CHANNELS[key as ChannelKey].contractor?.[0] ?? null) === contractorKey);
    const own = segments
      .filter((segment) => keys.includes(segment.channelKey))
      .map((segment) => ({ ...segment, contractorKey }));
    const title = keys.map((key) => (key === null ? null : CHANNELS[key as ChannelKey].contractor?.[1] ?? null)).find((value) => value !== null) ?? null;
    return {
      contractorKey,
      contractorTitle: title,
      channelKeys: keys.filter((key): key is string => key !== null).sort(),
      totals: totalsOf(own),
      flags: flagsOf(own),
      segments: own,
    };
  });

  return {
    generatedAt: iso(now),
    businessTimeZone: "Europe/Moscow",
    revenueBasis: "creator_net_after_platform_fee",
    seriesFloorAt: iso(new Date(seriesFloorAt)),
    range: { from, to, fromAt: iso(new Date(fromAt)), toAt: iso(new Date(toAt)) },
    channels,
    contractors,
  };
}

/** Demo answers of Трафик → Источники (see demo/core.ts). */
export const trafficSourcesHandlers: DemoHandlers = {
  ofLinksChannelsGet: (request) => ofLinkChannels(request),
};
