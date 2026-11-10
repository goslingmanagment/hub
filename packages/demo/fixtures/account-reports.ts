import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { demoError, iso, mills, queryString, type DemoReply, type DemoRequest } from "../core.ts";
import { demoFans, demoUserByRole } from "../world.ts";
import { addDays, chatterWorld, mskDay, mskMidnight, DAY_MS, HOUR_MS, MINUTE_MS, type DemoChatterWorld, type DemoSale, type DemoShift } from "./account-model.ts";

/**
 * A chatter's shift reports as the agency ledger keeps them (`accountReports`):
 * Workboard's «Мои смены» joins them to the shifts of `accountChatterStats`, so
 * both are made from the same working life (account-model.ts) — the same days,
 * a report's window the shift's own. The demo walks every state of the screen:
 *
 * - the newest ended shift: a draft the agent composed twice (version 2 of 2) —
 *   «проверь и отправь»;
 * - the one before: posted;
 * - the third: posted, the chatter's second page was not open, so it stands at
 *   zero, its sales are held out with the reason, and an amount added by hand
 *   sits beside them; a sale in an overlap with a colleague's shift is held out
 *   everywhere;
 * - the fourth: no report at all (the chatter did not ask for one);
 * - a day off in Hub with a report of its own: the chatter worked with the
 *   extension switched off — «смена в Hub не найдена»;
 * - older ones are posted; the shift going on has none yet.
 *
 * Invented data only.
 */

type Reports = KernelOperationResponse<"accountReports">;
type Report = Reports["reports"][number];
type Line = Report["lines"][number];

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 62;
const STEP_MS = 5 * MINUTE_MS;
/** The ended shift (newest first, from 0) the chatter never asked a report for. */
const WITHOUT_REPORT = 3;

const round = (at: number) => Math.round(at / STEP_MS) * STEP_MS;

function saleLine(sale: DemoSale, held: string | null, note: string | null): Line {
  return {
    n: null,
    pageLabel: sale.pageLabel,
    fanRef: sale.fan.platformUserId,
    fanName: sale.fanName ?? "",
    kind: sale.reportKind,
    occurredAt: iso(new Date(sale.at)),
    netMills: sale.netMills,
    counted: held === null,
    added: false,
    what: "",
    flags: held === null ? [] : [held],
    notes: note === null ? [] : [note],
    ppvAuthor: "",
    ppvSentAt: "",
  };
}

function finish(lines: Line[], pages: readonly string[]) {
  lines.forEach((line, position) => { line.n = position + 1; });
  const counted = lines.filter((line) => line.counted);
  return {
    totalMills: counted.reduce((total, line) => total + line.netMills, 0),
    pages: pages.map((page) => ({
      pageLabel: page,
      amountMills: counted.filter((line) => line.pageLabel === page).reduce((total, line) => total + line.netMills, 0),
    })),
    lines,
  };
}

function reportOf(shift: DemoShift, index: number, pages: readonly string[], now: number): Report {
  const quietPage = index === 2 && pages.length > 1 ? pages[1]! : null;
  const sales = [...shift.sales].sort((left, right) => left.at - right.at);
  const tip = sales.find((sale) => sale.reportKind === "tip");
  const lines: Line[] = sales.map((sale) => {
    const held = sale.overlap
      ? "в это время шла смена другого чаттера, и фану никто не писал — продажу делит владелец (§4.2)"
      : sale.pageLabel === quietPage ? "страница не была открыта у тебя в это время (§1.4)" : null;
    const note = (index === 0 || index === 2) && sale === tip ? "фан приписал к типу: «спасибо за вчера»" : null;
    return saleLine(sale, held, note);
  });
  if (index === 2) {
    // An amount added by hand: a tip for a PPV of the shift that came before the window opened.
    lines.push({
      n: null, pageLabel: pages[0] ?? "mia-1", fanRef: "", fanName: "", kind: "tip", occurredAt: null, netMills: 12_000,
      counted: true, added: true, what: "тип за ппв этой смены, пришёл за 10 минут до начала окна", flags: [], notes: [],
      ppvAuthor: "", ppvSentAt: "",
    });
  }
  const versions = index === 0 ? 2 : 1;
  const end = round(shift.end);
  return {
    id: Math.floor(shift.start / STEP_MS),
    reportDate: mskDay(shift.start),
    windowFrom: iso(new Date(round(shift.start))),
    windowTo: iso(new Date(end)),
    cutAt: iso(new Date(end - 7 * MINUTE_MS)),
    version: versions,
    versions,
    status: index === 0 ? "draft" : "posted",
    // The second version of the newest was composed again after a late sale was checked.
    savedAt: iso(new Date(Math.min(now, end - 6 * MINUTE_MS + (versions > 1 ? 41 * MINUTE_MS : 0)))),
    ...finish(lines, pages),
  };
}

