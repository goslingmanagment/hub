import {
  CHATTER_SHIFT_END_IDLE_MINUTES,
  CHATTER_STATS_MAX_DAYS,
  CLIENT_ACTIVITY_LOST_MINUTES,
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
  listChatterActivityMinutes,
  listConfirmedShiftCredits,
  listPpvFacts,
  listReplyDelayCounts,
  listSaleCompanions,
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
import { shiftsOfMinutes, type ActivityMinute, type ComputedShift } from "./chatter-shifts.ts";
import { moscowDayOf } from "./shift-report.ts";
import { DELAY_BOUNDS, byDelayOf, byPriceOf } from "./team-sales.ts";

/**
 * A chatter's statistics: the cabinet's «Статистика» (`accountChatterStats`,
 * the caller's own) and the same for the owner and team leads
 * (`teamChatterStats`). Contract: packages/contracts chatter-stats.ts.
 *
 * THE SHIFTS are Chat Memory week 1's actual shifts (services/chatter-shifts.ts)
 * on the pages the chatter works now, as a person counts them (`joinShifts`):
 * two that are less than an hour apart — the browser restarted, a break — are
 * one, the gap a pause; a stretch under VISIT_MINUTES of work with no sale is
 * a visit, not a shift, and is left out.
 *
 * THE MONEY OF A SHIFT is the net of each sale that came during it on a page
 * the chatter had open in the extension at that moment (`shiftOfSale`): a page
 * opened for a minute in an eight-hour shift does not bring the whole shift's
 * sales of it. A sale when another chatter, in their own shift, had the page
 * open too counts for both and is marked (`overlap`, `together`): Hub does not
 * split it. A guide, not a basis for pay — what a sale pays whom is the
 * confirmed shift report's (services/shift-report.ts), shown beside it.
 *
 * THE REST is what «Числа» and «Продажи» already count, for this chatter:
 * messages with them as the author, fans written to and who paid within the
 * shift, personal PPVs by price, replies by delay against purchases — the
 * team's on the same pages beside each. Database only and read-only.
 */

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const TOP_FANS = 5;
/** Two open minutes of a page this far apart are one stretch: a beat comes once a minute, and a silent extension is lost after it. */
const SPAN_GAP_MS = CLIENT_ACTIVITY_LOST_MINUTES * MINUTE_MS;
/** A tab opened within the minute before its first beat. */
const SPAN_LEAD_MS = MINUTE_MS;
/** The last beat's minute and the one after it. */
const SPAN_TAIL_MS = 2 * MINUTE_MS;
/** Actual shifts this close are one shift here: the same hour without activity that ends a shift. */
const JOIN_GAP_MS = CHATTER_SHIFT_END_IDLE_MINUTES * MINUTE_MS;
/** Less work than this, with no sale, is a visit (a look at the extension), not a shift. */
export const VISIT_MINUTES = 15;

const KIND_OF: Readonly<Record<string, ChatterSaleKind>> = {
  message_purchase: "ppv",
  tip: "tip",
  stream_tip: "tip",
  subscription: "subscription",
  post_purchase: "post",
};

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const known = map.get(key);
  if (known === undefined) map.set(key, [value]);
  else known.push(value);
}

export interface OpenSpan {
  from: number;
  to: number;
}

/**
 * The stretches each page was open in the extension, from its open minutes
 * (any order): minutes up to SPAN_GAP_MS apart join, and a stretch runs from a
 * minute before its first to two minutes after its last. Pure.
 */
export function openSpansOf(minutes: ReadonlyArray<{ pageId: number; at: number }>): Map<number, OpenSpan[]> {
  const byPage = new Map<number, number[]>();
  for (const minute of minutes) push(byPage, minute.pageId, minute.at);
  const spans = new Map<number, OpenSpan[]>();
  for (const [pageId, ats] of byPage) {
    const sorted = [...new Set(ats)].sort((a, b) => a - b);
    const own: OpenSpan[] = [];
    let first = sorted[0]!;
    let last = first;
    for (const at of sorted.slice(1)) {
      if (at - last > SPAN_GAP_MS) {
        own.push({ from: first - SPAN_LEAD_MS, to: last + SPAN_TAIL_MS });
        first = at;
      }
      last = at;
    }
    own.push({ from: first - SPAN_LEAD_MS, to: last + SPAN_TAIL_MS });
    spans.set(pageId, own);
  }
  return spans;
}

