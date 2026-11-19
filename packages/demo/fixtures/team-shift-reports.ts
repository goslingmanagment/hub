import type { ChatterSaleKind, KernelOperationResponse, TeamShiftReport, TeamShiftReportParts } from "@agency_hub_core/contracts";
import { millsRoundedTo, millsToNumber } from "@agency_hub_core/shared";
import { shiftReportDay } from "@agency_hub_core/ui/moscow";

import { demoError, queryNumber, queryString, type DemoHandlers, type DemoReply, type DemoRequest } from "../core.ts";
import { DEMO_USERS, demoPage, demoUserByRole } from "../world.ts";
import { demoShiftId } from "./sale-claims.ts";
import { DEMO_OLD_WAY_USER, SWITCH_DAYS, demoHubReportOf } from "./shift-reports.ts";
import { DAY, MIN, addDays, creditedOf, isoAt, mskDay, mskMidnight, pick, rng, teamViewerPages, teamWorld, workedPages, type DemoShift } from "./team-world.ts";

/**
 * «Смены → Отчёты» in the demo (`teamShiftReports`): every shift of the team's journal (team-world.ts, the very shifts
 * `teamShiftSales` lists) with its report. The demo chatter's are the rows «Мои» and the board read (shift-reports.ts
 * `demoHubReportOf`): the same phase, version and post. Everyone else walks the board's every state over their shifts
 * since the switch, newest first — on the check, waiting for «Подтверждаю», reopened, not handed in, counted; Иван
 * reports the old way (a post in «Отчётность»). A report holds the shift's sales as the person marked them (their
 * shares), the card's «по правилу» is the journal's own number. Cut to the viewer's pages as Hub cuts it.
 *
 * Invented data only.
 */

type Response = KernelOperationResponse<"teamShiftReports">;
type Item = TeamShiftReport;
type Tally = Response["totals"];
type Stage = "draft" | "checking" | "confirm" | "fixing" | "counted";

/** Each person's shifts since the switch, newest first: where their reports stand (beyond the list — counted). */
const STAGES: Readonly<Record<string, readonly Stage[]>> = {
  "kate.v": ["checking", "fixing", "counted"],
  "den.s": ["draft", "confirm", "counted", "counted", "draft"],
  "olya.m": ["confirm", "counted", "draft"],
};

/** What the next shift is told, now and then (a fan of the shift's sales named). */
const COMMENTS: ReadonlyArray<(fan: string) => string> = [
  (fan) => `${fan} ждёт кастом к пятнице, предоплату взяла.`,
  (fan) => `${fan} просил не писать до вечера, у него смена.`,
  (fan) => `Обещала ${fan} голосовое после 20:00, не забудьте.`,
  (fan) => `${fan} торгуется по PPV за $35: держу цену, не скидывайте.`,
];

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;
const toCent = (mills: number) => millsToNumber(millsRoundedTo(mills, "cent"));

function kindOf(kind: string): ChatterSaleKind {
  if (kind === "message_purchase" || kind === "ppv") return "ppv";
  if (kind === "post_purchase" || kind === "post") return "post";
  if (kind === "subscription") return "subscription";
  return "tip";
}

function partsOf(sales: ReadonlyArray<TeamShiftReportParts["sales"][number]>): TeamShiftReportParts {
  const counted = sales.filter((sale) => sale.netMills > 0).sort((a, b) => a.at.localeCompare(b.at));
  const byKind = { ppv: 0, tip: 0, subscription: 0, post: 0 };
  for (const sale of counted) byKind[sale.kind] += sale.netMills;
  return { count: counted.length, mills: counted.reduce((sum, sale) => sum + sale.netMills, 0), byKind, sales: counted };
}

/** What a report holds (a body of shift-reports.ts, or a simulated shift's). */
interface BodyLike {
  lines: ReadonlyArray<{ pageLabel: string; kind: string; occurredAt: string; amountMills: number; fan: { name: string | null } }>;
  pages: ReadonlyArray<{ pageLabel: string; amountMills: number }>;
  totalMills: number;
}

