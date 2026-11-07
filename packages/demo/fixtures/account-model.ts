/**
 * A chatter's working life in the demo agency: their shifts and visits in the
 * extension, the sales on their pages during them, and their marks in the
 * shift report. One model, so the cabinet's «Статистика», «Отчёт смены» and
 * «Мои AI-траты» tell the same story about the same days.
 *
 * Shifts sit at the same hour of the clock every day, around the moment the
 * request arrived: today's shift is always going on, so the cabinet shows its
 * live state; yesterday's waits for marks, the one before is ready to confirm,
 * older ones are confirmed (one with a late sale that came after).
 */
import type { ChatterSaleKind } from "@agency_hub_core/contracts";

import { between, hashString, intBetween, mills, pick, rng } from "../core.ts";
import { DEMO_USERS, demoDailyNet, demoFans, demoPage, type DemoFan, type DemoPlatform, type DemoUser } from "../world.ts";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
const MSK_OFFSET_MS = 3 * HOUR_MS;

/** How far back the model goes: two of the longest windows, and some. */
const HISTORY_DAYS = 70;
/** The chatter's first minute in the extension, days before today. */
const ACTIVITY_SINCE_DAYS = 52;

/** The Moscow day (YYYY-MM-DD) of an instant. Moscow has no DST: UTC+3. */
export function mskDay(at: number): string {
  return new Date(at + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant a Moscow day starts. */
export function mskMidnight(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) - MSK_OFFSET_MS;
}

export function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

/** The Moscow days from `from` to `to`, both included, oldest first. */
export function dayRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

export interface DemoMark {
  mark: "mine" | "share" | "not_mine";
  shareWith: string | null;
  amountMills: number | null;
  note: string | null;
}

export interface DemoSale {
  ref: string;
  at: number;
  pageLabel: string;
  platform: DemoPlatform;
  kind: ChatterSaleKind;
  /** The shift report's open token. */
  reportKind: string;
  netMills: number;
  fan: DemoFan;
  fanName: string | null;
  /** Another chatter's shift holds it too and neither wrote to the fan. */
  overlap: boolean;
  /** A PPV's price bucket (`upTo10`…), else null. */
  priceBucket: string | null;
  ppvSender: string | null;
  ppvWithoutAuthor: boolean;
  writers: { username: string; messages: number }[];
  withoutAuthor: number;
  myMark: DemoMark | null;
  otherMarks: { username: string; mark: string; shareWith: string | null }[];
  /** The caller's confirmed report holds it. */
  confirmed: boolean;
}

export interface DemoShift {
  visit: boolean;
  /** The Moscow day holding most of it. */
  date: string;
  start: number;
  end: number;
  ongoing: boolean;
  pauses: { from: number; to: number }[];
  workedMinutes: number;
  /** The most active first. */
  pages: string[];
  pageMinutes: Record<string, number>;
  messages: number;
  ppvSent: number;
  fansWritten: number;
  fansPaid: number;
  together: string[];
  sales: DemoSale[];
  confirmedAt: number | null;
  /** Sales that came after the confirmation. */
  pending: number;
}

export interface DemoChatterWorld {
  user: DemoUser;
  now: number;
  today: string;
  /** null — the person never worked in the extension (the owner, a lead). */
  activitySince: number | null;
  /** Shifts and visits, the newest first. */
  shifts: DemoShift[];
  /** Sales outside the caller's shifts a teammate shares with them. */
  sharedWithMe: DemoSale[];
  /** Who worked the caller's pages lately. */
  teammates: DemoUser[];
}

const PPV_PRICES = [7.99, 9.99, 9.99, 9.99, 12, 14.99, 15, 19.99, 19.99, 19.99, 25, 25, 29.99, 35, 45, 60, 75, 99, 150] as const;
const TIP_AMOUNTS = [5, 5, 10, 10, 10, 15, 20, 20, 25, 30, 50, 50, 100] as const;
const SUBSCRIPTION_PRICES = [9.99, 9.99, 14.99, 24.99] as const;
const POST_PRICES = [5, 8, 10, 12, 15, 20] as const;
/** The platform's cut: the creator keeps 80 %. */
const NET_SHARE = 0.8;

export function priceBucket(gross: number): string {
  if (gross < 10) return "upTo10";
  if (gross < 25) return "10to25";
  if (gross < 50) return "25to50";
  if (gross < 100) return "50to100";
  return "over100";
}

const REPORT_KIND: Record<ChatterSaleKind, string> = {
  ppv: "message_purchase",
  tip: "tip",
  subscription: "subscription",
  post: "post_purchase",
};

function numericRef(seed: string): string {
  return String(1_000_000_000 + (hashString(seed) % 8_999_999_999));
}

/** A buyer of the page, the richest the likeliest. */
function pickFan(random: () => number, label: string): DemoFan {
  const buyers = demoFans(label).filter((fan) => fan.totalSpent > 0);
  const pool = buyers.length > 0 ? buyers : demoFans(label);
  const index = Math.floor(random() ** 2.4 * Math.min(pool.length, 90));
  const fan = pool[Math.min(index, pool.length - 1)];
  if (!fan) throw new Error(`demo: no fans on ${label}`);
  return fan;
}

function pickKind(random: () => number): ChatterSaleKind {
  const roll = random();
  if (roll < 0.56) return "ppv";
  if (roll < 0.82) return "tip";
  if (roll < 0.93) return "subscription";
  return "post";
}

function grossOf(random: () => number, kind: ChatterSaleKind): number {
  switch (kind) {
    case "ppv": return pick(random, PPV_PRICES);
    case "tip": return random() < 0.03 ? pick(random, [150, 200, 250]) : pick(random, TIP_AMOUNTS);
    case "subscription": return pick(random, SUBSCRIPTION_PRICES);
    case "post": return pick(random, POST_PRICES);
  }
}

/** Other active chatters who work the page. */
function colleaguesOn(label: string, me: DemoUser): DemoUser[] {
  return DEMO_USERS.filter((user) => user.role === "chatter" && user.active && user.id !== me.id && user.pages.includes(label));
}

interface SaleInput {
  random: () => number;
  seed: string;
  me: DemoUser;
  label: string;
  from: number;
  to: number;
  /** The page's net the shift can carry, dollars. */
  target: number;
}

function salesOf({ random, seed, me, label, from, to, target }: SaleInput): DemoSale[] {
  const page = demoPage(label);
  if (!page || target <= 0) return [];
  const colleagues = colleaguesOn(label, me);
  const sales: DemoSale[] = [];
  let left = target;
  while (left > 3 && sales.length < 40) {
    const kind = pickKind(random);
    const gross = grossOf(random, kind);
    const net = gross * NET_SHARE;
    if (sales.length > 0 && net > left * 1.6) break;
    left -= net;
    const fan = pickFan(random, label);
    const colleague = colleagues.length > 0 && random() < 0.3 ? pick(random, colleagues) : null;
    const overlap = colleague !== null && random() < 0.25;
    const senderRoll = random();
    const ppvSender = kind !== "ppv" ? null
      : colleague !== null && !overlap && senderRoll < 0.3 ? colleague.username
        : senderRoll > 0.95 ? null
          : me.username;
    const writers = overlap ? [] : [
      { username: me.username, messages: intBetween(random, 2, 38) },
      ...(colleague !== null ? [{ username: colleague.username, messages: intBetween(random, 1, 14) }] : []),
    ].sort((left, right) => right.messages - left.messages);
    sales.push({
      ref: numericRef(`${seed}:${label}:${sales.length}`),
      at: Math.round(from + (to - from) * between(random, 0.04, 0.98)),
      pageLabel: label,
      platform: page.platform,
      kind,
      reportKind: kind === "tip" && random() < 0.08 ? "stream_tip" : REPORT_KIND[kind],
      netMills: mills(net),
      fan,
      fanName: random() < 0.04 ? null : fan.displayName,
      overlap,
      priceBucket: kind === "ppv" ? priceBucket(gross) : null,
      ppvSender,
      ppvWithoutAuthor: kind === "ppv" && ppvSender === null,
      writers,
      withoutAuthor: overlap ? intBetween(random, 1, 4) : random() < 0.12 ? intBetween(random, 1, 3) : 0,
      myMark: null,
      otherMarks: [],
      confirmed: false,
    });
  }
  return sales;
}

/** Pauses inside a shift: none to two, ten to forty minutes each. */
function pausesOf(random: () => number, start: number, end: number): { from: number; to: number }[] {
  const count = intBetween(random, 0, 2);
  const pauses: { from: number; to: number }[] = [];
  const length = end - start;
  for (let index = 0; index < count; index += 1) {
    const slotFrom = start + (length * (index + 1)) / (count + 2);
    const from = Math.round((slotFrom + between(random, -20, 20) * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
    const to = from + intBetween(random, 10, 40) * MINUTE_MS;
    if (to < end - 30 * MINUTE_MS) pauses.push({ from, to });
  }
  return pauses;
}

/** The Moscow day holding most of [start, end). */
function majorityDay(start: number, end: number): string {
  const first = mskDay(start);
  const nextMidnight = mskMidnight(addDays(first, 1));
  if (end <= nextMidnight) return first;
  return nextMidnight - start >= end - nextMidnight ? first : mskDay(nextMidnight);
}

function buildShift(me: DemoUser, seed: string, start: number, end: number, ongoing: boolean, visit: boolean): DemoShift {
  const random = rng(seed);
  const pauses = visit ? [] : pausesOf(random, start, end);
  const pausedMinutes = pauses.reduce((sum, pause) => sum + (pause.to - pause.from) / MINUTE_MS, 0);
  const workedMinutes = Math.max(1, Math.round((end - start) / MINUTE_MS - pausedMinutes));
  const pages = me.pages.length > 1 && (visit || random() < 0.25) ? [me.pages[0]!] : [...me.pages];
  const weights = pages.length === 1 ? [1] : [0.58, 0.42];
  const pageMinutes: Record<string, number> = {};
  pages.forEach((label, index) => { pageMinutes[label] = Math.round(workedMinutes * (weights[index] ?? 0.3)); });
  const date = majorityDay(start, end);
  const sales: DemoSale[] = [];
  for (const label of pages) {
    const dayNet = demoDailyNet(label, new Date(mskMidnight(date) + 12 * HOUR_MS), 1)[0]?.net ?? 0;
    // Evenings carry more of a day's money than their share of the clock.
    const share = visit ? (random() < 0.5 ? 0 : 0.05) : (workedMinutes / 1440) * 1.65;
    sales.push(...salesOf({ random, seed, me, label, from: start, to: end, target: dayNet * share }));
  }
  sales.sort((left, right) => left.at - right.at);
  const perHour = intBetween(random, 26, 38);
  const messages = visit ? intBetween(random, 6, 34) : Math.round((workedMinutes / 60) * perHour);
  const ppvSales = sales.filter((sale) => sale.kind === "ppv").length;
  const ppvSent = Math.min(messages, Math.round(ppvSales / between(random, 0.2, 0.3)) + intBetween(random, 0, 3));
  const fansPaid = new Set(sales.map((sale) => `${sale.pageLabel}:${sale.fan.platformUserId}`)).size;
  const fansWritten = Math.max(fansPaid, visit ? intBetween(random, 3, 12) : Math.round((workedMinutes / 60) * between(random, 5, 8)));
  const together = [...new Set(sales.filter((sale) => sale.overlap).flatMap((sale) => colleaguesOn(sale.pageLabel, me).map((user) => user.username)))];
  return {
    visit,
    date,
    start,
    end,
    ongoing,
    pauses,
    workedMinutes,
    pages,
    pageMinutes,
    messages,
    ppvSent,
    fansWritten,
    fansPaid,
    together,
    sales,
    confirmedAt: null,
    pending: 0,
  };
}

/** The mark the chatter gives a sale: theirs, shared, or a colleague's. */
function markOf(random: () => number, sale: DemoSale, me: DemoUser): DemoMark {
  const colleague = sale.writers.find((writer) => writer.username !== me.username)?.username
    ?? (sale.overlap ? colleaguesOn(sale.pageLabel, me)[0]?.username : undefined);
  if (sale.ppvSender !== null && sale.ppvSender !== me.username) {
    return random() < 0.5
      ? { mark: "not_mine", shareWith: null, amountMills: null, note: null }
      : { mark: "share", shareWith: sale.ppvSender, amountMills: null, note: null };
  }
  if (sale.overlap && colleague) return { mark: "share", shareWith: colleague, amountMills: null, note: null };
  return { mark: "mine", shareWith: null, amountMills: null, note: null };
}

function otherMarksOf(sale: DemoSale, me: DemoUser, mine: DemoMark | null, dispute: boolean): DemoSale["otherMarks"] {
  const others = new Set(sale.writers.map((writer) => writer.username).filter((name) => name !== me.username));
  if (sale.overlap) for (const user of colleaguesOn(sale.pageLabel, me)) others.add(user.username);
  return [...others].map((username) => {
    if (dispute) return { username, mark: "mine", shareWith: null };
    if (mine?.mark === "share" && mine.shareWith === username) return { username, mark: "share", shareWith: me.username };
    if (sale.ppvSender === username) return { username, mark: "mine", shareWith: null };
    return { username, mark: "not_mine", shareWith: null };
  });
}

/** Marks and confirmations: today's shift has a couple, yesterday's half, the one before all, older ones are confirmed. */
function settle(shifts: DemoShift[], me: DemoUser, now: number): void {
  let ended = 0;
  let disputeLeft = 1;
  let ownAmountLeft = 1;
  for (const shift of shifts) {
    const random = rng(`marks:${me.id}:${shift.start}`);
    const stage = shift.ongoing ? "ongoing" : ended === 0 ? "draft" : ended === 1 ? "ready" : "confirmed";
    if (!shift.ongoing) ended += 1;
    shift.sales.forEach((sale, index) => {
      const marked = stage === "ongoing" ? index < 2
        : stage === "draft" ? index < Math.ceil(shift.sales.length * 0.55)
          : !(stage === "confirmed" && ended === 3 && index === shift.sales.length - 1 && shift.sales.length > 1);
      if (!marked) {
        sale.otherMarks = otherMarksOf(sale, me, null, false);
        return;
      }
      const mark = markOf(random, sale, me);
      let dispute = false;
      if (mark.mark === "mine" && disputeLeft > 0 && stage === "ready" && sale.writers.length > 1) {
        dispute = true;
        disputeLeft -= 1;
      }
      if (mark.mark === "mine" && ownAmountLeft > 0 && stage === "confirmed" && sale.kind === "tip" && sale.netMills >= 16_000) {
        mark.amountMills = Math.round(sale.netMills / 2_000) * 1_000;
        mark.note = "часть — оплата кастома прошлой недели";
        ownAmountLeft -= 1;
      }
      sale.myMark = mark;
      sale.otherMarks = otherMarksOf(sale, me, mark, dispute);
      sale.confirmed = stage === "confirmed";
    });
    if (stage === "confirmed") {
      shift.confirmedAt = Math.min(now - HOUR_MS, shift.end + intBetween(random, 40, 14 * 60) * MINUTE_MS);
      shift.pending = shift.sales.filter((sale) => !sale.confirmed).length;
    }
  }
}

/** What the marks claim for the caller: «моё» whole (or their own amount), «делим» half. */
export function creditedMills(sales: readonly DemoSale[]): number {
  return sales.reduce((sum, sale) => {
    const mark = sale.myMark;
    if (mark === null) return sum;
    if (mark.mark === "mine") return sum + (mark.amountMills ?? sale.netMills);
    if (mark.mark === "share") return sum + Math.floor(sale.netMills / 2);
    return sum;
  }, 0);
}

/** The same sales seen from a colleague's shift: shared with the caller, waiting for their answer. */
function sharedWithMeOf(me: DemoUser, anchor: number): DemoSale[] {
  const label = me.pages.find((item) => colleaguesOn(item, me).length > 0);
  const colleague = label ? colleaguesOn(label, me)[0] : undefined;
  if (!label || !colleague) return [];
  const random = rng(`shared:${me.id}`);
  return [1, 3].map((daysBack, index) => {
    const at = anchor - daysBack * DAY_MS - intBetween(random, 7 * 60, 10 * 60) * MINUTE_MS;
    const page = demoPage(label)!;
    const fan = pickFan(random, label);
    const gross = index === 0 ? 29.99 : 50;
    const kind: ChatterSaleKind = index === 0 ? "ppv" : "tip";
    return {
      ref: numericRef(`shared:${me.id}:${index}`),
      at,
      pageLabel: label,
      platform: page.platform,
      kind,
      reportKind: REPORT_KIND[kind],
      netMills: mills(gross * NET_SHARE),
      fan,
      fanName: fan.displayName,
      overlap: false,
      priceBucket: kind === "ppv" ? priceBucket(gross) : null,
      ppvSender: kind === "ppv" ? colleague.username : null,
      ppvWithoutAuthor: false,
      writers: [
        { username: colleague.username, messages: intBetween(random, 14, 30) },
        { username: me.username, messages: intBetween(random, 4, 11) },
      ],
      withoutAuthor: 0,
      myMark: null,
      otherMarks: [{ username: colleague.username, mark: "share", shareWith: me.username }],
      confirmed: false,
    };
  });
}

/** The person's working life up to `now`. Deterministic within five minutes. */
export function chatterWorld(user: DemoUser, nowDate: Date): DemoChatterWorld {
  const now = nowDate.getTime();
  const today = mskDay(now);
  const teammates = DEMO_USERS.filter((other) => other.active && other.id !== user.id
    && (other.role === "chatter" ? other.pages.some((label) => user.pages.includes(label)) : other.role === "team_lead" && other.pages.length > 3));
  if (user.role !== "chatter") {
    return { user, now, today, activitySince: null, shifts: [], sharedWithMe: [], teammates };
  }
  // Today's shift began a little over three hours ago; every other day's at about the same hour.
  const anchor = Math.floor((now - 192 * MINUTE_MS) / (5 * MINUTE_MS)) * 5 * MINUTE_MS;
  const activitySince = anchor - ACTIVITY_SINCE_DAYS * DAY_MS + 35 * MINUTE_MS;
  const shifts: DemoShift[] = [];
  for (let back = 0; back <= HISTORY_DAYS; back += 1) {
    const day = mskDay(anchor - back * DAY_MS);
    const random = rng(`shift:${user.id}:${day}`);
    const off = random() < 0.2;
    const start = back === 0 ? anchor : anchor - back * DAY_MS + intBetween(random, -100, 50) * MINUTE_MS;
    if (start < activitySince) break;
    if (back === 0 || !off) {
      const end = back === 0 ? now : start + intBetween(random, 330, 500) * MINUTE_MS;
      shifts.push(buildShift(user, `shift:${user.id}:${day}`, start, end, back === 0, false));
    }
    // Now and then a short look-in hours before the shift: not a shift.
    if (back > 0 && random() < 0.12) {
      const visitStart = start - intBetween(random, 7 * 60, 11 * 60) * MINUTE_MS;
      shifts.push(buildShift(user, `visit:${user.id}:${day}`, visitStart, visitStart + intBetween(random, 18, 70) * MINUTE_MS, false, true));
    }
  }
  shifts.sort((left, right) => right.start - left.start);
  settle(shifts.filter((shift) => !shift.visit), user, now);
  // A visit's sales: confirmed with the shifts around it when older than two days.
  for (const visit of shifts.filter((shift) => shift.visit && shift.sales.length > 0)) {
    const old = now - visit.end > 2 * DAY_MS;
    for (const sale of visit.sales) {
      if (old) sale.myMark = { mark: "mine", shareWith: null, amountMills: null, note: null };
      sale.confirmed = old;
    }
    if (old) visit.confirmedAt = visit.end + 3 * HOUR_MS;
  }
  return { user, now, today, activitySince, shifts, sharedWithMe: sharedWithMeOf(user, anchor), teammates };
}
