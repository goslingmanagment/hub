/**
 * The «page» area's view of the invented agency: who a page's subscribers and
 * followers are, what each fan bought and when, and how a page's windows are
 * counted. Everything is derived from world.ts and cached per page, so the
 * page's overview, its lists, a fan's card and the top-fans table tell the
 * same story: a fan's spend is the sum of his transactions, the follower
 * chart counts the same follows the follower list shows.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import {
  between,
  daysAgo,
  demoError,
  hashString,
  hoursAgo,
  intBetween,
  iso,
  isoDay,
  pick,
  queryString,
  rng,
  type DemoReply,
  type DemoRequest,
} from "../core.ts";
import { DEMO_PAGES, demoFans, demoPage, demoUserByRole, type DemoFan, type DemoPage } from "../world.ts";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/** Fansly and OnlyFans both keep 20 %: net = gross × 0.8. */
export const CREATOR_SHARE = 0.8;
/** OnlyFans collection through the vendor stopped this many days ago (2026-11-01). */
export const OFF_SHIFT_DAYS = 2;

export type AssignedPage = KernelOperationResponse<"pageSubscribers">["page"];
export type CanonicalType = KernelOperationResponse<"pageTransactions">["items"][number]["canonicalType"];

// --- Pages ---

/** The page a request names, if the console's person may see it. */
export function resolvePage(request: DemoRequest): DemoPage | DemoReply {
  const label = request.params.pageLabel ?? queryString(request, "pageLabel") ?? "";
  const page = demoPage(label);
  if (!page) return demoError(404, "not_found", `Страница ${label} не найдена`);
  if (!demoUserByRole(request.role).pages.includes(page.label)) {
    return demoError(404, "not_found", `Страница ${label} не найдена`);
  }
  return page;
}

export function assignedPage(page: DemoPage, now: Date): AssignedPage {
  return {
    id: page.id,
    label: page.label,
    platform: page.platform,
    modelSlug: page.modelSlug,
    modelName: page.modelName,
    username: page.username,
    displayName: page.displayName,
    followerCount: { value: page.followers, available: page.followers !== null },
    subscriberCount: { value: page.subscribers, available: true },
    lastLightSyncAt: page.health === "off" ? iso(daysAgo(now, OFF_SHIFT_DAYS)) : iso(hoursAgo(now, 0.3)),
    lastFollowerSyncAt: page.platform === "fansly" ? iso(hoursAgo(now, page.health === "attention" ? 9 : 1)) : null,
    capabilities: { voiceNotes: page.platform === "fansly" },
  };
}

export function pageRefShort(page: DemoPage) {
  return { id: page.id, label: page.label, platform: page.platform, modelSlug: page.modelSlug, modelName: page.modelName };
}

/** How far back a page's data reaches: an OnlyFans page stopped two days ago. */
export function shiftHours(page: DemoPage): number {
  return page.health === "off" ? OFF_SHIFT_DAYS * 24 : 0;
}

// --- The page's people: the rich fans of world.ts and the quiet crowd ---

const FILLER_STEMS = [
  "alpha", "bear", "billy", "bobby", "brad", "buck", "carlos", "casey", "chad", "cody",
  "dale", "derek", "doug", "duke", "dylan", "ethan", "felix", "gary", "glen", "grant",
  "greg", "hank", "ian", "jack", "jay", "jeff", "jim", "josh", "keith", "kurt",
  "lance", "larry", "luke", "mark", "matt", "milo", "neil", "noah", "otto", "owen",
  "pete", "phil", "quinn", "ralph", "ray", "rex", "rob", "rod", "ross", "russ",
  "ryan", "scott", "sean", "seth", "shane", "steve", "ted", "tim", "todd", "tony",
  "travis", "troy", "tyler", "victor", "wade", "walt", "wes", "will", "zack", "zeke",
  "nomad", "pilot", "sailor", "biker", "gamer", "trucker", "cowboy", "surfer", "drifter", "ranger",
] as const;

const FILLER_TAILS = ["", "", "", "_", "x", "xx", "_88", "_tx", "_uk", "_nyc", "77", "99", "_irl", "_1"] as const;

