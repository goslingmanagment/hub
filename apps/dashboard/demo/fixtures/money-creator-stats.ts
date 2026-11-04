/**
 * «Статистика»: Fansly's own statistics of a page (the 2026-10 Overview,
 * Content and Audience tabs). The revenue rows come from the same ledger as
 * Overview, so Fansly's numbers and the hub's agree the way they do in use.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { between, demoError, hashString, hoursAgo, intBetween, isoDay, pick, queryNumber, queryString, rng, type DemoHandlers, type DemoReply, type DemoRequest } from "../core.ts";
import type { DemoPage } from "../world.ts";
import { DAY_MS, ledgerDay, ownerOnly, pageOr404, startOfDayMs, type LedgerTx, type LedgerType } from "./money-ledger.ts";

/** Fansly's surfaces: 0 For You, 1 Timeline, 2 Suggestions, 3 Search, 4 Other. */
const SOURCES = [0, 1, 2, 3, 4] as const;

export interface Reach {
  /** Media views a day. */
  views: number;
  /** Share of views per source. */
  split: readonly number[];
  /** Average watched share of a video, percent. */
  watchPct: number;
  /** Day since which Hub holds the page's statistics (days ago). */
  historyDays: number;
}

/** How visible each page is — ivy-2 is an FYP darling that earns nothing. */
export function reachOf(page: DemoPage): Reach {
  switch (page.label) {
    case "mia-1": return { views: 7400, split: [0.52, 0.31, 0.07, 0.05, 0.05], watchPct: 41, historyDays: 260 };
    case "mia-2": return { views: 5600, split: [0.48, 0.34, 0.07, 0.05, 0.06], watchPct: 38, historyDays: 260 };
    case "mia-3": return { views: 4300, split: [0.57, 0.26, 0.07, 0.05, 0.05], watchPct: 36, historyDays: 200 };
    case "nova-1": return { views: 3900, split: [0.41, 0.4, 0.08, 0.05, 0.06], watchPct: 47, historyDays: 230 };
    case "ivy-1": return { views: 1900, split: [0.6, 0.24, 0.07, 0.04, 0.05], watchPct: 33, historyDays: 41 };
    case "ivy-2": return { views: 16800, split: [0.76, 0.14, 0.05, 0.03, 0.02], watchPct: 29, historyDays: 150 };
    default: return { views: 0, split: [0, 0, 0, 0, 0], watchPct: 0, historyDays: 0 };
  }
}

function dayList(fromDay: string, toDay: string): string[] {
  const out: string[] = [];
  for (let at = Date.parse(`${fromDay}T00:00:00Z`); at <= Date.parse(`${toDay}T00:00:00Z`); at += DAY_MS) out.push(isoDay(new Date(at)));
  return out;
}

function shiftDay(day: string, days: number): string {
  return isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));
}

/** A day's swing: weekends stronger, an occasional FYP spike. */
function dayFactor(label: string, day: string): number {
  const random = rng(`reach:${label}:${day}`);
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  const weekend = weekday === 0 || weekday === 6 ? 1.18 : 1;
  const spike = random() < 0.07 ? between(random, 1.6, 2.6) : 1;
  return weekend * spike * between(random, 0.78, 1.22);
}

interface Window {
  fromDay: string;
  toDay: string;
  days: number;
}

function windowOf(request: DemoRequest): Window | DemoReply {
  const days = queryNumber(request, "days", 30);
  if (![7, 30, 90, 180, 365].includes(days)) return demoError(400, "bad_request", "days must be 7, 30, 90, 180 or 365");
  const to = queryString(request, "to") ?? isoDay(request.now);
  return { fromDay: shiftDay(to, -(days - 1)), toDay: to, days };
}

function startDay(page: DemoPage, now: Date): string {
  return isoDay(new Date(startOfDayMs(now) - reachOf(page).historyDays * DAY_MS));
}

function ownerPage(request: DemoRequest): DemoPage | DemoReply {
  return ownerOnly(request) ?? pageOr404(request, request.params.pageLabel);
}

function isReply(value: unknown): value is DemoReply {
  return typeof value === "object" && value !== null && (value as { demoReply?: unknown }).demoReply === true;
}

// --- one day of a page ---

export interface DayStats {
  views: Array<{ source: number; views: number; unique: number; video: number; completed: number; watchMs: number; watchPctSum: number; image: number }>;
  profile: Array<{ source: number; visits: number; unique: number; watchMs: number }>;
  follows: number;
  unfollows: number;
}

