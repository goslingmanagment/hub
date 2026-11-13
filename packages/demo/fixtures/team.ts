import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { averageQuality, type ShiftQuality } from "@agency_hub_core/ui/shiftReview";

import { demoError, queryNumber, queryString, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DEMO_CHATTERS, DEMO_DATA_PAGES, demoFans, demoPage } from "../world.ts";
import { teamGreetings, teamWinBackApproaches, teamWinBackResults } from "./team-extra.ts";
import { adminModelApplication, adminModelApplications } from "./team-applications.ts";
import { teamChatterStats, teamShiftSales } from "./team-stats.ts";
import { teamDisputes } from "./team-disputes.ts";
import { shiftReviewNumbers, teamShiftReview } from "./team-review.ts";
import {
  DAY,
  HOUR,
  MIN,
  between,
  clamp,
  creditedOf,
  intBetween,
  isoAt,
  messagesOnDay,
  mskDay,
  mskHour,
  mskMidnight,
  pageBuyFactor,
  ppvCells,
  replyCells,
  rng,
  teamWorld,
  viewerPages,
  windowDays,
  windowStart,
  workedPages,
  type DemoShift,
} from "./team-world.ts";

/** Demo answers of the «Команда» screens (see demo/core.ts); the team's life is simulated in team-world.ts. */

const FORBIDDEN = () => demoError(403, "Forbidden", "Этот раздел — для владельца и тимлидов.");

function daysParam(request: DemoRequest, fallback: number, max: number): number | null {
  const days = queryNumber(request, "days", fallback);
  return Number.isInteger(days) && days >= 1 && days <= max ? days : null;
}

function badDays(max: number) {
  return demoError(400, "Bad Request", `days — целое число от 1 до ${max}.`);
}

/** Shifts that touch the viewer's pages. */
function scopedShifts(shifts: readonly DemoShift[], scope: readonly string[]): DemoShift[] {
  return shifts.filter((shift) => shift.pages.some((page) => page.messages > 0 && scope.includes(page.pageLabel)));
}

// --- Authorship ---

type AuthorshipPage = KernelOperationResponse<"teamAuthorship">["pages"][number];

function authorshipOf(request: DemoRequest, scope: readonly string[], days: number): AuthorshipPage[] {
  const now = request.now;
  const shifts = teamWorld(now).shifts;
  const dayList = windowDays(now, days);
  const pages: AuthorshipPage[] = [];
  for (const page of DEMO_DATA_PAGES) {
    if (!scope.includes(page.label)) continue;
    const onPage = shifts.filter((shift) => shift.pages.some((item) => item.pageLabel === page.label && item.messages > 0));
    const authors = new Map<number, { userId: number; username: string; messages: number }>();
    const rows: AuthorshipPage["days"] = [];
    for (const day of dayList) {
      const random = rng(`authorship:${page.label}:${day}`);
      let authored = 0;
      for (const shift of onPage) {
        const count = messagesOnDay(shift, page.label, day);
        if (count === 0) continue;
        authored += count;
        const author = authors.get(shift.user.id) ?? { userId: shift.user.id, username: shift.user.username, messages: 0 };
        author.messages += count;
        authors.set(shift.user.id, author);
      }
      // Today is still going: only the part of it that has passed.
      const dayShare = day === mskDay(now.getTime()) ? clamp((now.getTime() - mskMidnight(day)) / DAY, 0.05, 1) : 1;
      // Nobody in the extension that day: a few messages from the model's phone (ivy-1 lives on the phone).
      const phone = authored === 0
        ? Math.round(intBetween(random, onPage.length === 0 ? 10 : 2, onPage.length === 0 ? 32 : 14) * dayShare)
        : Math.round(authored * between(random, 0.03, 0.1) + intBetween(random, 0, 6) * dayShare);
      const leakRate = page.label === "mia-3" ? between(random, 0.03, 0.09) : between(random, 0.004, 0.03);
      const inShiftWithout = authored === 0 ? 0 : Math.round(authored * leakRate);
      const personal = authored + phone;
      if (personal === 0) continue;
      rows.push({ day, personal, authored, inShift: authored + inShiftWithout, inShiftAuthored: authored });
    }
    if (rows.length === 0) continue;
    const total = rows.reduce((sum, row) => ({
      personal: sum.personal + row.personal,
      authored: sum.authored + row.authored,
      inShift: sum.inShift + row.inShift,
      inShiftAuthored: sum.inShiftAuthored + row.inShiftAuthored,
    }), { personal: 0, authored: 0, inShift: 0, inShiftAuthored: 0 });
    pages.push({
      pageLabel: page.label,
      platform: page.platform,
      total,
      days: rows,
      authors: [...authors.values()].filter((author) => author.messages > 0).sort((left, right) => right.messages - left.messages),
    });
  }
  return pages;
}

