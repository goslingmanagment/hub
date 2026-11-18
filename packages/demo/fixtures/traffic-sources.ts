/**
 * Трафик → Источники and the page of one link: the OnlyFans link series of the
 * demo agency, live up to the latest collection window before the request
 * (reads at 00:45, 06:45, 12:45 and 18:45 Moscow; the 00:45 read closes the
 * day before). Invented sources and links:
 *   - Reddit, whose earlier contractor brought most of its money, and a new
 *     contractor since a few days before the two weeks;
 *   - X, quiet for the last days, with young links that have no fan yet;
 *   - video sites, six working links, one whose money OnlyFans never knows,
 *     two without clicks;
 *   - a shoutout link born two days ago; TikTok, whose link the series missed
 *     for a while (unread days, then a day without a baseline);
 *   - Instagram, silent with an open contractor term while old fans still pay;
 *   - SFS, whose link never had a click (it works past the links);
 *   - YouTube and a Telegram channel, stopped;
 *   - links without a source, a few of them moving.
 * The VIP page's reads failed one whole day four days ago: that day and the
 * next have no figures. Answers `ofLinksChannelsGet` (honouring `from`, `to`,
 * `pageId`, `days`), `ofLinksHistoryGet`, and lends its links to `ofLinksGet`.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { between, demoError, iso, mills, queryString, rng, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DAY_MS, HOUR_MS, OF_PAGES, demoDigits, mskDayKey } from "./publish-of-common.ts";

type Channels = KernelOperationResponse<"ofLinksChannelsGet">;
type Channel = Channels["channels"][number];
type Segment = Channel["segments"][number];
type Flag = Segment["flags"][number];
type Totals = Channel["totals"];
type History = KernelOperationResponse<"ofLinksHistoryGet">;
type OfLink = KernelOperationResponse<"ofLinksGet">["links"][number];

const MSK_OFFSET_MS = 3 * HOUR_MS;
/** The series began this many days before today. */
const SERIES_DAYS = 70;
/** The VIP page (OF_PAGES[1]) was not read at all this many days ago. */
const OUTAGE_DAYS_AGO = 4;

interface TermSeed {
  key: string;
  title: string;
  /** Days before today the term began; it ends `toDaysAgo` days ago, or is open. */
  fromDaysAgo: number;
  toDaysAgo: number | null;
}

const CHANNELS: Readonly<Record<string, { title: string; terms: readonly TermSeed[] }>> = {
  reddit: {
    title: "Reddit",
    terms: [
      { key: "north-wind", title: "Студия «Северный ветер»", fromDaysAgo: 160, toDaysAgo: 12 },
      { key: "maple-media", title: "Maple Media", fromDaysAgo: 12, toDaysAgo: null },
    ],
  },
  x: { title: "X (Twitter)", terms: [{ key: "promo-lab", title: "Promo Lab", fromDaysAgo: 40, toDaysAgo: null }] },
  tubes: { title: "Видеоплощадки", terms: [{ key: "clip-works", title: "Clip Works", fromDaysAgo: 75, toDaysAgo: null }] },
  shoutouts: { title: "Шаутауты", terms: [{ key: "shout-desk", title: "Шаут-деск", fromDaysAgo: 3, toDaysAgo: null }] },
  tiktok: { title: "TikTok", terms: [] },
  instagram: { title: "Instagram", terms: [{ key: "noon-agency", title: "Агентство «Полдень»", fromDaysAgo: 55, toDaysAgo: null }] },
  sfs: { title: "SFS", terms: [{ key: "mutual-desk", title: "Взаимный пиар", fromDaysAgo: 30, toDaysAgo: null }] },
  youtube: { title: "YouTube", terms: [{ key: "frame-studio", title: "Frame Studio", fromDaysAgo: 140, toDaysAgo: 34 }] },
  telegram: { title: "Telegram-канал", terms: [] },
};

