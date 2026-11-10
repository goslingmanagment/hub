import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { demoError, iso, queryString, type DemoReply, type DemoRequest } from "../core.ts";
import { demoUserByRole } from "../world.ts";
import { addDays, chatterWorld, mskDay, DAY_MS, MINUTE_MS, type DemoSale, type DemoShift } from "./account-model.ts";

/**
 * «Отчёт смены» in the cabinet (`accountReports`): the chatter's shift reports
 * as the agency ledger keeps them, made from the same shifts and sales as
 * «Статистика» (account-model.ts). The newest is a draft recomputed once (two
 * versions); in the third the chatter's second page was not open, so it stands
 * at zero, its sales are held out and an amount added by hand sits beside them;
 * a sale in an overlap with a colleague's shift is held out everywhere. The two
 * newest are drafts, older reports are posted. Invented data only.
 */

type Reports = KernelOperationResponse<"accountReports">;
type Report = Reports["reports"][number];
type Line = Report["lines"][number];

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 62;
const STEP_MS = 5 * MINUTE_MS;

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
  lines.forEach((line, position) => { line.n = position + 1; });
  const counted = lines.filter((line) => line.counted);
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
    status: index < 2 ? "draft" : "posted",
    totalMills: counted.reduce((total, line) => total + line.netMills, 0),
    // The second version of the newest was composed again after a late sale was checked.
    savedAt: iso(new Date(Math.min(now, end - 6 * MINUTE_MS + (versions > 1 ? 41 * MINUTE_MS : 0)))),
    pages: pages.map((page) => ({
      pageLabel: page,
      amountMills: counted.filter((line) => line.pageLabel === page).reduce((total, line) => total + line.netMills, 0),
    })),
    lines,
  };
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
    .map((shift, index) => reportOf(shift, index, world.user.pages, world.now))
    .filter((report) => report.reportDate >= from && report.reportDate <= to);
  return { from, to, reports };
}