export function dayStats(page: DemoPage, day: string): DayStats {
  const reach = reachOf(page);
  const random = rng(`creator:${page.label}:${day}`);
  const factor = dayFactor(page.label, day);
  const views = SOURCES.map((source) => {
    const total = Math.round(reach.views * factor * reach.split[source]! * between(random, 0.85, 1.15));
    const video = Math.round(total * between(random, 0.55, 0.68));
    const pct = reach.watchPct * between(random, 0.85, 1.15) * (source === 0 ? 0.9 : 1.1);
    return {
      source,
      views: total,
      unique: Math.round(total * between(random, 0.58, 0.7)),
      video,
      completed: Math.round(video * pct / 100 * between(random, 0.5, 0.7)),
      watchMs: Math.round(video * between(random, 11, 19) * 1000 * (pct / 40) + (total - video) * 2_600),
      watchPctSum: Math.round(video * pct * 100),
      image: total - video,
    };
  });
  const allViews = views.reduce((sum, row) => sum + row.views, 0);
  const visitsTotal = allViews * between(random, 0.028, 0.04);
  const profileSplit = [0.44, 0.27, 0.15, 0.09, 0.05];
  const profile = SOURCES.map((source) => {
    const visits = Math.round(visitsTotal * profileSplit[source]!);
    return { source, visits, unique: Math.round(visits * 0.82), watchMs: Math.round(visits * between(random, 16, 28) * 1000) };
  });
  const follows = Math.round(visitsTotal * between(random, 0.06, 0.1));
  return { views, profile, follows, unfollows: Math.round(follows * between(random, 0.25, 0.45)) };
}

/** Fansly's product codes for the hub's sources (the current era). */
const PRODUCT: Partial<Record<LedgerType, { type: number; label: string }>> = {
  subscription: { type: 15001, label: "subscriptions" },
  tip: { type: 7101, label: "tips" },
  message_purchase: { type: 2110, label: "media" },
  post_purchase: { type: 2116, label: "media_sets" },
  stream_tip: { type: 45101, label: "stream_tickets" },
};

function revenueRows(page: DemoPage, day: string, txs: readonly LedgerTx[]) {
  const groups = new Map<number, { label: string; transactions: number; net: number; refunds: number; refunded: number }>();
  for (const tx of txs) {
    const product = PRODUCT[tx.type] ?? (tx.type === "refund" || tx.type === "chargeback" ? PRODUCT.message_purchase! : null);
    if (!product) continue;
    const group = groups.get(product.type) ?? { label: product.label, transactions: 0, net: 0, refunds: 0, refunded: 0 };
    if (tx.netMills < 0) {
      group.refunds += 1;
      group.refunded += -tx.netMills;
    } else {
      group.transactions += 1;
      group.net += tx.netMills;
    }
    groups.set(product.type, group);
  }
  return [...groups.entries()].map(([productType, group]) => ({
    day,
    productType,
    productLabel: group.label,
    transactions: group.transactions,
    grossMills: Math.round(group.net / 0.8),
    netMills: group.net - group.refunded,
    refunds: group.refunds,
    refundedNetMills: group.refunded,
  }));
}

const TIER_NAMES = [
  { name: "Fan", color: "#8f7bff", price: 4.99 },
  { name: "VIP", color: "#ff7ab6", price: 14.99 },
  { name: "Inner circle", color: "#f5b942", price: 29.99 },
] as const;

function tiersOf(page: DemoPage) {
  return TIER_NAMES.map((tier, index) => ({
    tierId: String(5_000_000_000_000_000 + (hashString(`${page.label}:tier:${index}`) % 1_000_000_000) * 1000 + index),
    name: tier.name,
    color: tier.color,
    position: index,
    active: !(page.label.startsWith("ivy") && index === 2),
  }));
}

// --- the Overview tab ---

