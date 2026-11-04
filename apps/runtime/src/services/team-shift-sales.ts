import type { TeamShiftSalesQuery, TeamShiftSalesResponse } from "@agency_hub_core/contracts";
import { listFirstChatterActivities, listSaleLastWriters, listShiftSales, type ShiftSale } from "@agency_hub_core/db";
import { addUtcDays, startOfBusinessDay } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireDashboardUser, type AuthPrincipal } from "./auth.ts";
import {
  SALE_LAST_WRITER_HOURS,
  dayOfWork,
  lastWriterQuery,
  middleOfWork,
  moscowDayOf,
  readPeopleWork,
  teamReadPages,
  teamShiftOf,
  workHoldsSale,
  type ComputedWork,
} from "./chatter-shifts.ts";
import { perHour, settleSale } from "./chatter-stats.ts";

/**
 * «Команда → Смены» (`teamShiftSales`): every chatter's shifts of the window
 * with their money, in one read for the whole team, and the window of the same
 * length before it. Contract: packages/contracts chatter-stats.ts.
 *
 * The shifts and whose a sale is are the chatter statistics' (chatter-stats.ts),
 * for everyone at once, so a chatter's row here is the money of their own
 * screen: a sale two chatters' shifts hold is the one's who last wrote to its
 * fan; neither wrote — it counts for both (`overlapNetMills`). The team's own
 * totals count every sale once. Database only and read-only; a guide, not a
 * basis for pay.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

type Totals = Omit<TeamShiftSalesResponse["team"], "daily">;

export interface HeldShift {
  userId: number;
  username: string;
  work: ComputedWork;
  /** The sales the shift holds (`workHoldsSale`), oldest first. */
  held: readonly ShiftSale[];
}

/** The index of the first sale at `at` or later, in sales sorted by time. Pure. */
function firstAtOrAfter(sales: readonly ShiftSale[], at: number): number {
  let low = 0;
  let high = sales.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sales[middle]!.occurredAt.getTime() < at) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The sales a piece of work holds, from all the sales sorted by time. Pure. */
export function salesOfWork(work: ComputedWork, sales: readonly ShiftSale[]): ShiftSale[] {
  if (work.salesSince.size === 0) return [];
  const held: ShiftSale[] = [];
  for (let at = firstAtOrAfter(sales, Math.min(...work.salesSince.values())); at < sales.length; at += 1) {
    const sale = sales[at]!;
    if (sale.occurredAt.getTime() >= work.endedAt) break;
    if (workHoldsSale(work, { pageLabel: sale.pageLabel, at: sale.occurredAt.getTime() })) held.push(sale);
  }
  return held;
}

/** Who holds each sale: the people whose shifts do. Pure. */
function holdersOf(shifts: readonly HeldShift[]): Map<number, Set<number>> {
  const holders = new Map<number, Set<number>>();
  for (const shift of shifts) {
    for (const sale of shift.held) {
      const known = holders.get(sale.transactionId) ?? new Set<number>();
      known.add(shift.userId);
      holders.set(sale.transactionId, known);
    }
  }
  return holders;
}

/** The sales two people's shifts hold: whose they are needs who last wrote to the fan. Pure. */
export function contestedSales(shifts: readonly HeldShift[]): ShiftSale[] {
  const holders = holdersOf(shifts);
  const seen = new Set<number>();
  const out: ShiftSale[] = [];
  for (const shift of shifts) {
    for (const sale of shift.held) {
      if ((holders.get(sale.transactionId)?.size ?? 0) < 2 || seen.has(sale.transactionId)) continue;
      seen.add(sale.transactionId);
      out.push(sale);
    }
  }
  return out;
}

const netOf = (sales: readonly ShiftSale[]) => sales.reduce((sum, sale) => sum + sale.netMills, 0);

/**
 * The window of `days` Moscow days ending on `until` (default today; at most the
 * days that keep today inside it), cut at `now`, and the one before it: the same
 * days earlier, cut at the same point — this week so far against last week up to
 * the same hour, never against all of it. Pure.
 */
