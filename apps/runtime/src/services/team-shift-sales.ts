import type { OUTSIDE_SALE_HOMES, TeamShiftSalesQuery, TeamShiftSalesResponse } from "@agency_hub_core/contracts";
import { listFirstChatterActivities, type ShiftSale } from "@agency_hub_core/db";
import { addUtcDays, startOfBusinessDay } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireDashboardUser, type AuthPrincipal } from "./auth.ts";
import {
  dayOfWork,
  middleOfWork,
  moscowDayOf,
  teamReadPages,
  teamShiftOf,
  workHoldsSale,
  type ComputedWork,
} from "./chatter-shifts.ts";
import { perHour, saleKindOf } from "./chatter-stats.ts";
import { homesOfSales, moneyOfPieces, readTeamSales, type SettledHome } from "./sale-rule.ts";

/**
 * «Команда → Смены» (`teamShiftSales`): every chatter's shifts of the window
 * with their money, in one read for the whole team, and the window of the same
 * length before it. Contract: packages/contracts chatter-stats.ts.
 *
 * The shifts are the chatter statistics' (chatter-stats.ts) and whose a sale is
 * sale-rule.ts's, for everyone at once, so a chatter's row here is the money of
 * their own screen: a sale two chatters' shifts hold is the one's who last wrote
 * to its fan; neither wrote — it counts for both (`overlapNetMills`); from
 * SALE_RULE_SINCE_DAY a chatter's PPV is its sender's, in the shift it came in or
 * their next one, and a post tip or a Campaign contribution the общак. The
 * team's own totals count every sale once. Database only and read-only; a
 * guide, not a basis for pay.
 *
 * The window's sales in no shift's money are listed apart (`outside`), never in
 * the money above: a look-in's when its person last wrote to the fan, the
 * общак, a chatter's PPV waiting for their next shift, the rest nobody's.
 * Shifts and these add up to every sale of the pages.
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

type OutsideHome = (typeof OUTSIDE_SALE_HOMES)[number];

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

const netOf = (sales: readonly ShiftSale[]) => sales.reduce((sum, sale) => sum + sale.netMills, 0);

export interface OutsideSale {
  sale: ShiftSale;
  home: OutsideHome;
  /** `visit` — the look-in's person; `waiting` — the chatter whose PPV it is. */
  who: string | null;
}

/** The sales of [from, to) in no shift's money, oldest first, and where each went (sale-rule.ts). Pure. */
export function salesOutsideShifts(settled: readonly SettledHome[], window: { from: number; to: number }): OutsideSale[] {
  return settled.flatMap(({ sale, home }): OutsideSale[] => {
    const at = sale.occurredAt.getTime();
    if (at < window.from || at >= window.to) return [];
    if (home.kind === "pieces") return home.pieces[0]!.work.kind === "visit" ? [{ sale, home: "visit", who: home.pieces[0]!.username }] : [];
    if (home.kind === "common") return [{ sale, home: "common", who: null }];
    if (home.kind === "waiting") return [{ sale, home: "waiting", who: home.username }];
    return [{ sale, home: "nobody", who: null }];
  });
}

/** The window's money outside shifts, by Moscow day of the sale and by page, and each sale. Pure. */
export function outsideMoney(outside: readonly OutsideSale[], dates: readonly string[]): TeamShiftSalesResponse["outside"] {
  const of = (list: readonly OutsideSale[]) => {
    const sum = (home: OutsideHome) => netOf(list.filter((one) => one.home === home).map((one) => one.sale));
    return { visitsNetMills: sum("visit"), nobodyNetMills: sum("nobody"), commonNetMills: sum("common"), waitingNetMills: sum("waiting") };
  };
  const total = (money: ReturnType<typeof of>) => money.visitsNetMills + money.nobodyNetMills + money.commonNetMills + money.waitingNetMills;
  const labels = [...new Set(outside.map((one) => one.sale.pageLabel))];
  return {
    ...of(outside),
    daily: dates.map((date) => ({ date, ...of(outside.filter((one) => moscowDayOf(one.sale.occurredAt.getTime()) === date)) })),
    pages: labels.map((pageLabel) => ({ pageLabel, ...of(outside.filter((one) => one.sale.pageLabel === pageLabel)) }))
      .sort((a, b) => total(b) - total(a) || a.pageLabel.localeCompare(b.pageLabel)),
    sales: outside.map((one) => ({
      at: one.sale.occurredAt.toISOString(),
      pageLabel: one.sale.pageLabel,
      fanName: one.sale.fanName,
      kind: saleKindOf(one.sale.kind),
      netMills: one.sale.netMills,
      visitBy: one.home === "visit" ? one.who : null,
      home: one.home,
      waitingFor: one.home === "waiting" ? one.who : null,
    })),
  };
}

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
 * `firstActivity` — everyone's first minute Hub has; `settled` — every sale read
 * with its home (sale-rule.ts `readTeamSales`, its pieces' works those of
 * `shifts`); without it, the sales the shifts hold by the old rule. Pure.
 */
export function teamShiftMoney(input: {
  days: number;
  now: Date;
  until?: string | undefined;
  shifts: readonly HeldShift[];
  lastWriters: ReadonlyMap<number, number>;
  firstActivity: ReadonlyMap<number, Date>;
  settled?: readonly SettledHome[];
}): Omit<TeamShiftSalesResponse, "serverNow" | "outside"> {
  const window = shiftSalesWindow(input);
  const { previousFrom, previousTo, dates } = window;
  const settled = input.settled ?? homesOfSales({
    sales: [...new Map(input.shifts.flatMap((shift) => shift.held).map((sale) => [sale.transactionId, sale])).values()]
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.transactionId - b.transactionId),
    shifts: input.shifts,
    visits: [],
    lastWriters: input.lastWriters,
    facts: new Map(),
    now: input.now.getTime(),
  });
  const moneyOf = moneyOfPieces(settled);
  const overlap = new Set(settled.flatMap(({ sale, home }) => (home.kind === "pieces" && home.pieces.length > 1 ? [sale.transactionId] : [])));
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
      const own = moneyOf.get(shift.work) ?? [];
      return {
        ...shift,
        current: inWindow(shift.work),
        date: dayOf(shift.userId, shift.work),
        own,
        salesNetMills: netOf(own),
        overlapNetMills: netOf(own.filter((sale) => overlap.has(sale.transactionId))),
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

  // Everyone's work and every sale of the pages around both windows (a shift the windows' edge cuts is whole), each
  // sale settled (sale-rule.ts).
  const [team, firstActivity] = await Promise.all([
    readTeamSales(app.db, { from: new Date(window.previousFrom), to: new Date(window.to), now, pages }),
    listFirstChatterActivities(app.db),
  ]);
  const sales = team.settled.map((one) => one.sale);
  const held = team.shifts.map((shift) => ({ ...shift, held: salesOfWork(shift.work, sales) }));
  // Without anyone's work around the windows Hub knows nothing of their shifts: no sale of them is outside one.
  const seen = [...team.shifts, ...team.visits].some((one) => one.work.endedAt > window.previousFrom - DAY_MS && one.work.startedAt < window.to + DAY_MS);
  return {
    ...teamShiftMoney({ days, now, until, shifts: held, lastWriters: team.lastWriters, firstActivity, settled: team.settled }),
    outside: outsideMoney(seen ? salesOutsideShifts(team.settled, window) : [], window.dates),
    serverNow: now.toISOString(),
  };
}
