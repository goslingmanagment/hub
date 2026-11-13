/**
 * What stands between a person's shifts and the report they are paid by, day by day (Workboard «Смены» and «Мои
 * смены»). A shift's money on the screens is the rule's («чья продажа»); people are paid by the day's report — the
 * breakdown the chat agent saved to the agency ledger and the post in «Отчётность». The two sums of a day differ on
 * most days for a reason that is nobody's to act on: a sale paid in a later report («долёт»). So the answer is not a
 * second sum but the named things somebody can act on, per person and report day, and nothing for a day that has none:
 *
 * - `unreported` — sales of the day's shifts no counted line of any of the person's reports pays;
 * - `byWordsMills` — what the day's report counts that is none of the person's sales by the rule;
 * - `postApartMills` — how far the post lies from the breakdown saved for it;
 * - `sumOnlyMills` — a day paid by a post written by hand (no breakdown to read): the report's sum, where it differs.
 *
 * Hub's server pairs the reports' lines with the sales (the lines name them by reference): no line, no reference and
 * nobody else's report reaches a browser. Read from the ledger with Hub's payouts key (GET only); nothing is written.
 */
import { z } from "zod";

import { CHATTER_STATS_MAX_DAYS } from "./chatter-stats.ts";
import { businessDate, errorResponseSchema, intId, isoTimestamp, mills } from "./primitives.ts";

/** The sales a note lists at most (`unreported.sales`); its `count` and `mills` are of all of them. */
export const SHIFT_REPORT_NOTE_SALES_MAX = 12;

/** The window of «Смены» and «Мои смены» (`teamShiftSales`, `accountChatterStats`): the same days, the same shifts. */
export const shiftReportNotesQuerySchema = z.object({
  /** Whole Moscow days back from the window's last day (`until`, default today), that day included. */
  days: z.coerce.number().int().min(1).max(CHATTER_STATS_MAX_DAYS).default(7),
  /** The window's last Moscow day; default today. */
  until: businessDate.optional(),
  /** One page only, as the team's page filter: its shifts, its sales, its lines of the reports. */
  pageLabel: z.string().min(1).max(120).optional(),
});

/** A sale of a person's shift that none of their reports pays. Never the fan. */
export const shiftReportNoteSaleSchema = z.object({
  /** Hub's id of the sale: its chain of money opens by it (`saleChain`). */
  saleId: intId,
  occurredAt: isoTimestamp,
  pageLabel: z.string(),
  /** Hub's transaction type: message_purchase, subscription, tip, post_purchase, stream_tip. */
  kind: z.string(),
  /** The person's part of it by the rule (the whole net but a split's). */
  netMills: mills,
});

/** One person's report day with something to say. */
export const shiftReportNoteSchema = z.object({
  /** Every login of the person: the day's shifts are theirs by any of them. */
  userIds: z.array(intId),
  /** The Moscow day the shifts are reported on (`shiftReportDay`). */
  reportDate: businessDate,
  /**
   * Sales of the day's shifts, the person's by the rule, that no counted line of any of their reports pays — of the
   * reports from 2 days before the window to 8 days after it (a late sale is paid in a later report). Only for a day
   * with a saved breakdown. `sales` — the oldest first, at most SHIFT_REPORT_NOTE_SALES_MAX.
   */
  unreported: z.object({
    count: z.number().int().nonnegative(),
    mills,
    sales: z.array(shiftReportNoteSaleSchema),
  }),
  /**
   * Counted lines of this day's report that pay none of the person's sales by the rule: a sale the rule gives someone
   * else or nobody, or money past the platform, put in by the chatter's word. 0 — none.
   */
  byWordsMills: mills,
  /** The day's pay base less its breakdown's counted lines: the post was changed by hand. 0 — the same, or cents apart. */
  postApartMills: mills,
  /**
   * A day with a pay base and no saved breakdown (a post written by hand, a report handed in in Hub): what the report
   * pays by, when that is another sum than the rule's shifts of the day; null — the same, or the day has a breakdown.
   */
  sumOnlyMills: mills.nullable(),
});

export const shiftReportNotesResponseSchema = z.object({
  /** The window's Moscow days, both included. */
  from: businessDate,
  to: businessDate,
  /** The first day the screens count by the rule; null — not switched: no day has a note. */
  ruleFrom: businessDate.nullable(),
  /** Only the days with something to say, the newest first. A day whose shift still goes on, or before `ruleFrom`, has none. */
  notes: z.array(shiftReportNoteSchema),
  serverNow: isoTimestamp,
});

export type ShiftReportNotesQuery = z.infer<typeof shiftReportNotesQuerySchema>;
export type ShiftReportNote = z.infer<typeof shiftReportNoteSchema>;
export type ShiftReportNoteSale = z.infer<typeof shiftReportNoteSaleSchema>;
export type ShiftReportNotesResponse = z.infer<typeof shiftReportNotesResponseSchema>;

export const shiftReportNoteRouteSchemas = {
  shiftReportNotes: {
    auth: { kind: "any-session" },
    tags: ["client"],
    summary: "Per person and report day, what stands between the shifts' sales by the rule and the report: sales in no report, sums by word, a post changed by hand",
    description: "Workboard «Смены» and «Мои смены»; read-only. The owner and a team lead: every person's days, on the "
      + "pages the viewer reaches (`pageLabel` narrows to one: 404 for a page that does not exist, 403 for one the viewer "
      + "does not reach). Anyone else, and a narrow session whatever the role: their own person's days alone. Shifts and "
      + "their sales are `teamShiftSales`' by the rule; the reports are the ledger's GET /v1/reports, /v1/report-days and "
      + "/v1/report-posts, read with Hub's payouts key. No fan, no report line and no reference of a sale is in the "
      + "answer. 503 when the ledger is not connected or did not answer: nothing is known of the days then.",
    querystring: shiftReportNotesQuerySchema,
    response: {
      200: shiftReportNotesResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
} as const;