interface LinkSeed {
  name: string;
  page: 0 | 1;
  kind: "tracking" | "trial";
  channel: string | null;
  /** New fans a day, on average, now. */
  rate: number;
  /** Fans a day before `rateChangedDaysAgo` (an old link that stopped working). */
  oldRate?: number;
  rateChangedDaysAgo?: number;
  /** Days before today the link was created; null: older than the series. */
  createdDaysAgo: number | null;
  /** The series first read it this many days ago (it missed it before). */
  firstReadDaysAgo?: number;
  /** No fans from this many days ago on. */
  quietSinceDaysAgo?: number;
  /** Clicks a day without a fan. */
  clicksOnly?: number;
  /** Nothing at all lately. */
  idle?: boolean;
  /** Old fans still pay this much a day, on some days. */
  oldFansPay?: number;
  /** OnlyFans never reports the link's money. */
  moneyUnknown?: boolean;
  /** Fans brought before the series began. */
  before?: number;
  trialDays?: number;
  expiredDaysAgo?: number;
}

const LINKS: readonly LinkSeed[] = [
  { name: "Reddit · основной профиль", page: 0, kind: "tracking", channel: "reddit", rate: 0.4, oldRate: 4.5, rateChangedDaysAgo: 14, createdDaysAgo: null, before: 380 },
  { name: "Reddit · промо-посты", page: 0, kind: "tracking", channel: "reddit", rate: 0, oldRate: 2.2, rateChangedDaysAgo: 13, createdDaysAgo: null, before: 210, idle: false },
  { name: "Reddit · Maple", page: 0, kind: "trial", channel: "reddit", rate: 2.4, createdDaysAgo: 11, trialDays: 30 },
  { name: "Reddit · VIP", page: 1, kind: "tracking", channel: "reddit", rate: 0.9, createdDaysAgo: null, before: 60 },
  { name: "Reddit · архив", page: 0, kind: "tracking", channel: "reddit", rate: 0, createdDaysAgo: null, idle: true, before: 540, expiredDaysAgo: 20 },

  { name: "X · ссылка в био", page: 0, kind: "tracking", channel: "x", rate: 3.2, createdDaysAgo: null, quietSinceDaysAgo: 3, before: 90 },
  { name: "X · закреплённый пост", page: 0, kind: "tracking", channel: "x", rate: 0, createdDaysAgo: null, clicksOnly: 1.6, before: 12 },
  { name: "X · второй аккаунт", page: 1, kind: "tracking", channel: "x", rate: 0, createdDaysAgo: 4, clicksOnly: 3 },
  { name: "X · третий аккаунт", page: 1, kind: "tracking", channel: "x", rate: 0, createdDaysAgo: 1 },

  { name: "PH", page: 0, kind: "trial", channel: "tubes", rate: 1.2, createdDaysAgo: null, before: 140, trialDays: 360 },
  { name: "Xfree", page: 0, kind: "trial", channel: "tubes", rate: 0.9, createdDaysAgo: null, before: 120, trialDays: 360 },
  { name: "Redgifs", page: 0, kind: "trial", channel: "tubes", rate: 0.6, createdDaysAgo: null, before: 80, trialDays: 360 },
  { name: "Fikfap", page: 0, kind: "trial", channel: "tubes", rate: 0.7, createdDaysAgo: null, before: 60, trialDays: 360, moneyUnknown: true },
  { name: "TikPorn", page: 0, kind: "trial", channel: "tubes", rate: 0.2, createdDaysAgo: null, before: 20, trialDays: 360 },
  { name: "Waptap", page: 0, kind: "trial", channel: "tubes", rate: 0.15, createdDaysAgo: 30, trialDays: 360 },
  { name: "Erome", page: 0, kind: "trial", channel: "tubes", rate: 0, createdDaysAgo: null, idle: true, before: 4, trialDays: 360 },
  { name: "SpankBang", page: 0, kind: "trial", channel: "tubes", rate: 0, createdDaysAgo: null, idle: true, trialDays: 360 },

  { name: "Шаутаут @luna.shares", page: 0, kind: "tracking", channel: "shoutouts", rate: 6, createdDaysAgo: 2 },
  { name: "TikTok · био", page: 1, kind: "tracking", channel: "tiktok", rate: 1.3, createdDaysAgo: null, firstReadDaysAgo: 9, before: 70 },

  { name: "Instagram · сторис", page: 0, kind: "tracking", channel: "instagram", rate: 0, createdDaysAgo: null, idle: true, before: 160, oldFansPay: 11 },
  { name: "SFS · общая", page: 1, kind: "tracking", channel: "sfs", rate: 0, createdDaysAgo: 28, idle: true },
  { name: "YouTube · описание", page: 0, kind: "tracking", channel: "youtube", rate: 0, createdDaysAgo: null, idle: true, before: 240 },
  { name: "YouTube · шортсы", page: 0, kind: "tracking", channel: "youtube", rate: 0, createdDaysAgo: null, idle: true, before: 35, expiredDaysAgo: 30 },
  { name: "Telegram · закреп", page: 1, kind: "tracking", channel: "telegram", rate: 0, createdDaysAgo: null, idle: true, before: 25 },

  { name: "Ссылка с основной страницы", page: 1, kind: "tracking", channel: null, rate: 1.4, createdDaysAgo: null, before: 300 },
  { name: "Пробные 30 дней · бывшие фаны", page: 0, kind: "trial", channel: null, rate: 0.5, createdDaysAgo: null, before: 120, trialDays: 30 },
  { name: "Рассылка по фанам", page: 1, kind: "tracking", channel: null, rate: 0, createdDaysAgo: null, clicksOnly: 0.8, before: 40 },
  { name: "Тест · старый", page: 0, kind: "tracking", channel: null, rate: 0, createdDaysAgo: null, idle: true, before: 3 },
  { name: "Тест · новый", page: 0, kind: "tracking", channel: null, rate: 0, createdDaysAgo: null, idle: true },
  { name: "Осенняя акция", page: 0, kind: "trial", channel: null, rate: 0, createdDaysAgo: null, idle: true, before: 45, trialDays: 7, expiredDaysAgo: 25 },
];

