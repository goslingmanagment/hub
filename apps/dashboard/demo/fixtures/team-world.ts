/**
 * The team's working life in the demo agency: every chatter's actual shifts
 * (as the chat extension would see them), their messages, PPVs, replies and
 * the sales on the pages they worked. Every «Команда» screen reads this one
 * simulation, so the shifts, the numbers, the reports and the statistics of a
 * chatter agree with each other — and with the pages' revenue in world.ts.
 */
import { between, hashString, intBetween, pick, rng, type DemoRequest } from "../core.ts";
import { DEMO_USERS, demoDailyNet, demoFans, demoPage, demoUserByRole, type DemoFan, type DemoUser } from "../world.ts";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
const MSK = 3 * HOUR;

/** Collection of the OnlyFans pages through the vendor stopped here: nothing of theirs is known after it. */
export const OF_STOP = Date.parse("2026-11-01T00:00:00+03:00");

// --- Moscow days ---

export function mskDay(at: number): string {
  return new Date(at + MSK).toISOString().slice(0, 10);
}

export function mskMidnight(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) - MSK;
}

export function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY).toISOString().slice(0, 10);
}

export function mskHour(at: number): number {
  return new Date(at + MSK).getUTCHours();
}

/** The start of a window of `days` whole Moscow days, today included. */
export function windowStart(now: Date, days: number): number {
  return mskMidnight(addDays(mskDay(now.getTime()), -(days - 1)));
}

/** The Moscow days of a window, oldest first. */
export function windowDays(now: Date, days: number): string[] {
  const today = mskDay(now.getTime());
  return Array.from({ length: days }, (_, index) => addDays(today, index - (days - 1)));
}