const FILLER_NAMES = [
  "Billy", "Chad", "Derek", "Doug", "Ethan", "Greg", "Hank", "Jack", "Jeff", "Josh", "Kurt", "Luke",
  "Mark", "Matt", "Neil", "Owen", "Pete", "Ray", "Rob", "Ryan", "Sean", "Steve", "Ted", "Tony",
  "Tyler", "Wade", "Will", "Zack", "J.", "M.", "Big Bear", "Lonely Pilot", "Mr. Nice", "Captain",
] as const;

export const FAN_LINES = [
  "good morning beautiful ☀️",
  "you looked amazing in that last post",
  "how was your day babe?",
  "haha you're too much 😂",
  "can I get something special this weekend?",
  "just got off work, thinking about you",
  "that video was 🔥🔥",
  "did you get my tip?",
  "miss talking to you",
  "what are you up to tonight?",
  "send me a pic of your outfit today?",
  "you always make my day better",
  "sorry I was busy this week",
  "I'd love a custom, how much?",
  "night night 😘",
  "are you going live this week?",
  "lol yes exactly",
  "ok unlocking it now",
] as const;

export const MODEL_LINES = [
  "hiii you 🥰 missed you",
  "aww you're sweet, my day was long but better now",
  "I have something new I think you'll like 😏",
  "just finished a little shoot… want a peek?",
  "you're one of my favorites, you know that?",
  "tell me about your day babe",
  "I'll be live on friday, save me a seat 💕",
  "for you? I can do a custom, tell me what you want",
  "hehe glad you liked it",
  "thank you so much for the tip!! 🥺",
  "sleep well handsome 😘",
  "what are you wearing rn? 😇",
] as const;

export interface PageFan {
  fan: DemoFan;
  /** One of the world's spenders (false: the quiet crowd). */
  core: boolean;
  /** Hours since the fan followed; null: not a follower. */
  followedHoursAgo: number | null;
  subscription: {
    id: string;
    startedHoursAgo: number;
    /** Hours until the paid period ends (negative never). */
    endsInHours: number;
    autoRenew: boolean | null;
    autoRenewOffDaysAgo: number | null;
    tierName: string | null;
    paid: boolean;
  } | null;
  /** Hours since the fan's account was made. */
  createdHoursAgo: number;
  dm: {
    conversationId: string;
    lastMessageHoursAgo: number;
    lastFanMessageHoursAgo: number | null;
    lastModelMessageHoursAgo: number | null;
    unreadCount: number;
    preview: string;
    storedMessageCount: number;
  } | null;
  presence: { status: "active_now" | "recently_active" | "offline"; lastSeenHoursAgo: number | null };
}

function tierNameOf(page: DemoPage, price: number): string | null {
  if (page.platform === "onlyfans") return null;
  if (price === 0) return "Free";
  if (price < 10) return "Bestie";
  if (price < 20) return "Inner Circle";
  return "VIP";
}

function conversationIdOf(page: DemoPage, fanId: string): string {
  const digits = String(hashString(`conv:${page.label}:${fanId}`)).padStart(10, "3");
  return page.platform === "fansly" ? `8${digits}${fanId.slice(-7)}` : `${fanId}`;
}