// ── Time ──────────────────────────────────────────────────────────────────

/** UTC instant of Moscow midnight of a day key. */
const dayStartMs = (day: string) => Date.parse(`${day}T00:00:00Z`) - MSK_OFFSET_MS;
const nextDay = (day: string) => mskDayKey(dayStartMs(day) + DAY_MS);

/** The read of the latest window (00:45, 06:45, 12:45, 18:45 Moscow; five minutes in) at or before `at`. */
function readAtOrBefore(at: number): number {
  const local = at + MSK_OFFSET_MS;
  const midnight = Math.floor(local / DAY_MS) * DAY_MS;
  const minutes = (local - midnight) / 60_000;
  const read = [50, 410, 770, 1130].filter((minute) => minute <= minutes).at(-1);
  return (read === undefined ? midnight - 310 * 60_000 : midnight + read * 60_000) - MSK_OFFSET_MS;
}

interface Figures { fans: number; clicks: number; money: number }
const ZERO: Figures = { fans: 0, clicks: 0, money: 0 };
const add = (left: Figures, right: Figures): Figures => ({ fans: left.fans + right.fans, clicks: left.clicks + right.clicks, money: left.money + right.money });

interface ShownDay {
  day: string;
  /** null: the day has no figures (no read inside it, the read after unread days, today before its read). */
  figures: Figures | null;
  noBaseline: boolean;
}

interface LinkLife {
  seed: LinkSeed;
  index: number;
  linkRef: string;
  pageId: number;
  pageLabel: string;
  createdAt: number | null;
  firstDay: string;
  /** What the link really took in each day from its first read day (today: up to the latest read). */
  truth: Map<string, Figures>;
  /** What it had before the first read (counted on that day, flagged no_baseline). */
  carried: Figures;
  lastRead: number;
  today: string;
}

function arrivals(seed: LinkSeed, index: number, day: string, daysAgo: number, share: number): Figures {
  const random = rng(`traffic-sources:${index}:${day}`);
  const pay = seed.oldFansPay !== undefined && random() < 0.35 ? mills(seed.oldFansPay * between(random, 0.6, 1.6) * share) : 0;
  if (seed.idle) return { fans: 0, clicks: 0, money: pay };
  if (seed.clicksOnly !== undefined) return { fans: 0, clicks: Math.round(seed.clicksOnly * between(random, 0, 2) * share), money: 0 };
  const quiet = seed.quietSinceDaysAgo !== undefined && daysAgo <= seed.quietSinceDaysAgo;
  const young = seed.createdDaysAgo !== null && seed.createdDaysAgo <= 3;
  const old = seed.rateChangedDaysAgo !== undefined && daysAgo > seed.rateChangedDaysAgo;
  const base = old ? seed.oldRate ?? seed.rate : seed.rate;
  // A young link grows: its newest day is its best.
  const rate = young ? base * (seed.createdDaysAgo! - daysAgo + 1) / 2 : base;
  const fans = quiet ? 0 : Math.max(0, Math.round(rate * between(random, 0.1, 1.9) * share));
  const clicks = Math.round((fans * between(random, 1.2, 2.4) + between(random, 0, 3)) * share);
  return { fans, clicks, money: mills(fans * between(random, 2, 9)) + pay };
}