// --- Empty hours ---

/** How likely fans write to a page in an hour, by Moscow hour: the audience is mostly American. */
function fanHourWeight(hour: number): number {
  if (hour >= 2 && hour <= 8) return 1;
  if (hour >= 9 && hour <= 13) return 0.55;
  if (hour >= 14 && hour <= 18) return 0.72;
  return 0.9;
}

const FAN_HOUR_BASE: Readonly<Record<string, number>> = {
  "mia-1": 0.93, "mia-2": 0.86, "mia-3": 0.72, "mia-of": 0.9, "mia-vip-of": 0.82, "nova-1": 0.96, "ivy-1": 0.28, "ivy-2": 0.46,
};

function emptyHoursOf(request: DemoRequest, scope: readonly string[], days: number): KernelOperationResponse<"teamEmptyHours">["pages"] {
  const now = request.now.getTime();
  const world = teamWorld(request.now);
  const from = windowStart(request.now, days);
  const result: KernelOperationResponse<"teamEmptyHours">["pages"] = [];
  for (const page of DEMO_DATA_PAGES) {
    if (!scope.includes(page.label)) continue;
    const onPage = world.shifts.filter((shift) => shift.pages.some((item) => item.pageLabel === page.label && item.messages > 0));
    const firstMinute = onPage.reduce((min, shift) => Math.min(min, shift.startedAt), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(firstMinute)) {
      result.push({ pageLabel: page.label, platform: page.platform, shiftsSince: null, hoursWithFans: 0, emptyHours: 0, emptyByHour: Array.from({ length: 24 }, () => 0), fans: 0, payers: 0, waitedOverHour: 0, waitedNetMills: 0 });
      continue;
    }
    const start = Math.ceil(Math.max(from, firstMinute) / HOUR) * HOUR;
    const end = now;
    const byHour = Array.from({ length: 24 }, () => 0);
    let hoursWithFans = 0;
    let emptyHours = 0;
    for (let hour = start; hour + HOUR <= end; hour += HOUR) {
      const random = rng(`fanhour:${page.label}:${hour}`);
      if (random() > (FAN_HOUR_BASE[page.label] ?? 0.5) * fanHourWeight(mskHour(hour))) continue;
      hoursWithFans += 1;
      const covered = onPage.some((shift) => shift.startedAt < hour + HOUR && shift.endedAt > hour);
      if (covered) continue;
      emptyHours += 1;
      byHour[mskHour(hour)]! += 1;
    }
    const random = rng(`empty:${page.label}:${days}:${mskDay(now)}`);
    const fans = Math.round(emptyHours * between(random, 1.2, page.dailyNet > 100 ? 2.2 : 1.4));
    const payers = Math.round(fans * between(random, 0.22, 0.36));
    const waitedOverHour = Math.round(fans * between(random, 0.38, 0.62));
    const spenders = demoFans(page.label).filter((fan) => fan.spent30d > 0);
    let waitedNet = 0;
    for (let index = 0; index < Math.round(Math.min(payers, waitedOverHour) * 0.6); index += 1) {
      waitedNet += spenders[Math.floor(random() ** 1.6 * spenders.length)]?.spent30d ?? 0;
    }
    result.push({
      pageLabel: page.label,
      platform: page.platform,
      shiftsSince: isoAt(firstMinute),
      hoursWithFans,
      emptyHours,
      emptyByHour: byHour,
      fans,
      payers,
      waitedOverHour,
      waitedNetMills: Math.round(waitedNet * 1000),
    });
  }
  return result;
}

