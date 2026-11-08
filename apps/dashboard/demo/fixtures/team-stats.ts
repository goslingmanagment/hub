/**
 * A chatter's «Статистика» for the owner and team leads (`teamChatterStats`),
 * built from the same simulated shifts as every other «Команда» screen.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { type DemoRequest } from "../core.ts";
import { DEMO_CHATTERS, demoPage, type DemoUser } from "../world.ts";
import {
  DAY,
  addDays,
  creditedOf,
  isoAt,
  mskDay,
  pageBuyFactor,
  ppvCells,
  replyCells,
  teamWorld,
  windowDays,
  windowStart,
  workedPages,
  type DemoSale,
  type DemoShift,
} from "./team-world.ts";

type Response = KernelOperationResponse<"teamChatterStats">;
type Stats = NonNullable<Response["stats"]>;

/** The Moscow day holding most of the shift. */
function dateOf(shift: Pick<DemoShift, "startedAt" | "endedAt">): string {
  return mskDay(shift.startedAt + (shift.endedAt - shift.startedAt) / 2);
}

function salesIn(shift: DemoShift, scope: readonly string[]): DemoSale[] {
  const pages = workedPages(shift);
  return shift.sales.filter((sale) => pages.includes(sale.pageLabel) && scope.includes(sale.pageLabel));
}

function byKind(sales: readonly DemoSale[]) {
  const result = { ppv: 0, tip: 0, subscription: 0, post: 0 };
  for (const sale of sales) result[sale.kind] += sale.netMills;
  return result;
}

function net(sales: readonly DemoSale[]): number {
  return sales.reduce((sum, sale) => sum + sale.netMills, 0);
}

function periodTotals(shifts: readonly DemoShift[], scope: readonly string[]) {
  const sales = shifts.flatMap((shift) => salesIn(shift, scope));
  const workedMinutes = shifts.reduce((sum, shift) => sum + shift.workedMinutes, 0);
  const salesNetMills = net(sales);
  return {
    shifts: shifts.length,
    workedMinutes,
    salesNetMills,
    sales: sales.length,
    perHourMills: workedMinutes === 0 ? null : Math.round(salesNetMills / (workedMinutes / 60)),
  };
}

function sumReplies(tables: ReadonlyArray<ReturnType<typeof replyCells>>) {
  const template = tables[0] ?? replyCells(0, 300, 1, "empty");
  return template.map((cell, index) => ({
    bucket: cell.bucket,
    replies: tables.reduce((sum, table) => sum + (table[index]?.replies ?? 0), 0),
    bought: tables.reduce((sum, table) => sum + (table[index]?.bought ?? 0), 0),
  }));
}

function replyTables(shifts: readonly DemoShift[], pages: readonly string[]) {
  return shifts.flatMap((shift) => shift.pages
    .filter((page) => page.messages > 0 && pages.includes(page.pageLabel))
    .map((page) => replyCells(Math.round((shift.replies * page.messages) / shift.messages), shift.speed, pageBuyFactor(page.pageLabel), `${shift.user.username}:${shift.startedAt}:${page.pageLabel}`)));
}

/** Moscow days in a row with a shift, ending today (or yesterday while today has none yet). */
function streakOf(days: ReadonlySet<string>, today: string): number {
  let day = days.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (days.has(day)) {
    streak += 1;
    day = addDays(day, -1);
  }
  return streak;
}