function linkLife(seed: LinkSeed, index: number, now: Date): LinkLife {
  const lastRead = readAtOrBefore(now.getTime());
  const today = mskDayKey(now);
  const todayStart = dayStartMs(today);
  const page = OF_PAGES[seed.page] ?? OF_PAGES[0]!;
  const createdAt = seed.createdDaysAgo === null ? null : todayStart - seed.createdDaysAgo * DAY_MS + 11 * HOUR_MS;
  const firstReadDaysAgo = Math.min(seed.firstReadDaysAgo ?? SERIES_DAYS, seed.createdDaysAgo ?? SERIES_DAYS);
  const truth = new Map<string, Figures>();
  for (let daysAgo = firstReadDaysAgo; daysAgo >= 0; daysAgo -= 1) {
    const day = mskDayKey(todayStart - daysAgo * DAY_MS);
    const share = Math.min(1, Math.max(0, (lastRead - dayStartMs(day)) / DAY_MS));
    truth.set(day, arrivals(seed, index, day, daysAgo, share));
  }
  const random = rng(`traffic-sources:before:${index}`);
  const beforeFans = seed.before ?? 0;
  const carried = createdAt !== null && seed.firstReadDaysAgo === undefined
    ? ZERO
    : {
      fans: beforeFans,
      clicks: Math.round(beforeFans * between(random, 1.4, 2.6)),
      money: mills(beforeFans * between(random, 4, 14)),
    };
  return {
    seed,
    index,
    linkRef: demoDigits(`traffic-sources-ref:${index}`, 8),
    pageId: page.id,
    pageLabel: page.label,
    createdAt,
    firstDay: mskDayKey(todayStart - firstReadDaysAgo * DAY_MS),
    truth,
    carried,
    lastRead,
    today,
  };
}

/** What the series shows for a day of the link. */
function shownDay(link: LinkLife, day: string): ShownDay {
  const truth = link.truth.get(day);
  if (truth === undefined) return { day, figures: null, noBaseline: false };
  // Today has figures once a read of its own came in (06:45).
  if (day === link.today && link.lastRead < dayStartMs(day) + 6 * HOUR_MS + 45 * 60_000) return { day, figures: null, noBaseline: false };
  if (link.seed.page === 1) {
    const outage = mskDayKey(dayStartMs(link.today) - OUTAGE_DAYS_AGO * DAY_MS);
    if (day === outage || day === nextDay(outage)) return { day, figures: null, noBaseline: false };
  }
  if (day === link.firstDay && (link.createdAt === null || link.createdAt < dayStartMs(day))) {
    return { day, figures: add(truth, link.carried), noBaseline: true };
  }
  return { day, figures: truth, noBaseline: false };
}

/** What the link took in over the days [from, to] (whole arrivals, unread days too), with its carried value
 *  when nothing was read before `from`. */
function counted(link: LinkLife, from: string, to: string): { figures: Figures; noBaseline: boolean } {
  let figures = ZERO;
  for (const [day, value] of link.truth) {
    if (day >= from && day <= to) figures = add(figures, value);
  }
  const fromStart = from <= link.firstDay;
  const created = link.createdAt !== null && link.createdAt >= dayStartMs(from);
  if (fromStart && link.firstDay <= to) figures = add(figures, link.carried);
  return { figures, noBaseline: fromStart && !created && link.firstDay <= to };
}

// ── The channels' read ────────────────────────────────────────────────────

