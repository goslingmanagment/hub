import {
  CHATTER_STATS_MAX_DAYS,
  MASS_SEND_MIN_CHATS,
  type ChatterSaleKind,
  type ChatterStats,
  type TeamChatterStatsQuery,
  type TeamChatterStatsResponse,
} from "@agency_hub_core/contracts";
import {
  findFirstChatterActivity,
  listActivePeople,
  listAuthoredSends,
  listConfirmedShiftCredits,
  listPpvFacts,
  listReplyDelayCounts,
  listSaleLastWriters,
  listShiftSales,
  listUserPageAssignments,
  type AuthoredSendRow,
  type Database,
  type ShiftSale,
} from "@agency_hub_core/db";
import { addUtcDays, startOfBusinessDay } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireDashboardUser, requireSessionUser, type AuthPrincipal } from "./auth.ts";
import { revenueOfShifts } from "./chatter-numbers.ts";
import {
  SALE_LAST_WRITER_HOURS,
  dayOfWork,
  lastWriterQuery,
  middleOfWork,
  moscowDayOf,
  readPeopleWork,
  workHoldsSale,
  type ComputedWork,
  type PersonWork,
} from "./chatter-shifts.ts";
import { DELAY_BOUNDS, byDelayOf, byPriceOf } from "./team-sales.ts";

/**
 * A chatter's statistics: the cabinet's «Статистика» (`accountChatterStats`,
 * the caller's own) and the same for the owner and team leads
 * (`teamChatterStats`). Contract: packages/contracts chatter-stats.ts.
 *
 * THE SHIFTS, THE VISITS, THEIR DAYS AND THEIR SALES are services/chatter-shifts.ts's,
 * on the pages the chatter works now. The money here is the shifts': a visit
 * is listed apart.
 *
 * A SALE TWO SHIFTS HOLD (two chatters on a page, as at a handover) is the money
 * of who last wrote to its fan on that page (`settleSale`). Neither wrote: it
 * counts for both and is marked (`overlap`, `together`), Hub does not split it.
 * Checked against the payout sheet for the first week: of $2,131 two shifts held,
 * $96 stayed with both, and the sheet's cells came closer. A visit's sales are
 * chatter-shifts.ts's (`salesHeldBy`), here read for all of them at once.
 *
 * A guide, not a basis for pay — what a sale pays whom is the confirmed shift
 * report's (services/shift-report.ts), shown beside it.
 *
 * THE REST is what «Числа» and «Продажи» already count, for this chatter:
 * messages with them as the author, fans written to and who paid within the
 * shift, personal PPVs by price, replies by delay against purchases — the
 * team's on the same pages beside each. Database only and read-only.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const TOP_FANS = 5;

const KIND_OF: Readonly<Record<string, ChatterSaleKind>> = {
  message_purchase: "ppv",
  tip: "tip",
  stream_tip: "tip",
  subscription: "subscription",
  post_purchase: "post",
};

/** A sale's kind as the screens name it, from the transaction's canonical type. Pure. */
export function saleKindOf(canonicalType: string): ChatterSaleKind {
  return KIND_OF[canonicalType] ?? "tip";
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const known = map.get(key);
  if (known === undefined) map.set(key, [value]);
  else known.push(value);
}

/**
 * Whose a sale of the chatter's shift is, by who else's shifts hold it and who
 * last wrote to its fan (null — nobody we know of): the chatter's, a colleague's,
 * or both of theirs. Pure.
 */
export function settleSale(userId: number, others: readonly number[], lastWriter: number | null): "mine" | "theirs" | "both" {
  if (others.length === 0 || lastWriter === userId) return "mine";
  return lastWriter !== null && others.includes(lastWriter) ? "theirs" : "both";
}

/** Moscow days in a row with a shift: up to today (or yesterday while today has none yet), and the longest run. Pure. */
export function streaksOf(days: ReadonlySet<string>, today: string): { current: number; longest: number } {
  const shift = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10);
  let current = 0;
  let cursor = days.has(today) ? today : shift(today, -1);
  while (days.has(cursor)) {
    current += 1;
    cursor = shift(cursor, -1);
  }
  let longest = 0;
  for (const day of days) {
    if (days.has(shift(day, -1))) continue;
    let run = 0;
    for (let next = day; days.has(next); next = shift(next, 1)) run += 1;
    longest = Math.max(longest, run);
  }
  return { current, longest };
}

function emptyByKind(): Record<ChatterSaleKind, number> {
  return { ppv: 0, tip: 0, subscription: 0, post: 0 };
}