/** A report as a reader sees it: the lines and pages of their pages, the sums of exactly those (Hub's `reportSeenBy`). */
function seenOf(body: BodyLike, cut: ReadonlySet<string> | null) {
  const lines = body.lines.filter((line) => cut === null || cut.has(line.pageLabel));
  const pages = cut === null ? body.pages.map((page) => ({ pageLabel: page.pageLabel, amountMills: page.amountMills }))
    : body.pages.filter((page) => cut.has(page.pageLabel)).map((page) => ({ pageLabel: page.pageLabel, amountMills: toCent(lines.filter((line) => line.pageLabel === page.pageLabel).reduce((sum, line) => sum + line.amountMills, 0)) }));
  return {
    totalMills: cut === null ? body.totalMills : pages.reduce((sum, page) => sum + page.amountMills, 0),
    pages,
    cut: cut !== null && pages.length < body.pages.length,
    parts: partsOf(lines.map((line) => ({ at: line.occurredAt, netMills: line.amountMills, kind: kindOf(line.kind), pageLabel: line.pageLabel, fanName: line.fan.name }))),
  };
}

/** A simulated shift's report body: its sales as the person marked them, a page each, rounded to the cent as Hub does. */
function bodyOf(shift: DemoShift): BodyLike {
  const worked = workedPages(shift);
  const sales = shift.sales.filter((sale) => worked.includes(sale.pageLabel));
  const lines = sales.map((sale) => ({
    pageLabel: sale.pageLabel, kind: sale.kind, occurredAt: isoAt(sale.at), amountMills: creditedOf(sale), fan: { name: sale.fan.displayName },
  }));
  const pages = worked.map((pageLabel) => ({ pageLabel, amountMills: toCent(lines.filter((line) => line.pageLabel === pageLabel).reduce((sum, line) => sum + line.amountMills, 0)) }));
  return { lines, pages, totalMills: pages.reduce((sum, page) => sum + page.amountMills, 0) };
}

/** The models' comment (one model's shift: said once). */
function commentOf(shift: DemoShift, handed: boolean): Item["comments"] {
  const random = rng(`report-comment:${shift.user.id}:${shift.startedAt}`);
  if (random() > (handed ? 0.45 : 0.2)) return [];
  const fan = shift.sales.find((sale) => sale.fan.displayName)?.fan.displayName ?? "Фан";
  return [{ modelName: "", comment: pick(random, COMMENTS)(fan) }];
}

function tallyOf(items: readonly Item[]): Tally {
  const tally: Tally = { shifts: 0, handedIn: 0, expected: 0, reportedMills: 0, notHandedIn: 0, waitingConfirm: 0, ongoing: 0, oldWay: 0 };
  for (const item of items) {
    tally.shifts += 1;
    if (item.report !== null) {
      tally.handedIn += 1;
      tally.expected += 1;
      tally.reportedMills += item.report.totalMills;
      if (item.phase === "confirm") tally.waitingConfirm += 1;
    } else if (item.ongoing) tally.ongoing += 1;
    else if (item.board) {
      tally.notHandedIn += 1;
      tally.expected += 1;
    } else tally.oldWay += 1;
  }
  return tally;
}

const CLEAN = { hub: "matched" as const, foundCount: 0, foundMills: 0, gengar: "clean" as const, proposals: 0 };

/** The viewer's cut: a page asked for (everyone's), else theirs — none for the owner, and none on one's own shift. */
interface Cut { asked: ReadonlySet<string> | null; reader: ReadonlySet<string> | null }