function creatorStatsOverview(request: DemoRequest): KernelOperationResponse<"creatorStatsOverview"> | DemoReply {
  const page = ownerPage(request);
  if (isReply(page)) return page;
  const window = windowOf(request);
  if (isReply(window)) return window;
  const now = request.now;
  const empty: KernelOperationResponse<"creatorStatsOverview"> = {
    page: { label: page.label, platform: page.platform },
    window,
    totalsWindow: null,
    totals: [],
    views: [], profile: [], follows: [], subscriptions: [], revenue: [], levels: [], tierLevels: [], engagement: [],
    hourlyViews: [], hourlyRevenue: [], tiers: [], coverage: [],
  };
  if (page.platform !== "fansly") return empty;

  const firstDay = startDay(page, now);
  const today = isoDay(now);
  const days = dayList(window.fromDay, window.toDay).filter((day) => day >= firstDay && day <= today);
  const tiers = tiersOf(page);
  const out = { ...empty, tiers };

  // Levels walk back from today's counters.
  const levelByDay = new Map<string, { followers: number; subscribers: number }>();
  {
    let followers = page.followers ?? 0;
    let subscribers = page.subscribers;
    for (const day of dayList(firstDay, today).reverse()) {
      levelByDay.set(day, { followers, subscribers });
      const stats = dayStats(page, day);
      followers = Math.max(0, followers - (stats.follows - stats.unfollows));
      const random = rng(`subs:${page.label}:${day}`);
      subscribers = Math.max(0, subscribers - intBetween(random, -3, 5));
    }
  }

  for (const day of days) {
    const stats = dayStats(page, day);
    for (const row of stats.views) {
      out.views.push({
        day, source: row.source, views: row.views, uniqueViewers: row.unique, videoViews: row.video,
        completedViews: row.completed, watchMs: row.watchMs, watchPctSum: row.watchPctSum, imageViews: row.image,
      });
    }
    for (const row of stats.profile) {
      out.profile.push({ day, source: row.source, profileVisits: row.visits, uniqueVisitors: row.unique, profileWatchMs: row.watchMs });
    }
    out.follows.push({ day, follows: stats.follows, unfollows: stats.unfollows });
    const txs = ledgerDay(page, day, now);
    out.revenue.push(...revenueRows(page, day, txs));
    const subs = txs.filter((tx) => tx.type === "subscription").length;
    const random = rng(`tiers:${page.label}:${day}`);
    tiers.forEach((tier, index) => {
      const share = [0.6, 0.3, 0.1][index]!;
      const fresh = Math.round(subs * share * 0.45 + random() * 1.4);
      out.subscriptions.push({
        day, tierId: tier.tierId,
        subscriptionsNew: fresh,
        subscriptionsRenewed: Math.round(subs * share * 0.55),
        subscriptionsExpired: Math.round(fresh * between(random, 0.5, 1.1)),
        subscriptionsCancelled: Math.round(fresh * between(random, 0.2, 0.6)),
      });
    });
    const level = levelByDay.get(day)!;
    out.levels.push({ day, followerCount: level.followers, subscriberCount: level.subscribers });
    tiers.forEach((tier, index) => {
      out.tierLevels.push({ day, tierId: tier.tierId, subscriberCount: Math.round(level.subscribers * [0.66, 0.27, 0.07][index]!) });
    });
    const allViews = stats.views.reduce((sum, row) => sum + row.views, 0);
    out.engagement.push(
      { day, metric: "media_likes", source: 1, value: Math.round(allViews * between(random, 0.016, 0.024)) },
      { day, metric: "post_likes", source: 1, value: Math.round(allViews * between(random, 0.006, 0.01)) },
      { day, metric: "comments", source: 1, value: Math.round(allViews * between(random, 0.0008, 0.0016)) },
    );
  }

  // The last 72 hours, as Fansly's hourly series.
  const hourNow = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
  for (let hour = hourNow - 71 * 3_600_000; hour <= hourNow; hour += 3_600_000) {
    const date = new Date(hour);
    const stats = dayStats(page, isoDay(date));
    const utcHour = date.getUTCHours();
    // US evenings peak around 02:00 UTC, the morning trough around 12:00.
    const diurnal = 0.45 + 0.9 * (0.5 + 0.5 * Math.cos(((utcHour - 2) / 24) * 2 * Math.PI));
    const random = rng(`hour:${page.label}:${hour}`);
    for (const row of stats.views.slice(0, 3)) {
      const views = Math.round((row.views / 24) * diurnal * between(random, 0.8, 1.2));
      out.hourlyViews.push({ hour: date.toISOString(), source: row.source, views, watchMs: Math.round(views * (row.watchMs / Math.max(1, row.views))) });
    }
    const txs = ledgerDay(page, isoDay(date), now).filter((tx) => tx.occurredMs >= hour && tx.occurredMs < hour + 3_600_000);
    out.hourlyRevenue.push({ hour: date.toISOString(), netMills: txs.reduce((sum, tx) => sum + tx.netMills, 0), transactions: txs.length });
  }

  // Fansly's own summary exists for its three periods only.
  if (window.days <= 90) {
    const previousDays = dayList(shiftDay(window.fromDay, -window.days), shiftDay(window.fromDay, -1)).filter((day) => day >= firstDay);
    const hasPrevious = previousDays.length === window.days;
    const sumViews = (list: readonly string[], source: number, pickOf: (row: DayStats["views"][number]) => number) =>
      list.reduce((sum, day) => sum + pickOf(dayStats(page, day).views[source]!), 0);
    const prevValue = (value: number) => (hasPrevious ? value : null);
    out.totalsWindow = { fromDay: window.fromDay, toDay: window.toDay, capturedAt: hoursAgo(now, 0.6).toISOString() };
    for (const source of SOURCES) {
      out.totals.push(
        { scope: "views", ref: String(source), metric: "views", value: sumViews(days, source, (row) => row.views), previous: prevValue(sumViews(previousDays, source, (row) => row.views)) },
        { scope: "views", ref: String(source), metric: "watchMs", value: sumViews(days, source, (row) => row.watchMs), previous: prevValue(sumViews(previousDays, source, (row) => row.watchMs)) },
        // Unique over the window, not the sum of the days' uniques.
        { scope: "views", ref: String(source), metric: "uniqueViewers", value: Math.round(sumViews(days, source, (row) => row.unique) * 0.31), previous: prevValue(Math.round(sumViews(previousDays, source, (row) => row.unique) * 0.31)) },
      );
    }
    const visits = (list: readonly string[]) => list.reduce((sum, day) => sum + dayStats(page, day).profile.reduce((acc, row) => acc + row.visits, 0), 0);
    const netFollows = (list: readonly string[]) => list.reduce((sum, day) => { const stats = dayStats(page, day); return sum + stats.follows - stats.unfollows; }, 0);
    const money = (list: readonly string[]) => list.flatMap((day) => ledgerDay(page, day, now));
    const current = money(days);
    const previous = money(previousDays);
    const payers = (txs: readonly LedgerTx[]) => new Set(txs.filter((tx) => tx.fan && tx.netMills > 0).map((tx) => tx.fan!.platformUserId)).size;
    const net = (txs: readonly LedgerTx[]) => txs.reduce((sum, tx) => sum + (tx.type === "other" ? 0 : tx.netMills), 0);
    const startLevel = levelByDay.get(shiftDay(window.fromDay, -1)) ?? levelByDay.get(window.fromDay);
    const endLevel = levelByDay.get(window.toDay <= today ? window.toDay : today);
    out.totals.push(
      { scope: "profile", ref: "", metric: "profileVisits", value: visits(days), previous: prevValue(visits(previousDays)) },
      { scope: "follows", ref: "", metric: "netFollows", value: netFollows(days), previous: prevValue(netFollows(previousDays)) },
      { scope: "account", ref: "", metric: "followerCount", value: endLevel?.followers ?? null, previous: startLevel?.followers ?? null },
      { scope: "account", ref: "", metric: "subscriberCount", value: endLevel?.subscribers ?? null, previous: startLevel?.subscribers ?? null },
      { scope: "revenue", ref: "", metric: "netMills", value: net(current), previous: prevValue(net(previous)) },
      { scope: "revenue", ref: "", metric: "payingFans", value: payers(current), previous: prevValue(payers(previous)) },
      { scope: "revenue", ref: "", metric: "newPayingFans", value: Math.round(payers(current) * 0.27), previous: prevValue(Math.round(payers(previous) * 0.3)) },
    );
  }

  const oldest = `${firstDay}T00:00:00.000Z`;
  const fresh = hoursAgo(now, 0.4).toISOString();
  out.coverage = ["series:views:day", "series:profile:day", "series:follows:day", "series:subscriptions:day", "series:revenue:day", "series:views:hour", "summary"].map((scopeRef) => ({
    scopeRef,
    oldestCapturedAt: scopeRef === "series:views:hour" ? hoursAgo(now, 72).toISOString() : oldest,
    newestCapturedAt: fresh,
    updatedAt: fresh,
  }));
  return out;
}