/** Money per worked hour; null without worked time. Pure. */
export function perHour(netMills: number, minutes: number): number | null {
  return minutes === 0 ? null : Number((BigInt(netMills) * 60n) / BigInt(minutes));
}

/** The composed_with of a message as the cabinet groups it. Pure. */
function composedGroupOf(value: string | null): "hand" | "reply" | "fix" | "greet" | "other" {
  if (value === "hand" || value === "reply" || value === "fix") return value;
  if (value === "hi" || value === "ping") return "greet";
  return "other";
}

const iso = (at: number) => new Date(at).toISOString();

interface StatsPage {
  pageId: number;
  label: string;
  platform: string;
}

/** The pages a shift worked, the most active first; while it has none yet, the pages it is active on. Pure. */
function pagesOf(shift: ComputedWork): string[] {
  const active = [...shift.pages].sort((a, b) => b[1] - a[1]).map(([label]) => label);
  if (shift.salesSince.size === 0) return active;
  const worked = [...shift.salesSince.keys()];
  return [...active.filter((label) => shift.salesSince.has(label)), ...worked.filter((label) => !shift.pages.has(label))];
}

/** The fans written to in a shift and, of them, who paid on that page after the first message, before the shift's end. Pure. */
function fansOf(shift: { endedAt: number }, sends: readonly AuthoredSendRow[], salesByFan: ReadonlyMap<string, readonly ShiftSale[]>) {
  const firstTo = new Map<string, number>();
  for (const send of sends) {
    const key = `${send.pageId}:${send.fanRef}`;
    const at = send.at.getTime();
    if (!firstTo.has(key) || at < firstTo.get(key)!) firstTo.set(key, at);
  }
  const paid = new Set<string>();
  for (const [key, first] of firstTo) {
    const bought = (salesByFan.get(key) ?? []).some((sale) => sale.occurredAt.getTime() >= first && sale.occurredAt.getTime() < shift.endedAt);
    if (bought) paid.add(key);
  }
  return { written: [...firstTo.keys()], paid: [...paid] };
}

const netOf = (sales: readonly ShiftSale[]) => sales.reduce((sum, sale) => sum + sale.netMills, 0);
const holds = (work: ComputedWork, sale: ShiftSale) => workHoldsSale(work, { pageLabel: sale.pageLabel, at: sale.occurredAt.getTime() });

