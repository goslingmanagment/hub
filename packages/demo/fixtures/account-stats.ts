/**
 * The cabinet's «Статистика» (`accountChatterStats`) from the chatter's
 * working life in account-model.ts.
 */
import type { ChatterSaleKind, ChatterStats } from "@agency_hub_core/contracts";

import { between, intBetween, iso, rng } from "../core.ts";
import { addDays, creditedMills, dayRange, DAY_MS, mskMidnight, type DemoChatterWorld, type DemoSale, type DemoShift } from "./account-model.ts";

type ByKind = Record<ChatterSaleKind, number>;

const PRICE_BUCKETS = ["upTo10", "10to25", "25to50", "50to100", "over100"] as const;
/** How often a PPV of the bucket is bought: cheap ones sell, dear ones seldom. */
const PRICE_RATE: Record<string, number> = { upTo10: 0.36, "10to25": 0.27, "25to50": 0.17, "50to100": 0.12, over100: 0.09 };
const DELAY_BUCKETS = [
  { bucket: "under5m", share: 0.44, rate: 0.15, team: 0.12 },
  { bucket: "5to15m", share: 0.25, rate: 0.12, team: 0.1 },
  { bucket: "15to60m", share: 0.16, rate: 0.085, team: 0.075 },
  { bucket: "1to6h", share: 0.11, rate: 0.055, team: 0.05 },
  { bucket: "over6h", share: 0.04, rate: 0.03, team: 0.028 },
] as const;

function emptyByKind(): ByKind {
  return { ppv: 0, tip: 0, subscription: 0, post: 0 };
}