function longestStreak(days: ReadonlySet<string>, from: string, to: string): number {
  let longest = 0;
  let run = 0;
  for (let day = from; day <= to; day = addDays(day, 1)) {
    run = days.has(day) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

function statsOf(request: DemoRequest, scope: readonly string[], days: number, user: DemoUser): Stats {
  const now = request.now;
  const world = teamWorld(now);
  const from = windowStart(now, days);
  const dayList = windowDays(now, days);
  const firstDay = dayList[0]!;
  const prevFirstDay = addDays(firstDay, -days);
  const touches = (shift: DemoShift) => shift.pages.some((page) => page.messages > 0 && scope.includes(page.pageLabel));
  const mine = world.shifts.filter((shift) => shift.user.id === user.id && touches(shift));
  const inWindow = mine.filter((shift) => dateOf(shift) >= firstDay);
  const inPrevious = mine.filter((shift) => dateOf(shift) >= prevFirstDay && dateOf(shift) < firstDay);
  const since = world.activitySince.get(user.id);
  const activitySince = since !== undefined && Number.isFinite(since) ? since : null;

  const windowSales = inWindow.flatMap((shift) => salesIn(shift, scope));
  const base = periodTotals(inWindow, scope);
  const confirmedNetMills = inWindow
    .filter((shift) => shift.confirmedAt !== null)
    .reduce((sum, shift) => sum + salesIn(shift, scope).reduce((inner, sale) => inner + creditedOf(sale), 0), 0);

  const shifts: Stats["shifts"] = inWindow.map((shift) => {
    const sales = salesIn(shift, scope);
    return {
      date: dateOf(shift),
      startedAt: isoAt(shift.startedAt),
      endedAt: isoAt(shift.endedAt),
      ongoing: shift.ongoing,
      workedMinutes: shift.workedMinutes,
      pauses: shift.pauses.map((pause) => ({ from: isoAt(pause.from), to: isoAt(pause.to) })),
      pages: workedPages(shift).filter((label) => scope.includes(label)),
      salesNetMills: net(sales),
      overlapNetMills: net(sales.filter((sale) => sale.overlap)),
      together: shift.together,
      messages: shift.messages,
      ppvSent: shift.ppvSent,
      fansWritten: shift.fansWritten,
      fansPaid: Math.min(shift.fansWritten, new Set(sales.map((sale) => sale.fan.platformUserId)).size),
      confirmedNetMills: shift.confirmedAt === null ? null : sales.reduce((sum, sale) => sum + creditedOf(sale), 0),
      sales: sales.map((sale) => ({
        at: isoAt(sale.at),
        netMills: sale.netMills,
        kind: sale.kind,
        pageLabel: sale.pageLabel,
        fanName: sale.fan.displayName,
        overlap: sale.overlap,
      })),
    };
  });

  const daily: Stats["daily"] = dayList.map((day) => {
    const ofDay = inWindow.filter((shift) => dateOf(shift) === day);
    const sales = ofDay.flatMap((shift) => salesIn(shift, scope));
    return {
      date: day,
      salesNetMills: net(sales),
      byKind: byKind(sales),
      shifts: ofDay.length,
      workedMinutes: ofDay.reduce((sum, shift) => sum + shift.workedMinutes, 0),
    };
  });

  const visits: Stats["visits"] = world.visits
    .filter((visit) => visit.user.id === user.id && scope.includes(visit.pageLabel) && visit.startedAt >= from)
    .map((visit) => ({
      date: mskDay(visit.startedAt),
      startedAt: isoAt(visit.startedAt),
      endedAt: isoAt(visit.endedAt),
      workedMinutes: visit.workedMinutes,
      messages: visit.messages,
      salesNetMills: net(visit.sales),
      sales: visit.sales.length,
    }));

  const pageMap = new Map<string, Stats["pages"][number]>();
  for (const shift of inWindow) {
    for (const page of shift.pages) {
      if (page.messages < 10 || !scope.includes(page.pageLabel)) continue;
      const entry = pageMap.get(page.pageLabel) ?? { pageLabel: page.pageLabel, platform: demoPage(page.pageLabel)?.platform ?? "fansly", salesNetMills: 0, sales: 0, activeMinutes: 0 };
      entry.activeMinutes += page.activeMinutes;
      pageMap.set(page.pageLabel, entry);
    }
  }
  for (const sale of windowSales) {
    const entry = pageMap.get(sale.pageLabel);
    if (!entry) continue;
    entry.salesNetMills += sale.netMills;
    entry.sales += 1;
  }
  const pages = [...pageMap.values()].sort((left, right) => right.salesNetMills - left.salesNetMills);
  const pageLabels = pages.map((page) => page.pageLabel);

  // The team on the same pages over the same days, the chatter included.
  const team = world.shifts.filter((shift) => dateOf(shift) >= firstDay && workedPages(shift).some((label) => pageLabels.includes(label)));
  const ppvSent = inWindow.reduce((sum, shift) => sum + shift.ppvSent, 0);
  const own = ppvCells(ppvSent, windowSales, `stats:${user.username}:${days}`);
  const teamSales = team.flatMap((shift) => salesIn(shift, pageLabels));
  const teamCells = ppvCells(team.reduce((sum, shift) => sum + shift.ppvSent, 0), teamSales, `stats-team:${user.username}:${days}`);
  const ppvByPrice = own.map((cell, index) => ({
    bucket: cell.bucket,
    sent: cell.sent,
    bought: cell.bought,
    netMills: cell.netMills,
    teamSent: Math.max(cell.sent, teamCells[index]?.sent ?? 0),
    teamBought: Math.max(cell.bought, teamCells[index]?.bought ?? 0),
  }));

  const repliesTo = now.getTime() - DAY;
  const ownReplies = sumReplies(replyTables(inWindow.filter((shift) => shift.endedAt <= repliesTo), pageLabels));
  const teamReplies = sumReplies(replyTables(team.filter((shift) => shift.endedAt <= repliesTo), pageLabels));
  const byDelay = ownReplies.map((cell, index) => ({
    bucket: cell.bucket,
    replies: cell.replies,
    bought: cell.bought,
    teamReplies: Math.max(cell.replies, teamReplies[index]?.replies ?? 0),
    teamBought: Math.max(cell.bought, teamReplies[index]?.bought ?? 0),
  }));

  const fans = new Map<string, Stats["topFans"][number]>();
  const names = new Map<string, string>();
  for (const sale of windowSales) {
    const key = `${sale.pageLabel}:${sale.fan.platformUserId}`;
    // Two fans with one display name read as one: the second goes by the handle.
    const taken = names.get(sale.fan.displayName);
    if (taken === undefined) names.set(sale.fan.displayName, key);
    const name = taken === undefined || taken === key ? sale.fan.displayName : sale.fan.username;
    const entry = fans.get(key) ?? { fanName: name, pageLabel: sale.pageLabel, netMills: 0, sales: 0 };
    entry.netMills += sale.netMills;
    entry.sales += 1;
    fans.set(key, entry);
  }

  const bestShift = shifts.reduce<Stats["shifts"][number] | null>((best, shift) => (best === null || shift.salesNetMills > best.salesNetMills ? shift : best), null);
  const bestDay = daily.reduce<Stats["daily"][number] | null>((best, day) => (day.salesNetMills > 0 && (best === null || day.salesNetMills > best.salesNetMills) ? day : best), null);
  const biggest = windowSales.reduce<DemoSale | null>((best, sale) => (best === null || sale.netMills > best.netMills ? sale : best), null);
  const shiftDays = new Set(mine.map((shift) => dateOf(shift)));
  const today = mskDay(now.getTime());

  const previous = activitySince !== null && activitySince <= windowStart(now, days * 2) ? periodTotals(inPrevious, scope) : null;

  return {
    user: { userId: user.id, username: user.username },
    days,
    from: isoAt(from),
    to: now.toISOString(),
    activitySince: activitySince === null ? null : isoAt(activitySince),
    totals: {
      ...base,
      overlapNetMills: net(windowSales.filter((sale) => sale.overlap)),
      byKind: byKind(windowSales),
      confirmedNetMills,
      unconfirmedShifts: inWindow.filter((shift) => !shift.ongoing && shift.confirmedAt === null).length,
      messages: inWindow.reduce((sum, shift) => sum + shift.messages, 0),
      fansWritten: shifts.reduce((sum, shift) => sum + shift.fansWritten, 0),
      fansPaid: shifts.reduce((sum, shift) => sum + shift.fansPaid, 0),
    },
    previous,
    daily,
    shifts,
    visits,
    pages,
    ppv: {
      sent: own.reduce((sum, cell) => sum + cell.sent, 0),
      bought: own.reduce((sum, cell) => sum + cell.bought, 0),
      netMills: own.reduce((sum, cell) => sum + cell.netMills, 0),
      byPrice: ppvByPrice,
    },
    replies: {
      to: isoAt(repliesTo),
      replies: ownReplies.reduce((sum, cell) => sum + cell.replies, 0),
      bought: ownReplies.reduce((sum, cell) => sum + cell.bought, 0),
      byDelay,
    },
    composed: inWindow.reduce((sum, shift) => ({
      hand: sum.hand + shift.composed.hand,
      reply: sum.reply + shift.composed.reply,
      fix: sum.fix + shift.composed.fix,
      greet: sum.greet + shift.composed.greet,
      other: sum.other + shift.composed.other,
    }), { hand: 0, reply: 0, fix: 0, greet: 0, other: 0 }),
    topFans: [...fans.values()].sort((left, right) => right.netMills - left.netMills).slice(0, 5),
    records: {
      bestShift: bestShift === null || bestShift.salesNetMills === 0 ? null : { startedAt: bestShift.startedAt, salesNetMills: bestShift.salesNetMills },
      bestDay: bestDay === null ? null : { date: bestDay.date, salesNetMills: bestDay.salesNetMills },
      biggestSale: biggest === null ? null : { at: isoAt(biggest.at), netMills: biggest.netMills, kind: biggest.kind, pageLabel: biggest.pageLabel, fanName: biggest.fan.displayName },
      streakDays: streakOf(shiftDays, today),
      longestStreakDays: Math.max(streakOf(shiftDays, today), longestStreak(shiftDays, prevFirstDay, today)),
    },
    serverNow: now.toISOString(),
  };
}

export function teamChatterStats(request: DemoRequest, scope: readonly string[], days: number, userId: number | undefined): Response {
  const world = teamWorld(request.now);
  const monthStart = windowStart(request.now, 31);
  const people = DEMO_CHATTERS
    .map((user) => {
      const shifts = world.shifts.filter((shift) => shift.user.id === user.id && shift.startedAt >= monthStart
        && shift.pages.some((page) => page.messages > 0 && scope.includes(page.pageLabel)));
      return { user, shifts: shifts.length, net: shifts.reduce((sum, shift) => sum + net(salesIn(shift, scope)), 0) };
    })
    .filter((entry) => entry.shifts > 0)
    .sort((left, right) => right.net - left.net);
  const chosen = people.find((entry) => entry.user.id === userId) ?? people[0];
  return {
    people: people.map((entry) => ({ userId: entry.user.id, username: entry.user.username })),
    stats: chosen ? statsOf(request, scope, days, chosen.user) : null,
    serverNow: request.now.toISOString(),
  };
}

type ShiftSalesResponse = KernelOperationResponse<"teamShiftSales">;
type ShiftMoneyTotals = NonNullable<ShiftSalesResponse["previous"]>;

/** «Команда → Смены»: everyone's shifts of the window with their money, and the window before (`teamShiftSales`). */
export function teamShiftSales(request: DemoRequest, scope: readonly string[], days: number, until: string | undefined): ShiftSalesResponse {
  const now = request.now;
  const world = teamWorld(now);
  // As the server: the window ends on `until` (today by default, never leaving today out), the one before is cut at the same point.
  const today = mskDay(now.getTime());
  const latest = addDays(today, days - 1);
  const asked = until ?? today;
  const lastDay = asked > latest ? latest : asked;
  const dayList = Array.from({ length: days }, (_, index) => addDays(lastDay, index - (days - 1)));
  const firstDay = dayList[0]!;
  const prevFirstDay = addDays(firstDay, -days);
  const previousFrom = mskMidnightOf(prevFirstDay);
  const to = Math.min(now.getTime(), mskMidnightOf(addDays(lastDay, 1)));
  const middle = (shift: DemoShift) => shift.startedAt + (shift.endedAt - shift.startedAt) / 2;
  const touches = (shift: DemoShift) => shift.pages.some((page) => page.messages > 0 && scope.includes(page.pageLabel));
  const current = world.shifts.filter((shift) => touches(shift) && dateOf(shift) >= firstDay && dateOf(shift) <= lastDay);
  const before = world.shifts.filter((shift) => touches(shift) && dateOf(shift) >= prevFirstDay && dateOf(shift) < firstDay && middle(shift) < to - days * DAY);
  const shifts = [...current, ...before];
  const totals = (list: readonly DemoShift[]): ShiftMoneyTotals => periodTotals(list, scope);
  // The team counts a sale once, though two shifts hold it.
  const teamOf = (list: readonly DemoShift[]) => {
    const seen = new Map<string, { netMills: number; date: string }>();
    for (const shift of [...list].sort((left, right) => left.startedAt - right.startedAt)) {
      for (const sale of salesIn(shift, scope)) if (!seen.has(sale.ref)) seen.set(sale.ref, { netMills: sale.netMills, date: dateOf(shift) });
    }
    const workedMinutes = list.reduce((sum, shift) => sum + shift.workedMinutes, 0);
    const salesNetMills = [...seen.values()].reduce((sum, sale) => sum + sale.netMills, 0);
    return {
      totals: { shifts: list.length, workedMinutes, salesNetMills, sales: seen.size, perHourMills: workedMinutes === 0 ? null : Math.round(salesNetMills / (workedMinutes / 60)) },
      byDay: (date: string) => [...seen.values()].filter((sale) => sale.date === date).reduce((sum, sale) => sum + sale.netMills, 0),
    };
  };
  const dailyOf = (list: readonly DemoShift[], salesOfDay: (date: string, ofDay: readonly DemoShift[]) => number) => dayList.map((date) => {
    const ofDay = list.filter((shift) => dateOf(shift) === date);
    return { date, salesNetMills: salesOfDay(date, ofDay), shifts: ofDay.length, workedMinutes: ofDay.reduce((sum, shift) => sum + shift.workedMinutes, 0) };
  });
  const firsts = [...world.activitySince.values()].filter(Number.isFinite);
  const knownSince = firsts.length === 0 ? null : Math.min(...firsts);
  const covered = (first: number | null | undefined) => first !== null && first !== undefined && Number.isFinite(first) && first <= previousFrom;
  const team = teamOf(current);

  const chatters = DEMO_CHATTERS
    .filter((user) => shifts.some((shift) => shift.user.id === user.id))
    .map((user) => {
      const mine = current.filter((shift) => shift.user.id === user.id);
      return {
        userId: user.id,
        username: user.username,
        ...totals(mine),
        overlapNetMills: mine.reduce((sum, shift) => sum + net(salesIn(shift, scope).filter((sale) => sale.overlap)), 0),
        previous: covered(world.activitySince.get(user.id)) ? totals(before.filter((shift) => shift.user.id === user.id)) : null,
        daily: dailyOf(mine, (_, ofDay) => ofDay.reduce((sum, shift) => sum + net(salesIn(shift, scope)), 0)),
      };
    })
    .sort((left, right) => right.salesNetMills - left.salesNetMills || left.username.localeCompare(right.username));

  return {
    from: isoAt(mskMidnightOf(firstDay)),
    to: isoAt(to),
    knownSince: knownSince === null ? null : isoAt(knownSince),
    team: { ...team.totals, daily: dailyOf(current, (date) => team.byDay(date)) },
    previous: covered(knownSince) ? teamOf(before).totals : null,
    chatters,
    shifts: [...current].sort((left, right) => right.startedAt - left.startedAt).map((shift) => {
      const sales = salesIn(shift, scope);
      const pages = shift.pages
        .filter((page) => scope.includes(page.pageLabel))
        .map((page) => ({ pageLabel: page.pageLabel, activeMinutes: page.activeMinutes, messages: page.messages }))
        .sort((left, right) => right.messages - left.messages);
      return {
        userId: shift.user.id,
        username: shift.user.username,
        startedAt: isoAt(shift.startedAt),
        endedAt: isoAt(shift.endedAt),
        ongoing: shift.ongoing,
        workedMinutes: shift.workedMinutes,
        pauses: shift.pauses.map((pause) => ({ from: isoAt(pause.from), to: isoAt(pause.to) })),
        lastInputAt: isoAt(shift.lastInputAt),
        lastBeatAt: isoAt(shift.lastBeatAt),
        pages,
        authoredMessages: pages.reduce((sum, page) => sum + page.messages, 0),
        date: dateOf(shift),
        salesNetMills: net(sales),
        overlapNetMills: net(sales.filter((sale) => sale.overlap)),
        sales: sales.length,
      };
    }),
    serverNow: now.toISOString(),
  };
}

function mskMidnightOf(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) - 3 * 3_600_000;
}