export async function computeChatterStats(
  db: Database,
  input: { userId: number; username: string; pages: readonly StatsPage[]; days: number; now: Date },
): Promise<ChatterStats> {
  const { userId, now } = input;
  const from = addUtcDays(startOfBusinessDay(now), -(input.days - 1));
  const previousFrom = addUtcDays(from, -input.days);
  // A reply's day for a purchase must be over (as «Продажи»).
  const repliesTo = new Date(Math.max(now.getTime() - DAY_MS, from.getTime()));
  const pageIds = input.pages.map((page) => page.pageId);
  // A day more, so a shift of the window's first day that began the evening before is whole.
  const readFrom = new Date(previousFrom.getTime() - DAY_MS);

  const [activitySince, people] = await Promise.all([
    findFirstChatterActivity(db, userId),
    readPeopleWork(db, { from: readFrom, to: now, now, pages: pageIds, userId }),
  ]);
  const work = (people.get(userId)?.work ?? []).filter((one) => middleOfWork(one) >= previousFrom.getTime());
  const sales = work.length === 0 ? [] : await listShiftSales(db, { pageIds, from: readFrom, to: now });
  const held = work.map((one) => ({ work: one, sales: sales.filter((sale) => holds(one, sale)) }));
  const heldSales = held.flatMap((one) => one.sales);

  const [team, sendsRead, ppvRows, replyRows, reports] = await Promise.all([
    // Whose shifts hold these sales too.
    heldSales.length === 0 ? Promise.resolve(new Map<number, PersonWork>()) : readPeopleWork(db, { from: readFrom, to: now, now, pages: pageIds }),
    listAuthoredSends(db, { userId, pageIds, from: new Date(from.getTime() - DAY_MS), to: now }),
    listPpvFacts(db, { from, to: now, pages: pageIds, burstMinFans: MASS_SEND_MIN_CHATS }),
    repliesTo <= from
      ? Promise.resolve([])
      : listReplyDelayCounts(db, { from, to: repliesTo, pages: pageIds, burstMinFans: MASS_SEND_MIN_CHATS, delayBounds: DELAY_BOUNDS }),
    listConfirmedShiftCredits(db, { userId, since: new Date(from.getTime() - DAY_MS), pageIds }),
  ]);
  const othersOf = new Map<number, number[]>();
  const usernames = new Map<number, string>();
  for (const [otherId, other] of team) {
    if (otherId === userId) continue;
    usernames.set(otherId, other.username);
    const shifts = other.work.filter((one) => one.kind === "shift");
    for (const sale of heldSales) if (shifts.some((one) => holds(one, sale))) push(othersOf, sale.transactionId, otherId);
  }
  const visitSales = new Set(held.filter((one) => one.work.kind === "visit").flatMap((one) => one.sales.map((sale) => sale.transactionId)));
  const lastWriters = await listSaleLastWriters(db, {
    hours: SALE_LAST_WRITER_HOURS,
    sales: lastWriterQuery(heldSales.filter((sale) => othersOf.has(sale.transactionId) || visitSales.has(sale.transactionId))),
  });
  const settled = (sale: ShiftSale) => settleSale(userId, othersOf.get(sale.transactionId) ?? [], lastWriters.get(sale.transactionId) ?? null);

  // The chatter's first shift Hub has began before Hub heard of them, so most of what Hub saw says nothing of its day.
  const dayOfShift = (shift: ComputedWork) => (activitySince !== null && shift.startedAt - activitySince.getTime() < HOUR_MS ? moscowDayOf(shift.startedAt) : dayOfWork(shift));
  const withSales = held.map((one) => ({
    work: one.work,
    sales: one.sales.filter((sale) => (one.work.kind === "shift" ? settled(sale) !== "theirs" : lastWriters.get(sale.transactionId) === userId)),
  }));
  const inWindow = (one: { work: ComputedWork }) => middleOfWork(one.work) >= from.getTime();
  const counted = withSales.filter((one) => one.work.kind === "shift");
  const current = counted.filter(inWindow);
  const before = counted.filter((one) => !inWindow(one));
  const visits = withSales.filter((one) => one.work.kind === "visit" && inWindow(one));
  const currentSales = current.flatMap((one) => one.sales);
  const together = new Map<number, string[]>();
  for (const sale of currentSales) {
    if (settled(sale) === "both") together.set(sale.transactionId, othersOf.get(sale.transactionId)!.map((otherId) => usernames.get(otherId)!));
  }
  const sends = sendsRead.filter((send) => send.at >= from);
  const salesByFan = new Map<string, ShiftSale[]>();
  for (const sale of sales) if (sale.fanRef !== null) push(salesByFan, `${sale.pageId}:${sale.fanRef}`, sale);
  const confirmations = revenueOfShifts(current.map((one) => one.work), reports);

  const written = new Set<string>();
  const paid = new Set<string>();
  let sendAt = 0;
  const shifts = current.map(({ work: shift, sales: own }, index) => {
    while (sendAt < sendsRead.length && sendsRead[sendAt]!.at.getTime() < shift.startedAt) sendAt += 1;
    const ownSends: AuthoredSendRow[] = [];
    for (let at = sendAt; at < sendsRead.length && sendsRead[at]!.at.getTime() < shift.endedAt; at += 1) ownSends.push(sendsRead[at]!);
    const fans = fansOf(shift, ownSends, salesByFan);
    for (const key of fans.written) written.add(key);
    for (const key of fans.paid) paid.add(key);
    const overlapping = own.filter((sale) => together.has(sale.transactionId));
    const confirmation = confirmations[index]!;
    return {
      date: dayOfShift(shift),
      startedAt: iso(shift.startedAt),
      endedAt: iso(shift.endedAt),
      ongoing: shift.ongoing,
      workedMinutes: shift.workedMinutes,
      pauses: shift.pauses.map((pause) => ({ from: iso(pause.from), to: iso(pause.to) })),
      pages: pagesOf(shift),
      salesNetMills: netOf(own),
      overlapNetMills: netOf(overlapping),
      together: [...new Set(overlapping.flatMap((sale) => together.get(sale.transactionId)!))].sort(),
      messages: ownSends.length,
      ppvSent: ownSends.filter((send) => send.priced).length,
      fansWritten: fans.written.length,
      fansPaid: fans.paid.length,
      confirmedNetMills: confirmation.confirmed ? confirmation.revenueMills : null,
      sales: own.map((sale) => ({
        at: sale.occurredAt.toISOString(),
        netMills: sale.netMills,
        kind: KIND_OF[sale.kind] ?? "tip",
        pageLabel: sale.pageLabel,
        fanName: sale.fanName,
        overlap: together.has(sale.transactionId),
      })),
    };
  });

  const sum = (pick: (shift: (typeof shifts)[number]) => number) => shifts.reduce((total, shift) => total + pick(shift), 0);
  const byKind = emptyByKind();
  for (const sale of currentSales) byKind[KIND_OF[sale.kind] ?? "tip"] += sale.netMills;
  const workedMinutes = sum((shift) => shift.workedMinutes);
  const salesNetMills = sum((shift) => shift.salesNetMills);

  // The window before: only when Hub had the chatter's activity for all of it.
  const previousCovered = activitySince !== null && activitySince.getTime() <= previousFrom.getTime();
  const previousMinutes = before.reduce((total, one) => total + one.work.workedMinutes, 0);
  const previousNet = before.reduce((total, one) => total + netOf(one.sales), 0);

  // Every Moscow day of the window, by the day each shift belongs to (as the payout sheet dates a shift).
  const daily = Array.from({ length: input.days }, (_, offset) => {
    const date = moscowDayOf(addUtcDays(from, offset).getTime());
    const ofDay = shifts.filter((shift) => shift.date === date);
    const dayKinds = emptyByKind();
    for (const shift of ofDay) for (const sale of shift.sales) dayKinds[sale.kind] += sale.netMills;
    return {
      date,
      salesNetMills: ofDay.reduce((total, shift) => total + shift.salesNetMills, 0),
      byKind: dayKinds,
      shifts: ofDay.length,
      workedMinutes: ofDay.reduce((total, shift) => total + shift.workedMinutes, 0),
    };
  });

  const pageTotals = new Map<string, { salesNetMills: number; sales: number; activeMinutes: number }>();
  const pageTotal = (label: string) => {
    const known = pageTotals.get(label) ?? { salesNetMills: 0, sales: 0, activeMinutes: 0 };
    pageTotals.set(label, known);
    return known;
  };
  for (const { work: shift } of current) for (const [label, active] of shift.pages) pageTotal(label).activeMinutes += active;
  for (const sale of currentSales) {
    const total = pageTotal(sale.pageLabel);
    total.salesNetMills += sale.netMills;
    total.sales += 1;
  }
  const platformOf = new Map(input.pages.map((page) => [page.label, page.platform]));

  const mineRows = ppvRows.filter((row) => row.userId === userId);
  const mineBought = mineRows.filter((row) => row.bought);
  const mineByPrice = byPriceOf(mineRows);
  const teamByPrice = byPriceOf(ppvRows.filter((row) => row.userId !== null));
  const mineByDelay = byDelayOf(replyRows.filter((row) => row.userId === userId));
  const teamByDelay = byDelayOf(replyRows.filter((row) => row.userId !== null));

  const composed = { hand: 0, reply: 0, fix: 0, greet: 0, other: 0 };
  for (const send of sends) composed[composedGroupOf(send.composedWith)] += 1;

  const fanTotals = new Map<string, { fanName: string | null; pageLabel: string; netMills: number; sales: number }>();
  for (const sale of currentSales) {
    if (sale.fanRef === null) continue;
    const key = `${sale.pageId}:${sale.fanRef}`;
    const known = fanTotals.get(key) ?? { fanName: sale.fanName, pageLabel: sale.pageLabel, netMills: 0, sales: 0 };
    known.netMills += sale.netMills;
    known.sales += 1;
    fanTotals.set(key, known);
  }

  const bestShift = shifts.reduce<(typeof shifts)[number] | null>((best, shift) => (shift.salesNetMills > (best?.salesNetMills ?? 0) ? shift : best), null);
  const bestDay = daily.reduce<(typeof daily)[number] | null>((best, day) => (day.salesNetMills > (best?.salesNetMills ?? 0) ? day : best), null);
  const biggest = currentSales.reduce<ShiftSale | null>((best, sale) => (sale.netMills > (best?.netMills ?? 0) ? sale : best), null);
  const streaks = streaksOf(new Set(counted.map((one) => dayOfShift(one.work))), moscowDayOf(now.getTime()));

  return {
    user: { userId, username: input.username },
    days: input.days,
    from: from.toISOString(),
    to: now.toISOString(),
    activitySince: activitySince?.toISOString() ?? null,
    totals: {
      shifts: shifts.length,
      workedMinutes,
      salesNetMills,
      sales: currentSales.length,
      perHourMills: perHour(salesNetMills, workedMinutes),
      overlapNetMills: sum((shift) => shift.overlapNetMills),
      byKind,
      confirmedNetMills: sum((shift) => shift.confirmedNetMills ?? 0),
      unconfirmedShifts: shifts.filter((shift) => !shift.ongoing && shift.confirmedNetMills === null).length,
      messages: sends.length,
      fansWritten: written.size,
      fansPaid: paid.size,
    },
    previous: previousCovered
      ? { shifts: before.length, workedMinutes: previousMinutes, salesNetMills: previousNet, sales: before.reduce((total, one) => total + one.sales.length, 0), perHourMills: perHour(previousNet, previousMinutes) }
      : null,
    daily,
    shifts: [...shifts].reverse(),
    visits: visits.map(({ work: visit, sales: own }) => ({
      date: dayOfWork(visit),
      startedAt: iso(visit.startedAt),
      endedAt: iso(visit.endedAt),
      workedMinutes: visit.workedMinutes,
      messages: [...visit.messages.values()].reduce((total, messages) => total + messages, 0),
      salesNetMills: netOf(own),
      sales: own.length,
    })).reverse(),
    pages: [...pageTotals.entries()]
      .map(([pageLabel, total]) => ({ pageLabel, platform: platformOf.get(pageLabel) ?? "", ...total }))
      .sort((a, b) => b.salesNetMills - a.salesNetMills || b.activeMinutes - a.activeMinutes || a.pageLabel.localeCompare(b.pageLabel)),
    ppv: {
      sent: mineRows.length,
      bought: mineBought.length,
      netMills: mineBought.reduce((total, row) => total + row.netMills, 0),
      byPrice: mineByPrice.map((cell, index) => ({ ...cell, teamSent: teamByPrice[index]!.sent, teamBought: teamByPrice[index]!.bought })),
    },
    replies: {
      to: repliesTo.toISOString(),
      replies: mineByDelay.reduce((total, cell) => total + cell.replies, 0),
      bought: mineByDelay.reduce((total, cell) => total + cell.bought, 0),
      byDelay: mineByDelay.map((cell, index) => ({ ...cell, teamReplies: teamByDelay[index]!.replies, teamBought: teamByDelay[index]!.bought })),
    },
    composed,
    topFans: [...fanTotals.values()].sort((a, b) => b.netMills - a.netMills || b.sales - a.sales).slice(0, TOP_FANS),
    records: {
      bestShift: bestShift === null ? null : { startedAt: bestShift.startedAt, salesNetMills: bestShift.salesNetMills },
      bestDay: bestDay === null ? null : { date: bestDay.date, salesNetMills: bestDay.salesNetMills },
      biggestSale: biggest === null ? null : {
        at: biggest.occurredAt.toISOString(),
        netMills: biggest.netMills,
        kind: KIND_OF[biggest.kind] ?? "tip",
        pageLabel: biggest.pageLabel,
        fanName: biggest.fanName,
      },
      streakDays: streaks.current,
      longestStreakDays: streaks.longest,
    },
    serverNow: now.toISOString(),
  };
}

