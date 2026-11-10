/**
 * The chatter's own shift reports (Workboard «Мои смены», owner 2026-11-10): one
 * report per report date, as the agency ledger keeps it — the agent's draft (the
 * pages and their amounts, the sales counted and the ones held out, and why), the
 * chatter's post in «Отчётность», or both. The post is the report that counts:
 * a report's one number is what the chatter published. Hub's server reads the
 * ledger's GET /v1/reports and GET /v1/report-days for the caller only (the user
 * comes from the session, never the query) and passes them on, micro-dollars
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

/** The agent's draft of a shift report, as the ledger's GET /v1/reports keeps it (the owner's «Отчёты» carry it as `draft`). */
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

/** One page of a chatter's report: as posted, as drafted, and how they compare. */
export const accountShiftReportPageSchema = z.object({
  pageLabel: z.string(),
  /** What the page adds to the report's one number (`totalMills`): its posted amount when the report is posted (0 — the page was left out of the post), else the draft's. */
  amountMills: mills,
  /** The agent's draft of the page; null — not in a draft (written without the agent). */
  draftMills: mills.nullable(),
  /** The page in the chatter's post; null — not posted. */
  postedMills: mills.nullable(),
  /** posted_equal · posted_changed (the chatter changed the amount) · post_only (no draft) · draft_only (not posted); another value as the ledger wrote it. */
  postState: z.string(),
});

/**
 * A chatter's report of one report date: the agent's draft, the chatter's post in «Отчётность», or both. The draft's
 * fields (id, window, version, the sales) are null or empty for a post written without the agent.
 */
export const accountShiftReportSchema = accountReportSchema.extend({
  /** draft — composed, not posted yet; post — posted without a draft (written by hand); both — a draft and its post. */
  source: z.enum(["draft", "post", "both"]),
  /** The draft's id; null — a post without a draft. */
  id: intId.nullable(),
  /** The shift's window and the moment the sales were cut off, from the draft; null — no draft. */
  windowFrom: isoTimestamp.nullable(),
  windowTo: isoTimestamp.nullable(),
  cutAt: isoTimestamp.nullable(),
  version: z.number().int().positive().nullable(),
  versions: z.number().int().positive().nullable(),
  /** posted for a post; else the draft's (draft · posted · superseded · another as the ledger wrote it). */
  status: z.string(),
  /** The report's one number: what the chatter posted (the posted pages added up) once any page is posted, else the draft's total. */
  totalMills: mills,
  /** The draft's total; null — no draft. */
  draftTotalMills: mills.nullable(),
  /** When the draft was composed; null — no draft. */
  savedAt: isoTimestamp.nullable(),
  /** When the post was sent (the latest that touched a page); null — not posted. */
  postedAt: isoTimestamp.nullable(),
  pages: z.array(accountShiftReportPageSchema),
});

export const accountReportsResponseSchema = z.object({
  from: businessDate,
  to: businessDate,
  /** One per report date (two drafts of one date stay two), the newest first. */
  reports: z.array(accountShiftReportSchema),
  /**
   * false — the posts did not come (the ledger's GET /v1/report-days failed, or answered rows Hub could not prove are
   * the caller's): the reports are the agent's drafts alone, and a shift without a draft may still have a post.
   */
  postsRead: z.boolean(),
});

export type AccountReportsQuery = z.infer<typeof accountReportsQuerySchema>;
export type AccountReportsResponse = z.infer<typeof accountReportsResponseSchema>;
export type AccountReport = z.infer<typeof accountReportSchema>;
export type AccountShiftReport = z.infer<typeof accountShiftReportSchema>;
export type AccountShiftReportPage = z.infer<typeof accountShiftReportPageSchema>;
export type AccountReportLine = z.infer<typeof accountReportLineSchema>;

export const accountReportsRouteSchemas = {
  accountReports: {
    auth: { kind: "any-session" },
    tags: ["client"],
    summary: "The caller's own shift reports from the agency ledger: drafted and posted pages, amounts, sales counted and held out",
    description: "Workboard «Мои смены»; read-only. Read from the ledger's GET /v1/reports and GET /v1/report-days with "
      + "Hub's payouts key for the session's user only. Report dates are Moscow days, at most 62; without a query the "
      + "last 14. Sales only, no pay. When the posts alone do not come, the drafts are served and `postsRead` is false. "
      + "503 when the ledger is not connected or did not answer.",
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
