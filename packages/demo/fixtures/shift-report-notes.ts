import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { millsRoundedTo, millsToNumber } from "@agency_hub_core/shared";
import { shiftReportDay } from "@agency_hub_core/ui/moscow";

import { demoError, queryNumber, queryString, type DemoHandlers, type DemoReply, type DemoRequest } from "../core.ts";
import { demoPage, demoUserByRole, type DemoUser } from "../world.ts";
import { chatterWorld } from "./account-model.ts";
import { DEMO_RULE_FROM_DAYS } from "./team-stats.ts";
import { addDays, mskDay, teamWorld, viewerPages, workedPages } from "./team-world.ts";

/**
 * What stands between a person's shifts of a day and the report it is paid by (`shiftReportNotes`): the line under a
 * day's last shift on «Смены» and «Мои смены». Hub pairs every line of a person's reports with the sale it pays and
 * says only what is left; the demo says it of the days its reports tell their story of (team-reports.ts,
 * account-reports.ts), by the index of the person's ended report day, the newest from 0.
 *
 * On «Смены» (the team's working life, team-world.ts):
 * - alex.k — the newest day's report is composed and not posted, and a sale came after it was cut: «не в отчёте: 1
 *   продажа»; the day before he raised a page in the post: «в посте иначе: +$15.00»; the third counts an amount he
 *   added by his word: «в отчёте по словам: $12.00»; the fourth has no report at all: nothing;
 * - kate.v — her newest post is changed by hand and two late sales are in no report: both said on one line; the day
 *   before is CLEAN though its two sums differ: the sale that came after the report's cut is paid in the next day's
 *   report as «долёт», so Hub finds its line and the day says nothing; the third has five sales in no report;
 * - den.s — a post lowered by hand: «в посте иначе: −$8.00»; a report written without the agent, no breakdown to
 *   read: the report's sum as before, «в отчёте $…»;
 * - olya.m — one sale in no report; everyone else, and every other day, is clean.
 *
 * On a chatter's own «Мои смены» (the demo chatter is alex.k; their own working life, account-model.ts) the days are
 * those whose report is the post in «Отчётность», older than the days handed in in Hub (shift-reports.ts): a sale in
 * no report, an amount by word, and both on one line. Anyone but the owner reads their own days alone (a team lead of
 * the demo works no shifts: no line).
 * Invented people and amounts only.
 */

type Answer = KernelOperationResponse<"shiftReportNotes">;
type Note = Answer["notes"][number];
type NoteSale = Note["unreported"]["sales"][number];

type Twist =
  /** The day's last `sales` sales came after the report was cut and no later report has them; the post changed by hand, or an amount by word, too. */
  | { kind: "unreported"; sales: number; postApartMills?: number; byWordsMills?: number }
  /** The report counts an amount that is none of the person's sales by the rule. */
  | { kind: "by_words"; mills: number }
  /** The post lies this far from the breakdown saved for it. */
  | { kind: "post_apart"; mills: number }
  /** A post written without the agent: the report's sum, this far from the rule's. */
  | { kind: "sum_only"; deltaMills: number }
  /** A sale came after the report's cut and the next day's report pays it: the sums differ, the day is clean. */
  | { kind: "paid_later" };

type Twists = Readonly<Record<string, Readonly<Record<number, Twist>>>>;

/** «Смены»: whose report day (by the index of the ended day, the newest from 0) says what. */
const TEAM_TWISTS: Twists = {
  "alex.k": { 0: { kind: "unreported", sales: 1 }, 1: { kind: "post_apart", mills: 15_000 }, 2: { kind: "by_words", mills: 12_000 } },
  "kate.v": { 0: { kind: "unreported", sales: 2, postApartMills: 12_500 }, 1: { kind: "paid_later" }, 2: { kind: "unreported", sales: 5 } },
  "den.s": { 2: { kind: "post_apart", mills: -8_000 }, 3: { kind: "sum_only", deltaMills: 23_400 } },
  "olya.m": { 1: { kind: "unreported", sales: 1 } },
};

/** A chatter's own «Мои смены»: the days posted in «Отчётность», past the ones handed in in Hub. */
const OWN_TWISTS: Twists = {
  "alex.k": { 6: { kind: "unreported", sales: 1 }, 7: { kind: "by_words", mills: 12_000 }, 8: { kind: "unreported", sales: 2, byWordsMills: 20_000 }, 9: { kind: "paid_later" } },
};

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;
const cents = (value: number) => millsToNumber(millsRoundedTo(value, "cent"));

/** Hub's transaction type of a demo sale's kind. */
const CANONICAL: Readonly<Record<string, string>> = { ppv: "message_purchase", tip: "tip", subscription: "subscription", post: "post_purchase" };

/** A shift as the notes read it, from either of the demo's working lives. */
interface DayShift {
  user: DemoUser;
  startedAt: number;
  endedAt: number;
  ongoing: boolean;
  sales: NoteSale[];
}

/** The team's shifts as «Смены» shows them on `scope`: a shift's sales are those of the pages it worked. */
function teamShifts(request: DemoRequest, scope: readonly string[]): DayShift[] {
  return teamWorld(request.now).shifts
    .filter((shift) => shift.pages.some((page) => page.messages > 0 && scope.includes(page.pageLabel)))
    .map((shift) => {
      const pages = workedPages(shift);
      return {
        user: shift.user,
        startedAt: shift.startedAt,
        endedAt: shift.endedAt,
        ongoing: shift.ongoing,
        sales: shift.sales
          .filter((sale) => pages.includes(sale.pageLabel) && scope.includes(sale.pageLabel))
          .map((sale) => ({ saleId: Number(sale.ref), occurredAt: new Date(sale.at).toISOString(), pageLabel: sale.pageLabel, kind: CANONICAL[sale.kind] ?? sale.kind, netMills: sale.netMills })),
      };
    });
}

