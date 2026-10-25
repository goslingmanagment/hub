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
  confirmShiftReport,
  listChatterActivityMinutes,
  listConfirmedReports,
  listExportLines,
  listMarkedSales,
  listPageWorkers,
  listReportLines,
  listSaleFacts,
  listSalesByIds,
  listSharedWithMe,
  listShiftMarks,
  listShiftSales,
  markShiftSale,
  upsertShiftResolution,
  type Database,
  type MarkedSaleRow,
  type SaleFacts,
  type ShiftMarkRow,
  type ShiftSale,
} from "@agency_hub_core/db";
import { millsPercentOf, millsRoundedTo } from "@agency_hub_core/shared";

import { pageScopeFor } from "../api/request-auth.ts";
import type { AppContext } from "../bootstrap.ts";
import { requireDashboardUser, requireOwner, requireSessionUser, type AuthPrincipal, type HumanAuthPrincipal } from "./auth.ts";
import { shiftsOfMinutes, type ActivityMinute } from "./chatter-shifts.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";

/**
 * Chat Memory week 4 (docs/plans/2026-10-24-chat-memory/week-4.md §2): the
 * draft shift report.
 *
 * THE DRAFT (`accountShiftReport`, the chatter's cabinet). The caller's actual
 * shifts (week 1) on the pages they work now; a shift's sales are the money
 * fans paid on those pages during it (net, as the payout sheet counts). Each
 * sale carries its facts: who sent the PPV it bought, who else wrote to the fan
 * in 48 hours. Two shifts that overlap (ari-1, 00:00–02:00) both show the sale;
 * each chatter marks it.
 *
 * THE MARKS AND THE CONFIRMATION. «моё» claims the net (or the chatter's own
 * amount, never above it), «делим с X» half of it, «не моё» nothing. Confirming
 * writes a line for each sale of the shift; a sale that came after the
 * confirmation is marked and confirmed later, the lines held stay as they were.
 * Hub credits no sale by itself (roadmap: «Hub shows facts; it decides nothing
 * about money»).
 *
 * WHO GETS WHAT (`creditsOfSale`). The marks agree only as one «моё» or as two
 * «делим» naming each other («не моё» beside them is fine); anything else is a
 * dispute the owner splits. An agreed sale credits once a chatter whose credit
 * it is confirmed it — a «делим» either of the two (the partner who agreed from
 * «С тобой делят» has no shift that holds it).
 *
 * ONE DAY PER SALE (`saleDayOf`). A sale is in exactly one export: on the
 * Moscow day the earliest shift holding it started — anyone's, by the
 * extension's activity on its page — else on its own Moscow day. Who confirmed
 * what, and in what order, never moves it: a credit confirmed later lands on
 * the same day, and the export lists every ended shift that holds a sale of its
 * days and is not confirmed yet, and the sales that came after a confirmation.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

type MarkOf = MarkedSaleRow["marks"][number];
export type ShiftDisputeReason = "two_mine" | "share_not_agreed" | "conflicting";
export type Settlement =
  | { kind: "nobody" }
  | { kind: "mine"; userId: number }
  | { kind: "share"; userIds: [number, number] }
  | { kind: "dispute"; reason: ShiftDisputeReason };

/** Whether the marks of a sale agree, and on what. Pure. */
export function judgeMarks(marks: ReadonlyArray<Pick<MarkOf, "userId" | "mark" | "shareWithUserId">>): Settlement {
  const claims = marks.filter((mark) => mark.mark !== "not_mine");
  if (claims.length === 0) return { kind: "nobody" };
  if (claims.length === 1 && claims[0]!.mark === "mine") return { kind: "mine", userId: claims[0]!.userId };
  if (claims.length === 2) {
    const [a, b] = claims as [typeof claims[number], typeof claims[number]];
    if (a.mark === "share" && b.mark === "share" && a.shareWithUserId === b.userId && b.shareWithUserId === a.userId) {
      return { kind: "share", userIds: [a.userId, b.userId] };
    }
  }
  if (claims.filter((mark) => mark.mark === "mine").length >= 2) return { kind: "dispute", reason: "two_mine" };
  if (claims.every((mark) => mark.mark === "share")) return { kind: "dispute", reason: "share_not_agreed" };
  return { kind: "dispute", reason: "conflicting" };
}