const hubMoney = {
  state: "no_data",
  reason: "not_computed",
  revenueBasis: "creator_net_after_platform_fee",
  attributionRule: "ofapi_subscription_period_equal_split.v1",
  netMills: null,
  pendingMills: null,
} as const;

interface Range { from: string; to: string; fromAt: number; toAt: number }

/** One link's piece [from, to] of the range (whole days), or null when it has no read by the piece's end. */
function segmentOf(link: LinkLife, range: Range, piece: { from: string; to: string }, contractorKey: string | null, withDays: boolean): Segment | null {
  const to = piece.to < link.today ? piece.to : link.today;
  if (link.firstDay > to) return null;
  const { figures, noBaseline } = counted(link, piece.from, to);
  const kind = link.seed.kind;
  const flags: Flag[] = [...(noBaseline ? ["no_baseline" as const] : []), ...(link.seed.moneyUnknown ? ["money_unknown" as const] : [])];
  const days: Segment["days"] = withDays ? [] : null;
  if (days !== null) {
    for (let day = piece.from; day <= to; day = nextDay(day)) {
      const shown = shownDay(link, day);
      days.push({
        businessDate: day,
        clicks: shown.figures?.clicks ?? null,
        fans: shown.figures?.fans ?? null,
        vendorNetMills: shown.figures === null || link.seed.moneyUnknown ? null : shown.figures.money,
        flags: shown.figures === null ? [] : [...(shown.noBaseline ? ["no_baseline" as const] : []), ...(link.seed.moneyUnknown ? ["money_unknown" as const] : [])],
      });
    }
  }
  const startAt = Math.max(range.fromAt, dayStartMs(piece.from));
  const endAt = Math.min(range.toAt, dayStartMs(nextDay(piece.to)));
  const firstReadAt = dayStartMs(link.firstDay) + 50 * 60_000;
  return {
    pageId: link.pageId,
    pageLabel: link.pageLabel,
    linkKind: kind,
    linkRef: link.linkRef,
    name: link.seed.name,
    linkCreatedAt: link.createdAt === null ? null : iso(new Date(link.createdAt)),
    channelKey: link.seed.channel,
    contractorKey,
    startAt: iso(new Date(startAt)),
    endAt: iso(new Date(endAt)),
    startObservedAt: firstReadAt < startAt ? iso(new Date(readAtOrBefore(startAt - 1))) : null,
    endObservedAt: iso(new Date(Math.min(link.lastRead, readAtOrBefore(endAt - 1)))),
    clicks: figures.clicks,
    claims: kind === "trial" ? figures.fans : null,
    subscribers: kind === "trial" ? Math.round(figures.fans * 0.4) : figures.fans,
    fans: figures.fans,
    vendorNetMills: link.seed.moneyUnknown ? null : figures.money,
    flags,
    days,
  };
}

function totalsOf(segments: readonly Segment[]): { totals: Totals; flags: Flag[] } {
  return {
    totals: {
      linkCount: new Set(segments.map((segment) => `${segment.pageId}:${segment.linkKind}:${segment.linkRef}`)).size,
      clicks: segments.reduce((total, segment) => total + segment.clicks, 0),
      claims: segments.reduce((total, segment) => total + (segment.claims ?? 0), 0),
      subscribers: segments.reduce((total, segment) => total + segment.subscribers, 0),
      fans: segments.reduce((total, segment) => total + (segment.fans ?? 0), 0),
      vendorNetMills: segments.reduce((total, segment) => total + (segment.vendorNetMills ?? 0), 0),
      hubMoney,
    },
    flags: [...new Set(segments.flatMap((segment) => segment.flags))],
  };
}

const dayAgo = (today: string, days: number) => mskDayKey(dayStartMs(today) - days * DAY_MS);

/** A term's days inside [from, to]; null when they do not meet. */
function termPiece(term: TermSeed, today: string, from: string, to: string): { from: string; to: string } | null {
  const start = dayAgo(today, term.fromDaysAgo);
  const end = term.toDaysAgo === null ? to : dayAgo(today, term.toDaysAgo + 1);
  const piece = { from: start > from ? start : from, to: end < to ? end : to };
  return piece.from <= piece.to ? piece : null;
}