/** A chatter's own shifts as «Мои смены» shows them. */
function ownShifts(request: DemoRequest): DayShift[] {
  const world = chatterWorld(demoUserByRole(request.role), request.now);
  return world.shifts.filter((shift) => !shift.visit).map((shift) => ({
    user: world.user,
    startedAt: shift.start,
    endedAt: shift.end,
    ongoing: shift.ongoing,
    sales: shift.sales.map((sale) => ({ saleId: Number(sale.ref), occurredAt: new Date(sale.at).toISOString(), pageLabel: sale.pageLabel, kind: sale.reportKind, netMills: sale.netMills })),
  }));
}

/** A person-day's note by its twist; null — the day says nothing. */
function noteOf(user: DemoUser, reportDate: string, shifts: readonly DayShift[], twist: Twist | undefined): Note | null {
  if (twist === undefined || twist.kind === "paid_later") return null;
  const sales = shifts.flatMap((shift) => shift.sales).sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  const note: Note = { userIds: [user.id], reportDate, unreported: { count: 0, mills: 0, sales: [] }, byWordsMills: 0, postApartMills: 0, sumOnlyMills: null };
  switch (twist.kind) {
    case "unreported": {
      const late = sales.slice(-twist.sales);
      note.unreported = { count: late.length, mills: late.reduce((sum, sale) => sum + sale.netMills, 0), sales: late };
      note.postApartMills = twist.postApartMills ?? 0;
      note.byWordsMills = twist.byWordsMills ?? 0;
      break;
    }
    case "by_words":
      note.byWordsMills = twist.mills;
      break;
    case "post_apart":
      note.postApartMills = twist.mills;
      break;
    case "sum_only":
      note.sumOnlyMills = cents(sales.reduce((sum, sale) => sum + sale.netMills, 0)) + twist.deltaMills;
      break;
  }
  return note.unreported.count > 0 || note.byWordsMills !== 0 || note.postApartMills !== 0 || note.sumOnlyMills !== null ? note : null;
}

function shiftReportNotes(request: DemoRequest): Answer | DemoReply {
  const days = queryNumber(request, "days", 7);
  if (!Number.isInteger(days) || days < 1 || days > 31) return demoError(400, "Bad Request", "days — целое от 1 до 31.");
  const until = queryString(request, "until");
  if (until !== undefined && !BUSINESS_DATE.test(until)) return demoError(400, "Bad Request", "until — день в формате YYYY-MM-DD.");
  // As Hub: everyone's days for the owner; one's own for a team lead, a chatter and a narrow session.
  const scope = request.narrow || request.role !== "owner" ? null : viewerPages(request);
  const pageLabel = queryString(request, "pageLabel");
  if (pageLabel !== undefined) {
    if (!demoPage(pageLabel)) return demoError(404, "Not Found", `Страницы «${pageLabel}» нет.`);
    if (!(scope ?? demoUserByRole(request.role).pages).includes(pageLabel)) return demoError(403, "Forbidden", `Страница «${pageLabel}» вам не назначена.`);
  }
  // The window of «Смены»: it ends on `until` (today by default, never leaving today out).
  const today = mskDay(request.now.getTime());
  const latest = addDays(today, days - 1);
  const asked = until ?? today;
  const to = asked > latest ? latest : asked;
  const from = addDays(to, -(days - 1));
  const ruleFrom = addDays(today, -DEMO_RULE_FROM_DAYS);

  const shifts = scope === null ? ownShifts(request) : teamShifts(request, pageLabel === undefined ? scope : [pageLabel]);
  const twists = scope === null ? OWN_TWISTS : TEAM_TWISTS;
  const byPerson = new Map<number, Map<string, DayShift[]>>();
  for (const shift of shifts) {
    const day = shiftReportDay(shift.startedAt, shift.endedAt);
    const person = byPerson.get(shift.user.id) ?? new Map<string, DayShift[]>();
    person.set(day, [...(person.get(day) ?? []), shift]);
    byPerson.set(shift.user.id, person);
  }
  const notes: Note[] = [];
  for (const person of byPerson.values()) {
    // The person's ended report days, the newest first: a day whose shift still goes on is not one yet.
    const ended = [...person].filter(([, list]) => list.every((shift) => !shift.ongoing)).sort(([left], [right]) => right.localeCompare(left));
    ended.forEach(([reportDate, list], index) => {
      // A day before the window's first belongs to it when its night's row does (the screen places a note by its row).
      if (reportDate < addDays(from, -1) || reportDate > to || reportDate < ruleFrom) return;
      const user = list[0]!.user;
      const note = noteOf(user, reportDate, list, twists[user.username]?.[index]);
      if (note !== null) notes.push(note);
    });
  }
  notes.sort((left, right) => right.reportDate.localeCompare(left.reportDate) || left.userIds[0]! - right.userIds[0]!);
  return { from, to, ruleFrom, notes, serverNow: request.now.toISOString() };
}

export const shiftReportNoteHandlers: DemoHandlers = { shiftReportNotes };