function itemOf(request: DemoRequest, shift: DemoShift, scope: readonly string[], cut: Cut, viewerId: number): Item {
  const now = request.now;
  const user = shift.user;
  const own = user.id === viewerId;
  const cutTo = cut.asked ?? (own ? null : cut.reader);
  const visible = (label: string) => cutTo === null || cutTo.has(label);
  const reportDate = shiftReportDay(shift.startedAt, shift.endedAt);
  const worked = workedPages(shift);
  const ruleSales = shift.sales.filter((sale) => worked.includes(sale.pageLabel) && scope.includes(sale.pageLabel));
  const base = {
    shiftId: demoShiftId({ start: shift.startedAt }, user),
    userId: user.id,
    personName: user.name,
    startedAt: isoAt(shift.startedAt),
    endedAt: isoAt(shift.endedAt),
    ongoing: shift.ongoing,
    workedMinutes: shift.workedMinutes,
    pauses: shift.pauses.map((pause) => ({ from: isoAt(pause.from), to: isoAt(pause.to) })),
    pages: shift.pages.filter((page) => page.messages > 0 && visible(page.pageLabel)).map((page) => page.pageLabel),
    reportDate,
    own,
    // The journal's own number of the shift: its sales on the viewer's pages, whole (`teamShiftSales`).
    rule: partsOf(ruleSales.map((sale) => ({ at: isoAt(sale.at), netMills: sale.netMills, kind: sale.kind, pageLabel: sale.pageLabel, fanName: sale.fan.displayName }))),
  };
  const nothing = { report: null, counted: null, check: null, waitsConfirm: false, postCopied: null, draftTotalMills: null };

  // The demo chatter: the rows «Мои» and the board read.
  const hub = user.id === demoUserByRole("chatter").id ? demoHubReportOf(now, user, shift.startedAt) : null;
  if (hub !== null) {
    const handed = hub.latest ?? (hub.candidate === null ? null : { version: 1, submittedAt: hub.candidate.at, door: "workboard" as const, body: hub.candidate.body });
    const seen = handed === null ? null : seenOf(handed.body, cutTo);
    const comments = hub.comment.trim() === "" ? [] : [{ modelName: "", comment: hub.comment.trim() }];
    return {
      ...base, ...nothing,
      board: hub.board,
      phase: hub.phase,
      report: handed === null || seen === null ? null : { source: hub.latest !== null ? "version" : "candidate", number: handed.version, at: handed.submittedAt, door: handed.door, ...seen },
      counted: hub.latest === null ? null : { version: hub.latest.version, at: hub.latest.submittedAt },
      check: handed === null ? null : CLEAN,
      waitsConfirm: hub.phase === "confirm",
      comments,
      postCopied: own ? hub.postCopied : null,
      // One's own draft, as «Мои» shows it; a page asked for is that page's part, no draft's.
      draftTotalMills: own && handed === null && cut.asked === null ? hub.draftTotalMills : null,
    };
  }

  const board = user.username !== DEMO_OLD_WAY_USER && shift.startedAt >= mskMidnight(mskDay(now.getTime() - SWITCH_DAYS * DAY));
  if (!board) return { ...base, ...nothing, board: false, phase: null, comments: [] };
  if (shift.ongoing) return { ...base, ...nothing, board: true, phase: "draft", comments: [] };
  const since = mskMidnight(mskDay(now.getTime() - SWITCH_DAYS * DAY));
  const ended = teamWorld(now).shifts.filter((one) => one.user.id === user.id && !one.ongoing && one.startedAt >= since);
  const place = ended.findIndex((one) => one.startedAt === shift.startedAt);
  const stage: Stage = STAGES[user.username]?.[place] ?? "counted";
  if (stage === "draft") return { ...base, ...nothing, board: true, phase: "draft", comments: commentOf(shift, false) };

  const random = rng(`report-time:${user.id}:${shift.startedAt}`);
  const seen = seenOf(bodyOf(shift), cutTo);
  const countedAt = shift.endedAt + Math.round(8 + random() * 30) * MIN;
  // A report on the check was handed in a few minutes ago (late, the next morning); one to confirm, soon after the end.
  const handedAt = stage === "checking" ? Math.max(shift.endedAt + 4 * MIN, now.getTime() - 3 * MIN) : shift.endedAt + 6 * MIN;
  const onCheck = stage === "checking" || stage === "confirm";
  const door = random() < 0.2 ? "telegram" as const : "workboard" as const;
  return {
    ...base,
    board: true,
    phase: stage,
    report: { source: onCheck ? "candidate" : "version", number: 1, at: isoAt(onCheck ? handedAt : countedAt), door, ...seen },
    counted: onCheck ? null : { version: 1, at: isoAt(countedAt) },
    check: stage === "checking"
      ? { hub: "running", foundCount: 0, foundMills: 0, gengar: "reading", proposals: 0 }
      : stage === "confirm" ? { hub: "matched", foundCount: 0, foundMills: 0, gengar: "found", proposals: 1 } : CLEAN,
    waitsConfirm: stage === "confirm",
    comments: commentOf(shift, true),
    postCopied: null,
    draftTotalMills: null,
  };
}