function makePageFan(page: DemoPage, fan: DemoFan, core: boolean, random: () => number, crowd?: {
  followedHoursAgo: number | null;
  subscribedHoursAgo: number | null;
}): PageFan {
  const followedHoursAgo = page.platform === "fansly"
    ? crowd ? crowd.followedHoursAgo : fan.firstSeenDaysAgo * 24 + between(random, 0, 23)
    : null;
  let subscription: PageFan["subscription"] = null;
  if (fan.isSubscriber) {
    const startedHoursAgo = crowd?.subscribedHoursAgo
      ?? Math.min((followedHoursAgo ?? fan.firstSeenDaysAgo * 24), between(random, 0.1, 1) * fan.firstSeenDaysAgo * 24 + between(random, 0, 23));
    const cycle = 30 * 24;
    const elapsed = startedHoursAgo % cycle;
    // A fresh subscription renews: fans turn renewal off a few days in.
    const autoRenew = random() < 0.05 ? null : startedHoursAgo < 72 ? true : fan.autoRenew;
    subscription = {
      id: `${page.platform === "fansly" ? "6" : "9"}${String(hashString(`sub:${page.label}:${fan.platformUserId}`)).padStart(10, "1")}`,
      startedHoursAgo,
      endsInHours: Math.max(2, cycle - elapsed),
      autoRenew,
      autoRenewOffDaysAgo: autoRenew === false ? Math.max(0, Math.floor(startedHoursAgo / 24) - intBetween(random, 2, 20)) : null,
      tierName: tierNameOf(page, fan.tierPrice),
      paid: fan.tierPrice > 0,
    };
  }
  const writes = core ? fan.lastMessageDaysAgo < 80 : random() < 0.22;
  // Nothing happens before the fan came: no chat, no visit before his follow or subscription.
  const knownHours = Math.max(0.3, followedHoursAgo ?? subscription?.startedHoursAgo ?? fan.firstSeenDaysAgo * 24);
  const lastMessageHoursAgo = Math.min(knownHours * 0.95, core ? fan.lastMessageDaysAgo * 24 + between(random, 0.2, 20) : between(random, 0.2, 60 * 24) * random());
  const fanWroteLast = random() < 0.55;
  const dm: PageFan["dm"] = writes
    ? {
      conversationId: conversationIdOf(page, fan.platformUserId),
      lastMessageHoursAgo,
      lastFanMessageHoursAgo: fanWroteLast ? lastMessageHoursAgo : Math.min(knownHours, lastMessageHoursAgo + between(random, 0.1, 30)),
      lastModelMessageHoursAgo: fanWroteLast ? Math.min(knownHours, lastMessageHoursAgo + between(random, 0.2, 12)) : lastMessageHoursAgo,
      unreadCount: fanWroteLast && lastMessageHoursAgo < 36 ? intBetween(random, 1, 3) : 0,
      preview: fanWroteLast ? pick(random, FAN_LINES) : pick(random, MODEL_LINES),
      storedMessageCount: core ? intBetween(random, 40, 1800) : intBetween(random, 2, 60),
    }
    : null;
  const roll = random();
  const presence: PageFan["presence"] = roll < 0.025
    ? { status: "active_now", lastSeenHoursAgo: 0 }
    : roll < 0.1
      ? { status: "recently_active", lastSeenHoursAgo: between(random, 0.2, 1.8) }
      : roll < 0.75
        ? { status: "offline", lastSeenHoursAgo: Math.min(knownHours * 0.9, 2 + -Math.log(Math.max(random(), 1e-6)) * 90) }
        : { status: "offline", lastSeenHoursAgo: null };
  const created = (fan.firstSeenDaysAgo + intBetween(random, 3, 900)) * 24;
  // An OnlyFans page stopped being read on 2026-11-01: what Hub knows of it is two days old.
  const shift = shiftHours(page);
  if (shift === 0) return { fan, core, followedHoursAgo, subscription, createdHoursAgo: created, dm, presence };
  return {
    fan,
    core,
    followedHoursAgo: followedHoursAgo === null ? null : followedHoursAgo + shift,
    subscription: subscription ? { ...subscription, startedHoursAgo: subscription.startedHoursAgo + shift } : null,
    createdHoursAgo: created + shift,
    dm: dm
      ? {
        ...dm,
        lastMessageHoursAgo: dm.lastMessageHoursAgo + shift,
        lastFanMessageHoursAgo: dm.lastFanMessageHoursAgo === null ? null : dm.lastFanMessageHoursAgo + shift,
        lastModelMessageHoursAgo: dm.lastModelMessageHoursAgo === null ? null : dm.lastModelMessageHoursAgo + shift,
        unreadCount: 0,
      }
      : null,
    presence: { status: "offline", lastSeenHoursAgo: presence.lastSeenHoursAgo === null ? null : presence.lastSeenHoursAgo + shift },
  };
}

const populationCache = new Map<string, PageFan[]>();

/**
 * Everyone a page knows: the world's fans of the page first, then as many
 * quiet followers and subscribers as the page's counters say it has.
 */