export function isoAt(at: number): string {
  return new Date(at).toISOString();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A platform numeric id: digits, never a leading zero. */
export function numericRef(seed: string): string {
  return String(4_000_000_000 + hashString(seed));
}

// --- Who the viewer is ---

/** The pages the console's viewer reaches; null — a chatter, who has no team screens. */
export function viewerPages(request: DemoRequest): readonly string[] | null {
  if (request.role === "chatter") return null;
  return demoUserByRole(request.role).pages;
}

// --- The schedules ---

interface Schedule {
  username: string;
  /** Moscow hour the shift usually starts. */
  startHour: number;
  /** Worked hours, min and max. */
  hours: readonly [number, number];
  pages: ReadonlyArray<readonly [string, number]>;
  /** A page they look into now and then with a few messages. */
  peek: string | null;
  /** Messages per worked hour. */
  rate: number;
  dayOff: number;
  /** Days of extension activity Hub knows. */
  sinceDays: number;
  /** No shift began after this moment. */
  until?: (now: Date) => number;
  ppvShare: number;
  /** Median reply delay, seconds. */
  replyMedian: readonly [number, number];
}

const SCHEDULES: readonly Schedule[] = [
  { username: "alex.k", startHour: 10, hours: [6.5, 8.8], pages: [["mia-1", 0.6], ["mia-2", 0.4]], peek: "mia-3", rate: 40, dayOff: 0.2, sinceDays: 44, ppvShare: 0.05, replyMedian: [95, 240] },
  { username: "kate.v", startHour: 18, hours: [6, 8], pages: [["mia-3", 0.55], ["mia-1", 0.45]], peek: "mia-2", rate: 36, dayOff: 0.22, sinceDays: 44, ppvShare: 0.045, replyMedian: [150, 420] },
  { username: "den.s", startHour: 21, hours: [7, 9.5], pages: [["nova-1", 1]], peek: null, rate: 46, dayOff: 0.15, sinceDays: 41, ppvShare: 0.055, replyMedian: [70, 180] },
  { username: "olya.m", startHour: 12, hours: [6, 8], pages: [["mia-vip-of", 0.55], ["mia-of", 0.45]], peek: null, rate: 31, dayOff: 0.25, sinceDays: 44, until: () => OF_STOP, ppvShare: 0.05, replyMedian: [220, 600] },
  { username: "ivan.p", startHour: 15, hours: [2.3, 4.4], pages: [["ivy-2", 1]], peek: null, rate: 28, dayOff: 0.35, sinceDays: 23, ppvShare: 0.04, replyMedian: [420, 1500] },
  { username: "lena.r", startHour: 13, hours: [5, 7], pages: [["mia-2", 0.5], ["nova-1", 0.5]], peek: null, rate: 33, dayOff: 0.3, sinceDays: 44, until: (now) => now.getTime() - 12 * DAY, ppvShare: 0.05, replyMedian: [180, 500] },
];

/** The chatter still worked for the agency at `at` (a share or a dispute names only such a teammate). */
export function workingAt(user: DemoUser, at: number, now: Date): boolean {
  const schedule = SCHEDULES.find((item) => item.username === user.username);
  if (!schedule) return user.active;
  return schedule.until === undefined || schedule.until(now) > at;
}

// --- The model ---

export type SaleKind = "ppv" | "tip" | "subscription" | "post";
export type Mark = "mine" | "share" | "not_mine";

export interface DemoSale {
  ref: string;
  pageLabel: string;
  platform: "fansly" | "onlyfans";
  kind: SaleKind;
  fan: DemoFan;
  /** Creator's net, mills. */
  netMills: number;
  /** The price the fan paid, mills. */
  priceMills: number;
  at: number;
  /** The chatter's mark in their shift report. */
  mark: Mark;
  shareWith: DemoUser | null;
  /** A «моё» with the chatter's own (lower) amount. */
  ownAmountMills: number | null;
  /** Another chatter's shift holds it too and neither wrote to the fan. */
  overlap: boolean;
}

export interface DemoShiftPage {
  pageLabel: string;
  activeMinutes: number;
  messages: number;
}

export interface DemoShift {
  user: DemoUser;
  startedAt: number;
  endedAt: number;
  ongoing: boolean;
  workedMinutes: number;
  pauses: Array<{ from: number; to: number }>;
  /** The most messages first. */
  pages: DemoShiftPage[];
  messages: number;
  ppvSent: number;
  /** Average price of the PPVs sent, mills. */
  ppvAveragePriceMills: number;
  fansWritten: number;
  replies: number;
  replyMedianSeconds: number;
  repliesWithinHour: number;
  waitingAtEnd: number;
  composed: { hand: number; reply: number; fix: number; greet: number; other: number };
  sales: DemoSale[];
  confirmedAt: number | null;
  /** Other chatters whose shift on one of these pages overlapped this one. */
  together: string[];
  /** Median reply-delay profile, for the delay buckets. */
  speed: number;
}

export interface DemoVisit {
  user: DemoUser;
  startedAt: number;
  endedAt: number;
  workedMinutes: number;
  messages: number;
  pageLabel: string;
  sales: DemoSale[];
}

export interface DemoTeamWorld {
  shifts: DemoShift[];
  visits: DemoVisit[];
  /** The chatter's first minute in the extension Hub knows. */
  activitySince: Map<number, number>;
}

function userOf(username: string): DemoUser {
  const user = DEMO_USERS.find((item) => item.username === username);
  if (!user) throw new Error(`demo: no user ${username}`);
  return user;
}

const PPV_PRICES = [9.99, 14.99, 14.99, 19.99, 19.99, 24.99, 24.99, 29.99, 34.99, 39.99, 49.99, 49.99, 74.99, 99.99, 149.99] as const;
const TIPS = [5, 10, 10, 15, 20, 25, 30, 50, 50, 100, 150] as const;
const SUBS = [9.99, 14.99, 14.99, 24.99] as const;
const POSTS = [7.99, 12.99, 14.99, 19.99] as const;

function saleOf(random: () => number, label: string): { kind: SaleKind; price: number } {
  const roll = random();
  const ivy = label.startsWith("ivy");
  if (roll < (ivy ? 0.35 : 0.56)) return { kind: "ppv", price: pick(random, ivy ? PPV_PRICES.slice(0, 7) : PPV_PRICES) };
  if (roll < (ivy ? 0.8 : 0.82)) return { kind: "tip", price: pick(random, ivy ? TIPS.slice(0, 5) : TIPS) };
  if (roll < 0.92) return { kind: "subscription", price: pick(random, SUBS) };
  return { kind: "post", price: pick(random, POSTS) };
}

/** Net revenue of a page on a Moscow day, dollars — the world's daily figure. */
function pageDayNet(label: string, day: string): number {
  if (demoPage(label)?.platform === "onlyfans" && mskMidnight(day) >= OF_STOP) return 0;
  return demoDailyNet(label, new Date(mskMidnight(day) + 12 * HOUR), 1)[0]?.net ?? 0;
}

function buyers(label: string): DemoFan[] {
  const fans = demoFans(label).filter((fan) => fan.totalSpent > 0);
  return fans.length > 0 ? fans : demoFans(label);
}

function makeSales(
  random: () => number,
  schedule: Schedule,
  label: string,
  pageMinutes: number,
  day: string,
  from: number,
  to: number,
  seed: string,
  now: Date,
): DemoSale[] {
  const page = demoPage(label);
  if (!page || to <= from) return [];
  // The ivy pages earn little: their one chatter's shift holds most of it.
  const target = pageDayNet(label, day) * (pageMinutes / 1440) * (page.dailyNet < 20 ? 4.5 : 1.8);
  const fans = buyers(label);
  const sales: DemoSale[] = [];
  let sum = 0;
  while (sum < target && sales.length < 40) {
    const { kind, price } = saleOf(random, label);
    const net = price * 0.8;
    const left = target - sum;
    if (net > left && random() > left / net) break;
    const fan = fans[Math.floor(random() ** 2.2 * Math.min(fans.length, 90))] ?? fans[0]!;
    const markRoll = random();
    const at = from + Math.floor(random() * (to - from));
    const others = DEMO_USERS.filter((user) => user.role === "chatter" && user.username !== schedule.username && user.pages.includes(label) && workingAt(user, at, now));
    const mark: Mark = markRoll < 0.87 || others.length === 0 ? "mine" : markRoll < 0.95 ? "share" : "not_mine";
    sales.push({
      ref: numericRef(`${seed}:${label}:${sales.length}`),
      pageLabel: label,
      platform: page.platform,
      kind,
      fan,
      netMills: Math.round(net * 1000),
      priceMills: Math.round(price * 1000),
      at,
      mark,
      shareWith: mark === "share" ? pick(random, others) : null,
      ownAmountMills: mark === "mine" && net > 20 && random() < 0.08 ? Math.round(net * 0.5) * 1000 : null,
      overlap: false,
    });
    sum += net;
  }
  return sales.sort((left, right) => left.at - right.at);
}

function simulateChatter(schedule: Schedule, now: Date): { shifts: DemoShift[]; visits: DemoVisit[]; since: number } {
  const user = userOf(schedule.username);
  const nowMs = now.getTime();
  const today = mskDay(nowMs);
  const sinceDay = addDays(today, -schedule.sinceDays);
  const until = schedule.until ? schedule.until(now) : Number.POSITIVE_INFINITY;
  const shifts: DemoShift[] = [];
  const visits: DemoVisit[] = [];
  let since = Number.POSITIVE_INFINITY;
  for (let offset = schedule.sinceDays; offset >= 0; offset -= 1) {
    const day = addDays(today, -offset);
    const random = rng(`shift:${schedule.username}:${day}`);
    const off = random() < schedule.dayOff;
    const start = mskMidnight(day) + schedule.startHour * HOUR + Math.round(between(random, -45, 50)) * MIN;
    if (start > nowMs || start >= until) continue;
    if (off) {
      // A day off now and then has a look-in: not a shift, not in the money.
      if (random() < 0.3 && day !== sinceDay) {
        const visitStart = mskMidnight(day) + intBetween(random, 11, 22) * HOUR + intBetween(random, 0, 59) * MIN;
        const minutes = intBetween(random, 14, 75);
        if (visitStart + minutes * MIN < nowMs) {
          const label = schedule.pages[0]![0];
          const sales = random() < 0.4 ? makeSales(random, schedule, label, minutes * 3, day, visitStart, visitStart + minutes * MIN, `visit:${schedule.username}:${day}`, now).slice(0, 2) : [];
          visits.push({ user, startedAt: visitStart, endedAt: visitStart + minutes * MIN, workedMinutes: minutes, messages: intBetween(random, 6, 34), pageLabel: label, sales });
          since = Math.min(since, visitStart);
        }
      }
      continue;
    }
    since = Math.min(since, start);
    const plannedWorked = Math.round(between(random, schedule.hours[0], schedule.hours[1]) * 60);
    const pauseCount = random() < 0.3 ? 0 : random() < 0.7 ? 1 : intBetween(random, 2, 3);
    const pauses: Array<{ from: number; to: number }> = [];
    let pausedSoFar = 0;
    for (let index = 0; index < pauseCount; index += 1) {
      const length = intBetween(random, 12, 48);
      const from = start + (Math.round((plannedWorked * (index + 1)) / (pauseCount + 1)) + pausedSoFar) * MIN;
      pauses.push({ from, to: from + length * MIN });
      pausedSoFar += length;
    }
    let end = start + (plannedWorked + pausedSoFar) * MIN;
    let ongoing = false;
    let shiftPauses = pauses;
    if (end > nowMs) {
      ongoing = true;
      end = Math.floor(nowMs / MIN) * MIN;
      shiftPauses = pauses.filter((pause) => pause.from < end).map((pause) => ({ from: pause.from, to: Math.min(pause.to, end) }));
    }
    const pausedMinutes = shiftPauses.reduce((sum, pause) => sum + Math.round((pause.to - pause.from) / MIN), 0);
    const workedMinutes = Math.round((end - start) / MIN) - pausedMinutes;
    const messages = Math.max(50, Math.round((workedMinutes / 60) * schedule.rate * between(random, 0.8, 1.2)));
    // An ongoing shift under the rule is a visit so far: the screens do not show it yet.
    if (workedMinutes < 120) continue;

    const weights = schedule.pages.map(([label, weight]) => [label, Math.max(0.05, weight * between(random, 0.75, 1.25))] as const);
    const weightSum = weights.reduce((sum, [, weight]) => sum + weight, 0);
    const pages: DemoShiftPage[] = [];
    let assigned = 0;
    weights.forEach(([label, weight], index) => {
      const share = weight / weightSum;
      const pageMessages = index === weights.length - 1 ? messages - assigned : Math.round(messages * share);
      assigned += pageMessages;
      pages.push({ pageLabel: label, activeMinutes: Math.min(workedMinutes, Math.round(workedMinutes * share * between(random, 1.1, 1.45))), messages: pageMessages });
    });
    let peekMessages = 0;
    if (schedule.peek && random() < 0.22) {
      peekMessages = intBetween(random, 2, 8);
      pages.push({ pageLabel: schedule.peek, activeMinutes: intBetween(random, 4, 25), messages: peekMessages });
    }
    pages.sort((left, right) => right.messages - left.messages);
    const totalMessages = messages + peekMessages;

    const sales = pages
      .filter((page) => page.messages >= 10)
      .flatMap((page) => makeSales(random, schedule, page.pageLabel, page.activeMinutes, day, start, end, `sale:${schedule.username}:${start}`, now))
      .sort((left, right) => left.at - right.at);

    const ppvSales = sales.filter((sale) => sale.kind === "ppv");
    const ppvSent = Math.max(Math.round(totalMessages * schedule.ppvShare * between(random, 0.8, 1.2)), Math.ceil(ppvSales.length * between(random, 2.4, 4.2)));
    const averagePrice = ppvSales.length > 0
      ? ppvSales.reduce((sum, sale) => sum + sale.priceMills, 0) / ppvSales.length * between(random, 1, 1.25)
      : pick(random, [19.99, 24.99, 29.99]) * 1000;
    const replies = Math.round(totalMessages * between(random, 0.42, 0.55));
    const hand = Math.round(totalMessages * between(random, 0.48, 0.62));
    const reply = Math.round(totalMessages * between(random, 0.24, 0.32));
    const fix = Math.round(totalMessages * between(random, 0.05, 0.09));
    const greet = Math.round(totalMessages * between(random, 0.02, 0.04));
    const fansWritten = Math.round(totalMessages / between(random, 4.5, 7));
    const ageHours = (nowMs - end) / HOUR;
    const confirmed = !ongoing && (schedule.until !== undefined ? true : ageHours > 96 || (ageHours > 14 && random() < 0.85));
    shifts.push({
      user,
      startedAt: start,
      endedAt: end,
      ongoing,
      workedMinutes,
      pauses: shiftPauses,
      pages,
      messages: totalMessages,
      ppvSent,
      ppvAveragePriceMills: Math.round(averagePrice / 10) * 10,
      fansWritten,
      replies,
      replyMedianSeconds: intBetween(random, schedule.replyMedian[0], schedule.replyMedian[1]),
      repliesWithinHour: Math.round(replies * between(random, 0.84, 0.98)),
      waitingAtEnd: ongoing ? intBetween(random, 3, 11) : intBetween(random, 0, 8),
      composed: { hand, reply, fix, greet, other: Math.max(0, totalMessages - hand - reply - fix - greet) },
      sales,
      confirmedAt: confirmed ? Math.min(nowMs - 30 * MIN, end + Math.round(between(random, 0.3, 11) * HOUR)) : null,
      together: [],
      speed: (schedule.replyMedian[0] + schedule.replyMedian[1]) / 2,
    });
  }
  return { shifts, visits, since };
}

let cache: { key: number; world: DemoTeamWorld } | null = null;

/** The team's shifts and visits up to `now`, newest first. */
export function teamWorld(now: Date): DemoTeamWorld {
  const key = Math.floor(now.getTime() / MIN);
  if (cache && cache.key === key) return cache.world;
  const shifts: DemoShift[] = [];
  const visits: DemoVisit[] = [];
  const activitySince = new Map<number, number>();
  for (const schedule of SCHEDULES) {
    const result = simulateChatter(schedule, now);
    shifts.push(...result.shifts);
    visits.push(...result.visits);
    activitySince.set(userOf(schedule.username).id, result.since);
  }
  // Two chatters on one page at once: who else a shift's sale counts for.
  for (const shift of shifts) {
    const labels = new Set(shift.pages.filter((page) => page.messages >= 10).map((page) => page.pageLabel));
    const others = shifts.filter((other) => other.user.id !== shift.user.id
      && other.startedAt < shift.endedAt && other.endedAt > shift.startedAt
      && other.pages.some((page) => page.messages >= 10 && labels.has(page.pageLabel)));
    if (others.length === 0) continue;
    const random = rng(`overlap:${shift.user.username}:${shift.startedAt}`);
    let marked = false;
    for (const sale of shift.sales) {
      const both = others.some((other) => other.startedAt <= sale.at && other.endedAt >= sale.at
        && other.pages.some((page) => page.pageLabel === sale.pageLabel && page.messages >= 10));
      if (both && random() < 0.12) {
        sale.overlap = true;
        marked = true;
      }
    }
    if (marked) shift.together = [...new Set(others.map((other) => other.user.username))];
  }
  shifts.sort((left, right) => right.startedAt - left.startedAt);
  visits.sort((left, right) => right.startedAt - left.startedAt);
  const world = { shifts, visits, activitySince };
  cache = { key, world };
  return world;
}

/** The pages a shift worked: its sales count there. */
export function workedPages(shift: DemoShift): string[] {
  return shift.pages.filter((page) => page.messages >= 10).map((page) => page.pageLabel);
}

/** What a chatter's report credits for a sale: «моё» the net (or their own amount), «делим» half, «не моё» nothing. */
export function creditedOf(sale: DemoSale): number {
  if (sale.mark === "not_mine") return 0;
  if (sale.mark === "share") return Math.round(sale.netMills / 2);
  return sale.ownAmountMills ?? sale.netMills;
}

/** Messages of a shift on a page that fell on a Moscow day, spread evenly over the worked span. */
export function messagesOnDay(shift: DemoShift, pageLabel: string, day: string): number {
  const page = shift.pages.find((item) => item.pageLabel === pageLabel);
  if (!page || page.messages === 0) return 0;
  const from = Math.max(shift.startedAt, mskMidnight(day));
  const to = Math.min(shift.endedAt, mskMidnight(addDays(day, 1)));
  if (to <= from) return 0;
  return Math.round((page.messages * (to - from)) / (shift.endedAt - shift.startedAt));
}

// --- Buckets shared by the sales screens and the statistics ---

export const PRICE_BUCKETS = [
  { key: "upTo10", upTo: 10_000 },
  { key: "10to25", upTo: 25_000 },
  { key: "25to50", upTo: 50_000 },
  { key: "50to100", upTo: 100_000 },
  { key: "over100", upTo: Number.POSITIVE_INFINITY },
] as const;

/** How the PPVs a chatter sends spread over the price buckets. */
const PRICE_SPREAD = [0.16, 0.4, 0.27, 0.13, 0.04] as const;

export function priceBucketOf(priceMills: number): number {
  return PRICE_BUCKETS.findIndex((bucket) => priceMills <= bucket.upTo);
}

export interface PpvCell { bucket: string; sent: number; bought: number; netMills: number }

/** PPVs by price: the bought ones are the sales, the sent ones spread around them. */
export function ppvCells(sent: number, sales: readonly DemoSale[], seed: string): PpvCell[] {
  const random = rng(`ppv:${seed}`);
  return PRICE_BUCKETS.map((bucket, index) => {
    const bought = sales.filter((sale) => sale.kind === "ppv" && priceBucketOf(sale.priceMills) === index);
    const spread = Math.round(sent * PRICE_SPREAD[index]! * between(random, 0.85, 1.15));
    return {
      bucket: bucket.key,
      sent: Math.max(spread, bought.length === 0 ? 0 : bought.length + Math.ceil(bought.length * between(random, 0.4, 2.5))),
      bought: bought.length,
      netMills: bought.reduce((sum, sale) => sum + sale.netMills, 0),
    };
  });
}

export const DELAY_BUCKETS = ["under5m", "5to15m", "15to60m", "1to6h", "over6h"] as const;

/** How replies spread over the delay buckets for a chatter of a given speed (median seconds). */
export function delaySpread(speed: number): readonly number[] {
  if (speed < 200) return [0.61, 0.22, 0.1, 0.05, 0.02];
  if (speed < 450) return [0.44, 0.27, 0.16, 0.09, 0.04];
  return [0.24, 0.24, 0.25, 0.18, 0.09];
}

/** The share of replies a purchase followed within 24 hours, by delay. */
export const DELAY_BUY_RATE = [0.14, 0.105, 0.078, 0.052, 0.03] as const;

export function pageBuyFactor(label: string): number {
  if (label.startsWith("ivy")) return 0.3;
  if (label === "nova-1") return 1.35;
  if (label.endsWith("-of")) return 1.1;
  return 1;
}

export interface ReplyCell { bucket: string; replies: number; bought: number }

export function replyCells(replies: number, speed: number, buyFactor: number, seed: string): ReplyCell[] {
  const random = rng(`replies:${seed}`);
  const spread = delaySpread(speed);
  return DELAY_BUCKETS.map((bucket, index) => {
    // Rounded by chance, so that many small shifts add up to the right totals.
    const count = Math.floor(replies * spread[index]! * between(random, 0.85, 1.15) + random());
    return { bucket, replies: count, bought: Math.min(count, Math.floor(count * DELAY_BUY_RATE[index]! * buyFactor * between(random, 0.75, 1.25) + random())) };
  });
}

export { rng, between, intBetween, pick };