export function shiftSalesWindow(input: { days: number; now: Date; until?: string | undefined }) {
  const { days, now } = input;
  const today = moscowDayOf(now.getTime());
  const latest = moscowDayOf(addUtcDays(startOfBusinessDay(now), days - 1).getTime());
  const asked = input.until ?? today;
  const lastDay = asked > latest ? latest : asked;
  const from = addUtcDays(new Date(Date.parse(`${lastDay}T00:00:00+03:00`)), -(days - 1)).getTime();
  const to = Math.min(now.getTime(), from + days * DAY_MS);
  return {
    from,
    to,
    previousFrom: from - days * DAY_MS,
    previousTo: to - days * DAY_MS,
    dates: Array.from({ length: days }, (_, offset) => moscowDayOf(from + offset * DAY_MS)),
  };
}

/**
 * The team's money from its shifts in the window (`shiftSalesWindow`) and the one
 * before. `shifts` — everyone's shifts read since a day before the window before,
 * any order; `lastWriters` — who last wrote to the fan of each contested sale;
 * `firstActivity` — everyone's first minute Hub has. Pure.
 */
export function teamShiftMoney(input: {
  days: number;
  now: Date;
  until?: string | undefined;
  shifts: readonly HeldShift[];
  lastWriters: ReadonlyMap<number, number>;
  firstActivity: ReadonlyMap<number, Date>;
}): Omit<TeamShiftSalesResponse, "serverNow"> {
  const window = shiftSalesWindow(input);
  const { previousFrom, previousTo, dates } = window;
  const holders = holdersOf(input.shifts);
  const settled = (userId: number, sale: ShiftSale) => settleSale(
    userId,
    [...(holders.get(sale.transactionId) ?? [])].filter((other) => other !== userId),
    input.lastWriters.get(sale.transactionId) ?? null,
  );
  // As the chatter's own screen: their first shift began before Hub heard of them, so its start dates it.
  const dayOf = (userId: number, work: ComputedWork) => {
    const first = input.firstActivity.get(userId);
    return first !== undefined && work.startedAt - first.getTime() < HOUR_MS ? moscowDayOf(work.startedAt) : dayOfWork(work);
  };

  const inWindow = (work: ComputedWork) => middleOfWork(work) >= window.from && middleOfWork(work) < window.to;
  const inPrevious = (work: ComputedWork) => middleOfWork(work) >= previousFrom && middleOfWork(work) < previousTo;
  const money = input.shifts
    .filter((shift) => inWindow(shift.work) || inPrevious(shift.work))
    .sort((a, b) => a.work.startedAt - b.work.startedAt || a.userId - b.userId)
    .map((shift) => {
      const own = shift.held.filter((sale) => settled(shift.userId, sale) !== "theirs");
      return {
        ...shift,
        current: inWindow(shift.work),
        date: dayOf(shift.userId, shift.work),
        own,
        salesNetMills: netOf(own),
        overlapNetMills: netOf(own.filter((sale) => settled(shift.userId, sale) === "both")),
      };
    });
  type Money = (typeof money)[number];
  const current = money.filter((one) => one.current);
  const before = money.filter((one) => !one.current);

  const totalsOf = (list: readonly Money[]): Totals => {
    const workedMinutes = list.reduce((sum, one) => sum + one.work.workedMinutes, 0);
    const salesNetMills = list.reduce((sum, one) => sum + one.salesNetMills, 0);
    return { shifts: list.length, workedMinutes, salesNetMills, sales: list.reduce((sum, one) => sum + one.own.length, 0), perHourMills: perHour(salesNetMills, workedMinutes) };
  };
  // The team counts a sale once, on the earliest shift that holds it.
  const teamOf = (list: readonly Money[]) => {
    const seen = new Set<number>();
    const byDay = new Map<string, number>();
    let salesNetMills = 0;
    for (const one of list) {
      for (const sale of one.own) {
        if (seen.has(sale.transactionId)) continue;
        seen.add(sale.transactionId);
        salesNetMills += sale.netMills;
        byDay.set(one.date, (byDay.get(one.date) ?? 0) + sale.netMills);
      }
    }
    const workedMinutes = list.reduce((sum, one) => sum + one.work.workedMinutes, 0);
    return { totals: { shifts: list.length, workedMinutes, salesNetMills, sales: seen.size, perHourMills: perHour(salesNetMills, workedMinutes) }, byDay };
  };
  const dailyOf = (list: readonly Money[], salesOfDay: (date: string, ofDay: readonly Money[]) => number) => dates.map((date) => {
    const ofDay = list.filter((one) => one.date === date);
    return { date, salesNetMills: salesOfDay(date, ofDay), shifts: ofDay.length, workedMinutes: ofDay.reduce((sum, one) => sum + one.work.workedMinutes, 0) };
  });

  const firsts = [...input.firstActivity.values()].map((at) => at.getTime());
  const knownSince = firsts.length === 0 ? null : Math.min(...firsts);
  const covered = (first: number | null | undefined) => first !== null && first !== undefined && first <= previousFrom;
  const team = teamOf(current);

  const people = new Map<number, string>();
  for (const one of money) people.set(one.userId, one.username);
  const chatters = [...people].map(([userId, username]) => {
    const mine = current.filter((one) => one.userId === userId);
    return {
      userId,
      username,
      ...totalsOf(mine),
      overlapNetMills: mine.reduce((sum, one) => sum + one.overlapNetMills, 0),
      previous: covered(input.firstActivity.get(userId)?.getTime()) ? totalsOf(before.filter((one) => one.userId === userId)) : null,
      daily: dailyOf(mine, (_, ofDay) => ofDay.reduce((sum, one) => sum + one.salesNetMills, 0)),
    };
  }).sort((a, b) => b.salesNetMills - a.salesNetMills || b.workedMinutes - a.workedMinutes || a.username.localeCompare(b.username));

  return {
    from: new Date(window.from).toISOString(),
    to: new Date(window.to).toISOString(),
    knownSince: knownSince === null ? null : new Date(knownSince).toISOString(),
    team: { ...team.totals, daily: dailyOf(current, (date) => team.byDay.get(date) ?? 0) },
    previous: covered(knownSince) ? teamOf(before).totals : null,
    chatters,
    shifts: [...current].reverse().map((one) => ({
      ...teamShiftOf(one.userId, one.username, one.work),
      date: one.date,
      salesNetMills: one.salesNetMills,
      overlapNetMills: one.overlapNetMills,
      sales: one.own.length,
    })),
  };
}