export function pagePopulation(page: DemoPage): PageFan[] {
  const cached = populationCache.get(page.label);
  if (cached) return cached;
  const core = demoFans(page.label);
  // A nickname ("Cold Captain") belongs to one fan of a page; the others go by their handle.
  const nicknames = new Set<string>();
  const unique = (fan: DemoFan): DemoFan => {
    if (!fan.displayName.includes(" ") || fan.displayName === fan.username) return fan;
    if (!nicknames.has(fan.displayName)) {
      nicknames.add(fan.displayName);
      return fan;
    }
    return { ...fan, displayName: fan.username };
  };
  const out: PageFan[] = core.map((fan) => makePageFan(page, unique(fan), true, rng(`pf:${page.label}:${fan.platformUserId}`)));
  const coreSubs = core.filter((fan) => fan.isSubscriber).length;
  const extraSubs = Math.max(0, page.subscribers - coreSubs);
  const extraFollowers = page.platform === "fansly" ? Math.max(0, (page.followers ?? 0) - core.length) : 0;
  const crowd = Math.max(extraSubs, extraFollowers);
  // New follows and subscriptions a day, as the counters' growth shows them.
  const followMeanDays = Math.max(60, (page.followers ?? 0) / Math.max(4, (page.followers ?? 0) / 230));
  const subMeanDays = page.platform === "onlyfans" ? 140 : 95;
  for (let index = 0; index < crowd; index += 1) {
    const random = rng(`crowd:${page.label}:${index}`);
    const stem = pick(random, FILLER_STEMS);
    const username = `${stem}${pick(random, FILLER_TAILS)}${random() < 0.55 ? intBetween(random, 1, 9999) : ""}`;
    const isSubscriber = index < extraSubs;
    const isFollower = page.platform === "fansly" && index < extraFollowers;
    const followedHoursAgo = isFollower ? Math.min(900 * 24, -Math.log(Math.max(random(), 1e-9)) * followMeanDays * 24) : null;
    const subscribedHoursAgo = isSubscriber
      ? Math.min(followedHoursAgo ?? Number.POSITIVE_INFINITY, -Math.log(Math.max(random(), 1e-9)) * subMeanDays * 24)
      : null;
    const paid = isSubscriber && random() < (page.platform === "onlyfans" ? 0.7 : 0.42);
    const spender = isSubscriber && random() < 0.07;
    const firstSeenDaysAgo = Math.floor(Math.max(followedHoursAgo ?? 0, subscribedHoursAgo ?? 0) / 24) + 1;
    const lastPurchaseDaysAgo = spender ? Math.min(firstSeenDaysAgo, intBetween(random, 0, 90)) : null;
    const totalSpent = spender ? Math.round(between(random, 4, 45) * 100) / 100 : 0;
    const id = String(hashString(`crowd-id:${page.label}:${index}`)).padStart(10, "5");
    const fan: DemoFan = {
      platformUserId: page.platform === "fansly" ? `7${id}${String(500000 + index).padStart(7, "0")}` : `${1000000 + (hashString(id) % 8000000)}`,
      username,
      displayName: random() < 0.55 ? pick(random, FILLER_NAMES) : username,
      totalSpent,
      spent30d: lastPurchaseDaysAgo !== null && lastPurchaseDaysAgo <= 30 ? totalSpent : 0,
      purchases: spender ? intBetween(random, 1, 3) : 0,
      firstSeenDaysAgo,
      lastPurchaseDaysAgo,
      lastMessageDaysAgo: 999,
      isSubscriber,
      isFollower,
      tierPrice: paid ? pick(random, [4.99, 9.99, 9.99, 14.99]) : 0,
      autoRenew: random() < 0.74,
      country: "US",
    };
    out.push(makePageFan(page, unique(fan), false, random, { followedHoursAgo, subscribedHoursAgo }));
  }
  populationCache.set(page.label, out);
  return out;
}

const byIdCache = new Map<string, Map<string, PageFan>>();

export function findPageFan(page: DemoPage, platformUserId: string): PageFan | undefined {
  let index = byIdCache.get(page.label);
  if (!index) {
    index = new Map(pagePopulation(page).map((item) => [item.fan.platformUserId, item]));
    byIdCache.set(page.label, index);
  }
  return index.get(platformUserId);
}