/** The caller's own statistics, on the pages they work now. Any cookie session. */
export async function readAccountChatterStats(app: AppContext, principal: AuthPrincipal, input: { days: number }): Promise<ChatterStats> {
  requireSessionUser(principal);
  const pages = principal.user.assignedPages.map((page) => ({ pageId: page.id, label: page.label, platform: page.platform }));
  return computeChatterStats(app.db, { userId: principal.user.id, username: principal.user.username, pages, days: input.days, now: new Date() });
}

/** A chatter's statistics for the owner and team leads: the chatter's pages the viewer reaches. */
export async function readTeamChatterStats(
  app: AppContext,
  principal: AuthPrincipal,
  input: { query: TeamChatterStatsQuery; pageScope: readonly number[] | undefined },
): Promise<TeamChatterStatsResponse> {
  requireDashboardUser(principal);
  const now = new Date();
  const scope = input.pageScope;
  const people = await listActivePeople(app.db, { pages: scope ?? "all", from: new Date(now.getTime() - CHATTER_STATS_MAX_DAYS * DAY_MS), to: now });
  const chosen = people.find((person) => person.userId === input.query.userId) ?? people[0];
  if (chosen === undefined) return { people, stats: null, serverNow: now.toISOString() };
  const pages = (await listUserPageAssignments(app.db, chosen.userId))
    .filter((page) => scope === undefined || scope.includes(page.pageId))
    .map((page) => ({ pageId: page.pageId, label: page.label, platform: page.platform }));
  const stats = await computeChatterStats(app.db, { userId: chosen.userId, username: chosen.username, pages, days: input.query.days, now });
  return { people, stats, serverNow: now.toISOString() };
}
