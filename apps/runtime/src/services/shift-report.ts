import {
  SHIFT_REPORT_EXPORT_MAX_DAYS,
  SHIFT_REPORT_MAX_DAYS,
  type AccountShiftReportChangeResponse,
  type AccountShiftReportMarkBody,
  type AccountShiftReportResponse,
  type ShiftReportSale,
  type TeamShiftDisputesResponse,
  type TeamShiftExportResponse,
  type TeamShiftResolveBody,
} from "@agency_hub_core/contracts";
import {
  insertShiftReport,
  listChatterActivityMinutes,
  listConfirmedLines,
  listConfirmedReports,
  listPageWorkers,
  listSaleFacts,
  listSalesByIds,
  listSharedWithMe,
  listShiftDisputes,
  listShiftMarks,
  listShiftSales,
  upsertShiftMark,
  upsertShiftResolution,
  type ConfirmedLineRow,
  type SaleFacts,
  type ShiftDisputeRow,
  type ShiftMark,
  type ShiftMarkRow,
  type ShiftSale,
} from "@agency_hub_core/db";
import { millsPercentOf, millsRoundedTo } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireDashboardUser, requireOwner, requireSessionUser, type AuthPrincipal } from "./auth.ts";
import { shiftsOfMinutes, type ActivityMinute } from "./chatter-shifts.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";

/**
 * Chat Memory week 4 (docs/plans/2026-10-24-chat-memory/week-4.md §2): the
 * draft shift report.
 *
 * THE DRAFT (`accountShiftReport`, the chatter's cabinet). The caller's actual
 * shifts (week 1); a shift's sales are the money fans paid on the pages the
 * caller was active on during it (net, as the payout sheet counts). Each sale
 * carries its facts: who sent the PPV it bought, who else wrote to the fan in
 * 48 hours. Two shifts that overlap (ari-1, 00:00–02:00) both show the sale;
 * each chatter marks it.
 *
 * THE MARKS AND THE CONFIRMATION. «моё» credits the net (or the chatter's own
 * amount), «делим с X» the owner's share of it, «не моё» nothing. A confirmed
 * report keeps its lines as they stood. Hub credits no sale by itself
 * (roadmap: «Hub shows facts; it decides nothing about money»).
 *
 * DISPUTES AND THE EXPORT. Two «моё», or «делим с X» X did not answer with
 * «делим» back, is a dispute the owner splits. The export counts confirmed
 * lines, a decided dispute by the owner's split, and leaves an open dispute out.
 */

const DAY_MS = 86_400_000;

/** What a mark credits of a sale. Pure. */
export function creditOf(input: { mark: ShiftMark; netMills: number; amountMills: number | null; sharePercent: number }): number {
  const base = input.amountMills ?? input.netMills;
  if (input.mark === "mine") return base;
  if (input.mark === "share") return Number(millsPercentOf(base, input.sharePercent));
  return 0;
}

/** A payout-sheet cell: Fansly to the cent, OnlyFans whole dollars. Pure. */
export function payoutCellOf(platform: string, mills: number): number {
  return Number(millsRoundedTo(mills, platform === "onlyfans" ? "dollar" : "cent"));
}

interface CallerShift {
  startedAt: Date;
  endedAt: Date;
  ongoing: boolean;
  pageIds: number[];
  pageLabels: string[];
}

