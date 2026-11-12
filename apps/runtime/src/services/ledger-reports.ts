import { z } from "zod";

import {
  ACCOUNT_REPORTS_DEFAULT_DAYS,
  ACCOUNT_REPORTS_MAX_DAYS,
  businessDate,
  type AccountReport,
  type AccountReportsQuery,
  type AccountReportsResponse,
  type AccountShiftReport,
  type TeamLedgerReportPage,
} from "@agency_hub_core/contracts";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";

import { requireSessionUser, type AuthPrincipal } from "./auth.ts";
import { ServiceUnavailableError } from "./errors.ts";
import { checkWindow, ledgerGet, list, micros, millsOf, type LedgerReadApp } from "./ledger-payouts.ts";

/**
 * Workboard «Мои смены» from the agency ledger (owner, 2026-11-10): the caller's own shift reports, one per report
 * date — the agent's draft (GET /v1/reports), the chatter's post in «Отчётность» page by page (GET /v1/report-days),
 * or both. The post is the report that counts: a report's one number is what the chatter published, the draft's total
 * stands beside it. Hub's server reads both with its payouts key, for the session's user only — the id and the
 * username come from the principal, never from the request — and keeps only what it can prove is that user's: the
 * drafts by their Hub user id (or name), the day rows by being one person's, the drafts' person. Sales only: the
 * ledger's people, models, transactions, gross amounts and decisions stay behind; nothing about pay reaches a
 * chatter's session. A changed shape of the drafts is a 503; the posts failing alone leave the drafts (`postsRead`).
 */

const DAY_MS = 86_400_000;

/** A text the screen shows; the ledger may leave it out or null. */
const text = z.string().nullish().transform((value) => value ?? "");
/** A list of texts; Go writes an empty one as null. */
const texts = z.array(z.string()).nullish().transform((value): string[] => value ?? []);
const nullable = <T extends z.ZodTypeAny>(item: T) => item.nullish().transform((value): z.output<T> | null => value ?? null);

/**
 * One report as the ledger's GET /v1/reports serves it — the shape the chatter's screen and the owner's «Отчёты»
 * (ledger-team-reports.ts) both read. What only the owner's screen uses (whose, the posted side) may be absent.
 */
export const ledgerReportSchema = z.object({
  id: z.number().int().positive(),
  person: z.string().nullish().transform((value) => value ?? null),
  hub_username: text,
  hub_user_id: z.number().int().nullish().transform((value) => value ?? null),
  chatter: text,
  report_date: businessDate,
  window_from: z.string(),
  window_to: z.string(),
  cut_at: z.string(),
  version: z.number().int().positive(),
  versions: z.number().int().positive(),
  status: z.string(),
  total_micros: micros,
  created_at: z.string(),
  posted_at: z.string().nullish().transform((value) => value ?? null),
  pages: list(z.object({
    page: z.string(),
    model: text,
    amount_micros: micros,
    posted_micros: micros.nullish().transform((value) => value ?? null),
    post_state: text,
  })),
  lines: list(z.object({
    n: z.number().int().nullish().transform((value) => value ?? null),
    page: text,
    fan_ref: text,
    fan_name: text,
    kind: text,
    occurred_at: z.string().nullish().transform((value) => value ?? null),
    net_micros: micros,
    counted: z.boolean(),
    added: z.boolean(),
    what: text,
    flags: texts,
    notes: texts,
    ppv_author: text,
    ppv_sent_at: text,
  })),
});

export type LedgerReport = z.output<typeof ledgerReportSchema>;

const ledgerReportsSchema = z.object({
  from: z.string(),
  to: z.string(),
  reports: list(ledgerReportSchema),
});

/**
 * The ledger's GET /v1/report-days: the pay base page by page — what each person posted in «Отчётность» and what the
 * agent drafted, and how they compare. The rows carry the ledger's code of the person, never a Hub user id.
 */
