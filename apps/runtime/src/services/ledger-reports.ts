import { z } from "zod";

import {
  ACCOUNT_REPORTS_DEFAULT_DAYS,
  ACCOUNT_REPORTS_MAX_DAYS,
  businessDate,
  type AccountReportsQuery,
  type AccountReportsResponse,
} from "@agency_hub_core/contracts";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";

import { requireSessionUser, type AuthPrincipal } from "./auth.ts";
import { ServiceUnavailableError } from "./errors.ts";
import { checkWindow, ledgerGet, list, micros, millsOf, type LedgerReadApp } from "./ledger-payouts.ts";

/**
 * The cabinet's «Отчёт смены» from the agency ledger (owner, 2026-11-10): the
 * caller's own shift reports as the team's chat agent composed them. Hub's
 * server reads the ledger's GET /v1/reports with its payouts key, for the
 * session's user only — the id and the username come from the principal, never
 * from the request — and keeps only that user's reports of the answer, whatever
 * the ledger sent. Sales only: the ledger's people, transactions, gross amounts
 * and decisions stay behind; nothing about pay reaches a chatter's session.
 * The answer is checked field by field: a changed shape is a 503.
 */

const DAY_MS = 86_400_000;

/** A text the screen shows; the ledger may leave it out or null. */
const text = z.string().nullish().transform((value) => value ?? "");
/** A list of texts; Go writes an empty one as null. */
const texts = z.array(z.string()).nullish().transform((value): string[] => value ?? []);

const ledgerReportsSchema = z.object({
  from: z.string(),
  to: z.string(),
  reports: list(z.object({
    id: z.number().int().positive(),
    hub_username: text,
    hub_user_id: z.number().int().nullish().transform((value) => value ?? null),
    report_date: businessDate,
    window_from: z.string(),
    window_to: z.string(),
    cut_at: z.string(),
    version: z.number().int().positive(),
    versions: z.number().int().positive(),
    status: z.string(),
    total_micros: micros,
    created_at: z.string(),
    pages: list(z.object({ page: z.string(), amount_micros: micros })),
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
  })),
});

type LedgerReport = z.output<typeof ledgerReportsSchema>["reports"][number];

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

export async function readAccountReports(
  app: LedgerReadApp,
  principal: AuthPrincipal,
  query: AccountReportsQuery,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<AccountReportsResponse> {
  requireSessionUser(principal);
  const user = { id: principal.user.id, username: principal.user.username };
  const window = reportsWindow(query, options.now ?? new Date());
  const body = await ledgerGet(
    app,
    "/v1/reports",
    { from: window.from, to: window.to, hub_user_id: String(user.id), hub_username: user.username },
    { client: "account-reports", ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) },
  );
  const parsed = ledgerReportsSchema.safeParse(body);
  if (!parsed.success) {
    app.logger.warn({ issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`) }, "ledger reports: unexpected answer");
    throw new ServiceUnavailableError("The ledger's GET /v1/reports answered in a shape Hub does not know");
  }

  // The ledger filters by the user already; a report of someone else in the answer never reaches the screen.
  const own = parsed.data.reports.filter((report) => belongsTo(report, user));
  const dropped = parsed.data.reports.length - own.length;
  if (dropped > 0) app.logger.warn({ userId: user.id, dropped }, "ledger reports: the answer held reports of another user, dropped");

  const reports = own
    .map((report) => ({
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
    }))
    // The newest first: by the shift's day, then its window, then the ledger's order.
    .sort((left, right) => right.reportDate.localeCompare(left.reportDate)
      || Date.parse(right.windowFrom) - Date.parse(left.windowFrom)
      || right.id - left.id);
  return { from: window.from, to: window.to, reports };
}