function byKindOf(sales: readonly DemoSale[]): ByKind {
  const result = emptyByKind();
  for (const sale of sales) result[sale.kind] += sale.netMills;
  return result;
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function totalsOf(shifts: readonly DemoShift[]) {
  const salesNetMills = sum(shifts, (shift) => sum(shift.sales, (sale) => sale.netMills));
  const workedMinutes = sum(shifts, (shift) => shift.workedMinutes);
  return {
    shifts: shifts.length,
    workedMinutes,
    salesNetMills,
    sales: sum(shifts, (shift) => shift.sales.length),
    perHourMills: workedMinutes > 0 ? Math.round(salesNetMills / (workedMinutes / 60)) : null,
  };
}

/** Moscow days in a row with a shift, up to `last` (or the day before when `last` has none). */
function streakUpTo(days: ReadonlySet<string>, last: string): number {
  let day = days.has(last) ? last : addDays(last, -1);
  let streak = 0;
  while (days.has(day)) {
    streak += 1;
    day = addDays(day, -1);
  }
  return streak;
}

function longestRun(days: readonly string[], worked: ReadonlySet<string>): number {
  let best = 0;
  let run = 0;
  for (const day of days) {
    run = worked.has(day) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

function statsSale(sale: DemoSale) {
  return {
    at: iso(new Date(sale.at)),
    netMills: sale.netMills,
    kind: sale.kind,
    pageLabel: sale.pageLabel,
    fanName: sale.fanName,
    overlap: sale.overlap,
  };
}

export function chatterStats(world: DemoChatterWorld, days: number): ChatterStats {
  const { user, now, today } = world;
  const firstDay = addDays(today, -(days - 1));
  const windowDays = dayRange(firstDay, today);
  const inWindow = (shift: DemoShift) => shift.date >= firstDay && shift.date <= today;
  const shifts = world.shifts.filter((shift) => !shift.visit && inWindow(shift));
  const visits = world.shifts.filter((shift) => shift.visit && inWindow(shift));
  const sales = shifts.flatMap((shift) => shift.sales);
  const random = rng(`stats:${user.id}:${today}:${days}`);

  const previousFirst = addDays(firstDay, -days);
  const previousKnown = world.activitySince !== null && world.activitySince <= mskMidnight(previousFirst);
  const previousShifts = world.shifts.filter((shift) => !shift.visit && shift.date >= previousFirst && shift.date < firstDay);

  const confirmed = shifts.filter((shift) => shift.confirmedAt !== null);
  const confirmedOf = (shift: DemoShift) => creditedMills(shift.sales.filter((sale) => sale.confirmed));

  // PPVs by price: what sold, and what was sent beside it.
  const ppvSales = sales.filter((sale) => sale.kind === "ppv");
  const byPrice = PRICE_BUCKETS.map((bucket) => {
    const sold = ppvSales.filter((sale) => sale.priceBucket === bucket);
    const rate = PRICE_RATE[bucket] ?? 0.1;
    const sent = shifts.length === 0 ? 0
      : sold.length === 0 ? (bucket === "over100" ? 0 : intBetween(random, 0, 3))
        : Math.round(sold.length / (rate * between(random, 0.85, 1.15)));
    const teamSent = shifts.length === 0 ? 0 : Math.round(sent * between(random, 1.8, 2.6)) + intBetween(random, 0, 4);
    return {
      bucket,
      sent: Math.max(sent, sold.length),
      bought: sold.length,
      netMills: sum(sold, (sale) => sale.netMills),
      teamSent,
      teamBought: Math.round(teamSent * rate * between(random, 0.78, 0.98)),
    };
  });

  // Replies to a waiting fan, up to a day ago.
  const repliesTo = now - DAY_MS;
  const replyBase = Math.round(sum(shifts.filter((shift) => shift.end <= repliesTo), (shift) => shift.messages) * 0.31);
  const byDelay = DELAY_BUCKETS.map((cell) => {
    const replies = Math.round(replyBase * cell.share * between(random, 0.9, 1.1));
    const teamReplies = Math.round(replies * between(random, 2, 2.6));
    return {
      bucket: cell.bucket,
      replies,
      bought: Math.round(replies * cell.rate * between(random, 0.85, 1.15)),
      teamReplies,
      teamBought: Math.round(teamReplies * cell.team),
    };
  });

  const messages = sum(shifts, (shift) => shift.messages);
  const composed = {
    reply: Math.round(messages * 0.31),
    fix: Math.round(messages * 0.09),
    greet: Math.round(messages * 0.065),
    other: Math.round(messages * 0.025),
    hand: 0,
  };
  composed.hand = messages - composed.reply - composed.fix - composed.greet - composed.other;

  const fans = new Map<string, { fanName: string | null; pageLabel: string; netMills: number; sales: number }>();
  for (const sale of sales) {
    const key = `${sale.pageLabel}:${sale.fan.platformUserId}`;
    const entry = fans.get(key) ?? { fanName: sale.fanName ?? sale.fan.displayName, pageLabel: sale.pageLabel, netMills: 0, sales: 0 };
    entry.netMills += sale.netMills;
    entry.sales += 1;
    fans.set(key, entry);
  }

  const pages = new Map<string, { pageLabel: string; platform: string; salesNetMills: number; sales: number; activeMinutes: number }>();
  for (const shift of shifts) {
    for (const label of shift.pages) {
      const entry = pages.get(label) ?? { pageLabel: label, platform: shift.sales.find((sale) => sale.pageLabel === label)?.platform ?? "fansly", salesNetMills: 0, sales: 0, activeMinutes: 0 };
      const own = shift.sales.filter((sale) => sale.pageLabel === label);
      entry.salesNetMills += sum(own, (sale) => sale.netMills);
      entry.sales += own.length;
      entry.activeMinutes += shift.pageMinutes[label] ?? 0;
      pages.set(label, entry);
    }
  }

  const daily = windowDays.map((date) => {
    const ofDay = shifts.filter((shift) => shift.date === date);
    const daySales = ofDay.flatMap((shift) => shift.sales);
    return {
      date,
      salesNetMills: sum(daySales, (sale) => sale.netMills),
      byKind: byKindOf(daySales),
      shifts: ofDay.length,
      workedMinutes: sum(ofDay, (shift) => shift.workedMinutes),
    };
  });

  const bestShift = [...shifts].sort((left, right) => sum(right.sales, (sale) => sale.netMills) - sum(left.sales, (sale) => sale.netMills))[0];
  const bestDay = [...daily].filter((day) => day.salesNetMills > 0).sort((left, right) => right.salesNetMills - left.salesNetMills)[0];
  const biggest = [...sales].sort((left, right) => right.netMills - left.netMills)[0];
  const workedDays = new Set(world.shifts.filter((shift) => !shift.visit).map((shift) => shift.date));
  const streakDays = streakUpTo(workedDays, today);

  return {
    user: { userId: user.id, username: user.username },
    days,
    from: iso(new Date(mskMidnight(firstDay))),
    to: iso(new Date(now)),
    activitySince: world.activitySince === null ? null : iso(new Date(world.activitySince)),
    totals: {
      ...totalsOf(shifts),
      overlapNetMills: sum(sales.filter((sale) => sale.overlap), (sale) => sale.netMills),
      byKind: byKindOf(sales),
      confirmedNetMills: sum(confirmed, confirmedOf),
      unconfirmedShifts: shifts.filter((shift) => !shift.ongoing && shift.confirmedAt === null).length,
      messages,
      fansWritten: sum(shifts, (shift) => shift.fansWritten),
      fansPaid: sum(shifts, (shift) => shift.fansPaid),
    },
    previous: previousKnown ? totalsOf(previousShifts) : null,
    daily,
    shifts: shifts.map((shift) => ({
      date: shift.date,
      startedAt: iso(new Date(shift.start)),
      endedAt: iso(new Date(shift.end)),
      ongoing: shift.ongoing,
      workedMinutes: shift.workedMinutes,
      pauses: shift.pauses.map((pause) => ({ from: iso(new Date(pause.from)), to: iso(new Date(pause.to)) })),
      pages: shift.pages,
      salesNetMills: sum(shift.sales, (sale) => sale.netMills),
      overlapNetMills: sum(shift.sales.filter((sale) => sale.overlap), (sale) => sale.netMills),
      together: shift.together,
      messages: shift.messages,
      ppvSent: shift.ppvSent,
      fansWritten: shift.fansWritten,
      fansPaid: shift.fansPaid,
      confirmedNetMills: shift.confirmedAt === null ? null : confirmedOf(shift),
      sales: shift.sales.map(statsSale),
    })),
    visits: visits.map((visit) => ({
      date: visit.date,
      startedAt: iso(new Date(visit.start)),
      endedAt: iso(new Date(visit.end)),
      workedMinutes: visit.workedMinutes,
      messages: visit.messages,
      salesNetMills: sum(visit.sales, (sale) => sale.netMills),
      sales: visit.sales.length,
    })),
    pages: [...pages.values()].sort((left, right) => right.salesNetMills - left.salesNetMills),
    ppv: {
      sent: sum(byPrice, (cell) => cell.sent),
      bought: sum(byPrice, (cell) => cell.bought),
      netMills: sum(byPrice, (cell) => cell.netMills),
      byPrice,
    },
    replies: {
      to: iso(new Date(repliesTo)),
      replies: sum(byDelay, (cell) => cell.replies),
      bought: sum(byDelay, (cell) => cell.bought),
      byDelay,
    },
    composed,
    topFans: [...fans.values()].sort((left, right) => right.netMills - left.netMills).slice(0, 5),
    records: {
      bestShift: bestShift ? { startedAt: iso(new Date(bestShift.start)), salesNetMills: sum(bestShift.sales, (sale) => sale.netMills) } : null,
      bestDay: bestDay ? { date: bestDay.date, salesNetMills: bestDay.salesNetMills } : null,
      biggestSale: biggest ? { at: iso(new Date(biggest.at)), netMills: biggest.netMills, kind: biggest.kind, pageLabel: biggest.pageLabel, fanName: biggest.fanName } : null,
      streakDays,
      longestStreakDays: Math.max(streakDays, longestRun(dayRange(previousFirst, today), workedDays)),
    },
    serverNow: iso(new Date(now)),
  };
}