// --- Sales: PPVs and replies ---

function salesWindow(request: DemoRequest, days: number, scope: readonly string[]) {
  const from = windowStart(request.now, days);
  const shifts = scopedShifts(teamWorld(request.now).shifts, scope).filter((shift) => shift.startedAt >= from);
  return { from, shifts };
}

/** A shift's PPVs sent on one page, by its messages there. */
function ppvOnPage(shift: DemoShift, label: string): number {
  const page = shift.pages.find((item) => item.pageLabel === label);
  if (!page || shift.messages === 0) return 0;
  return Math.round((shift.ppvSent * page.messages) / shift.messages);
}

function totalOf(cells: ReadonlyArray<{ sent: number; bought: number; netMills: number }>) {
  return cells.reduce((sum, cell) => ({ sent: sum.sent + cell.sent, bought: sum.bought + cell.bought, netMills: sum.netMills + cell.netMills }), { sent: 0, bought: 0, netMills: 0 });
}

function salesPpv(request: DemoRequest, scope: readonly string[], days: number): KernelOperationResponse<"teamSalesPpv"> {
  const { from, shifts } = salesWindow(request, days, scope);
  const pages: KernelOperationResponse<"teamSalesPpv">["pages"] = [];
  for (const page of DEMO_DATA_PAGES) {
    if (!scope.includes(page.label)) continue;
    const onPage = shifts.filter((shift) => workedPages(shift).includes(page.label));
    const authoredSent = onPage.reduce((sum, shift) => sum + ppvOnPage(shift, page.label), 0);
    const sales = onPage.flatMap((shift) => shift.sales.filter((sale) => sale.pageLabel === page.label));
    const random = rng(`ppv-page:${page.label}:${days}`);
    let withoutAuthor = Math.round(authoredSent * between(random, 0.06, 0.14));
    if (onPage.length === 0) {
      // Nobody works the page in the extension: every PPV went out from a phone.
      const liveDays = days;
      withoutAuthor = page.dailyNet < 20 ? Math.round(liveDays * between(random, 0.3, 0.7)) : 0;
    }
    if (authoredSent + withoutAuthor === 0) continue;
    const byPrice = ppvCells(authoredSent + withoutAuthor, sales, `${page.label}:${days}`);
    if (onPage.length === 0 && random() < 0.6 && byPrice[1]) {
      byPrice[1].bought += 1;
      byPrice[1].netMills += 11_992;
      byPrice[1].sent = Math.max(byPrice[1].sent, 2);
    }
    const chats = Math.max(1, Math.round((authoredSent + withoutAuthor) * between(random, 0.12, 0.2)));
    const firstPpv = byPrice.map((cell, index) => {
      const sent = Math.round(chats * [0.3, 0.45, 0.18, 0.06, 0.01][index]!);
      const rate = [0.52, 0.38, 0.27, 0.16, 0.1][index]! * pageBuyFactor(page.label);
      const bought = Math.min(sent, Math.round(sent * rate * between(random, 0.8, 1.2)));
      const average = cell.bought > 0 ? cell.netMills / cell.bought : [7_992, 15_992, 27_992, 59_992, 119_992][index]!;
      return { bucket: cell.bucket, sent, bought, netMills: Math.round(bought * average) };
    });
    pages.push({ pageLabel: page.label, platform: page.platform, total: totalOf(byPrice), byPrice, firstPpv, withoutAuthor });
  }
  const chatters = DEMO_CHATTERS.map((user) => {
    const own = shifts.filter((shift) => shift.user.id === user.id);
    const sent = own.reduce((sum, shift) => sum + workedPages(shift).filter((label) => scope.includes(label)).reduce((inner, label) => inner + ppvOnPage(shift, label), 0), 0);
    const sales = own.flatMap((shift) => shift.sales.filter((sale) => scope.includes(sale.pageLabel)));
    const byPrice = ppvCells(sent, sales, `chatter:${user.username}:${days}`);
    return { userId: user.id, username: user.username, total: totalOf(byPrice), byPrice };
  }).filter((chatter) => chatter.total.sent > 0).sort((left, right) => right.total.netMills - left.total.netMills);
  return { from: isoAt(from), to: request.now.toISOString(), pages, chatters, serverNow: request.now.toISOString() };
}

