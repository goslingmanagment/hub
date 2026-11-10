/**
 * The chatter's own shift reports in the cabinet («Отчёт смены», owner 2026-11-10):
 * the agent's breakdown of each report as the agency ledger keeps it — the
 * pages and their amounts, the sales counted and the ones held out, and why.
 * Hub's server reads the ledger's GET /v1/reports for the caller only (the user
 * comes from the session, never the query) and passes it on, micro-dollars
 * turned into mills. Sales only: no rates, pay, payouts or debt reach a
 * chatter's session. 503 — the ledger is not connected or did not answer.
 */
import { z } from "zod";

import { businessDate, errorResponseSchema, intId, isoTimestamp, mills } from "./primitives.ts";

/** The ledger's widest window of one read of reports. */
export const ACCOUNT_REPORTS_MAX_DAYS = 62;
/** The window without a query: the last 14 Moscow days, today included. */
export const ACCOUNT_REPORTS_DEFAULT_DAYS = 14;

export const accountReportsQuerySchema = z.object({
  /** Report dates (the Moscow day a shift started), both included; `to` is today and `from` 13 days before it without them. */
  from: businessDate.optional(),
  to: businessDate.optional(),
});

export const accountReportLineSchema = z.object({
  /** The line's number in the report; null — the ledger gave none. */
  n: z.number().int().nullable(),
  pageLabel: z.string(),
  fanRef: z.string(),
  fanName: z.string(),
  /** Hub's transaction type: message_purchase, subscription, tip, post_purchase, stream_tip, … */
  kind: z.string(),
  /** null — an amount added by hand has no moment. */
  occurredAt: isoTimestamp.nullable(),
  netMills: mills,
  /** In the page's amount; false — held out, `flags` say why. */
  counted: z.boolean(),
  /** Added by hand (outside the shift window or outside Hub); `what` explains it. */
  added: z.boolean(),
  what: z.string(),
  /** Why a sale was held out, in the agent's words. */
  flags: z.array(z.string()),
  notes: z.array(z.string()),
  /** Who sent the PPV and when, as the agent read it; empty — not a PPV or not known. */
  ppvAuthor: z.string(),
  ppvSentAt: z.string(),
});

export const accountReportSchema = z.object({
  id: intId,
  /** The Moscow day the shift started. */
  reportDate: businessDate,
  /** The shift's window and the moment the sales were cut off. */
  windowFrom: isoTimestamp,
  windowTo: isoTimestamp,
  cutAt: isoTimestamp,
  /** The current version and how many the agent composed. */
  version: z.number().int().positive(),
  versions: z.number().int().positive(),
  /** draft — composed by the agent; posted — the chatter published it; superseded — replaced. */
  status: z.string(),
  totalMills: mills,
  /** When this version was composed. */
  savedAt: isoTimestamp,
  pages: z.array(z.object({ pageLabel: z.string(), amountMills: mills })),
  lines: z.array(accountReportLineSchema),
});

export const accountReportsResponseSchema = z.object({
  from: businessDate,
  to: businessDate,
  /** The newest first. */
  reports: z.array(accountReportSchema),
});

export type AccountReportsQuery = z.infer<typeof accountReportsQuerySchema>;
export type AccountReportsResponse = z.infer<typeof accountReportsResponseSchema>;
export type AccountReport = z.infer<typeof accountReportSchema>;
export type AccountReportLine = z.infer<typeof accountReportLineSchema>;

export const accountReportsRouteSchemas = {
  accountReports: {
    auth: { kind: "any-session" },
    tags: ["client"],
    summary: "The caller's own shift reports from the agency ledger: pages, amounts, sales counted and held out",
    description: "The chatter's cabinet; read-only. Read from the ledger's GET /v1/reports with Hub's payouts key for "
      + "the session's user only. Report dates are Moscow days, at most 62; without a query the last 14. Sales only, "
      + "no pay. 503 when the ledger is not connected or did not answer.",
    querystring: accountReportsQuerySchema,
    response: {
      200: accountReportsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
} as const;