const ledgerReportDaysSchema = z.object({
  from: z.string(),
  to: z.string(),
  days: list(z.object({
    person: z.string(),
    report_date: businessDate,
    page: z.string(),
    model: text,
    posted_micros: nullable(micros),
    draft_micros: nullable(micros),
    diff_micros: nullable(micros),
    state: z.string(),
    posted_at: nullable(z.string()),
    report_id: nullable(z.number().int().positive()),
    post_id: nullable(z.number().int().positive()),
    // The report handed in in Hub for the person and day (ledger#82; an older ledger sends none): its page, how the post
    // compares, what the day accrues from.
    hub_micros: nullable(micros).optional().default(null),
    hub_diff_micros: nullable(micros).optional().default(null),
    hub_state: nullable(z.string()).optional().default(null),
    basis: nullable(z.string()).optional().default(null),
    accrue_micros: nullable(micros).optional().default(null),
  })),
});

export type LedgerReportDay = z.output<typeof ledgerReportDaysSchema>["days"][number];

/**
 * A report as a chatter sees it (and the owner, opened): the pages and their amounts, the sales counted and held out,
 * in mills. Sales only — the ledger's people, models, the posted side, transactions, gross and decisions stay behind.
 */
export function accountReportOf(report: LedgerReport): AccountReport {
  return {
    id: report.id,
    reportDate: report.report_date,
    windowFrom: report.window_from,
    windowTo: report.window_to,
    cutAt: report.cut_at,
    version: report.version,
    versions: report.versions,
    status: report.status,
    totalMills: millsOf(report.total_micros),
    savedAt: report.created_at,
    pages: report.pages.map((page) => ({ pageLabel: page.page, amountMills: millsOf(page.amount_micros) })),
    lines: report.lines.map((line) => ({
      n: line.n,
      pageLabel: line.page,
      fanRef: line.fan_ref,
      fanName: line.fan_name,
      kind: line.kind,
      occurredAt: line.occurred_at,
      netMills: millsOf(line.net_micros),
      counted: line.counted,
      added: line.added,
      what: line.what,
      flags: line.flags,
      notes: line.notes,
      ppvAuthor: line.ppv_author,
      ppvSentAt: line.ppv_sent_at,
    })),
  };
}

/** A read's answer, checked: a changed shape is a 503, and the log says what changed. */
function checked<T extends z.ZodTypeAny>(app: Pick<LedgerReadApp, "logger">, schema: T, body: unknown, path: string, what: string): z.output<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    app.logger.warn({ issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`) }, `${what}: unexpected answer`);
    throw new ServiceUnavailableError(`The ledger's GET ${path} answered in a shape Hub does not know`);
  }
  return parsed.data as z.output<T>;
}

/** The ledger's GET /v1/reports answer, checked: a changed shape is a 503, and the log says what changed. */
export function parseLedgerReports(app: Pick<LedgerReadApp, "logger">, body: unknown) {
  return checked(app, ledgerReportsSchema, body, "/v1/reports", "ledger reports");
}

/** The ledger's GET /v1/report-days answer, checked the same way. */
export function parseLedgerReportDays(app: Pick<LedgerReadApp, "logger">, body: unknown): LedgerReportDay[] {
  return checked(app, ledgerReportDaysSchema, body, "/v1/report-days", "ledger report days").days;
}

/** One page of a report day in mills: posted, drafted, and the difference when the chatter changed it. */
export function reportPageOf(day: LedgerReportDay): TeamLedgerReportPage {
  const posted = day.posted_micros === null ? null : millsOf(day.posted_micros);
  const draft = day.draft_micros === null ? null : millsOf(day.draft_micros);
  const diff = day.diff_micros !== null ? millsOf(day.diff_micros) : posted !== null && draft !== null ? posted - draft : null;
  return {
    pageLabel: day.page,
    model: day.model,
    postedMills: posted,
    draftMills: draft,
    diffMills: diff === 0 ? null : diff,
    state: day.state,
    postedAt: day.posted_at,
    hubMills: day.hub_micros === null ? null : millsOf(day.hub_micros),
    hubState: day.hub_state,
    basis: day.basis,
  };
}