type ReplyCells = ReturnType<typeof replyCells>;

function sumReplyCells(tables: readonly ReplyCells[]): ReplyCells {
  const template = tables[0] ?? replyCells(0, 300, 1, "empty");
  return template.map((cell, index) => ({
    bucket: cell.bucket,
    replies: tables.reduce((sum, table) => sum + (table[index]?.replies ?? 0), 0),
    bought: tables.reduce((sum, table) => sum + (table[index]?.bought ?? 0), 0),
  }));
}

function replyTotal(cells: ReplyCells) {
  return cells.reduce((sum, cell) => ({ replies: sum.replies + cell.replies, bought: sum.bought + cell.bought }), { replies: 0, bought: 0 });
}

function salesReplies(request: DemoRequest, scope: readonly string[], days: number): KernelOperationResponse<"teamSalesReplies"> {
  const to = request.now.getTime() - DAY;
  const { from, shifts } = salesWindow(request, days, scope);
  const settled = shifts.filter((shift) => shift.endedAt <= to);
  const pages: KernelOperationResponse<"teamSalesReplies">["pages"] = [];
  for (const page of DEMO_DATA_PAGES) {
    if (!scope.includes(page.label)) continue;
    const tables = settled.flatMap((shift) => {
      const onPage = shift.pages.find((item) => item.pageLabel === page.label);
      if (!onPage || onPage.messages === 0) return [];
      const replies = Math.round((shift.replies * onPage.messages) / shift.messages);
      return [replyCells(replies, shift.speed, pageBuyFactor(page.label), `${shift.user.username}:${shift.startedAt}:${page.label}`)];
    });
    // Replies with no author: from a phone, slower.
    const random = rng(`replies-phone:${page.label}:${days}`);
    const authored = tables.reduce((sum, table) => sum + replyTotal(table).replies, 0);
    const liveDays = days - 1;
    const phone = authored > 0 ? Math.round(authored * between(random, 0.05, 0.12)) : Math.round(liveDays * (page.dailyNet < 20 ? between(random, 3, 7) : 0));
    if (phone > 0) tables.push(replyCells(phone, 1800, pageBuyFactor(page.label), `phone:${page.label}:${days}`));
    if (tables.length === 0) continue;
    const byDelay = sumReplyCells(tables);
    const total = replyTotal(byDelay);
    if (total.replies === 0) continue;
    pages.push({ pageLabel: page.label, platform: page.platform, total, byDelay });
  }
  const chatters = DEMO_CHATTERS.map((user) => {
    const tables = settled.filter((shift) => shift.user.id === user.id).flatMap((shift) => shift.pages
      .filter((item) => item.messages > 0 && scope.includes(item.pageLabel))
      .map((item) => replyCells(Math.round((shift.replies * item.messages) / shift.messages), shift.speed, pageBuyFactor(item.pageLabel), `${shift.user.username}:${shift.startedAt}:${item.pageLabel}`)));
    const byDelay = sumReplyCells(tables);
    return { userId: user.id, username: user.username, total: replyTotal(byDelay), byDelay };
  }).filter((chatter) => chatter.total.replies > 0).sort((left, right) => right.total.replies - left.total.replies);
  return { from: isoAt(from), to: isoAt(to), pages, chatters, serverNow: request.now.toISOString() };
}

// --- The eight numbers ---

type Numbers = KernelOperationResponse<"teamChatterNumbers">["chatters"][number]["shifts"][number]["numbers"];

