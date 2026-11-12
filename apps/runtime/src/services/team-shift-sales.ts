import type { TeamShiftSalesQuery, TeamShiftSalesResponse } from "@agency_hub_core/contracts";
import { listFirstChatterActivities, listSaleLastWriters, listShiftSales, type Database, type ShiftSale } from "@agency_hub_core/db";
import { addUtcDays, startOfBusinessDay } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireDashboardUser, type AuthPrincipal } from "./auth.ts";
import {
  SALE_LAST_WRITER_HOURS,
  dayOfShift,
  lastWriterQuery,
  middleOfWork,
  moscowDayOf,
  netOf,
  readPeopleWork,
  teamReadPages,
  teamShiftOf,
  workHoldsShiftSale,
  type ComputedWork,
  type PersonPiece,
} from "./chatter-shifts.ts";
import { perHour, saleKindOf, settleSale } from "./chatter-stats.ts";
import {
  RULED_SALES_LEAD_MS,
  creditedPiece,
  openWindowFrom,
  outsideHomeOf,
  piecesByUser,
  readScreenHomes,
  readScreensRule,
  ruledSale,
  ruledSalesFrom,
  ruledWork,
  type OutsideHome,
  type ScreenHome,
  type ScreensRule,
} from "./sale-rule-screens.ts";
import { reportDateOfShift } from "./shift-rows.ts";

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
 *
 * The window's sales no shift holds are listed apart (`outside`), never in the
 * money above: a look-in's when its person last wrote to the fan, the rest
 * nobody's. Shifts, look-ins and nobody add up to every sale of the pages.
 *
 * From the screens' switch on (sale-rule-screens.ts), a shift of a report date
 * of the switch's day or later is the rule's: its money is what `sale_homes`
 * credits it (a sale at a junction once: the last writer's, the slot's, or the
 * owner's to decide), its day is its report date; `outside` then has the
 * rule's lines too — the pot, a PPV waiting for its sender, the owner's
 * decision. Off, every number is the old count.
 */

const DAY_MS = 86_400_000;

type Totals = Omit<TeamShiftSalesResponse["team"], "daily">;

export interface HeldShift extends PersonPiece {
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
    if (workHoldsShiftSale(work, sale)) held.push(sale);
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

/** The sales of [from, to) no shift holds, oldest first: `shifts` — everyone's, with what each holds. Pure. */
export function salesNoShiftHolds(input: { from: number; to: number; sales: readonly ShiftSale[]; shifts: readonly HeldShift[] }): ShiftSale[] {
  const held = new Set(input.shifts.flatMap((shift) => shift.held.map((sale) => sale.transactionId)));
  return input.sales.filter((sale) => sale.occurredAt.getTime() >= input.from && sale.occurredAt.getTime() < input.to && !held.has(sale.transactionId));
}

/** The look-ins whose pages and time hold the sale (`workHoldsSale`); it is theirs only if its person last wrote to the fan. Pure. */
export function visitsAround(visits: readonly PersonPiece[], sale: ShiftSale): PersonPiece[] {
  return visits.filter((visit) => workHoldsShiftSale(visit.work, sale));
}

/**
 * Where a sale no shift holds went: to a look-in whose person was the last to
 * write to the fan (as a visit's sales, `salesHeldBy`; of several, the
 * earliest), or nobody. `lastWriters` — of the sales a look-in is around. Pure.
 */
export function settleOutsideShifts(
  sales: readonly ShiftSale[],
  visits: readonly PersonPiece[],
  lastWriters: ReadonlyMap<number, number>,
): Array<{ sale: ShiftSale; visit: PersonPiece | null }> {
  return sales.map((sale) => ({
    sale,
    visit: visitsAround(visits, sale).find((visit) => lastWriters.get(sale.transactionId) === visit.userId) ?? null,
  }));
}

/** The window's money outside shifts, by Moscow day of the sale and by page, and each sale. Pure. */
export function outsideMoney(settled: ReadonlyArray<{ sale: ShiftSale; visit: PersonPiece | null }>, dates: readonly string[]): TeamShiftSalesResponse["outside"] {
  const of = (list: typeof settled) => ({
    visitsNetMills: netOf(list.filter((one) => one.visit !== null).map((one) => one.sale)),
    nobodyNetMills: netOf(list.filter((one) => one.visit === null).map((one) => one.sale)),
  });
  const labels = [...new Set(settled.map((one) => one.sale.pageLabel))];
  return {
    ...of(settled),
    daily: dates.map((date) => ({ date, ...of(settled.filter((one) => moscowDayOf(one.sale.occurredAt.getTime()) === date)) })),
    pages: labels.map((pageLabel) => ({ pageLabel, ...of(settled.filter((one) => one.sale.pageLabel === pageLabel)) }))
      .sort((a, b) => b.visitsNetMills + b.nobodyNetMills - (a.visitsNetMills + a.nobodyNetMills) || a.pageLabel.localeCompare(b.pageLabel)),
    sales: settled.map((one) => ({
      at: one.sale.occurredAt.toISOString(),
      pageLabel: one.sale.pageLabel,
      fanName: one.sale.fanName,
      kind: saleKindOf(one.sale.kind),
      netMills: one.sale.netMills,
      visitBy: one.visit?.username ?? null,
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
 * The screens' view of the one rule for `teamShiftMoney`: from `from` on (sale-rule-screens.ts), a shift's money is
 * what `homes` credit it. `sales` — every sale a home may credit to a shift of the read, by id (read back by the PPV's
 * wait); `visits` — everyone's look-ins, for the homes that are theirs.
 */
export interface RuledShiftsInput {
  rule: ScreensRule;
  homes: ReadonlyMap<number, ScreenHome>;
  sales: ReadonlyMap<number, ShiftSale>;
  visits: readonly PersonPiece[];
}

/** A shift's money as the screen counts it, for the screen and the comparison («было и стало»). */
export interface ShiftMoney extends HeldShift {
  /** In the window (else the one before). */
  current: boolean;
  date: string;
  /** Counted by the rule (`ruledWork`); else by the old count. */
  ruled: boolean;
  /** The sales it counts, each with its share of the net (the whole net but a split's). */
  own: ShiftSale[];
  salesNetMills: number;
  overlapNetMills: number;
}

/**
 * Of the old shifts' sales, the ones they count (`settleSale` not a colleague's), and of the rule's homes, what each
 * ruled shift is credited — the sales an old shift counts aside. Pure.
 */
export function ruledCredits(input: {
  shifts: readonly HeldShift[];
  ruled: (shift: HeldShift) => boolean;
  settled: (userId: number, sale: ShiftSale) => "mine" | "theirs" | "both";
  rule: RuledShiftsInput;
}): { oldCounted: Set<number>; credits: Map<HeldShift, ShiftSale[]>; credited: Set<number> } {
  const oldCounted = new Set<number>();
  for (const shift of input.shifts) {
    if (input.ruled(shift)) continue;
    for (const sale of shift.held) if (input.settled(shift.userId, sale) !== "theirs") oldCounted.add(sale.transactionId);
  }
  const byUser = piecesByUser(input.shifts);
  const credits = new Map<HeldShift, ShiftSale[]>();
  const credited = new Set<number>();
  for (const [transactionId, home] of input.rule.homes) {
    if (home.kind !== "shift" || oldCounted.has(transactionId)) continue;
    const sale = input.rule.sales.get(transactionId);
    if (sale === undefined) continue;
    for (const share of home.shares) {
      const shift = creditedPiece(byUser, share);
      if (shift === null || !input.ruled(shift)) continue;
      credits.set(shift, [...(credits.get(shift) ?? []), { ...sale, netMills: share.mills }]);
      credited.add(transactionId);
    }
  }
  for (const list of credits.values()) list.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.transactionId - b.transactionId);
  return { oldCounted, credits, credited };
}

/**
 * The team's money from its shifts in the window (`shiftSalesWindow`) and the one
 * before. `shifts` — everyone's shifts read since a day before the window before,
 * any order; `lastWriters` — who last wrote to the fan of each contested sale;
 * `firstActivity` — everyone's first minute Hub has; `rule` — the one rule's homes
 * from the switch's day on (absent — off: the old count throughout). Pure.
 */
export function teamShiftMoney(input: TeamShiftMoneyInput): Omit<TeamShiftSalesResponse, "serverNow" | "outside"> {
  return teamShiftMoneyOf(input).result;
}

export interface TeamShiftMoneyInput {
  days: number;
  now: Date;
  until?: string | undefined;
  shifts: readonly HeldShift[];
  lastWriters: ReadonlyMap<number, number>;
  firstActivity: ReadonlyMap<number, Date>;
  rule?: RuledShiftsInput | undefined;
}

/** `teamShiftMoney` and each shift's money behind it. Pure. */
export function teamShiftMoneyOf(input: TeamShiftMoneyInput): {
  result: Omit<TeamShiftSalesResponse, "serverNow" | "outside">;
  money: ShiftMoney[];
  oldCounted: ReadonlySet<number>;
  credited: ReadonlySet<number>;
} {
  const window = shiftSalesWindow(input);
  const { previousFrom, previousTo, dates } = window;
  const holders = holdersOf(input.shifts);
  const settled = (userId: number, sale: ShiftSale) => settleSale(
    userId,
    [...(holders.get(sale.transactionId) ?? [])].filter((other) => other !== userId),
    input.lastWriters.get(sale.transactionId) ?? null,
  );
  const dayOf = (userId: number, work: ComputedWork) => dayOfShift(work, input.firstActivity.get(userId)?.getTime());

  const inWindow = (work: ComputedWork) => middleOfWork(work) >= window.from && middleOfWork(work) < window.to;
  const inPrevious = (work: ComputedWork) => middleOfWork(work) >= previousFrom && middleOfWork(work) < previousTo;
  // By the rule: a shift of a report date of the window, begun before its end (the window before: before the same point).
  const previousDates = new Set(dates.map((date) => moscowDayOf(Date.parse(`${date}T00:00:00+03:00`) - input.days * DAY_MS)));
  const currentDates = new Set(dates);
  const ruleInput = input.rule;
  const ruled = (shift: HeldShift) => ruledWork(ruleInput?.rule, shift.work);
  const ruledIn = (shift: HeldShift, days: ReadonlySet<string>, to: number) => days.has(reportDateOfShift(shift.work)) && shift.work.startedAt < to;
  const isCurrent = (shift: HeldShift) => (ruled(shift) ? ruledIn(shift, currentDates, window.to) : inWindow(shift.work));
  const isPrevious = (shift: HeldShift) => (ruled(shift) ? ruledIn(shift, previousDates, previousTo) : inPrevious(shift.work));
  const byRule = ruleInput === undefined
    ? { oldCounted: new Set<number>(), credits: new Map<HeldShift, ShiftSale[]>(), credited: new Set<number>() }
    : ruledCredits({ shifts: input.shifts, ruled, settled, rule: ruleInput });

  const money: ShiftMoney[] = input.shifts
    .filter((shift) => isCurrent(shift) || isPrevious(shift))
    .sort((a, b) => a.work.startedAt - b.work.startedAt || a.userId - b.userId)
    .map((shift) => {
      if (ruled(shift)) {
        const own = byRule.credits.get(shift) ?? [];
        return {
          ...shift, current: isCurrent(shift), date: reportDateOfShift(shift.work), ruled: true, own, salesNetMills: netOf(own), overlapNetMills: 0,
        };
      }
      const own = shift.held.filter((sale) => settled(shift.userId, sale) !== "theirs");
      return {
        ...shift,
        current: inWindow(shift.work),
        date: dayOf(shift.userId, shift.work),
        ruled: false,
        own,
        salesNetMills: netOf(own),
        overlapNetMills: netOf(own.filter((sale) => settled(shift.userId, sale) === "both")),
      };
    });
  type Money = ShiftMoney;
  const current = money.filter((one) => one.current);
  const before = money.filter((one) => !one.current);

  const totalsOf = (list: readonly Money[]): Totals => {
    const workedMinutes = list.reduce((sum, one) => sum + one.work.workedMinutes, 0);
    const salesNetMills = list.reduce((sum, one) => sum + one.salesNetMills, 0);
    return { shifts: list.length, workedMinutes, salesNetMills, sales: list.reduce((sum, one) => sum + one.own.length, 0), perHourMills: perHour(salesNetMills, workedMinutes) };
  };
  // The team counts a sale once, on the earliest shift that holds it; a ruled shift's share of a split is its own part.
  const teamOf = (list: readonly Money[]) => {
    const seen = new Set<number>();
    const counted = new Set<string>();
    const byDay = new Map<string, number>();
    let salesNetMills = 0;
    for (const one of list) {
      for (const sale of one.own) {
        const key = one.ruled ? `${sale.transactionId}:${one.userId}:${one.work.startedAt}` : String(sale.transactionId);
        if (counted.has(key) || (!one.ruled && seen.has(sale.transactionId))) continue;
        counted.add(key);
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

  const result = {
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
  return { result, money, oldCounted: byRule.oldCounted, credited: byRule.credited };
}

/** A sale of the window outside the shifts' money, with the line it is shown on. */
export interface OutsideSale {
  sale: ShiftSale;
  home: OutsideHome;
  /** A look-in's person. */
  visitBy: string | null;
}

/**
 * The window's sales outside the shifts' money with the rule on. One the rule places — of the switch's day or later,
 * or held by a ruled shift — is where its home is when that is no person's shift: a look-in, the pot, a PPV waiting
 * for its sender, the owner's decision, nobody. Any other as before: no shift holds it, a look-in's when its person
 * last wrote, else nobody's (`oldWay`, the old settling of the window's unheld sales). A sale a shift counts — old or
 * ruled — is never here, nor one whose home is a person's shift (counted on it, in its own window). Pure.
 */
export function outsideByRule(input: {
  from: number;
  to: number;
  sales: readonly ShiftSale[];
  rule: RuledShiftsInput;
  oldWay: ReadonlyArray<{ sale: ShiftSale; visit: PersonPiece | null }>;
  /** The sales a shift counts, old or ruled. */
  counted: ReadonlySet<number>;
  /** The sales a ruled shift holds. */
  heldByRuled: ReadonlySet<number>;
  usernames: ReadonlyMap<number, string>;
}): OutsideSale[] {
  const oldWay = new Map(input.oldWay.map((one) => [one.sale.transactionId, one]));
  const out: OutsideSale[] = [];
  for (const sale of input.sales) {
    const at = sale.occurredAt.getTime();
    if (at < input.from || at >= input.to || input.counted.has(sale.transactionId)) continue;
    const home = input.rule.homes.get(sale.transactionId);
    if (home === undefined || !(ruledSale(input.rule.rule, sale) || input.heldByRuled.has(sale.transactionId))) {
      const old = oldWay.get(sale.transactionId);
      if (old !== undefined) out.push({ sale, home: old.visit === null ? "nobody" : "visit", visitBy: old.visit?.username ?? null });
      continue;
    }
    const line = outsideHomeOf(home);
    if (line === null) continue;
    const visitor = line === "visit" ? home.shares[0]?.userId : undefined;
    out.push({ sale, home: line, visitBy: visitor === undefined ? null : input.usernames.get(visitor) ?? `hub:${visitor}` });
  }
  return out;
}

const RULED_LINES = ["pot", "waiting", "decide"] as const;

/** `outsideMoney` with the rule's lines beside the look-ins and nobody's: the pot, a PPV waiting, the owner's decision. Pure. */
export function outsideMoneyByRule(settled: readonly OutsideSale[], dates: readonly string[]): TeamShiftSalesResponse["outside"] {
  const of = (list: readonly OutsideSale[]) => {
    const sumOf = (home: OutsideHome) => netOf(list.filter((one) => one.home === home).map((one) => one.sale));
    return {
      visitsNetMills: sumOf("visit"),
      nobodyNetMills: sumOf("nobody"),
      ...Object.fromEntries(RULED_LINES.map((home) => [`${home}NetMills`, sumOf(home)])) as { potNetMills: number; waitingNetMills: number; decideNetMills: number },
    };
  };
  const total = (one: ReturnType<typeof of>) => one.visitsNetMills + one.nobodyNetMills + one.potNetMills + one.waitingNetMills + one.decideNetMills;
  const labels = [...new Set(settled.map((one) => one.sale.pageLabel))];
  return {
    ...of(settled),
    daily: dates.map((date) => ({ date, ...of(settled.filter((one) => moscowDayOf(one.sale.occurredAt.getTime()) === date)) })),
    pages: labels.map((pageLabel) => ({ pageLabel, ...of(settled.filter((one) => one.sale.pageLabel === pageLabel)) }))
      .sort((a, b) => total(b) - total(a) || a.pageLabel.localeCompare(b.pageLabel)),
    sales: settled.map((one) => ({
      at: one.sale.occurredAt.toISOString(),
      pageLabel: one.sale.pageLabel,
      fanName: one.sale.fanName,
      kind: saleKindOf(one.sale.kind),
      netMills: one.sale.netMills,
      visitBy: one.visitBy,
      home: one.home,
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
  return teamShiftSalesOf(app.db, { days, until, now, pages });
}

/** `teamShiftSales` of the pages, read as the screen reads it, for whoever may (the route above, the comparison tool). */
export async function teamShiftSalesOf(
  db: Database,
  input: { days: number; until?: string | undefined; now: Date; pages: "all" | readonly number[] },
): Promise<TeamShiftSalesResponse> {
  return (await teamShiftSalesRead(db, input)).response;
}

/** What `teamShiftSales` answers and what is behind it: each shift's money, the sales outside them, the rule's homes. */
export interface TeamShiftSalesRead {
  response: TeamShiftSalesResponse;
  money: ShiftMoney[];
  outside: OutsideSale[];
  rule: ScreensRule | null;
  homes: ReadonlyMap<number, ScreenHome>;
}

/**
 * `teamShiftSales`, with the screens' switch as stored (`rule` absent) or as given (null — off; the comparison's
 * «было» and «стало»). Off, every number is the old count, byte for byte.
 */
export async function teamShiftSalesRead(
  db: Database,
  input: { days: number; until?: string | undefined; now: Date; pages: "all" | readonly number[]; rule?: ScreensRule | null },
): Promise<TeamShiftSalesRead> {
  const { days, until, now, pages } = input;
  const rule = input.rule !== undefined ? input.rule : await readScreensRule(db);
  const window = shiftSalesWindow({ days, now, until });
  // A day on each side, so a shift the window's edge cuts is whole.
  const readFrom = new Date(window.previousFrom - DAY_MS);
  const readTo = new Date(Math.min(now.getTime(), window.to + DAY_MS));

  const [people, firstActivity] = await Promise.all([
    readPeopleWork(db, { from: readFrom, to: readTo, now, pages }),
    listFirstChatterActivities(db),
  ]);
  const pieces = (kind: ComputedWork["kind"]) => [...people].flatMap(([userId, person]) => person.work
    .filter((work) => work.kind === kind)
    .map((work) => ({ userId, username: person.username, work })));
  const shifts = pieces("shift");
  const visits = pieces("visit");
  // Every page's sales, a page nobody had open in the window too: its money is outside the shifts, never out of sight.
  const sales = await listShiftSales(db, { pageIds: pages, from: readFrom, to: readTo });
  const held = shifts.map((shift) => ({ ...shift, held: salesOfWork(shift.work, sales) }));
  // The window's sales no shift holds: a look-in's when its person last wrote to the fan, else nobody's.
  const outside = salesNoShiftHolds({ from: window.from, to: window.to, sales, shifts: held });
  const lastWriters = await listSaleLastWriters(db, {
    hours: SALE_LAST_WRITER_HOURS,
    sales: lastWriterQuery([...contestedSales(held), ...outside.filter((sale) => visitsAround(visits, sale).length > 0)]),
  });
  const oldWay = settleOutsideShifts(outside, visits, lastWriters);
  if (rule === null) {
    const { result, money } = teamShiftMoneyOf({ days, now, until, shifts: held, lastWriters, firstActivity });
    return {
      response: { ...result, outside: outsideMoney(oldWay, window.dates), serverNow: now.toISOString() },
      money,
      outside: oldWay.map((one) => ({ sale: one.sale, home: one.visit === null ? "nobody" : "visit", visitBy: one.visit?.username ?? null })),
      rule,
      homes: new Map(),
    };
  }

  // By the rule: the homes of every sale that can land on a ruled shift of the read — back by the PPV's wait.
  const ruledFrom = Math.max(ruledSalesFrom(rule), readFrom.getTime() - RULED_SALES_LEAD_MS);
  const earlier = ruledFrom < readFrom.getTime() ? await listShiftSales(db, { pageIds: pages, from: new Date(ruledFrom), to: readFrom }) : [];
  const allSales = [...earlier, ...sales];
  const homes = await readScreenHomes(db, {
    sales: allSales.filter((sale) => sale.occurredAt.getTime() >= ruledFrom),
    openFrom: openWindowFrom(now, [...people.values()].flatMap((person) => person.work)),
    now,
    live: rule.live,
  });
  const ruleInput: RuledShiftsInput = { rule, homes, sales: new Map(allSales.map((sale) => [sale.transactionId, sale])), visits };
  const { result, money, oldCounted, credited } = teamShiftMoneyOf({ days, now, until, shifts: held, lastWriters, firstActivity, rule: ruleInput });
  const usernames = new Map([...people].map(([userId, person]) => [userId, person.username]));
  const outsideSales = outsideByRule({
    from: window.from,
    to: window.to,
    sales,
    rule: ruleInput,
    oldWay,
    counted: new Set([...oldCounted, ...credited]),
    heldByRuled: new Set(held.filter((shift) => ruledWork(rule, shift.work)).flatMap((shift) => shift.held.map((sale) => sale.transactionId))),
    usernames,
  });
  return {
    response: { ...result, outside: outsideMoneyByRule(outsideSales, window.dates), ruleFrom: rule.from, serverNow: now.toISOString() },
    money,
    outside: outsideSales,
    rule,
    homes,
  };
}