/** A sale's net in two halves that sum to it exactly: the odd mill to the lower user id. Pure. */
export function halvesOf(netMills: number, userIds: readonly [number, number]): Map<number, number> {
  const [low, high] = [...userIds].sort((a, b) => a - b) as [number, number];
  const first = Number(millsPercentOf(netMills, 50));
  return new Map([[low, first], [high, netMills - first]]);
}

/** What a chatter's own mark claims of a sale: «моё» the net or their amount (never above it), «делим» their half, «не моё» nothing. Pure. */
export function claimOf(mark: Pick<ShiftMarkRow, "userId" | "mark" | "shareWithUserId" | "amountMills">, netMills: number): number {
  if (mark.mark === "mine") return Math.min(mark.amountMills ?? netMills, netMills);
  if (mark.mark === "share" && mark.shareWithUserId !== null) return halvesOf(netMills, [mark.userId, mark.shareWithUserId]).get(mark.userId)!;
  return 0;
}

/**
 * Who is credited what of one sale. The owner's split wins; a dispute without
 * it credits nobody yet (`open`); an agreed sale credits once confirmed (see
 * the file's header). Pure.
 */
export function creditsOfSale(sale: {
  netMills: number;
  active: boolean;
  marks: ReadonlyArray<Pick<MarkOf, "userId" | "mark" | "shareWithUserId" | "amountMills">>;
  resolution: ReadonlyArray<{ userId: number; percent: number }> | null;
  confirmedBy: ReadonlySet<number>;
}): { open: boolean; credits: Array<{ userId: number; mills: number }> } {
  if (!sale.active) return { open: false, credits: [] };
  if (sale.resolution !== null && sale.resolution.length > 0) {
    let given = 0;
    const credits = sale.resolution.map((share, index) => {
      const mills = index === sale.resolution!.length - 1 ? sale.netMills - given : Number(millsPercentOf(sale.netMills, share.percent));
      given += mills;
      return { userId: share.userId, mills };
    });
    return { open: false, credits };
  }
  const settled = judgeMarks(sale.marks);
  if (settled.kind === "dispute") return { open: true, credits: [] };
  if (settled.kind === "mine") {
    const mark = sale.marks.find((one) => one.userId === settled.userId)!;
    return { open: false, credits: sale.confirmedBy.has(settled.userId) ? [{ userId: settled.userId, mills: claimOf(mark, sale.netMills) }] : [] };
  }
  if (settled.kind === "share") {
    if (!settled.userIds.some((userId) => sale.confirmedBy.has(userId))) return { open: false, credits: [] };
    return { open: false, credits: [...halvesOf(sale.netMills, settled.userIds)].map(([userId, mills]) => ({ userId, mills })) };
  }
  return { open: false, credits: [] };
}

/** The Moscow `YYYY-MM-DD` of an instant (Moscow has no DST: UTC+3). Pure. */
export function moscowDayOf(at: number): string {
  return new Date(at + 3 * 3_600_000).toISOString().slice(0, 10);
}

/** A sale's one day in every export (see the file's header). Pure. */
export function saleDayOf(
  sale: { pageLabel: string; at: number },
  shifts: ReadonlyArray<{ startedAt: number; endedAt: number; pages: ReadonlyMap<string, unknown> }>,
): string {
  let first: number | null = null;
  for (const shift of shifts) {
    if (shift.pages.has(sale.pageLabel) && shift.startedAt <= sale.at && sale.at < shift.endedAt && (first === null || shift.startedAt < first)) {
      first = shift.startedAt;
    }
  }
  return moscowDayOf(first ?? sale.at);
}

/** A payout-sheet cell: Fansly to the cent, OnlyFans whole dollars. Pure. */
export function payoutCellOf(platform: string, mills: number): number {
  return Number(millsRoundedTo(mills, platform === "onlyfans" ? "dollar" : "cent"));
}