/**
 * A shift's numbers. The three of its quality — the reply median, the fans left
 * without an answer at the end, the AI's texts sent unedited — are its review's
 * (team-review.ts, by the review's rules), so one shift shows one set of
 * numbers on every screen (spec §3 r2): `textMessages` and `aiUnedited` are
 * the review's, as Hub counts them. `composed` is the buttons: `reply` — the
 * AI's texts sent as they were (in the demo the Reply button's texts are
 * exactly the unedited ones), `fix` — the chatter's drafts the AI fixed,
 * `hand` — the other texts, `other` — the rest of the shift's messages (Hi
 * greetings, messages without words).
 */
function numbersOf(shift: DemoShift, disputed: ReadonlySet<string>, now: Date): { numbers: Numbers; quality: ShiftQuality } {
  const review = shiftReviewNumbers(shift, now.getTime());
  const { quality } = review;
  const pages = workedPages(shift);
  const sales = shift.sales.filter((sale) => pages.includes(sale.pageLabel));
  const credited = shift.confirmedAt === null ? null : sales.filter((sale) => !disputed.has(sale.ref)).reduce((sum, sale) => sum + creditedOf(sale), 0);
  const numbers: Numbers = {
    workedMinutes: shift.workedMinutes,
    revenueMills: credited,
    revenuePerHourMills: credited === null ? null : Math.round(credited / (shift.workedMinutes / 60)),
    fansWritten: shift.fansWritten,
    fansPaid: Math.min(shift.fansWritten, new Set(sales.map((sale) => sale.fan.platformUserId)).size),
    messages: shift.messages,
    ppvSent: shift.ppvSent,
    ppvBought: sales.filter((sale) => sale.kind === "ppv").length,
    ppvAveragePriceMills: shift.ppvSent > 0 ? shift.ppvAveragePriceMills : null,
    ppvShare: shift.messages > 0 ? shift.ppvSent / shift.messages : null,
    replies: review.replies,
    replyMedianSeconds: quality.replyMedianSeconds,
    repliesWithinHour: review.repliesWithinHour,
    waitingAtEnd: quality.unansweredAtEnd,
    composed: {
      hand: review.textMessages - review.aiUnedited - review.fix,
      reply: review.aiUnedited,
      fix: review.fix,
      // The parts add up to the shift's messages, as Hub's do.
      other: Math.max(0, shift.messages - review.textMessages),
    },
    textMessages: review.textMessages,
    aiUnedited: review.aiUnedited,
  };
  return { numbers, quality };
}

function weekOf(rows: ReadonlyArray<{ numbers: Numbers; confirmed: boolean; quality: ShiftQuality }>) {
  const sum = (take: (numbers: Numbers) => number) => rows.reduce((total, row) => total + take(row.numbers), 0);
  const confirmed = rows.filter((row) => row.confirmed);
  const revenue = confirmed.length === 0 ? null : confirmed.reduce((total, row) => total + (row.numbers.revenueMills ?? 0), 0);
  const confirmedMinutes = confirmed.reduce((total, row) => total + row.numbers.workedMinutes, 0);
  const messages = sum((numbers) => numbers.messages);
  const ppvSent = sum((numbers) => numbers.ppvSent);
  // «…, в среднем за смену»: the plain average of the shifts' own numbers (the screens average the same way).
  const average = averageQuality(rows.map((row) => row.quality));
  return {
    workedMinutes: sum((numbers) => numbers.workedMinutes),
    revenueMills: revenue,
    revenuePerHourMills: revenue === null || confirmedMinutes === 0 ? null : Math.round(revenue / (confirmedMinutes / 60)),
    fansWritten: sum((numbers) => numbers.fansWritten),
    fansPaid: sum((numbers) => numbers.fansPaid),
    messages,
    ppvSent,
    ppvBought: sum((numbers) => numbers.ppvBought),
    ppvAveragePriceMills: ppvSent === 0 ? null : Math.round(sum((numbers) => (numbers.ppvAveragePriceMills ?? 0) * numbers.ppvSent) / ppvSent / 10) * 10,
    ppvShare: messages === 0 ? null : ppvSent / messages,
    replies: sum((numbers) => numbers.replies),
    replyMedianSeconds: average.replyMedianSeconds,
    repliesWithinHour: sum((numbers) => numbers.repliesWithinHour),
    waitingAtEnd: Math.round(average.unansweredAtEnd ?? 0),
    composed: {
      hand: sum((numbers) => numbers.composed.hand),
      reply: sum((numbers) => numbers.composed.reply),
      fix: sum((numbers) => numbers.composed.fix),
      other: sum((numbers) => numbers.composed.other),
    },
    textMessages: sum((numbers) => numbers.textMessages),
    aiUnedited: sum((numbers) => numbers.aiUnedited),
    shifts: rows.length,
    unconfirmedShifts: rows.filter((row) => !row.confirmed).length,
  };
}

