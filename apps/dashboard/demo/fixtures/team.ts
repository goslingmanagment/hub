import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { demoError, queryNumber, queryString, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DEMO_CHATTERS, DEMO_DATA_PAGES, DEMO_PAGES, DEMO_USERS, demoFans, demoPage, type DemoUser } from "../world.ts";
import { teamCustoms, teamGreetings, teamWinBackApproaches, teamWinBackResults } from "./team-extra.ts";
import { adminModelApplication, adminModelApplications } from "./team-applications.ts";
import { teamChatterStats, teamShiftSales } from "./team-stats.ts";
import {
  DAY,
  HOUR,
  MIN,
  addDays,
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
  workingAt,
  windowDays,
  windowStart,
  workedPages,
  type DemoSale,
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

// --- Disputes: sales on shared pages where two chatters' marks do not agree ---

export interface DemoDispute {
  sale: DemoSale;
  shift: DemoShift;
  reason: "two_mine" | "share_not_agreed" | "conflicting";
  other: DemoUser;
  /** The owner's split, or null. */
  resolution: Array<{ user: DemoUser; percent: number }> | null;
  resolvedAt: number | null;
}

export function teamDisputes(now: Date): DemoDispute[] {
  const disputes: DemoDispute[] = [];
  for (const shift of teamWorld(now).shifts) {
    if (shift.confirmedAt === null) continue;
    for (const sale of shift.sales) {
      const others = DEMO_CHATTERS.filter((user) => user.id !== shift.user.id && user.pages.includes(sale.pageLabel) && workingAt(user, sale.at, now));
      if (others.length === 0 || sale.netMills < 12_000) continue;
      const random = rng(`dispute:${sale.ref}`);
      if (random() > 0.03) continue;
      const together = others.find((user) => shift.together.includes(user.username));
      const other = together ?? others[Math.floor(random() * others.length)]!;
      const roll = random();
      const reason = roll < 0.55 ? "two_mine" : roll < 0.85 ? "share_not_agreed" : "conflicting";
      const age = now.getTime() - sale.at;
      const resolved = age > 4 * DAY && random() < 0.7;
      const resolution = !resolved
        ? null
        : random() < 0.5
          ? [{ user: shift.user, percent: 50 }, { user: other, percent: 50 }]
          : random() < 0.7
            ? [{ user: shift.user, percent: 100 }]
            : [{ user: shift.user, percent: 70 }, { user: other, percent: 30 }];
      disputes.push({ sale, shift, reason, other, resolution, resolvedAt: resolved ? sale.at + Math.round(between(random, 1.6, 3.5) * DAY) : null });
    }
  }
  // Calm, as on production: one dispute waits for the owner, the newest; the others were settled.
  const newestOpen = disputes.filter((dispute) => dispute.resolution === null).sort((left, right) => right.sale.at - left.sale.at)[0];
  for (const dispute of disputes) {
    if (dispute.resolution !== null || dispute === newestOpen) continue;
    dispute.resolution = [{ user: dispute.shift.user, percent: 50 }, { user: dispute.other, percent: 50 }];
    dispute.resolvedAt = Math.min(now.getTime() - HOUR, dispute.sale.at + DAY);
  }
  return disputes;
}

function disputeMarks(dispute: DemoDispute) {
  const { shift, other, reason, sale } = dispute;
  const mine = { userId: shift.user.id, username: shift.user.username, mark: "mine", shareWithUserId: null, shareWith: null, amountMills: null };
  if (reason === "two_mine") {
    return [mine, { userId: other.id, username: other.username, mark: "mine", shareWithUserId: null, shareWith: null, amountMills: null }];
  }
  if (reason === "share_not_agreed") {
    return [{ userId: shift.user.id, username: shift.user.username, mark: "share", shareWithUserId: other.id, shareWith: other.username, amountMills: null }];
  }
  return [
    { ...mine, amountMills: Math.round((sale.netMills * 0.6) / 1000) * 1000 },
    { userId: other.id, username: other.username, mark: "share", shareWithUserId: shift.user.id, shareWith: shift.user.username, amountMills: null },
  ];
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

function numbersOf(shift: DemoShift, disputed: ReadonlySet<string>): Numbers {
  const pages = workedPages(shift);
  const sales = shift.sales.filter((sale) => pages.includes(sale.pageLabel));
  const credited = shift.confirmedAt === null ? null : sales.filter((sale) => !disputed.has(sale.ref)).reduce((sum, sale) => sum + creditedOf(sale), 0);
  return {
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
    replies: shift.replies,
    replyMedianSeconds: shift.replies > 0 ? shift.replyMedianSeconds : null,
    repliesWithinHour: shift.repliesWithinHour,
    waitingAtEnd: shift.waitingAtEnd,
    composed: { hand: shift.composed.hand, reply: shift.composed.reply, fix: shift.composed.fix, other: shift.composed.greet + shift.composed.other },
  };
}

function weekOf(rows: ReadonlyArray<{ numbers: Numbers; confirmed: boolean }>) {
  const sum = (take: (numbers: Numbers) => number) => rows.reduce((total, row) => total + take(row.numbers), 0);
  const confirmed = rows.filter((row) => row.confirmed);
  const revenue = confirmed.length === 0 ? null : confirmed.reduce((total, row) => total + (row.numbers.revenueMills ?? 0), 0);
  const confirmedMinutes = confirmed.reduce((total, row) => total + row.numbers.workedMinutes, 0);
  const messages = sum((numbers) => numbers.messages);
  const ppvSent = sum((numbers) => numbers.ppvSent);
  const medians = rows.filter((row) => row.numbers.replyMedianSeconds !== null).map((row) => row.numbers.replyMedianSeconds!).sort((left, right) => left - right);
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
    replyMedianSeconds: medians.length === 0 ? null : medians[Math.floor(medians.length / 2)]!,
    repliesWithinHour: sum((numbers) => numbers.repliesWithinHour),
    waitingAtEnd: rows.length === 0 ? 0 : Math.round(sum((numbers) => numbers.waitingAtEnd) / rows.length),
    composed: {
      hand: sum((numbers) => numbers.composed.hand),
      reply: sum((numbers) => numbers.composed.reply),
      fix: sum((numbers) => numbers.composed.fix),
      other: sum((numbers) => numbers.composed.other),
    },
    shifts: rows.length,
    unconfirmedShifts: rows.filter((row) => !row.confirmed).length,
  };
}

function parseInstant(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

// --- Export ---

function exportOf(request: DemoRequest, scope: readonly string[], fromDay: string, toDay: string): KernelOperationResponse<"teamShiftExport"> {
  const now = request.now;
  const world = teamWorld(now);
  const disputes = teamDisputes(now);
  const disputeByRef = new Map(disputes.map((dispute) => [dispute.sale.ref, dispute]));
  const inWindow = (day: string) => day >= fromDay && day <= toDay;
  const cells = new Map<string, { username: string; pageLabel: string; platform: string; shiftDate: string; creditedMills: number }>();
  const credit = (user: DemoUser, sale: DemoSale, day: string, amount: number) => {
    if (amount <= 0) return;
    const key = `${user.username}\u0000${sale.pageLabel}\u0000${day}`;
    const cell = cells.get(key) ?? { username: user.username, pageLabel: sale.pageLabel, platform: sale.platform, shiftDate: day, creditedMills: 0 };
    cell.creditedMills += sale.platform === "onlyfans" ? Math.round(amount / 1000) * 1000 : amount;
    cells.set(key, cell);
  };
  const ownAmounts: KernelOperationResponse<"teamShiftExport">["ownAmounts"] = [];
  const unconfirmed: KernelOperationResponse<"teamShiftExport">["unconfirmed"] = [];
  let disputedOpen = 0;
  for (const shift of scopedShifts(world.shifts, scope)) {
    const day = mskDay(shift.startedAt);
    if (!inWindow(day)) continue;
    if (shift.confirmedAt === null) {
      unconfirmed.push({ username: shift.user.username, startedAt: isoAt(shift.startedAt), endedAt: isoAt(shift.endedAt), ongoing: shift.ongoing });
      continue;
    }
    const pages = workedPages(shift);
    for (const sale of shift.sales) {
      if (!pages.includes(sale.pageLabel) || !scope.includes(sale.pageLabel)) continue;
      const dispute = disputeByRef.get(sale.ref);
      if (dispute) {
        if (dispute.resolution === null) {
          disputedOpen += 1;
          continue;
        }
        for (const share of dispute.resolution) credit(share.user, sale, day, Math.round((sale.netMills * share.percent) / 100));
        continue;
      }
      credit(shift.user, sale, day, creditedOf(sale));
      if (sale.mark === "share" && sale.shareWith) credit(sale.shareWith, sale, day, Math.round(sale.netMills / 2));
      if (sale.ownAmountMills !== null) {
        ownAmounts.push({ username: shift.user.username, pageLabel: sale.pageLabel, saleRef: sale.ref, occurredAt: isoAt(sale.at), netMills: sale.netMills, amountMills: sale.ownAmountMills });
      }
    }
  }
  const lateChanges: KernelOperationResponse<"teamShiftExport">["lateChanges"] = [];
  for (const dispute of disputes) {
    const payDay = mskDay(dispute.shift.startedAt);
    if (!inWindow(payDay) || dispute.resolution === null || dispute.resolvedAt === null || !scope.includes(dispute.sale.pageLabel)) continue;
    if (dispute.resolvedAt < mskMidnight(addDays(payDay, 2))) continue;
    for (const share of dispute.resolution) {
      lateChanges.push({
        username: share.user.username,
        pageLabel: dispute.sale.pageLabel,
        saleRef: dispute.sale.ref,
        occurredAt: isoAt(dispute.sale.at),
        payDay,
        creditedMills: Math.round((dispute.sale.netMills * share.percent) / 100),
        change: "added",
        at: isoAt(dispute.resolvedAt),
      });
    }
  }
  const order = new Map(DEMO_USERS.map((user, index) => [user.username, index]));
  const pageOrder = new Map(DEMO_PAGES.map((page, index) => [page.label, index]));
  const rows = [...cells.values()].sort((left, right) => (order.get(left.username)! - order.get(right.username)!)
    || (pageOrder.get(left.pageLabel)! - pageOrder.get(right.pageLabel)!)
    || left.shiftDate.localeCompare(right.shiftDate));
  return {
    from: fromDay,
    to: toDay,
    rows,
    disputedOpen,
    ownAmounts,
    unconfirmed: unconfirmed.sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    lateChanges,
    serverNow: now.toISOString(),
  };
}

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const teamHandlers: DemoHandlers = {
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
    const shifts = scopedShifts(teamWorld(request.now).shifts, scope).filter((shift) => shift.startedAt >= from && shift.startedAt < to);
    const onlyUser = queryNumber(request, "userId", Number.NaN);
    const chatters = DEMO_CHATTERS.filter((user) => Number.isNaN(onlyUser) || user.id === onlyUser).map((user) => {
      const rows = shifts.filter((shift) => shift.user.id === user.id).map((shift) => ({
        startedAt: isoAt(shift.startedAt),
        endedAt: isoAt(shift.endedAt),
        ongoing: shift.ongoing,
        pages: workedPages(shift),
        confirmed: shift.confirmedAt !== null,
        numbers: numbersOf(shift, disputed),
      }));
      return { userId: user.id, username: user.username, week: weekOf(rows), shifts: rows };
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

  teamShiftDisputes: (request) => {
    const scope = viewerPages(request);
    if (!scope) return FORBIDDEN();
    const days = daysParam(request, 14, 31);
    if (days === null) return badDays(31);
    const from = windowStart(request.now, days);
    const disputes = teamDisputes(request.now)
      .filter((dispute) => dispute.sale.at >= from && scope.includes(dispute.sale.pageLabel))
      .sort((left, right) => (left.resolution === null ? 0 : 1) - (right.resolution === null ? 0 : 1) || right.sale.at - left.sale.at)
      .map((dispute) => ({
        saleRef: dispute.sale.ref,
        pageLabel: dispute.sale.pageLabel,
        platform: dispute.sale.platform,
        fanRef: dispute.sale.fan.platformUserId,
        occurredAt: isoAt(dispute.sale.at),
        netMills: dispute.sale.netMills,
        reason: dispute.reason,
        marks: disputeMarks(dispute),
        people: [dispute.shift.user, dispute.other].map((user) => ({ userId: user.id, username: user.username })),
        resolution: dispute.resolution?.map((share) => ({ userId: share.user.id, username: share.user.username, percent: share.percent })) ?? null,
      }));
    return { disputes, serverNow: request.now.toISOString() };
  },

  teamShiftExport: (request) => {
    const scope = viewerPages(request);
    if (!scope) return FORBIDDEN();
    const from = queryString(request, "from") ?? "";
    const to = queryString(request, "to") ?? "";
    if (!BUSINESS_DATE.test(from) || !BUSINESS_DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      return demoError(400, "Bad Request", "from и to — даты YYYY-MM-DD.");
    }
    const span = (Date.parse(to) - Date.parse(from)) / DAY + 1;
    if (span < 1 || span > 31) return demoError(400, "Bad Request", "Окно — от 1 до 31 дня.");
    return exportOf(request, scope, from, to);
  },

  // The owner's split is accepted and changes nothing in the invented world.
  teamShiftResolve: (request) => {
    if (request.role !== "owner") return demoError(403, "Forbidden", "Споры решает владелец.");
    return { changed: true, serverNow: request.now.toISOString() };
  },

  adminModelApplications,
  adminModelApplication,

  teamCustoms: (request) => {
    const scope = viewerPages(request);
    if (!scope) return FORBIDDEN();
    return teamCustoms(request, scope);
  },

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