async function callerShifts(app: AppContext, userId: number, days: number, now: Date): Promise<CallerShift[]> {
  // A day more than asked, so a shift that began before the window is whole.
  const minutes = await listChatterActivityMinutes(app.db, {
    from: new Date(now.getTime() - (days + 1) * DAY_MS), to: now, pages: "all", userId,
  });
  const pageIdOf = new Map(minutes.map((minute) => [minute.pageLabel, minute.pageId]));
  const activity: ActivityMinute[] = minutes.map((minute) => ({ at: minute.minute.getTime(), pageLabel: minute.pageLabel, input: minute.input }));
  const since = now.getTime() - days * DAY_MS;
  return shiftsOfMinutes(activity, now.getTime())
    .filter((shift) => shift.endedAt > since)
    .map((shift) => {
      const labels = [...shift.pages.keys()].sort();
      return {
        startedAt: new Date(shift.startedAt),
        endedAt: new Date(shift.endedAt),
        ongoing: shift.ongoing,
        pageIds: labels.map((label) => pageIdOf.get(label)!),
        pageLabels: labels,
      };
    })
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

async function shiftSales(app: AppContext, shift: CallerShift): Promise<ShiftSale[]> {
  return listShiftSales(app.db, { pageIds: shift.pageIds, from: shift.startedAt, to: shift.endedAt });
}

function saleOf(sale: ShiftSale, facts: SaleFacts | undefined, marks: readonly ShiftMarkRow[], userId: number): ShiftReportSale {
  const mine = marks.find((mark) => mark.transactionId === sale.transactionId && mark.userId === userId);
  return {
    saleRef: String(sale.transactionId),
    pageLabel: sale.pageLabel,
    platform: sale.platform,
    kind: sale.kind,
    fanRef: sale.fanRef,
    fanName: sale.fanName,
    netMills: sale.netMills,
    occurredAt: sale.occurredAt.toISOString(),
    ppvSender: facts?.ppvSender?.username ?? null,
    ppvWithoutAuthor: facts?.ppvWithoutAuthor ?? false,
    writers: (facts?.writers ?? []).map((writer) => ({ username: writer.username, messages: writer.messages })),
    withoutAuthor: facts?.withoutAuthor ?? 0,
    myMark: mine === undefined ? null : {
      mark: mine.mark,
      shareWithUserId: mine.shareWithUserId,
      shareWith: mine.shareWithUsername,
      amountMills: mine.amountMills,
      note: mine.note,
    },
    otherMarks: marks
      .filter((mark) => mark.transactionId === sale.transactionId && mark.userId !== userId)
      .map((mark) => ({ username: mark.username, mark: mark.mark, shareWith: mark.shareWithUsername })),
  };
}

export async function readAccountShiftReport(
  app: AppContext,
  principal: AuthPrincipal,
  input: { days: number },
): Promise<AccountShiftReportResponse> {
  requireSessionUser(principal);
  const now = new Date();
  const userId = principal.user.id;
  const sharePercent = (await loadEffectiveConfig(app.db, app.config)).shiftReportSharePercent ?? 50;
  const shifts = await callerShifts(app, userId, input.days, now);
  const salesByShift = await Promise.all(shifts.map((shift) => shiftSales(app, shift)));
  const inShifts = new Set(salesByShift.flat().map((sale) => sale.transactionId));
  const windowFrom = new Date(now.getTime() - input.days * DAY_MS);
  const sharedIds = (await listSharedWithMe(app.db, { userId, from: windowFrom, to: now })).filter((id) => !inShifts.has(id));
  const shared = await listSalesByIds(app.db, sharedIds);
  const all = [...salesByShift.flat(), ...shared];
  const ids = [...new Set(all.map((sale) => sale.transactionId))];
  const [facts, marks, confirmed] = await Promise.all([
    listSaleFacts(app.db, { transactionIds: ids }),
    listShiftMarks(app.db, { transactionIds: ids }),
    listConfirmedReports(app.db, { userId, since: new Date(windowFrom.getTime() - DAY_MS) }),
  ]);
  const factOf = new Map(facts.map((fact) => [fact.transactionId, fact]));
  const pageIds = [...new Set(shifts.flatMap((shift) => shift.pageIds).concat(shared.map((sale) => sale.pageId)))];
  const teammates = (await listPageWorkers(app.db, { pageIds, from: new Date(now.getTime() - SHIFT_REPORT_MAX_DAYS * DAY_MS), to: now }))
    .filter((worker) => worker.userId !== userId);

  return {
    sharePercent,
    shifts: shifts.map((shift, index) => {
      const sales = salesByShift[index]!;
      const report = confirmed.find((one) => one.startedAt.getTime() === shift.startedAt.getTime());
      const myMarks = sales.map((sale) => marks.find((mark) => mark.transactionId === sale.transactionId && mark.userId === userId));
      const credited = report?.creditedNetMills ?? sales.reduce((sum, sale, at) => {
        const mark = myMarks[at];
        return mark === undefined ? sum : sum + creditOf({ mark: mark.mark, netMills: sale.netMills, amountMills: mark.amountMills, sharePercent });
      }, 0);
      return {
        startedAt: shift.startedAt.toISOString(),
        endedAt: shift.endedAt.toISOString(),
        ongoing: shift.ongoing,
        pages: shift.pageLabels,
        sales: sales.map((sale) => saleOf(sale, factOf.get(sale.transactionId), marks, userId)),
        creditedMills: credited,
        unmarked: myMarks.filter((mark) => mark === undefined).length,
        confirmedAt: report === undefined ? null : report.confirmedAt.toISOString(),
      };
    }),
    sharedWithMe: shared.map((sale) => saleOf(sale, factOf.get(sale.transactionId), marks, userId)),
    teammates,
    serverNow: now.toISOString(),
  };
}

export async function markAccountShiftSale(
  app: AppContext,
  principal: AuthPrincipal,
  body: AccountShiftReportMarkBody,
): Promise<AccountShiftReportChangeResponse> {
  requireSessionUser(principal);
  const now = new Date();
  const userId = principal.user.id;
  const saleId = Number(body.saleRef);
  const shifts = await callerShifts(app, userId, SHIFT_REPORT_MAX_DAYS, now);
  let sale: ShiftSale | undefined;
  let shift: CallerShift | undefined;
  for (const candidate of shifts) {
    sale = (await shiftSales(app, candidate)).find((one) => one.transactionId === saleId);
    if (sale !== undefined) {
      shift = candidate;
      break;
    }
  }
  if (sale === undefined) {
    const shared = await listSharedWithMe(app.db, { userId, from: new Date(now.getTime() - SHIFT_REPORT_MAX_DAYS * DAY_MS), to: now });
    if (shared.includes(saleId)) sale = (await listSalesByIds(app.db, [saleId]))[0];
  }
  if (sale === undefined) throw new NotFoundError("The sale is not in your shifts");
  if (shift !== undefined) {
    const reports = await listConfirmedReports(app.db, { userId, since: new Date(shift.startedAt.getTime() - 1) });
    if (reports.some((report) => report.startedAt.getTime() === shift.startedAt.getTime())) {
      throw new ConflictError("The shift's report is confirmed", { reason: "confirmed" });
    }
  }
  let shareWith: number | null = null;
  if (body.mark === "share") {
    const workers = await listPageWorkers(app.db, { pageIds: [sale.pageId], from: new Date(now.getTime() - SHIFT_REPORT_MAX_DAYS * DAY_MS), to: now });
    if (body.shareWithUserId === undefined || body.shareWithUserId === userId || !workers.some((worker) => worker.userId === body.shareWithUserId)) {
      throw new BadRequestError("«Делим» needs a teammate who worked the page");
    }
    shareWith = body.shareWithUserId;
  }
  await upsertShiftMark(app.db, {
    userId, transactionId: sale.transactionId, pageId: sale.pageId, mark: body.mark, shareWithUserId: shareWith,
    amountMills: body.amountMills ?? null, note: body.note ?? null,
  });
  return { changed: true, serverNow: now.toISOString() };
}

export async function confirmAccountShiftReport(
  app: AppContext,
  principal: AuthPrincipal,
  body: { startedAt: string },
): Promise<AccountShiftReportChangeResponse> {
  requireSessionUser(principal);
  const now = new Date();
  const userId = principal.user.id;
  const startedAt = new Date(body.startedAt);
  if (Number.isNaN(startedAt.getTime())) throw new BadRequestError("`startedAt` is not a time");
  const shift = (await callerShifts(app, userId, SHIFT_REPORT_MAX_DAYS, now)).find((one) => one.startedAt.getTime() === startedAt.getTime());
  if (shift === undefined) throw new NotFoundError("The shift was not found");
  if (shift.ongoing) throw new ConflictError("The shift is still going", { reason: "ongoing" });
  const sales = await shiftSales(app, shift);
  const marks = (await listShiftMarks(app.db, { transactionIds: sales.map((sale) => sale.transactionId) })).filter((mark) => mark.userId === userId);
  const unmarked = sales.filter((sale) => !marks.some((mark) => mark.transactionId === sale.transactionId));
  if (unmarked.length > 0) throw new ConflictError(`${unmarked.length} sales have no mark`, { reason: "unmarked" });
  const sharePercent = (await loadEffectiveConfig(app.db, app.config)).shiftReportSharePercent ?? 50;
  const { recorded } = await insertShiftReport(app.db, {
    userId,
    startedAt: shift.startedAt,
    endedAt: shift.endedAt,
    lines: sales.map((sale) => {
      const mark = marks.find((one) => one.transactionId === sale.transactionId)!;
      return {
        transactionId: sale.transactionId,
        pageId: sale.pageId,
        mark: mark.mark,
        shareWithUserId: mark.shareWithUserId,
        netMills: sale.netMills,
        creditedMills: creditOf({ mark: mark.mark, netMills: sale.netMills, amountMills: mark.amountMills, sharePercent }),
        occurredAt: sale.occurredAt,
      };
    }),
  });
  return { changed: recorded, serverNow: now.toISOString() };
}

export async function readTeamShiftDisputes(
  app: AppContext,
  principal: AuthPrincipal,
  input: { days: number; pageScope: readonly number[] | undefined },
): Promise<TeamShiftDisputesResponse> {
  requireDashboardUser(principal);
  const now = new Date();
  const disputes = await listShiftDisputes(app.db, {
    from: new Date(now.getTime() - input.days * DAY_MS), to: now, pages: input.pageScope ?? "all",
  });
  return {
    disputes: disputes.map((dispute) => ({
      saleRef: String(dispute.transactionId),
      pageLabel: dispute.pageLabel,
      platform: dispute.platform,
      fanRef: dispute.fanRef,
      occurredAt: dispute.occurredAt.toISOString(),
      netMills: dispute.netMills,
      reason: dispute.reason,
      marks: dispute.marks,
      people: disputePeopleOf(dispute),
      resolution: dispute.resolution === null ? null : dispute.resolution.map((share) => ({
        userId: share.userId,
        username: disputePeopleOf(dispute).find((person) => person.userId === share.userId)?.username ?? String(share.userId),
        percent: share.percent,
      })),
    })),
    serverNow: now.toISOString(),
  };
}

export async function resolveTeamShiftDispute(
  app: AppContext,
  principal: AuthPrincipal,
  input: { saleRef: string; body: TeamShiftResolveBody },
): Promise<AccountShiftReportChangeResponse> {
  requireOwner(principal);
  const now = new Date();
  const sale = (await listSalesByIds(app.db, [Number(input.saleRef)]))[0];
  if (sale === undefined) throw new NotFoundError("The sale was not found");
  const dispute = (await listShiftDisputes(app.db, {
    from: new Date(sale.occurredAt.getTime() - 1), to: new Date(sale.occurredAt.getTime() + 1), pages: [sale.pageId],
  })).find((one) => one.transactionId === sale.transactionId);
  if (dispute === undefined) throw new ConflictError("The sale is not disputed", { reason: "not_disputed" });
  const shares = input.body.shares;
  if (shares.reduce((sum, share) => sum + share.percent, 0) !== 100) throw new BadRequestError("The percents must sum to 100");
  if (new Set(shares.map((share) => share.userId)).size !== shares.length
    || shares.some((share) => !disputePeopleOf(dispute).some((person) => person.userId === share.userId))) {
    throw new BadRequestError("Split only between the chatters who marked the sale or are named in its «делим», each once");
  }
  await upsertShiftResolution(app.db, { transactionId: sale.transactionId, pageId: sale.pageId, shares, userId: principal.user.id });
  return { changed: true, serverNow: now.toISOString() };
}

/** Moscow midnight of a `YYYY-MM-DD` day, as an instant (Moscow has no DST: UTC+3). */
/** The chatters a disputed sale can be split between: who marked it and whom it is shared with. Pure. */
export function disputePeopleOf(dispute: Pick<ShiftDisputeRow, "marks">): Array<{ userId: number; username: string }> {
  const people = new Map<number, string>();
  for (const mark of dispute.marks) {
    people.set(mark.userId, mark.username);
    if (mark.shareWithUserId !== null && !people.has(mark.shareWithUserId)) people.set(mark.shareWithUserId, mark.shareWith ?? String(mark.shareWithUserId));
  }
  return [...people].map(([userId, username]) => ({ userId, username }));
}

function moscowMidnight(day: string): Date {
  return new Date(`${day}T00:00:00+03:00`);
}

/**
 * The export's cells: confirmed lines, with a disputed sale counted by the
 * owner's split (on the day of the chatter's line, or of the sale when they
 * have none) and left out while open. Pure.
 */
export function exportCellsOf(input: {
  lines: readonly ConfirmedLineRow[];
  disputes: readonly ShiftDisputeRow[];
  saleDayOf: (dispute: ShiftDisputeRow) => string;
  inWindow: (day: string) => boolean;
}): { cells: Array<{ username: string; pageLabel: string; platform: string; shiftDate: string; creditedMills: number }>; disputedOpen: number } {
  const disputeOf = new Map(input.disputes.map((dispute) => [dispute.transactionId, dispute]));
  const sums = new Map<string, { username: string; pageLabel: string; platform: string; shiftDate: string; creditedMills: number }>();
  const add = (cell: { username: string; pageLabel: string; platform: string; shiftDate: string }, mills: number) => {
    if (mills === 0 || !input.inWindow(cell.shiftDate)) return;
    const key = `${cell.username}\u0000${cell.pageLabel}\u0000${cell.shiftDate}`;
    const known = sums.get(key) ?? { ...cell, creditedMills: 0 };
    known.creditedMills += mills;
    sums.set(key, known);
  };
  const openDisputes = new Set<number>();
  for (const line of input.lines) {
    const dispute = disputeOf.get(line.transactionId);
    if (dispute === undefined) add(line, line.creditedMills);
    else if (dispute.resolution === null) openDisputes.add(line.transactionId);
  }
  for (const dispute of input.disputes) {
    if (dispute.resolution === null) continue;
    for (const share of dispute.resolution) {
      const line = input.lines.find((one) => one.transactionId === dispute.transactionId && one.userId === share.userId);
      const username = line?.username ?? disputePeopleOf(dispute).find((person) => person.userId === share.userId)?.username ?? String(share.userId);
      add(
        { username, pageLabel: dispute.pageLabel, platform: dispute.platform, shiftDate: line?.shiftDate ?? input.saleDayOf(dispute) },
        Number(millsPercentOf(dispute.netMills, share.percent)),
      );
    }
  }
  const cells = [...sums.values()]
    .map((cell) => ({ ...cell, creditedMills: payoutCellOf(cell.platform, cell.creditedMills) }))
    .filter((cell) => cell.creditedMills > 0)
    .sort((a, b) => a.username.localeCompare(b.username) || a.shiftDate.localeCompare(b.shiftDate) || a.pageLabel.localeCompare(b.pageLabel));
  return { cells, disputedOpen: openDisputes.size };
}

export async function readTeamShiftExport(
  app: AppContext,
  principal: AuthPrincipal,
  input: { from: string; to: string; pageScope: readonly number[] | undefined },
): Promise<TeamShiftExportResponse> {
  requireDashboardUser(principal);
  const now = new Date();
  const from = moscowMidnight(input.from);
  const to = new Date(moscowMidnight(input.to).getTime() + DAY_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new BadRequestError("`from` must not be after `to`");
  if (to.getTime() - from.getTime() > SHIFT_REPORT_EXPORT_MAX_DAYS * DAY_MS) {
    throw new BadRequestError(`The window is at most ${SHIFT_REPORT_EXPORT_MAX_DAYS} days`);
  }
  const pages = input.pageScope ?? "all";
  const lines = await listConfirmedLines(app.db, { from, to, pages });
  // A shift is at most a day or so: a sale of a shift in the window is within a day of it.
  const disputes = await listShiftDisputes(app.db, { from: new Date(from.getTime() - 2 * DAY_MS), to: new Date(to.getTime() + 2 * DAY_MS), pages });
  const moscowDay = (at: Date) => new Date(at.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
  const { cells, disputedOpen } = exportCellsOf({
    lines,
    disputes,
    saleDayOf: (dispute) => moscowDay(dispute.occurredAt),
    inWindow: (day) => day >= input.from && day <= input.to,
  });

  // Ended shifts in the window without a confirmed report.
  const minutes = await listChatterActivityMinutes(app.db, { from: new Date(from.getTime() - DAY_MS), to: new Date(Math.min(to.getTime() + DAY_MS, now.getTime())), pages });
  const people = new Map<number, { username: string; minutes: ActivityMinute[] }>();
  for (const minute of minutes) {
    const person = people.get(minute.userId) ?? { username: minute.username, minutes: [] };
    person.minutes.push({ at: minute.minute.getTime(), pageLabel: minute.pageLabel, input: minute.input });
    people.set(minute.userId, person);
  }
  const unconfirmed: TeamShiftExportResponse["unconfirmed"] = [];
  for (const [userId, person] of people) {
    const reports = await listConfirmedReports(app.db, { userId, since: new Date(from.getTime() - DAY_MS) });
    for (const shift of shiftsOfMinutes(person.minutes, now.getTime())) {
      if (shift.ongoing || shift.startedAt < from.getTime() || shift.startedAt >= to.getTime()) continue;
      if (reports.some((report) => report.startedAt.getTime() === shift.startedAt)) continue;
      unconfirmed.push({ username: person.username, startedAt: new Date(shift.startedAt).toISOString(), endedAt: new Date(shift.endedAt).toISOString() });
    }
  }
  unconfirmed.sort((a, b) => a.username.localeCompare(b.username) || a.startedAt.localeCompare(b.startedAt));
  return { from: input.from, to: input.to, rows: cells, disputedOpen, unconfirmed, serverNow: now.toISOString() };
}