// --- the Content tab ---

const CAPTIONS = [
  "Sunday morning in bed, who's joining? ☕",
  "New set from the beach trip 🌊",
  "Tried on the red one… thoughts?",
  "Behind the scenes of today's shoot",
  "Gym day, sweaty and proud 💪",
  "Little dance before going out",
  "Cozy hoodie season is here",
  "Mirror check before date night",
  "Rainy day = movie day, pick the film",
  "POV: you finally text me back",
  "Golden hour hits different",
  "New lingerie haul, part 2",
  "Can't sleep, keep me company?",
  "Cooking pasta in my favourite apron",
  "Halloween fit, guess the character 🎃",
  "Pool day with the girls",
  "Bath time, bubbles everywhere",
  "Outfit of the day: all black",
  "Q&A — ask me anything in the comments",
  "Stretching routine, full version in DMs",
  "First snow of the year ❄️",
  "Lazy Saturday, no plans",
  "Pink or black? Vote below",
  "Trying the trend everyone's doing",
  "Hotel room tour 🏨",
  "Coffee date with you ☕",
  "Late night selfie dump",
  "Who wants the uncut version?",
  "Road trip outfit check",
  "Birthday week starts now 🎂",
  "Silk pyjamas kind of night",
  "Thank you for 10k 🖤",
  "",
  "",
] as const;

const TAGS = [
  "lingerie", "cosplay", "fitness", "petite", "blonde", "brunette", "redhead", "tattoos", "bikini", "yoga",
  "goth", "asmr", "outdoor", "curvy", "teasing", "girlnextdoor", "dance", "shower", "stockings", "smile",
] as const;

export interface DemoMedia {
  mediaOfferId: string;
  postId: string | null;
  mediaType: 1 | 2;
  durationMs: number | null;
  postedDaysAgo: number;
  deletedDaysAgo: number | null;
  caption: string | null;
  /** Views on its first day; it fades from there. */
  peak: number;
  likeRate: number;
  watchPct: number;
  tags: string[];
}

const mediaCache = new Map<string, DemoMedia[]>();