/** A draft's own pages in the pay base's words, when the pay base has none of its day. */
export function draftPages(draft: LedgerReport): TeamLedgerReportPage[] {
  return draft.pages.map((page) => {
    const amount = millsOf(page.amount_micros);
    const posted = page.posted_micros === null ? null : millsOf(page.posted_micros);
    const diff = posted === null ? null : posted - amount;
    return {
      pageLabel: page.page,
      model: page.model,
      postedMills: posted,
      draftMills: amount,
      diffMills: diff === 0 ? null : diff,
      state: page.post_state !== "" ? page.post_state : posted === null ? "draft_only" : diff === 0 ? "posted_equal" : "posted_changed",
      postedAt: posted === null ? null : draft.posted_at,
      hubMills: null,
      hubState: null,
      basis: null,
    };
  });
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The asked window, or the last 14 Moscow days ending today; at most 62 days, else a 400. */
export function reportsWindow(query: AccountReportsQuery, now: Date): { from: string; to: string } {
  const to = query.to ?? toBusinessDate(now, MOSCOW_TIME_ZONE);
  const from = query.from ?? addDays(to, -(ACCOUNT_REPORTS_DEFAULT_DAYS - 1));
  checkWindow(from, to, ACCOUNT_REPORTS_MAX_DAYS);
  return { from, to };
}

/** The report is this user's: their Hub id, or — when the ledger knows no id — their username, case aside. */
function belongsTo(report: LedgerReport, user: { id: number; username: string }): boolean {
  if (report.hub_user_id !== null) return report.hub_user_id === user.id;
  return report.hub_username.trim().toLowerCase() === user.username.trim().toLowerCase();
}

/**
 * A draft's pages with what the pay base says of them: a page of the day rows replaces the draft's own (the rows are
 * the posts as the ledger read them), a page only the rows have (posted, not drafted) joins; a draft's page the rows
 * do not name keeps the draft's own word (a page at zero too).
 */
function mergedPages(draft: LedgerReport | null, rows: readonly TeamLedgerReportPage[]): TeamLedgerReportPage[] {
  const pages = draft === null ? [] : draftPages(draft);
  for (const row of rows) {
    const at = pages.findIndex((page) => page.pageLabel === row.pageLabel);
    if (at >= 0) pages[at] = row;
    else pages.push(row);
  }
  return pages;
}

/** One report date's report: its draft, its pages, the one number. null — neither a draft nor a posted page. */
function shiftReportOf(reportDate: string, draft: LedgerReport | null, rows: readonly TeamLedgerReportPage[]): AccountShiftReport | null {
  const pages = mergedPages(draft, rows);
  const posted = pages.filter((page) => page.postedMills !== null);
  if (draft === null && posted.length === 0) return null;
  const base = draft === null ? null : accountReportOf(draft);
  const isPosted = posted.length > 0;
  const postedAt = isPosted
    ? posted.map((page) => page.postedAt).filter((at): at is string => at !== null).sort().at(-1) ?? draft?.posted_at ?? null
    : null;
  return {
    source: base === null ? "post" : isPosted ? "both" : "draft",
    id: base?.id ?? null,
    reportDate,
    windowFrom: base?.windowFrom ?? null,
    windowTo: base?.windowTo ?? null,
    cutAt: base?.cutAt ?? null,
    version: base?.version ?? null,
    versions: base?.versions ?? null,
    status: isPosted ? "posted" : base?.status ?? "posted",
    // What the chatter published: the posted pages; a page left out of the post adds nothing.
    totalMills: isPosted ? posted.reduce((total, page) => total + (page.postedMills ?? 0), 0) : base?.totalMills ?? 0,
    draftTotalMills: base?.totalMills ?? null,
    savedAt: base?.savedAt ?? null,
    postedAt,
    pages: pages.map((page) => ({
      pageLabel: page.pageLabel,
      amountMills: isPosted ? page.postedMills ?? 0 : page.draftMills ?? 0,
      draftMills: page.draftMills,
      postedMills: page.postedMills,
      postState: page.state,
    })),
    lines: base?.lines ?? [],
  };
}

/**
 * The caller's reports: the day rows of each report date with its draft — by the rows' report id, else by the date. A
 * date with posted rows and no draft is a post written by hand; a second draft of one date stays a report of its own.
 */
function shiftReportsOf(drafts: readonly LedgerReport[], days: readonly LedgerReportDay[]): AccountShiftReport[] {
  const draftById = new Map(drafts.map((draft) => [draft.id, draft]));
  const dates = new Map<string, { rows: TeamLedgerReportPage[]; draftId: number | null }>();
  for (const day of days) {
    let date = dates.get(day.report_date);
    if (!date) {
      date = { rows: [], draftId: null };
      dates.set(day.report_date, date);
    }
    date.rows.push(reportPageOf(day));
    if (date.draftId === null && day.report_id !== null && draftById.has(day.report_id)) date.draftId = day.report_id;
  }
  const attached = new Set([...dates.values()].flatMap((date) => (date.draftId === null ? [] : [date.draftId])));
  const alone: LedgerReport[] = [];
  for (const draft of drafts) {
    if (attached.has(draft.id)) continue;
    const date = dates.get(draft.report_date);
    if (date && date.draftId === null) {
      date.draftId = draft.id;
      attached.add(draft.id);
    } else {
      alone.push(draft);
    }
  }
  const reports = [
    ...[...dates.entries()].map(([reportDate, date]) => shiftReportOf(reportDate, date.draftId === null ? null : draftById.get(date.draftId) ?? null, date.rows)),
    ...alone.map((draft) => shiftReportOf(draft.report_date, draft, [])),
  ];
  return reports.filter((report): report is AccountShiftReport => report !== null);
}

const newestFirst = (left: AccountShiftReport, right: AccountShiftReport) => right.reportDate.localeCompare(left.reportDate)
  || (right.windowFrom === null ? 0 : Date.parse(right.windowFrom)) - (left.windowFrom === null ? 0 : Date.parse(left.windowFrom))
  || (right.id ?? 0) - (left.id ?? 0);

export async function readAccountReports(
  app: LedgerReadApp,
  principal: AuthPrincipal,
  query: AccountReportsQuery,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<AccountReportsResponse> {
  requireSessionUser(principal);
  const user = { id: principal.user.id, username: principal.user.username };
  const window = reportsWindow(query, options.now ?? new Date());
  const params = { from: window.from, to: window.to, hub_user_id: String(user.id), hub_username: user.username };
  const read = { client: "account-reports", ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) };
  const [reportsBody, readDays] = await Promise.all([
    ledgerGet(app, "/v1/reports", params, read),
    // The posts failing alone leave the drafts: the screen says so once, and claims no shift has none.
    ledgerGet(app, "/v1/report-days", params, read)
      .then((body) => parseLedgerReportDays(app, body))
      .catch((error: unknown) => {
        if (!(error instanceof ServiceUnavailableError)) throw error;
        app.logger.warn({ userId: user.id, reason: error.message }, "ledger report days: not read, the drafts alone are served");
        return null;
      }),
  ]);
  const answer = parseLedgerReports(app, reportsBody);

  // The ledger filters by the user already; a report of someone else in the answer never reaches the screen.
  const own = answer.reports.filter((report) => belongsTo(report, user));
  const dropped = answer.reports.length - own.length;
  if (dropped > 0) app.logger.warn({ userId: user.id, dropped }, "ledger reports: the answer held reports of another user, dropped");

  // The day rows carry no Hub user id: they are kept only as one person's, the one the caller's drafts are of — and
  // never a person a draft of someone else in the answer is of.
  let days = readDays;
  if (days !== null && days.length > 0) {
    const persons = new Set([...days.map((day) => day.person), ...own.flatMap((report) => (report.person === null ? [] : [report.person]))]);
    const others = new Set(answer.reports.filter((report) => !belongsTo(report, user)).flatMap((report) => (report.person === null ? [] : [report.person])));
    if (persons.size > 1 || [...persons].some((person) => others.has(person))) {
      app.logger.warn({ userId: user.id, persons: persons.size }, "ledger report days: the answer held more than one person, dropped; the drafts alone are served");
      days = null;
    }
  }

  const reports = shiftReportsOf(own, days ?? []).sort(newestFirst);
  return { from: window.from, to: window.to, reports, postsRead: days !== null };
}