/**
 * The report of a day Hub saw no shift on: the chatter worked from the phone,
 * the extension switched off, and the agent composed the report from the page's
 * sales. The latest such day at least a few days back, inside the chatter's history.
 */
function reportWithoutShift(world: DemoChatterWorld): Report | null {
  if (world.activitySince === null || world.user.pages.length === 0) return null;
  const worked = new Set(world.shifts.filter((shift) => !shift.visit).flatMap((shift) => [mskDay(shift.start), shift.date]));
  for (let back = 4; back <= 20; back += 1) {
    const day = addDays(world.today, -back);
    if (worked.has(day) || mskMidnight(day) < world.activitySince) continue;
    const page = world.user.pages[0]!;
    const fans = demoFans(page).filter((fan) => fan.totalSpent > 0);
    const start = mskMidnight(day) + 19 * HOUR_MS;
    const end = start + 4 * HOUR_MS + 30 * MINUTE_MS;
    const line = (fanIndex: number, minute: number, kind: string, dollars: number): Line => {
      const fan = fans[fanIndex % Math.max(1, fans.length)];
      return {
        n: null, pageLabel: page, fanRef: fan?.platformUserId ?? "", fanName: fan?.displayName ?? "", kind,
        occurredAt: iso(new Date(start + minute * MINUTE_MS)), netMills: mills(dollars), counted: true, added: false,
        what: "", flags: [], notes: [], ppvAuthor: "", ppvSentAt: "",
      };
    };
    const lines = [line(3, 52, "message_purchase", 19.99 * 0.8), line(11, 164, "tip", 20 * 0.8)];
    lines[0]!.notes.push("расширение было выключено: смену собрали по продажам страницы");
    return {
      id: Math.floor(start / STEP_MS),
      reportDate: day,
      windowFrom: iso(new Date(start)),
      windowTo: iso(new Date(end)),
      cutAt: iso(new Date(end - 7 * MINUTE_MS)),
      version: 1,
      versions: 1,
      status: "posted",
      savedAt: iso(new Date(end + 9 * MINUTE_MS)),
      ...finish(lines, world.user.pages),
    };
  }
  return null;
}

export function accountReports(request: DemoRequest): Reports | DemoReply {
  const fromQuery = queryString(request, "from");
  const toQuery = queryString(request, "to");
  if ((fromQuery !== undefined && !BUSINESS_DATE.test(fromQuery)) || (toQuery !== undefined && !BUSINESS_DATE.test(toQuery))) {
    return demoError(400, "Bad Request", "`from` and `to` must be dates YYYY-MM-DD");
  }
  const world = chatterWorld(demoUserByRole(request.role), request.now);
  const to = toQuery ?? world.today;
  const from = fromQuery ?? addDays(to, -13);
  if (from > to) return demoError(400, "Bad Request", "from is after to");
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) >= MAX_DAYS * DAY_MS) {
    return demoError(400, "Bad Request", `At most ${MAX_DAYS} days`);
  }
  // A report is composed at the end of a shift: the shift going on has none yet.
  const ended = world.shifts.filter((shift) => !shift.visit && !shift.ongoing);
  const reports = ended
    .map((shift, index) => (index === WITHOUT_REPORT ? null : reportOf(shift, index, world.user.pages, world.now)))
    .filter((report): report is Report => report !== null);
  const alone = reportWithoutShift(world);
  if (alone !== null) reports.push(alone);
  const inRange = reports
    .filter((report) => report.reportDate >= from && report.reportDate <= to)
    // The newest first, as Hub sends them.
    .sort((left, right) => right.reportDate.localeCompare(left.reportDate) || Date.parse(right.windowFrom) - Date.parse(left.windowFrom));
  return { from, to, reports: inRange };
}