export const teamShiftReportHandlers: DemoHandlers = {
  teamShiftReports: (request): Response | DemoReply => {
    const scope = teamViewerPages(request);
    if (!scope) return demoError(403, "Forbidden", "Этот раздел — для владельца и тимлидов.");
    const pageLabel = queryString(request, "pageLabel");
    if (pageLabel !== undefined) {
      if (!demoPage(pageLabel)) return demoError(404, "Not Found", `Страницы «${pageLabel}» нет.`);
      if (!scope.includes(pageLabel)) return demoError(403, "Forbidden", `Страница «${pageLabel}» вам не назначена.`);
    }
    const days = queryNumber(request, "days", 7);
    if (!Number.isInteger(days) || days < 1 || days > 31) return demoError(400, "Bad Request", "days — целое число от 1 до 31.");
    const until = queryString(request, "until");
    if (until !== undefined && !BUSINESS_DATE.test(until)) return demoError(400, "Bad Request", "until — день в формате YYYY-MM-DD.");
    const userParam = queryNumber(request, "userId", Number.NaN);

    // The window as the server's: `days` days ending on `until` (never leaving today out).
    const today = mskDay(request.now.getTime());
    const latest = addDays(today, days - 1);
    const lastDay = (until ?? today) > latest ? latest : until ?? today;
    const firstDay = addDays(lastDay, -(days - 1));
    const pages = pageLabel === undefined ? scope : [pageLabel];
    const viewer = demoUserByRole(request.role);
    // The owner reads a report whole; anyone else cut to their pages; a page asked for is that page's part.
    const cut: Cut = { asked: pageLabel === undefined ? null : new Set([pageLabel]), reader: request.role === "owner" ? null : new Set(scope) };

    const shifts = teamWorld(request.now).shifts.filter((shift) => {
      const day = shiftReportDay(shift.startedAt, shift.endedAt);
      return day >= firstDay && day <= lastDay && shift.pages.some((page) => page.messages > 0 && pages.includes(page.pageLabel));
    });
    const people = [...new Map(shifts.map((shift) => [shift.user.id, { userId: shift.user.id, name: shift.user.name }])).values()]
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
    const chosen = Number.isNaN(userParam) ? shifts : shifts.filter((shift) => shift.user.id === userParam);
    const reports = chosen.map((shift) => itemOf(request, shift, pages, cut, viewer.id))
      .sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.startedAt.localeCompare(a.startedAt));
    const dates = [...new Set(reports.map((item) => item.reportDate))];
    return {
      from: firstDay,
      to: lastDay,
      days: dates.map((date) => ({ date, ...tallyOf(reports.filter((item) => item.reportDate === date)) })),
      totals: tallyOf(reports),
      reports,
      people: people.filter((person) => DEMO_USERS.some((user) => user.id === person.userId)),
      serverNow: request.now.toISOString(),
    };
  },
};