export function ofLinkChannels(request: DemoRequest): Channels | ReturnType<typeof demoError> {
  const { now } = request;
  const today = mskDayKey(now);
  const seriesFloorAt = dayStartMs(today) - SERIES_DAYS * DAY_MS + 50 * 60_000;
  const from = queryString(request, "from") ?? mskDayKey(seriesFloorAt);
  const to = queryString(request, "to") ?? today;
  if (from > to) return demoError(400, "Bad Request", "`from` is after `to`");
  if (from > today) return demoError(400, "Bad Request", "`from` is in the future");
  const rawPage = queryString(request, "pageId");
  const pageId = rawPage === undefined ? undefined : Number(rawPage);
  if (pageId !== undefined && !OF_PAGES.some((page) => page.id === pageId)) return demoError(404, "Not Found", "OnlyFans page not found");
  const withDays = queryString(request, "days") === "true";
  const range: Range = { from, to, fromAt: dayStartMs(from), toAt: Math.min(dayStartMs(nextDay(to)), now.getTime()) };

  const links = LINKS.map((seed, index) => linkLife(seed, index, now)).filter((link) => pageId === undefined || link.pageId === pageId);
  const whole = { from, to };
  const segments = links.flatMap((link) => segmentOf(link, range, whole, null, withDays) ?? []);
  const channelKeys = [...new Set(segments.map((segment) => segment.channelKey))]
    .sort((left, right) => (left === right ? 0 : left === null ? 1 : right === null ? -1 : left < right ? -1 : 1));

  // The contractor-cut segments: each link's piece under each term, and the stretches without one.
  const contractorSegments: Segment[] = [];
  for (const link of links) {
    const terms = link.seed.channel === null ? [] : CHANNELS[link.seed.channel]?.terms ?? [];
    const pieces = terms.flatMap((term) => {
      const piece = termPiece(term, today, from, to);
      return piece === null ? [] : [{ ...piece, key: term.key as string | null }];
    }).sort((left, right) => left.from.localeCompare(right.from));
    let cursor = from;
    for (const piece of pieces) {
      if (piece.from > cursor) contractorSegments.push(...[segmentOf(link, range, { from: cursor, to: dayAgo(piece.from, 1) }, null, false)].flatMap((item) => item ?? []));
      contractorSegments.push(...[segmentOf(link, range, piece, piece.key, false)].flatMap((item) => item ?? []));
      cursor = nextDay(piece.to);
    }
    if (cursor <= to) contractorSegments.push(...[segmentOf(link, range, { from: cursor, to }, null, false)].flatMap((item) => item ?? []));
  }

  const channels: Channel[] = channelKeys.map((key) => {
    const own = segments.filter((segment) => segment.channelKey === key);
    const terms = key === null ? [] : CHANNELS[key]?.terms ?? [];
    return {
      channelKey: key,
      channelTitle: key === null ? null : CHANNELS[key]?.title ?? key,
      contractors: terms.flatMap((term) => {
        const piece = termPiece(term, today, from, to);
        if (piece === null) return [];
        const termSegments = contractorSegments.filter((segment) => segment.channelKey === key && segment.contractorKey === term.key);
        return [{
          contractorKey: term.key,
          contractorTitle: term.title,
          validFrom: iso(new Date(dayStartMs(dayAgo(today, term.fromDaysAgo)))),
          validTo: term.toDaysAgo === null ? null : iso(new Date(dayStartMs(dayAgo(today, term.toDaysAgo)))),
          validFromBasis: "confirmed" as const,
          ...totalsOf(termSegments),
        }];
      }),
      ...totalsOf(own),
      segments: own,
    };
  });
  const contractorKeys = [...new Set(contractorSegments.map((segment) => segment.contractorKey))];
  const contractors: Channels["contractors"] = contractorKeys.map((contractorKey) => {
    const own = contractorSegments.filter((segment) => segment.contractorKey === contractorKey);
    const title = Object.values(CHANNELS).flatMap((channel) => channel.terms).find((term) => term.key === contractorKey)?.title ?? null;
    return {
      contractorKey,
      contractorTitle: title,
      channelKeys: [...new Set(own.map((segment) => segment.channelKey).filter((item): item is string => item !== null))].sort(),
      ...totalsOf(own),
      segments: own,
    };
  });

  return {
    generatedAt: iso(now),
    businessTimeZone: "Europe/Moscow",
    revenueBasis: "creator_net_after_platform_fee",
    seriesFloorAt: iso(new Date(seriesFloorAt)),
    range: { from, to, fromAt: iso(new Date(range.fromAt)), toAt: iso(new Date(range.toAt)) },
    channels,
    contractors,
  };
}