/** The page's media, newest first. Deterministic: ids are stable across screens. */
export function demoMedia(page: DemoPage): DemoMedia[] {
  const cached = mediaCache.get(page.label);
  if (cached) return cached;
  const random = rng(`media:${page.label}`);
  const reach = reachOf(page);
  const count = page.label.startsWith("mia") ? 64 : page.label === "nova-1" ? 46 : 38;
  const list: DemoMedia[] = [];
  let age = intBetween(random, 0, 1);
  for (let index = 0; index < count; index += 1) {
    const video = random() < 0.56;
    const seed = hashString(`${page.label}:media:${index}`);
    // Every caption once before any repeats, in a per-page order.
    const caption = CAPTIONS[(index * 11 + (hashString(page.label) % CAPTIONS.length)) % CAPTIONS.length]!;
    random();
    list.push({
      mediaOfferId: `${7_000_000_000 + (seed % 900_000_000)}${String(index).padStart(8, "0")}`,
      postId: random() < 0.94 ? `${6_000_000_000 + (hashString(`post:${seed}`) % 900_000_000)}${String(index).padStart(8, "0")}` : null,
      mediaType: video ? 2 : 1,
      durationMs: video ? Math.round(between(random, 7, 210) * 1000) : null,
      postedDaysAgo: age,
      deletedDaysAgo: index === 9 ? Math.max(0, age - 6) : null,
      caption: caption === "" ? null : caption,
      peak: Math.round(reach.views * between(random, 0.04, 0.32) * (video ? 1.3 : 0.6) * (random() < 0.08 ? 3 : 1)),
      likeRate: between(random, 0.015, 0.05),
      watchPct: Math.min(92, reach.watchPct * between(random, 0.6, 1.5)),
      tags: Array.from(new Set(Array.from({ length: intBetween(random, 2, 5) }, () => pick(random, TAGS)))),
    });
    age += intBetween(random, 1, 7);
  }
  mediaCache.set(page.label, list);
  return list;
}

/** The catalog's price and all-time sales of a media: one answer for the list of what sells and the media's card. */
export function mediaSales(page: DemoPage, media: DemoMedia) {
  const random = rng(`catalog:${media.mediaOfferId}`);
  const priced = random() < 0.62;
  const price = priced ? pick(random, [7.99, 9.99, 12.99, 14.99, 19.99, 24.99]) : null;
  // Sales follow the page's money: ivy pages sell next to nothing.
  const salesScale = Math.min(1.5, Math.max(0.03, page.dailyNet / 150));
  const salesCount = priced ? Math.max(0, Math.round((media.peak / 120) * salesScale * between(random, 0.3, 1.6))) : null;
  const netMills = price !== null && salesCount !== null ? Math.round(salesCount * price * 800) : null;
  return {
    /** The same stream goes on, for the rest of the media's card. */
    random,
    priceMills: price === null ? null : Math.round(price * 1000),
    sales: {
      count: salesCount,
      netMills,
      pendingMills: netMills === null ? null : Math.round(netMills * between(random, 0, 0.12)),
      grossMills: netMills === null ? null : { value: Math.round(netMills / 0.8), derived: true as const, basis: "netMills / 0.8 — комиссия Fansly 20 %" },
    },
  };
}

/** What sold in messages on the pages that sell most: no post, no caption and no views, as on production. */
function soldInMessages(page: DemoPage) {
  if (!["mia-1", "mia-2", "nova-1"].includes(page.label)) return [];
  return Array.from({ length: 30 }, (_, index) => {
    const random = rng(`sold-in-messages:${page.label}:${index}`);
    const video = random() < 0.7;
    const price = pick(random, [14.99, 19.99, 24.99, 29.99, 39.99, 49.99]);
    const count = intBetween(random, 2, 60);
    const netMills = Math.round(count * price * 800);
    return {
      mediaOfferId: `${6_100_000_000 + (hashString(`sold:${page.label}:${index}`) % 800_000_000)}${String(index).padStart(6, "0")}`,
      mediaType: video ? 2 : 1,
      durationMs: video ? Math.round(between(random, 40, 900) * 1000) : null,
      postId: null,
      postedDaysAgo: intBetween(random, 3, 240),
      deletedDaysAgo: null,
      caption: null,
      priceMills: Math.round(price * 1000),
      sales: {
        count,
        netMills,
        pendingMills: Math.round(netMills * between(random, 0, 0.08)),
        grossMills: { value: Math.round(netMills / 0.8), derived: true as const, basis: "netMills / 0.8 — комиссия Fansly 20 %" },
      },
      windowViews: null,
    };
  });
}