/**
 * The index of the shift a sale is the chatter's in: it came while the shift
 * went on, and the chatter had its page open then. null — none. Pure.
 */
export function shiftOfSale(
  sale: { pageId: number; at: number },
  shifts: ReadonlyArray<{ startedAt: number; endedAt: number }>,
  spans: ReadonlyMap<number, readonly OpenSpan[]>,
): number | null {
  const index = shifts.findIndex((shift) => sale.at >= shift.startedAt && sale.at < shift.endedAt);
  if (index < 0) return null;
  const open = (spans.get(sale.pageId) ?? []).some((span) => sale.at >= span.from && sale.at < span.to);
  return open ? index : null;
}

export interface JoinedShift {
  startedAt: number;
  endedAt: number;
  ongoing: boolean;
  workedMinutes: number;
  pauses: Array<{ from: number; to: number }>;
  /** Active minutes per page. */
  pages: Map<string, number>;
  /** The actual shifts it is made of, as indexes of the input. */
  parts: number[];
}

/**
 * Actual shifts as a person counts them: each one that starts less than
 * JOIN_GAP_MS after the previous one ended joins it, the gap a pause. Input in
 * any order; the answer oldest first. Pure.
 */
export function joinShifts(shifts: readonly ComputedShift[]): JoinedShift[] {
  const order = shifts.map((shift, index) => ({ shift, index })).sort((a, b) => a.shift.startedAt - b.shift.startedAt);
  const joined: JoinedShift[] = [];
  for (const { shift, index } of order) {
    const last = joined.at(-1);
    if (last !== undefined && shift.startedAt - last.endedAt < JOIN_GAP_MS) {
      last.pauses.push({ from: last.endedAt, to: shift.startedAt }, ...shift.pauses);
      last.endedAt = shift.endedAt;
      last.ongoing = shift.ongoing;
      last.workedMinutes += shift.workedMinutes;
      for (const [label, minutes] of shift.pages) last.pages.set(label, (last.pages.get(label) ?? 0) + minutes);
      last.parts.push(index);
      continue;
    }
    joined.push({
      startedAt: shift.startedAt,
      endedAt: shift.endedAt,
      ongoing: shift.ongoing,
      workedMinutes: shift.workedMinutes,
      pauses: [...shift.pauses],
      pages: new Map(shift.pages),
      parts: [index],
    });
  }
  return joined;
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

function perHour(netMills: number, minutes: number): number | null {
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

  const [activitySince, minutes] = await Promise.all([
    findFirstChatterActivity(db, userId),
    // A day more, so a shift that began at the start of the window before is whole.
    listChatterActivityMinutes(db, { from: new Date(previousFrom.getTime() - DAY_MS), to: now, pages: pageIds, userId }),
  ]);
  const activity: ActivityMinute[] = minutes.map((minute) => ({ at: minute.minute.getTime(), pageLabel: minute.pageLabel, input: minute.input }));
  const actual = shiftsOfMinutes(activity, now.getTime());
  const spans = openSpansOf(minutes.map((minute) => ({ pageId: minute.pageId, at: minute.minute.getTime() })));
  const joinedAll = joinShifts(actual).filter((shift) => shift.startedAt >= previousFrom.getTime());
  const sales = joinedAll.length === 0 ? [] : await listShiftSales(db, { pageIds, from: previousFrom, to: now });

  // Each sale to the joined shift that holds it, if it is the chatter's.
  const salesOfShift = new Map<number, ShiftSale[]>();
  for (const sale of sales) {
    const index = shiftOfSale({ pageId: sale.pageId, at: sale.occurredAt.getTime() }, joinedAll, spans);
    if (index !== null) push(salesOfShift, index, sale);
  }
  const counted = joinedAll
    .map((shift, index) => ({ shift, sales: salesOfShift.get(index) ?? [] }))
    .filter((one) => one.shift.workedMinutes >= VISIT_MINUTES || one.sales.length > 0);
  const current = counted.filter((one) => one.shift.startedAt >= from.getTime());
  const before = counted.filter((one) => one.shift.startedAt < from.getTime());
  const currentSales = current.flatMap((one) => one.sales);

  const [companions, sends, ppvRows, replyRows, reports] = await Promise.all([
    listSaleCompanions(db, {
      userId,
      scopePageIds: pageIds,
      sales: currentSales.map((sale) => ({ transactionId: sale.transactionId, pageId: sale.pageId, at: sale.occurredAt })),
    }),
    listAuthoredSends(db, { userId, pageIds, from, to: now }),
    listPpvFacts(db, { from, to: now, pages: pageIds, burstMinFans: MASS_SEND_MIN_CHATS }),
    repliesTo <= from
      ? Promise.resolve([])
      : listReplyDelayCounts(db, { from, to: repliesTo, pages: pageIds, burstMinFans: MASS_SEND_MIN_CHATS, delayBounds: DELAY_BOUNDS }),
    listConfirmedShiftCredits(db, { userId, since: new Date(from.getTime() - DAY_MS), pageIds }),
  ]);
  const together = new Map<number, string[]>();
  for (const companion of companions) push(together, companion.transactionId, companion.username);
  const salesByFan = new Map<string, ShiftSale[]>();
  for (const sale of sales) if (sale.fanRef !== null) push(salesByFan, `${sale.pageId}:${sale.fanRef}`, sale);
  // A joined shift is confirmed when every actual shift of it is: the report confirms actual shifts.
  const confirmations = revenueOfShifts(actual, reports);

  const written = new Set<string>();
  const paid = new Set<string>();
  let sendAt = 0;
  const shifts = current.map(({ shift, sales: own }) => {
    while (sendAt < sends.length && sends[sendAt]!.at.getTime() < shift.startedAt) sendAt += 1;
    const ownSends: AuthoredSendRow[] = [];
    for (let at = sendAt; at < sends.length && sends[at]!.at.getTime() < shift.endedAt; at += 1) ownSends.push(sends[at]!);
    const fans = fansOf(shift, ownSends, salesByFan);
    for (const key of fans.written) written.add(key);
    for (const key of fans.paid) paid.add(key);
    const overlapping = own.filter((sale) => together.has(sale.transactionId));
    const parts = shift.parts.map((part) => confirmations[part]!);
    return {
      startedAt: iso(shift.startedAt),
      endedAt: iso(shift.endedAt),
      ongoing: shift.ongoing,
      workedMinutes: shift.workedMinutes,
      pauses: shift.pauses.map((pause) => ({ from: iso(pause.from), to: iso(pause.to) })),
      pages: [...shift.pages].sort((a, b) => b[1] - a[1]).map(([label]) => label),
      salesNetMills: own.reduce((sum, sale) => sum + sale.netMills, 0),
      overlapNetMills: overlapping.reduce((sum, sale) => sum + sale.netMills, 0),
      together: [...new Set(overlapping.flatMap((sale) => together.get(sale.transactionId)!))].sort(),
      messages: ownSends.length,
      ppvSent: ownSends.filter((send) => send.priced).length,
      fansWritten: fans.written.length,
      fansPaid: fans.paid.length,
      confirmedNetMills: parts.every((part) => part.confirmed) ? parts.reduce((sum, part) => sum + (part.revenueMills ?? 0), 0) : null,
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
  const previousMinutes = before.reduce((total, one) => total + one.shift.workedMinutes, 0);
  const previousNet = before.reduce((total, one) => total + one.sales.reduce((sub, sale) => sub + sale.netMills, 0), 0);

  // Every Moscow day of the window, by the day each shift began (as the payout sheet dates a shift).
  const daily = Array.from({ length: input.days }, (_, offset) => {
    const date = moscowDayOf(addUtcDays(from, offset).getTime());
    const ofDay = shifts.filter((_, index) => moscowDayOf(current[index]!.shift.startedAt) === date);
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
  for (const { shift } of current) for (const [label, active] of shift.pages) pageTotal(label).activeMinutes += active;
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
  const streaks = streaksOf(new Set(counted.map((one) => moscowDayOf(one.shift.startedAt))), moscowDayOf(now.getTime()));

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