// ── The links' read, and one link's history ───────────────────────────────

/** The links of «Источники» as `ofLinksGet` shows them: what each has had since it was made. */
export function trafficSourceLinks(now: Date): OfLink[] {
  return LINKS.map((seed, index) => {
    const link = linkLife(seed, index, now);
    const all = counted(link, link.firstDay, link.today).figures;
    const random = rng(`traffic-sources:link:${index}`);
    const page = OF_PAGES[seed.page] ?? OF_PAGES[0]!;
    const todayStart = dayStartMs(link.today);
    const expired = seed.expiredDaysAgo === undefined ? null : todayStart - seed.expiredDaysAgo * DAY_MS;
    const channel = seed.channel === null ? null : CHANNELS[seed.channel] ?? null;
    const term = channel?.terms.find((item) => item.toDaysAgo === null) ?? channel?.terms.at(-1) ?? null;
    const bindingFrom = iso(new Date(link.createdAt ?? todayStart - (SERIES_DAYS + 30) * DAY_MS));
    const created = link.createdAt ?? todayStart - Math.round(between(random, SERIES_DAYS + 20, SERIES_DAYS + 200)) * DAY_MS;
    return {
      pageId: link.pageId,
      linkKind: seed.kind,
      linkRef: link.linkRef,
      name: seed.name,
      url: `https://onlyfans.com/${page.username}/${seed.kind === "trial" ? "trial" : "c"}${demoDigits(`traffic-sources-url:${index}`, 3)}`,
      linkCreatedAt: iso(new Date(created)),
      linkEndsAt: expired !== null ? iso(new Date(expired)) : seed.kind === "trial" ? iso(new Date(Math.max(created, todayStart - 30 * DAY_MS) + 240 * DAY_MS)) : null,
      isFinished: seed.kind === "trial" ? false : null,
      state: expired !== null ? "expired" : "active",
      trialDays: seed.trialDays ?? null,
      tags: [],
      observedAt: iso(new Date(link.lastRead)),
      businessDate: mskDayKey(link.lastRead),
      runRef: String(1_000 + index),
      inLatestRun: expired === null,
      clicks: all.clicks,
      claims: seed.kind === "trial" ? all.fans : null,
      subscribers: seed.kind === "trial" ? Math.round(all.fans * 0.4) : all.fans,
      spenders: seed.moneyUnknown ? null : Math.round(all.fans * between(random, 0.04, 0.12)),
      fans: all.fans,
      fansMetric: seed.kind === "trial" ? "claims" : "subscribers",
      vendorMoney: {
        revenueBasis: "creator_net_after_platform_fee",
        netMills: seed.moneyUnknown ? null : all.money,
        chargebacksMills: seed.moneyUnknown ? null : 0,
        calculatedAt: seed.moneyUnknown ? null : iso(new Date(link.lastRead - 40 * 60_000)),
        isLoading: seed.moneyUnknown ? true : false,
        lastRecalculation: null,
      },
      hubMoney: {
        state: "no_data", reason: "no_completed_walk", revenueBasis: "creator_net_after_platform_fee",
        attributionRule: "ofapi_subscription_period_equal_split.v1", floorAt: null, netMills: null, pendingMills: null,
        transactionCount: null, fanCount: null,
      },
      comparison: { state: null, flags: [], fromAt: null, toAt: null, vendorDeltaMills: null, hubNetMills: null, differenceMills: null },
      binding: seed.channel === null || channel === null ? null : {
        channelKey: seed.channel,
        channelTitle: channel.title,
        validFrom: bindingFrom,
        validTo: null,
        validFromBasis: "confirmed",
        contractor: term === null ? null : {
          contractorKey: term.key,
          contractorTitle: term.title,
          validFrom: iso(new Date(todayStart - term.fromDaysAgo * DAY_MS)),
          validTo: term.toDaysAgo === null ? null : iso(new Date(todayStart - term.toDaysAgo * DAY_MS)),
          validFromBasis: "confirmed",
        },
      },
    } satisfies OfLink;
  });
}