export function findByConversation(page: DemoPage, conversationId: string): PageFan | undefined {
  return pagePopulation(page).find((item) => item.dm?.conversationId === conversationId);
}

export function fanMatches(fan: DemoFan, query: string | undefined): boolean {
  if (!query) return true;
  const needle = query.trim().toLowerCase().replace(/^@/, "");
  return fan.username.toLowerCase().includes(needle) || fan.displayName.toLowerCase().includes(needle) || fan.platformUserId === needle;
}

export function fanIdentity(page: DemoPage, item: PageFan, now: Date) {
  return {
    platform: page.platform,
    platformUserId: item.fan.platformUserId,
    username: item.fan.username,
    displayName: item.fan.displayName === item.fan.username ? null : item.fan.displayName,
    createdAtExternal: iso(hoursAgo(now, item.createdHoursAgo)),
    pageAlias: null,
  };
}

// --- What each fan bought ---

export interface DemoTx {
  id: string;
  rawType: number | string;
  type: CanonicalType;
  /** Hours before the request. */
  hoursAgo: number;
  netMills: number;
  grossMills: number;
  pending: boolean;
}

const FANSLY_RAW: Record<CanonicalType, number> = {
  subscription: 3, tip: 7, message_purchase: 26, post_purchase: 25, stream_tip: 41, chargeback: 90, refund: 91, payout_reversal: 92, other: 0,
};

const OF_RAW: Record<CanonicalType, string> = {
  subscription: "subscription", tip: "tip", message_purchase: "message", post_purchase: "post", stream_tip: "stream", chargeback: "chargeback", refund: "refund", payout_reversal: "payout_reversal", other: "other",
};

function grossPrice(random: () => number, type: CanonicalType, fan: DemoFan): number {
  switch (type) {
    case "subscription": return fan.tierPrice > 0 ? fan.tierPrice : 9.99;
    case "tip": return pick(random, [3, 5, 5, 10, 10, 15, 20, 25, 50, 100]);
    case "stream_tip": return pick(random, [5, 10, 20]);
    case "post_purchase": return pick(random, [4.99, 7.99, 9.99, 14.99]);
    default: return pick(random, [6.99, 9.99, 12.99, 14.99, 19.99, 24.99, 29.99, 39.99, 49.99]);
  }
}

const txCache = new Map<string, DemoTx[]>();

/**
 * A fan's transactions on a page, newest first: real prices, the latest on
 * the day world.ts says he last bought, adding up to about his total spend.
 */
export function fanTransactions(page: DemoPage, fan: DemoFan): DemoTx[] {
  const key = `${page.label}:${fan.platformUserId}`;
  const cached = txCache.get(key);
  if (cached) return cached;
  const out: DemoTx[] = [];
  if (fan.totalSpent > 0 && fan.lastPurchaseDaysAgo !== null) {
    const random = rng(`tx:${key}`);
    const last = fan.lastPurchaseDaysAgo;
    const first = Math.max(fan.firstSeenDaysAgo, last);
    const shift = shiftHours(page);
    let remaining = fan.totalSpent;
    let index = 0;
    while (remaining > 0.5 && index < 400) {
      const roll = random();
      const type: CanonicalType = fan.tierPrice > 0 && roll < 0.2
        ? "subscription"
        : roll < 0.5 ? "tip" : roll < 0.9 ? "message_purchase" : roll < 0.97 ? "post_purchase" : page.platform === "fansly" ? "stream_tip" : "tip";
      let gross = grossPrice(random, type, fan);
      let net = Math.round(gross * CREATOR_SHARE * 100) / 100;
      if (net > remaining) {
        net = Math.round(remaining * 100) / 100;
        gross = Math.round((net / CREATOR_SHARE) * 100) / 100;
      }
      remaining -= net;
      const day = index === 0 ? last : last + (first - last) * random() ** 0.8;
      const hours = day * 24 + between(random, 0.1, 22) + shift;
      out.push({
        id: page.platform === "fansly"
          ? `9${String(hashString(`${key}:${index}`)).padStart(10, "4")}${String(index).padStart(6, "0")}`
          : `${4000000000 + (hashString(`${key}:${index}`) % 900000000)}`,
        rawType: page.platform === "fansly" ? FANSLY_RAW[type] : OF_RAW[type],
        type,
        hoursAgo: hours,
        netMills: Math.round(net * 1000),
        grossMills: Math.round(gross * 1000),
        pending: hours < 30 && random() < 0.5,
      });
      index += 1;
    }
    // Now and then a card bank takes a purchase back.
    if (out.length >= 4 && random() < 0.04) {
      const victim = out[intBetween(random, 1, out.length - 1)]!;
      out.push({
        id: `${victim.id}-cb`,
        rawType: page.platform === "fansly" ? FANSLY_RAW.chargeback : OF_RAW.chargeback,
        type: "chargeback",
        hoursAgo: Math.max(shift + 1, victim.hoursAgo - between(random, 24, 24 * 20)),
        netMills: -victim.netMills,
        grossMills: -victim.grossMills,
        pending: false,
      });
    }
  }
  out.sort((left, right) => left.hoursAgo - right.hoursAgo);
  txCache.set(key, out);
  return out;
}