export async function readTeamShiftSales(
  app: AppContext,
  principal: AuthPrincipal,
  input: { query: TeamShiftSalesQuery; pageScope: readonly number[] | undefined },
): Promise<TeamShiftSalesResponse> {
  requireDashboardUser(principal);
  const now = new Date();
  const { days, until } = input.query;
  const pages = await teamReadPages(app, principal, { pageLabel: input.query.pageLabel, pageScope: input.pageScope });
  const window = shiftSalesWindow({ days, now, until });
  // A day on each side, so a shift the window's edge cuts is whole.
  const readFrom = new Date(window.previousFrom - DAY_MS);
  const readTo = new Date(Math.min(now.getTime(), window.to + DAY_MS));

  const [people, firstActivity] = await Promise.all([
    readPeopleWork(app.db, { from: readFrom, to: readTo, now, pages }),
    listFirstChatterActivities(app.db),
  ]);
  const shifts = [...people].flatMap(([userId, person]) => person.work
    .filter((work) => work.kind === "shift")
    .map((work) => ({ userId, username: person.username, work })));
  const pageIds = pages === "all" ? [...new Set([...people.values()].flatMap((person) => [...person.pageIds.values()]))] : pages;
  const sales = shifts.length === 0 ? [] : await listShiftSales(app.db, { pageIds, from: readFrom, to: readTo });
  const held = shifts.map((shift) => ({ ...shift, held: salesOfWork(shift.work, sales) }));
  const lastWriters = await listSaleLastWriters(app.db, { hours: SALE_LAST_WRITER_HOURS, sales: lastWriterQuery(contestedSales(held)) });
  return { ...teamShiftMoney({ days, now, until, shifts: held, lastWriters, firstActivity }), serverNow: now.toISOString() };
}