function ofLinkHistory(request: DemoRequest): History | ReturnType<typeof demoError> {
  const { now } = request;
  const pageId = Number(queryString(request, "pageId"));
  const kind = queryString(request, "linkKind");
  const ref = queryString(request, "linkRef");
  const index = LINKS.findIndex((seed, position) =>
    (OF_PAGES[seed.page] ?? OF_PAGES[0]!).id === pageId && seed.kind === kind && demoDigits(`traffic-sources-ref:${position}`, 8) === ref);
  if (index < 0) return demoError(404, "Not Found", "The series has never seen this link");
  const link = linkLife(LINKS[index]!, index, now);
  const to = queryString(request, "to") ?? link.today;
  let from = queryString(request, "from");
  if (from === undefined) from = dayAgo(to, 29);
  if (from > to) return demoError(400, "Bad Request", "`from` is after `to`");
  const toAt = Math.min(dayStartMs(nextDay(to)), now.getTime());
  const outage = mskDayKey(dayStartMs(link.today) - OUTAGE_DAYS_AGO * DAY_MS);
  const days: History["days"] = [];
  for (let day = from; day <= to && dayStartMs(day) < toAt; day = nextDay(day)) {
    const shown = shownDay(link, day);
    const figures = shown.figures;
    const dayEnd = Math.min(dayStartMs(nextDay(day)), toAt);
    const kindTrial = link.seed.kind === "trial";
    days.push({
      businessDate: day,
      dayStartAt: iso(new Date(dayStartMs(day))),
      dayEndAt: iso(new Date(dayEnd)),
      startObservedAt: figures === null || shown.noBaseline ? null : iso(new Date(dayStartMs(day) + 50 * 60_000)),
      endObservedAt: figures === null ? null : iso(new Date(Math.min(link.lastRead, dayStartMs(nextDay(day)) + 50 * 60_000))),
      clicks: figures?.clicks ?? null,
      claims: figures === null || !kindTrial ? null : figures.fans,
      subscribers: figures === null ? null : kindTrial ? Math.round(figures.fans * 0.4) : figures.fans,
      fans: figures?.fans ?? null,
      vendorNetMills: figures === null || link.seed.moneyUnknown ? null : figures.money,
      missedWindows: link.seed.page === 1 && (day === outage || day === nextDay(outage)) ? (day === outage ? 4 : 1) : 0,
      flags: figures === null ? [] : [...(shown.noBaseline ? ["no_baseline" as const] : []), ...(link.seed.moneyUnknown ? ["money_unknown" as const] : [])],
      hub: null,
    });
  }
  const page = OF_PAGES[link.seed.page] ?? OF_PAGES[0]!;
  return {
    generatedAt: iso(now),
    businessTimeZone: "Europe/Moscow",
    revenueBasis: "creator_net_after_platform_fee",
    seriesFloorAt: iso(new Date(dayStartMs(link.today) - SERIES_DAYS * DAY_MS + 50 * 60_000)),
    pageId: page.id,
    pageLabel: page.label,
    linkKind: link.seed.kind,
    linkRef: link.linkRef,
    name: link.seed.name,
    linkCreatedAt: link.createdAt === null ? null : iso(new Date(link.createdAt)),
    fansMetric: link.seed.kind === "trial" ? "claims" : "subscribers",
    range: { from, to, fromAt: iso(new Date(dayStartMs(from))), toAt: iso(new Date(toAt)) },
    snapshots: [],
    attempts: [],
    days,
    hubMoney: {
      state: "no_data", reason: "no_completed_walk", revenueBasis: "creator_net_after_platform_fee",
      attributionRule: "ofapi_subscription_period_equal_split.v1", floorAt: null, netMills: null, pendingMills: null,
      transactionCount: null, fanCount: null,
    },
  };
}

/** Demo answers of Трафик → Источники and the page of one link (see demo/core.ts). */
export const trafficSourcesHandlers: DemoHandlers = {
  ofLinksChannelsGet: (request) => ofLinkChannels(request),
  ofLinksHistoryGet: (request) => ofLinkHistory(request),
};