const pageTxCache = new Map<string, { item: PageFan; tx: DemoTx }[]>();

/** Every transaction of the page, newest first. */
export function pageTransactionsOf(page: DemoPage): { item: PageFan; tx: DemoTx }[] {
  const cached = pageTxCache.get(page.label);
  if (cached) return cached;
  const out: { item: PageFan; tx: DemoTx }[] = [];
  for (const item of pagePopulation(page)) {
    if (item.fan.totalSpent <= 0) continue;
    for (const tx of fanTransactions(page, item.fan)) out.push({ item, tx });
  }
  out.sort((left, right) => left.tx.hoursAgo - right.tx.hoursAgo);
  pageTxCache.set(page.label, out);
  return out;
}

// --- Windows ---

export type SpenderPeriod = "today" | "7d" | "30d" | "90d" | "180d" | "mtd" | "custom" | "lifetime";

export interface Window {
  period: SpenderPeriod;
  /** Inclusive UTC days; null on lifetime. */
  fromDay: string | null;
  toDay: string | null;
  days: number | null;
}

function dayIndex(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

export function dayOf(now: Date, hours: number): string {
  return isoDay(new Date(now.getTime() - hours * HOUR_MS));
}

export function spenderWindow(request: DemoRequest): Window {
  const raw = queryString(request, "period") ?? "lifetime";
  const period = (["today", "7d", "30d", "90d", "180d", "mtd", "custom", "lifetime"].includes(raw) ? raw : "lifetime") as SpenderPeriod;
  const today = isoDay(request.now);
  const span = (days: number): Window => ({ period, fromDay: isoDay(daysAgo(request.now, days - 1)), toDay: today, days });
  switch (period) {
    case "today": return span(1);
    case "7d": return span(7);
    case "30d": return span(30);
    case "90d": return span(90);
    case "180d": return span(180);
    case "mtd": {
      const from = `${today.slice(0, 8)}01`;
      return { period, fromDay: from, toDay: today, days: dayIndex(today) - dayIndex(from) + 1 };
    }
    case "custom": {
      const from = queryString(request, "from") ?? today;
      const to = queryString(request, "to") ?? today;
      return { period, fromDay: from, toDay: to, days: dayIndex(to) - dayIndex(from) + 1 };
    }
    case "lifetime": return { period, fromDay: null, toDay: null, days: null };
  }
}

export function previousWindow(window: Window): Window | null {
  if (window.fromDay === null || window.days === null) return null;
  const from = dayIndex(window.fromDay);
  const to = new Date((from - 1) * DAY_MS);
  const start = new Date((from - window.days) * DAY_MS);
  return { period: "custom", fromDay: isoDay(start), toDay: isoDay(to), days: window.days };
}

export function inWindow(window: Window, now: Date, hours: number): boolean {
  if (window.fromDay === null || window.toDay === null) return true;
  const day = dayOf(now, hours);
  return day >= window.fromDay && day <= window.toDay;
}

export function spenderPeriodShape(window: Window, now: Date) {
  return { timeZone: "UTC", fromBusinessDate: window.fromDay, toBusinessDateInclusive: window.toDay, asOf: iso(hoursAgo(now, 0.25)) };
}

export interface WindowMetrics {
  grossAmountMills: number;
  creatorNetAmountMills: number;
  postedGrossAmountMills: number;
  pendingGrossAmountMills: number;
  unknownGrossAmountMills: number;
  postedCreatorNetAmountMills: number;
  pendingCreatorNetAmountMills: number;
  unknownCreatorNetAmountMills: number;
  transactionCount: number;
  lastTransactionAt: string | null;
}

export function metricsOf(txs: readonly DemoTx[], now: Date): WindowMetrics {
  const metrics: WindowMetrics = {
    grossAmountMills: 0,
    creatorNetAmountMills: 0,
    postedGrossAmountMills: 0,
    pendingGrossAmountMills: 0,
    unknownGrossAmountMills: 0,
    postedCreatorNetAmountMills: 0,
    pendingCreatorNetAmountMills: 0,
    unknownCreatorNetAmountMills: 0,
    transactionCount: 0,
    lastTransactionAt: null,
  };
  let newest = Number.POSITIVE_INFINITY;
  for (const tx of txs) {
    metrics.grossAmountMills += tx.grossMills;
    metrics.creatorNetAmountMills += tx.netMills;
    if (tx.pending) {
      metrics.pendingGrossAmountMills += tx.grossMills;
      metrics.pendingCreatorNetAmountMills += tx.netMills;
    } else {
      metrics.postedGrossAmountMills += tx.grossMills;
      metrics.postedCreatorNetAmountMills += tx.netMills;
    }
    metrics.transactionCount += 1;
    newest = Math.min(newest, tx.hoursAgo);
  }
  metrics.lastTransactionAt = Number.isFinite(newest) ? iso(hoursAgo(now, newest)) : null;
  return metrics;
}

export function windowTxs(page: DemoPage, fan: DemoFan, window: Window, now: Date): DemoTx[] {
  return fanTransactions(page, fan).filter((tx) => inWindow(window, now, tx.hoursAgo));
}

/** Retention as the hub classifies it (packages/shared spender-retention). */
export function retentionOf(lastHoursAgo: number | null, lifetimeNetMills: number): "active" | "cooling" | "inactive" | "needs_reactivation" {
  const days = lastHoursAgo === null ? Number.POSITIVE_INFINITY : lastHoursAgo / 24;
  if (days <= 14) return "active";
  if (days <= 45) return "cooling";
  return lifetimeNetMills >= 100_000 ? "needs_reactivation" : "inactive";
}

export function paginate<T>(request: DemoRequest, items: readonly T[], fallbackLimit = 50): { items: T[]; limit: number; offset: number; total: number } {
  const limit = Math.min(200, Math.max(1, Number(queryString(request, "limit") ?? fallbackLimit) || fallbackLimit));
  const offset = Math.max(0, Number(queryString(request, "offset") ?? 0) || 0);
  return { items: items.slice(offset, offset + limit), limit, offset, total: items.length };
}

export function queryBool(request: DemoRequest, key: string): boolean | undefined {
  const value = queryString(request, key);
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function pagesOfPlatform(platform: string): DemoPage[] {
  return DEMO_PAGES.filter((page) => page.platform === platform);
}

/** A share of a window's net per transaction type: every page sells its own way. */
export function revenueMix(page: DemoPage): Record<"subscription" | "tip" | "message_purchase" | "post_purchase" | "stream_tip", number> {
  const random = rng(`mix:${page.label}`);
  const sub = page.platform === "onlyfans" ? between(random, 0.3, 0.4) : between(random, 0.14, 0.24);
  const tip = between(random, 0.22, 0.32);
  const post = between(random, 0.03, 0.07);
  const stream = page.platform === "fansly" ? between(random, 0.005, 0.02) : 0;
  return { subscription: sub, tip, post_purchase: post, stream_tip: stream, message_purchase: Math.max(0, 1 - sub - tip - post - stream) };
}