/** The pages a person's report reaches: the ones they work now (the owner — all). */
function reportPagesOf(principal: HumanAuthPrincipal): "all" | readonly number[] {
  return pageScopeFor(principal) ?? "all";
}

interface CallerShift {
  startedAt: Date;
  endedAt: Date;
  ongoing: boolean;
  pageIds: number[];
  pageLabels: string[];
}

async function callerShifts(app: AppContext, userId: number, pages: "all" | readonly number[], days: number, now: Date): Promise<CallerShift[]> {
  // A day more than asked, so a shift that began before the window is whole.
  const minutes = await listChatterActivityMinutes(app.db, {
    from: new Date(now.getTime() - (days + 1) * DAY_MS), to: now, pages, userId,
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

function saleOf(sale: ShiftSale, facts: SaleFacts | undefined, marks: readonly ShiftMarkRow[], userId: number, confirmed: boolean): ShiftReportSale {
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
    confirmed,
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
  const pages = reportPagesOf(principal);
  const shifts = await callerShifts(app, userId, pages, input.days, now);
  const salesByShift = await Promise.all(shifts.map((shift) => shiftSales(app, shift)));
  const inShifts = new Set(salesByShift.flat().map((sale) => sale.transactionId));
  const windowFrom = new Date(now.getTime() - input.days * DAY_MS);
  const sharedIds = (await listSharedWithMe(app.db, { userId, from: windowFrom, to: now, pages })).filter((id) => !inShifts.has(id));
  const shared = await listSalesByIds(app.db, sharedIds);
  const all = [...salesByShift.flat(), ...shared];
  const ids = [...new Set(all.map((sale) => sale.transactionId))];
  const reportsSince = new Date(windowFrom.getTime() - 2 * DAY_MS);
  const [facts, marks, confirmed, lines] = await Promise.all([
    listSaleFacts(app.db, { transactionIds: ids }),
    listShiftMarks(app.db, { transactionIds: ids }),
    listConfirmedReports(app.db, { userId, since: reportsSince }),
    listReportLines(app.db, { userId, since: reportsSince }),
  ]);
  const heldSet = new Set(lines.map((line) => line.transactionId));
  const factOf = new Map(facts.map((fact) => [fact.transactionId, fact]));
  const pageIds = [...new Set(shifts.flatMap((shift) => shift.pageIds).concat(shared.map((sale) => sale.pageId)))];
  const teammates = (await listPageWorkers(app.db, { pageIds, from: new Date(now.getTime() - SHIFT_REPORT_MAX_DAYS * DAY_MS), to: now }))
    .filter((worker) => worker.userId !== userId);

  return {
    shifts: shifts.map((shift, index) => {
      const sales = salesByShift[index]!;
      const report = confirmed.find((one) => one.startedAt.getTime() === shift.startedAt.getTime());
      const open = sales.filter((sale) => !heldSet.has(sale.transactionId));
      const myMarks = open.map((sale) => marks.find((mark) => mark.transactionId === sale.transactionId && mark.userId === userId));
      // A confirmed shift credits its lines on the pages the chatter works now — a page taken away takes its money off this view.
      const credited = report !== undefined
        ? lines.filter((line) => line.reportStartedAt.getTime() === shift.startedAt.getTime() && shift.pageIds.includes(line.pageId))
          .reduce((sum, line) => sum + line.creditedMills, 0)
        : open.reduce((sum, sale, at) => {
        const mark = myMarks[at];
        return mark === undefined ? sum : sum + claimOf(mark, sale.netMills);
      }, 0);
      return {
        startedAt: shift.startedAt.toISOString(),
        endedAt: shift.endedAt.toISOString(),
        ongoing: shift.ongoing,
        pages: shift.pageLabels,
        sales: sales.map((sale) => saleOf(sale, factOf.get(sale.transactionId), marks, userId, heldSet.has(sale.transactionId))),
        creditedMills: credited,
        unmarked: myMarks.filter((mark) => mark === undefined).length,
        pending: report === undefined ? 0 : open.length,
        confirmedAt: report === undefined ? null : report.confirmedAt.toISOString(),
      };
    }),
    sharedWithMe: shared.map((sale) => saleOf(sale, factOf.get(sale.transactionId), marks, userId, false)),
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
  const pages = reportPagesOf(principal);
  const saleId = Number(body.saleRef);
  let sale: ShiftSale | undefined;
  for (const candidate of await callerShifts(app, userId, pages, SHIFT_REPORT_MAX_DAYS, now)) {
    sale = (await shiftSales(app, candidate)).find((one) => one.transactionId === saleId);
    if (sale !== undefined) break;
  }
  if (sale === undefined) {
    const shared = await listSharedWithMe(app.db, { userId, from: new Date(now.getTime() - SHIFT_REPORT_MAX_DAYS * DAY_MS), to: now, pages });
    if (shared.includes(saleId)) sale = (await listSalesByIds(app.db, [saleId]))[0];
  }
  if (sale === undefined) throw new NotFoundError("The sale is not in your shifts");
  let shareWith: number | null = null;
  if (body.mark === "share") {
    const workers = await listPageWorkers(app.db, { pageIds: [sale.pageId], from: new Date(now.getTime() - SHIFT_REPORT_MAX_DAYS * DAY_MS), to: now });
    if (body.shareWithUserId === undefined || body.shareWithUserId === userId || !workers.some((worker) => worker.userId === body.shareWithUserId)) {
      throw new BadRequestError("«Делим» needs a teammate who worked the page");
    }
    shareWith = body.shareWithUserId;
  }
  // The chatter's own amount: «моё» only, and never above the sale's net.
  const amount = body.mark === "mine" ? body.amountMills ?? null : null;
  if (amount !== null && amount > sale.netMills) {
    throw new BadRequestError("The amount is above the sale's net", { reason: "amount_above_net" });
  }
  const outcome = await markShiftSale(app.db, {
    userId, transactionId: sale.transactionId, pageId: sale.pageId, mark: body.mark, shareWithUserId: shareWith,
    amountMills: amount, note: body.note ?? null,
  });
  if (outcome === "confirmed") throw new ConflictError("The shift's report is confirmed", { reason: "confirmed" });
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
  const shift = (await callerShifts(app, userId, reportPagesOf(principal), SHIFT_REPORT_MAX_DAYS, now))
    .find((one) => one.startedAt.getTime() === startedAt.getTime());
  if (shift === undefined) throw new NotFoundError("The shift was not found");
  if (shift.ongoing) throw new ConflictError("The shift is still going", { reason: "ongoing" });
  const sales = await shiftSales(app, shift);
  const { recorded, unmarked } = await confirmShiftReport(app.db, {
    userId,
    startedAt: shift.startedAt,
    endedAt: shift.endedAt,
    sales: sales.map((sale) => ({ transactionId: sale.transactionId, pageId: sale.pageId, netMills: sale.netMills, occurredAt: sale.occurredAt })),
    claimOf: (mark, sale) => claimOf(mark, sale.netMills),
  });
  if (unmarked > 0) throw new ConflictError(`${unmarked} sales have no mark`, { reason: "unmarked" });
  return { changed: recorded, serverNow: now.toISOString() };
}

export interface ShiftDispute extends MarkedSaleRow {
  reason: ShiftDisputeReason;
}

/** The sales in [from, to) whose marks do not agree (`judgeMarks`), the undecided first. */
export async function listSaleDisputes(
  db: Database,
  input: { from: Date; to: Date; pages: "all" | readonly number[] } | { transactionIds: readonly number[] },
): Promise<ShiftDispute[]> {
  const disputes: ShiftDispute[] = [];
  for (const sale of await listMarkedSales(db, input)) {
    const settled = judgeMarks(sale.marks);
    if (settled.kind === "dispute") disputes.push({ ...sale, reason: settled.reason });
  }
  return disputes.sort((a, b) => Number(a.resolution !== null) - Number(b.resolution !== null) || b.occurredAt.getTime() - a.occurredAt.getTime());
}

export async function readTeamShiftDisputes(
  app: AppContext,
  principal: AuthPrincipal,
  input: { days: number; pageScope: readonly number[] | undefined },
): Promise<TeamShiftDisputesResponse> {
  requireDashboardUser(principal);
  const now = new Date();
  const disputes = await listSaleDisputes(app.db, {
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
  const dispute = (await listSaleDisputes(app.db, { transactionIds: [sale.transactionId] }))[0];
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

/** The chatters a disputed sale can be split between: who marked it and whom it is shared with. Pure. */
export function disputePeopleOf(dispute: Pick<MarkedSaleRow, "marks">): Array<{ userId: number; username: string }> {
  const people = new Map<number, string>();
  for (const mark of dispute.marks) {
    people.set(mark.userId, mark.username);
    if (mark.shareWithUserId !== null && !people.has(mark.shareWithUserId)) people.set(mark.shareWithUserId, mark.shareWith ?? String(mark.shareWithUserId));
  }
  return [...people].map(([userId, username]) => ({ userId, username }));
}

/** Moscow midnight of a `YYYY-MM-DD` day, as an instant (Moscow has no DST: UTC+3). */
function moscowMidnight(day: string): Date {
  return new Date(`${day}T00:00:00+03:00`);
}

export interface ExportSale extends Pick<MarkedSaleRow, "transactionId" | "pageLabel" | "platform" | "netMills" | "active" | "marks" | "resolution" | "occurredAt"> {
  /** The sale's one day in the exports (`saleDayOf`). */
  saleDay: string;
  /** Who confirmed a report holding it, with their usernames. */
  confirmedBy: ReadonlyMap<number, string>;
}

/**
 * The export's cells: each sale's credits (`creditsOfSale`) on the sale's one
 * day, per chatter and page; an open dispute is left out and counted; a
 * chatter's own amount below Hub's net is listed for the owner. Pure.
 */
export function exportCellsOf(sales: readonly ExportSale[]): {
  cells: Array<{ username: string; pageLabel: string; platform: string; shiftDate: string; creditedMills: number }>;
  disputedOpen: number;
  ownAmounts: TeamShiftExportResponse["ownAmounts"];
} {
  const sums = new Map<string, { username: string; pageLabel: string; platform: string; shiftDate: string; creditedMills: number }>();
  const ownAmounts: TeamShiftExportResponse["ownAmounts"] = [];
  let disputedOpen = 0;
  for (const sale of sales) {
    const { open, credits } = creditsOfSale({
      netMills: sale.netMills, active: sale.active, marks: sale.marks, resolution: sale.resolution, confirmedBy: new Set(sale.confirmedBy.keys()),
    });
    if (open) disputedOpen += 1;
    const nameOf = (userId: number) => sale.confirmedBy.get(userId) ?? disputePeopleOf(sale).find((person) => person.userId === userId)?.username ?? String(userId);
    for (const credit of credits) {
      if (credit.mills === 0) continue;
      const cell = { username: nameOf(credit.userId), pageLabel: sale.pageLabel, platform: sale.platform, shiftDate: sale.saleDay };
      const key = `${cell.username}\u0000${cell.pageLabel}\u0000${cell.shiftDate}`;
      const known = sums.get(key) ?? { ...cell, creditedMills: 0 };
      known.creditedMills += credit.mills;
      sums.set(key, known);
      const mark = sale.marks.find((one) => one.userId === credit.userId && one.mark === "mine" && one.amountMills !== null && one.amountMills < sale.netMills);
      if (mark !== undefined && sale.resolution === null) {
        ownAmounts.push({
          username: cell.username, pageLabel: sale.pageLabel, saleRef: String(sale.transactionId), occurredAt: sale.occurredAt.toISOString(),
          netMills: sale.netMills, amountMills: mark.amountMills!,
        });
      }
    }
  }
  const cells = [...sums.values()]
    .map((cell) => ({ ...cell, creditedMills: payoutCellOf(cell.platform, cell.creditedMills) }))
    .filter((cell) => cell.creditedMills > 0)
    .sort((a, b) => a.username.localeCompare(b.username) || a.shiftDate.localeCompare(b.shiftDate) || a.pageLabel.localeCompare(b.pageLabel));
  return { cells, disputedOpen, ownAmounts };
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
  // A sale of the window's days happened in it or within a day after (a shift that began on its last day).
  const scanTo = new Date(to.getTime() + DAY_MS);
  const lines = await listExportLines(app.db, { from, to: scanTo, pages });

  // Everyone's shifts by the extension's activity, on every page: a sale's day must not depend on the scope.
  // Two days before the window, so a shift holding its first sales is whole.
  const minutes = await listChatterActivityMinutes(app.db, {
    from: new Date(from.getTime() - 2 * DAY_MS), to: new Date(Math.min(scanTo.getTime() + HOUR_MS, now.getTime())), pages: "all",
  });
  const people = new Map<number, { username: string; minutes: ActivityMinute[] }>();
  const scopedLabels = new Set<string>();
  for (const minute of minutes) {
    const person = people.get(minute.userId) ?? { username: minute.username, minutes: [] };
    person.minutes.push({ at: minute.minute.getTime(), pageLabel: minute.pageLabel, input: minute.input });
    people.set(minute.userId, person);
    if (pages === "all" || pages.includes(minute.pageId)) scopedLabels.add(minute.pageLabel);
  }
  const shifts = [...people].flatMap(([userId, person]) => shiftsOfMinutes(person.minutes, now.getTime()).map((shift) => ({ ...shift, userId })));

  const marked = await listMarkedSales(app.db, { transactionIds: [...new Set(lines.map((line) => line.transactionId))] });
  const sales: ExportSale[] = [];
  const lateSales: TeamShiftExportResponse["lateSales"] = [];
  for (const sale of marked) {
    const saleDay = saleDayOf({ pageLabel: sale.pageLabel, at: sale.occurredAt.getTime() }, shifts);
    if (saleDay < input.from || saleDay > input.to) continue;
    const held = lines.filter((line) => line.transactionId === sale.transactionId);
    sales.push({ ...sale, saleDay, confirmedBy: new Map(held.map((line) => [line.userId, line.username])) });
    for (const line of held.filter((one) => one.late)) {
      lateSales.push({
        username: line.username, pageLabel: sale.pageLabel, saleRef: String(sale.transactionId), occurredAt: sale.occurredAt.toISOString(),
        saleDay, arrivedAt: line.arrivedAt.toISOString(),
      });
    }
  }
  const { cells, disputedOpen, ownAmounts } = exportCellsOf(sales);

  // Ended shifts that are not confirmed yet: those that began in the window, and those that hold a sale of its days
  // (a later shift's credit on an earlier day) — until they are, the window's cells may still grow.
  const unconfirmed: TeamShiftExportResponse["unconfirmed"] = [];
  for (const [userId, person] of people) {
    const reports = await listConfirmedReports(app.db, { userId, since: new Date(from.getTime() - 3 * DAY_MS) });
    for (const shift of shifts.filter((one) => one.userId === userId)) {
      if (shift.ongoing || ![...shift.pages.keys()].some((label) => scopedLabels.has(label))) continue;
      const began = shift.startedAt >= from.getTime() && shift.startedAt < to.getTime();
      const holds = sales.some((sale) => shift.pages.has(sale.pageLabel) && shift.startedAt <= sale.occurredAt.getTime() && sale.occurredAt.getTime() < shift.endedAt);
      if (!began && !holds) continue;
      if (reports.some((report) => report.startedAt.getTime() < shift.endedAt && report.endedAt.getTime() > shift.startedAt)) continue;
      unconfirmed.push({ username: person.username, startedAt: new Date(shift.startedAt).toISOString(), endedAt: new Date(shift.endedAt).toISOString() });
    }
  }
  unconfirmed.sort((a, b) => a.username.localeCompare(b.username) || a.startedAt.localeCompare(b.startedAt));
  lateSales.sort((a, b) => a.saleDay.localeCompare(b.saleDay) || a.username.localeCompare(b.username) || a.occurredAt.localeCompare(b.occurredAt));
  return { from: input.from, to: input.to, rows: cells, disputedOpen, ownAmounts, unconfirmed, lateSales, serverNow: now.toISOString() };
}
