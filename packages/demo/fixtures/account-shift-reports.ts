import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { demoError, queryString, type DemoReply, type DemoRequest } from "../core.ts";
import { demoUserByRole } from "../world.ts";
import { addDays, chatterWorld, DAY_MS } from "./account-model.ts";
import { reportWithoutShift } from "./account-reports.ts";
import { demoReportDays, type DemoReportDay } from "./team-reports.ts";

/**
 * A chatter's shift reports as Hub serves them to «Мои смены» (`accountReports`): one per report date — the agent's
 * draft (account-reports.ts), the chatter's post in «Отчётность», or both — exactly the report days the owner sees in
 * «Выплаты → Отчёты» (team-reports.ts), so a chatter and the owner see one report. The demo chatter's walk every
 * state of the screen: a draft not posted yet (the newest ended shift), a sum changed in the post (the one before),
 * a shift with nothing (the fourth), a report posted in part (a page the ledger did not recognise, the fifth), a
 * report written by hand (the sixth), the rest posted as drafted, and a report of a day Hub saw no shift on.
 *
 * Invented data only.
 */

type Reports = KernelOperationResponse<"accountReports">;
type Report = Reports["reports"][number];
type Draft = NonNullable<DemoReportDay["draft"]>;

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 62;

/** One report day as the chatter's report: the one number is what was posted, the draft's total beside it. */
function reportOfDay(date: string, draft: Draft | null, pages: DemoReportDay["pages"]): Report {
  const posted = pages.filter((page) => page.postedMills !== null);
  const isPosted = posted.length > 0;
  return {
    source: draft === null ? "post" : isPosted ? "both" : "draft",
    id: draft?.id ?? null,
    reportDate: date,
    windowFrom: draft?.windowFrom ?? null,
    windowTo: draft?.windowTo ?? null,
    cutAt: draft?.cutAt ?? null,
    version: draft?.version ?? null,
    versions: draft?.versions ?? null,
    status: isPosted ? "posted" : draft?.status ?? "posted",
    totalMills: isPosted ? posted.reduce((sum, page) => sum + (page.postedMills ?? 0), 0) : draft?.totalMills ?? 0,
    draftTotalMills: draft?.totalMills ?? null,
    savedAt: draft?.savedAt ?? null,
    postedAt: posted.map((page) => page.postedAt).filter((at): at is string => at !== null).sort().at(-1) ?? null,
    pages: pages.map((page) => ({
      pageLabel: page.pageLabel,
      amountMills: isPosted ? page.postedMills ?? 0 : page.draftMills ?? 0,
      draftMills: page.draftMills,
      postedMills: page.postedMills,
      postState: page.state,
    })),
    lines: draft?.lines ?? [],
  };
}

export function accountReports(request: DemoRequest): Reports | DemoReply {
  const fromQuery = queryString(request, "from");
  const toQuery = queryString(request, "to");
  if ((fromQuery !== undefined && !BUSINESS_DATE.test(fromQuery)) || (toQuery !== undefined && !BUSINESS_DATE.test(toQuery))) {
    return demoError(400, "Bad Request", "`from` and `to` must be dates YYYY-MM-DD");
  }
  const user = demoUserByRole(request.role);
  const world = chatterWorld(user, request.now);
  const to = toQuery ?? world.today;
  const from = fromQuery ?? addDays(to, -13);
  if (from > to) return demoError(400, "Bad Request", "from is after to");
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) >= MAX_DAYS * DAY_MS) {
    return demoError(400, "Bad Request", `At most ${MAX_DAYS} days`);
  }
  const reports = demoReportDays(request.now)
    .filter((day) => day.user.id === user.id)
    .map((day) => reportOfDay(day.date, day.draft, day.pages));
  // The day Hub saw no shift on: posted as the agent composed it.
  const alone = reportWithoutShift(world);
  if (alone !== null) {
    reports.push(reportOfDay(alone.reportDate, alone, alone.pages.map((page) => ({
      pageLabel: page.pageLabel, model: "", postedMills: page.amountMills, draftMills: page.amountMills, diffMills: null, state: "posted_equal", postedAt: alone.savedAt,
    }))));
  }
  const inRange = reports
    .filter((report) => report.reportDate >= from && report.reportDate <= to)
    // The newest first, as Hub sends them.
    .sort((left, right) => right.reportDate.localeCompare(left.reportDate)
      || (right.windowFrom === null ? 0 : Date.parse(right.windowFrom)) - (left.windowFrom === null ? 0 : Date.parse(left.windowFrom)));
  return { from, to, reports: inRange, postsRead: true };
}