/** One media's views on a day `ageDays` after it was posted, per source. */
export function mediaDay(media: DemoMedia, ageDays: number, day: string): { fyp: number; timeline: number; other: number } {
  if (ageDays < 0) return { fyp: 0, timeline: 0, other: 0 };
  const random = rng(`mday:${media.mediaOfferId}:${day}`);
  const fade = Math.exp(-ageDays / 9) + 0.03;
  const total = media.peak * fade * between(random, 0.75, 1.25);
  // FYP serves only videos, and only in their first 90 days.
  const fypShare = media.mediaType === 2 && ageDays <= 90 ? 0.58 : 0;
  return {
    fyp: Math.round(total * fypShare),
    timeline: Math.round(total * (1 - fypShare) * 0.78),
    other: Math.round(total * (1 - fypShare) * 0.22),
  };
}

function creatorStatsContent(request: DemoRequest): KernelOperationResponse<"creatorStatsContent"> | DemoReply {
  const page = ownerPage(request);
  if (isReply(page)) return page;
  const window = windowOf(request);
  if (isReply(window)) return window;
  const base = { page: { label: page.label, platform: page.platform }, window };
  if (page.platform !== "fansly") return { ...base, walk: { visited: 0, queued: 0 }, media: [], topSales: [], topSalesTotal: 0 };
  const today = isoDay(request.now);
  const days = dayList(window.fromDay, window.toDay).filter((day) => day <= today);
  const all = demoMedia(page);
  const media = all.flatMap((item) => {
    const postedDay = shiftDay(today, -item.postedDaysAgo);
    let fyp = 0;
    let timeline = 0;
    let other = 0;
    for (const day of days) {
      const age = (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${postedDay}T00:00:00Z`)) / DAY_MS;
      const point = mediaDay(item, age, day);
      fyp += point.fyp;
      timeline += point.timeline;
      other += point.other;
    }
    const views = fyp + timeline + other;
    if (views === 0) return [];
    const video = item.mediaType === 2;
    const videoViews = video ? Math.round(views * 0.93) : null;
    let allTime = 0;
    for (let age = 0; age <= item.postedDaysAgo; age += 1) {
      const point = mediaDay(item, age, shiftDay(postedDay, age));
      allTime += point.fyp + point.timeline + point.other;
    }
    return [{
      mediaOfferId: item.mediaOfferId,
      mediaType: item.mediaType,
      durationMs: item.durationMs,
      postId: item.postId,
      postedAt: new Date(Date.parse(`${postedDay}T00:00:00Z`) + 17 * 3_600_000).toISOString(),
      deletedAt: item.deletedDaysAgo === null ? null : new Date(Date.parse(`${shiftDay(today, -item.deletedDaysAgo)}T00:00:00Z`) + 9 * 3_600_000).toISOString(),
      caption: item.caption,
      views,
      forYouViews: video && item.postedDaysAgo <= 90 + window.days ? fyp : null,
      timelineViews: timeline,
      otherViews: other,
      videoViews,
      completedViews: videoViews === null ? null : Math.round(videoViews * (item.watchPct / 100) * 0.6),
      watchMs: videoViews === null ? Math.round(views * 2_400) : Math.round(videoViews * (item.durationMs ?? 0) * (item.watchPct / 100)),
      watchPctSum: videoViews === null ? null : Math.round(videoViews * item.watchPct * 100),
      likes: Math.round(views * item.likeRate),
      allTimeViews: allTime,
    }];
  });
  media.sort((left, right) => (right.views ?? 0) - (left.views ?? 0));
  // ivy-1 joined the media walk late: the first pass is still running.
  const walk = page.label === "ivy-1" ? { visited: Math.round(all.length * 0.68), queued: all.length } : { visited: all.length, queued: all.length };
  const viewsInWindow = new Map(media.map((row) => [row.mediaOfferId, row.views]));
  const sold = [
    ...all.flatMap((item) => {
      const { priceMills, sales } = mediaSales(page, item);
      return (sales.netMills ?? 0) > 0 ? [{ ...item, priceMills, sales, windowViews: viewsInWindow.get(item.mediaOfferId) ?? null }] : [];
    }),
    ...soldInMessages(page),
  ].sort((left, right) => (right.sales.netMills ?? 0) - (left.sales.netMills ?? 0) || left.mediaOfferId.localeCompare(right.mediaOfferId));
  const topSales = sold.slice(0, 50).map((item) => ({
    mediaOfferId: item.mediaOfferId,
    mediaType: item.mediaType,
    durationMs: item.durationMs,
    postId: item.postId,
    postedAt: new Date(Date.parse(`${shiftDay(today, -item.postedDaysAgo)}T00:00:00Z`) + 17 * 3_600_000).toISOString(),
    deletedAt: item.deletedDaysAgo === null ? null : new Date(Date.parse(`${shiftDay(today, -item.deletedDaysAgo)}T00:00:00Z`) + 9 * 3_600_000).toISOString(),
    caption: item.caption,
    priceMills: item.priceMills,
    sales: item.sales,
    windowViews: item.windowViews,
  }));
  return { ...base, walk, media, topSales, topSalesTotal: sold.length };
}

function creatorStatsMedia(request: DemoRequest): KernelOperationResponse<"creatorStatsMedia"> | DemoReply {
  const page = ownerPage(request);
  if (isReply(page)) return page;
  const window = windowOf(request);
  if (isReply(window)) return window;
  const item = demoMedia(page).find((entry) => entry.mediaOfferId === request.params.mediaOfferId);
  // Sold in messages: Fansly serves it no days, and the server answers with empty lists.
  if (!item && soldInMessages(page).some((entry) => entry.mediaOfferId === request.params.mediaOfferId)) {
    return { mediaOfferId: request.params.mediaOfferId!, window, daily: [], hourly: [], retention: [], tags: [] };
  }
  if (!item) return demoError(404, "not_found", "Медиа не найдено");
  const today = isoDay(request.now);
  const postedDay = shiftDay(today, -item.postedDaysAgo);
  const out: KernelOperationResponse<"creatorStatsMedia"> = { mediaOfferId: item.mediaOfferId, window, daily: [], hourly: [], retention: [], tags: [] };
  for (const day of dayList(window.fromDay, window.toDay).filter((entry) => entry >= postedDay && entry <= today)) {
    const age = (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${postedDay}T00:00:00Z`)) / DAY_MS;
    const point = mediaDay(item, age, day);
    for (const [source, views] of [[0, point.fyp], [1, point.timeline], [4, point.other]] as const) {
      if (source === 0 && item.mediaType !== 2) continue;
      const videoViews = item.mediaType === 2 ? Math.round(views * 0.93) : null;
      out.daily.push({
        day, source, views,
        videoViews,
        completedViews: videoViews === null ? null : Math.round(videoViews * (item.watchPct / 100) * 0.6),
        watchMs: videoViews === null ? Math.round(views * 2_400) : Math.round(videoViews * (item.durationMs ?? 0) * (item.watchPct / 100)),
        uniqueViewers: Math.round(views * 0.71),
      });
    }
  }
  // The first hours after posting, while Fansly still serves them (a week).
  if (item.postedDaysAgo <= 7) {
    const start = Date.parse(`${postedDay}T17:00:00Z`);
    for (let hour = 0; hour < 48; hour += 1) {
      const at = start + hour * 3_600_000;
      if (at > request.now.getTime()) break;
      const random = rng(`mhour:${item.mediaOfferId}:${hour}`);
      const curve = item.peak / 10 * Math.exp(-hour / 14) * between(random, 0.7, 1.3);
      out.hourly.push({ hour: new Date(at).toISOString(), source: 1, views: Math.round(curve * 0.45) });
      if (item.mediaType === 2) out.hourly.push({ hour: new Date(at).toISOString(), source: 0, views: Math.round(curve * 0.55) });
    }
  }
  if (item.mediaType === 2) {
    for (const source of [0, 1]) {
      const random = rng(`retention:${item.mediaOfferId}:${source}`);
      const decay = (100 - item.watchPct) / 100 * (source === 0 ? 1.25 : 0.95);
      out.retention.push({
        source,
        sampleSize: Math.round(item.peak * between(random, 0.6, 2.4) * (source === 0 ? 1.4 : 0.8)),
        capturedDay: today,
        points: Array.from({ length: 21 }, (_, index) => {
          const percent = index * 5;
          const still = Math.max(0.03, Math.exp(-decay * 2.2 * (percent / 100)) - (percent > 0 && percent < 15 ? 0.08 : 0));
          return { percent, stillWatching: Math.round(still * 1000) / 1000 };
        }),
      });
    }
  }
  const tagRandom = rng(`mtags:${item.mediaOfferId}`);
  out.tags = item.tags.map((tag) => ({ tag, source: 0, views: Math.round(item.peak * between(tagRandom, 0.1, 0.9)) }))
    .sort((left, right) => (right.views ?? 0) - (left.views ?? 0));
  return out;
}

// --- the Audience tab ---

const COUNTRY_SHARE: ReadonlyArray<[string, number]> = [
  ["US", 0.47], ["GB", 0.09], ["CA", 0.07], ["DE", 0.055], ["AU", 0.045], ["FR", 0.03], ["NL", 0.025],
  ["SE", 0.02], ["BR", 0.02], ["MX", 0.018], ["IT", 0.017], ["ES", 0.016], ["PL", 0.014], ["IE", 0.012],
  ["NO", 0.01], ["JP", 0.009], ["IN", 0.008], ["NZ", 0.007], ["CH", 0.006],
];

function creatorStatsAudience(request: DemoRequest): KernelOperationResponse<"creatorStatsAudience"> | DemoReply {
  const page = ownerPage(request);
  if (isReply(page)) return page;
  const window = windowOf(request);
  if (isReply(window)) return window;
  const base = { page: { label: page.label, platform: page.platform }, window };
  if (page.platform !== "fansly") {
    return { ...base, countries: [], countriesCoveredDays: 0, tags: null, activeHours: null, benchmarks: null, mediaShown: [] };
  }
  const now = request.now;
  const reach = reachOf(page);
  const random = rng(`audience:${page.label}:${window.days}`);
  // The audience lane runs since 2026-10-04: a month at most.
  const covered = Math.min(window.days, 30, reach.historyDays);
  const windowViews = reach.views * covered;
  const countries = COUNTRY_SHARE.flatMap(([country, share]) => [0, 1].map((source) => {
    const views = Math.round(windowViews * share * (source === 0 ? reach.split[0]! : reach.split[1]!) * between(random, 0.8, 1.2));
    return {
      country,
      source,
      views,
      watchMs: Math.round(views * between(random, 7, 12) * 1000),
      profileVisits: Math.round(views * between(random, 0.025, 0.04)),
    };
  }));
  const tagFrom = isoDay(new Date(startOfDayMs(now) - Math.min(window.days, 28) * DAY_MS));
  const tagRows = TAGS.slice(0, 16).flatMap((tag, index) => [0, 1].map((source) => {
    const views = Math.round(windowViews * 0.12 * Math.exp(-index / 4) * (source === 0 ? 1 : 0.35) * between(random, 0.7, 1.3));
    const video = Math.round(views * 0.88);
    const liftAvailable = source === 0 && index < 12;
    return {
      tag, source, views, videoViews: video,
      completedViews: Math.round(video * between(random, 0.12, 0.3)),
      liftPoints: liftAvailable ? Math.round(between(random, -6, 9) * 10) / 10 : null,
      liftAvailable,
    };
  })).sort((left, right) => (right.views ?? 0) - (left.views ?? 0));
  const cells: Array<{ source: number; weekday: number; hour: number; views: number }> = [];
  for (const source of [0, 1]) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const diurnal = 0.25 + 0.75 * (0.5 + 0.5 * Math.cos(((hour - 2) / 24) * 2 * Math.PI));
        const weekend = weekday === 0 || weekday === 6 || (weekday === 5 && hour >= 20) ? 1.25 : 1;
        cells.push({ source, weekday, hour, views: Math.round((windowViews / 168) * reach.split[source]! * diurnal * weekend * between(random, 0.8, 1.2)) });
      }
    }
  }
  const buckets: ReadonlyArray<[number, number, number | null]> = [[0, 0, 15_000], [1, 15_000, 30_000], [2, 30_000, 60_000], [3, 60_000, 180_000], [4, 180_000, null]];
  const benchmarks = [0, 1].flatMap((source) => buckets.map(([lengthBucket, minMs, maxMs]) => {
    const avg = Math.max(8, reach.watchPct * (1.5 - lengthBucket * 0.22) * (source === 0 ? 0.92 : 1.08) * between(random, 0.9, 1.1));
    return {
      source, lengthBucket, minMs, maxMs,
      mediaCount: lengthBucket === 4 && page.label.startsWith("ivy") ? 0 : intBetween(random, 2, 14),
      avgWatchPercent: Math.round(avg * 10) / 10,
      completionRate: Math.round(Math.min(0.9, avg / 100 * 0.62) * 1000) / 1000,
      videoViews: Math.round(windowViews * 0.1 * between(random, 0.4, 1.6)),
    };
  }));
  const mediaShown: Array<{ hour: string; source: number; mediaShown: number }> = [];
  const hourNow = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
  for (let hour = hourNow - 71 * 3_600_000; hour <= hourNow; hour += 3_600_000) {
    const utcHour = new Date(hour).getUTCHours();
    const diurnal = 0.4 + 0.6 * (0.5 + 0.5 * Math.cos(((utcHour - 2) / 24) * 2 * Math.PI));
    const hourRandom = rng(`shown:${page.label}:${hour}`);
    mediaShown.push(
      { hour: new Date(hour).toISOString(), source: 0, mediaShown: Math.round(26 * diurnal * between(hourRandom, 0.7, 1.2)) },
      { hour: new Date(hour).toISOString(), source: 1, mediaShown: Math.round(14 * diurnal * between(hourRandom, 0.7, 1.2)) },
    );
  }
  const windowFrom = isoDay(new Date(startOfDayMs(now) - (covered - 1) * DAY_MS));
  return {
    ...base,
    countries,
    countriesCoveredDays: covered,
    tags: { fromDay: tagFrom, toDay: isoDay(now), rows: tagRows },
    activeHours: { fromDay: windowFrom, toDay: isoDay(now), cells },
    benchmarks: { fromDay: windowFrom, toDay: isoDay(now), rows: benchmarks },
    mediaShown,
  };
}

export const creatorStatsHandlers: DemoHandlers = {
  creatorStatsOverview,
  creatorStatsContent,
  creatorStatsMedia,
  creatorStatsAudience,
};