function parseInstant(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}


const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const teamHandlers: DemoHandlers = {
  teamShiftReview,
  teamShifts: (request) => {
    const scope = viewerPages(request);
    if (!scope) return FORBIDDEN();
    const pageLabel = queryString(request, "pageLabel");
    if (pageLabel !== undefined) {
      if (!demoPage(pageLabel)) return demoError(404, "Not Found", `Страницы «${pageLabel}» нет.`);
      if (!scope.includes(pageLabel)) return demoError(403, "Forbidden", `Страница «${pageLabel}» вам не назначена.`);
    }
    const toParsed = parseInstant(queryString(request, "to"));
    const fromParsed = parseInstant(queryString(request, "from"));
    if (toParsed === null || fromParsed === null) return demoError(400, "Bad Request", "from и to — время в формате RFC 3339.");
    const to = toParsed ?? request.now.getTime();
    const from = fromParsed ?? to - DAY;
    if (from >= to || to - from > 7 * DAY + MIN) return demoError(400, "Bad Request", "Окно — не больше 7 дней.");
    const labels = pageLabel === undefined ? scope : [pageLabel];
    const shifts = scopedShifts(teamWorld(request.now).shifts, labels)
      .filter((shift) => shift.startedAt < to && shift.endedAt > from)
      .map((shift) => {
        // A shift that touched the window comes whole, as the server sends it.
        const pages = shift.pages
          .filter((page) => labels.includes(page.pageLabel))
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
        };
      });
    return { from: isoAt(from), to: isoAt(to), shifts, serverNow: request.now.toISOString() };
  },

  teamShiftSales: (request) => {
    const scope = viewerPages(request);
    if (!scope) return FORBIDDEN();
    const pageLabel = queryString(request, "pageLabel");
    if (pageLabel !== undefined) {
      if (!demoPage(pageLabel)) return demoError(404, "Not Found", `Страницы «${pageLabel}» нет.`);
      if (!scope.includes(pageLabel)) return demoError(403, "Forbidden", `Страница «${pageLabel}» вам не назначена.`);
    }
    const days = daysParam(request, 7, 31);
    if (days === null) return badDays(31);
    const until = queryString(request, "until");
    if (until !== undefined && !BUSINESS_DATE.test(until)) return demoError(400, "Bad Request", "until — день в формате YYYY-MM-DD.");
    return teamShiftSales(request, pageLabel === undefined ? scope : [pageLabel], days, until);
  },

  teamAuthorship: (request) => {
    const scope = viewerPages(request);
    if (!scope) return FORBIDDEN();
    const days = daysParam(request, 7, 7);
    if (days === null) return badDays(7);
    return { from: isoAt(windowStart(request.now, days)), to: request.now.toISOString(), pages: authorshipOf(request, scope, days), serverNow: request.now.toISOString() };
  },

  teamEmptyHours: (request) => {
    const scope = viewerPages(request);
    if (!scope) return FORBIDDEN();
    const days = daysParam(request, 7, 31);
    if (days === null) return badDays(31);
    return { from: isoAt(windowStart(request.now, days)), to: request.now.toISOString(), pages: emptyHoursOf(request, scope, days), serverNow: request.now.toISOString() };
  },

  teamGreetings: (request) => {
    const scope = viewerPages(request);
    if (!scope) return FORBIDDEN();
    const days = daysParam(request, 7, 31);
    if (days === null) return badDays(31);
    return teamGreetings(request, scope, days);
  },

  teamSalesPpv: (request) => {
    const scope = viewerPages(request);
    if (!scope) return FORBIDDEN();
    const days = daysParam(request, 30, 31);
    if (days === null) return badDays(31);
    return salesPpv(request, scope, days);
  },

  teamSalesReplies: (request) => {
    const scope = viewerPages(request);
    if (!scope) return FORBIDDEN();
    const days = daysParam(request, 30, 31);
    if (days === null) return badDays(31);
    return salesReplies(request, scope, days);
  },

  teamChatterNumbers: (request) => {
    const scope = viewerPages(request);
    if (!scope) return FORBIDDEN();
    const toParsed = parseInstant(queryString(request, "to"));
    const fromParsed = parseInstant(queryString(request, "from"));
    if (toParsed === null || fromParsed === null) return demoError(400, "Bad Request", "from и to — время в формате RFC 3339.");
    const to = toParsed ?? request.now.getTime();
    const from = fromParsed ?? to - 7 * DAY;
    if (from >= to || to - from > 31 * DAY) return demoError(400, "Bad Request", "Окно — не больше 31 дня.");
    const disputed = new Set(teamDisputes(request.now).filter((dispute) => dispute.resolution === null).map((dispute) => dispute.sale.ref));
    // As Hub (services/chatter-numbers.ts): a shift is the window's when the middle of its work falls inside.
    const middleOfWork = (shift: DemoShift) => Math.floor((shift.startedAt + shift.endedAt - 1) / 2);
    const shifts = scopedShifts(teamWorld(request.now).shifts, scope).filter((shift) => middleOfWork(shift) >= from && middleOfWork(shift) < to);
    const onlyUser = queryNumber(request, "userId", Number.NaN);
    const chatters = DEMO_CHATTERS.filter((user) => Number.isNaN(onlyUser) || user.id === onlyUser).map((user) => {
      const rows = shifts.filter((shift) => shift.user.id === user.id).map((shift) => {
        const { numbers, quality } = numbersOf(shift, disputed, request.now);
        return {
          row: {
            startedAt: isoAt(shift.startedAt),
            endedAt: isoAt(shift.endedAt),
            ongoing: shift.ongoing,
            pages: workedPages(shift),
            confirmed: shift.confirmedAt !== null,
            numbers,
          },
          quality,
        };
      });
      return {
        userId: user.id,
        username: user.username,
        week: weekOf(rows.map(({ row, quality }) => ({ numbers: row.numbers, confirmed: row.confirmed, quality }))),
        shifts: rows.map(({ row }) => row),
      };
    }).filter((chatter) => chatter.shifts.length > 0)
      .sort((left, right) => right.week.messages - left.week.messages);
    return { from: isoAt(from), to: isoAt(to), chatters, serverNow: request.now.toISOString() };
  },

  teamChatterStats: (request) => {
    const scope = viewerPages(request);
    if (!scope) return FORBIDDEN();
    const days = daysParam(request, 7, 31);
    if (days === null) return badDays(31);
    const userId = queryNumber(request, "userId", Number.NaN);
    return teamChatterStats(request, scope, days, Number.isInteger(userId) && userId > 0 ? userId : undefined);
  },

  adminModelApplications,
  adminModelApplication,

  teamWinBackApproaches: (request) => {
    if (request.role !== "owner") return demoError(403, "Forbidden", "Подходы меняет только владелец.");
    return teamWinBackApproaches();
  },

  teamWinBackResults: (request) => {
    const scope = viewerPages(request);
    if (!scope) return FORBIDDEN();
    const days = daysParam(request, 30, 90);
    if (days === null) return badDays(90);
    return teamWinBackResults(request, scope, days);
  },
};
